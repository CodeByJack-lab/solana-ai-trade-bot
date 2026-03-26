// src/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase');
const axios = require('axios');
const crypto = require('crypto');
let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;
const { PublicKey } = require('@solana/web3.js');

const { runSellPipeline, executeBuy, handleIncomingFund, handleOutgoingFund } = require('./tradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { consensusService, getPendingMemeCount } = require('./consensusService');
const { analyzeReentry, reviewActivePosition } = require('./aiService');
const { retrospectiveJob } = require('../jobs/retrospectiveJob');

const app = express();
app.use(express.json());

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;           
const WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID;
const HELIUS_API_KEY_2 = process.env.HELIUS_API_KEY_2;       
const WEBHOOK_ID_2 = process.env.HELIUS_WEBHOOK_ID_2;

const NGROK_URL = process.env.NGROK_URL || "https://solana-ai-trade-bot-production.up.railway.app";

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

const botWallet = process.env.MY_WALLET_PUBLIC_KEY;

// 🚀 全新數據追蹤器：按來源及 Type 分類
let detailedStats = {};

// 🚀 本地防洪開關
let isNurseryPoolFull = false; 

function initStatKey(key) {
    if (!detailedStats[key]) {
        detailedStats[key] = { received: 0, filtered: 0, added: 0 };
    }
}

// 🚀 [新增] 定期檢查數據庫魚池容量，更新本地狀態
async function refreshPoolStatus() {
    try {
        const { count, error } = await supabase
            .from('nursery_pool')
            .select('*', { count: 'exact', head: true });
        
            if (!error && count !== null) {
            // 與 SQL Function 門檻一致，滿 250 隻即鎖死同步
            isNurseryPoolFull = count >= 200; 
            if (isNurseryPoolFull) {
                healthMonitor.setStatus('Meme_Radar', '🟡 魚池已滿 (本地暫停同步)');
            }
        }
    } catch (e) {
        console.error("⚠️ 探測魚池狀態失敗:", e.message);
    }
}
// 啟動 10 秒循環探針
setInterval(refreshPoolStatus, 10000);

const aiReviewCooldowns = new Map(); // 新增：AI 大腦專用冷卻計時器
const ramSecondaryPool = new Map(); 
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

// ==========================================
// 🚀 Helius / Alchemy 專屬路由：處理會計部與雷達
// ==========================================
app.post('/webhook/helius', async (req, res) => {
    res.status(200).send('OK'); 

    try {
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) return;

        // 🚀 智能格式轉換：兼容 Helius (Array) 與 Alchemy (Object)
        let events = [];
        if (Array.isArray(req.body)) {
            events = req.body; 
        } else if (req.body && req.body.event && Array.isArray(req.body.event.activity)) {
            // Alchemy 格式翻譯
            const activities = req.body.event.activity;
            const fakeHeliusEvent = {
                type: 'ALCHEMY_TRANSFER',
                signature: activities[0]?.hash || 'alchemy_tx',
                nativeTransfers: activities.map(act => ({
                    fromUserAccount: act.fromAddress,
                    toUserAccount: act.toAddress,
                    amount: parseFloat(act.value || 0) * 1e9 // 翻譯為 lamports
                }))
            };
            events.push(fakeHeliusEvent);
        } else {
            return; // 格式不符，安靜拋棄
        }

        for (const event of events) {
            // 🔍 1. 逆向追蹤：判定來源與 Type
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

            // 📝 記錄接收數量
            const statKey = `[${sourceName}] ${eventType}`;
            initStatKey(statKey);
            detailedStats[statKey].received++;

            // ==========================================
            // 💰 分流 A：會計部邏輯
            // ==========================================
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

            // ==========================================
            // 🔫 分流 B：終極版交易雷達 (Meme 挖掘)
            // ==========================================
            let newMemeAddress = null;

            if (event.tokenTransfers && event.tokenTransfers.length > 0) {
                const transfer = event.tokenTransfers.find(t => 
                    t.mint !== SOL_MINT_ADDRESS && 
                    t.mint !== SYSTEM_PROGRAM_ID && 
                    t.mint.length > 32
                );
                if (transfer) newMemeAddress = transfer.mint;
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
                                newMemeAddress = potentialMint;
                                break;
                            }
                        }
                    }
                }
            }

            // ✅ 成功抽到，掟入魚池並記錄分類數據
            if (newMemeAddress) {
                detailedStats[statKey].filtered++;
            
                // 🚀 [核心修改] 斷路器邏輯：本地攔截
                if (isNurseryPoolFull) {
                    // 直接返回，不執行下方的 RPC，保護數據庫連線數
                    return; 
                }
                const { data: isInserted } = await supabase.rpc('insert_fish_with_limit', {
                    new_mint_address: newMemeAddress
                });
                if (isInserted) {
                    detailedStats[statKey].added++; 
                } else {
                    // 如果 RPC 返回 FALSE (代表剛好爆咗)，立刻更新本地狀態為 TRUE
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
// 🚀 秘密開關：手動強制觸發 Master AI 進化
// ==========================================
app.get('/force-evolution', async (req, res) => {
    console.log('\n========================================');
    console.log('👑 [Admin] 管理員已手動強制喚醒 Master AI！');
    console.log('========================================\n');

    res.status(200).send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #4CAF50;">🚀 Master AI 已被強制喚醒！</h1>
            <p style="font-size: 18px;">系統正準備進行自我進化分析...</p>
            <p style="color: #666;">請返回 Railway / Terminal 查看詳細的 Console Log 戰報。</p>
            <hr style="width: 200px; margin: 30px auto;">
            <p style="font-size: 14px; color: #999;">Status: Processing (Attempt 1)</p>
        </div>
    `);

    try {
        const { retrospectiveJob } = require('../jobs/retrospectiveJob');
        await retrospectiveJob.runEvolutionWithRetry(1);
    } catch (e) {
        console.error("❌ 手動觸發進化失敗:", e.message);
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
    console.log('🐟 [Nursery Radar] 雙層過濾系統已啟動 (DB -> RAM -> Out)');
    
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

            const now = Date.now();
            for (const [mint, data] of ramSecondaryPool.entries()) {
                if (now >= data.nextProcessTime) {
                    const { securityGuard } = require('./securityGuard');
                    const secResult = await securityGuard.checkAll(mint);

                    if (secResult.isSafe) {
                        console.log(`\n======================================================`);
                        console.log(`🎣 [RAM Nursery] 緩刑出獄: ${mint.substring(0,6)}`);
                        console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);
                        console.log(`======================================================\n`);
                        await triggerBuyPipeline(mint, secResult, config);
                        ramSecondaryPool.delete(mint);
                    } else {
                        const reason = secResult.reason || '';
                        if (!reason.includes('查無報價') && !reason.includes('死水') && !reason.includes('流動性太窮')) {
                            console.log(`🛡️ [Security] RAM二次攔截 ${mint.substring(0,6)}: ${reason}`);
                        }
                        data.failCount++;
                        if (data.failCount >= 3) {
                            ramSecondaryPool.delete(mint);
                        } else {
                            data.nextProcessTime = Date.now() + (15 * 60 * 1000);
                        }
                    }
                }
            }

            const { data: oldestToken } = await supabase
                .from('nursery_pool')
                .select('*')
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (oldestToken) {
                const mintAddress = oldestToken.mint_address;
                const ageMins = (Date.now() - new Date(oldestToken.created_at).getTime()) / 60000;

                if (ageMins > config.max_age_mins) {
                    await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);
                } else if (ageMins >= config.min_age_mins) {
                    
                    const { securityGuard } = require('./securityGuard');
                    const secResult = await securityGuard.checkAll(mintAddress);

                    await supabase.from('nursery_pool').delete().eq('mint_address', mintAddress);

                    if (secResult.isSafe) {
                        console.log(`\n======================================================`);
                        console.log(`🎣 [Nursery] 撈出熟魚: ${mintAddress.substring(0,6)} (已坐監 ${config.min_age_mins} 分鐘)`);
                        console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);
                        console.log(`======================================================\n`);
                        await triggerBuyPipeline(mintAddress, secResult, config);
                    } else {
                        const reason = secResult.reason || '';
                        if (!reason.includes('查無報價') && !reason.includes('死水') && !reason.includes('流動性太窮')) {
                            console.log(`🛡️ [Security] 攔截 ${mintAddress.substring(0,6)}: ${reason}`);
                        }

                        if (secResult.isPurgatory) {
                            ramSecondaryPool.set(mintAddress, {
                                failCount: 1, 
                                nextProcessTime: Date.now() + (10 * 60 * 1000)
                            });
                        }
                    }
                } else {
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
    }, 3000); 
}

function startWatchlistMonitor() {
    console.log('📋 [Watchlist Radar] 橫盤接回雷達啟動...');
    
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;

            const mints = watchlist.map(w => w.mint_address).join(',');
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 5000 });
            const dexPairs = dexRes.data?.pairs || [];

            for (const item of watchlist) {
                const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === item.mint_address);
                if (!pair) continue;

                const currentPrice = parseFloat(pair.priceUsd) || 0;
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
                        const buyResult = await executeBuy(item.mint_address, item.token_symbol, 'MEME_REENTRY', 95, decisionObj.reason, config.trade_amount_sol);
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
    console.log('👁️ [Radar] 智能雙引擎 (Jup V3/Dex) 批次持倉監控啟動 (15秒特種防禦)...');
    
    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const positions = portfolio.positions;
            
            // 🚀 Fix 3: 記憶體自動回收機制 (Memory Leak Protection)
            if (!positions || positions.length === 0) {
                if (aiReviewCooldowns.size > 0) {
                    console.log(`🧹 [Memory Clean] 檢測到全空倉，清空殘留的大腦冷卻記憶體 (${aiReviewCooldowns.size} 條)`);
                    aiReviewCooldowns.clear();
                }
                healthMonitor.setStatus('AI_Overseer', '🟢 巡邏完畢 (無持倉)');
                return;
            }

            // 找出已經不在 positions 裡面的孤兒 Keys 並刪除
            const currentMints = new Set(positions.map(p => p.mint_address));
            for (const mint of aiReviewCooldowns.keys()) {
                if (!currentMints.has(mint)) {
                    console.log(`🧹 [Memory Clean] 清除孤兒冷卻記憶體: ${mint.substring(0, 6)}`);
                    aiReviewCooldowns.delete(mint);
                }
            }

            const mints = positions.map(p => p.mint_address);
            let pricesMap = {};
            let missingMints = [...mints]; 

            try {
                const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`;
                const dexRes = await axios.get(dexUrl, { timeout: 4000 });
                const dexPairs = dexRes.data?.pairs || [];
                
                if (dexPairs.length > 0) {
                    const { getSolPriceInHKD } = require('./priceService');
                    const solPriceHKD = await getSolPriceInHKD();
                    const solPriceUSD = solPriceHKD / 7.8;

                    for (const mint of mints) {
                        const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === mint);
                        if (pair && pair.priceUsd) {
                            pricesMap[mint] = parseFloat(pair.priceUsd) / solPriceUSD; 
                            missingMints = missingMints.filter(m => m !== mint);
                        }
                    }
                }
            } catch (dexErr) {
                console.warn(`⚠️ [Radar] DexScreener 報價失敗，準備切換 Jupiter 備援...`);
            }

            if (missingMints.length > 0) {
                try {
                    const jupUrl = `https://api.jup.ag/price/v2?ids=${missingMints.join(',')}&vsToken=${SOL_MINT_ADDRESS}`;
                    const jupRes = await axios.get(jupUrl, { timeout: 3000 });
                    const jupData = jupRes.data?.data || {};
                    
                    for (const [mint, info] of Object.entries(jupData)) {
                        if (info && info.price) {
                            pricesMap[mint] = parseFloat(info.price);
                        }
                    }
                } catch (jupErr) {
                    console.warn(`⚠️ [Radar] Jupiter V3 報價亦失敗。`);
                }
            }

            const STOP_LOSS_PCT = parseFloat(config.stop_loss_pct || -10);

            for (const pos of positions) {
                const currentPrice = pricesMap[pos.mint_address];
                if (!currentPrice) continue; 

                const pnlSol = (currentPrice - pos.entry_price_sol) * pos.quantity;
                const pnlPct = (pnlSol / (pos.entry_price_sol * pos.quantity)) * 100;
                
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                if (currentPrice > pos.highest_price_sol) {
                    pos.highest_price_sol = currentPrice;
                    await supabase.from(`active_positions_${tableSuffix}`).update({ highest_price_sol: currentPrice }).eq('mint_address', pos.mint_address);
                }

                const drawdownFromHigh = ((currentPrice - pos.highest_price_sol) / pos.highest_price_sol) * 100;
                const highestPnlPct = ((pos.highest_price_sol - pos.entry_price_sol) / pos.entry_price_sol) * 100;

                const posDataForAI = { ...pos, currentPrice, pnlPct, mode: portfolio.mode };

                const isBluechip = pos.strategy_type && pos.strategy_type.includes('BLUECHIP');
                const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');

                let action = 'HOLD';
                let reason = '';
                let sellFraction = 1.0; 

                // 🚀 核心升級：老幣專屬保本防護線 (Meme 幣不受影響)
                if (isBluechip && highestPnlPct >= 5.0 && pnlPct <= 0.5) {
                    action = 'SELL';
                    reason = `🛡️ [老幣保本機制] 利潤曾達 +${highestPnlPct.toFixed(2)}% 現回落至成本線，強制結利`;
                }

                if (pnlPct <= STOP_LOSS_PCT) {
                    action = 'SELL';
                    reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${STOP_LOSS_PCT}%)`;
                } 
                else if (!isHalfSold && highestPnlPct >= 100) {
                    action = 'SELL';
                    sellFraction = 0.5;
                    reason = `🚀 翻倍回本機制 (歷史最高達 +${highestPnlPct.toFixed(2)}%，賣出 50% 鎖定成本)`;
                }
                else if (isHalfSold && drawdownFromHigh <= -30) {
                    action = 'SELL';
                    reason = `💰 登月尾倉止盈 (翻倍後高位回撤 ${drawdownFromHigh.toFixed(2)}%，全數獲利了結)`;
                }
                else if (!isHalfSold && highestPnlPct >= 50 && drawdownFromHigh <= -15) {
                    action = 'SELL';
                    reason = `💰 觸發無腦利潤保護 (歷史最高: +${highestPnlPct.toFixed(2)}%，高位回撤: ${drawdownFromHigh.toFixed(2)}%)`;
                } 
                else {
                    // ==========================================
                    // 🧠 AI 大腦冷卻機制 (RAM-based Cooldown)
                    // ==========================================
                    const nowMs = Date.now();
                    const lastReviewMs = aiReviewCooldowns.get(pos.mint_address) || 0;
                    const minsSinceLastReview = (nowMs - lastReviewMs) / 60000;

                    // 1. 如果距離上次審查不足 5 分鐘，安靜地跳過
                    if (minsSinceLastReview < 5) {
                        continue; 
                    }

                    // 2. 夠 5 分鐘！更新計時器，並叫醒 AI 審查
                    aiReviewCooldowns.set(pos.mint_address, nowMs);

                    console.log(`\n👁️ [AI Overseer] 正在審查 ${pos.token_symbol} (PNL: ${pnlPct.toFixed(2)}%)...`);
                    
                    try {
                        const reviewResult = await reviewActivePosition(pos.mint_address, posDataForAI);
                        
                        if (reviewResult.decision === 'RETRY_LATER') {
                            // 如果 AI 炒車，將冷卻時間回撥少少 (例如等 2 分鐘就再試，唔洗等足 5 分鐘)
                            aiReviewCooldowns.set(pos.mint_address, nowMs - (3 * 60 * 1000));
                            continue; 
                        }

                        action = reviewResult.decision;
                        reason = `AI 指示: ${reviewResult.reason}`;
                        
                        if (action === 'EXIT') action = 'SELL';
                        
                        if (action === 'HOLD') {
                            console.log(`🛡️ [AI 決策] ${pos.token_symbol} 繼續持有。理由: ${reviewResult.reason}\n`);
                        }
                    } catch (aiErr) {
                        console.error(`❌ [AI Reviewer] 發生錯誤:`, aiErr.message);
                        // 出錯時提早 1 分鐘重試
                        aiReviewCooldowns.set(pos.mint_address, nowMs - (4 * 60 * 1000));
                        continue;
                    }
                }

                if (action === 'SELL') {
                    const pnlIcon = pnlPct > 0 ? '🚀 止盈' : '🩸 止損';
                    
                    if (isBluechip && !isHalfSold && pnlPct > 0 && sellFraction === 1.0) {
                        sellFraction = 0.5;
                        reason = `[老幣分批止盈] ${reason}`;
                    }

                    const sellResult = await runSellPipeline(pos, currentPrice, reason, sellFraction);
                    
                    if (sellResult) {
                        if (sellFraction === 0.5) {
                            console.log(`\n======================================================`);
                            console.log(`💳 🔴 【分批賣出成功 - ${pos.token_symbol}】 🔴 💳`);
                            console.log(`📊 動作: 🚀 止盈 (+${pnlPct.toFixed(2)}%)`);
                            console.log(`🤖 理由: ${reason}`);
                            console.log(`======================================================\n`);
                            sendTelegramAlert(`🌟 <b>翻倍鎖定利潤</b>\n🪙 代幣: $${pos.token_symbol}\n賣出 50% 鎖定成本，剩餘尾倉讓利潤奔跑！`);
                        } else {
                            console.log(`\n======================================================`);
                            console.log(`💳 🔴 【全倉賣出成功 - ${pos.token_symbol}】 🔴 💳`);
                            console.log(`📊 動作: ${pnlIcon} (${pnlPct.toFixed(2)}%)`);
                            console.log(`🤖 理由: ${reason}`);
                            console.log(`======================================================\n`);

                            // 🚀 修復 Memory Leak：全倉賣出後，清除大腦冷卻計時器
                            aiReviewCooldowns.delete(pos.mint_address);

                            // 🚀 嚴格限制：只有 MEME_SNIPE 或 MEME_BLIND 先可以跌入橫盤接回名單
                            const isFirstTimeMeme = !isBluechip && 
                                                    (pos.strategy_type && (pos.strategy_type.includes('MEME_SNIPE') || pos.strategy_type.includes('MEME_BLIND')));
                            
                            // 防止 TRENDING 被誤判
                            const isTrending = pos.strategy_type && pos.strategy_type.includes('TRENDING');

                            if (isFirstTimeMeme) {
                                if (pnlPct >= -20) {
                                    // 🚀 Phase 3 核心修復：使用 upsert 防止 UNIQUE Constraint 爆錯卡死迴圈
                                    await supabase.from('reentry_watchlist').upsert([{
                                        mint_address: pos.mint_address, token_symbol: pos.token_symbol,
                                        sold_price_sol: currentPrice, baseline_price_sol: currentPrice,
                                        consolidation_start_time: new Date().toISOString()
                                    }], { onConflict: 'mint_address' });
                                    console.log(`📋 已將 ${pos.token_symbol} 加入橫盤觀察名單 (30分鐘後評估接回)`);
                                } else {
                                    console.log(`💀 [Blacklist] ${pos.token_symbol} 虧損過大 (${pnlPct.toFixed(2)}%)，判處死刑，拒絕加入接回名單！`);
                                }
                            } else if (isTrending) {
                                // 🚀 新增：Trending 幣專屬賣出 Log
                                console.log(`🔥 [Trending] ${pos.token_symbol} (Top 50) 已完成歷史任務，功成身退，不作接回。`);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`❌ [Position Monitor] 監控迴圈異常:`, err.message);
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

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        console.log('🔄 [System] 系統啟動，準備載入雙 Webhook 模組...');
        await toggleHeliusWebhook(true);
        healthMonitor.setStatus('Trade_Engine', '🟢 正常待命');

        startDatabaseNurseryMonitor(); 
        startWatchlistMonitor(); 
        startPositionMonitor();
        startCommandListener();
        startWebhookStatsMonitor(); 
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