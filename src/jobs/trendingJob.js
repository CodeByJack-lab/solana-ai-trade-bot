// src/jobs/trendingJob.js
// 📝 檔案功能用途：V10.9 數學雷達排程器 (天網級防禦)。內建雙重前置物理防禦網，並賦予 AI 「一票否決物理拔線」的絕對權力。

const axios = require('axios');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { routerService } = require('../services/router');
const { getPortfolio } = require('../services/portfolioService'); 
const configEnv = require('../config/config'); 
const { healthMonitor } = require('../services/healthMonitor');
const { cacheManager } = require('../services/cacheManager'); 

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

let isTrendingRunning = false;
let radarTimer = null; 

const trendingJob = {
    getTargetTurnover(liquidity, tiersConfig) {
        const defaultTiers = { "10000000": 0.005, "5000000": 0.01, "2000000": 0.015, "1000000": 0.02, "500000": 0.03, "250000": 0.04, "150000": 0.05, "0": 0.08 };
        const tiers = tiersConfig || defaultTiers;
        const sortedThresholds = Object.keys(tiers).map(Number).sort((a, b) => b - a);

        for (const threshold of sortedThresholds) {
            if (liquidity >= threshold) return tiers[threshold.toString()];
        }
        return 0.08; 
    },

    async runRoutine() {
        if (isTrendingRunning) return;
        isTrendingRunning = true;

        try {
            const portfolio = getPortfolio();
            if (!portfolio || (portfolio.mode !== 'LIVE' && portfolio.mode !== 'PAPER')) return;

            const { data: sysConfig } = await supabase.from('system_config').select('is_running, trending_survival_score').eq('id', 1).single();
            if (!sysConfig || !sysConfig.is_running) return;

            const survivalScore = sysConfig.trending_survival_score || 60;
            const { data: stratParams } = await supabase.from('ai_strategy_params').select('dynamic_vl_tiers').eq('id', 3).single();
            const dynamicVlTiers = stratParams?.dynamic_vl_tiers;

            const { data: poolTokens } = await supabase.from('trending_pool').select('*');
            if (!poolTokens || poolTokens.length === 0) return; 

            await redis.set('dex_priority_lock', 'TRENDING', 'EX', 120);

            // =====================================================================
            // 🛡️ 物理防禦 Phase A：【API 呼叫前】絕對防偽裝甲
            // =====================================================================
            const verifiedTokens = cacheManager.getVerifiedTokens() || {};
            const safeWhitelist = {};
            Object.keys(verifiedTokens).forEach(k => safeWhitelist[k.toUpperCase()] = verifiedTokens[k]);

            const { data: top100Data } = await supabase.from('trending_top100').select('token_symbol, mint_address');
            const top100Map = {};
            if (top100Data) top100Data.forEach(t => top100Map[t.token_symbol.toUpperCase()] = t.mint_address);

            const validPoolTokens = [];

            for (const token of poolTokens) {
                const upperSymbol = (token.token_symbol || '').toUpperCase();
                const mintAddress = token.mint_address;
                let isFake = false;

                if (safeWhitelist[upperSymbol] && safeWhitelist[upperSymbol] !== mintAddress) {
                    isFake = true;
                } else if (top100Map[upperSymbol] && top100Map[upperSymbol] !== mintAddress) {
                    isFake = true;
                }

                if (isFake) {
                    console.log(`🗑️ [Fake Shield] 攔截仿冒幣！${upperSymbol} (${mintAddress}) 與正版地址不符，物理踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                } else {
                    validPoolTokens.push(token); 
                }
            }

            if (validPoolTokens.length === 0) {
                console.log(`👑 [Trending VIP] 保溫箱內全屬假幣已被清剿，暫無獵物。`);
                return;
            }

            console.log(`👑 [Trending VIP] 已過濾假幣，向 DexScreener 查詢 ${validPoolTokens.length} 隻保溫箱獵物...`);

            // 🚀 V9.1 批次查詢 (防 429)
            const mintsArray = validPoolTokens.map(t => t.mint_address);
            const batchMarketData = {};
            
            for (let i = 0; i < mintsArray.length; i += 30) {
                const batch = mintsArray.slice(i, i + 30);
                let success = false;
                let retry = 0;
                
                while (!success && retry < 3) {
                    try {
                        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, { timeout: 15000 });
                        
                        if (res.data && res.data.pairs) {
                            for (const pair of res.data.pairs) {
                                if (pair.chainId !== 'solana') continue;
                                const mint = pair.baseToken.address;
                                if (!batchMarketData[mint] || (pair.liquidity?.usd > batchMarketData[mint].liquidity)) {
                                    batchMarketData[mint] = {
                                        h1: parseFloat(pair.priceChange?.h1) || 0,
                                        volume5m: pair.volume?.m5 || 0,
                                        liquidity: pair.liquidity?.usd || 0,
                                        buys5m: pair.txns?.m5?.buys || 0,
                                        sells5m: pair.txns?.m5?.sells || 0
                                    };
                                }
                            }
                        }
                        success = true; 
                    } catch (err) {
                        retry++;
                        const is429 = err.response?.status === 429 || err.message.includes('429');
                        console.warn(`⚠️ [Trending] 批次查價失敗 (嘗試 ${retry}/3): ${err.message}`);
                        if (is429) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5000) + 5000));
                        else await new Promise(r => setTimeout(r, 2000));
                    }
                }
                await new Promise(r => setTimeout(r, 1500));
            }

            let triggeredCount = 0;

            for (const token of validPoolTokens) {
                const mintAddress = token.mint_address;
                
                const isOwned = portfolio.positions.some(p => p.mint_address === mintAddress);
                if (isOwned) {
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }

                const mData = batchMarketData[mintAddress];
                if (!mData) continue; 

                const h1 = mData.h1;
                const vol5m = mData.volume5m;
                const liq = mData.liquidity;
                const buys = mData.buys5m;
                const sells = mData.sells5m;

                // =====================================================================
                // 🗡️ 物理防禦 Phase B：【API 呼叫後】狗莊刷量與極惡 OFI 攔截 
                // =====================================================================
                const totalTxns = buys + sells;
                const avgTrade = totalTxns > 0 ? (vol5m / totalTxns) : 0;
                const pseudoOfi = totalTxns > 0 ? (buys - sells) / totalTxns : 0;
                const turnover5m = liq > 0 ? (vol5m / liq) : 0;
                const buyRatio = totalTxns > 0 ? (buys / totalTxns) : 0;

                if (totalTxns >= 15 && avgTrade < 25) {
                    console.log(`🗑️ [Nano Spam Guard] 攔截乞衣刷量！${token.token_symbol} 均單 $${avgTrade.toFixed(2)}，踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }
                if (turnover5m > 1.5 && h1 < 100) {
                    console.log(`🗑️ [Divergence Guard] 攔截高階造市！${token.token_symbol} 換手率高達 ${(turnover5m*100).toFixed(0)}% 但價格不漲，踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }
                if (totalTxns > 50 && buyRatio > 0.45 && buyRatio < 0.55) {
                    console.log(`🗑️ [Sybil Guard] 攔截腳本對沖！${token.token_symbol} 買賣對稱率 ${(buyRatio*100).toFixed(1)}%，踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }
                if (totalTxns >= 15 && pseudoOfi < -0.2) {
                    console.log(`🗑️ [OFI Guard] 空軍壓境！${token.token_symbol} OFI 極差 (${pseudoOfi.toFixed(2)})，踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }

                // 📈 計算動能是否達標
                const targetTurnover = this.getTargetTurnover(liq, dynamicVlTiers);
                const isPriceSurge = h1 >= 3.0; 
                const isVolSurge = liq > 0 && (vol5m / liq) > targetTurnover; 
                const isBuyPressure = buys > (sells * 1.5) && buys > 5; 

                if (isPriceSurge || isVolSurge || isBuyPressure) {
                    triggeredCount++;
                    console.log(`\n======================================================`);
                    console.log(`📡 [Math Radar] 動能觸發！幣種: ${token.token_symbol}`);
                    console.log(`   - 流動性: $${liq.toLocaleString()} | 目標換手率: ${(targetTurnover*100).toFixed(2)}%`);
                    console.log(`   - 1H 升幅: ${h1}% | 實際 5m 量/池比: ${liq > 0 ? ((vol5m/liq)*100).toFixed(2) : 0}% | 買/賣: ${buys}/${sells}`);
                    console.log(`======================================================\n`);

                    // 🛡️ 呼叫安檢中樞
                    const secResult = await securityGuard.calculateQuantScore(mintAddress, 'TRENDING');
                    
                    if (!secResult.isSafe) {
                        console.log(`🗑️ [Trending Security] 安檢判定危險: ${secResult.reason}`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                        continue; 
                    }

                    // 🚦 呼叫 AI 路由 (如果 AI JSON 回傳 VETO，routerService 應該將其最終分數壓至 0)
                    const finalAiScoreObj = { numeric_score: secResult.numeric_score }; // 用 object 傳遞，方便 router 修改
                    const isBought = await routerService.routeSignal(mintAddress, 'TRENDING', secResult, finalAiScoreObj);

                    if (isBought) {
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    } else {
                        // 💀 核心修正：如果 AI 判斷為 VETO (分數被 router 扣至低於 survivalScore)，直接火化！
                        const actualScore = finalAiScoreObj.numeric_score !== undefined ? finalAiScoreObj.numeric_score : secResult.numeric_score;

                        if (actualScore >= survivalScore) {
                            console.log(`⏳ [Trending] 潛力仍在 (分數: ${actualScore})，保留於保溫箱...`);
                            await supabase.from('trending_pool').update({ ai_score: actualScore, volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
                        } else {
                            console.log(`🗑️ [Trending] 分數低於門檻或遭 AI 否決 (${actualScore} < ${survivalScore})，物理拔線並拉黑！`);
                            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                            await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                        }
                    }
                } else {
                    await supabase.from('trending_pool').update({ volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
                }
            }

            console.log(`👑 [Trending VIP] 巡邏完畢 (觸發: ${triggeredCount} / ${validPoolTokens.length})。`);
            healthMonitor.setStatus('Math_Radar', `🟢 剛巡邏 ${validPoolTokens.length} 隻 (觸發: ${triggeredCount})`);

        } catch (err) {
            console.error(`❌ [Trending Job] 執行異常:`, err.message);
            healthMonitor.setStatus('Math_Radar', '🔴 巡邏異常');
        } finally {
            await redis.del('dex_priority_lock');
            isTrendingRunning = false;
        }
    },

    triggerImmediateAndResetClock() {
        if (radarTimer) clearInterval(radarTimer);
        this.runRoutine();
        radarTimer = setInterval(() => { this.runRoutine(); }, 120000); 
    },

    start() {
        radarTimer = setInterval(() => { this.runRoutine(); }, 120000); 
        console.log(`🔥 [Trending Incubator] 數學雷達已待命，極限過濾引擎上線...`);
    }
};

module.exports = { trendingJob };