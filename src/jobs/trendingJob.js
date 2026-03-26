// src/jobs/trendingJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { healthMonitor } = require('../services/healthMonitor');
const { canBuyTrending } = require('../services/portfolioService'); // 🚀 引入三軍資金防線
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

let isTrendingRunning = false;

const trendingJob = {
    async runRoutine() {
        if (isTrendingRunning) return;
        isTrendingRunning = true;

        try {
            // 🚀 絕對資金與倉位紀律 (2:4:4)
            if (!canBuyTrending()) {
                return; 
            }

            // 1. 系統檢查與參數獲取
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) {
                return;
            }

            // 🚀 讀取專屬下單金額 (若無則預設 0.1)
            const tradeAmount = parseFloat(config.trending_trade_amount_sol) || 0.1;

            // 2. 從 trending_pool 抽最舊嘅一隻幣出嚟 (先進先出)
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

            // 3. 🚀 送入 Security Guard (標明來源係 TRENDING)
            const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');

            if (!secResult.isSafe) {
                console.log(`🛡️ [Trending Security] 攔截 ${targetToken.token_symbol} (${mintAddress.substring(0,6)}): ${secResult.reason}`);
                // 🚀 Phase 3 修復：確認為垃圾幣後，才執行刪除
                await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                return;
            }

            console.log(`\n======================================================`);
            console.log(`🔥 [Trending] 準備突擊 Top 50 熱門幣: ${targetToken.token_symbol}`);
            console.log(`🛡️ [Security] 物理與合約防線通關！準備交由 AI 審查...`);
            console.log(`======================================================\n`);

            // 4. 交畀 AI 三白劍俠審查 (標明 poolType: 'TRENDING')
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

            // 🚀 Phase 3 修復：AI 決策完畢，無論買唔買，都將佢從 Pool 移除
            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);

        } catch (err) {
            // 🚀 若果中途死 API (Timeout)，跌入 Catch，唔執行 Delete，等隻幣留喺 Pool 下次再戰！
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