// src/services/sourceAggregator.js
// 📝 檔案功能用途：V9.1 多路冗餘數據源聚合器。三路 WebSocket 監聽 (Helius/Official/Alchemy) + 60秒緩衝池 + LP/FDV 比例快篩。

const WebSocket = require('ws');
const axios = require('axios');
const Redis = require('ioredis');
const { supabase } = require('../config/supabase');
const config = require('../config/config');

const redis = new Redis(config.cache.redisUrl);

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

class SourceAggregator {
    constructor() {
        this.mintBuffer = new Set();
        this.blacklist = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '11111111111111111111111111111111'];
        this.isProcessingBuffer = false;
        
        // ⏳ [V9.1 最佳化] 延長至 60 秒一次的批量快篩 (黃金入手窗口)
        // 避開開盤首 30 秒的 MEV 砸盤與 Jupiter 路由盲區
        setInterval(() => this._processMintBuffer(), 60000);
    }

    sanitizeAddress(address) {
        if (!address) return null;
        const clean = address.toString().trim().replace(/[\n\r\t\s]/g, '');
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return null;
        return clean;
    }

    connectWebSocket(name, wsUrl, programIds) {
        if (!wsUrl) return;

        let ws = new WebSocket(wsUrl);
        let pingTimeout;

        const heartbeat = () => {
            clearTimeout(pingTimeout);
            pingTimeout = setTimeout(() => {
                console.warn(`⚠️ [WS-${name}] 心跳超時，強制重連...`);
                ws.terminate();
            }, 35000);
        };

        ws.on('open', () => {
            console.log(`🟢 [WS-${name}] 已連線，啟動 logsSubscribe 監聽...`);
            heartbeat();
            
            ws.send(JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                params: [{ mentions: programIds }, { commitment: "processed" }]
            }));
        });

        ws.on('ping', heartbeat);
        
        ws.on('message', async (data) => {
            try {
                const response = JSON.parse(data);
                if (response.method !== 'logsNotification') return;
                
                const logs = response.params?.result?.value?.logs || [];
                const isCreation = logs.some(l => l.includes('InitializeMint') || l.includes('CreatePool') || l.includes('InitializeInstruction2'));
                
                if (isCreation) {
                    const signature = response.params.result.context.signature || response.params.result.value.signature;
                    if (!signature) return;

                    const isSeen = await redis.set(`seen_sig:${signature}`, '1', 'EX', 3600, 'NX');
                    if (!isSeen) return; 

                    const txInfo = await axios.post(config.rpc.helius1.url || config.rpc.alchemy.url, {
                        jsonrpc: "2.0", id: 1, method: "getTransaction",
                        params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                    }).catch(() => null);

                    const accounts = txInfo?.data?.result?.transaction?.message?.accountKeys || [];
                    const potentialMints = accounts.map(a => a.pubkey).filter(k => !this.blacklist.includes(k) && k.length > 32);

                    for (const mint of potentialMints) {
                        const cleanMint = this.sanitizeAddress(mint);
                        if (cleanMint) this.mintBuffer.add(cleanMint);
                    }
                }
            } catch (err) {}
        });

        ws.on('close', () => {
            clearTimeout(pingTimeout);
            console.warn(`🔴 [WS-${name}] 斷線，5 秒後嘗試重連...`);
            setTimeout(() => this.connectWebSocket(name, wsUrl, programIds), 5000);
        });

        ws.on('error', (err) => {
            console.error(`❌ [WS-${name}] 錯誤: ${err.message}`);
            ws.close();
        });
    }

    async pollBirdeyeNewListings() {
        if (!config.external.birdeyeApiKey) return;
        try {
            const res = await axios.get('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20', {
                headers: { 'X-API-KEY': config.external.birdeyeApiKey, 'accept': 'application/json' },
                timeout: 5000
            });
            
            const tokens = res.data?.data?.items || [];
            for (const token of tokens) {
                const mint = this.sanitizeAddress(token.address);
                if (mint && !this.blacklist.includes(mint)) {
                    const isProcessed = await redis.get(`processed_mint:${mint}`);
                    if (!isProcessed) this.mintBuffer.add(mint);
                }
            }
        } catch (err) {}
    }

    async _processMintBuffer() {
        if (this.isProcessingBuffer || this.mintBuffer.size === 0) return;
        this.isProcessingBuffer = true;

        const mintsArray = Array.from(this.mintBuffer).slice(0, 30);
        mintsArray.forEach(m => this.mintBuffer.delete(m));

        try {
            const addresses = mintsArray.join(',');
            const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses}`;
            const res = await axios.get(url, { timeout: 5000 });

            if (res.data && res.data.pairs) {
                for (const pair of res.data.pairs) {
                    if (pair.chainId !== 'solana') continue;
                    const mint = pair.baseToken?.address;
                    const liquidity = pair.liquidity?.usd || 0;
                    const fdv = pair.fdv || 0;
                    
                    const isProcessed = await redis.set(`processed_mint:${mint}`, '1', 'EX', 86400, 'NX');
                    if (!isProcessed) continue;

                    let lpRatioPass = false;
                    if (liquidity >= 5000) {
                        if (fdv > 0) {
                            const ratio = liquidity / fdv;
                            if (ratio >= 0.05 && ratio <= 0.18) lpRatioPass = true;
                        } else {
                            lpRatioPass = true; 
                        }
                    }

                    if (lpRatioPass) {
                        console.log(`🎯 [Aggregator] 捕獲合格初生幣: ${pair.baseToken.symbol} (Liq: $${liquidity.toFixed(0)})`);
                        await redis.zadd('v9_nursery_queue', Date.now(), mint);
                        await supabase.from('nursery_pool').upsert([{ mint_address: mint, created_at: new Date().toISOString() }]);
                    }
                }
            }
        } catch (err) {
            mintsArray.forEach(m => this.mintBuffer.add(m)); 
        } finally {
            this.isProcessingBuffer = false;
        }
    }

    start() {
        console.log('🌐 [Source Aggregator] 多路 WebSocket 冗餘監聽器啟動...');
        const targets = [PUMP_FUN_PROGRAM_ID, RAYDIUM_V4_PROGRAM_ID];
        
        const heliusWsUrl = config.rpc.helius1.apiKey ? `wss://atlas-mainnet.helius-rpc.com?api-key=${config.rpc.helius1.apiKey}` : null;
        this.connectWebSocket('Helius', heliusWsUrl, targets);
        
        this.connectWebSocket('Official-Mainnet', 'wss://api.mainnet-beta.solana.com', targets);

        const alchemyWsUrl = config.rpc.alchemy.apiKey ? `wss://solana-mainnet.g.alchemy.com/v2/${config.rpc.alchemy.apiKey}` : null;
        this.connectWebSocket('Alchemy', alchemyWsUrl, targets);

        setInterval(() => this.pollBirdeyeNewListings(), 3 * 60 * 1000);
    }
}

const sourceAggregator = new SourceAggregator();
module.exports = { sourceAggregator };