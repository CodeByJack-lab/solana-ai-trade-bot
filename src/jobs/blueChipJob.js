// backend/jobs/blueChipJob.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { getBlueChipCount, getPositionLimits } = require('../services/portfolioService');
const { consensusService } = require('../services/consensusService');
const { executeBuy } = require('../services/tradeService');
const { healthMonitor } = require('../services/healthMonitor');

// ==========================================
// 🧮 數學輔助工具區 (純 CPU 運算，0 網絡負擔)
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
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// 2. Bollinger Bands (布林帶)
function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return {
        upper: sma + (stdDev * sd),
        middle: sma,
        lower: sma - (stdDev * sd)
    };
}

// 3. EMA (指數移動平均線) - 計算 MACD 的基礎
function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
        emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

// 4. MACD (平滑異同移動平均線)
function calculateMACD(closes) {
    if (closes.length < 26) return null;
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push(ema12[i] - ema26[i]);
    }
    
    const signalLine = calculateEMA(macdLine, 9);
    const hist = macdLine.map((m, i) => m - signalLine[i]);

    return {
        macd: macdLine[macdLine.length - 1],
        signal: signalLine[signalLine.length - 1],
        hist: hist[hist.length - 1],       // 當前柱子
        prevHist: hist[hist.length - 2]    // 上一根柱子
    };
}

// 5. Volume Shrinkage (成交量萎縮/沽壓枯竭)
function checkVolumeShrinkage(volumes) {
    if (volumes.length < 7) return false;
    // 💡 避開當前未行完嘅 K 線 (length - 1)，選取「最後一根已完整收盤的 K 線」 (length - 2)
    const lastClosedVol = volumes[volumes.length - 2];
    
    // 計算再之前 5 根 K 線的平均成交量
    const pastVols = volumes.slice(volumes.length - 7, volumes.length - 2);
    const avgVol = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;

    // 判斷：最後一根完整 K 線的成交量，是否小於近期平均的 75% (即縮量 25% 以上)
    return lastClosedVol < (avgVol * 0.75);
}

// ==========================================
// 🚀 核心排程
// ==========================================
const blueChipJob = {
    start() {
        console.log(`📈 [BlueChip Radar] 終極四維抄底雷達已啟動 (每分鐘掃描 Binance)...`);
        healthMonitor.setStatus('Bluechip_Radar', '🟢 監聽中');

        setInterval(async () => {
            try {
                const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!config || !config.is_running) return;

                // 🛑 第零道防線：資金與倉位絕對鎖
                const { maxBluechip } = getPositionLimits();
                if (getBlueChipCount() >= maxBluechip) {
                    healthMonitor.setStatus('Bluechip_Radar', '🟡 老幣倉位已滿，暫停掃描');
                    return;
                }

                healthMonitor.setStatus('Bluechip_Radar', '🟢 掃描指標中...');
                
                const { data: pool } = await supabase.from('bluechip_pool').select('*').eq('is_active', true);
                const { data: aiParams } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
                const rsiThreshold = aiParams?.rsi_oversold || 30;

                if (!pool) return;

                // 逐隻掃描 Binance K線
                for (const token of pool) {
                    const symbol = `${token.token_symbol}USDT`;
                    try {
                        // 💡 提升 Limit 到 100 支 K 線，確保 EMA 同 MACD 計算極度精準
                        const res = await axios.get(`https://api-g.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`);
                        
                        const closes = res.data.map(k => parseFloat(k[4]));  // 收盤價
                        const volumes = res.data.map(k => parseFloat(k[5])); // 成交量
                        const currentPrice = closes[closes.length - 1];

                        // 🧮 運算四大指標
                        const rsi = calculateRSI(closes);
                        const bb = calculateBollingerBands(closes);
                        const macdData = calculateMACD(closes);
                        const isVolumeShrinking = checkVolumeShrinkage(volumes);

                        // 🎯 判斷條件
                        const isRsiOversold = rsi <= rsiThreshold;
                        const isBbTouched = bb && currentPrice <= bb.lower;
                        // MACD 轉向：雖然仲處於跌勢 (hist < 0)，但下跌動能已經開始縮減 (hist > prevHist)
                        const isMacdReversing = macdData && macdData.hist < 0 && macdData.hist > macdData.prevHist;

                        // 打印雷達狀態 (只打印重點，費事洗版)
                        if (isRsiOversold || isBbTouched) {
                            console.log(`📊 [${token.token_symbol}] 價: $${currentPrice.toFixed(3)} | RSI: ${rsi.toFixed(1)} | 縮量: ${isVolumeShrinking?'✅':'❌'} | MACD轉向: ${isMacdReversing?'✅':'❌'}`);
                        }

                        // 🚨 終極四維觸發條件 (四星連珠)
                        if (isRsiOversold && isBbTouched && isVolumeShrinking && isMacdReversing) {
                            console.log(`🚨 [Bluechip] ${token.token_symbol} 觸發四維抄底指標，移交軍師防雷審核...`);
                            
                            const marketData = { 
                                symbol: token.token_symbol, 
                                rsi, 
                                price: currentPrice,
                                indicators: 'RSI 超賣 + BB 觸底 + 沽壓枯竭 + MACD 動能反轉',
                                ohlcv: res.data.slice(-10) 
                            };
                            
                            const aiDecision = await consensusService.runBluechipConsensus(token.mint_address, marketData);
                            
                            if (aiDecision?.buy) {
                                await executeBuy(
                                    token.mint_address, 
                                    token.token_symbol, 
                                    'BLUECHIP_SWING', 
                                    100, 
                                    `${aiDecision.reason} (TA: 四維指標共振抄底)`, 
                                    config.trade_amount_sol
                                );
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠️ [Bluechip] 獲取 ${symbol} 數據失敗`);
                    }
                }
            } catch (err) {
                healthMonitor.setStatus('Bluechip_Radar', `🔴 掃描出錯: ${err.message}`);
            }
        }, 60 * 1000); 
    }
};

module.exports = { blueChipJob };