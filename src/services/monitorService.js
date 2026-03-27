// src/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase');
const axios = require('axios');
const crypto = require('crypto');
const configEnv = require('../config/env'); // 👈 [V7.0] 引入中央彈藥庫

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;
const { PublicKey } = require('@solana/web3.js');

const { runSellPipeline, executeBuy, handleIncomingFund, handleOutgoingFund } = require('./tradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { consensusService, getPendingMemeCount } = require('./consensusService');
const { analyzeReentry, reviewActivePosition } = require('./aiService');
const { retrospectiveJob } = require('../jobs/retrospectiveJob');
const { aiOrchestrator } = require('./aiOrchestrator');

// 👇👇👇 [V7.0 新增] 引入 Price Oracle 
const { priceOracleService } = require('./priceOracleService');
// 👆👆👆

const app = express();
app.use(express.json());
// 應付 Railway Healthcheck
app.get('/', (req, res) => {
    res.status(200).send('🟢 SOL_Trade V7.0 系統正常運行中');
});

// 🚀 [V7.0] 轉用中央彈藥庫
const HELIUS_API_KEY = configEnv.rpc.helius1.apiKey;           
const WEBHOOK_ID = configEnv.rpc.helius1.webhookId;
const HELIUS_API_KEY_2 = configEnv.rpc.helius2.apiKey;       
const WEBHOOK_ID_2 = configEnv.rpc.helius2.webhookId;

const NGROK_URL = process.env.NGROK_URL || "https://solana-ai-trade-bot-production.up.railway.app";

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

const botWallet = configEnv.solana.walletPublicKey; // 👈 [V7.0] 轉用中央彈藥庫

// 🚀 全新數據追蹤器：按來源及 Type 分類
let detailedStats = {};
let webhooksThisMinute = 0;
let lastAiCount = 0;

// 🚀 本地防洪開關
let isNurseryPoolFull = false; 

function initStatKey(key) {
    if (!detailedStats[key]) {
        detailedStats[key] = { received: 0, filtered: 0, added: 0 };
    }
}

// 🚀 V7.0 升級：嚴格 Base58 洗白，防 400 Bad Request
function sanitizeAddress(address) {
    if (!address) return null;
    const clean = address.toString().trim().replace(/[\n\r\t\s]/g, '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return null;
    return clean;
}

// 🚀 [新增] 定期檢查數據庫魚池容量，更新本地狀態
async function refreshPoolStatus() {
    try {
        const { count, error } = await supabase
            .from('nursery_pool')
            .select('*', { count: 'exact', head: true });
        
            if (!error && count !== null) {
            isNurseryPoolFull = count >= 200; 
            if (isNurseryPoolFull) {
                healthMonitor.setStatus('Meme_Radar', '🟡 魚池已滿 (本地暫停同步)');
            }
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
    if (!enable) {
        console.log('🛑 [Helius] 系統關閉，保留 Helius Dashboard 現有設定，不作修改。');
        return; 
    }

    const cleanUrl = NGROK_URL.replace(/\/$/, '');
    const targetUrl = `${cleanUrl}/webhook/helius`;
    console.log(`📡 [Helius] 正在確保雙 Webhook 連線至: ${targetUrl}`);

    if (HELIUS_API_KEY && WEBHOOK_ID) {
        try {
            const url1 = `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`;
            const payload1 = {
                webhookURL: targetUrl,
                transactionTypes: ["CREATE_POOL"], 
                accountAddresses: [RAYDIUM_V4_PROGRAM_ID],
                webhookType: "enhanced",
                txnStatus: "success" 
            };
            await axios.put(url1, payload1);
            console.log('✅ [Webhook 1] Raydium 專線設定同步成功！');
        } catch (err) {
            console.error('❌ [Webhook 1 Error] Raydium 更新失敗:', err.response?.data || err.message);
        }
    }

    if (HELIUS_API_KEY_2 && WEBHOOK_ID_2) {
        try {
            const url2 = `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID_2}?api-key=${HELIUS_API_KEY_2}`;
            const payload2 = {
                webhookURL: targetUrl,
                transactionTypes: ["TOKEN_MINT", "CREATE_POOL"], 
                accountAddresses: [PUMP_FUN_PROGRAM_ID],
                webhookType: "enhanced",
                txnStatus: "success" 
            };
            await axios.put(url2, payload2);
            console.log('✅ [Webhook 2] Pump.fun 專線設定同步成功 (安全模式)！');
        } catch (err) {
            console.error('❌ [Webhook 2 Error] Pump.fun 更新失敗:', err.response?.data || err.message);
        }
    }

    console.log('🔵 [Accounting] 會計部已移交 Alchemy 託管，程式內 Webhook 3 已解除掛載。');

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
        if (Array.isArray(req.body)) {
            events = req.body; 
        } else if (req.body && req.body.event && Array.isArray(req.body.event.activity)) {
            const activities = req.body.event.activity;
            const fakeHeliusEvent = {
                type: 'ALCHEMY_TRANSFER',
                signature: activities[0]?.hash || 'alchemy_tx',
                nativeTransfers: activities.map(act => ({
                    fromUserAccount: act.fromAddress,
                    toUserAccount: act.toAddress,
                    amount: parseFloat(act.value || 0) * 1e9
                }))
            };
            events.push(fakeHeliusEvent);
        } else {
            return; 
        }

        for (const event of events) {
            const eventType = event.type || 'UNKNOWN_TYPE';
            let sourceName = 'Other';

            const nativeTransfers = event.nativeTransfers || [];
            const isWalletAction = nativeTransfers.some(t => t.fromUserAccount === botWallet || t.toUserAccount === botWallet);

            if (isWalletAction) {
                sourceName = 'Wallet';
            } else if (event.instructions) {
                if (event.instructions.some(ix => ix.programId === PUMP_FUN_PROGRAM_ID)) {
                    sourceName = 'PumpFun';
                } else if (event.instructions.some(ix => ix.programId === RAYDIUM_V4_PROGRAM_ID)) {
                    sourceName = 'Raydium';
                }
            }

            const statKey = `[${sourceName}] ${eventType}`;
            initStatKey(statKey);
            detailedStats[statKey].received++;

            if (isWalletAction) {
                for (const t of nativeTransfers) {
                    const amount = t.amount / 1e9;
                    const txid = event.signature || 'alchemy_tx';

                    if (t.toUserAccount === botWallet && amount > 0) {
                        console.log(`💰 [Accounting] 偵測到入金: ${amount} SOL`);
                        await handleIncomingFund(t.fromUserAccount, amount, txid);
                    } 
                    else if (t.fromUserAccount === botWallet && amount > 0) {
                        if (t.toUserAccount.length > 32) { 
                            console.log(`💸 [Accounting] 偵測到出金: ${amount} SOL`);
                            await handleOutgoingFund(t.toUserAccount, amount, txid);
                        }
                    }
                }
                continue; 
            }

            let newMemeAddress = null;

            if (event.tokenTransfers && event.tokenTransfers.length > 0) {
                const transfer = event.tokenTransfers.find(t => 
                    t.mint !== SOL_MINT_ADDRESS && 
                    t.mint !== SYSTEM_PROGRAM_ID && 
                    t.mint.length > 32
                );
                if (transfer) newMemeAddress = sanitizeAddress(transfer.mint);
            }

            if (!newMemeAddress && event.instructions) {
                for (const ix of event.instructions) {
                    if (ix.programId === PUMP_FUN_PROGRAM_ID || ix.programId === RAYDIUM_V4_PROGRAM_ID) {
                        if (ix.accounts) {
                            const potentialMint = ix.accounts.find(acc => 
                                acc !== SOL_MINT_ADDRESS && 
                                acc !== SYSTEM_PROGRAM_ID && 
                                acc !== PUMP_FUN_PROGRAM_ID && 
                                acc.length > 32
                            );
                            if (potentialMint) {
                                newMemeAddress = sanitizeAddress(potentialMint);
                                break;
                            }
                        }
                    }
                }
            }

            if (newMemeAddress) {
                detailedStats[statKey].filtered++;
            
                if (isNurseryPoolFull) {
                    return; 
                }
                const { data: isInserted } = await supabase.rpc('insert_fish_with_limit', {
                    new_mint_address: newMemeAddress
                });
                if (isInserted) {
                    detailedStats[statKey].added++; 
                } else {
                    isNurseryPoolFull = true;
                    detailedStats[statKey].dropped++;
                }
            } 
        }
    } catch (err) {
        console.error('❌ [Webhook Error]', err.message);
    }
});

// ==========================================
// 🌐 [Master AI 控制中心] - HTML 介面
// ==========================================
app.get('/force-evolution', (req, res) => {
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Master AI 控制中心</title>
            <style>
                body { font-family: sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: #1e293b; padding: 2.5rem; border-radius: 1.5rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; max-width: 450px; border: 1px solid #334155; }
                h1 { color: #38bdf8; margin-bottom: 1rem; font-size: 1.5rem; }
                p { color: #94a3b8; margin-bottom: 2rem; line-height: 1.6; }
                .btn { background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%); color: white; border: none; padding: 1rem 2rem; font-size: 1.1rem; border-radius: 0.75rem; cursor: pointer; transition: all 0.2s; width: 100%; font-weight: 700; text-transform: uppercase; }
                .btn:hover { transform: scale(1.02); filter: brightness(1.1); box-shadow: 0 0 20px rgba(14,165,233,0.4); }
                .status-badge { display: inline-block; padding: 0.25rem 0.75rem; background: #064e3b; color: #34d399; border-radius: 1rem; font-size: 0.75rem; margin-bottom: 1rem; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="status-badge">PROTOCOL V7.2 READY</div>
                <h1>🧠 Master AI 控制中心</h1>
                <p>啟動後，Master AI 將強制掃描過去 12 小時戰報，執行「深度敗因分析」並自動修正 AI 戰鬥腳本與系統參數。</p>
                <form action="/force-evolution" method="POST">
                    <button type="submit" class="btn">🔥 立即執行手動進化</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// 3. 真正執行啟動嘅 POST 路由
app.post('/force-evolution', (req, res) => {
    console.log('\n👑 [Admin] 管理員已透過手動介面觸發 Master AI 進化！');
    
    try {
        // 執行進化程序（唔需要 await，等佢背景行）
        retrospectiveJob.runEvolutionWithRetry(1).catch(e => {
            console.error("❌ 背景進化失敗:", e.message);
        });

        res.status(200).send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"></head>
            <body style="background: #0f172a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh;">
                <div style="text-align: center; border: 1px solid #22c55e; padding: 3rem; border-radius: 1rem; background: #1e293b;">
                    <h1 style="color: #22c55e;">🚀 進化指令已發出！</h1>
                    <p>Master AI 正在處理中。請留意 Email 報告與 Telegram 戰報推送。</p>
                    <a href="/force-evolution" style="color: #38bdf8; text-decoration: none;">← 返回</a>
                </div>
            </body>
            </html>
        `);
    } catch (e) {
        res.status(500).send('<h1>❌ 啟動失敗</h1>');
    }
});

function startWebhookStatsMonitor() {
    setInterval(() => {
        console.log(`\n========================================`);
        console.log(`📡 [Webhook 戰況] 過去 5 分鐘詳細雷達報告:`);

        const keys = Object.keys(detailedStats);
        
        if (keys.length === 0) {
            console.log(`   📭 暫無收到任何 Webhook 訊號`);
        } else {
            let totalReceived = 0, totalFiltered = 0, totalAdded = 0;
            
            keys.forEach(key => {
                const s = detailedStats[key];
                totalReceived += s.received;
                totalFiltered += s.filtered;
                totalAdded += s.added;
                const discarded = s.received - s.added;
                
                console.log(`   🏷️ ${key}:`);
                console.log(`      📥 接收: ${s.received} | 💊 抽幣: ${s.filtered} | 🐟 入池: ${s.added} | 🗑️ 拋棄: ${discarded}`);
            });
            
            console.log(`   -------------------------------------`);
            console.log(`   📊 總計 -> 📥: ${totalReceived} | 💊: ${totalFiltered} | 🐟: ${totalAdded}`);
        }
        console.log(`========================================\n`);

        detailedStats = {}; 
    }, 5 * 60 * 1000); 
}

async function triggerBuyPipeline(mintAddress, secResult, config) {
    while (isAiReviewing) {
        await new Promise(r => setTimeout(r, 1000));
    }

    isAiReviewing = true; 
    try {
        if (secResult.isBlindSnipe) {
            console.log(`🎯 [BlindSnipe] 觸發盲狙模式，即刻呼叫大腦！`);
        }
        const aiDecision = await consensusService.runMemeConsensus(mintAddress, secResult.marketData);
        
        if (aiDecision.buy) {
            const strategy = secResult.isBlindSnipe ? 'MEME_BLIND' : 'MEME_SNIPE';
            const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, strategy, aiDecision.score, aiDecision.reason, config.trade_amount_sol);
            
            if (buyResult !== false) {
                console.log(`\n======================================================`);
                console.log(`✅ 🟢 【買入指令已送出 - ${secResult.marketData.symbol}】 🟢 ✅`);
                console.log(`📍 策略: ${strategy}`);
                console.log(`投入金額: ${config.trade_amount_sol} SOL`);
                console.log(`🤖 AI 買入理由: ${aiDecision.reason}`);
                console.log(`======================================================\n`);
            }
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
    console.log('🐟 [Nursery Radar] 全 DB 依賴過濾系統已啟動 (404 緩刑防頂死支援)');
    
    setInterval(async () => {
        if (isNurseryRunning) return;
        
        const queueLength = getPendingMemeCount();
        if (queueLength >= 3) {
            healthMonitor.setStatus('Meme_Radar', `🟡 議事廳爆滿 (${queueLength} 單)`);
            return;
        }

        isNurseryRunning = true;
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) {
                healthMonitor.setStatus('Meme_Radar', '🟡 系統已暫停');
                isNurseryRunning = false; return;
            }

            const { data: tokens } = await supabase.from('nursery_pool').select('*').order('created_at', { ascending: true }).limit(20);

            if (tokens && tokens.length > 0) {
                let processed = false;
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
                            console.log(`\n======================================================`);
                            console.log(`🎣 [Nursery] 撈出熟魚: ${mintAddress.substring(0,6)} (已坐監 ${ageMins.toFixed(1)} 分鐘)`);
                            console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);
                            console.log(`======================================================\n`);
                            await triggerBuyPipeline(mintAddress, secResult, config);
                        } else {
                            if (secResult.isPurgatory && ageMins < 5) {
                                console.log(`⏳ [Nursery] ${mintAddress.substring(0,6)} Indexer 未準備好或流動性不足，留池等待 (年齡: ${ageMins.toFixed(1)}m)`);
                            } else {
                                const reason = secResult.reason || '';
                                if (!reason.includes('查無報價') && !reason.includes('死水') && !reason.includes('流動性太窮') && !reason.includes('等待廣播中')) {
                                    console.log(`🛡️ [Security] 攔截並移除 ${mintAddress.substring(0,6)}: ${reason}`);
                                }
                                await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                            }
                        }
                        processed = true;
                        break; 
                    }
                }
                if (!processed) {
                    healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
                }
            } else {
                healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
            }

        } catch (err) {
            console.error(`❌ [Nursery Radar Error]`, err.message);
            healthMonitor.setStatus('Meme_Radar', `🔴 雷達故障: ${err.message}`);
        } finally {
            isNurseryRunning = false;
        }
    }, 30000); 
}

function startWatchlistMonitor() {
    console.log('📋 [Watchlist Radar] 橫盤接回雷達啟動...');
    
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;

            const mints = watchlist.map(w => w.mint_address);
            
            const pricesMap = await priceOracleService.getPrices(mints);

            for (const item of watchlist) {
                const tokenData = pricesMap[item.mint_address];
                const currentPrice = tokenData ? tokenData.priceUsd : 0;
                
                if (currentPrice === 0) continue;

                const baseline = parseFloat(item.baseline_price_sol);
                const consolidationStartTime = new Date(item.consolidation_start_time).getTime();
                const now = Date.now();
                const minutesConsolidated = (now - consolidationStartTime) / (1000 * 60);

                if (currentPrice >= baseline * 1.05) {
                    console.log(`📈 [Watchlist] ${item.token_symbol} 突破前高，放棄接回！`);
                    await supabase.from('reentry_watchlist').delete().eq('id', item.id);
                    continue;
                }
                if (currentPrice <= baseline * 0.8) {
                    console.log(`📉 [Watchlist] ${item.token_symbol} 跌破支撐，放棄接回！`);
                    await supabase.from('reentry_watchlist').delete().eq('id', item.id);
                    continue;
                }

                if (minutesConsolidated >= 30) {
                    console.log(`⏳ [Watchlist] ${item.token_symbol} 已橫盤 30 分鐘，啟動 Re-entry 審查...`);
                    const { data: config } = await supabase.from('system_config').select('trade_amount_sol').eq('id', 1).single();
                    
                    const decisionObj = await analyzeReentry(item.mint_address, item.token_symbol, baseline);
                    
                    if (decisionObj.decision === 'BUY') {
                        const buyResult = await executeBuy(item.mint_address, item.token_symbol, 'MEME_REENTRY', decisionObj.score || 95, decisionObj.reason, config.trade_amount_sol);
                        if (buyResult !== false) {
                            console.log(`\n======================================================`);
                            console.log(`✅ 🟢 【接回成功 - ${item.token_symbol}】 🟢 ✅`);
                            console.log(`📍 策略: MEME_REENTRY`);
                            console.log(`🤖 AI 買入理由: ${decisionObj.reason}`);
                            console.log(`======================================================\n`);
                        }
                    } else {
                        console.log(`🧠 [Reentry Rejected] 否決: ${decisionObj.reason}`);
                    }
                    
                    await supabase.from('reentry_watchlist').delete().eq('id', item.id);
                }
            }
        } catch (err) {
            console.error(`❌ [Watchlist Monitor Error]`, err.message);
        }
    }, 60000); 
}

function startPositionMonitor() {
    console.log('👁️ [Radar] 智能極速雙軌持倉監控啟動 (5s物理止損 + 15s大腦巡邏)...');
    
    let cachedSolPriceUsd = 150; 
    const sellingLocks = new Set(); // 👈 互斥鎖已就位

    setInterval(async () => {
        try {
            const { getSolPriceInHKD } = require('./priceService');
            const solPriceHKD = await getSolPriceInHKD();
            cachedSolPriceUsd = solPriceHKD / 7.8;
        } catch(e) {}
    }, 60000);

    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const positions = portfolio.positions;
            
            if (!positions || positions.length === 0) return;

            const mints = positions.map(p => p.mint_address);
            let pricesMap = {};

            for (const mint of mints) {
                const cachedData = priceOracleService.cache.get(mint);
                if (cachedData) {
                    if (cachedData.priceSol) {
                        pricesMap[mint] = cachedData.priceSol;
                    } else if (cachedData.priceUsd) {
                        pricesMap[mint] = cachedData.priceUsd / cachedSolPriceUsd;
                    }
                }
            }

            const STOP_LOSS_PCT = parseFloat(config.stop_loss_pct || -10);

            for (const pos of positions) {
                // 🛑 核心防禦：如果這隻幣已經在執行賣出，直接跳過本輪循環！
                if (sellingLocks.has(pos.mint_address)) continue;

                const currentPrice = pricesMap[pos.mint_address];
                if (!currentPrice) continue; 

                const pnlSol = (currentPrice - pos.entry_price_sol) * pos.quantity;
                const pnlPct = (pnlSol / (pos.entry_price_sol * pos.quantity)) * 100;
                
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                if (currentPrice > pos.highest_price_sol) {
                    pos.highest_price_sol = currentPrice;
                    supabase.from(`active_positions_${tableSuffix}`).update({ highest_price_sol: currentPrice }).eq('mint_address', pos.mint_address).then();
                }

                const drawdownFromHigh = ((currentPrice - pos.highest_price_sol) / pos.highest_price_sol) * 100;
                const highestPnlPct = ((pos.highest_price_sol - pos.entry_price_sol) / pos.entry_price_sol) * 100;

                const isBluechip = pos.strategy_type && pos.strategy_type.includes('BLUECHIP');
                const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');

                let action = 'HOLD';
                let reason = '';
                let sellFraction = 1.0; 

                if (isBluechip && highestPnlPct >= 5.0 && pnlPct <= 0.5) {
                    action = 'SELL';
                    reason = `🛡️ [老幣保本機制] 利潤曾達 +${highestPnlPct.toFixed(2)}% 現回落至成本線，強制結利`;
                } else if (pnlPct <= STOP_LOSS_PCT) {
                    action = 'SELL';
                    reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${STOP_LOSS_PCT}%)`;
                } else if (!isHalfSold && highestPnlPct >= 100) {
                    action = 'SELL';
                    sellFraction = 0.5;
                    reason = `🚀 翻倍回本機制 (歷史最高達 +${highestPnlPct.toFixed(2)}%，賣出 50% 鎖定成本)`;
                } else if (isHalfSold && drawdownFromHigh <= -30) {
                    action = 'SELL';
                    reason = `💰 登月尾倉止盈 (翻倍後高位回撤 ${drawdownFromHigh.toFixed(2)}%，全數獲利了結)`;
                } else if (!isHalfSold && highestPnlPct >= 50 && drawdownFromHigh <= -15) {
                    action = 'SELL';
                    reason = `💰 觸發無腦利潤保護 (歷史最高: +${highestPnlPct.toFixed(2)}%，高位回撤: ${drawdownFromHigh.toFixed(2)}%)`;
                } 

                if (action === 'SELL') {
                    if (isBluechip && !isHalfSold && pnlPct > 0 && sellFraction === 1.0) {
                        sellFraction = 0.5;
                        reason = `[老幣分批止盈] ${reason}`;
                    }

                    // 🛑 上鎖！阻止後續循環重複賣出
                    sellingLocks.add(pos.mint_address);

                    runSellPipeline(pos, currentPrice, reason, sellFraction).then(sellResult => {
                        if (sellResult && sellFraction === 0.5) {
                            sendTelegramAlert(`🌟 <b>翻倍/分批鎖定利潤</b>\n🪙 代幣: $${pos.token_symbol}\n賣出 50% 鎖定利潤，剩餘尾倉讓利潤奔跑！`);
                        }
                    }).catch(err => {
                        console.error(`❌ [Track 1 Sell Error]`, err.message);
                    }).finally(() => {
                        // 🛑 解鎖！無論成功失敗都釋放
                        sellingLocks.delete(pos.mint_address);
                    });
                }
            }
        } catch (err) {
            console.error(`❌ [Position Monitor] 5s 極速引擎異常:`, err.message);
        }
    }, 5000); 

    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const positions = portfolio.positions;
            
            if (!positions || positions.length === 0) {
                if (aiReviewCooldowns.size > 0) aiReviewCooldowns.clear();
                healthMonitor.setStatus('AI_Overseer', '🟢 巡邏完畢 (無持倉)');
                return;
            }

            const currentMints = new Set(positions.map(p => p.mint_address));
            for (const mint of aiReviewCooldowns.keys()) {
                if (!currentMints.has(mint)) aiReviewCooldowns.delete(mint);
            }

            for (const pos of positions) {
                // 🛑 核心防禦：如果 2 秒物理 Loop 已經在賣出這隻幣，AI 巡邏直接跳過，不干涉！
                if (sellingLocks.has(pos.mint_address)) continue;

                const nowMs = Date.now();
                const lastReviewMs = aiReviewCooldowns.get(pos.mint_address) || 0;
                
                if ((nowMs - lastReviewMs) / 60000 < 5) continue; 

                const cachedData = priceOracleService.cache.get(pos.mint_address);
                if (!cachedData) continue;
                
                const currentPrice = cachedData.priceSol ? cachedData.priceSol : (cachedData.priceUsd / cachedSolPriceUsd);
                const pnlPct = (((currentPrice - pos.entry_price_sol) * pos.quantity) / (pos.entry_price_sol * pos.quantity)) * 100;

                aiReviewCooldowns.set(pos.mint_address, nowMs);

                console.log(`\n👁️ [AI Overseer] 正在審查 ${pos.token_symbol} (PNL: ${pnlPct.toFixed(2)}%)...`);
                
                try {
                    const posDataForAI = { ...pos, currentPrice, pnlPct, mode: portfolio.mode };
                    const reviewResult = await reviewActivePosition(pos.mint_address, posDataForAI);
                    
                    if (reviewResult.decision === 'RETRY_LATER') {
                        aiReviewCooldowns.set(pos.mint_address, nowMs - (3 * 60 * 1000));
                        continue; 
                    }

                    if (reviewResult.decision === 'EXIT' || reviewResult.decision === 'SELL') {
                        // 🛑 上鎖！
                        sellingLocks.add(pos.mint_address);

                        runSellPipeline(pos, currentPrice, `AI 指示: ${reviewResult.reason}`, 1.0)
                            .catch(err => console.error(`❌ [Track 2 Sell Error]`, err.message))
                            .finally(() => {
                                aiReviewCooldowns.delete(pos.mint_address);
                                // 🛑 解鎖！
                                sellingLocks.delete(pos.mint_address);
                            });
                    } else {
                        console.log(`🛡️ [AI 決策] ${pos.token_symbol} 繼續持有。理由: ${reviewResult.reason}\n`);
                    }
                } catch (aiErr) {
                    console.error(`❌ [AI Reviewer] 發生錯誤:`, aiErr.message);
                    aiReviewCooldowns.set(pos.mint_address, nowMs - (4 * 60 * 1000)); 
                }
            }
        } catch (err) {
            console.error(`❌ [Position Monitor] AI 巡邏引擎異常:`, err.message);
            healthMonitor.setStatus('AI_Overseer', `🔴 監控異常: ${err.message}`);
        }
    }, 15000);
}

function startCommandListener() {
    console.log('👂 [Command] 獨立訊號接收器已啟動...');
    setInterval(async () => {
        try {
            const { data: commands } = await supabase.from('command_queue').select('*').order('created_at', { ascending: true });
            if (!commands || commands.length === 0) return;

            for (const cmd of commands) {
                console.log(`📥 [Command] 收到管理員指令: ${cmd.command_type} (${cmd.mint_address})`);

                if (cmd.command_type === 'FORCE_SELL_ALL') {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    sendAdminAlert(`🚨 <b>大盤雪崩，拔線逃生</b>\n管理員已按下紅色按鈕，全線強平清倉！`);

                    const { getPortfolio } = require('./portfolioService');
                    const positions = getPortfolio().positions;
                    for (const pos of positions) {
                        await runSellPipeline(pos, pos.highest_price_sol, "🚨 緊急拔線，無腦市價市平倉", 1.0);
                        await new Promise(r => setTimeout(r, 1500)); 
                    }
                } 
                else if (cmd.command_type === 'PAUSE_BUY') {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '已暫停新開倉' }).eq('id', 1);
                    sendAdminAlert(`⏸️ <b>系統已暫停買入</b>\n持倉監控會繼續運作，但不會買入新幣。`);
                }
                else if (cmd.command_type === 'RESUME_BUY') {
                    await supabase.from('system_config').update({ is_running: true, status_msg: '正常運作中' }).eq('id', 1);
                    sendAdminAlert(`▶️ <b>系統已恢復正常</b>\n雷達已重新啟動。`);
                }

                await supabase.from('command_queue').delete().eq('id', cmd.id);
            }
        } catch (err) {
            console.error(`❌ [Command Error]`, err.message);
        }
    }, 5000);
}

function startOneMinuteMetricsAlert() {
    console.log('⏱️ [Metrics] 1 分鐘極速雷達已啟動 (純 Log 模式)...');
    
    setInterval(() => {
        const currentAiCount = aiOrchestrator.requestCount || 0;
        const aiThisMinute = currentAiCount - lastAiCount;
        lastAiCount = currentAiCount;

        const currentWebhooks = webhooksThisMinute;
        webhooksThisMinute = 0; 

        const currentOracleQueue = healthMonitor.oracleQueueSize || 0;

        const timeStr = new Date().toLocaleTimeString('zh-HK', { hour12: false });
        
        console.log(`[${timeStr}] 📊 Minute Heartbeat -> AI Call: ${aiThisMinute} | Webhook: ${currentWebhooks} | Oracle Queue: ${currentOracleQueue}`);
        
    }, 60000); 
}

// 🚀 [V7.2] 錯峰啟動機制：防開機瞬間 RPC 429 崩潰
function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        console.log('🔄 [System] 系統啟動，準備載入雙 Webhook 模組...');
        await toggleHeliusWebhook(true);
        healthMonitor.setStatus('Trade_Engine', '🟢 正常待命');

        console.log('⏳ [Boot Sequence] 啟動錯峰點火機制，每隔 2 秒喚醒一個雷達 (防 RPC 429 洪峰)...');

        // 第 2 秒：喚醒持倉監控 (最重要，先保命)
        setTimeout(() => { 
            startPositionMonitor(); 
        }, 2000);

        // 第 4 秒：喚醒魚池雷達
        setTimeout(() => { 
            startDatabaseNurseryMonitor(); 
        }, 4000);

        // 第 6 秒：喚醒接回雷達
        setTimeout(() => { 
            startWatchlistMonitor(); 
        }, 6000);

        // 第 8 秒：喚醒指令接收器
        setTimeout(() => { 
            startCommandListener(); 
        }, 8000);

        // 第 10 秒：喚醒統計模組
        setTimeout(() => { 
            startWebhookStatsMonitor(); 
            startOneMinuteMetricsAlert();
            console.log('✅ [Boot Sequence] 所有 Web/監控 雷達錯峰點火完畢！系統進入平穩巡航狀態。');
        }, 10000);
    });
}

process.on('SIGINT', async () => {
    console.log('\n🛑 [System] 接收到關閉訊號...');
    await toggleHeliusWebhook(false);
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('\n🛑 [System] 接收到重啟訊號...');
    await toggleHeliusWebhook(false);
    process.exit(0);
});

module.exports = { startMarketMonitor };