// backend/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase'); 
const axios = require('axios'); 
const { getPortfolio, getMemeCount, getPositionLimits } = require('./portfolioService'); 
const { healthMonitor } = require('./healthMonitor');
const { securityGuard } = require('./securityGuard');
const { consensusService, getPendingMemeCount } = require('./consensusService'); 
const { reviewActivePosition, analyzeReentry } = require('./aiService');
const { executeBuy, executeSell, executeSellRaydium, forceWriteOff, runSellPipeline } = require('./tradeService'); // 確保引入 runSellPipeline
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const app = express();
app.use(express.json({ limit: '50mb' }));

const TARGET_PROGRAMS = ['6EF8rrecthR5Dkzon8Nwu78hrvfCKubJ14M5uBEwF6P', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8']; 
let isProcessingBatch = false; 

// ==========================================
// 🧮 離場專用技術指標計算工具
// ==========================================
function calculateRSI(closes, periods = 14) {
    if (closes.length <= periods) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= periods; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / periods; let avgLoss = losses / periods;
    for (let i = periods + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff >= 0 ? diff : 0; const loss = diff < 0 ? -diff : 0;
        avgGain = ((avgGain * (periods - 1)) + gain) / periods;
        avgLoss = ((avgLoss * (periods - 1)) + loss) / periods;
    }
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return { upper: sma + (stdDev * sd), middle: sma, lower: sma - (stdDev * sd) };
}

function calculateMACD(closes) {
    if (closes.length < 26) return null;
    const ema = (data, p) => {
        const k = 2 / (p + 1); let res = [data[0]];
        for (let i = 1; i < data.length; i++) res.push(data[i] * k + res[i - 1] * (1 - k));
        return res;
    };
    const ema12 = ema(closes, 12); const ema26 = ema(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = ema(macdLine, 9);
    return { hist: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1], prevHist: macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2] };
}

// ==========================================
// 🌊 核心雷達監控區
// ==========================================

function startDatabaseNurseryMonitor() {
    console.log(`🐟 [Nursery Radar] 滴水式雷達已啟動 (每 10 秒撈 1 魚)...`);
    healthMonitor.setStatus('Meme_Radar', '🟢 監聽與撈魚中');
    
    setInterval(async () => {
        if (isProcessingBatch) return; 
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) return;

        const { maxMeme } = getPositionLimits();
        if ((getMemeCount() + getPendingMemeCount()) >= maxMeme) {
            healthMonitor.setStatus('Meme_Radar', '🟡 倉位或隊列已滿，暫停撈魚');
            return; 
        }

        healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
        isProcessingBatch = true;
        try {
            const thresholdTime = new Date(Date.now() - (config.min_age_mins || 5) * 60 * 1000).toISOString();
            const deadTime = new Date(Date.now() - (config.max_age_mins || 60) * 60 * 1000).toISOString();
            await supabase.from('nursery_pool').delete().lte('created_at', deadTime);

            const { data: matureTokens } = await supabase.from('nursery_pool').select('mint_address').lte('created_at', thresholdTime).order('created_at', { ascending: true }).limit(1);
            if (!matureTokens || matureTokens.length === 0) { isProcessingBatch = false; return; }

            const mint = matureTokens[0].mint_address;
            await supabase.from('nursery_pool').delete().eq('mint_address', mint); 
            console.log(`🎣 [Nursery] 撈出成熟代幣 ${mint.substring(0,6)}... 交由保安亭處理`);

            const safety = await securityGuard.checkAll(mint);
            if (!safety.isSafe) { console.log(`🛡️ [Security] 攔截: ${safety.reason}`); isProcessingBatch = false; return; }

            const aiDecision = await consensusService.runMemeConsensus(mint, safety.marketData, { isReentry: false });
            if (aiDecision?.buy) { await executeBuy(mint, safety.marketData.symbol, 'MEME_HUNTER', aiDecision.score, aiDecision.reason, config.trade_amount_sol); }
        } catch (err) { console.error(`❌ [Nursery Error] 撈魚出錯:`, err.message); } finally { isProcessingBatch = false; }
    }, 10000); 
}

app.post('/webhook/helius', async (req, res) => {
    res.sendStatus(200); 
    try {
        const { count } = await supabase.from('nursery_pool').select('*', { count: 'exact', head: true });
        if (count >= 50) return; 
        let incomingMints = new Set();
        if (Array.isArray(req.body)) {
            req.body.forEach(ev => {
                if (ev.instructions?.some(ix => TARGET_PROGRAMS.includes(ix.programId)) && ev.tokenTransfers) {
                    ev.tokenTransfers.forEach(tf => { if (tf.mint) incomingMints.add(tf.mint); });
                }
            });
        }
        if (incomingMints.size > 0) {
            const inserts = Array.from(incomingMints).map(mint => ({ mint_address: mint }));
            await supabase.from('nursery_pool').upsert(inserts, { onConflict: 'mint_address' });
        }
    } catch (err) {}
});

function startWatchlistMonitor() {
    console.log(`📋 [Watchlist Radar] 橫盤接回雷達啟動...`);
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;
            const { maxMeme } = getPositionLimits();
            if ((getMemeCount() + getPendingMemeCount()) >= maxMeme) return; 

            for (const token of watchlist) {
                const startTime = new Date(token.consolidation_start_time).getTime();
                if ((Date.now() - startTime) / 60000 >= 30) {
                    const aiReview = await analyzeReentry(token.mint_address, token.token_symbol, token.baseline_price_sol);
                    if (aiReview?.decision === 'BUY') {
                        const marketData = await securityGuard.fetchDexData(token.mint_address); 
                        if (marketData) {
                            const finalDecision = await consensusService.runMemeConsensus(token.mint_address, marketData, { isReentry: true });
                            if (finalDecision?.buy) {
                                const { data: config } = await supabase.from('system_config').select('trade_amount_sol').eq('id', 1).single();
                                await executeBuy(token.mint_address, token.token_symbol, 'MEME_REENTRY', finalDecision.score, finalDecision.reason, config.trade_amount_sol);
                            }
                        }
                    }
                    await supabase.from('reentry_watchlist').delete().eq('mint_address', token.mint_address);
                }
            }
        } catch (err) {}
    }, 10 * 60 * 1000); 
}

const reviewTracking = new Map(); 

async function getDexScreenerInfo(mint, retry) {
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3000 });
        return res.data.pairs?.find(p => p.chainId === 'solana');
    } catch (e) { return null; }
}

async function getDynamicConfig() {
    const { data } = await supabase.from('system_config').select('*').eq('id', 1).single();
    return data;
}

function startPositionMonitor() {
    console.log(`👁️ [Radar] 智能 AI Review + 技術平倉 + 基本風控啟動...`);
    setInterval(async () => {
        try {
            const portfolio = getPortfolio();
            const config = await getDynamicConfig();
            if (portfolio.positions.length === 0) return;
            const positionsSnapshot = [...portfolio.positions];

            for (const pos of positionsSnapshot) {
                const dsInfo = await getDexScreenerInfo(pos.mint_address, 0); 
                const currentPrice = dsInfo?.priceNative ? parseFloat(dsInfo.priceNative) : null;
                if (!currentPrice) continue;
                
                // 更新歷史最高價
                if (currentPrice > pos.highest_price_sol) {
                    pos.highest_price_sol = currentPrice;
                    const table = portfolio.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
                    supabase.from(table).update({ highest_price_sol: currentPrice }).eq('mint_address', pos.mint_address).then(()=>{});
                }
                
                const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
                const drawdownPct = ((pos.highest_price_sol - currentPrice) / pos.highest_price_sol) * 100;
                const isHalfSold = (pos.strategy_type || '').includes('HALF_SOLD');

                // ==========================================
                // 🚀 【新增】老幣技術離場邏輯 (PNL > 5% 才觸發)
                // ==========================================
                if (pos.strategy_type === 'BLUECHIP_SWING' && pnlPct > 5) {
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${pos.mint_address}&type=15m&limit=30`, {
                            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
                            timeout: 5000
                        });
                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 26) {
                            const closes = items.map(k => parseFloat(k.o));
                            const rsi = calculateRSI(closes);
                            const bb = calculateBollingerBands(closes);
                            const macd = calculateMACD(closes);

                            const isRsiHot = rsi >= 70;
                            const isUpperBB = currentPrice >= bb?.upper;
                            const isMacdWeak = macd?.hist < macd?.prevHist && macd?.hist > 0;

                            if (isRsiHot || isUpperBB || isMacdWeak) {
                                const techReason = isRsiHot ? "RSI超買" : (isUpperBB ? "觸碰BB上軌" : "MACD動能見頂");
                                console.log(`🎯 [Technical Exit] ${pos.token_symbol} 滿足技術指標: ${techReason}`);
                                await runSellPipeline(pos, currentPrice, `技術平倉: ${techReason}`, 1.0);
                                continue; 
                            }
                        }
                    } catch (e) { console.warn(`⚠️ [Exit Radar] Birdeye 數據獲取失敗: ${e.message}`); }
                }

                // ==========================================
                // 👁️ AI Review 邏輯 (保留原功能)
                // ==========================================
                const now = Date.now();
                const track = reviewTracking.get(pos.mint_address) || { lastPrice: pos.entry_price_sol, lastTime: 0 };
                const changeSinceLastReview = ((currentPrice - track.lastPrice) / track.lastPrice) * 100;
                if ((now - track.lastTime > 30 * 60 * 1000) || (changeSinceLastReview >= 25) || (changeSinceLastReview <= -10)) {
                    reviewTracking.set(pos.mint_address, { lastPrice: currentPrice, lastTime: now });
                    const aiReview = await reviewActivePosition(pos.mint_address, { ...pos, pnlPct });
                    if (aiReview && aiReview.decision === 'EXIT') {
                        await runSellPipeline(pos, currentPrice, `AI 監軍撤退: ${aiReview.reason}`, 1.0);
                        continue; 
                    }
                }

                // ==========================================
                // 🛡️ 基本風控邏輯 (翻倍/止損/移動止盈)
                // ==========================================
                let triggerSell = false; let sellReason = ""; let sellFraction = 1.0; 

                if (pnlPct >= 100 && !isHalfSold) {
                    triggerSell = true; sellReason = `翻倍保本出局 (+${pnlPct.toFixed(1)}%)`; sellFraction = 0.5;
                }
                else if (pnlPct <= config.stop_loss_pct) {
                    triggerSell = true; sellReason = `死線硬止損 (${pnlPct.toFixed(1)}%)`; sellFraction = 1.0;
                }
                else if (drawdownPct >= 30 && pnlPct > 20) { 
                    triggerSell = true; sellReason = `高位回撤鎖盈 (-${drawdownPct.toFixed(1)}%)`; sellFraction = 1.0;
                }

                if (triggerSell) {
                    const isSold = await runSellPipeline(pos, currentPrice, sellReason, sellFraction);
                    if (isSold && sellFraction === 1.0) {
                        await supabase.from('reentry_watchlist').upsert({
                            mint_address: pos.mint_address, token_symbol: pos.token_symbol || 'UNKNOWN',
                            sold_price_sol: currentPrice, baseline_price_sol: currentPrice,
                            consolidation_start_time: new Date().toISOString()
                        }, { onConflict: 'mint_address' });
                    }
                }
            }
        } catch (err) { console.error(`❌ [Position Monitor] 出錯:`, err.message); }
    }, 5000); 
}

function startCommandListener() {
    supabase.channel('command_listener').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'command_queue' }, async (payload) => {
        const cmd = payload.new;
        try {
            const portfolio = getPortfolio();
            if (cmd.command_type === 'SELL_SINGLE' && cmd.mint_address) {
                const pos = portfolio.positions.find(p => p.mint_address === cmd.mint_address);
                if (pos) {
                    const dsInfo = await getDexScreenerInfo(cmd.mint_address, 0);
                    await runSellPipeline(pos, dsInfo?.priceNative || 0, "手動斬倉", 1.0);
                }
            } else if (cmd.command_type === 'SELL_ALL') {
                for (const pos of [...portfolio.positions]) {
                    const dsInfo = await getDexScreenerInfo(pos.mint_address, 0);
                    await runSellPipeline(pos, dsInfo?.priceNative || 0, "核彈平倉", 1.0);
                }
            }
            await supabase.from('command_queue').delete().eq('id', cmd.id);
        } catch (err) {}
    }).subscribe();
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        startDatabaseNurseryMonitor(); 
        startWatchlistMonitor(); 
        startPositionMonitor();
        startCommandListener();
    });
}

module.exports = { startMarketMonitor };