// src/services/sourceAggregator.js
// 📝 檔案功能用途：V9.2 多路冗餘數據源聚合器。三路 WebSocket 監聽 + 15秒極速緩衝池 + 5分鐘壽命防塞車機制 (去 Birdeye 化)。
// 🚀 V9.2.3 升級：加入 1nc1nerator 焚化爐監聽，捕捉 LP Burn 訊號極速搶跑。
// 🛠️ V9.2.4 升級：修復 429 靜默吞幣 Bug，並放寬 Pump.fun 畢業盤健康比例 (5% - 150%)。

const WebSocket = require('ws');
const axios = require('axios');
const Redis = require('ioredis');
const { supabase } = require('../config/supabase');
const config = require('../config/config');

const redis = new Redis(config.cache.redisUrl);

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
// 💀 官方焚化爐 (所有 LP Burn 都會經過呢度)
const INCINERATOR_ADDRESS = "1nc1nerator11111111111111111111111111111111"; 

class SourceAggregator {
    constructor() {
        this.mintBuffer = new Map(); 
        this.blacklist = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '11111111111111111111111111111111', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
        this.isProcessingBuffer = false;
        
        // 🎣 每 15 秒極速清空緩衝池
        setInterval(() => this._processMintBuffer(), 15000);
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
        let pingInterval;
        let pongTimeout;

        const startHeartbeat = () => {
            pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
                pongTimeout = setTimeout(() => {
                    console.warn(`⚠️ [WS-${name}] 伺服器無回應 Pong，強制重連...`);
                    ws.terminate();
                }, 10000);
            }, 30000);
        };

        ws.on('open', () => {
            console.log(`🟢 [WS-${name}] 已連線，啟動 logsSubscribe 監聽...`);
            startHeartbeat();
            
            ws.send(JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                params: [{ mentions: programIds }, { commitment: "processed" }]
            }));
        });

        ws.on('pong', () => {
            clearTimeout(pongTimeout);
        });
        
        ws.on('message', async (data) => {
            try {
                const response = JSON.parse(data);
                if (response.method !== 'logsNotification') return;
                
                const logs = response.params?.result?.value?.logs || [];
                const logsStr = JSON.stringify(logs);
                const signature = response.params.result.context.signature || response.params.result.value.signature;
                if (!signature) return;

                const isCreation = logsStr.includes('InitializeMint') || logsStr.includes('CreatePool') || logsStr.includes('InitializeInstruction2');
                const isBurn = logsStr.includes('Instruction: Burn') || logsStr.includes('1nc1nerator');

                // 🎯 攔截 1：新池建立
                if (isCreation) {
                    const isSeen = await redis.set(`seen_sig:${signature}`, '1', 'EX', 3600, 'NX');
                    if (!isSeen) return; 

                    const txInfo = await axios.post(config.rpc.helius1.url || config.rpc.alchemy.url, {
                        jsonrpc: "2.0", id: 1, method: "getTransaction",
                        params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                    }).catch(() => null);

                    const accounts = txInfo?.data?.result?.transaction?.message?.accountKeys || [];
                    const potentialMints = accounts.map(a => a.pubkey).filter(k => !this.blacklist.includes(k) && k.length > 32);

                    const now = Date.now();
                    for (const mint of potentialMints) {
                        const cleanMint = this.sanitizeAddress(mint);
                        if (cleanMint && !this.mintBuffer.has(cleanMint)) {
                            this.mintBuffer.set(cleanMint, now);
                        }
                    }
                } 
                // 🔥 攔截 2：捕捉到燒池 (LP Burn)！
                else if (isBurn) {
                    const nurseryCount = await redis.zcard('v9_nursery_queue');
                    if (nurseryCount === 0) return; // 保溫箱無貨，直接無視，慳 API

                    const txInfo = await axios.post(config.rpc.helius1.url || config.rpc.alchemy.url, {
                        jsonrpc: "2.0", id: 1, method: "getTransaction",
                        params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                    }).catch(() => null);

                    const accounts = txInfo?.data?.result?.transaction?.message?.accountKeys || [];
                    const activeNurseryMints = await redis.zrange('v9_nursery_queue', 0, -1);

                    for (const acc of accounts) {
                        if (activeNurseryMints.includes(acc.pubkey)) {
                            console.log(`\n🔥 [LP BURN DETECTED] 捕捉到莊家燒池訊號！保溫箱目標鎖定: ${acc.pubkey}`);
                            await redis.set(`lp_burned:${acc.pubkey}`, 'TRUE', 'EX', 86400);

                            // 🚀 提前從保溫池抽出嚟買
                            await redis.zrem('v9_nursery_queue', acc.pubkey);
                            const { securityGuard } = require('./securityGuard');
                            const { routerService } = require('./router');

                            const secResult = await securityGuard.calculateQuantScore(acc.pubkey, 'NEWBORN');
                            // 因為燒咗池，硬性加 20 分動能分
                            secResult.numeric_score += 20; 
                            await routerService.routeSignal(acc.pubkey, 'NEWBORN', secResult);
                            break;
                        }
                    }
                }
            } catch (err) {}
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            clearTimeout(pongTimeout);
            console.warn(`🔴 [WS-${name}] 斷線，5 秒後嘗試重連...`);
            setTimeout(() => this.connectWebSocket(name, wsUrl, programIds), 5000);
        });

        ws.on('error', (err) => {
            console.error(`❌ [WS-${name}] 錯誤: ${err.message}`);
            ws.close();
        });
    }

    async _processMintBuffer() {
        if (this.isProcessingBuffer || this.mintBuffer.size === 0) return;
        this.isProcessingBuffer = true;

        const now = Date.now();
        // 🚀 V9.2 防護：清理超過 5 分鐘仍無法在 DexScreener 查到價的死幣
        for (const [mint, timestamp] of this.mintBuffer.entries()) {
            if (now - timestamp > 5 * 60 * 1000) {
                this.mintBuffer.delete(mint);
            }
        }

        // 每次抽 30 隻出嚟試
        const mintsToProcess = Array.from(this.mintBuffer.entries()).slice(0, 30);
        mintsToProcess.forEach(([m, _]) => this.mintBuffer.delete(m)); // 先移出，失敗再放回

        if (mintsToProcess.length === 0) {
            this.isProcessingBuffer = false;
            return;
        }

        try {
            const addresses = mintsToProcess.map(([m, _]) => m).join(',');
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
                            // 🛠️ 修正：放寬 Pump.fun 畢業盤的健康比例 (大於 5% 且小於 150% 容錯)
                            if (ratio >= 0.05 && ratio <= 1.50) lpRatioPass = true;
                        } else {
                            lpRatioPass = true; 
                        }
                    }

                    if (lpRatioPass) {
                        console.log(`🎯 [Aggregator] 捕獲合格初生幣: ${pair.baseToken.symbol} (Liq: $${liquidity.toFixed(0)})，放入保溫池等待熟成...`);
                        await redis.zadd('v9_nursery_queue', Date.now(), mint);
                        await supabase.from('nursery_pool').upsert([{ mint_address: mint, created_at: new Date().toISOString() }]);
                    }
                }
            }
        } catch (err) {
            // 🚨 修正：加入高調警告，不再死得不明不白
            const errMsg = err.response?.status === 429 ? '觸發 429 限制' : err.message;
            console.warn(`⚠️ [Aggregator] 查價失敗 (${errMsg})，將 ${mintsToProcess.length} 隻幣退回緩衝池...`);
            
            // 查價失敗，放回 Buffer 等下次再試（需帶上原本的 timestamp）
            mintsToProcess.forEach(([m, ts]) => {
                if (!this.mintBuffer.has(m)) this.mintBuffer.set(m, ts);
            }); 
        } finally {
            this.isProcessingBuffer = false;
        }
    }

    start() {
        console.log('🌐 [Source Aggregator] 多路 WebSocket 冗餘監聽器啟動...');
        const targets = [PUMP_FUN_PROGRAM_ID, RAYDIUM_V4_PROGRAM_ID, INCINERATOR_ADDRESS];
        
        let heliusWsUrl = null;
        if (config.rpc.helius1.url) {
            heliusWsUrl = config.rpc.helius1.url.replace('https://', 'wss://');
        } else if (config.rpc.helius1.apiKey) {
            heliusWsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.rpc.helius1.apiKey}`;
        }
        this.connectWebSocket('Helius', heliusWsUrl, targets);
        
        this.connectWebSocket('Official-Mainnet', 'wss://api.mainnet-beta.solana.com', targets);

        const alchemyWsUrl = config.rpc.alchemy.apiKey ? `wss://solana-mainnet.g.alchemy.com/v2/${config.rpc.alchemy.apiKey}` : null;
        this.connectWebSocket('Alchemy', alchemyWsUrl, targets);
    }
}

const sourceAggregator = new SourceAggregator();
module.exports = { sourceAggregator };
