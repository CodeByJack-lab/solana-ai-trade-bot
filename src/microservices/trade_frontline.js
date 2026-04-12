// src/microservices/trade_frontline.js
// 📝 檔案功能用途：V10 【獵人中樞】微服務 (Microservice Core)
// 🚀 核心升級：100% 全自動狙擊、大市氣候完美接軌 AI、15% 溢價護盾、Event Loop 防阻塞、ML 毒藥收集器。

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios'); // 🎯 補回 axios 供 Python ML 呼叫
const { createClient } = require('@supabase/supabase-js'); // 🎯 新增 Supabase 供毒藥收集器使用

// 載入 V10 底層模組
const { getPortfolio, initPortfolio, canBuyMeme, canBuyTrending } = require('../services/portfolioService'); 
const { securityGuard } = require('../services/securityGuard'); 
const { consensusService } = require('../services/consensusService'); 
const { executeBuy, runSellPipeline } = require('../services/tradeService'); // 🎯 補回 runSellPipeline 供 Watchdog 使用
const { sendTelegramAlert, processTelegramCallback } = require('../services/telegramService'); 
const { getJupiterFinalQuote } = require('../services/tradeService');
const { sourceAggregator } = require('../services/sourceAggregator'); 
const { walletMonitorRouter } = require('../services/walletMonitor'); 
const { keyRotator } = require('../services/keyRotator'); // 🎯 補回 keyRotator 供 Mistral 使用
const { cacheManager } = require('../services/cacheManager'); // 🎯 補回 cacheManager

// ------------------------------------------------------------------
// 1. 初始化與全域防禦變數
// ------------------------------------------------------------------
const app = express();
app.use(express.json());

// 🎯 掛載 Alchemy 錢包監聽 Router (保留！)
app.use('/', walletMonitorRouter);

const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const burnSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const watchdogSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379'); // 🎯 Watchdog 廣播

// 🎯 初始化 Supabase 客戶端 (供毒藥收集器寫入負樣本使用)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let globalConfig = { is_running: true };

const last_valid_ts = new Map();
const latest_market_data = new Map();
const symbol_cache = new Map(); 
let ml_compiled_rule_func = () => false; 

// 🛡️ Layer 1：實體巨頭與大廠品牌黑名單 (保留！)
const BRAND_BLACKLIST = new Set([
    'OPENAI', 'CHATGPT', 'SORA', 'CLAUDE', 'GEMINI', 'NVIDIA', 'APPLE', 'META', 'GOOGLE', 'MICROSOFT', 'AMAZON', 'TSMC', 'AMD', 'INTEL',
    'GROK', 'ELON', 'MUSK', 'TRUMP', 'BIDEN', 'OBAMA', 'PUTIN', 'ZELENSKY', 'TATE', 'MRBEAST',
    'BLACKROCK', 'VANGUARD', 'FIDELITY', 'SEC', 'FED', 'JPMORGAN', 'OIL', 'PETROL', 'GAS', 'GOLD', 'SILVER',
    'GTA', 'ROBLOX', 'RBX', 'NINTENDO', 'DISNEY', 'POKEMON',
    'PEPE', 'DOGE', 'SHIB', 'MAGA', 'WIF', 'BOME', 'BONK', 'SLERF', 'POPCAT',
    'BINANCE', 'COINBASE', 'KRAKEN', 'FTX', 'ALAMEDA', 'TETHER', 'CIRCLE', 'ZARA'
]);

// ------------------------------------------------------------------
// 2. 時光倒流護盾 & 訊號接收
// ------------------------------------------------------------------
redisSub.subscribe('price_updates', 'trending_signal'); // 🎯 補回 trending_signal
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
    
    // 🎯 接聽藍籌訊號
    if (channel === 'trending_signal') {
        try {
            const { mint, symbol } = JSON.parse(message);
            symbol_cache.set(mint, symbol);
            console.log(`🐺 [Frontline] 接收到 Trending 藍籌訊號: ${symbol}，送入決策漏斗！`);
            setImmediate(() => processAsymmetricRouting(mint, 'TRENDING'));
        } catch (e) {}
    }
});

// 🤖 接收 monitor_guards 的 AI 體檢請求 (Event-Driven Watchdog)
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

// ------------------------------------------------------------------
// 3. 🚨 OOM 防禦：記憶體清道夫 (保留！)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 4. DEFCON 6 秒接管 (智能護航版)
// ------------------------------------------------------------------
setInterval(async () => {
    if (!globalConfig.is_running) return;
    
    const portfolio = getPortfolio();
    const activeMints = portfolio.positions?.map(p => p.mint_address) || [];
    
    // 🎯 條件 1：手頭上冇倉位 -> 系統處於「空倉掛機」狀態，絕對唔會判定為斷氣
    if (activeMints.length === 0) return;

    const now = Date.now();
    let deadMints = []; // 紀錄邊幾隻幣真係斷咗氣

    // 🎯 條件 2：檢查手上「每一隻」倉位嘅最後報價時間
    for (const mint of activeMints) {
        const lastTs = last_valid_ts.get(mint) || 0;
        // 如果超過 6 秒 (6000ms) 冇更新，或者根本從來未收過報價 (lastTs = 0)
        if (now - lastTs > 6000) { 
            deadMints.push(mint);
        }
    }

    // 🎯 條件 3：有倉位 + 發現有幣斷氣超過 6 秒 -> 啟動 Jupiter 救援
    if (deadMints.length > 0) {
        console.warn(`🚨 [DEFCON 6] Koyeb 查價中斷！有 ${deadMints.length} 隻持倉幣超過 6 秒無報價，啟動 Jupiter 救援！`);
        
        try {
            // 淨係查斷氣嗰啲幣同 SOL 嘅美金價，慳 API Quota
            const jupMints = [...deadMints, 'So11111111111111111111111111111111111111112'];
            const res = await axios.get(`https://api.jup.ag/price/v3?ids=${jupMints.join(',')}`, { timeout: 3000 });
            
            const solUsd = parseFloat(res.data?.data?.['So11111111111111111111111111111111111111112']?.price || '1');
            const fallbackPayload = {};
            const ts = Date.now();
            
            deadMints.forEach(m => {
                if (res.data?.data?.[m]?.price) {
                    // 將 Jupiter 嘅純價格轉化為系統需要嘅格式
                    fallbackPayload[m] = { p: parseFloat(res.data.data[m].price) / solUsd, v: 0, b: 0, s: 0, l: 0, ts: ts };
                    last_valid_ts.set(m, ts); // 更新時間戳，等佢下個 4 秒唔會再叫救命
                    latest_market_data.set(m, fallbackPayload[m]); 
                }
            });
            
            // 將救援報價廣播出去，等 Watchdog 繼續運作
            if (Object.keys(fallbackPayload).length > 0) {
                await redisClient.publish('price_updates', JSON.stringify(fallbackPayload));
                // console.log(`🚑 [Jupiter Rescue] 成功為 ${Object.keys(fallbackPayload).length} 隻代幣注入救援報價！`); // 隱藏以免洗版
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

// ------------------------------------------------------------------
// 5. Webhook 與保溫箱 (加入併發限流)
// ------------------------------------------------------------------
app.post('/webhook/radar', (req, res) => {
    res.status(200).send('OK'); 
    setImmediate(async () => {
        try {
            const payload = req.body[0] || req.body;
            if (!payload || !payload.mint) return;
            const symbol = payload.symbol || 'UNKNOWN';
            if (!runLayer1PhysicalFilter(symbol)) return; 
            symbol_cache.set(payload.mint, symbol);
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
            // 🛡️ RPC 併發限流：加入 await 與 delay
            for (const mint of ripeTokens) {
                await processAsymmetricRouting(mint, 'NEWBORN');
                await new Promise(r => setTimeout(r, 1000)); 
            }
        }
    } catch (e) {}
}, 10000);

// ------------------------------------------------------------------
// 6. 100% 全自動狙擊漏斗 (加入高級 Rug Pull 毒藥收集器)
// ------------------------------------------------------------------
async function processAsymmetricRouting(mint, poolType = 'NEWBORN') {
    try {
        if (poolType === 'NEWBORN' && !canBuyMeme()) return;
        if (poolType === 'TRENDING' && !canBuyTrending()) return;

        const marketData = latest_market_data.get(mint); 
        if (!marketData || marketData.v === 0) return;

        const symbol = symbol_cache.get(mint) || 'UNKNOWN';

        // 1. 量化基準分 (V9 靈魂)
        const secResult = await securityGuard.calculateQuantScore(mint, poolType);
        if (!secResult.isSafe) {
            console.log(`🛑 [Quant Reject] ${symbol} 未達基準: ${secResult.reason}`);
            
            // 🎯 毒藥收集器：專門捕捉 Rug Pull / 貔貅陷阱 (高流動性誘餌 + 致命合約/籌碼缺憾)
            const isRugTrap = marketData.l > 10000 && (
                secResult.reason.includes('合約高危') || 
                secResult.reason.includes('籌碼過度集中') || 
                secResult.reason.includes('貔貅攔截')
            );

            // 如果係高級陷阱，我哋抽樣寫入 ML Database，教 Python 認住呢種特徵！
            if (isRugTrap) {
                // 🎲 20% 隨機抽樣，避免 Database 爆炸及 ML 樣本過度失衡
                if (Math.random() < 0.20) {
                    console.log(`☠️ [Poison Data] 捕獲高級 Rug Pull 陷阱 (${symbol})！作為負樣本寫入 ML 數據庫...`);
                    const totalTxs = marketData.b + marketData.s;
                    const ofi = totalTxs > 0 ? (marketData.b - marketData.s) / totalTxs : 0;
                    
                    // 背景靜默寫入，不阻塞主線程
                    supabase.from('trade_patterns').insert([{
                        mint_address: mint,
                        token_symbol: symbol,
                        entry_price_sol: marketData.p || 0,
                        entry_ofi: ofi,
                        entry_liquidity_usd: marketData.l,
                        entry_volume_5m: marketData.v,
                        realized_pnl_pct: -100.00, // 🩸 標記為絕對死局 (秒 Rug)
                        trade_type: 'ML_NEGATIVE_SAMPLE',
                        action: 'LIQUIDATED'
                    }]).then(({error}) => {
                        if (error) console.error(`❌ [Poison Data] 寫入負樣本失敗:`, error.message);
                    });
                }
            }
            return;
        }

        // 2. Python ML 推論
        let mlScore = 50;
        try {
            const res = await axios.post('http://127.0.0.1:8000/predict', { features: marketData }, { timeout: 2000 });
            mlScore = res.data.score || 50;
        } catch (e) {
            console.warn(`⚠️ [ML Down] 無法連接 Python 智腦，使用基準分。`);
        }

        // 3. GROQ 語意審批
        const envStateStr = await redisClient.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'CHOPPY' };
        
        const llmResult = await consensusService.runMemeConsensus(mint, marketData, { 
            baseScore: secResult.numeric_score, poolType, climate: envState.climate 
        });

        if (!llmResult.buy) {
            console.log(`🛑 [GROQ VETO] ${symbol} 被 AI 否決: ${llmResult.reason}`);
            return;
        }

        // 🚀 4. 全自動發射 (廢除 TG 手動按鈕)
        const finalScore = Math.floor((mlScore + llmResult.score) / 2);
        
        // 讀取動態 buy_score_threshold (預設 70)
        let buyThreshold = 70;
        const baselineStr = await redisClient.get("cache:14d_baseline_model");
        if (baselineStr) {
            try { buyThreshold = JSON.parse(baselineStr).buy_threshold || 70; } catch(e){}
        }

        if (finalScore >= buyThreshold) {
            console.log(`🔥 [AUTO SNIPER] ${symbol} 突破重圍！綜合得分: ${finalScore}，1 毫秒內執行買入！`);
            const tradeAmountSol = parseFloat(process.env.DEFAULT_TRADE_AMOUNT_SOL || '0.1');
            await executeBuy(mint, symbol, poolType, finalScore, `🤖 全自動狙擊 (量化+ML+GROQ綜合: ${finalScore})`, tradeAmountSol, marketData, envState);
        } else {
            console.log(`🛑 [AUTO VETO] ${symbol} 綜合得分 ${finalScore} 未達動態門檻 ${buyThreshold}。`);
        }

    } catch (err) {
        // 🎯 致命 Bug 修復：強化錯誤輸出，避免死機而無聲無息
        const symbol = symbol_cache.get(mint) || 'UNKNOWN';
        console.error(`❌ [Routing Error] 決策漏斗處理 ${symbol} (${mint}) 時發生崩潰:`, err.message);
        if (err.stack) console.error(err.stack);
    }
}

// ------------------------------------------------------------------
// 7. LP Burn 越獄接收器
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 8. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🚀 SOL QUANT HUNTER_FRONTLINE V10 (大數據統計防禦網) 啟動中...");
    
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