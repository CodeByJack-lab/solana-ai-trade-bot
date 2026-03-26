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

            // 🚀 核心變數：大盤分數、錢包餘額與老幣專屬資金
            const currentNewsScore = config.latest_news_score || 0;
            const currentWalletBalance = parseFloat(config.live_wallet_balance) || 0;
            // 兼容防呆：如果資料庫未更新 bluechip_trade_amount_sol，則跌回使用 trade_amount_sol
            const baseBluechipAmount = parseFloat(config.bluechip_trade_amount_sol) || parseFloat(config.trade_amount_sol) || 0.1; 

            try {
                // 1. DexScreener 初步篩選
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
                    maxRSI: parseFloat(params?.bluechip_max_rsi) || 40,
                    minDropPct: parseFloat(params?.bluechip_min_drop_pct) || 2, 
                    minVolUsd: parseFloat(params?.bluechip_min_vol) || 500000 
                };

                const targetTokens = [];
                const targetDrop = Math.abs(bluechipLimits.minDropPct);
                
                for (const token of pool) {
                    const pair = dexPairs.find(p => p.chainId === 'solana' && p.baseToken?.address === token.mint_address);
                    const h1Change = pair ? parseFloat(pair.priceChange?.h1 || 0) : 0;
                    const h24Change = pair ? parseFloat(pair.priceChange?.h24 || 0) : 0; 
                    const vol24h = pair ? parseFloat(pair.volume?.h24 || 0) : 0;
                    
                    if (vol24h < bluechipLimits.minVolUsd) continue;
                    
                    // 🚀 觸發「閃崩特權」條件：1小時跌幅 > 8%
                    const isFlashCrash = h1Change <= -8.0;

                    if (isFlashCrash || h1Change <= -(targetDrop / 2) || h24Change <= -targetDrop) {
                        targetTokens.push({ ...token, isFlashCrash, pair }); // 儲存閃崩狀態
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

                    // 讀取過往 AI 記憶
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
                            const volumes = items.map(k => parseFloat(k.v)); // 取出成交量
                            marketData.currentPrice = closes[closes.length - 1];

                            const rsiHist = getRSIHistory(closes);
                            const prevRsi = rsiHist[1];
                            const currentRsi = rsiHist[2];
                            const bb = calculateBollingerBands(closes);
                            const macdData = calculateMACD(closes);

                            marketData.rsiHistory = `[${rsiHist.map(r => r.toFixed(1)).join(', ')}]`;
                            
                            // 🚀 核心優化：成交量背離分析
                            // 取過去19根K線的平均成交量 (排除最後一根)
                            const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
                            const currentVol = volumes[volumes.length - 1];
                            const volRatio = avgVol > 0 ? (currentVol / avgVol) : 1;

                            const isOversold = prevRsi <= bluechipLimits.maxRSI;
                            const isRsiHook = currentRsi > prevRsi;
                            const isVolumeHealthy = volRatio < 3.0; // 拋壓若大於平均 3 倍，視為機構砸盤，攔截

                            // ⚡ 閃崩左側特權 vs 常規右側抄底
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
                                // 列出精準的雷達攔截原因
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

                    // 🛡️ [防線二]: CoinGecko / DexScreener 降級備援分析
                    if (!layer1Success) {
                        console.log(`📡 [Level 2] 啟動 CoinGecko / DexScreener 備援分析 ${token.token_symbol}...`);
                        const pair = token.pair; // 使用前面存的 pair
                        
                        let cgPrice = null;
                        try {
                            if (process.env.COINGECKO_API_KEY) {
                                const cgRes = await axios.get(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${token.mint_address}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, {
                                    headers: { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY },
                                    timeout: 4000
                                });
                                const tokenData = cgRes.data[token.mint_address];
                                if (tokenData && tokenData.usd) {
                                    cgPrice = tokenData.usd;
                                }
                            }
                        } catch (cgErr) {
                            console.warn(`⚠️ [CoinGecko] 備援請求失敗:`, cgErr.message);
                        }

                        if (cgPrice || pair) {
                            marketData.currentPrice = cgPrice || parseFloat(pair.priceNative);
                            const drop1h = pair ? pair.priceChange?.h1 : "N/A";
                            marketData.techIndicators = `技術指標失效(API 400)。當前大跌: 1h跌幅 ${drop1h}%, 24h量 $${pair?.volume?.h24 || 'N/A'}`;
                            strategy = 'BLUECHIP_DEX_FALLBACK';
                            isDipConfirmed = true; 
                            console.log(`🎯 [Level 2 Fallback] ${token.token_symbol} 觸發大跌備援機制，強制呼叫 AI 審查！`);
                        }
                    }

                    // 🛡️ [防線三]: Jupiter 緊急報價 (最後防線)
                    if (!layer1Success && marketData.currentPrice === 0) {
                        console.log(`📡 [Level 3] 啟動 Jupiter 緊急報價防線...`);
                        try {
                            const jupRes = await axios.get(`https://api.jup.ag/price/v2?ids=${token.mint_address}`);
                            const jupPrice = jupRes.data?.data?.[token.mint_address]?.price;
                            if (jupPrice) {
                                marketData.currentPrice = parseFloat(jupPrice);
                                marketData.techIndicators = `Jupiter 緊急報價 (所有歷史數據源均失效)`;
                                strategy = 'BLUECHIP_JUP_EMERGENCY';
                                isDipConfirmed = true;
                            }
                        } catch (e) {
                            console.error(`💀 [Level 3] 所有報價源全滅，放棄 ${token.token_symbol}`);
                        }
                    }

                    // 🧠 執行 AI 決策
                    if (isDipConfirmed && marketData.currentPrice > 0) {
                        const decisionObj = await consensusService.runBluechipConsensus(token.mint_address, marketData);

                        if (decisionObj.buy) {
                            // 🚀 核心升級：動態資金分配邏輯
                            let finalAmount = baseBluechipAmount;
                            
                            // A. 避險減倉 (新聞指數 > 60)
                            if (currentNewsScore > 60) {
                                finalAmount *= 0.5;
                                console.log(`🛡️ [Macro Risk] 大盤不穩 (得分:${currentNewsScore})，老幣倉位自動減半至 ${finalAmount.toFixed(3)} SOL`);
                            }
                            
                            // B. 極限加碼 (RSI < 20 且 餘額 >= 1.0 SOL)
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
        console.log(`📡 [Bluechip] 老幣抄底雷達已啟動 (閃崩/量價過濾版)`);
    }
};

module.exports = { blueChipJob };