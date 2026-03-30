// src/jobs/trendingJob.js
const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { canBuyTrending } = require('../services/portfolioService'); 
const configEnv = require('../config/env'); 
const { healthMonitor } = require('../services/healthMonitor');

// 🚀 [新增] 引入 Redis 以管理 VIP 鎖
const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

let isTrendingRunning = false;

// 保留原有嘅備援機制框架，防患未然
const apiCooldowns = {
    geckoTerminal: 0,
    jupiterV3: 0,
    jupiterV6: 0
};

function isApiAvailable(apiName) {
    return Date.now() > apiCooldowns[apiName];
}

function markApiFailed(apiName) {
    console.warn(`🚨 [Trending Fallback] ${apiName} 發生故障，已觸發斷路器，進入 60 秒冷卻期！`);
    apiCooldowns[apiName] = Date.now() + 60000;
}

const trendingJob = {
    async runRoutine() {
        if (isTrendingRunning) return;
        isTrendingRunning = true;

        try {
            if (!canBuyTrending()) return; 

            const { data: config } = await supabase.from('system_config').select('is_running, trending_trade_amount_sol, trending_survival_score').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const survivalScore = config.trending_survival_score || 60;

            // 🚀 [升級] 攞出保溫箱入面所有代幣 (最高 200 隻)
            const { data: poolTokens } = await supabase.from('trending_pool').select('*');
            if (!poolTokens || poolTokens.length === 0) return; 

            // 🔒 [VIP 機制] 霸佔 DexScreener 資源，掛上 TRENDING 鎖，叫 Meme 讓路 (鎖定 120 秒)
            await redis.set('dex_priority_lock', 'TRENDING', 'EX', 120);
            console.log(`👑 [Trending VIP] 已鎖定 DexScreener 資源，全面掃描 TOP 200 (共 ${poolTokens.length} 隻)...`);

            const mintsArray = poolTokens.map(t => t.mint_address);

            // 🌊 [核心] 呼叫 Security Guard 嘅批量水喉，一次過攞晒所有最新數據
            const batchMarketData = await securityGuard.getBatchMarketData(mintsArray);

            let triggeredCount = 0;

            for (const token of poolTokens) {
                const mintAddress = token.mint_address;
                const mData = batchMarketData[mintAddress];

                if (!mData) continue; // 如果 DexScreener 搵唔到數據，跳過

                // 🧮 提取數學雷達所需數據
                const h1 = mData.h1;
                const vol5m = mData.volume5m;
                const liq = mData.liquidity;
                const buys = mData.buys5m;
                const sells = mData.sells5m;

                // 🎯 數學雷達三大條件 (中是但一個即觸發)
                const isPriceSurge = h1 >= 3.0; // 1 小時內拉升 >= 3%
                const isVolSurge = liq > 0 && (vol5m / liq) > 0.05; // 5分鐘成交量佔池子 > 5% (極度活躍)
                const isBuyPressure = buys > (sells * 1.5) && buys > 5; // 買盤壓制 (最少要有 5 個買單防雜訊)

                if (isPriceSurge || isVolSurge || isBuyPressure) {
                    triggeredCount++;
                    console.log(`\n======================================================`);
                    console.log(`📡 [Math Radar] 觸發！幣種: ${token.token_symbol}`);
                    console.log(`   - 1H 升幅: ${h1}% | 5m 量/池比: ${liq > 0 ? ((vol5m/liq)*100).toFixed(2) : 0}% | 買/賣: ${buys}/${sells}`);
                    console.log(`======================================================\n`);

                    // 🛡️ 實體安檢 (此處為 TRENDING，會直行直過 VIP 鎖)
                    const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');
                    if (!secResult.isSafe) {
                        console.log(`🗑️ [Trending Security] 動能衰退/防線失敗，淘汰出局: ${secResult.reason}`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        continue; 
                    }

                    // 🧠 只有通過雷達嘅幣，先會交畀 AI 審批，極大節省算力
                    const aiDecision = await consensusService.runMemeConsensus(
                        mintAddress, 
                        secResult.marketData, 
                        { poolType: 'TRENDING', lastComment: token.last_ai_comment }
                    );

                    // 🚀 [核心修復] 強制防禦：確保 AI 分數為數字
                    const aiScore = (aiDecision.score !== undefined && aiDecision.score !== null && !isNaN(aiDecision.score)) 
                                    ? Number(aiDecision.score) 
                                    : 0;

                    if (aiDecision.buy) {
                        const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, 'TRENDING_MOMENTUM', aiScore, aiDecision.reason, config.trending_trade_amount_sol || 0.1);
                        if (buyResult) await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    } else {
                        if (aiScore >= survivalScore || aiDecision.decision === 'ONHOLD' || (aiDecision.reason && aiDecision.reason.includes('ONHOLD'))) {
                            console.log(`⏳ [Trending] 潛力仍在 (分數: ${aiScore} >= ${survivalScore})，保留數據...`);
                            await supabase.from('trending_pool').update({ 
                                last_ai_comment: aiDecision.reason,
                                ai_score: aiScore, 
                                volume_5m: vol5m,
                                price_change_h1: h1,
                                updated_at: new Date().toISOString() 
                            }).eq('mint_address', mintAddress);
                        } else {
                            console.log(`🗑️ [Trending] 分數低於門檻 (${aiScore} < ${survivalScore})，踢出保溫箱！`);
                            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        }
                    }
                } else {
                    // 💤 雷達未觸發，只靜默更新物理數據，唔 Call AI！
                    await supabase.from('trending_pool').update({ 
                        volume_5m: vol5m,
                        price_change_h1: h1,
                        updated_at: new Date().toISOString() 
                    }).eq('mint_address', mintAddress);
                }
            }

            console.log(`👑 [Trending VIP] 巡邏完畢 (觸發雷達數: ${triggeredCount} / ${poolTokens.length})。強制冷卻 1 秒後釋放資源...`);
            healthMonitor.setStatus('Math_Radar', `🟢 剛巡邏 ${poolTokens.length} 隻 (觸發: ${triggeredCount})`);
            await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常:`, err.message);
            healthMonitor.setStatus('Math_Radar', '🔴 巡邏異常');
        } finally {
            // 🔓 [解鎖] 無論成功定失敗，最後一定釋放 VIP 鎖，畀 Meme 行
            await redis.del('dex_priority_lock');
            isTrendingRunning = false;
        }
    },
    start() {
        // 🚀 升級：每 15 分鐘全量掃描一次 (改為 15 分鐘)
        cron.schedule('*/15 * * * *', () => { this.runRoutine(); });
        console.log(`🔥 [Trending Incubator] 真・Top 200 數學雷達已啟動 (每 15 分鐘巡邏一次)`);
    }
};

module.exports = { trendingJob };