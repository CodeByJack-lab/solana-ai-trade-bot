// src/microservices/trade_frontline.js
// 📝 檔案功能用途：V10.22 【獵人中樞】微服務 (Microservice Core)
// 🚀 核心升級：修復 LLM 決策日誌無顯示理由的視覺 Bug。實裝「三權分立」計分法 (Quant20+ML65+LLM15)。

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios'); 
const { createClient } = require('@supabase/supabase-js'); 

// 載入 V10 底層模組
const { getPortfolio, initPortfolio, canBuyMeme, canBuyTrending } = require('../services/portfolioService'); 
const { securityGuard } = require('../services/securityGuard'); 
const { consensusService } = require('../services/consensusService'); 
const { executeBuy, runSellPipeline } = require('../services/tradeService'); 
const { sendTelegramAlert, processTelegramCallback } = require('../services/telegramService'); 
const { getJupiterFinalQuote } = require('../services/tradeService');
const { sourceAggregator } = require('../services/sourceAggregator'); 
const { walletMonitorRouter } = require('../services/walletMonitor'); 
const { keyRotator } = require('../services/keyRotator'); 
const { cacheManager } = require('../services/cacheManager'); 

const app = express();
app.use(express.json());
app.use('/', walletMonitorRouter);

const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const burnSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const watchdogSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379'); 

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let globalConfig = { is_running: true };

const last_valid_ts = new Map();
const latest_market_data = new Map();
const symbol_cache = new Map(); 
let ml_compiled_rule_func = () => false; 

const BRAND_BLACKLIST = new Set([
    'OPENAI', 'CHATGPT', 'SORA', 'CLAUDE', 'GEMINI', 'NVIDIA', 'APPLE', 'META', 'GOOGLE', 'MICROSOFT', 'AMAZON', 'TSMC', 'AMD', 'INTEL',
    'GROK', 'ELON', 'MUSK', 'TRUMP', 'BIDEN', 'OBAMA', 'PUTIN', 'ZELENSKY', 'TATE', 'MRBEAST',
    'BLACKROCK', 'VANGUARD', 'FIDELITY', 'SEC', 'FED', 'JPMORGAN', 'OIL', 'PETROL', 'GAS', 'GOLD', 'SILVER',
    'GTA', 'ROBLOX', 'RBX', 'NINTENDO', 'DISNEY', 'POKEMON',
    'PEPE', 'DOGE', 'SHIB', 'MAGA', 'WIF', 'BOME', 'BONK', 'SLERF', 'POPCAT',
    'BINANCE', 'COINBASE', 'KRAKEN', 'FTX', 'ALAMEDA', 'TETHER', 'CIRCLE', 'ZARA'
]);

redisSub.subscribe('price_updates', 'trending_signal'); 
redisSub.on('message', (channel, message) => {
    if (channel === 'price_updates') {
        try {
            const payload = JSON.parse(message);
            for (const [mint, data] of Object.entries(payload)) {
                if (data.ts <= (last_valid_ts.get(mint) || 0)) continue;
                last_valid_ts.set(mint, data.ts);
                latest_market_data.set(mint, data); 
            }
        } catch (e) {}
    }
    
    if (channel === 'trending_signal') {
        try {
            const { mint, symbol } = JSON.parse(message);
            symbol_cache.set(mint, symbol);
            console.log(`\n🐺 [Frontline] 接收到 TRENDING 藍籌訊號: ${symbol}，送入三權決策漏斗！`);
            setImmediate(() => processAsymmetricRouting(mint, 'TRENDING'));
        } catch (e) {}
    }
});

watchdogSub.subscribe('watchdog_alerts');
watchdogSub.on('message', async (channel, message) => {
    if (channel === 'watchdog_alerts') {
        try {
            const { mint, symbol, pnl, cvd, vwap_dev, volatility, climate } = JSON.parse(message);
            console.log(`🕵️‍♂️ [Watchdog] 接收到 ${symbol} 階梯體檢請求 (+${pnl.toFixed(1)}%)，呼叫 MISTRAL...`);

            const aiConfig = cacheManager.getPromptConfig('POSITION_WATCHDOG', {
                token_symbol: symbol, current_profit_pct: pnl.toFixed(2), 
                max_profit_pct: pnl.toFixed(2), market_climate: climate
            });
            const dataPrompt = `${aiConfig.parsedPrompt}\n[Hard Data] CVD Slope: ${cvd.toFixed(0)}, VWAP Dev: ${vwap_dev.toFixed(2)}%, Volatility: ${volatility.toFixed(4)}`;

            const decision = await keyRotator.enqueueRequest('MISTRAL', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: aiConfig.models[0] || 'mistral-large-latest',
                    messages: [{ role: "user", content: dataPrompt }],
                    response_format: { type: "json_object" }, temperature: 0.1
                }, { headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
                return JSON.parse(res.data.choices[0].message.content);
            }, 'POSITION_WATCHDOG');

            console.log(`🤖 [AI Watchdog] $${symbol} | 判定: ${decision.action} | 理由: ${decision.thought_process}`);

            if (decision.action === 'SELL_HALF' || decision.action === 'SELL_ALL') {
                const portfolio = getPortfolio();
                const pos = portfolio.positions.find(p => p.mint_address === mint);
                if (pos) {
                    const isHalfSold = pos.strategy_type?.includes('HALF_SOLD');
                    if (decision.action === 'SELL_HALF' && isHalfSold) return;

                    const lockKey = `sell_lock:${mint}`;
                    const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
                    if (acquired) {
                        const fraction = decision.action === 'SELL_HALF' ? 0.5 : 1.0;
                        await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, `🤖 AI 數據體檢: ${decision.thought_process}`, fraction)
                            .finally(() => redisClient.del(lockKey));
                    }
                }
            }
        } catch (e) {
            console.error(`⚠️ [Watchdog Error] 體檢失敗:`, e.message);
        }
    }
});

setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [mint, ts] of last_valid_ts.entries()) {
        if (now - ts > 10 * 60 * 1000) { 
            last_valid_ts.delete(mint);
            latest_market_data.delete(mint);
            symbol_cache.delete(mint);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) console.log(`🧹 [Garbage Collector] 已釋放 ${cleanedCount} 隻過期代幣的 RAM 緩存。`);
}, 60 * 1000); 

setInterval(async () => {
    if (!globalConfig.is_running) return;
    
    const portfolio = getPortfolio();
    const activeMints = portfolio.positions?.map(p => p.mint_address) || [];
    if (activeMints.length === 0) return;

    const now = Date.now();
    let deadMints = []; 

    for (const mint of activeMints) {
        const lastTs = last_valid_ts.get(mint) || 0;
        if (now - lastTs > 6000) { 
            deadMints.push(mint);
        }
    }

    if (deadMints.length > 0) {
        console.warn(`🚨 [DEFCON 6] Koyeb 查價中斷！有 ${deadMints.length} 隻持倉幣超過 6 秒無報價，啟動 Jupiter 救援！`);
        try {
            const jupMints = [...deadMints, 'So11111111111111111111111111111111111111112'];
            const res = await axios.get(`https://api.jup.ag/price/v3?ids=${jupMints.join(',')}`, { timeout: 3000 });
            
            const solUsd = parseFloat(res.data?.data?.['So11111111111111111111111111111111111111112']?.price || '1');
            const fallbackPayload = {};
            const ts = Date.now();
            
            deadMints.forEach(m => {
                if (res.data?.data?.[m]?.price) {
                    fallbackPayload[m] = { p: parseFloat(res.data.data[m].price) / solUsd, v: 0, b: 0, s: 0, l: 0, ts: ts };
                    last_valid_ts.set(m, ts); 
                    latest_market_data.set(m, fallbackPayload[m]); 
                }
            });
            
            if (Object.keys(fallbackPayload).length > 0) {
                await redisClient.publish('price_updates', JSON.stringify(fallbackPayload));
            }
        } catch (err) {
            console.error(`❌ [Jupiter Rescue] 救援失敗: ${err.message}`);
        }
    }
}, 4000); 

function runLayer1PhysicalFilter(symbol) {
    if (!symbol) return false;
    const upperSymbol = symbol.toUpperCase();
    if (/[^\x00-\x7F]/.test(upperSymbol)) return false;
    if (BRAND_BLACKLIST.has(upperSymbol)) return false;
    return true;
}

app.post('/webhook/radar', (req, res) => {
    res.status(200).send('OK'); 
    setImmediate(async () => {
        try {
            const payload = req.body[0] || req.body;
            if (!payload || !payload.mint) return;
            const symbol = payload.symbol || 'UNKNOWN';
            if (!runLayer1PhysicalFilter(symbol)) return; 
            symbol_cache.set(payload.mint, symbol);
            
            console.log(`\n🐺 [Frontline] 接收到 NEWBORN 藍籌訊號: ${symbol}，送入保溫箱！`);
            await redisClient.zadd('v9_nursery_queue', Date.now(), payload.mint);
        } catch (e) {}
    });
});

setInterval(async () => {
    if (!globalConfig.is_running) return;
    try {
        const now = Date.now();
        const ripeTokens = await redisClient.zrangebyscore('v9_nursery_queue', 0, now - (5 * 60 * 1000));
        if (ripeTokens.length > 0) {
            await redisClient.zrem('v9_nursery_queue', ...ripeTokens);
            for (const mint of ripeTokens) {
                await processAsymmetricRouting(mint, 'NEWBORN');
                await new Promise(r => setTimeout(r, 1000)); 
            }
        }
    } catch (e) {}
}, 10000);

async function processAsymmetricRouting(mint, poolType = 'NEWBORN') {
    try {
        if (poolType === 'NEWBORN' && !canBuyMeme()) return;
        if (poolType === 'TRENDING' && !canBuyTrending()) return;

        const marketData = latest_market_data.get(mint); 
        if (!marketData || marketData.v === 0) return;

        const symbol = symbol_cache.get(mint) || 'UNKNOWN';

        // 🛡️ 第一權：Quant 量化物理安檢 (滿分 20 分)
        const secResult = await securityGuard.calculateQuantScore(mint, poolType);
        if (!secResult.isSafe) {
            console.log(`🛑 [Quant Reject] ${symbol} 未達基準: ${secResult.reason}`);
            
            const isRugTrap = marketData.l > 10000 && (
                secResult.reason.includes('合約高危') || 
                secResult.reason.includes('籌碼集中') || 
                secResult.reason.includes('貔貅攔截')
            );

            if (isRugTrap && Math.random() < 0.20) {
                console.log(`☠️ [Poison Data] 捕獲高級 Rug Pull 陷阱 (${symbol})！作為負樣本寫入 ML 數據庫...`);
                const totalTxs = marketData.b + marketData.s;
                const ofi = totalTxs > 0 ? (marketData.b - marketData.s) / totalTxs : 0;
                
                supabase.from('trade_patterns').insert([{
                    mint_address: mint,
                    token_symbol: symbol,
                    entry_price_sol: marketData.p || 0,
                    entry_ofi: ofi,
                    entry_liquidity_usd: marketData.l,
                    entry_volume_5m: marketData.v,
                    realized_pnl_pct: -100.00 
                }]).then(({error}) => {
                    if (error) console.error(`❌ [Poison Data] 寫入負樣本失敗:`, error.message);
                });
            }
            return;
        }

        const quantScore = secResult.numeric_score; 
        const appliedMlStrategyId = secResult.applied_ml_strategy_id || 0;
        console.log(`   - 🛡️ [Quant] 基礎物理審核通過，得分: ${quantScore}/20`);

        // 🧠 第二權：Python ML 大腦預測勝率 (滿分 65 分)
        let mlScore = 32; 
        let mlConfidenceMultiplier = 1.0; 
        
        try {
            const res = await axios.post('http://127.0.0.1:8000/predict', { features: marketData, type: poolType }, { timeout: 2000 });
            if (res.data && typeof res.data.win_probability === 'number') {
                mlScore = res.data.score || 0; 
                mlConfidenceMultiplier = res.data.confidence_multiplier || 1.0;
                console.log(`   - 🤖 [ML Brain] 勝率預測: ${(res.data.win_probability * 100).toFixed(1)}% | 得分: ${mlScore}/65 | 注碼乘數: x${mlConfidenceMultiplier}`);
            }
        } catch (e) {
            console.warn(`   - ⚠️ [ML Brain] 離線或超時，無法獲取勝率預測 (給予預設 32 分)`);
        }

        // 🗣️ 第三權：LLM 敘事與防山寨審批 (-15 分 到 +15 分)
        const envStateStr = await redisClient.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'CHOPPY' };
        
        let llmScore = 0;
        let llmReason = "LLM 未啟用";
        try {
            console.log(`   - 🧠 [LLM Consensus] 發起 ${symbol} 的敘事潛力會議...`);
            const llmResult = await consensusService.runMemeConsensus(mint, marketData, { poolType, climate: envState.climate });
            llmScore = llmResult.narrative_score || 0;
            llmReason = llmResult.reason || "無解釋";
            
            // 🚨 FIX: 完美印出分數與理由
            console.log(`   - 🗣️ [LLM Consensus] 敘事得分: ${llmScore > 0 ? '+' : ''}${llmScore} 分 | 簡評: ${llmReason}`);
        } catch (e) {
            console.warn(`   - ⚠️ [LLM Down] 敘事分析失敗，跳過 LLM 加減分。`);
        }

        // 🚀 4. 全自動發射決策 
        const finalScore = quantScore + mlScore + llmScore;
        
        let buyThreshold = 70; 
        try {
            const mlParamsStr = await redisClient.get('ml_strategy_params');
            if (mlParamsStr) {
                const mlParams = JSON.parse(mlParamsStr);
                const currentClimate = envState.climate || 'CHOPPY';
                buyThreshold = mlParams?.[poolType]?.[currentClimate]?.buyThreshold || mlParams?.buy_threshold || 70;
            }
        } catch(e) {
            console.warn(`⚠️ [Frontline] 讀取動態及格線失敗，使用預設值 70`);
        }

        console.log(`⚖️ [Final Verdict] ${symbol} 總分: ${finalScore} / 100 (及格線: ${buyThreshold})`);

        if (finalScore >= buyThreshold) {
            const lockKey = `buy_lock:${mint}`;
            const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 10, 'NX');
            if (acquired) {
                console.log(`🎯 [TRIGGER] 總分達標 (${finalScore} >= ${buyThreshold})！授權開火！`);
                
                let baseAmount = poolType === 'NEWBORN' ? 0.1 : 0.2; 
                try {
                    const { data: config } = await supabase.from('system_config').select('trade_amount_sol, trending_trade_amount_sol').eq('id', 1).single();
                    if (config) {
                        baseAmount = poolType === 'NEWBORN' ? config.trade_amount_sol : config.trending_trade_amount_sol;
                    }
                } catch(e){}
                
                const safeMultiplier = Math.max(0.5, Math.min(2.0, mlConfidenceMultiplier));
                const finalTradeAmountSol = parseFloat((baseAmount * safeMultiplier).toFixed(3));
                console.log(`💰 [Sizing] 基礎注碼: ${baseAmount} SOL, 乘數: x${safeMultiplier} -> 最終下單: ${finalTradeAmountSol} SOL`);

                await executeBuy(
                    mint, symbol, poolType, finalScore, 
                    `🤖 三權決策 (Q:${quantScore} + M:${mlScore} + L:${llmScore}) | LLM: ${llmReason}`, 
                    finalTradeAmountSol, marketData, envState, appliedMlStrategyId, safeMultiplier
                );
            }
        } else {
            console.log(`🚫 [AUTO VETO] 分數不達標 (${finalScore} < ${buyThreshold})，拒絕買入。`);
            
            if (finalScore >= (buyThreshold - 5)) {
                const { data: config } = await supabase.from('system_config').select('trade_mode').eq('id', 1).single();
                if (config && config.trade_mode !== 'LIVE') {
                     console.log(`👻 [Shadow] ${symbol} 分數邊緣 (${finalScore})，收入 Shadow 觀察池供 ML 學習。`);
                     await supabase.from('active_positions_shadow').insert({
                         mint_address: mint,
                         token_symbol: symbol,
                         entry_price_sol: marketData.p,
                         highest_price_sol: marketData.p,
                         quantity: 1,
                         strategy_type: poolType + '_SHADOW',
                         ai_reason: llmReason,
                         ai_score: finalScore,
                         entry_liquidity_usd: marketData.l,
                         entry_volume_5m_usd: marketData.v,
                         entry_ofi: marketData.b && marketData.s ? (marketData.b - marketData.s) / (marketData.b + marketData.s) : 0,
                         market_climate: envState.climate
                     });
                }
            }
        }

    } catch (err) {
        const symbol = symbol_cache.get(mint) || 'UNKNOWN';
        console.error(`❌ [Routing Error] 決策漏斗處理 ${symbol} (${mint}) 時發生崩潰:`, err.message);
    }
}

burnSub.subscribe('lp_burn_alerts');
burnSub.on('message', async (channel, message) => {
    if (channel === 'lp_burn_alerts') {
        try {
            const { mint } = JSON.parse(message);
            const marketData = latest_market_data.get(mint);
            const symbol = symbol_cache.get(mint) || 'UNKNOWN';
            
            if (marketData && marketData.l > 5000) {
                const removed = await redisClient.zrem('v9_nursery_queue', mint);
                if (removed) {
                    console.log(`🔥 [Interrupt] 接收到 LP Burn 越獄訊號！立刻將 ${symbol} 押送至決策漏斗！`);
                    setImmediate(() => processAsymmetricRouting(mint, 'NEWBORN'));
                }
            }
        } catch (e) {}
    }
});

async function bootstrap() {
    console.log("🚀 SOL QUANT HUNTER_FRONTLINE V10.22 (三權分立 AI 天網) 啟動中...");
    
    await initPortfolio();
    
    redisClient.get('cache:ml_compiled_rule_string').then(str => {
        if (str) ml_compiled_rule_func = new Function('data', str);
    }).catch(()=>{});

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`🌐 [Frontline] Webhook 閘口開啟，Port ${PORT} (1ms 防堵塞機制啟動)`);
    });
    sourceAggregator.start();
}

bootstrap();