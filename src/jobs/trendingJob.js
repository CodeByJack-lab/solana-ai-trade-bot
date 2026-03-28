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

// 🧠 斷路器：紀錄每隻 API 嘅冷卻到期時間 (Timestamp)
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

            const { data: config } = await supabase.from('system_config').select('is_running, trending_trade_amount_sol').eq('id', 1).single();
            if (!config || !config.is_running) return;

            const { data: poolTokens } = await supabase.from('trending_pool').select('*').order('updated_at', { ascending: true }).limit(20);
            if (!poolTokens || poolTokens.length === 0) return;

            const mints = poolTokens.map(t => t.mint_address).join(',');
            let latestPrices = {};
            let fetchSuccess = false;

            // 🛡️ 路線 1: GeckoTerminal (專查 Solana 細幣)
            if (!fetchSuccess && isApiAvailable('geckoTerminal')) {
                try {
                    const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${mints}`, { timeout: 3000 });
                    const pricesObj = res.data?.data?.attributes?.token_prices;
                    if (pricesObj) {
                        for (const [mint, priceStr] of Object.entries(pricesObj)) {
                            if (priceStr) latestPrices[mint] = { price: parseFloat(priceStr) };
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('geckoTerminal'); }
            }

            // 🛡️ 路線 2: Jupiter V3 專線
            if (!fetchSuccess && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
                try {
                    const jupConfig = { timeout: 3000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
                    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mints}`, jupConfig);
                    if (res.data) {
                        for (const [mint, info] of Object.entries(res.data)) {
                            if (info.usdPrice) latestPrices[mint] = { price: parseFloat(info.usdPrice) };
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV3'); }
            }

            // 🛡️ 路線 3: Jupiter V6 免費公海
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

            for (const targetToken of poolTokens) {
                if (!canBuyTrending()) break; 

                const mintAddress = targetToken.mint_address;
                const lastUpdatedMs = new Date(targetToken.updated_at).getTime();
                
                if (Date.now() - lastUpdatedMs < 5 * 60 * 1000) continue; 

                console.log(`\n======================================================`);
                console.log(`🩺 [Trending Incubator] 覆診潛力幣: ${targetToken.token_symbol}`);
                console.log(`======================================================\n`);

                const secResult = await securityGuard.checkAll(mintAddress, 'TRENDING');
                if (!secResult.isSafe) {
                    console.log(`🗑️ [Trending Security] 動能衰退，淘汰出局: ${secResult.reason}`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
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
                    if (aiDecision.score >= 70 || aiDecision.decision === 'ONHOLD' || aiDecision.reason.includes('ONHOLD')) {
                        console.log(`⏳ [Trending] 潛力仍在 (分數: ${aiDecision.score || 'ONHOLD'})，更新保溫箱...`);
                        await supabase.from('trending_pool').update({ 
                            last_ai_comment: aiDecision.reason,
                            ai_score: aiDecision.score || 0,
                            updated_at: new Date().toISOString()
                        }).eq('mint_address', mintAddress);
                    } else {
                        console.log(`🗑️ [Trending] 分數暴跌 (<70)，踢出保溫箱！`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    }
                }
                await new Promise(r => setTimeout(r, 2000)); 
            }
        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常:`, err.message);
        } finally {
            isTrendingRunning = false;
        }
    },
    start() {
        cron.schedule('*/30 * * * * *', () => { this.runRoutine(); });
        console.log(`🔥 [Trending Incubator] 保溫箱批次查價與 AI 覆診系統已就位`);
    }
};

module.exports = { trendingJob };