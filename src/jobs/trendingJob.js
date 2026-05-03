// src/jobs/trendingJob.js
// 📝 檔案功能用途：V10.21 數學雷達排程器 (天網級防禦)。
// 🚀 V10 核心升級：拔除越權的硬核 OFI/均單攔截，將參數裁決權全數交還給 securityGuard 與 Python ML。保留女巫與高階造市防禦。

const axios = require('axios');
const { supabase } = require('../config/supabase');
const { getPortfolio } = require('../services/portfolioService'); 
const configEnv = require('../config/config'); 
const { healthMonitor } = require('../services/healthMonitor');
const { cacheManager } = require('../services/cacheManager'); 

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');

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

            const { data: stratParams } = await supabase.from('ml_strategy_params').select('dynamic_vl_tiers').eq('id', 3).single();
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

            // 🚀 批次查詢 DexScreener (防 429)
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
                                        sells5m: pair.txns?.m5?.sells || 0,
                                        priceUsd: parseFloat(pair.priceUsd) || 0
                                    };
                                }
                            }
                        }
                        success = true; 
                    } catch (err) {
                        retry++;
                        const is429 = err.response?.status === 429 || err.message.includes('429');
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

                const totalTxns = buys + sells;
                const turnover5m = liq > 0 ? (vol5m / liq) : 0;
                const buyRatio = totalTxns > 0 ? (buys / totalTxns) : 0;

                // =====================================================================
                // 🗡️ 物理防禦 Phase B：保留絕對防線 (高階造市與女巫防禦)，剔除純數值限制
                // =====================================================================
                if (turnover5m > 1.5 && h1 < 100) {
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    continue;
                }
                if (totalTxns > 50 && buyRatio > 0.45 && buyRatio < 0.55) {
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

                    const priceSnapshot = {
                        [mintAddress]: {
                            p: mData.priceUsd || 0.001,
                            v: vol5m,
                            b: buys,
                            s: sells,
                            l: liq,
                            ts: Date.now()
                        }
                    };
                    
                    await redis.publish('price_updates', JSON.stringify(priceSnapshot));
                    await redis.publish('trending_signal', JSON.stringify({ mint: mintAddress, symbol: token.token_symbol }));
                    await new Promise(r => setTimeout(r, 2000));
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);

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