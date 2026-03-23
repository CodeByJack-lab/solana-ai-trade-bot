// src/jobs/blueChipJob.js
const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../config/supabase'); 
const { executeBuy } = require('../services/tradeService'); 
const { consensusService } = require('../services/consensusService'); 
const { healthMonitor } = require('../services/healthMonitor');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// ==========================================
// 🧠 本地指標運算庫 (CPU 處理，0 API 消耗)
// ==========================================
function getRSIHistory(closes, periods = 14) {
    if (closes.length <= periods) return [50, 50, 50]; 
    let gains = 0, losses = 0;
    for (let i = 1; i <= periods; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / periods; let avgLoss = losses / periods;
    const rsiArray = [];
    
    for (let i = periods + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff >= 0 ? diff : 0; const loss = diff < 0 ? -diff : 0;
        avgGain = ((avgGain * (periods - 1)) + gain) / periods;
        avgLoss = ((avgLoss * (periods - 1)) + loss) / periods;
        const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
        rsiArray.push(rsi);
    }
    return rsiArray.slice(-3); 
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
    return { 
        hist: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1], 
        prevHist: macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2] 
    };
}

function checkVolumeShrinkage(volumes) {
    if (volumes.length < 3) return false;
    const recentVols = volumes.slice(-3);
    return recentVols[2] < recentVols[1] && recentVols[1] < recentVols[0]; 
}

let isRunning = false; 

const blueChipJob = {
    async runRoutine() {
        if (isRunning) return; 
        isRunning = true;
        healthMonitor.setStatus('Bluechip_Radar', '🟢 掃描中...');

        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) {
                healthMonitor.setStatus('Bluechip_Radar', '🟡 系統已暫停');
                isRunning = false;
                return;
            }

            const { data: pool } = await supabase.from('bluechip_pool').select('*').eq('is_active', true);
            if (!pool || pool.length === 0) {
                healthMonitor.setStatus('Bluechip_Radar', '🟡 追蹤名單為空');
                isRunning = false; return;
            }

            const mints = pool.map(p => p.mint_address).join(',');
            
            try {
                // 1. DexScreener 批次獲取基礎數據
                const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 5000 });
                const dexPairs = dexRes.data?.pairs || [];

                const { data: params } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
                const bluechipLimits = {
                    maxRSI: params?.bluechip_max_rsi || 35,
                    minDropPct: params?.bluechip_min_drop_pct || 3,
                    minVolUsd: params?.bluechip_min_vol || 500000 
                };

                // --- 篩選目標 (只睇陰跌/暴跌，徹底刪除突破追高) ---
                const targetTokens = [];
                for (const token of pool) {
                    const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === token.mint_address);
                    const h1Change = pair ? parseFloat(pair.priceChange?.h1 || 0) : 0;
                    const vol24h = pair ? parseFloat(pair.volume?.h24 || 0) : 0;
                    
                    if (vol24h < bluechipLimits.minVolUsd) continue;
                    
                    // 🚀 FIX: 必須是跌幅大於設定值 (例如跌超過 -2%) 才能入選。絕不買升！
                    if (h1Change <= -Math.abs(bluechipLimits.minDropPct)) {
                        targetTokens.push(token);
                    }
                }

                if (targetTokens.length === 0) {
                    healthMonitor.setStatus('Bluechip_Radar', '🟢 巡邏完畢 (無跌破目標)');
                    isRunning = false; return;
                }

                // --- 核心分析迴圈 ---
                for (const token of targetTokens) {
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&limit=30`, {
                            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
                            timeout: 5000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 30) {
                            const closes = items.map(k => parseFloat(k.o));
                            const volumes = items.map(k => parseFloat(k.v));
                            const currentPrice = closes[closes.length - 1];

                            const rsiHist = getRSIHistory(closes);
                            const prevRsi = rsiHist[1];
                            const currentRsi = rsiHist[2];
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);

                            const isVolumeShrinking = checkVolumeShrinkage(volumes);
                            const isRsiHook = prevRsi <= bluechipLimits.maxRSI && currentRsi > prevRsi; 
                            
                            // 🚀 FIX: 徹底刪除 isBreakout (右側突破) 邏輯，只做恐慌拋售後的右側抄底！
                            const isDip = isRsiHook && bb && currentPrice <= (bb.lower * 1.05) && isVolumeShrinking;

                            if (isDip) {
                                const signalType = '右側抄底(RSI勾頭)';
                                console.log(`🚨 [Bluechip] ${token.token_symbol} 觸發【${signalType}】(RSI: ${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})，讀取 AI 記憶庫...`);
                                
                                // 🌟 1. 讀取「大腦記憶體」
                                let { data: memory } = await supabase.from('bluechip_pool').select('last_ai_comment, last_observed_at').eq('mint_address', token.mint_address).single();
                                
                                let pastComment = "無歷史紀錄 (首次觀測)";
                                let pastTime = "N/A";
                                
                                if (memory && memory.last_ai_comment) {
                                    pastComment = memory.last_ai_comment;
                                    pastTime = new Date(memory.last_observed_at).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
                                }

                                // 🌟 2. 構建大腦所需的市場數據
                                const marketData = {
                                    symbol: token.token_symbol,
                                    currentPrice: currentPrice,
                                    rsiHistory: `[${rsiHist.map(r => r.toFixed(1)).join(', ')}]`,
                                    techIndicators: `MACD Hist: ${macdData?.hist.toFixed(6)}, 觸及布林下軌`,
                                    lastComment: pastComment,
                                    lastTime: pastTime
                                };

                                // 🌟 3. 呼叫大腦進行決策
                                const decisionObj = await consensusService.runBluechipConsensus(token.mint_address, marketData);

                                // 🌟 4. 執行狀態機邏輯
                                if (decisionObj.buy) {
                                    await executeBuy(token.mint_address, token.token_symbol, 'BLUECHIP_SWING', 100, decisionObj.reason, config.trade_amount_sol);
                                    // 買完清空記憶
                                    await supabase.from('bluechip_pool').update({ last_ai_comment: null, last_observed_at: null }).eq('mint_address', token.mint_address);
                                } else {
                                    if (decisionObj.reason.includes('ONHOLD')) {
                                        // 寫入記憶庫，等下次比對
                                        await supabase.from('bluechip_pool').update({ 
                                            last_ai_comment: decisionObj.reason, 
                                            last_observed_at: new Date() 
                                        }).eq('mint_address', token.mint_address);
                                    } else if (decisionObj.reason.includes('ABORT')) {
                                        // 判斷趨勢已死，清空記憶放棄跟蹤
                                        await supabase.from('bluechip_pool').update({ last_ai_comment: null, last_observed_at: null }).eq('mint_address', token.mint_address);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`⚠️ [Bluechip] 分析 ${token.token_symbol} 時發生錯誤:`, err.message);
                    }
                    await new Promise(r => setTimeout(r, 1000)); 
                }

                healthMonitor.setStatus('Bluechip_Radar', '🟢 巡邏完畢 (待機中)');
            } catch (err) {
                console.error(`❌ [Bluechip] DexScreener 批次請求失敗:`, err.message);
                healthMonitor.setStatus('Bluechip_Radar', `🔴 API 錯誤: ${err.message}`);
            }

        } catch (err) {
            console.error(`❌ [Bluechip] 雷達系統異常:`, err.message);
            healthMonitor.setStatus('Bluechip_Radar', `🔴 系統異常: ${err.message}`);
        } finally {
            isRunning = false;
        }
    },

    start() {
        cron.schedule('*/5 * * * *', () => { this.runRoutine(); });
        console.log(`📡 [Bluechip] 老幣抄底雷達已啟動 (每 5 分鐘掃描一次)`);
    }
};

module.exports = { blueChipJob };