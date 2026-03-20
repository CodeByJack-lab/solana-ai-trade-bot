// src/jobs/blueChipJob.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { getBlueChipCount, getPositionLimits } = require('../services/portfolioService');
const { consensusService } = require('../services/consensusService');
const { executeBuy } = require('../services/tradeService');
const { healthMonitor } = require('../services/healthMonitor');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// 延遲工具
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 🧮 數學輔助工具區
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

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
    return emaArray;
}

function calculateMACD(closes) {
    if (closes.length < 26) return null;
    const ema12 = calculateEMA(closes, 12); const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = calculateEMA(macdLine, 9);
    const hist = macdLine.map((m, i) => m - signalLine[i]);
    return { hist: hist[hist.length - 1], prevHist: hist[hist.length - 2] };
}

function checkVolumeShrinkage(volumes) {
    if (volumes.length < 7) return false;
    const lastClosedVol = volumes[volumes.length - 2];
    const pastVols = volumes.slice(volumes.length - 7, volumes.length - 2);
    const avgVol = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;
    return lastClosedVol < (avgVol * 0.75);
}

// ==========================================
// 🚀 核心排程 (終極抗 429 批次初篩版 + 活躍波段參數)
// ==========================================
const blueChipJob = {
    start() {
        console.log(`📈 [BlueChip Radar] 批次防限流初篩版 (活躍波段模式) 啟動...`);
        healthMonitor.setStatus('Bluechip_Radar', '🟢 監聽中');

        let lastHeartbeat = Date.now(); // 💡 設立心跳計時器

        // 每 60 秒行一次
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

                // 💓 心跳包：每 10 分鐘報一次平安
                const now = Date.now();
                if (now - lastHeartbeat >= 10 * 60 * 1000) {
                    console.log(`📡 [BlueChip Radar] 💓 心跳包: 系統運作正常，過去 10 分鐘大市平靜，未見老幣回調觸發初篩。`);
                    lastHeartbeat = now; 
                }

                const { data: pool } = await supabase.from('bluechip_pool').select('*').eq('is_active', true);
                if (!pool || pool.length === 0 || !BIRDEYE_API_KEY) return;

                // 💡 1. 批次向 DexScreener 索取所有老幣報價 (1 個 Request 搞掂)
                const mintsArray = pool.map(t => t.mint_address.trim()).filter(Boolean);
                const chunk = mintsArray.slice(0, 30); // DexScreener 上限 30 隻
                const mintStr = chunk.join(',');

                let dexPairs = [];
                try {
                    const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintStr}`, { timeout: 5000 });
                    dexPairs = dexRes.data?.pairs || [];
                } catch (e) {
                    console.warn(`⚠️ [Bluechip] DexScreener 批次初篩失敗:`, e.message);
                    return; 
                }

                // 💡 2. 本地極速過濾：放寬至 1小時跌穿 4% 嘅幣
                const dipTokens = [];
                for (const token of pool) {
                    const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === token.mint_address);
                    const h1Change = pair ? parseFloat(pair.priceChange?.h1 || 0) : 0;
                    
                    // 🚀 放寬：跌幅超過 4% 才會被標記為抄底目標 (原為 -8%)
                    if (h1Change <= -4) {
                        dipTokens.push(token);
                    }
                }

                // 如果大市連 4% 回調都無，提早收工，0 Birdeye 消耗！
                if (dipTokens.length === 0) return;

                console.log(`🎯 [哨兵訊號] 發現 ${dipTokens.length} 隻老幣回調過 4%，準備啟動 Birdeye 精算...`);

                // 💡 3. 針對回調幣，逐隻向 Birdeye 索取 OHLCV (順序 + 強制 Sleep)
                for (const token of dipTokens) {
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&limit=100`, {
                            headers: { 
                                'X-API-KEY': BIRDEYE_API_KEY.replace(/['"]/g, '').trim(), 
                                'x-chain': 'solana' 
                            },
                            timeout: 8000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 30) {
                            const closes = items.map(k => parseFloat(k.o));
                            const volumes = items.map(k => parseFloat(k.v));
                            const currentPrice = closes[closes.length - 1];

                            const rsi = calculateRSI(closes);
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);
                            const isVolumeShrinking = checkVolumeShrinkage(volumes);

                            // 🚀 放寬：RSI 由 30 放寬至 40，觸及布林帶下軌邊緣 (1.01倍) 即可
                            if (rsi <= 40 && bb && currentPrice <= (bb.lower * 1.01) && isVolumeShrinking && macdData.hist > macdData.prevHist) {
                                console.log(`🚨 [Bluechip] ${token.token_symbol} 指標共振 (RSI: ${rsi.toFixed(1)})，移交 AI 軍師防雷...`);
                                const aiDecision = await consensusService.runBluechipConsensus(token.mint_address, {
                                    symbol: token.token_symbol, rsi, price: currentPrice, indicators: '四維共振 (活躍波段)'
                                });
                                if (aiDecision?.buy) {
                                    await executeBuy(token.mint_address, token.token_symbol, 'BLUECHIP_SWING', 100, aiDecision.reason, config.trade_amount_sol);
                                }
                            } else {
                                console.log(`ℹ️ [Bluechip] ${token.token_symbol} 未達精算門檻 (RSI: ${rsi.toFixed(1)})`);
                            }
                        }
                    } catch (e) {
                        const is429 = e.response?.status === 429;
                        console.warn(`⚠️ [Bluechip] ${token.token_symbol} ${is429 ? '觸發限流(429)' : 'API失敗'}`);
                    }

                    // 🛡️ 強制冷卻 2.5 秒，保護 Birdeye API 唔會撞 429
                    await sleep(2500); 
                }
                
            } catch (err) {
                healthMonitor.setStatus('Bluechip_Radar', `🔴 異常: ${err.message}`);
            }
        }, 60 * 1000); // 一分鐘大循環
    }
};

module.exports = { blueChipJob };