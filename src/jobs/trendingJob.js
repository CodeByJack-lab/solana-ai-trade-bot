// src/jobs/trendingJob.js
const cron = require('node-cron');
const axios = require('axios'); // 👈 V8.2 引入 Axios
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { healthMonitor } = require('../services/healthMonitor');
const { canBuyTrending } = require('../services/portfolioService'); 

let isTrendingRunning = false;

const trendingJob = {
    async runRoutine() {
        if (isTrendingRunning) return;
        isTrendingRunning = true;

        try {
            if (!canBuyTrending()) {
                return; 
            }

            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) {
                return;
            }

            const tradeAmount = parseFloat(config.trending_trade_amount_sol) || 0.1;

            // 🚀 V8.2 一車過：從保溫箱抽最多 20 隻幣
            const { data: poolTokens } = await supabase
                .from('trending_pool')
                .select('*')
                .order('updated_at', { ascending: true }) // 優先處理最耐未 check 嘅
                .limit(20);

            if (!poolTokens || poolTokens.length === 0) {
                return;
            }

            // 🚀 V8.2 批次向 Jupiter 查價
            const mints = poolTokens.map(t => t.mint_address).join(',');
            let latestPrices = {};
            try {
                const res = await axios.get(`https://api.jup.ag/price/v2?ids=${mints}`, { timeout: 3000 });
                if (res.data && res.data.data) latestPrices = res.data.data;
            } catch (e) {
                console.warn('⚠️ [Trending Job] Jupiter 批次查價失敗，暫緩本次覆診。');
                return;
            }

            // 逐隻幣進行覆診
            for (const targetToken of poolTokens) {
                if (!canBuyTrending()) break; // 買滿即停

                const mintAddress = targetToken.mint_address;
                const lastUpdatedMs = new Date(targetToken.updated_at).getTime();
                
                // 5 分鐘覆診冷卻期，防塞死 AI
                if (Date.now() - lastUpdatedMs < 5 * 60 * 1000) continue; 

                console.log(`\n======================================================`);
                console.log(`🎣 [Trending Job] 從保溫箱覆診代幣: ${targetToken.token_symbol} (${mintAddress.substring(0,6)}...)`);
                if (targetToken.last_ai_comment) {
                    console.log(`📜 [歷史記憶] 上次評語: ${targetToken.last_ai_comment}`);
                }
                console.log(`======================================================\n`);

                const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');

                if (!secResult.isSafe) {
                    console.log(`🛡️ [Trending Security] 攔截 ${targetToken.token_symbol} (${mintAddress.substring(0,6)}): ${secResult.reason}`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }

                console.log(`🔥 [Trending] 準備突擊 Top 50 熱門幣: ${targetToken.token_symbol}`);
                console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);

                const aiDecision = await consensusService.runMemeConsensus(
                    mintAddress, 
                    secResult.marketData, 
                    { 
                        poolType: 'TRENDING',
                        lastComment: targetToken.last_ai_comment || "這是首次發現該熱門幣" 
                    } 
                );

                if (aiDecision.buy) {
                    const strategy = 'TRENDING_MOMENTUM'; 
                    const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, strategy, aiDecision.score, aiDecision.reason, tradeAmount);
                    
                    if (buyResult !== false) {
                        console.log(`\n======================================================`);
                        console.log(`✅ 🟢 【買入成功 - ${secResult.marketData.symbol}】 🟢 ✅`);
                        console.log(`🤖 AI 買入理由: ${aiDecision.reason}`);
                        console.log(`======================================================\n`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    }
                } else {
                    console.log(`🧠 [Trending AI Rejected] 否決: ${aiDecision.reason}`);
                    
                    // 🚀 V8.2 評分 >= 70 分留低，否則踢走
                    if (aiDecision.score >= 70 || aiDecision.decision === 'ONHOLD' || aiDecision.reason.includes('ONHOLD')) {
                        console.log(`⏳ [Trending] 潛力仍在 (分數: ${aiDecision.score || 'ONHOLD'})，更新記憶並保留在保溫箱...`);
                        await supabase.from('trending_pool')
                            .update({ 
                                last_ai_comment: aiDecision.reason,
                                ai_score: aiDecision.score || 0,
                                updated_at: new Date().toISOString()
                            })
                            .eq('mint_address', mintAddress);
                    } else {
                        console.log(`🗑️ [Trending] 分數暴跌 (<70)，踢出保溫箱！`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    }
                }
                await new Promise(r => setTimeout(r, 2000)); // 錯峰抖氣
            }

        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常:`, err.message);
        } finally {
            isTrendingRunning = false;
        }
    },

    start() {
        // 🚀 修正：將 15 秒改為 30 秒，減少併發請求防 429
        cron.schedule('*/30 * * * * *', () => {
            this.runRoutine();
        });
        console.log(`🔥 [Trending Job] 熱門幣保溫箱追擊隊已就位 (具備 AI 批次查價與歷史記憶功能)`);
    }
};

module.exports = { trendingJob };