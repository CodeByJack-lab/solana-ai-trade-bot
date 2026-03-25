// src/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase');
const axios = require('axios');
const crypto = require('crypto');
let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;
const { PublicKey } = require('@solana/web3.js');

const { runSellPipeline, executeBuy } = require('./tradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { consensusService, getPendingMemeCount } = require('./consensusService');
const { analyzeReentry, reviewActivePosition } = require('./aiService');

const app = express();
app.use(express.json());

// 🚀 雙 Webhook 環境變數 (已對位)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;           
const WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID;
const HELIUS_API_KEY_2 = process.env.HELIUS_API_KEY_2;       
const WEBHOOK_ID_2 = process.env.HELIUS_WEBHOOK_ID_2;

const NGROK_URL = process.env.NGROK_URL || "https://solana-ai-trade-bot-production.up.railway.app";

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

let stats_totalWebhookSignals = 0;
let stats_pumpFunCreates = 0;
let stats_addedToNursery = 0;

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
                transactionTypes: ["CREATE_POOL", "INITIALIZE_ACCOUNT", "TOKEN_MINT"], 
                accountAddresses: [RAYDIUM_V4_PROGRAM_ID],
                webhookType: "enhanced",
                txnStatus: "success" 
            };
            await axios.put(url1, payload1);
            console.log('✅ [Webhook 1] Raydium 專線設定同步成功！');
        } catch (err) {
            console.error('❌ [Webhook 1 Error] Raydium 更新失敗:', err.response?.data || err.message);
        }
    } else {
        console.warn('⚠️ [Webhook 1] 缺少 HELIUS_API_KEY 或 HELIUS_WEBHOOK_ID，跳過設定。');
    }

    if (HELIUS_API_KEY_2 && WEBHOOK_ID_2) {
        try {
            const url2 = `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID_2}?api-key=${HELIUS_API_KEY_2}`;
            const payload2 = {
                webhookURL: targetUrl,
                transactionTypes: ["CREATE_POOL", "UNKNOWN", "INITIALIZE_ACCOUNT", "TOKEN_MINT"], 
                accountAddresses: [PUMP_FUN_PROGRAM_ID],
                webhookType: "enhanced",
                txnStatus: "success" 
            };
            await axios.put(url2, payload2);
            console.log('✅ [Webhook 2] Pump.fun 專線設定同步成功！');
        } catch (err) {
            console.error('❌ [Webhook 2 Error] Pump.fun 更新失敗:', err.response?.data || err.message);
        }
    } else {
        console.warn('⚠️ [Webhook 2] 缺少 HELIUS_API_KEY_2 或 HELIUS_WEBHOOK_ID_2，跳過設定。');
    }

    healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
}

app.post('/webhook/helius', async (req, res) => {
    res.status(200).send('OK');

    try {
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) return;

        const events = req.body;
        if (!Array.isArray(events)) return;

        stats_totalWebhookSignals += events.length; 

        for (const event of events) {
            const instructions = event.instructions || [];
            for (const ix of instructions) {
                if (ix.programId === PUMP_FUN_PROGRAM_ID) {
                    const dataObj = ix.data || "";
                    if (dataObj.length > 0) {
                        try {
                            const decodedBytes = bs58.decode(dataObj);
                            const hexString = Buffer.from(decodedBytes).toString('hex');
                            
                            const isNewMeme = 
                                hexString.startsWith('181ec828051c0777') || 
                                hexString.startsWith('d6904cec5f8b31b4') || 
                                hexString.startsWith('253a237ebe35e4c5') || 
                                hexString.startsWith('a572670079cef751') ||
                                hexString.startsWith('66063d1201daebea');

                            if (isNewMeme) {
                                const mintAddress = ix.accounts[0];
                                if (mintAddress) {
                                    stats_pumpFunCreates++; 
                                    const { data: isInserted, error } = await supabase.rpc('insert_fish_with_limit', {
                                        new_mint_address: mintAddress
                                    });
                                    if (isInserted) stats_addedToNursery++; 
                                }
                            }
                        } catch (e) { }
                    }
                }
            }
        }
    } catch (err) {
        console.error('❌ [Webhook Error]', err.message);
    }
});

function startWebhookStatsMonitor() {
    setInterval(() => {
        const discarded = stats_totalWebhookSignals - stats_addedToNursery;
        console.log(`\n========================================`);
        console.log(`📡 [Webhook 戰況] 過去 5 分鐘雷達報告:`);
        console.log(`   📥 總接收雜訊 : ${stats_totalWebhookSignals} 條`);
        console.log(`   💊 包含發射幣 : ${stats_pumpFunCreates} 隻`);
        console.log(`   🐟 成功入魚池 : ${stats_addedToNursery} 隻`);
        console.log(`   🗑️ 已拋棄雜訊 : ${discarded} 條`);
        console.log(`========================================\n`);
        
        stats_totalWebhookSignals = 0;
        stats_pumpFunCreates = 0;
        stats_addedToNursery = 0;
    }, 5 * 60 * 1000); 
}

const ramSecondaryPool = new Map(); 
let isAiReviewing = false;          

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
            
            // 🚀 耀眼的買入 Log
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
    
    // 🚀 改為 3 秒一審，加快消化速度
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
                        // 🚀 耀眼的接回 Log
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
    console.log('👁️ [Radar] 智能雙引擎 (Jup V3/Dex) 批次持倉監控啟動 (2分鐘循環防限流)...');
    
    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const positions = portfolio.positions;
            
            if (!positions || positions.length === 0) {
                healthMonitor.setStatus('AI_Overseer', '🟢 巡邏完畢 (無持倉)');
                return;
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

                const posDataForAI = { ...pos, currentPrice, pnlPct, mode: portfolio.mode };

                const isBluechip = pos.strategy_type && pos.strategy_type.includes('BLUECHIP');
                const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');

                let action = 'HOLD';
                let reason = '';

                if (pnlPct <= STOP_LOSS_PCT) {
                    action = 'SELL';
                    reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${STOP_LOSS_PCT}%)`;
                } else if (pnlPct >= 50 && drawdownFromHigh <= -10) {
                    action = 'SELL';
                    reason = `💰 利潤保護機制 (曾達+50%，回撤>10%)`;
                } else if (pnlPct >= 300) {
                    action = 'SELL';
                    reason = `🚀 觸發無腦暴利平倉 (+300%)`;
                } else {
                    console.log(`\n👁️ [AI Overseer] 正在審查 ${pos.token_symbol} (PNL: ${pnlPct.toFixed(2)}%)...`);
                    const reviewResult = await reviewActivePosition(pos.mint_address, posDataForAI);
                    action = reviewResult.decision;
                    reason = `AI 指示: ${reviewResult.reason}`;
                    
                    if (action === 'EXIT') action = 'SELL';
                }

                if (action === 'SELL') {
                    const pnlIcon = pnlPct > 0 ? '🚀 止盈' : '🩸 止損';
                    if (isBluechip && !isHalfSold && pnlPct > 0) {
                        const sellResult = await runSellPipeline(pos, currentPrice, `[老幣分批止盈] ${reason}`, 0.5);
                        if (sellResult) {
                            console.log(`\n======================================================`);
                            console.log(`💳 🔴 【分批賣出成功 - ${pos.token_symbol}】 🔴 💳`);
                            console.log(`📊 動作: 🚀 止盈 (+${pnlPct.toFixed(2)}%)`);
                            console.log(`🤖 理由: [老幣分批止盈] ${reason}`);
                            console.log(`======================================================\n`);
                            sendTelegramAlert(`🔵 <b>老幣波段止盈</b>\n🪙 代幣: $${pos.token_symbol}\n賣出 50% 鎖定利潤，剩餘倉位轉為零成本持有。`);
                        }
                    } else {
                        const sellResult = await runSellPipeline(pos, currentPrice, reason, 1.0);
                        if (sellResult) {
                            console.log(`\n======================================================`);
                            console.log(`💳 🔴 【全倉賣出成功 - ${pos.token_symbol}】 🔴 💳`);
                            console.log(`📊 動作: ${pnlIcon} (${pnlPct.toFixed(2)}%)`);
                            console.log(`🤖 理由: ${reason}`);
                            console.log(`======================================================\n`);

                            // 🚀 【防接飛刀機制】: Meme 幣第一次賣出，但如果虧損 >= -20%，直接判死刑！
                            const isFirstTimeMeme = !isBluechip && (!pos.strategy_type || !pos.strategy_type.includes('REENTRY'));
                            if (isFirstTimeMeme) {
                                if (pnlPct >= -20) {
                                    await supabase.from('reentry_watchlist').insert([{
                                        mint_address: pos.mint_address, token_symbol: pos.token_symbol,
                                        sold_price_sol: currentPrice, baseline_price_sol: currentPrice,
                                        consolidation_start_time: new Date().toISOString()
                                    }]);
                                    console.log(`📋 已將 ${pos.token_symbol} 加入橫盤觀察名單 (30分鐘後評估接回)`);
                                } else {
                                    console.log(`💀 [Blacklist] ${pos.token_symbol} 虧損過大 (${pnlPct.toFixed(2)}%)，判處死刑，拒絕加入接回名單！`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`❌ [Position Monitor] 監控迴圈異常:`, err.message);
            healthMonitor.setStatus('AI_Overseer', `🔴 監控異常: ${err.message}`);
        }
    }, 120000); 
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