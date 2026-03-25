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
// 🧠 本地指標運算庫
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

let isRunning = false; 

const blueChipJob = {
    async runRoutine() {
        if (isRunning) return; 
        isRunning = true;
        healthMonitor.setStatus('Bluechip_Radar', '🟢 掃描中...');

        const currentMinute = new Date().getMinutes();
        const shouldLog = (currentMinute % 10 === 0);

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

            if (shouldLog) {
                console.log(`\n💎 [Bluechip Radar] 每10分鐘例行報告: 目前雷達正鎖定 ${pool.length} 隻老幣進行靜默掃描...`);
            }

            try {
                let dexPairs = [];
                const chunkSize = 30; 
                for (let i = 0; i < pool.length; i += chunkSize) {
                    const chunk = pool.slice(i, i + chunkSize);
                    const chunkMints = chunk.map(p => p.mint_address).join(',');
                    
                    try {
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunkMints}`, { timeout: 5000 });
                        if (dexRes.data && dexRes.data.pairs) {
                            dexPairs = dexPairs.concat(dexRes.data.pairs);
                        }
                    } catch (e) {
                        if (e.response && e.response.status === 429) {
                            console.warn(`⚠️ [Bluechip] 觸發 429 限流，自動冷卻 2 秒...`);
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                    await new Promise(r => setTimeout(r, 500)); 
                }

                const { data: params } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
                const bluechipLimits = {
                    maxRSI: params?.bluechip_max_rsi || 40,
                    minDropPct: params?.bluechip_min_drop_pct || 2, 
                    minVolUsd: params?.bluechip_min_vol || 500000 
                };

                const targetTokens = [];
                const targetDrop = Math.abs(bluechipLimits.minDropPct);
                
                for (const token of pool) {
                    const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === token.mint_address);
                    const h1Change = pair ? parseFloat(pair.priceChange?.h1 || 0) : 0;
                    const h24Change = pair ? parseFloat(pair.priceChange?.h24 || 0) : 0; 
                    const vol24h = pair ? parseFloat(pair.volume?.h24 || 0) : 0;
                    
                    if (vol24h < bluechipLimits.minVolUsd) continue;
                    
                    if (h1Change <= -(targetDrop / 2) || h24Change <= -targetDrop) {
                        targetTokens.push(token);
                    }
                }

                if (targetTokens.length === 0) {
                    if (shouldLog) {
                        console.log(`💎 [Bluechip Radar] 掃描完畢: ${pool.length} 隻老幣均未觸發急跌門檻，大盤企穩中。`);
                    }
                    healthMonitor.setStatus('Bluechip_Radar', '🟢 巡邏完畢 (無跌破目標)');
                    isRunning = false; return;
                }

                console.log(`\n🚨 [Bluechip Radar] 警報！發現 ${targetTokens.length} 隻老幣觸發跌幅門檻，啟動 Birdeye 深度技術分析...`);

                const time_to = Math.floor(Date.now() / 1000);
                const time_from = time_to - (30 * 15 * 60); 

                for (const token of targetTokens) {
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&time_from=${time_from}&time_to=${time_to}`, {
                            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
                            timeout: 5000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 30) {
                            const closes = items.map(k => parseFloat(k.o));
                            const currentPrice = closes[closes.length - 1];

                            const rsiHist = getRSIHistory(closes);
                            const prevRsi = rsiHist[1];
                            const currentRsi = rsiHist[2];
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);

                            const isRsiHook = prevRsi <= bluechipLimits.maxRSI && currentRsi > prevRsi; 
                            const isDip = isRsiHook && bb && currentPrice <= (bb.lower * 1.05);

                            if (isDip) {
                                const signalType = '右側抄底(RSI勾頭)';
                                console.log(`🎯 [Bluechip] ${token.token_symbol} 觸發【${signalType}】(RSI: ${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})，讀取 AI 記憶庫...`);
                                
                                let { data: memory } = await supabase.from('bluechip_pool').select('last_ai_comment, last_observed_at').eq('mint_address', token.mint_address).single();
                                
                                let pastComment = "無歷史紀錄 (首次觀測)";
                                let pastTime = "N/A";
                                
                                if (memory && memory.last_ai_comment) {
                                    pastComment = memory.last_ai_comment;
                                    pastTime = new Date(memory.last_observed_at).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
                                }

                                const marketData = {
                                    symbol: token.token_symbol,
                                    currentPrice: currentPrice,
                                    rsiHistory: `[${rsiHist.map(r => r.toFixed(1)).join(', ')}]`,
                                    techIndicators: `MACD Hist: ${macdData?.hist.toFixed(6)}, 觸及布林下軌`,
                                    lastComment: pastComment,
                                    lastTime: pastTime
                                };

                                const decisionObj = await consensusService.runBluechipConsensus(token.mint_address, marketData);

                                if (decisionObj.buy) {
                                    await executeBuy(token.mint_address, token.token_symbol, 'BLUECHIP_SWING', 100, decisionObj.reason, config.trade_amount_sol);
                                    await supabase.from('bluechip_pool').update({ last_ai_comment: null, last_observed_at: null }).eq('mint_address', token.mint_address);
                                } else {
                                    console.log(`🧠 [Bluechip AI] ${token.token_symbol} 抄底被否決: ${decisionObj.reason}`);
                                    if (decisionObj.reason.includes('ONHOLD')) {
                                        await supabase.from('bluechip_pool').update({ 
                                            last_ai_comment: decisionObj.reason, 
                                            last_observed_at: new Date() 
                                        }).eq('mint_address', token.mint_address);
                                    } else if (decisionObj.reason.includes('ABORT')) {
                                        await supabase.from('bluechip_pool').update({ last_ai_comment: null, last_observed_at: null }).eq('mint_address', token.mint_address);
                                    }
                                }
                            } else {
                                console.log(`⏸️ [Bluechip] ${token.token_symbol} 未達完美抄底條件 (目前 RSI: ${currentRsi.toFixed(1)}, 現價: $${currentPrice.toFixed(4)}, 布林底門檻: $${(bb.lower * 1.05).toFixed(4)})，放棄呼叫 AI。`);                            }
                        } else {
                            console.log(`⚠️ [Bluechip] ${token.token_symbol} K線數據不足 (僅 ${items.length}/30 支)，放棄技術分析。`);
                        }
                    } catch (err) {
                        console.warn(`⚠️ [Bluechip] 分析 ${token.token_symbol} 時發生錯誤:`, err.message);
                        // 🚀 新增呢段：捉住 HTTP 400 真正死因！
                        if (err.response && err.response.data) {
                            console.error(`🚨 [API 拒絕原因]:`, JSON.stringify(err.response.data, null, 2));
                        }
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
        console.log(`📡 [Bluechip] 老幣抄底雷達已啟動 (背景靜默掃描，每 10 分鐘印出戰報)`);
    }
};

module.exports = { blueChipJob };