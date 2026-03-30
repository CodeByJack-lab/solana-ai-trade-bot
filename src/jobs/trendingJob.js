// src/jobs/trendingJob.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { canBuyTrending } = require('../services/portfolioService'); 
const configEnv = require('../config/env'); 
const { healthMonitor } = require('../services/healthMonitor');

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

let isTrendingRunning = false;
let radarTimer = null; // 🚀 [新增] 數學雷達專屬節拍器

const apiCooldowns = { geckoTerminal: 0, jupiterV3: 0, jupiterV6: 0 };
function isApiAvailable(apiName) { return Date.now() > apiCooldowns[apiName]; }
function markApiFailed(apiName) {
    console.warn(`🚨 [Trending Fallback] ${apiName} 發生故障，觸發斷路器！`);
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

            const { data: poolTokens } = await supabase.from('trending_pool').select('*');
            if (!poolTokens || poolTokens.length === 0) return; 

            // 🔒 [VIP 機制] 霸佔 DexScreener 資源，掛上 TRENDING 鎖，叫 Meme 讓路 (鎖定 120 秒)
            await redis.set('dex_priority_lock', 'TRENDING', 'EX', 120);
            console.log(`👑 [Trending VIP] 已鎖定 DexScreener 資源，全面掃描 TOP 200 (共 ${poolTokens.length} 隻)...`);

            const mintsArray = poolTokens.map(t => t.mint_address);
            const batchMarketData = await securityGuard.getBatchMarketData(mintsArray);

            let triggeredCount = 0;

            for (const token of poolTokens) {
                const mintAddress = token.mint_address;
                const mData = batchMarketData[mintAddress];
                if (!mData) continue; 

                const h1 = mData.h1;
                const vol5m = mData.volume5m;
                const liq = mData.liquidity;
                const buys = mData.buys5m;
                const sells = mData.sells5m;

                const isPriceSurge = h1 >= 3.0; 
                const isVolSurge = liq > 0 && (vol5m / liq) > 0.05; 
                const isBuyPressure = buys > (sells * 1.5) && buys > 5; 

                if (isPriceSurge || isVolSurge || isBuyPressure) {
                    triggeredCount++;
                    console.log(`\n======================================================`);
                    console.log(`📡 [Math Radar] 觸發！幣種: ${token.token_symbol}`);
                    console.log(`   - 1H 升幅: ${h1}% | 5m 量/池比: ${liq > 0 ? ((vol5m/liq)*100).toFixed(2) : 0}% | 買/賣: ${buys}/${sells}`);
                    console.log(`======================================================\n`);

                    const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');
                    if (!secResult.isSafe) {
                        console.log(`🗑️ [Trending Security] 動能衰退/防線失敗: ${secResult.reason}`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        continue; 
                    }

                    const aiDecision = await consensusService.runMemeConsensus(mintAddress, secResult.marketData, { poolType: 'TRENDING', lastComment: token.last_ai_comment });
                    const aiScore = (aiDecision.score !== undefined && aiDecision.score !== null && !isNaN(aiDecision.score)) ? Number(aiDecision.score) : 0;

                    if (aiDecision.buy) {
                        const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, 'TRENDING_MOMENTUM', aiScore, aiDecision.reason, config.trending_trade_amount_sol || 0.1);
                        if (buyResult) await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    } else {
                        if (aiScore >= survivalScore || aiDecision.decision === 'ONHOLD' || (aiDecision.reason && aiDecision.reason.includes('ONHOLD'))) {
                            console.log(`⏳ [Trending] 潛力仍在 (分數: ${aiScore} >= ${survivalScore})，保留數據...`);
                            await supabase.from('trending_pool').update({ last_ai_comment: aiDecision.reason, ai_score: aiScore, volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
                        } else {
                            console.log(`🗑️ [Trending] 分數低於門檻 (${aiScore} < ${survivalScore})，踢出保溫箱！`);
                            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        }
                    }
                } else {
                    await supabase.from('trending_pool').update({ volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
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

    // 🚀 [核心引擎] 接收大換血完畢信號，即刻開工並重置 15 分鐘時鐘！
    triggerImmediateAndResetClock() {
        console.log(`⏱️ [System] 接收到大換血完畢信號，重置數學雷達時鐘，立即啟動 VIP 巡邏！`);
        
        // 1. 清除舊有嘅鬧鐘，防止相撞
        if (radarTimer) clearInterval(radarTimer);
        
        // 2. 即刻跑一次雷達 (零等待！)
        this.runRoutine();
        
        // 3. 重新設定 15 分鐘嘅 metronome 節拍器
        radarTimer = setInterval(() => { this.runRoutine(); }, 15 * 60 * 1000);
    },

    start() {
        // 開機時設定一個預設鬧鐘 (防止爬蟲意外死火時雷達停擺)
        radarTimer = setInterval(() => { this.runRoutine(); }, 15 * 60 * 1000);
        console.log(`🔥 [Trending Incubator] 真・Top 200 數學雷達已待命，將由 Gecko 爬蟲全權指揮節拍...`);
    }
};

module.exports = { trendingJob };