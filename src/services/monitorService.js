// src/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase');
const axios = require('axios');
const crypto = require('crypto');
const configEnv = require('../config/env'); 
const { PublicKey } = require('@solana/web3.js');

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

const { runSellPipeline, executeBuy, handleIncomingFund, handleOutgoingFund } = require('./tradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { consensusService, getPendingMemeCount } = require('./consensusService');
const { reviewActivePosition } = require('./aiService'); 
const { retrospectiveJob } = require('../jobs/retrospectiveJob');
const { aiOrchestrator } = require('./aiOrchestrator');

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);
const redisSub = new Redis(configEnv.cache.redisUrl); 

const priceHistory1Min = new Map(); 
const sellingLocks = new Set(); 
const trendingPriceCache = new Map(); 

let lastRedisUpdateMs = Date.now();
let isHttpFallbackActive = false;

// 🧠 斷路器：紀錄每隻 API 嘅冷卻到期時間 (Timestamp)
const apiCooldowns = {
    geckoTerminal: 0,
    jupiterV3: 0,
    jupiterV6: 0
};

function isApiAvailable(apiName) {
    return Date.now() > apiCooldowns[apiName];
}

function markApiFailed(apiName) {
    console.warn(`🚨 [Monitor Fallback] ${apiName} 發生故障，已觸發斷路器，進入 60 秒冷卻期！`);
    apiCooldowns[apiName] = Date.now() + 60000;
}

const app = express();
const cors = require('cors'); 
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('🟢 SOL_Trade V8.8 系統正常運行中 (終極動態階梯鎖潤版)'));

app.post('/force-evolution', async (req, res) => {
    console.log('🧠 [Admin Command] 收到前端指令：強制喚醒 Master AI 進行進化！');
    try {
        const { retrospectiveJob } = require('../jobs/retrospectiveJob');
        retrospectiveJob.runEvolutionWithRetry(1).catch(err => console.error("進化失敗:", err));
        res.status(200).json({ success: true, message: '指令已送達，AI 正在運算中' });
    } catch (err) {
        console.error('❌ [Admin Command] 強制喚醒失敗:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

const HELIUS_API_KEY = configEnv.rpc.helius1.apiKey;           
const WEBHOOK_ID = configEnv.rpc.helius1.webhookId;
const HELIUS_API_KEY_2 = configEnv.rpc.helius2.apiKey;       
const WEBHOOK_ID_2 = configEnv.rpc.helius2.webhookId;
const NGROK_URL = process.env.NGROK_URL || "https://solana-ai-trade-bot-production.up.railway.app";
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

const botWallet = configEnv.solana.walletPublicKey; 

let detailedStats = {};
let webhooksThisMinute = 0;
let lastAiCount = 0;
let isNurseryPoolFull = false; 

function initStatKey(key) {
    if (!detailedStats[key]) detailedStats[key] = { received: 0, filtered: 0, added: 0 };
}

function sanitizeAddress(address) {
    if (!address) return null;
    const clean = address.toString().trim().replace(/[\n\r\t\s]/g, '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return null;
    return clean;
}

async function refreshPoolStatus() {
    try {
        const { count, error } = await supabase.from('nursery_pool').select('*', { count: 'exact', head: true });
        if (!error && count !== null) {
            isNurseryPoolFull = count >= 200; 
            if (isNurseryPoolFull) healthMonitor.setStatus('Meme_Radar', '🟡 魚池已滿 (本地暫停同步)');
        }
    } catch (e) {}
}
setInterval(refreshPoolStatus, 10000);

const aiReviewCooldowns = new Map(); 
let isAiReviewing = false;

async function toggleHeliusWebhook(enable = true) {
    if (!enable) return;
    const targetUrl = `${NGROK_URL.replace(/\/$/, '')}/webhook/helius`;
    console.log(`📡 [Helius] 確保雙 Webhook 連線至: ${targetUrl}`);

    if (HELIUS_API_KEY && WEBHOOK_ID) {
        try {
            const payload1 = { webhookURL: targetUrl, transactionTypes: ["CREATE_POOL"], accountAddresses: [RAYDIUM_V4_PROGRAM_ID], webhookType: "enhanced", txnStatus: "success" };
            await axios.put(`https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`, payload1);
        } catch (err) { console.error('❌ [Webhook 1 Error] Raydium 更新失敗'); }
    }
    if (HELIUS_API_KEY_2 && WEBHOOK_ID_2) {
        try {
            const payload2 = { webhookURL: targetUrl, transactionTypes: ["TOKEN_MINT", "CREATE_POOL"], accountAddresses: [PUMP_FUN_PROGRAM_ID], webhookType: "enhanced", txnStatus: "success" };
            await axios.put(`https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID_2}?api-key=${HELIUS_API_KEY_2}`, payload2);
        } catch (err) { console.error('❌ [Webhook 2 Error] Pump.fun 更新失敗'); }
    }
    healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中 (RAM 緩衝)');
    healthMonitor.setStatus('Wallet_Radar', '🔵 由 Alchemy 監控中');
}

app.post('/webhook/helius', async (req, res) => {
    res.status(200).send('OK'); 
    try {
        webhooksThisMinute++;
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) return;

        let events = [];
        if (Array.isArray(req.body)) events = req.body; 
        else if (req.body && req.body.event && Array.isArray(req.body.event.activity)) {
            const activities = req.body.event.activity;
            events.push({
                type: 'ALCHEMY_TRANSFER',
                signature: activities[0]?.hash || 'alchemy_tx',
                nativeTransfers: activities.map(act => ({
                    fromUserAccount: act.fromAddress, toUserAccount: act.toAddress, amount: parseFloat(act.value || 0) * 1e9
                }))
            });
        } else return; 

        for (const event of events) {
            const eventType = event.type || 'UNKNOWN_TYPE';
            let sourceName = 'Other';
            const nativeTransfers = event.nativeTransfers || [];
            const isWalletAction = nativeTransfers.some(t => t.fromUserAccount === botWallet || t.toUserAccount === botWallet);

            if (isWalletAction) sourceName = 'Wallet';
            else if (event.instructions) {
                if (event.instructions.some(ix => ix.programId === PUMP_FUN_PROGRAM_ID)) sourceName = 'PumpFun';
                else if (event.instructions.some(ix => ix.programId === RAYDIUM_V4_PROGRAM_ID)) sourceName = 'Raydium';
            }

            const statKey = `[${sourceName}] ${eventType}`;
            initStatKey(statKey);
            detailedStats[statKey].received++;

            if (isWalletAction) {
                for (const t of nativeTransfers) {
                    const amount = t.amount / 1e9;
                    const txid = event.signature || 'alchemy_tx';
                    if (t.toUserAccount === botWallet && amount > 0) {
                        await handleIncomingFund(t.fromUserAccount, amount, txid);
                    } else if (t.fromUserAccount === botWallet && amount > 0 && t.toUserAccount.length > 32) { 
                        await handleOutgoingFund(t.toUserAccount, amount, txid);
                    }
                }
                continue; 
            }

            let newMemeAddress = null;
            if (event.tokenTransfers && event.tokenTransfers.length > 0) {
                const transfer = event.tokenTransfers.find(t => t.mint !== SOL_MINT_ADDRESS && t.mint !== SYSTEM_PROGRAM_ID && t.mint.length > 32);
                if (transfer) newMemeAddress = sanitizeAddress(transfer.mint);
            }

            if (!newMemeAddress && event.instructions) {
                for (const ix of event.instructions) {
                    if (ix.programId === PUMP_FUN_PROGRAM_ID || ix.programId === RAYDIUM_V4_PROGRAM_ID) {
                        if (ix.accounts) {
                            const potentialMint = ix.accounts.find(acc => acc !== SOL_MINT_ADDRESS && acc !== SYSTEM_PROGRAM_ID && acc !== PUMP_FUN_PROGRAM_ID && acc.length > 32);
                            if (potentialMint) { newMemeAddress = sanitizeAddress(potentialMint); break; }
                        }
                    }
                }
            }

            if (newMemeAddress) {
                detailedStats[statKey].filtered++;
                await redis.zadd('ram_mints_queue', Date.now(), newMemeAddress);
                detailedStats[statKey].added++; 
            } 
        }
    } catch (err) {}
});

async function triggerBuyPipeline(mintAddress, secResult, config) {
    while (isAiReviewing) await new Promise(r => setTimeout(r, 1000));
    isAiReviewing = true; 
    try {
        const aiDecision = await consensusService.runMemeConsensus(mintAddress, secResult.marketData);
        if (aiDecision.buy) {
            const strategy = secResult.isBlindSnipe ? 'MEME_BLIND' : 'MEME_SNIPE';
            const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, strategy, aiDecision.score, aiDecision.reason, config.trade_amount_sol);
            if (buyResult !== false) console.log(`✅ 🟢 【買入指令已送出 - ${secResult.marketData.symbol}】 🟢 ✅`);
        } else {
            console.log(`🧠 [AI Rejected] 否決: ${aiDecision.reason}`);
        }
    } catch (err) {
        console.error(`❌ [AI Review Error]`, err.message);
    } finally {
        isAiReviewing = false; 
    }
}

// 🚀 RAM 預檢漏斗 (Batch RPC + Socials 攔截)
let isRamProcessorRunning = false;
function startRamCacheProcessor() {
    console.log('🧠 [RAM Cache] 5分鐘記憶體漏斗已啟動 (Batch RPC 預檢模式)');
    setInterval(async () => {
        if (isRamProcessorRunning) return;
        isRamProcessorRunning = true;
        try {
            const now = Date.now();
            const fiveMinsAgo = now - 300000; 
            const mints = await redis.zrangebyscore('ram_mints_queue', 0, fiveMinsAgo);
            
            if (mints && mints.length > 0) {
                console.log(`\n📦 [RAM Batch] 提取出 ${mints.length} 隻度過 5 分鐘冷靜期嘅新幣，準備執行批量查冊...`);
                await redis.zremrangebyscore('ram_mints_queue', 0, fiveMinsAgo);

                const { connection } = require('../config/solana');
                const pubkeys = mints.map(m => {
                    try { return new PublicKey(m); } catch(e) { return null; }
                }).filter(Boolean);

                const chunks = [];
                for(let i = 0; i < pubkeys.length; i += 100) chunks.push(pubkeys.slice(i, i + 100));

                const validMints = [];
                for (const chunk of chunks) {
                    try {
                        const accs = await connection.getMultipleAccountsInfo(chunk);
                        for (let i = 0; i < accs.length; i++) {
                            if (accs[i]) {
                                const mintStr = chunk[i].toString();
                                validMints.push(mintStr);
                                await redis.set(`SEC_ACC:${mintStr}`, 'VALID', 'EX', 86400);
                            }
                        }
                    } catch (rpcErr) {
                        console.error('❌ [RAM Batch] RPC 批量獲取失敗:', rpcErr.message);
                    }
                }

                if (validMints.length > 0) {
                    console.log(`🛡️ [RAM Batch] 鏈上存活: ${validMints.length} 隻，移交 Security Guard 進行三無過濾...`);
                    const { securityGuard } = require('./securityGuard');
                    
                    for (const mint of validMints) {
                        if (isNurseryPoolFull) break; 
                        
                        const secResult = await securityGuard.checkAll(mint);
                        
                        if (secResult.isSafe) {
                            console.log(`✅ [RAM Batch] ${mint.substring(0, 4)}... 安全通過預檢！放入 Supabase 魚池等待 AI。`);
                            await redis.set(`SEC_RES:${mint}`, JSON.stringify(secResult), 'EX', 3600);
                            await supabase.rpc('insert_fish_with_limit', { new_mint_address: mint });
                        } else {
                            console.log(`🗑️ [RAM Batch] 淘汰 ${mint.substring(0, 4)}... : ${secResult.reason}`);
                        }
                        
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }
        } catch (err) {
            console.error(`❌ [RAM Processor] 異常:`, err.message);
        } finally {
            isRamProcessorRunning = false;
        }
    }, 10000); 
}

// 🚀 DB 魚池只負責排隊等 AI (秒速處理)
let isNurseryRunning = false;
function startDatabaseNurseryMonitor() {
    console.log('🐟 [DB Nursery] AI 逐條審核系統已啟動 (由 min_age_mins 控制)');
    setInterval(async () => {
        if (isNurseryRunning) return;
        const queueLength = getPendingMemeCount();
        if (queueLength >= 3) return;

        isNurseryRunning = true;
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) { isNurseryRunning = false; return; }

            const { data: tokens } = await supabase.from('nursery_pool').select('*').order('created_at', { ascending: true }).limit(5);
            if (tokens && tokens.length > 0) {
                for (const token of tokens) {
                    const mintAddress = token.mint_address;
                    const ageMins = (Date.now() - new Date(token.created_at).getTime()) / 60000;

                    if (ageMins > config.max_age_mins) {
                        await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                        continue;
                    } 
                    
                    if (ageMins >= config.min_age_mins) {
                        console.log(`\n======================================================`);
                        console.log(`🤖 [AI Review] 幣種已達標 (入庫後 ${ageMins.toFixed(1)} 分鐘)，啟動 AI 審批...`);
                        console.log(`======================================================\n`);

                        const secResultStr = await redis.get(`SEC_RES:${mintAddress}`);
                        let secResult;
                        
                        if (secResultStr) {
                            secResult = JSON.parse(secResultStr);
                        } else {
                            const { securityGuard } = require('./securityGuard');
                            secResult = await securityGuard.checkAll(mintAddress);
                        }
                        
                        if (secResult && secResult.isSafe) {
                            await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                            await triggerBuyPipeline(mintAddress, secResult, config);
                            break; 
                        } else {
                            await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                        }
                    }
                }
            }
        } catch (err) {} finally { isNurseryRunning = false; }
    }, 10000); 
}

// ========================================================
// 🎯 核心：0 延遲實時盈虧監控與極速平倉 (V8.8 雙軌階梯版)
// ========================================================
async function handleZeroLatencyCheck(mint, currentPriceSol, config, portfolio) {
    if (!currentPriceSol || currentPriceSol <= 0) return;
    
    const pos = portfolio.positions.find(p => p.mint_address === mint);
    if (!pos || sellingLocks.has(mint)) return; 

    const now = Date.now();
    if (!priceHistory1Min.has(mint)) priceHistory1Min.set(mint, []);
    const history = priceHistory1Min.get(mint);
    history.push({ price: currentPriceSol, time: now });
    while (history.length > 0 && now - history[0].time > 60000) history.shift();
    priceHistory1Min.set(mint, history);

    const maxPriceLast60s = Math.max(...history.map(h => h.price));
    const dropFrom1MinHigh = ((currentPriceSol - maxPriceLast60s) / maxPriceLast60s) * 100;
    const pnlSol = (currentPriceSol - pos.entry_price_sol) * pos.quantity;
    const pnlPct = (pnlSol / (pos.entry_price_sol * pos.quantity)) * 100;
    
    if (currentPriceSol > pos.highest_price_sol) {
        const priceRatio = currentPriceSol / (pos.highest_price_sol || pos.entry_price_sol);
        if (priceRatio < 50) { 
            pos.highest_price_sol = currentPriceSol;
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            supabase.from(`active_positions_${tableSuffix}`).update({ highest_price_sol: currentPriceSol }).eq('mint_address', pos.mint_address).then();
        }
    }

    const drawdownFromHigh = ((currentPriceSol - pos.highest_price_sol) / pos.highest_price_sol) * 100;
    const highestPnlPct = ((pos.highest_price_sol - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');
    const STOP_LOSS_PCT = parseFloat(config.stop_loss_pct || -20);

    let action = 'HOLD'; let reason = ''; let sellFraction = 1.0; 
    
    const isMeme = pos.strategy_type.includes('MEME');
    let flashCrashThr = isMeme ? -10 : -7;       
    let cliffDropThr = isMeme ? -40 : -20;       
    const takeCapitalThr = isMeme ? 100 : 50; 

    // 🚀 [V8.8 終極雙軌升級] Meme 與 Trending 專屬的 Absolute PnL 動態鎖潤階梯
    let trailingTriggered = false;
    let trailingReason = '';
    const pnlDropPoints = highestPnlPct - pnlPct; // 計算由歷史高位回落咗幾多個「百分點」

    if (isMeme) {
        // 🐶 Meme 幣：高風險、高爆發，容忍極端洗盤
        if (highestPnlPct >= 300) {
            flashCrashThr = -25;
            cliffDropThr = -60;
            // 300% 以上，容許跌 100 個 PnL 點 (真實跌幅容忍約 25%)
            if (pnlDropPoints >= 100) { trailingTriggered = true; trailingReason = `最高 +${highestPnlPct.toFixed(0)}%，回落 100 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 200) {
            flashCrashThr = -20;
            cliffDropThr = -50;
            // 200% 以上，容許跌 70 個 PnL 點 (真實跌幅容忍約 23.3%)
            if (pnlDropPoints >= 70) { trailingTriggered = true; trailingReason = `最高 +${highestPnlPct.toFixed(0)}%，回落 70 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 150) {
            flashCrashThr = -15;
            cliffDropThr = -40;
            // 150% 以上，容許跌 50 個 PnL 點 (真實跌幅容忍約 20%)
            if (pnlDropPoints >= 50) { trailingTriggered = true; trailingReason = `最高 +${highestPnlPct.toFixed(0)}%，回落 50 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 100) {
            flashCrashThr = -12;
            cliffDropThr = -35;
            // 100% 以上 (剛出本)，容許跌 40 個 PnL 點 (真實跌幅容忍約 20%)
            if (pnlDropPoints >= 40) { trailingTriggered = true; trailingReason = `最高 +${highestPnlPct.toFixed(0)}%，回落 40 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 50) {
            // 未翻倍前，用傳統真實回撤比例 (-30%) 保護
            if (drawdownFromHigh <= -30) { trailingTriggered = true; trailingReason = `未翻倍前觸發追蹤止盈 (最高 +${highestPnlPct.toFixed(0)}%，現價真實回撤達 30%)`; }
        }
    } else {
        // 🔥 Trending / 藍籌幣：高市值、穩健拉升，收緊保護網
        if (highestPnlPct >= 150) {
            flashCrashThr = -15;
            cliffDropThr = -40;
            // 150% 已經係超級大牛市，容許跌 40 個 PnL 點 (即係保底食 +110%)
            if (pnlDropPoints >= 40) { trailingTriggered = true; trailingReason = `熱門幣最高 +${highestPnlPct.toFixed(0)}%，回落 40 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 100) {
            flashCrashThr = -12;
            cliffDropThr = -30;
            // 100% 以上，容許跌 30 個 PnL 點 (保底食 +70%)
            if (pnlDropPoints >= 30) { trailingTriggered = true; trailingReason = `熱門幣最高 +${highestPnlPct.toFixed(0)}%，回落 30 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 80) {
            flashCrashThr = -10;
            cliffDropThr = -25;
            // 80% 以上，容許跌 25 個 PnL 點 (保底食 +55%)
            if (pnlDropPoints >= 25) { trailingTriggered = true; trailingReason = `熱門幣最高 +${highestPnlPct.toFixed(0)}%，回落 25 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 50) {
            flashCrashThr = -8;
            cliffDropThr = -25;
            // 50% 以上 (剛出本)，容許跌 20 個 PnL 點 (保底食 +30%)
            if (pnlDropPoints >= 20) { trailingTriggered = true; trailingReason = `熱門幣最高 +${highestPnlPct.toFixed(0)}%，回落 20 個利潤點鎖潤`; }
        } else if (highestPnlPct >= 20) {
            // 熱門幣未夠 50% 出本前，只要升過 +20%，回撤 -12% 就走人保平安
            if (drawdownFromHigh <= -12) { trailingTriggered = true; trailingReason = `未出本前觸發追蹤止盈 (最高 +${highestPnlPct.toFixed(0)}%，現價真實回撤達 12%)`; }
        }
    }

    // 🏆 優先度 1：無情硬止盈 (Meme翻倍出本 / 熱門幣+50%出本) - 絕對優先！
    if (!isHalfSold && pnlPct >= takeCapitalThr) {
        action = 'SELL'; 
        sellFraction = 0.5; 
        reason = `🎯 觸發硬止盈 (抽回本金)：利潤達 +${pnlPct.toFixed(2)}%，賣出 50% 鎖定本金，實現零風險持倉！`;
    } 
    // 🛡️ 優先度 2：極速瀑布防線 (1分鐘內暴跌，現已支援高位動態放寬)
    else if (dropFrom1MinHigh <= flashCrashThr) {
        action = 'SELL'; 
        reason = `🚨 觸發瀑布防線：1 分鐘內極速插水 ${dropFrom1MinHigh.toFixed(2)}% (當前容忍度: ${flashCrashThr}%)`;
    } 
    // 🛡️ 優先度 3：物理硬止損 (保護底線，跌穿必斬，移除 !isHalfSold 確保歸零前走人)
    else if (pnlPct <= STOP_LOSS_PCT) {
        action = 'SELL'; 
        reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${STOP_LOSS_PCT}%)`;
    } 
    // 🛡️ 優先度 4：大佬專屬動態鎖潤網 (PnL 點數階梯)
    else if (trailingTriggered) {
        action = 'SELL'; 
        reason = `💰 ${trailingReason}`;
    }
    // 🛡️ 優先度 5：斷崖式崩盤 (高位回撤過大)
    else if (drawdownFromHigh <= cliffDropThr) {
        action = 'SELL'; 
        reason = `🚨 偵測到斷崖式崩盤 (高位回撤 ${drawdownFromHigh.toFixed(2)}%，當前容忍度: ${cliffDropThr}%)`;
    }

    if (action === 'SELL') {
        sellingLocks.add(pos.mint_address);
        priceHistory1Min.delete(pos.mint_address);
        runSellPipeline(pos, currentPriceSol, reason, sellFraction).then(sellResult => {
            if (sellResult && sellFraction === 0.5) {
                const telegramMsg = reason.includes('抽回本金') 
                    ? `🎯 <b>零風險持倉達成！</b>\n🪙 代幣: $${pos.token_symbol}\n🔥 利潤達標，已成功賣出 50% 抽回全數本金！剩下的讓利潤奔跑！`
                    : `🌟 <b>分批鎖定利潤</b>\n🪙 代幣: $${pos.token_symbol}\n賣出 50% 鎖定利潤！`;
                sendTelegramAlert(telegramMsg);
            }
        }).catch(err => console.error(`❌ [Zero Latency Sell Error]`, err.message)).finally(() => sellingLocks.delete(pos.mint_address));
    }
}

function startPositionMonitor() {
    console.log('👁️ [Radar] V8.8 雙軌秒斬防線 + 瀑布備援查價系統已啟動...');
    let cachedSolPriceUsd = 150; 
    const { getSolPriceInHKD } = require('./priceService');
    
    setInterval(async () => { try { cachedSolPriceUsd = (await getSolPriceInHKD()) / 7.8; } catch(e) {} }, 60000);

    setInterval(async () => {
        const { getPortfolio } = require('./portfolioService');
        const portfolio = getPortfolio();
        if (!portfolio || !portfolio.positions) return;
        const memeMints = portfolio.positions.filter(p => p.strategy_type && p.strategy_type.includes('MEME')).map(p => p.mint_address);
        if (memeMints.length > 0) await redis.set('active_watch_mints', JSON.stringify(memeMints), 'EX', 10);
        else await redis.del('active_watch_mints');
    }, 2000);

    redisSub.subscribe('price_updates');
    redisSub.on('message', async (channel, message) => {
        if (channel === 'price_updates') {
            lastRedisUpdateMs = Date.now(); 
            try {
                const config = (await supabase.from('system_config').select('*').eq('id', 1).single()).data;
                if (!config?.is_running) return;
                const portfolio = require('./portfolioService').getPortfolio();
                const { mint, priceUsd } = JSON.parse(message);
                const currentPriceSol = priceUsd / cachedSolPriceUsd; 
                await handleZeroLatencyCheck(mint, currentPriceSol, config, portfolio);
            } catch (err) {}
        }
    });

    setInterval(async () => {
        const timeSinceLastRedis = Date.now() - lastRedisUpdateMs;
        const { getPortfolio } = require('./portfolioService');
        const portfolio = getPortfolio();
        
        if (timeSinceLastRedis > 60000 && portfolio?.positions?.length > 0) {
            if (!isHttpFallbackActive) {
                isHttpFallbackActive = true;
                sendAdminAlert(`⚠️ <b>[情報源中斷]</b>\n超過 1 分鐘未收到 Koyeb 無人機報價！\n大本營已自動啟動 HTTP 瀑布備援查價 (每 10 秒)。`);
                console.log(`🚨 [Fallback] 啟動每 10 秒 HTTP 瀑布備援查價...`);
            }

            try {
                const config = (await supabase.from('system_config').select('*').eq('id', 1).single()).data;
                if (!config?.is_running) return;
                
                const mints = portfolio.positions.map(p => p.mint_address).join(',');
                let fetchedPrices = {};
                let fetchSuccess = false;

                if (!fetchSuccess && isApiAvailable('geckoTerminal')) {
                    try {
                        const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${mints}`, { timeout: 3000 });
                        const pricesObj = res.data?.data?.attributes?.token_prices;
                        if (pricesObj) {
                            for (const [mint, priceStr] of Object.entries(pricesObj)) {
                                if (priceStr) fetchedPrices[mint] = parseFloat(priceStr);
                            }
                            fetchSuccess = true;
                        }
                    } catch (e) { markApiFailed('geckoTerminal'); }
                }

                if (!fetchSuccess && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
                    try {
                        const jupConfig = { timeout: 3000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
                        const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mints}`, jupConfig);
                        if (res.data) {
                            for (const [mint, info] of Object.entries(res.data)) {
                                if (info.usdPrice) fetchedPrices[mint] = parseFloat(info.usdPrice);
                            }
                            fetchSuccess = true;
                        }
                    } catch (e) { markApiFailed('jupiterV3'); }
                }

                if (!fetchSuccess && isApiAvailable('jupiterV6')) {
                    try {
                        const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mints}`, { timeout: 3000 });
                        if (res.data?.data) {
                            for (const [mint, info] of Object.entries(res.data.data)) {
                                if (info.price) fetchedPrices[mint] = parseFloat(info.price);
                            }
                            fetchSuccess = true;
                        }
                    } catch (e) { markApiFailed('jupiterV6'); }
                }

                if (fetchSuccess) {
                    for (const pos of portfolio.positions) {
                        if (fetchedPrices[pos.mint_address]) {
                            const solPrice = fetchedPrices[pos.mint_address] / cachedSolPriceUsd;
                            await handleZeroLatencyCheck(pos.mint_address, solPrice, config, portfolio);
                        }
                    }
                } else {
                    console.warn(`⚠️ [Fallback] 所有備援 HTTP 查價皆已癱瘓！`);
                }
            } catch (err) {}

        } else if (timeSinceLastRedis <= 60000 && isHttpFallbackActive) {
            isHttpFallbackActive = false;
            sendAdminAlert(`✅ <b>[情報源恢復]</b>\nRedis 報價重新連線，大本營已關閉 HTTP 備援，切換回 0 延遲模式！`);
            console.log(`🟢 [Fallback] 關閉備援，恢復 Redis 監聽。`);
        }
    }, 10000); 

    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;
            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            if (!portfolio || !portfolio.positions) return;

            const trendingMints = portfolio.positions.filter(p => p.strategy_type && p.strategy_type.includes('TRENDING')).map(p => p.mint_address);
            if (trendingMints.length === 0) return;

            const mints = trendingMints.join(',');
            let fetchedPrices = {};
            let fetchSuccess = false;

            if (!fetchSuccess && isApiAvailable('geckoTerminal')) {
                try {
                    const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${mints}`, { timeout: 3000 });
                    const pricesObj = res.data?.data?.attributes?.token_prices;
                    if (pricesObj) {
                        for (const [mint, priceStr] of Object.entries(pricesObj)) {
                            if (priceStr) fetchedPrices[mint] = parseFloat(priceStr);
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('geckoTerminal'); }
            }

            if (!fetchSuccess && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
                try {
                    const jupConfig = { timeout: 3000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
                    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mints}`, jupConfig);
                    if (res.data) {
                        for (const [mint, info] of Object.entries(res.data)) {
                            if (info.usdPrice) fetchedPrices[mint] = parseFloat(info.usdPrice);
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV3'); }
            }

            if (!fetchSuccess && isApiAvailable('jupiterV6')) {
                try {
                    const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mints}`, { timeout: 3000 });
                    if (res.data?.data) {
                        for (const [mint, info] of Object.entries(res.data.data)) {
                            if (info.price) fetchedPrices[mint] = parseFloat(info.price);
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV6'); }
            }

            if (fetchSuccess) {
                for (const mint of trendingMints) {
                    if (fetchedPrices[mint]) {
                        const currentPriceSol = fetchedPrices[mint] / cachedSolPriceUsd;
                        trendingPriceCache.set(mint, currentPriceSol); 
                        await handleZeroLatencyCheck(mint, currentPriceSol, config, portfolio);
                    }
                }
            }
        } catch (err) {}
    }, 60000);

    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const positions = portfolio.positions;
            
            if (!positions || positions.length === 0) {
                if (aiReviewCooldowns.size > 0) aiReviewCooldowns.clear();
                return;
            }

            const currentMints = new Set(positions.map(p => p.mint_address));
            for (const mint of aiReviewCooldowns.keys()) {
                if (!currentMints.has(mint)) aiReviewCooldowns.delete(mint);
            }

            for (const pos of positions) {
                if (sellingLocks.has(pos.mint_address)) continue;
                const nowMs = Date.now();
                const lastReviewMs = aiReviewCooldowns.get(pos.mint_address) || 0;
                if ((nowMs - lastReviewMs) / 60000 < 3) continue; 

                let currentPrice = 0;
                if (pos.strategy_type.includes('MEME')) {
                    const priceUsdStr = await redis.get(`price_usd:${pos.mint_address}`);
                    if (priceUsdStr) currentPrice = parseFloat(priceUsdStr) / cachedSolPriceUsd;
                } else {
                    currentPrice = trendingPriceCache.get(pos.mint_address) || 0;
                }
                
                if (currentPrice <= 0) continue; 
                
                const pnlPct = (((currentPrice - pos.entry_price_sol) * pos.quantity) / (pos.entry_price_sol * pos.quantity)) * 100;
                aiReviewCooldowns.set(pos.mint_address, nowMs);

                console.log(`\n👁️ [AI Overseer] 正在審查 ${pos.token_symbol} (PNL: ${pnlPct.toFixed(2)}%)...`);
                
                try {
                    let aiMemory = [];
                    const memoryStr = await redis.get(`ai_memory:${pos.mint_address}`);
                    if (memoryStr) aiMemory = JSON.parse(memoryStr);

                    const posDataForAI = { ...pos, currentPrice, pnlPct, mode: portfolio.mode, previous_ai_thoughts: aiMemory };
                    const reviewResult = await reviewActivePosition(pos.mint_address, posDataForAI);
                    
                    if (reviewResult && reviewResult.reason) {
                        const timeStr = new Date().toLocaleTimeString('zh-HK', { hour12: false });
                        aiMemory.push(`[${timeStr}] ${reviewResult.reason}`);
                        if (aiMemory.length > 3) aiMemory.shift(); 
                        await redis.set(`ai_memory:${pos.mint_address}`, JSON.stringify(aiMemory), 'EX', 86400);
                        await redis.set(`ai_pending_db:${pos.mint_address}`, aiMemory.join(' | '), 'EX', 86400);
                    }

                    if (reviewResult.decision === 'RETRY_LATER') {
                        aiReviewCooldowns.set(pos.mint_address, nowMs - (3 * 60 * 1000));
                        continue; 
                    }

                    if (reviewResult.decision === 'EXIT' || reviewResult.decision === 'SELL') {
                        sellingLocks.add(pos.mint_address);
                        runSellPipeline(pos, currentPrice, `AI 指示: ${reviewResult.reason}`, 1.0)
                            .finally(() => { aiReviewCooldowns.delete(pos.mint_address); sellingLocks.delete(pos.mint_address); });
                    }
                } catch (aiErr) { aiReviewCooldowns.set(pos.mint_address, nowMs - (4 * 60 * 1000)); }
            }
        } catch (err) {}
    }, 180000); 

    setInterval(async () => {
        try {
            const keys = await redis.keys('ai_pending_db:*');
            if (keys.length === 0) return;
            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            if (!portfolio || !portfolio.mode) return;
            const tableName = portfolio.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            for (const key of keys) {
                const mint = key.split(':')[1];
                const memoryData = await redis.get(`ai_memory:${mint}`);
                if (memoryData) {
                    const memoryArray = JSON.parse(memoryData);
                    await supabase.from(tableName).update({ last_review_comment: memoryArray[memoryArray.length - 1] }).eq('mint_address', mint);
                    await redis.del(key);
                }
            }
        } catch (err) {}
    }, 5 * 60 * 1000);
}

function startCommandListener() {
    console.log('👂 [Command] 獨立訊號接收器已啟動...');
    setInterval(async () => {
        try {
            const { data: commands } = await supabase.from('command_queue').select('*').order('created_at', { ascending: true });
            if (!commands || commands.length === 0) return;

            for (const cmd of commands) {
                console.log(`📥 [Command] 收到管理員指令: ${cmd.command_type} (${cmd.mint_address || 'All'})`);

                if (cmd.command_type === 'FORCE_SELL_ALL' || cmd.command_type === 'SELL_ALL') {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    sendAdminAlert(`🚨 <b>大盤雪崩，拔線逃生</b>\n管理員已按下紅色按鈕，全線強平清倉！`);

                    const { getPortfolio } = require('./portfolioService');
                    const positions = getPortfolio().positions;
                    for (const pos of positions) {
                        await runSellPipeline(pos, pos.highest_price_sol, "🚨 緊急拔線，無腦市價平倉", 1.0);
                        await new Promise(r => setTimeout(r, 1500)); 
                    }
                } 
                else if (cmd.command_type === 'SELL_SINGLE' && cmd.mint_address) {
                    const { getPortfolio } = require('./portfolioService');
                    const pos = getPortfolio().positions.find(p => p.mint_address === cmd.mint_address);
                    
                    if (pos) {
                        let currentPrice = pos.entry_price_sol;
                        if (pos.strategy_type.includes('MEME')) {
                            const priceUsdStr = await redis.get(`price_usd:${pos.mint_address}`);
                            if (priceUsdStr) currentPrice = parseFloat(priceUsdStr) / 150; 
                        } else {
                            currentPrice = trendingPriceCache.get(pos.mint_address) || pos.entry_price_sol;
                        }
                        console.log(`👨‍💻 [Command] 執行手推斬倉: ${pos.token_symbol}`);
                        await runSellPipeline(pos, currentPrice, "👨‍💻 管理員手動市價平倉", 1.0);
                    }
                }
                else if (cmd.command_type === 'PAUSE_BUY') {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '已暫停新開倉' }).eq('id', 1);
                    sendAdminAlert(`⏸️ <b>系統已暫停買入</b>`);
                }
                else if (cmd.command_type === 'RESUME_BUY') {
                    await supabase.from('system_config').update({ is_running: true, status_msg: '正常運作中' }).eq('id', 1);
                    sendAdminAlert(`▶️ <b>系統已恢復正常</b>`);
                }

                await supabase.from('command_queue').delete().eq('id', cmd.id);
            }
        } catch (err) {}
    }, 5000); 
}

function startOneMinuteMetricsAlert() {
    setInterval(() => {
        const currentAiCount = aiOrchestrator.requestCount || 0;
        const aiThisMinute = currentAiCount - lastAiCount;
        lastAiCount = currentAiCount;

        const currentWebhooks = webhooksThisMinute;
        webhooksThisMinute = 0; 

        const timeStr = new Date().toLocaleTimeString('zh-HK', { hour12: false });
        console.log(`[${timeStr}] 📊 Minute Heartbeat -> AI Call: ${aiThisMinute} | Webhook: ${currentWebhooks}`);
    }, 60000); 
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        console.log('🔄 [System] 啟動雙 Webhook 與雙軌防線...');
        await toggleHeliusWebhook(true);
        setTimeout(() => { startPositionMonitor(); }, 2000);
        setTimeout(() => { startRamCacheProcessor(); }, 3000); 
        setTimeout(() => { startDatabaseNurseryMonitor(); }, 4000);
        setTimeout(() => { startCommandListener(); }, 6000);
        setTimeout(() => { startOneMinuteMetricsAlert(); }, 8000);
    });
}
process.on('SIGINT', async () => { await toggleHeliusWebhook(false); process.exit(0); });
process.on('SIGTERM', async () => { await toggleHeliusWebhook(false); process.exit(0); });

module.exports = { startMarketMonitor };
