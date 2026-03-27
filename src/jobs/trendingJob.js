// src/jobs/trendingJob.js
const cron = require('node-cron');
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

            // 🚀 撈取數據，包含 last_ai_comment
            const { data: targetToken } = await supabase
                .from('trending_pool')
                .select('*')
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (!targetToken) {
                return;
            }

            const mintAddress = targetToken.mint_address;

            console.log(`\n======================================================`);
            console.log(`🎣 [Trending Job] 從熱門池抽出代幣: ${targetToken.token_symbol} (${mintAddress.substring(0,6)}...)`);
            if (targetToken.last_ai_comment) {
                console.log(`📜 [歷史記憶] 上次評語: ${targetToken.last_ai_comment}`);
            }
            console.log(`======================================================\n`);

            const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');

            if (!secResult.isSafe) {
                console.log(`🛡️ [Trending Security] 攔截 ${targetToken.token_symbol} (${mintAddress.substring(0,6)}): ${secResult.reason}`);
                await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                return;
            }

            console.log(`🔥 [Trending] 準備突擊 Top 50 熱門幣: ${targetToken.token_symbol}`);
            console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);

            // 🚀 V7.2 升級：傳入歷史評語供 AI 對比
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
                    // 買入成功，從池中移除
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                }
            } else {
                console.log(`🧠 [Trending AI Rejected] 否決: ${aiDecision.reason}`);
                
                // 🚀 如果 AI 決定 ONHOLD (觀望)，更新評語並保留在池中，不刪除
                if (aiDecision.decision === 'ONHOLD' || aiDecision.reason.includes('ONHOLD')) {
                    console.log(`⏳ [Trending] AI 決定觀望，更新記憶並保留在池中...`);
                    await supabase.from('trending_pool')
                        .update({ last_ai_comment: aiDecision.reason })
                        .eq('mint_address', mintAddress);
                } else {
                    // 如果是 ABORT (放棄)，直接刪除
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                }
            }

        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常:`, err.message);
        } finally {
            isTrendingRunning = false;
        }
    },

    start() {
        cron.schedule('*/15 * * * * *', () => {
            this.runRoutine();
        });
        console.log(`🔥 [Trending Job] 熱門幣追擊隊已就位 (具備 AI 歷史記憶功能)`);
    }
};

module.exports = { trendingJob };