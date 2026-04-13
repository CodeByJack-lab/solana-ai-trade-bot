// src/microservices/trade_frontline.js
// 📝 檔案功能用途：V10.21 【獵人中樞】微服務 (Microservice Core)
// 🚀 核心升級：實裝「三權分立」計分法 (Quant20+ML60+LLM20)、解決及格線 JSON 路徑導致的 Logic Choke。

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

// ------------------------------------------------------------------
// 1. 初始化與全域防禦變數
// ------------------------------------------------------------------
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

// 🛡️ Layer 1：實體巨頭與大廠品牌黑名單 (極端明顯的山寨名單，隱晦的山寨交由 LLM 處理)
const BRAND_BLACKLIST = new Set([
    'OPENAI', 'CHATGPT', 'SORA', 'CLAUDE', 'GEMINI', 'NVIDIA', 'APPLE', 'META', 'GOOGLE', 'MICROSOFT', 'AMAZON', 'TSMC', 'AMD', 'INTEL', 'GROK', 'ELON', 'MUSK', 'TRUMP', 'BIDEN', 'OBAMA', 'PUTIN', 'ZELENSKY', 'TATE', 'MRBEAST', 'BLACKROCK', 'VANGUARD', 'FIDELITY', 'SEC', 'FED', 'JPMORGAN', 'OIL', 'PETROL', 'GAS', 'GOLD', 'SILVER', 'GTA', 'ROBLOX', 'RBX', 'NINTENDO', 'DISNEY', 'POKEMON', 'PEPE', 'DOGE', 'SHIB', 'MAGA', 'WIF', 'BOME', 'BONK', 'SLERF', 'POPCAT', 'BINANCE', 'COINBASE', 'KRAKEN', 'FTX', 'ALAMEDA', 'TETHER', 'CIRCLE', 'ZARA'
]);

// ------------------------------------------------------------------
// 2. 時光倒流護盾 & 訊號接收
// ------------------------------------------------------------------
redisSub.subscribe('price_updates', 'trending_signal');

redisSub.on('message', async (channel, message) => {
    if (channel === 'price_updates') {
        try {
            const payload = JSON.parse(message);
            for (const [mint, data] of Object.entries(payload)) {
                if (data.ts <= (last_valid_ts.get(mint) || 0)) continue;
                last_valid_ts.set(mint, data.ts);
                latest_market_data.set(mint, data);
            }
        } catch (e) {}
    } else if (channel === 'trending_signal') {
        try {
            const { mint, symbol } = JSON.parse(message);
            if (mint) {
                symbol_cache.set(mint, symbol || 'UNKNOWN');
                await processAsymmetricRouting(mint, 'TRENDING');
            }
        } catch (e) {}
    }
});

// 🤖 接收 monitor_guards 的 AI 體檢請求 (Event-Driven Watchdog)
watchdogSub.subscribe('watchdog_alerts');
watchdogSub.on('message', async (channel, message) => {
    if (channel === 'watchdog_alerts') {
        try {
            const { mint, symbol, pnl, cvd, vwap_dev, volatility, climate } = JSON.parse(message);
            console.log(`🕵️‍♂️ [Watchdog] 接收到 ${symbol} 階梯體檢請求 (+${pnl.toFixed(1)}%)，呼叫 LLM 評估...`);
            
            const portfolio = getPortfolio();
            const pos = portfolio.positions.find(p => p.mint_address === mint);
            if (!pos) return;

            const decision = await consensusService.runWatchdogConsensus(mint, symbol, pnl, cvd, vwap_dev, volatility, climate);
            
            if (decision.action === 'SELL' || decision.action === 'SELL_HALF') {
                const lockKey = `sell_lock:${mint}`;
                const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                if (acquired) {
                    const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
                    const sellFraction = decision.action === 'SELL_HALF' ? 0.5 : 1.0;
                    console.log(`🎯 [Watchdog] 裁決：${decision.reason}`);
                    await runSellPipeline(pos, currentPrice, decision.reason, sellFraction)
                        .finally(() => redisClient.del(lockKey));
                }
            } else {
                console.log(`💎 [Watchdog] 裁決：繼續持有 (Hold)`);
            }
        } catch (e) {
            console.error('❌ [Watchdog] 體檢失敗:', e.message);
        }
    }
});

// ------------------------------------------------------------------
// 3. 🚨 OOM 防禦：記憶體清道夫
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
// 4. 定期同步全域狀態
// ------------------------------------------------------------------
setInterval(async () => {
    try {
        const { data, error } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
        if (!error && data) {
            globalConfig.is_running = data.is_running;
        }
    } catch (e) {}
}, 5000);

function runLayer1PhysicalFilter(symbol) {
    if (!symbol) return false;
    const upperSymbol = symbol.toUpperCase();
    if (/[^\x00-\x7F]/.test(upperSymbol)) return false; 
    if (BRAND_BLACKLIST.has(upperSymbol)) return false; 
    return true;
}

// ------------------------------------------------------------------
// 5. Webhook 與保溫箱 (NEWBORN)
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
            // 放入 NEWBORN 保溫箱 (延遲 5 分鐘出池)
            await redisClient.zadd('v9_nursery_queue', Date.now(), payload.mint);
        } catch (e) {}
    });
});

setInterval(async () => {
    if (!globalConfig.is_running) return;
    try {
        const now = Date.now();
        // 取出 5 分鐘前進入保溫箱的幣
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

// ------------------------------------------------------------------
// 6. 100% 全自動狙擊漏斗 (三權分立計分版)
// ------------------------------------------------------------------
async function processAsymmetricRouting(mint, poolType = 'NEWBORN') {
    if (!globalConfig.is_running) return;
    try {
        if (poolType === 'NEWBORN' && !canBuyMeme()) return;
        if (poolType === 'TRENDING' && !canBuyTrending()) return;

        const isBlacklisted = await redisClient.get(`scam_blacklist:${mint}`);
        if (isBlacklisted) return;

        const marketData = latest_market_data.get(mint);
        if (!marketData || !marketData.p || !marketData.v) return;

        const symbol = symbol_cache.get(mint) || 'UNKNOWN';
        const envStr = await redisClient.get('global_env_state');
        const envState = envStr ? JSON.parse(envStr) : { climate: 'CHOPPY', newsScore: 0 };

        console.log(`\n🐺 [Frontline] 接收到 ${poolType} 藍籌訊號: ${symbol}，送入三權決策漏斗！`);

        // 🚀 1. 物理安全過濾器 (Quant: 滿分 20)
        let quantScore = 10; 
        const { isSafe, reason, penalty } = await securityGuard.runFullCheck(mint, marketData, poolType);
        
        if (!isSafe) {
            console.log(`🗑️ [OFI Guard] 空軍壓境！${symbol} OFI/成交量極差 (${reason})，踢出保溫箱！`);
            await redisClient.set(`scam_blacklist:${mint}`, 'TRUE', 'EX', 3600); 
            return;
        }
        quantScore -= penalty; 
        console.log(`   - 🛡️ [Quant] 基礎物理審核通過，得分: ${quantScore}/20`);

        // 🚀 2. Python 隨機森林勝率預測 (ML: 滿分 60)
        let mlScore = 0;
        let mlConfidenceMultiplier = 1.0;
        try {
            const pyRes = await axios.post('http://127.0.0.1:8000/predict', {
                features: marketData,
                type: poolType
            }, { timeout: 1500 });
            
            if (pyRes.data) {
                mlScore = pyRes.data.score || 0; 
                mlConfidenceMultiplier = pyRes.data.confidence_multiplier || 1.0;
                console.log(`   - 🤖 [ML Brain] 勝率預測: ${(pyRes.data.win_probability * 100).toFixed(1)}% | 得分: ${mlScore}/60 | 注碼乘數: x${mlConfidenceMultiplier}`);
            }
        } catch (e) {
            console.warn(`   - ⚠️ [ML Brain] 離線或超時，無法獲取勝率預測 (給予預設 30 分)`);
            mlScore = 30;
        }

        // 🚀 3. LLM 敘事潛力共識 (Narrative: 滿分 20)
        console.log(`   - 🧠 [LLM Consensus] 發起 ${symbol} 的敘事潛力會議...`);
        const { narrativeScore, ai_reason } = await consensusService.runMemeConsensus(mint, symbol, poolType);
        console.log(`   - 🗣️ [LLM Consensus] 敘事得分: ${narrativeScore}/20 | 簡評: ${ai_reason}`);

        // 🚀 4. 全自動發射決策 (三權結算)
        const finalScore = quantScore + mlScore + narrativeScore;
        
        // 🚨 FIX: 精準讀取對應幣種 (poolType) 與大市氣候 (climate) 的專屬及格線
        let buyThreshold = 70; // 預設安全底線
        try {
            const mlParamsStr = await redisClient.get('ml_strategy_params');
            if (mlParamsStr) {
                const mlParams = JSON.parse(mlParamsStr);
                const currentClimate = envState.climate || 'CHOPPY';
                
                // 深入 JSON 結構讀取 (例如: mlParams["NEWBORN"]["CHOPPY"].buyThreshold)
                buyThreshold = mlParams?.[poolType]?.[currentClimate]?.buyThreshold 
                            || mlParams?.buy_threshold 
                            || 70;
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
                
                // 套用 ML 動態注碼乘數
                let baseAmount = poolType === 'NEWBORN' ? 0.1 : 0.2; 
                try {
                    const { data: config } = await supabase.from('system_config').select('trade_amount_sol, trending_trade_amount_sol').eq('id', 1).single();
                    if (config) {
                        baseAmount = poolType === 'NEWBORN' ? config.trade_amount_sol : config.trending_trade_amount_sol;
                    }
                } catch(e){}
                
                const finalAmount = parseFloat((baseAmount * mlConfidenceMultiplier).toFixed(3));
                console.log(`💰 [Sizing] 基礎注碼: ${baseAmount} SOL, 乘數: x${mlConfidenceMultiplier} -> 最終下單: ${finalAmount} SOL`);

                await executeBuy(mint, marketData.p, finalAmount, poolType, ai_reason, finalScore);
            }
        } else {
            console.log(`🚫 [AUTO VETO] 分數不達標 (${finalScore} < ${buyThreshold})，拒絕買入。`);
            
            // 將邊緣幣 (60分以上但未達及格線) 放入 Shadow 追蹤，供未來 ML 訓練
            if (finalScore >= 60) {
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
                         ai_reason: ai_reason,
                         ai_score: finalScore,
                         entry_liquidity_usd: marketData.l,
                         entry_volume_5m_usd: marketData.v,
                         entry_ofi: marketData.b && marketData.s ? (marketData.b - marketData.s) / (marketData.b + marketData.s) : 0,
                         market_climate: envState.climate
                     });
                }
            }
        }

    } catch (e) {
        console.error(`❌ [Frontline] 漏斗處理 ${mint} 失敗:`, e.message);
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
            
            if (marketData && globalConfig.is_running) {
                console.log(`🔥 [Burn Sub] 接收到 ${symbol} 燒池訊號！觸發特快通道！`);
                await processAsymmetricRouting(mint, 'NEWBORN');
            }
        } catch(e) {}
    }
});

// ------------------------------------------------------------------
// 8. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🚀 SOL QUANT HUNTER_FRONTLINE V10.21 (三權分立 AI 天網) 啟動中...");
    await initPortfolio();
    
    app.listen(8080, '0.0.0.0', () => {
        console.log("🌐 [Frontline] Webhook 閘口開啟，Port 8080 (1ms 防堵塞機制啟動)");
    });
}

bootstrap();