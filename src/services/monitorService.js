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

// 🚀 [新增] 紀錄最後一次 Redis 更新時間，用作備援雷達判定
let lastRedisUpdateMs = Date.now();
let isHttpFallbackActive = false;

const app = express();
const cors = require('cors'); 
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('🟢 SOL_Trade V8.2 系統正常運行中 (0 延遲防禦版)'));

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
    } catch (e) {
        console.error("⚠️ 探測魚池狀態失敗:", e.message);
    }
}
setInterval(refreshPoolStatus, 10000);

const aiReviewCooldowns = new Map(); 
const nurseryScanCooldown = new Map(); 
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
    healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
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
                if (isNurseryPoolFull) return; 
                const { data: isInserted } = await supabase.rpc('insert_fish_with_limit', { new_mint_address: newMemeAddress });
                if (isInserted) detailedStats[statKey].added++; 
                else { isNurseryPoolFull = true; detailedStats[statKey].dropped++; }
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

let isNurseryRunning = false;
function startDatabaseNurseryMonitor() {
    console.log('🐟 [Nursery Radar] 全 DB 依濾系統已啟動 (404 緩刑防頂死支援)');
    setInterval(async () => {
        if (isNurseryRunning) return;
        const queueLength = getPendingMemeCount();
        if (queueLength >= 3) return;

        isNurseryRunning = true;
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) { isNurseryRunning = false; return; }

            const { data: tokens } = await supabase.from('nursery_pool').select('*').order('created_at', { ascending: true }).limit(20);
            if (tokens && tokens.length > 0) {
                for (const token of tokens) {
                    const mintAddress = token.mint_address;
                    const lastChecked = nurseryScanCooldown.get(mintAddress) || 0;
                    if (Date.now() - lastChecked < 15000) continue; 

                    nurseryScanCooldown.set(mintAddress, Date.now());
                    const ageMins = (Date.now() - new Date(token.created_at).getTime()) / 60000;

                    if (ageMins > config.max_age_mins) {
                        await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                        continue;
                    } 
                    if (ageMins >= config.min_age_mins) {
                        const { securityGuard } = require('./securityGuard');
                        const secResult = await securityGuard.checkAll(mintAddress);
                        if (secResult.isSafe) {
                            await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                            await triggerBuyPipeline(mintAddress, secResult, config);
                        } else {
                            if (!(secResult.isPurgatory && ageMins < 5)) {
                                await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                            }
                        }
                        break; 
                    }
                }
            }
        } catch (err) {} finally { isNurseryRunning = false; }
    }, 30000); 
}

// ==========================================
// 🛡️ V8.2 雙軌核心秒斬防線 (實時處理)
// ==========================================
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

    let action = 'HOLD';
    let reason = '';
    let sellFraction = 1.0; 

    // 🚀 [新增] 雙軌賣出策略：判斷係 Meme 定 Trending，設定唔同門檻
    const isMeme = pos.strategy_type.includes('MEME');
    
    const flashCrashThr = isMeme ? -10 : -7;       // 1分鐘插水: Meme 容忍 10%，Trending 容忍 7%
    const cliffDropThr = isMeme ? -40 : -20;       // 回撤斷崖: Meme 容忍 40%，Trending 容忍 20%
    const trailingProfitThr = isMeme ? 50 : 20;    // 移動止盈啟動點: Meme 賺 50% 啟動，Trending 賺 20% 啟動
    const trailingDrawdownThr = isMeme ? -30 : -12; // 移動止盈回撤: Meme -30% 鎖潤，Trending -12% 鎖潤
    const lockPrincipalThr = isMeme ? 95 : 40;     // 翻倍鎖本: Meme 賺 95% 賣一半，Trending 賺 40% 賣一半

    if (dropFrom1MinHigh <= flashCrashThr) {
        action = 'SELL'; reason = `🚨 觸發瀑布防線：1 分鐘內極速插水 ${dropFrom1MinHigh.toFixed(2)}%`;
    } else if (pnlPct <= STOP_LOSS_PCT) {
        action = 'SELL'; reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${STOP_LOSS_PCT}%)`;
    } else if (drawdownFromHigh <= cliffDropThr) {
        action = 'SELL'; reason = `🚨 偵測到斷崖式崩盤 (回撤 ${drawdownFromHigh.toFixed(2)}%)`;
    } else if (highestPnlPct >= trailingProfitThr && drawdownFromHigh <= trailingDrawdownThr) {
        action = 'SELL'; reason = `💰 觸發統一移動止盈 (曾賺 +${highestPnlPct.toFixed(2)}%，現回撤 ${drawdownFromHigh.toFixed(2)}%)`;
    } else if (!isHalfSold && highestPnlPct >= lockPrincipalThr) { 
        action = 'SELL'; sellFraction = 0.5; reason = `🚀 觸發利潤保護 (歷史最高: +${highestPnlPct.toFixed(2)}%)，賣 50% 鎖定本金`;
    }

    if (action === 'SELL') {
        sellingLocks.add(pos.mint_address);
        priceHistory1Min.delete(pos.mint_address);
        
        runSellPipeline(pos, currentPriceSol, reason, sellFraction).then(sellResult => {
            if (sellResult && sellFraction === 0.5) sendTelegramAlert(`🌟 <b>分批鎖定利潤</b>\n🪙 代幣: $${pos.token_symbol}\n賣出 50% 鎖定利潤！`);
        }).catch(err => console.error(`❌ [Zero Latency Sell Error]`, err.message))
          .finally(() => sellingLocks.delete(pos.mint_address));
    }
}

function startPositionMonitor() {
    console.log('👁️ [Radar] V8.2 雙軌秒斬防線 + HTTP 備援雷達 已啟動...');
    let cachedSolPriceUsd = 150; 
    const { getSolPriceInHKD } = require('./priceService');
    
    setInterval(async () => {
        try { const solPriceHKD = await getSolPriceInHKD(); cachedSolPriceUsd = solPriceHKD / 7.8; } catch(e) {}
    }, 60000);

    // 📡 1. 派更機制 (Meme)
    setInterval(async () => {
        const { getPortfolio } = require('./portfolioService');
        const portfolio = getPortfolio();
        if (!portfolio || !portfolio.positions) return;

        const memeMints = portfolio.positions.filter(p => p.strategy_type && p.strategy_type.includes('MEME')).map(p => p.mint_address);
        if (memeMints.length > 0) await redis.set('active_watch_mints', JSON.stringify(memeMints), 'EX', 10);
        else await redis.del('active_watch_mints');
    }, 2000);

    // ⚡ 2. 零延遲 Pub/Sub 接收器 (正常模式)
    redisSub.subscribe('price_updates', (err) => { if (err) console.error('❌ [Pub/Sub] 訂閱失敗:', err); });
    redisSub.on('message', async (channel, message) => {
        if (channel === 'price_updates') {
            lastRedisUpdateMs = Date.now(); // 🚀 [新增] 每次收到價錢更新時間
            try {
                const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!config || !config.is_running) return;
                const { getPortfolio } = require('./portfolioService');
                const portfolio = getPortfolio();
                const { mint, priceUsd } = JSON.parse(message);
                const currentPriceSol = priceUsd / cachedSolPriceUsd; 
                await handleZeroLatencyCheck(mint, currentPriceSol, config, portfolio);
            } catch (err) {}
        }
    });

    // 🚁 3. HTTP 備援雷達 (當 Redis 死機超過 1 分鐘時啟動)
    setInterval(async () => {
        const timeSinceLastRedis = Date.now() - lastRedisUpdateMs;
        const { getPortfolio } = require('./portfolioService');
        const portfolio = getPortfolio();
        
        if (timeSinceLastRedis > 60000 && portfolio?.positions?.length > 0) {
            if (!isHttpFallbackActive) {
                isHttpFallbackActive = true;
                sendAdminAlert(`⚠️ <b>[情報源中斷]</b>\n超過 1 分鐘未收到 Koyeb 無人機報價！\n大本營已自動啟動 HTTP 備援查價 (每 10 秒)。`);
                console.log(`🚨 [Fallback] 啟動每 10 秒 HTTP 備援查價...`);
            }

            try {
                const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!config || !config.is_running) return;
                
                const mints = portfolio.positions.map(p => p.mint_address).join(',');
                const { data } = await axios.get(`https://price.jup.ag/v6/price?ids=${mints}`, { timeout: 3000 }); // V2 API
                
                if (data?.data) {
                    for (const pos of portfolio.positions) {
                        if (data.data[pos.mint_address] && data.data[pos.mint_address].price) {
                            const solPrice = data.data[pos.mint_address].price / cachedSolPriceUsd;
                            await handleZeroLatencyCheck(pos.mint_address, solPrice, config, portfolio);
                        }
                    }
                }
            } catch (err) { console.warn(`⚠️ [Fallback] 備援 HTTP 查價失敗`); }

        } else if (timeSinceLastRedis <= 60000 && isHttpFallbackActive) {
            isHttpFallbackActive = false;
            sendAdminAlert(`✅ <b>[情報源恢復]</b>\nRedis 報價重新連線，大本營已關閉 HTTP 備援，切換回 0 延遲模式！`);
            console.log(`🟢 [Fallback] 關閉備援，恢復 Redis 監聽。`);
        }
    }, 10000); // 🚀 [新增] 每 10 秒 Check 一次

    // 🐢 4. Top 100 慢速專線 (每 60 秒批次查 Jupiter)
    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;
            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            if (!portfolio || !portfolio.positions) return;

            const trendingMints = portfolio.positions.filter(p => p.strategy_type && p.strategy_type.includes('TRENDING')).map(p => p.mint_address);
            if (trendingMints.length === 0) return;

            const ids = trendingMints.join(',');
            const { data } = await axios.get(`https://api.jup.https://price.jup.ag/v6/price?ids=ag/price/v2?ids=${ids}`, { timeout: 3000 }); // V2 API
            if (data && data.data) {
                for (const mint of trendingMints) {
                    if (data.data[mint] && data.data[mint].price) {
                        const priceUsd = data.data[mint].price;
                        const currentPriceSol = priceUsd / cachedSolPriceUsd;
                        trendingPriceCache.set(mint, currentPriceSol); 
                        await handleZeroLatencyCheck(mint, currentPriceSol, config, portfolio);
                    }
                }
            }
        } catch (err) {}
    }, 60000);

    // 🧠 5. AI 戰略巡邏 (降頻至 3 分鐘)
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

    // 🧹 6. DB 同步工
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

// ==========================================
// 👂 Command Listener 與系統啟動
// ==========================================
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
        console.log('🔄 [System] 系統啟動，準備載入雙 Webhook 模組...');
        await toggleHeliusWebhook(true);
        healthMonitor.setStatus('Trade_Engine', '🟢 正常待命');

        console.log('⏳ [Boot Sequence] 啟動錯峰點火機制...');

        setTimeout(() => { startPositionMonitor(); }, 2000);
        setTimeout(() => { startDatabaseNurseryMonitor(); }, 4000);
        setTimeout(() => { startCommandListener(); }, 6000);

        setTimeout(() => { 
            startOneMinuteMetricsAlert(); 
            console.log('✅ [Boot Sequence] 所有雷達點火完畢！系統進入 V8.2 巡航狀態。');
        }, 8000);
    });
}

process.on('SIGINT', async () => { console.log('\n🛑 接收到關閉訊號...'); await toggleHeliusWebhook(false); process.exit(0); });
process.on('SIGTERM', async () => { console.log('\n🛑 接收到重啟訊號...'); await toggleHeliusWebhook(false); process.exit(0); });

module.exports = { startMarketMonitor };