// src/jobs/trendingJob.js
const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { executeBuy } = require('../services/tradeService');
const { consensusService } = require('../services/consensusService');
const { canBuyTrending } = require('../services/portfolioService'); 
const configEnv = require('../config/env'); 

let isTrendingRunning = false;

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

            // 🚀 直接由 Database 抽 1 隻「已經等咗超過 5 分鐘」而且「等得最耐」嘅幣出嚟
            const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            
            const { data: poolTokens } = await supabase
                .from('trending_pool')
                .select('*')
                .lte('updated_at', fiveMinsAgo) // 必須超過 5 分鐘未覆診先有資格
                .order('updated_at', { ascending: true }) // 最舊優先 (等得最耐嗰個入去見醫生)
                .limit(1); // 每次只睇 1 隻，配搭 5 秒極速輸送帶

            if (!poolTokens || poolTokens.length === 0) return; 

            const targetToken = poolTokens[0];
            const mintAddress = targetToken.mint_address;
            const mints = mintAddress;

            let latestPrices = {};
            let fetchSuccess = false;

            if (!fetchSuccess && isApiAvailable('geckoTerminal')) {
                try {
                    const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${mints}`, { timeout: 3000 });
                    const pricesObj = res.data?.data?.attributes?.token_prices;
                    if (pricesObj && pricesObj[mintAddress]) {
                        latestPrices[mintAddress] = { price: parseFloat(pricesObj[mintAddress]) };
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('geckoTerminal'); }
            }

            if (!fetchSuccess && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
                try {
                    const jupConfig = { timeout: 3000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
                    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mints}`, jupConfig);
                    if (res.data && res.data[mintAddress]) {
                        latestPrices[mintAddress] = { price: parseFloat(res.data[mintAddress].usdPrice) };
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV3'); }
            }

            if (!fetchSuccess && isApiAvailable('jupiterV6')) {
                try {
                    const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mints}`, { timeout: 3000 });
                    if (res.data?.data) {
                        latestPrices = res.data.data;
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV6'); }
            }

            if (!fetchSuccess) {
                console.warn('⚠️ [Trending Job] 所有情報源均已癱瘓，暫緩本次覆診。');
                return;
            }

            console.log(`\n======================================================`);
            console.log(`🩺 [Trending Incubator] 覆診潛力幣: ${targetToken.token_symbol} (單行極速模式)`);
            console.log(`======================================================\n`);

            const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');
            if (!secResult.isSafe) {
                console.log(`🗑️ [Trending Security] 動能衰退，淘汰出局: ${secResult.reason}`);
                await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                return; 
            }

            const aiDecision = await consensusService.runMemeConsensus(
                mintAddress, 
                secResult.marketData, 
                { poolType: 'TRENDING', lastComment: targetToken.last_ai_comment }
            );

            if (aiDecision.buy) {
                const buyResult = await executeBuy(mintAddress, secResult.marketData.symbol, 'TRENDING_MOMENTUM', aiDecision.score, aiDecision.reason, config.trending_trade_amount_sol || 0.1);
                if (buyResult) await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
            } else {
                if (aiDecision.score >= survivalScore || aiDecision.decision === 'ONHOLD' || aiDecision.reason.includes('ONHOLD')) {
                    console.log(`⏳ [Trending] 潛力仍在 (分數: ${aiDecision.score || 'ONHOLD'} >= ${survivalScore})，重新排隊...`);
                    await supabase.from('trending_pool').update({ 
                        last_ai_comment: aiDecision.reason,
                        ai_score: aiDecision.score || 0,
                        updated_at: new Date().toISOString() 
                    }).eq('mint_address', mintAddress);
                } else {
                    console.log(`🗑️ [Trending] 分數低於門檻 (${aiDecision.score} < ${survivalScore})，踢出保溫箱！`);
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
        // 🚀 大佬嘅火力全開：每 5 秒 1 隻！
        cron.schedule('*/5 * * * * *', () => { this.runRoutine(); });
        console.log(`🔥 [Trending Incubator] 保溫箱覆診系統已就位 (極速排隊：每 5 秒 1 隻)`);
    }
};

module.exports = { trendingJob };
