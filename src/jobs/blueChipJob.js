// backend/jobs/blueChipJob.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { getBlueChipCount, getPositionLimits } = require('../services/portfolioService');
const { consensusService } = require('../services/consensusService');
const { executeBuy } = require('../services/tradeService');
const { healthMonitor } = require('../services/healthMonitor');
const path = require('path');

// 🛡️ 確保讀取 Birdeye API Key
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// ==========================================
// 🧮 數學輔助工具區 (完整保留你的四維指標邏輯)
// ==========================================

// 1. RSI (相對強弱指數)
function calculateRSI(closes, periods = 14) {
    if (closes.length <= periods) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= periods; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / periods;
    let avgLoss = losses / periods;
    for (let i = periods + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = ((avgGain * (periods - 1)) + gain) / periods;
        avgLoss = ((avgLoss * (periods - 1)) + loss) / periods;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
}

// 2. Bollinger Bands (布林帶)
function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return { upper: sma + (stdDev * sd), middle: sma, lower: sma - (stdDev * sd) };
}

// 3. EMA (MACD 基礎)
function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
        emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

// 4. MACD (動能反轉)
function calculateMACD(closes) {
    if (closes.length < 26) return null;
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = calculateEMA(macdLine, 9);
    const hist = macdLine.map((m, i) => m - signalLine[i]);
    return {
        hist: hist[hist.length - 1],
        prevHist: hist[hist.length - 2]
    };
}

// 5. Volume Shrinkage (沽壓枯竭)
function checkVolumeShrinkage(volumes) {
    if (volumes.length < 7) return false;
    const lastClosedVol = volumes[volumes.length - 2];
    const pastVols = volumes.slice(volumes.length - 7, volumes.length - 2);
    const avgVol = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;
    return lastClosedVol < (avgVol * 0.75);
}

// ==========================================
// 🚀 核心排程 (哨兵觸發制)
// ==========================================
const blueChipJob = {
    start() {
        console.log(`📈 [BlueChip Radar] 終極四維雷達啟動 (DexScreener 哨兵 + Birdeye 精算模式)...`);
        healthMonitor.setStatus('Bluechip_Radar', '🟢 監聽中');

        setInterval(async () => {
            try {
                const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!config || !config.is_running) return;

                const { maxBluechip } = getPositionLimits();
                if (getBlueChipCount() >= maxBluechip) {
                    healthMonitor.setStatus('Bluechip_Radar', '🟡 老幣倉位已滿');
                    return;
                }

                healthMonitor.setStatus('Bluechip_Radar', '🟢 掃苗中...');
                
                const { data: pool } = await supabase.from('bluechip_pool').select('*').eq('is_active', true);
                if (!pool || !BIRDEYE_API_KEY) return;

                for (const token of pool) {
                    try {
                        // 🕵️ 第一層：DexScreener 免費哨兵 (判斷超跌)
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token.mint_address}`, { timeout: 4000 });
                        const pair = dexRes.data.pairs?.find(p => p.chainId === 'solana');
                        if (!pair) continue;

                        const h1Change = parseFloat(pair.priceChange?.h1 || 0);

                        // 💡 只有當 1 小時跌幅超過 8%，先至啟動 Birdeye 精算 (節省 CUs)
                        if (h1Change > -8) continue; 

                        console.log(`🎯 [哨兵訊號] ${token.token_symbol} 1h 跌幅 ${h1Change}%, 啟動 Birdeye 四維精算...`);

                        // 🕵️ 第二層：Birdeye OHLCV 精算 (耗費 CUs)
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&limit=100`, {
                            headers: { 
                                'X-API-KEY': BIRDEYE_API_KEY.replace(/['"]/g, '').trim(), 
                                'x-chain': 'solana' 
                            },
                            timeout: 8000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length < 30) continue;

                        const closes = items.map(k => parseFloat(k.o));
                        const volumes = items.map(k => parseFloat(k.v));
                        const currentPrice = closes[closes.length - 1];

                        // 🧮 執行四維運算
                        const rsi = calculateRSI(closes);
                        const bb = calculateBollingerBands(closes);
                        const macdData = calculateMACD(closes);
                        const isVolumeShrinking = checkVolumeShrinkage(volumes);

                        // 🚨 最終四維觸發條件 (RSI <= 30 + BB 觸底 + 縮量 + MACD 轉向)
                        const isRsiOversold = rsi <= 30;
                        const isBbTouched = bb && currentPrice <= bb.lower;
                        const isMacdReversing = macdData && macdData.hist > macdData.prevHist;

                        if (isRsiOversold && isBbTouched && isVolumeShrinking && isMacdReversing) {
                            console.log(`🚨 [Bluechip] ${token.token_symbol} 指標共振，移交 AI 軍師防雷...`);
                            
                            const aiDecision = await consensusService.runBluechipConsensus(token.mint_address, {
                                symbol: token.token_symbol,
                                rsi,
                                price: currentPrice,
                                indicators: 'RSI+BB+Volume+MACD (Birdeye Source)'
                            });
                            
                            if (aiDecision?.buy) {
                                await executeBuy(token.mint_address, token.token_symbol, 'BLUECHIP_SWING', 100, aiDecision.reason, config.trade_amount_sol);
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠️ [Bluechip] ${token.token_symbol} 檢查失敗: ${e.message}`);
                    }
                }
            } catch (err) {
                healthMonitor.setStatus('Bluechip_Radar', `🔴 異常: ${err.message}`);
            }
        }, 60 * 1000); 
    }
};

module.exports = { blueChipJob };