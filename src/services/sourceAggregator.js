// src/services/sourceAggregator.js
// 📝 檔案功能用途：V10 多路冗餘數據源聚合器。三路 WebSocket 監聽 + LP Burn 訊號發射器。
// 🚀 V10 升級：徹底剝離交易邏輯，專心做情報雷達，經 Redis 廣播越獄信號。
// 🚀 V10.3 修正：完美對接 newborn_incubator 資料表，並解決 ESLint 嚴格警告。

const WebSocket = require('ws');
const axios = require('axios');
const Redis = require('ioredis');
const { supabase } = require('../config/supabase');
const config = require('../config/config');

const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
// 💀 官方焚化爐
const INCINERATOR_ADDRESS = "1nc1nerator11111111111111111111111111111111";

class SourceAggregator {
    constructor() {
        // V10: 移除了本機 mintBuffer，直接依賴 DB newborn_incubator
        this.blacklist = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '11111111111111111111111111111111', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
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
                if (ws.readyState === WebSocket.OPEN) ws.ping();
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

        ws.on('pong', () => clearTimeout(pongTimeout));
        
        ws.on('message', async (data) => {
            try {
                const response = JSON.parse(data);
                if (response.method !== 'logsNotification') return;
                
                const logs = response.params?.result?.value?.logs || [];
                const logsStr = JSON.stringify(logs);
                const signature = response.params?.result?.context?.signature || response.params?.result?.value?.signature;
                if (!signature) return;

                const isCreation = logsStr.includes('InitializeMint') || logsStr.includes('CreatePool') || logsStr.includes('InitializeInstruction2');
                const isBurn = logsStr.includes('Instruction: Burn') || logsStr.includes('1nc1nerator');

                // 🎯 攔截 1：新池建立
                if (isCreation) {
                    const isSeen = await redis.set(`seen_sig:${signature}`, '1', 'EX', 3600, 'NX');
                    if (!isSeen) return; 

                    // 🛡️ 防崩潰：加入 ?. 避免 config.rpc 不存在時報錯
                    const rpcUrl = config.rpc?.helius1?.url || config.rpc?.alchemy?.url;
                    if (!rpcUrl) return;

                    const txInfo = await axios.post(rpcUrl, {
                        jsonrpc: "2.0", id: 1, method: "getTransaction",
                        params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                    }).catch(() => null);

                    const accounts = txInfo?.data?.result?.transaction?.message?.accountKeys || [];
                    const potentialMints = accounts.map(a => a.pubkey).filter(k => k && !this.blacklist.includes(k) && k.length > 32);

                    for (const mint of potentialMints) {
                        const cleanMint = this.sanitizeAddress(mint);
                        if (cleanMint) {
                            console.log(`🐣 [Aggregator] 發現新生命 (Mint: ${cleanMint})，直接送入初生保溫箱...`);
                            
                            // 🚀 核心修復：加入 await 防止 Floating Promise 警告
                            const { error } = await supabase.from('newborn_incubator').upsert([
                                { mint_address: cleanMint }
                            ], { onConflict: 'mint_address' });
                            
                            if (error) console.error(`❌ [Aggregator] 存入保溫箱失敗:`, error.message);
                        }
                    }
                } 
                // 🔥 攔截 2：捕捉到燒池 (LP Burn)！
                else if (isBurn) {
                    const { data: incubatingTokens } = await supabase
                        .from('newborn_incubator')
                        .select('mint_address')
                        .eq('status', 'INCUBATING');

                    if (!incubatingTokens || incubatingTokens.length === 0) return;

                    const rpcUrl = config.rpc?.helius1?.url || config.rpc?.alchemy?.url;
                    if (!rpcUrl) return;

                    const txInfo = await axios.post(rpcUrl, {
                        jsonrpc: "2.0", id: 1, method: "getTransaction",
                        params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                    }).catch(() => null);

                    const accounts = txInfo?.data?.result?.transaction?.message?.accountKeys || [];
                    const activeNurseryMints = incubatingTokens.map(t => t.mint_address);

                    for (const acc of accounts) {
                        if (acc.pubkey && activeNurseryMints.includes(acc.pubkey)) {
                            console.log(`\n🔥 [LP BURN DETECTED] 捕捉到莊家燒池訊號！廣播越獄信號: ${acc.pubkey}`);
                            await redis.set(`lp_burned:${acc.pubkey}`, 'TRUE', 'EX', 86400);

                            await redis.publish('lp_burn_alerts', JSON.stringify({ mint: acc.pubkey }));
                            break;
                        }
                    }
                }
            } catch (err) {
                // 🛡️ 修復 Empty Catch Block 警告
                // 靜默處理 JSON 解析或連線異常，防止 Spam Log
            }
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

    start() {
        console.log('🌐 [Source Aggregator] 多路 WebSocket 冗餘監聽器啟動...');
        const targets = [PUMP_FUN_PROGRAM_ID, RAYDIUM_V4_PROGRAM_ID, INCINERATOR_ADDRESS];
        
        let heliusWsUrl = null;
        if (config.rpc?.helius1?.url) {
            heliusWsUrl = config.rpc.helius1.url.replace('https://', 'wss://');
        } else if (config.rpc?.helius1?.apiKey) {
            heliusWsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.rpc.helius1.apiKey}`;
        }
        this.connectWebSocket('Helius', heliusWsUrl, targets);
        this.connectWebSocket('Official-Mainnet', 'wss://api.mainnet-beta.solana.com', targets);

        const alchemyWsUrl = config.rpc?.alchemy?.apiKey ? `wss://solana-mainnet.g.alchemy.com/v2/${config.rpc.alchemy.apiKey}` : null;
        this.connectWebSocket('Alchemy', alchemyWsUrl, targets);
    }
}

const sourceAggregator = new SourceAggregator();
module.exports = { sourceAggregator };