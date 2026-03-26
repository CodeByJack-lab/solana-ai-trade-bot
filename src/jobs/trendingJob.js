// src/jobs/trendingJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { healthMonitor } = require('../services/healthMonitor');
const { canBuyTrending } = require('../services/portfolioService'); 
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

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

            // 🚀 新增：一從 Database 抽到隻幣出嚟，即刻印 Log 話畀你聽！
            console.log(`\n======================================================`);
            console.log(`🎣 [Trending Job] 從熱門池抽出代幣: ${targetToken.token_symbol} (${mintAddress.substring(0,6)}...)`);
            console.log(`======================================================\n`);

            const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');

            if (!secResult.isSafe) {
                console.log(`🛡️ [Trending Security] 攔截 ${targetToken.token_symbol} (${mintAddress.substring(0,6)}): ${secResult.reason}`);
                await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                return;
            }

            console.log(`🔥 [Trending] 準備突擊 Top 50 熱門幣: ${targetToken.token_symbol}`);
            console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);

            const aiDecision = await consensusService.runMemeConsensus(
                mintAddress, 
                secResult.marketData, 
                { poolType: 'TRENDING' } 
            );

            if (aiDecision.buy) {
                const strategy = 'TRENDING_MOMENTUM'; 
                const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, strategy, aiDecision.score, aiDecision.reason, tradeAmount);
                
                if (buyResult !== false) {
                    console.log(`\n======================================================`);
                    console.log(`✅ 🟢 【買入指令已送出 - ${secResult.marketData.symbol}】 🟢 ✅`);
                    console.log(`📍 策略: ${strategy} (Top 50 追擊)`);
                    console.log(`投入金額: ${tradeAmount} SOL`);
                    console.log(`🤖 AI 買入理由: ${aiDecision.reason}`);
                    console.log(`======================================================\n`);
                }
            } else {
                console.log(`🧠 [Trending AI Rejected] 否決: ${aiDecision.reason}`);
            }

            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);

        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常 (保留數據重試):`, err.message);
        } finally {
            isTrendingRunning = false;
        }
    },

    start() {
        cron.schedule('*/15 * * * * *', () => {
            this.runRoutine();
        });
        console.log(`🔥 [Trending Job] 熱門幣追擊隊已就位 (獨立資金庫與倉位鎖運作中)`);
    }
};

module.exports = { trendingJob };