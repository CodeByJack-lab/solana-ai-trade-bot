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
    return lastClosedVol < (avgVol * 0.75); // 縮量 < 75%
}

function checkVolumeExpansion(volumes) {
    if (volumes.length < 7) return false;
    const lastClosedVol = volumes[volumes.length - 2];
    const pastVols = volumes.slice(volumes.length - 7, volumes.length - 3);
    const avgVol = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;
    return lastClosedVol > (avgVol * 1.5); // 放量突破 > 1.5倍
}

// ==========================================
// 🚀 核心排程 (左側抄底 + 右側突破 雙引擎)
// ==========================================
const blueChipJob = {
    start() {
        console.log(`📈 [BlueChip Radar] 活躍波段雙軌模式 (抄底+突破) 啟動...`);
        healthMonitor.setStatus('Bluechip_Radar', '🟢 監聽中');

        let lastHeartbeat = Date.now(); 

        const runRoutine = async () => {
            try {
                const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!config || !config.is_running) return;

                const { maxBluechip } = getPositionLimits();
                if (getBlueChipCount() >= maxBluechip) {
                    healthMonitor.setStatus('Bluechip_Radar', '🟡 老幣倉位已滿');
                    return;
                }

                healthMonitor.setStatus('Bluechip_Radar', '🟢 雙軌掃描中...');

                const now = Date.now();
                if (now - lastHeartbeat >= 10 * 60 * 1000) {
                    console.log(`📡 [BlueChip Radar] 💓 心跳包: 系統運作正常，等候技術指標共振。`);
                    lastHeartbeat = now; 
                }

                const { data: pool } = await supabase.from('bluechip_pool').select('*').eq('is_active', true);
                if (!pool || pool.length === 0 || !BIRDEYE_API_KEY) return;

                const mintsArray = pool.map(t => t.mint_address.trim()).filter(Boolean);
                let dexPairs = [];

                for (let i = 0; i < mintsArray.length; i += 30) {
                    const chunk = mintsArray.slice(i, i + 30);
                    const mintStr = chunk.join(',');
                    try {
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintStr}`, { timeout: 5000 });
                        if (dexRes.data?.pairs) dexPairs = dexPairs.concat(dexRes.data.pairs);
                    } catch (e) { console.warn(`⚠️ [Bluechip] DexScreener 批次初篩失敗`); }
                    await sleep(1000); 
                }

                // 💡 2. 本地極速過濾：跌幅超過 4% (抄底) OR 升幅超過 3% (突破)
                const targetTokens = [];
                for (const token of pool) {
                    const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === token.mint_address);
                    const h1Change = pair ? parseFloat(pair.priceChange?.h1 || 0) : 0;
                    
                    if (h1Change <= -4 || h1Change >= 3) {
                        targetTokens.push(token);
                    }
                }

                if (targetTokens.length === 0) return;
                console.log(`🎯 [哨兵訊號] 發現 ${targetTokens.length} 隻老幣有異動 (回調或突破)，啟動精算...`);

                for (const token of targetTokens) {
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&limit=100`, {
                            headers: { 'X-API-KEY': BIRDEYE_API_KEY.replace(/['"]/g, '').trim(), 'x-chain': 'solana' }, timeout: 8000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 30) {
                            const closes = items.map(k => parseFloat(k.o));
                            const volumes = items.map(k => parseFloat(k.v));
                            const currentPrice = closes[closes.length - 1];

                            const rsi = calculateRSI(closes);
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);

                            // 📉 策略 A：左側抄底 (Dip)
                            const isVolumeShrinking = checkVolumeShrinkage(volumes);
                            const isDip = rsi <= 40 && bb && currentPrice <= (bb.lower * 1.01) && isVolumeShrinking && macdData.hist > macdData.prevHist;

                            // 📈 策略 B：右側突破 (Breakout)
                            const isVolumeExpanding = checkVolumeExpansion(volumes);
                            const isBreakout = rsi >= 60 && rsi <= 75 && bb && currentPrice >= bb.middle && macdData.hist > 0 && isVolumeExpanding;

                            if (isDip || isBreakout) {
                                const signalType = isDip ? '左側抄底' : '右側突破';
                                console.log(`🚨 [Bluechip] ${token.token_symbol} 觸發【${signalType}】(RSI: ${rsi.toFixed(1)})，移交 AI 軍師防雷...`);
                                
                                const aiDecision = await consensusService.runBluechipConsensus(token.mint_address, {
                                    symbol: token.token_symbol, rsi, price: currentPrice, indicators: `技術面${signalType} (活躍波段)`
                                });
                                
                                if (aiDecision?.buy) {
                                    await executeBuy(token.mint_address, token.token_symbol, 'BLUECHIP_SWING', 100, aiDecision.reason, config.trade_amount_sol);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠️ [Bluechip] ${token.token_symbol} API失敗或限流`);
                    }
                    await sleep(2500); 
                }
            } catch (err) {
                healthMonitor.setStatus('Bluechip_Radar', `🔴 異常: ${err.message}`);
            }
        };

        runRoutine();
        setInterval(runRoutine, 60 * 1000); 
    }
};

module.exports = { blueChipJob };