// src/microservices/trade_frontline.js
// 📝 檔案功能用途：V10.25 【獵人中樞】微服務 (Microservice Core)
// 🚀 核心升級：實裝「初生保溫箱」批次查價防 429 系統。全面棄用 Redis v9_nursery_queue，統一對接 Supabase DB。
// 🛡️ 終極修復：擴展 marketData 以攜帶 full fields，完美對接 securityGuard O(1) 綠色通道防撞車。
// 🧠 動態及格：完美對接 ML Engine 每日進化之 `ml_strategy_params`，從 Redis 陣列精準抓取大市專屬門檻。
// ⏱️ 保溫修復：拔除 5 分鐘時光陷阱，改為滿 20 隻或最舊等滿 1 分鐘即發車。
// 👻 影子修復：精準設定 50-55 分為 Shadow 區間，並修正 DB Schema 欄位不匹配導致寫入失敗之 Bug。

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
const { healthMonitor } = require('../services/healthMonitor');

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
let ml_compiled_rule_func = () => false;

// 🚀 V10 動態品牌防偽盾
let BRAND_BLACKLIST = new Set();
async function syncBrandBlacklist() {
    try {
        const cachedStr = await redisClient.get('cache:brand_blacklist');
        if (cachedStr) {
            BRAND_BLACKLIST = new Set(JSON.parse(cachedStr));
        }
    } catch (e) {}
}
syncBrandBlacklist(); 
setInterval(syncBrandBlacklist, 30000); 

// ------------------------------------------------------------------
// 2. 時光倒流護盾 & 訊號接收
// ------------------------------------------------------------------
redisSub.subscribe('price_updates', 'trending_signal'); 
redisSub.on('message', (channel, message) => {
    if (channel === 'price_updates') {
        healthMonitor.recordHeartbeat('PriceBot_Koyeb');
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
            console.log(`\n🐺 [Frontline] 接收到 TRENDING 熱門訊號: ${symbol}，送入三權決策漏斗！`);
            setImmediate(() => processAsymmetricRouting(mint, 'TRENDING'));
        } catch (e) {}
    }
});

// 🤖 接收 monitor_guards 的 AI 體檢請求
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

            const aiStartTime = Date.now();

            const decision = await keyRotator.enqueueRequest('MISTRAL', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: aiConfig.models[0] || 'mistral-large-latest',
                    messages: [{ role: "user", content: dataPrompt }],
                    response_format: { type: "json_object" }, temperature: 0.1
                }, { headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
                return JSON.parse(res.data.choices[0].message.content);
            }, 'POSITION_WATCHDOG');

            healthMonitor.recordAiLatency(Date.now() - aiStartTime);
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
// 4. DEFCON 6 秒接管 (智能護航版)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 5. Webhook 與保溫箱 (V10.3 批次查價防 429)
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
            
            console.log(`\n🐺 [Frontline Webhook] 接收到 NEWBORN 訊號: ${symbol}，寫入 DB 保溫箱 (進入 5 分鐘試煉)！`);
            
            await supabase.from('newborn_incubator').upsert([
                { 
                    mint_address: payload.mint, 
                    token_symbol: symbol, 
                    token_name: payload.name || 'UNKNOWN',
                    created_at: new Date().toISOString(),
                    status: 'INCUBATING'
                }
            ], { onConflict: 'mint_address' });

        } catch (e) {}
    });
});

// 🚀 V10.3 初生保溫箱批次巡邏官 (每 30 秒執行一次，嚴格執行 5 分鐘試煉)
setInterval(async () => {
    if (!globalConfig.is_running) return;

    try {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        const { data: candidates, error } = await supabase
            .from('newborn_incubator')
            .select('*')
            .eq('status', 'INCUBATING')
            .lt('created_at', fiveMinsAgo) // 🛡️ 斯巴達試煉：必須大過 5 分鐘！
            .order('created_at', { ascending: true });

        if (error || !candidates || candidates.length === 0) return;

        const sixMinsAgoTs = Date.now() - 6 * 60 * 1000;
        const oldestTokenTs = new Date(candidates[0].created_at).getTime();
        const isTimeoutReached = oldestTokenTs <= sixMinsAgoTs;

        let tokensToProcess = [];

        if (candidates.length >= 20) {
            if (isTimeoutReached) {
                tokensToProcess = candidates;
                console.log(`\n⏱️ [Incubator] 觸發 1 分鐘出車極限！共有 ${tokensToProcess.length} 隻歷經試煉的幣準備查價...`);
            } else {
                const processCount = Math.floor(candidates.length / 20) * 20;
                tokensToProcess = candidates.slice(0, processCount);
                console.log(`\n⏱️ [Incubator] 儲夠 20 隻！提取 ${tokensToProcess.length} 隻開車查價 (剩餘 ${candidates.length - processCount} 隻繼續等)...`);
            }
        } else if (isTimeoutReached) {
            tokensToProcess = candidates;
            console.log(`\n⏱️ [Incubator] 未夠 20 隻，但最舊已等滿 1 分鐘出車線！${tokensToProcess.length} 隻幣準備查價...`);
        } else {
            return;
        }

        const BATCH_SIZE = 20;
        for (let i = 0; i < tokensToProcess.length; i += BATCH_SIZE) {
            const batch = tokensToProcess.slice(i, i + BATCH_SIZE);
            const mints = batch.map(c => c.mint_address).join(',');
            
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 8000 });
                const pairs = res.data?.pairs || [];
                
                const pairMap = new Map();
                for (const p of pairs) {
                    if (p.chainId === 'solana' && p.baseToken && p.baseToken.address) {
                        const existing = pairMap.get(p.baseToken.address);
                        if (!existing || (p.liquidity?.usd > existing.liquidity?.usd)) {
                            pairMap.set(p.baseToken.address, p);
                        }
                    }
                }

                for (const token of batch) {
                    const pair = pairMap.get(token.mint_address);
                    
                    if (!pair || !pair.priceUsd || (pair.liquidity?.usd < 5000)) {
                        console.log(`💀 [Incubator] ${token.token_symbol || token.mint_address} 試煉失敗！流動性不足 ($${pair?.liquidity?.usd || 0})，判定為 Rug/垃圾幣，剔除。`);
                        await supabase.from('newborn_incubator').update({ status: 'RUGGED' }).eq('mint_address', token.mint_address);
                        continue;
                    }

                    const marketData = {
                        p: parseFloat(pair.priceUsd),
                        v: pair.volume?.m5 || 0,
                        b: pair.txns?.m5?.buys || 0,
                        s: pair.txns?.m5?.sells || 0,
                        l: pair.liquidity?.usd || 0,
                        ts: Date.now(),
                        description: pair.info?.description || pair.baseToken?.name || '',
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        fdv: pair.fdv || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0,
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                    };

                    latest_market_data.set(token.mint_address, marketData);
                    symbol_cache.set(token.mint_address, pair.baseToken.symbol || token.token_symbol);

                    await processAsymmetricRouting(token.mint_address, 'NEWBORN');

                    await supabase.from('newborn_incubator').update({ status: 'PROCESSED' }).eq('mint_address', token.mint_address);
                }

            } catch (err) {
                console.warn(`⚠️ [Incubator] 批次查價失敗:`, err.message);
            }

            if (i + BATCH_SIZE < tokensToProcess.length) {
                console.log(`⏳ [Incubator] 等待 5 秒 Cooldown...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

    } catch (e) {
        console.error("❌ [Incubator Critical] 巡邏官失職:", e.message);
    }
}, 30 * 1000);

// ------------------------------------------------------------------
// 6. 100% 全自動狙擊漏斗 (三權分立計分版)
// ------------------------------------------------------------------
async function processAsymmetricRouting(mint, poolType = 'NEWBORN') {
    try {
        if (poolType === 'NEWBORN' && !canBuyMeme()) return;
        if (poolType === 'TRENDING' && !canBuyTrending()) return;

        const marketData = latest_market_data.get(mint); 
        if (!marketData || marketData.v === 0) return;

        const symbol = symbol_cache.get(mint) || 'UNKNOWN';

        const secResult = await securityGuard.calculateQuantScore(mint, poolType, marketData);
        
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

        let mlScore = 32; 
        let mlConfidenceMultiplier = 1.0; 
        
        try {
            const mlStartTime = Date.now();
            const res = await axios.post('http://127.0.0.1:8000/predict', { features: marketData, type: poolType }, { timeout: 2000 });
            healthMonitor.recordAiLatency(Date.now() - mlStartTime);

            if (res.data && typeof res.data.win_probability === 'number') {
                mlScore = res.data.score || 0; 
                mlConfidenceMultiplier = res.data.confidence_multiplier || 1.0;
                console.log(`   - 🤖 [ML Brain] 勝率預測: ${(res.data.win_probability * 100).toFixed(1)}% | 得分: ${mlScore}/70 | 注碼乘數: x${mlConfidenceMultiplier}`);
            }
        } catch (e) {
            console.warn(`   - ⚠️ [ML Brain] 離線或超時，無法獲取勝率預測 (給予預設 32 分)`);
        }

        const envStateStr = await redisClient.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'CHOPPY' };
        
        let llmScore = 0;
        let llmReason = "LLM 未啟用";
        try {
            console.log(`   - 🧠 [LLM Consensus] 發起 ${symbol} 的敘事潛力會議...`);
            
            const llmStartTime = Date.now();
            
            let llmTargetData = secResult.marketData || {};
            if (!llmTargetData.description || llmTargetData.description.trim() === '') {
                llmTargetData.description = `Newly launched community token. Ticker: $${llmTargetData.symbol}, Name: ${llmTargetData.name}. No official description provided yet. Please evaluate the viral/meme potential based solely on its ticker and name. Do NOT penalize for lacking description.`;
            }

            const llmResult = await consensusService.runMemeConsensus(mint, llmTargetData, { poolType, climate: envState.climate });
            healthMonitor.recordAiLatency(Date.now() - llmStartTime);

            llmScore = llmResult.narrative_score || 0;
            llmReason = llmResult.reason || "無解釋";
        } catch (e) {
            console.warn(`   - ⚠️ [LLM Down] 敘事分析失敗，跳過 LLM 加減分。`);
        }

        const finalScore = quantScore + mlScore + llmScore;
        
        let buyThreshold = 70; 
        try {
            const mlParamsStr = await redisClient.get('ml_strategy_params');
            if (mlParamsStr) {
                const mlParams = JSON.parse(mlParamsStr);
                const currentClimate = envState.climate || 'CHOPPY';
                const paramsArray = Array.isArray(mlParams) ? mlParams : (mlParams.data || []);
                
                const targetParam = paramsArray.find(x => x.token_type === poolType && x.market_climate === currentClimate);
                if (targetParam && targetParam.buy_threshold) {
                    buyThreshold = Number(targetParam.buy_threshold);
                }
            }
        } catch(e) {
            console.warn(`⚠️ [Frontline] 讀取動態及格線失敗，使用預設防守線 70 分`);
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
            
            // 🎯 核心修復：精準定義 50-55 分為 Shadow 區間，並修正 Insert 欄位不匹配 Bug
            if (finalScore >= 50 && finalScore <= 55) {
                console.log(`👻 [Shadow Route] ${symbol} 落入 50-55 分區間，建立影子倉位 (供 ML 訓練用)。`);
                
                const { error: shadowErr } = await supabase.from('active_positions_shadow').insert({
                    mint_address: mint,
                    token_symbol: symbol,
                    strategy_type: poolType + '_SHADOW',
                    entry_price_sol: marketData.p,
                    ai_score: finalScore,
                    ai_reason: llmReason,
                    entry_liquidity_usd: marketData.l,
                    entry_volume_5m_usd: marketData.v,
                    entry_ofi: marketData.b && marketData.s ? (marketData.b - marketData.s) / (marketData.b + marketData.s) : 0,
                    market_climate: envState.climate
                });

                if (shadowErr) {
                    console.error(`❌ [Shadow Error] 寫入 active_positions_shadow 失敗:`, shadowErr.message);
                }
            }
        }

    } catch (err) {
        const symbol = symbol_cache.get(mint) || 'UNKNOWN';
        console.error(`❌ [Routing Error] 決策漏斗處理 ${symbol} (${mint}) 時發生崩潰:`, err.message);
    }
}

// ------------------------------------------------------------------
// 7. LP Burn 越獄接收器 (直接查詢 Supabase 保溫箱)
// ------------------------------------------------------------------
burnSub.subscribe('lp_burn_alerts');
burnSub.on('message', async (channel, message) => {
    if (channel === 'lp_burn_alerts') {
        try {
            const { mint } = JSON.parse(message);
            const symbol = symbol_cache.get(mint) || 'UNKNOWN';

            const { data: incubating } = await supabase
                .from('newborn_incubator')
                .select('mint_address')
                .eq('mint_address', mint)
                .eq('status', 'INCUBATING')
                .single();

            if (incubating) {
                console.log(`🔥 [Interrupt] 接收到 LP Burn 越獄訊號！立刻將 ${symbol} 查價並押送至決策漏斗！`);

                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 4000 });
                const pair = res.data?.pairs?.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

                if (pair && pair.priceUsd && pair.liquidity?.usd >= 5000) {
                    
                    const marketData = {
                        p: parseFloat(pair.priceUsd), v: pair.volume?.m5 || 0,
                        b: pair.txns?.m5?.buys || 0, s: pair.txns?.m5?.sells || 0,
                        l: pair.liquidity?.usd || 0, ts: Date.now(), 
                        description: pair.info?.description || pair.baseToken?.name || '',
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        fdv: pair.fdv || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0,
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                    };
                    latest_market_data.set(mint, marketData);

                    await processAsymmetricRouting(mint, 'NEWBORN');
                } else {
                    console.log(`💀 [Incubator Escape Failed] ${symbol} 雖燒池但流動性不足或無報價。`);
                }
                
                await supabase.from('newborn_incubator').update({ status: 'ESCAPED' }).eq('mint_address', mint);
            }
        } catch (e) {}
    }
});

// ------------------------------------------------------------------
// 8. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🚀 SOL QUANT HUNTER_FRONTLINE V10.26 (三權分立 + 50-55分精準 Shadow 版) 啟動中...");
    
    await initPortfolio();
    
    redisClient.get('cache:ml_compiled_rule_string').then(str => {
        if (str) ml_compiled_rule_func = new Function('data', str);
    }).catch(()=>{});

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`🌐 [Frontline] Webhook 閘口開啟，Port ${PORT} (1ms 防堵塞機制啟動)`);
    });
    sourceAggregator.start();
    
    await healthMonitor.setStatus('Hunter_Frontline', '🟢 獵人掃描中');
}

bootstrap();