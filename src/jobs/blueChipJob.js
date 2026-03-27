// src/jobs/blueChipJob.js
const cron = require('node-cron');
const axios = require('axios'); // 僅保留給 Birdeye OHLCV 獲取 K 線使用
const { supabase } = require('../config/supabase'); 
const { executeBuy } = require('../services/tradeService'); 
const { consensusService } = require('../services/consensusService'); 
const { healthMonitor } = require('../services/healthMonitor');
const { priceOracleService } = require('../services/priceOracleService');
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

            const currentNewsScore = config.latest_news_score || 0;
            const currentWalletBalance = parseFloat(config.live_wallet_balance) || 0;
            const baseBluechipAmount = parseFloat(config.bluechip_trade_amount_sol) || parseFloat(config.trade_amount_sol) || 0.1; 

            try {
                // 🚀 V7.0 Oracle 批次查價
                const poolMints = pool.map(p => p.mint_address);
                const pricesMap = await priceOracleService.getPrices(poolMints);

                const { data: params } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
                
                // 👇👇👇 [V7.0 參數名稱統一大一統]
                const bluechipLimits = {
                    maxRSI: parseFloat(params?.max_rsi) || 40,
                    minDropPct: parseFloat(params?.min_drop_pct) || 2, 
                    minVolUsd: parseFloat(params?.min_vol_24h) || 500000 
                };

                const targetTokens = [];
                const targetDrop = Math.abs(bluechipLimits.minDropPct);
                
                for (const token of pool) {
                    const tokenData = pricesMap[token.mint_address];
                    if (!tokenData) continue;

                    const vol24h = (tokenData.volume5m || 0) * 288;
                    const h1Change = tokenData.h1 || 0;
                    const h24Change = tokenData.h24 || 0;
                    
                    if (vol24h < bluechipLimits.minVolUsd) continue;
                    
                    const isFlashCrash = h1Change <= -8.0;

                    if (isFlashCrash || h1Change <= -(targetDrop / 2) || h24Change <= -targetDrop) {
                        targetTokens.push({ ...token, isFlashCrash, tokenData });
                    }
                }

                if (targetTokens.length === 0) {
                    if (shouldLog) {
                        console.log(`💎 [Bluechip Radar] 掃描完畢: ${pool.length} 隻老幣均未觸發急跌門檻，大盤企穩中。`);
                    }
                    healthMonitor.setStatus('Bluechip_Radar', '🟢 巡邏完畢 (無跌破目標)');
                    isRunning = false; return;
                }

                console.log(`\n🚨 [Bluechip Radar] 警報！發現 ${targetTokens.length} 隻老幣觸發跌幅門檻，啟動多層深度分析...`);

                const time_to = Math.floor(Date.now() / 1000);
                const time_from = time_to - (30 * 15 * 60); 

                for (const token of targetTokens) {
                    console.log(`⏳ [Birdeye Safety] 為防 429 限流，冷卻 1.5 秒後分析下一隻...`);
                    await new Promise(r => setTimeout(r, 1500));
                    
                    let strategy = 'BLUECHIP_SWING';
                    let isDipConfirmed = false;
                    let marketData = {
                        symbol: token.token_symbol,
                        currentPrice: 0,
                        rsiHistory: "N/A",
                        techIndicators: "",
                        lastComment: "無歷史紀錄 (首次觀測)",
                        lastTime: "N/A"
                    };

                    let { data: memory } = await supabase.from('bluechip_pool').select('last_ai_comment, last_observed_at').eq('mint_address', token.mint_address).single();
                    if (memory && memory.last_ai_comment) {
                        marketData.lastComment = memory.last_ai_comment;
                        marketData.lastTime = new Date(memory.last_observed_at).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
                    }

                    // 🛡️ [防線一]: Birdeye 深度技術分析
                    let layer1Success = false;
                    try {
                        const birdeyeRes = await axios.get(`https://public-api.birdeye.so/defi/ohlcv?address=${token.mint_address}&type=15m&time_from=${time_from}&time_to=${time_to}`, {
                            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
                            timeout: 5000
                        });

                        const items = birdeyeRes.data?.data?.items || [];
                        if (items.length >= 30) {
                            layer1Success = true;
                            const closes = items.map(k => parseFloat(k.o));
                            const volumes = items.map(k => parseFloat(k.v)); 
                            marketData.currentPrice = closes[closes.length - 1];

                            const rsiHist = getRSIHistory(closes);
                            const prevRsi = rsiHist[1];
                            const currentRsi = rsiHist[2];
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);

                            marketData.rsiHistory = `[${rsiHist.map(r => r.toFixed(1)).join(', ')}]`;
                            
                            const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
                            const currentVol = volumes[volumes.length - 1];
                            const volRatio = avgVol > 0 ? (currentVol / avgVol) : 1;

                            const isOversold = prevRsi <= bluechipLimits.maxRSI;
                            const isRsiHook = currentRsi > prevRsi;
                            const isVolumeHealthy = volRatio < 3.0; 

                            if (token.isFlashCrash && isVolumeHealthy) {
                                isDipConfirmed = true;
                                strategy = 'BLUECHIP_FLASH_CRASH';
                                marketData.techIndicators = `閃崩特權啟動: 1h跌幅>8%, 量能比:${volRatio.toFixed(1)}`;
                                console.log(`🎯 [Level 1 Birdeye] ${token.token_symbol} 觸發【閃崩抄底】(1h跌幅>8%)，呼叫 AI 大腦！`);
                            } else if (isOversold && isRsiHook && isVolumeHealthy) {
                                isDipConfirmed = true;
                                const bbStatus = (bb && marketData.currentPrice <= bb.lower) 
                                    ? '已跌穿布林下軌 (極度恐慌)' 
                                    : (bb ? `高於布林下軌 ${((marketData.currentPrice - bb.lower)/bb.lower*100).toFixed(1)}%` : '無布林帶數據');
                                
                                marketData.techIndicators = `MACD Hist: ${macdData?.hist?.toFixed(6)}, 狀態: ${bbStatus}, 量能比:${volRatio.toFixed(1)}`;
                                console.log(`🎯 [Level 1 Birdeye] ${token.token_symbol} 觸發【右側抄底】(RSI: ${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})，呼叫 AI 大腦！`);
                            } else {
                                if (!isVolumeHealthy) {
                                    console.log(`⏸️ [Bluechip] ${token.token_symbol} 成交量異常放大 (${volRatio.toFixed(1)}x)，防範機構砸盤`);
                                } else if (!isOversold && !token.isFlashCrash) {
                                    console.log(`⏸️ [Bluechip] ${token.token_symbol} 未達 RSI 超賣門檻 (前RSI: ${prevRsi.toFixed(1)} > 門檻 ${bluechipLimits.maxRSI})`);
                                } else if (!isRsiHook && !token.isFlashCrash) {
                                    console.log(`⏸️ [Bluechip] ${token.token_symbol} RSI 達標但未見勾頭反彈，防接飛刀 (RSI: ${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})`);
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`⚠️ [Level 1] Birdeye 分析 ${token.token_symbol} 失敗:`, err.message);
                    }

                    // 🛡️ [防線二]: 統一 Oracle 備援防線
                    if (!layer1Success) {
                        console.log(`📡 [Level 2] Birdeye 失效，啟動 Oracle 終極備援防線 ${token.token_symbol}...`);
                        const tokenData = token.tokenData; 
                        
                        if (tokenData && tokenData.priceUsd > 0) {
                            marketData.currentPrice = tokenData.priceSol || (tokenData.priceUsd / 150);
                            marketData.techIndicators = `技術指標失效(Birdeye 400)。當前大跌: 1h跌幅 ${tokenData.h1 || 'N/A'}%, 24h量 $${((tokenData.volume5m || 0) * 288).toFixed(0)}`;
                            strategy = 'BLUECHIP_ORACLE_FALLBACK';
                            isDipConfirmed = true; 
                            console.log(`🎯 [Level 2 Fallback] ${token.token_symbol} 觸發大跌備援機制，強制呼叫 AI 審查！`);
                        } else {
                            console.error(`💀 [Level 2] Oracle 報價亦失效，放棄 ${token.token_symbol}`);
                        }
                    }

                    // 🧠 執行 AI 決策
                    if (isDipConfirmed && marketData.currentPrice > 0) {
                        const decisionObj = await consensusService.runBluechipConsensus(token.mint_address, marketData);

                        if (decisionObj.buy) {
                            let finalAmount = baseBluechipAmount;
                            
                            if (currentNewsScore > 60) {
                                finalAmount *= 0.5;
                                console.log(`🛡️ [Macro Risk] 大盤不穩 (得分:${currentNewsScore})，老幣倉位自動減半至 ${finalAmount.toFixed(3)} SOL`);
                            }
                            
                            const currentRsiMatch = marketData.rsiHistory.match(/[\d.]+(?=\])/);
                            const currentRsiValue = currentRsiMatch ? parseFloat(currentRsiMatch[0]) : 50;
                            
                            if (currentRsiValue < 20 && currentWalletBalance >= 1.0) {
                                finalAmount *= 1.5;
                                console.log(`🔥 [Extreme Deep] RSI 極度超賣 (${currentRsiValue.toFixed(1)}) 且餘額安全，觸發 1.5x 加碼至 ${finalAmount.toFixed(3)} SOL`);
                            }

                            await executeBuy(token.mint_address, token.token_symbol, strategy, 100, decisionObj.reason, finalAmount);
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
                    }
                }

                healthMonitor.setStatus('Bluechip_Radar', '🟢 巡邏完畢 (待機中)');
            } catch (err) {
                console.error(`❌ [Bluechip] 系統錯誤:`, err.message);
                healthMonitor.setStatus('Bluechip_Radar', `🔴 異常: ${err.message}`);
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
        console.log(`📡 [Bluechip] 老幣抄底雷達已啟動 (閃崩/量價通用過濾版, V7.0 Oracle 驅動)`);
    }
};

module.exports = { blueChipJob };