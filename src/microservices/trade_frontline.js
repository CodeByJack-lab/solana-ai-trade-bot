// src/microservices/trade_frontline.js
// 📝 檔案功能用途：V10.53 【獵人中樞】微服務 (幽靈殺手版)
// 🚀 核心升級：實裝「Ghost Buster 幽靈殺手」機制，DexScreener 救援前強制與 DB 對帳，徹底清除 RAM 殘留倉位！

require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 50; 

const express = require('express');
const Redis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js'); 

const { getPortfolio, initPortfolio, canBuyMeme, canBuyTrending } = require('../services/portfolioService');
const { securityGuard } = require('../services/securityGuard'); 
const { consensusService } = require('../services/consensusService'); 
const { executeBuy, runSellPipeline } = require('../services/tradeService');
const { sendTelegramAlert, processTelegramCallback } = require('../services/telegramService'); 
const { sourceAggregator } = require('../services/sourceAggregator');
const { walletMonitorRouter } = require('../services/walletMonitor'); 
const { keyRotator } = require('../services/keyRotator'); 
const { cacheManager } = require('../services/cacheManager');
const { healthMonitor } = require('../services/healthMonitor');

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

let BRAND_BLACKLIST = new Set();
async function syncBrandBlacklist() {
    try {
        const cachedStr = await redisClient.get('cache:brand_blacklist');
        if (cachedStr) BRAND_BLACKLIST = new Set(JSON.parse(cachedStr));
    } catch (e) {}
}
syncBrandBlacklist(); 
setInterval(syncBrandBlacklist, 30000); 

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
                const mistralUrl = Buffer.from('aHR0cHM6Ly9hcGkubWlzdHJhbC5haS92MS9jaGF0L2NvbXBsZXRpb25z', 'base64').toString('utf-8');
                
                const res = await axios.post(mistralUrl, {
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
                        const sold = await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, `🤖 AI 數據體檢: ${decision.thought_process}`, fraction);
                        
                        if (sold) {
                            if (fraction === 1.0) {
                                const idx = portfolio.positions.findIndex(p => p.mint_address === mint);
                                if (idx > -1) portfolio.positions.splice(idx, 1);
                            } else {
                                pos.quantity = pos.quantity * 0.5;
                                pos.strategy_type = pos.strategy_type + '_HALF_SOLD';
                            }
                        } else {
                            await redisClient.del(lockKey);
                        }
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

// 替換 trade_frontline.js 中的 DexScreener 救援輪詢 (大約在 Line 130-220 之間)
const token_strike_count = new Map(); 
const token_last_dex_check_ts = new Map(); 

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
            const lastDexCheck = token_last_dex_check_ts.get(mint) || 0;
            if (now - lastDexCheck >= 30000) {
                deadMints.push(mint);
            }
        } else {
            token_strike_count.delete(mint);
            token_last_dex_check_ts.delete(mint);
        }
    }

    if (deadMints.length > 0) {
        try {
            const currentMode = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const { data: realPositions, error } = await supabase
                .from(`active_positions_${currentMode}`)
                .select('mint_address')
                .in('mint_address', deadMints);
                
            if (!error) {
                const realMints = new Set(realPositions.map(p => p.mint_address));
                const trueDeadMints = [];
                
                for (const m of deadMints) {
                    if (!realMints.has(m)) {
                        console.log(`👻 [Ghost Buster] 發現幽靈倉位 ${symbol_cache.get(m) || m}！DB 已經平倉但 RAM 卡住，立即清除！`);
                        last_valid_ts.delete(m);
                        latest_market_data.delete(m);
                        symbol_cache.delete(m);
                        token_strike_count.delete(m);
                        token_last_dex_check_ts.delete(m);
                        
                        const idx = portfolio.positions.findIndex(p => p.mint_address === m);
                        if (idx > -1) portfolio.positions.splice(idx, 1);
                    } else {
                        trueDeadMints.push(m);
                    }
                }
                deadMints = trueDeadMints;
            }
        } catch (dbErr) {
            console.warn(`⚠️ [Ghost Buster] DB 校對失敗:`, dbErr.message);
        }

        if (deadMints.length === 0) return; 

        // 🚀 新增：清楚印出究竟係邊幾隻幣卡住咗！
        const deadSymbols = deadMints.map(m => symbol_cache.get(m) || `${m.slice(0,4)}...`).join(', ');

        if (deadMints.length === activeMints.length && activeMints.length > 1) {
            console.warn(`🚨 [DEFCON 6] 全線斷線！準備進行 DexScreener 救援查價... (冷卻期: 30s)`);
        } else {
            console.warn(`⚠️ [Price Warning] 發現 ${deadMints.length} 隻持倉幣 (${deadSymbols}) 超時無報價，啟動 DexScreener 獨立監視 (冷卻期: 30s)...`);
        }

        try {
            await redisClient.set('DEXSCREENER_LOCK', 'MAIN_BOT', 'EX', 10);

            for (const m of deadMints) {
                token_last_dex_check_ts.set(m, now);
            }

            const mintsStr = deadMints.slice(0, 30).join(',');
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintsStr}`, { timeout: 5000 });
            const pairs = res.data?.pairs || [];
            
            const priceMap = new Map();
            pairs.forEach(p => {
                if (p.chainId === 'solana') {
                    const mint = p.baseToken.address;
                    const liq = p.liquidity?.usd || 0;
                    const existing = priceMap.get(mint);
                    if (!existing || liq > existing.liq) {
                        priceMap.set(mint, { price: parseFloat(p.priceNative || '0'), liq: liq });
                    }
                }
            });

            const fallbackPayload = {};
            const ts = Date.now();
            
            for (const m of deadMints) {
                const dexData = priceMap.get(m);
                
                if (dexData && dexData.price > 0 && dexData.liq > 1000) {
                    fallbackPayload[m] = { p: dexData.price, v: 0, b: 0, s: 0, l: dexData.liq, ts: ts };
                    last_valid_ts.set(m, ts); 
                    latest_market_data.set(m, fallbackPayload[m]);
                    token_strike_count.delete(m); 
                } else {
                    const strikes = (token_strike_count.get(m) || 0) + 1;
                    token_strike_count.set(m, strikes);
                    
                    const sym = symbol_cache.get(m) || 'UNKNOWN';
                    console.log(`💀 [Rugpull Check] 幣種 ${sym} 第 ${strikes}/3 次 DexScreener 查價失敗或池已乾...`);

                    if (strikes >= 3) {
                        console.error(`💥 [RUGPULL DETECTED] ${sym} 連續 3 次失去報價或流動性歸零，判定為已撤池！執行緊急清倉！`);
                        
                        const pos = portfolio.positions.find(p => p.mint_address === m);
                        if (pos) {
                            const lockKey = `sell_lock:${m}`;
                            const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
                            if (acquired) {
                                const sold = await runSellPipeline(pos, 0.000000001, `🚨 徹底失去報價 (判定 Rugpull 撤池)`, 1.0);
                                
                                // 🚀 終極火化程序 (Forced Cremation)
                                if (!sold) {
                                    console.error(`🪦 [Forced Cremation] 由於流動性枯竭，${sym} 無法透過 Jupiter 賣出。執行強制火化，從 DB 中徹底抹除 (-100% 虧損)！`);
                                    const currentMode = portfolio.mode === 'LIVE' ? 'live' : 'paper';
                                    await supabase.from(`active_positions_${currentMode}`).delete().eq('mint_address', m);
                                    
                                    // 寫入虧損紀錄
                                    await supabase.from(`trade_history_${currentMode}`).insert([{
                                        mint_address: m, token_symbol: sym, action: 'LIQUIDATED',
                                        entry_price_sol: pos.entry_price_sol, exit_price_sol: 0,
                                        realized_pnl_pct: -100.0, reason: "🪦 徹底歸零，無法賣出強制火化"
                                    }]);
                                }

                                // 無論賣唔賣得出，都從 RAM 中踢走佢，解除無限 Loop
                                const idx = portfolio.positions.findIndex(p => p.mint_address === m);
                                if (idx > -1) portfolio.positions.splice(idx, 1);
                                await redisClient.del(lockKey);
                            }
                        }
                        token_strike_count.delete(m);
                        token_last_dex_check_ts.delete(m);
                    }
                }
            }
            
            if (Object.keys(fallbackPayload).length > 0) {
                await redisClient.publish('price_updates', JSON.stringify(fallbackPayload));
            }
        } catch (err) {
            console.error(`❌ [DexScreener Rescue] 救援 API 連線異常: ${err.message}`);
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
            
            console.log(`\n🐺 [Frontline Webhook] 接收到 NEWBORN 訊號: ${symbol}，寫入 DB 保溫箱 (進入 15 秒光速試煉)！`);
            
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

setInterval(async () => {
    if (!globalConfig.is_running) return;

    try {
        const incubationTimeAgo = new Date(Date.now() - 15 * 1000).toISOString();
        
        const { data: candidates, error } = await supabase
            .from('newborn_incubator')
            .select('*')
            .eq('status', 'INCUBATING')
            .lt('created_at', incubationTimeAgo)
            .order('created_at', { ascending: true });

        if (error || !candidates || candidates.length === 0) return;

        const hardTimeoutTs = Date.now() - 30 * 1000;
        const oldestTokenTs = new Date(candidates[0].created_at).getTime();
        const isTimeoutReached = oldestTokenTs <= hardTimeoutTs;

        let tokensToProcess = [];

        if (candidates.length >= 20) {
            if (isTimeoutReached) {
                tokensToProcess = candidates;
                console.log(`\n⏱️ [Incubator] 觸發 30 秒出車極限！共有 ${tokensToProcess.length} 隻歷經試煉的幣準備查價...`);
            } else {
                const processCount = Math.floor(candidates.length / 20) * 20;
                tokensToProcess = candidates.slice(0, processCount);
                console.log(`\n⏱️ [Incubator] 儲夠 20 隻！提取 ${tokensToProcess.length} 隻開車查價 (剩餘 ${candidates.length - processCount} 隻繼續等)...`);
            }
        } else if (isTimeoutReached) {
            tokensToProcess = candidates;
            console.log(`\n⏱️ [Incubator] 未夠 20 隻，但最舊已等滿 30 秒出車線！${tokensToProcess.length} 隻幣準備查價...`);
        } else {
            return;
        }

        const BATCH_SIZE = 20;
        for (let i = 0; i < tokensToProcess.length; i += BATCH_SIZE) {
            await redisClient.set('DEXSCREENER_LOCK', 'MAIN_BOT', 'EX', 10);

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
}, 10 * 1000); 

async function processAsymmetricRouting(mint, poolType = 'NEWBORN') {
    try {
        if (poolType === 'NEWBORN' && !canBuyMeme()) return;
        if (poolType === 'TRENDING' && !canBuyTrending()) return;

        const symbol = symbol_cache.get(mint) || 'UNKNOWN';

        const portfolio = getPortfolio();
        const isHoldingMain = portfolio.positions && portfolio.positions.some(p => p.mint_address === mint);
        
        if (isHoldingMain) {
            console.log(`⚠️ [Frontline] 發現已持有倉位 $${symbol}，停止重複掃描/買入。`);
            if (poolType === 'TRENDING') {
                await supabase.from('trending_pool').delete().eq('mint_address', mint);
            }
            return;
        }

        const marketData = latest_market_data.get(mint); 
        if (!marketData || marketData.v === 0) return;

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
                    mint_address: mint, token_symbol: symbol, entry_price_sol: marketData.p || 0,
                    entry_ofi: ofi, entry_liquidity_usd: marketData.l, entry_volume_5m: marketData.v, realized_pnl_pct: -100.00 
                }]).then(({ error }) => {
                    if (error) console.error(`❌ [Poison Data] 寫入失敗:`, error.message);
                });
            }
            return;
        }

        const quantScore = secResult.numeric_score; 
        const appliedMlStrategyId = secResult.applied_ml_strategy_id || 0;
        console.log(`   - 🛡️ [Quant] 基礎物理審核通過，得分: ${quantScore}/20`);

        let mlScore = 32; 
        let mlConfidenceMultiplier = 1.0; 
        let priorProb = 0.5; 
        
        try {
            const mlStartTime = Date.now();
            const res = await axios.post('http://127.0.0.1:8000/predict', { features: marketData, type: poolType }, { timeout: 2000 });
            healthMonitor.recordAiLatency(Date.now() - mlStartTime);

            if (res.data && typeof res.data.win_probability === 'number') {
                mlScore = res.data.score || 0; 
                priorProb = res.data.win_probability; 
                mlConfidenceMultiplier = res.data.confidence_multiplier || 1.0;
                console.log(`   - 🤖 [ML Brain] 勝率預測: ${(priorProb * 100).toFixed(1)}% | 得分: ${mlScore}/70`);
            }
        } catch (e) {
            console.warn(`   - ⚠️ [ML Brain] 離線或超時，無法獲取勝率預測 (給予預設 32 分)`);
        }

        const envStateStr = await redisClient.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'CHOPPY' };
        
        let llmScore = 0;
        let llmReason = "LLM 未啟用";
        let llmFailed = false;

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
            console.warn(`   - ⚠️ [LLM Down] 敘事分析失敗，觸發 LLM Hard-Fail 標記。`);
            llmFailed = true;
            llmReason = "LLM 資源池全線異常";
        }

        let maxPositions = poolType === 'NEWBORN' ? 4 : 8; 
        let currentMode = 'paper';
        let baseAmount = poolType === 'NEWBORN' ? 0.1 : 0.2; 
        let currentPositionsCount = 0;
        
        try {
            const { data: config } = await supabase.from('system_config')
                .select('trade_mode, trade_amount_sol, trending_trade_amount_sol, max_meme_positions, max_trending_positions')
                .eq('id', 1).single();
            if (config) {
                currentMode = config.trade_mode === 'LIVE' ? 'live' : 'paper';
                baseAmount = poolType === 'NEWBORN' ? config.trade_amount_sol : config.trending_trade_amount_sol;
                maxPositions = poolType === 'NEWBORN' ? config.max_meme_positions : config.max_trending_positions;
            }

            const { count } = await supabase.from(`active_positions_${currentMode}`)
                .select('*', { count: 'exact', head: true }).like('strategy_type', `${poolType}%`);
            if (count !== null) currentPositionsCount = count;
        } catch(e) {}
        
        const priorOdds = priorProb / (1 - priorProb);
        
        const bayesFactor = 0.2 + (1.8 / (1.0 + Math.exp(-0.6 * (llmScore - 3.5))));

        const posteriorOdds = priorOdds * bayesFactor;
        const finalWinProb = posteriorOdds / (1 + posteriorOdds); 
        
        let finalScore = Math.round(finalWinProb * 100);

        let kellyBRatio = 2.0; 
        try {
            const mlStr = await redisClient.get('cache:dynamic_scoring_model');
            if (mlStr) kellyBRatio = JSON.parse(mlStr).kelly_b_ratio || 2.0;
        } catch(e) {}

        const fStar = finalWinProb - ((1 - finalWinProb) / kellyBRatio);
        const safeKelly = Math.max(0, fStar * 0.25); 
        
        const standardPositionSize = 1.0 / (maxPositions > 0 ? maxPositions : 10);
        let kellyMultiplier = Math.max(0.1, Math.min(safeKelly / standardPositionSize, 3.0)); 

        let buyThreshold = 70; 
        let activeStrategyId = appliedMlStrategyId || 0; 
        
        let dynamicSL = -15.0; 
        let dynamicTP = 20.0;

        try {
            const mlParamsStr = await redisClient.get('ml_strategy_params');
            if (mlParamsStr) {
                const mlParams = JSON.parse(mlParamsStr);
                const currentClimate = envState.climate || 'CHOPPY';
                const paramsArray = Array.isArray(mlParams) ? mlParams : (mlParams.data || []);
                
                const targetParam = paramsArray.find(x => x.token_type === poolType && x.market_climate === currentClimate);
                if (targetParam) {
                    if (targetParam.buy_threshold) buyThreshold = Number(targetParam.buy_threshold);
                    if (targetParam.id) activeStrategyId = targetParam.id; 
                    if (targetParam.stop_loss_pct) dynamicSL = Number(targetParam.stop_loss_pct);
                    if (targetParam.trailing_tp_trigger) dynamicTP = Number(targetParam.trailing_tp_trigger);
                }
            }
        } catch(e) {
            console.warn(`⚠️ [Frontline] 讀取動態及格線失敗，使用預設防守線 70 分`);
        }

        if (llmFailed) {
            console.log(`🛑 [Hard-Fail 防禦] 偵測到 LLM 異常，強行將 Buy Threshold 從 ${buyThreshold} 提升至 999，阻截盲買風險！`);
            buyThreshold = 999;
        }

        if (!llmFailed && finalScore >= buyThreshold - 2 && finalScore < buyThreshold) {
            if (llmScore >= 3) {
                console.log(`✨ [Narrative Override] 差少少及格 (${finalScore}/${buyThreshold})，但 LLM 敘事極度睇好 (${llmScore}分)，觸發特赦 +3 分！`);
                finalScore += 3;
                llmReason += " [✨敘事特赦+3保送]";
            }
        }

        console.log(`⚖️ [Final Verdict] ${symbol} 貝葉斯最終分: ${finalScore} / 100 (及格線: ${buyThreshold})`);

        if (finalScore >= buyThreshold) {
            if (currentPositionsCount >= maxPositions) {
                console.log(`🛑 [Capacity Full] ${poolType} 倉位已滿 (${currentPositionsCount}/${maxPositions})，放棄買入 ${symbol}。`);
                return; 
            }

            const lockKey = `buy_lock:${mint}`;
            const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 10, 'NX');
            if (acquired) {
                const inflightKey = `inflight_buy_${poolType}_${currentMode}`;
                const inflightCount = await redisClient.incr(inflightKey);
                await redisClient.expire(inflightKey, 10); 

                if ((currentPositionsCount + inflightCount - 1) >= maxPositions) {
                    console.log(`🚦 [Concurrency Block] 併發買單過多，${poolType} 倉位即將爆滿，攔截買入 ${symbol}。`);
                    return;
                }

                const finalTradeAmountSol = parseFloat((baseAmount * kellyMultiplier).toFixed(3));
                
                if (finalTradeAmountSol < 0.01) {
                    console.log(`🛑 [Kelly Reject] 凱利公式建議注碼極低 (${finalTradeAmountSol} SOL)，強行放棄交易！`);
                    return;
                }

                console.log(`🎯 [TRIGGER] 總分達標！授權開火！(Kelly倍數: ${kellyMultiplier.toFixed(2)}x, 總額: ${finalTradeAmountSol} SOL)`);
                
                const success = await executeBuy(
                    mint, symbol, poolType, finalScore, 
                    `🤖 貝葉斯決策 (Q:${quantScore} + M:${(finalWinProb*100).toFixed(0)}%) | LLM: ${llmReason}`, 
                    finalTradeAmountSol, marketData, envState, activeStrategyId, kellyMultiplier
                );

                if (success) {
                    await redisClient.set(`pos_sl_tp:${mint}`, JSON.stringify({ sl: dynamicSL, tp: dynamicTP }), 'EX', 86400 * 3);
                    console.log(`🛡️ [Strategy Config] 已為 ${symbol} 綁定專屬止損 (${dynamicSL}%) / 止盈 (${dynamicTP}%) 參數。`);
                }
            }
        } else {
            console.log(`🚫 [AUTO VETO] 分數不達標 (${finalScore} < ${buyThreshold})，拒絕買入。`);
        }
    } catch (err) {
        console.error(`❌ [Routing Error] 決策漏斗處理崩潰:`, err.message);
    }
}

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

                await redisClient.set('DEXSCREENER_LOCK', 'MAIN_BOT', 'EX', 10);

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

async function bootstrap() {
    console.log("🚀 SOL QUANT HUNTER_FRONTLINE V10.53 (幽靈殺手版) 啟動中...");
    
    await initPortfolio();

    let portfolioSyncTimeout = null;
    function schedulePortfolioSync(source) {
        if (portfolioSyncTimeout) clearTimeout(portfolioSyncTimeout);
        portfolioSyncTimeout = setTimeout(async () => {
            console.log(`🔄 [System Sync] 偵測到 ${source}，正在強制校準獵人 RAM 倉位...`);
            try {
                await initPortfolio();
                console.log(`✅ [System Sync] 獵人 RAM 倉位已與大本營 Database 完美清空/對齊！`);
            } catch (e) {
                console.error(`❌ [System Sync] 重新校準失敗:`, e.message);
            }
        }, 2000); 
    }

    supabase.channel('frontline_portfolio_sync')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' }, () => schedulePortfolioSync('System Config 變更'))
        .subscribe();
    
    redisClient.get('cache:ml_compiled_rule_string').then(str => {
        if (str) ml_compiled_rule_func = new Function('data', str);
    }).catch(()=>{});

    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`🌐 [Frontline] Webhook 閘口開啟，Port ${PORT} (1ms 防堵塞機制啟動)`);
    });
    sourceAggregator.start();
    
    await healthMonitor.setStatus('Hunter_Frontline', '🟢 獵人掃描中 (數學完全體)');
}

bootstrap();