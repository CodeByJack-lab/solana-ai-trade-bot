// src/jobs/trendingJob.js
// 📝 檔案功能用途：V9.1 數學雷達排程器。動態讀取 DB 的 V/L 階梯比例，利用 DexScreener 批量查價，精確喚醒 100 分量化漏斗與大腦分流器。

const axios = require('axios');
const { supabase } = require('../config/supabase');
const { securityGuard } = require('../services/securityGuard');
const { routerService } = require('../services/router');
const { getPortfolio } = require('../services/portfolioService'); 
const configEnv = require('../config/config'); 
const { healthMonitor } = require('../services/healthMonitor');

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

let isTrendingRunning = false;
let radarTimer = null; 

const trendingJob = {
    /**
     * 🧠 輔助函數：根據流動性，從動態階梯中找出對應的 V/L 目標
     */
    getTargetTurnover(liquidity, tiersConfig) {
        // 防呆預設值 (如果 DB 讀取失敗)
        const defaultTiers = { "10000000": 0.005, "5000000": 0.01, "2000000": 0.015, "1000000": 0.02, "500000": 0.03, "250000": 0.04, "150000": 0.05, "0": 0.08 };
        const tiers = tiersConfig || defaultTiers;
        
        // 將 JSON 嘅 Key 轉做數字，然後由大至小排序 [10000000, 5000000, 2000000...]
        const sortedThresholds = Object.keys(tiers).map(Number).sort((a, b) => b - a);

        for (const threshold of sortedThresholds) {
            if (liquidity >= threshold) {
                return tiers[threshold.toString()];
            }
        }
        return 0.08; // 終極保底
    },

    /**
     * 🕵️ 執行數學雷達巡邏，套用 DB 動態階梯 V/L 動能算法。
     */
    async runRoutine() {
        if (isTrendingRunning) return;
        isTrendingRunning = true;

        try {
            const portfolio = getPortfolio();
            if (!portfolio || (portfolio.mode !== 'LIVE' && portfolio.mode !== 'PAPER')) return;

            const { data: sysConfig } = await supabase.from('system_config').select('is_running, trending_survival_score').eq('id', 1).single();
            if (!sysConfig || !sysConfig.is_running) return;

            const survivalScore = sysConfig.trending_survival_score || 60;

            // 🧠 動態讀取 AI 策略參數內的 V/L 階梯設定
            const { data: stratParams } = await supabase.from('ai_strategy_params').select('dynamic_vl_tiers').eq('id', 3).single();
            const dynamicVlTiers = stratParams?.dynamic_vl_tiers;

            const { data: poolTokens } = await supabase.from('trending_pool').select('*');
            if (!poolTokens || poolTokens.length === 0) return; 

            // 🔒 掛上 VIP 鎖
            await redis.set('dex_priority_lock', 'TRENDING', 'EX', 120);
            console.log(`👑 [Trending VIP] 已鎖定資源，向 DexScreener 查詢 ${poolTokens.length} 隻保溫箱獵物...`);

            // 🚀 V9.1 新增：自行實作 DexScreener Batch Fetch，每次查 30 隻，完美防 429
            const mintsArray = poolTokens.map(t => t.mint_address);
            const batchMarketData = {};
            
            for (let i = 0; i < mintsArray.length; i += 30) {
                const batch = mintsArray.slice(i, i + 30);
                try {
                    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, { timeout: 5000 });
                    if (res.data && res.data.pairs) {
                        for (const pair of res.data.pairs) {
                            if (pair.chainId !== 'solana') continue;
                            const mint = pair.baseToken.address;
                            // 儲存流動性最高嗰個池嘅數據
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
                } catch (err) {
                    console.warn(`⚠️ [Trending] 批次查價失敗: ${err.message}`);
                }
                // 每次查完停 1 秒，防封鎖
                await new Promise(r => setTimeout(r, 1000));
            }

            let triggeredCount = 0;

            for (const token of poolTokens) {
                const mintAddress = token.mint_address;
                
                // 檢查是否已持倉，已持倉則移出保溫箱
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

                // 📈 [V9.0 核心] 從 DB 讀取動態階梯，決定當前池子的達標門檻
                const targetTurnover = this.getTargetTurnover(liq, dynamicVlTiers);

                const isPriceSurge = h1 >= 3.0; 
                const isVolSurge = liq > 0 && (vol5m / liq) > targetTurnover; 
                const isBuyPressure = buys > (sells * 1.5) && buys > 5; 
                
                // 真假幣攔截
                const { data: fakeCheck } = await supabase.from('trending_top100').select('mint_address').eq('token_symbol', token.token_symbol).single();
                const isKnownFake = fakeCheck && fakeCheck.mint_address !== mintAddress;

                if (isKnownFake) {
                    console.log(`🗑️ [Fake Shield] 攔截仿冒幣！${token.token_symbol} 與真品地址不符，踢出保溫箱！`);
                    await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                    continue;
                }

                if (isPriceSurge || isVolSurge || isBuyPressure) {
                    triggeredCount++;
                    console.log(`\n======================================================`);
                    console.log(`📡 [Math Radar] 動能觸發！幣種: ${token.token_symbol}`);
                    console.log(`   - 流動性: $${liq.toLocaleString()} | 目標換手率: ${(targetTurnover*100).toFixed(2)}%`);
                    console.log(`   - 1H 升幅: ${h1}% | 實際 5m 量/池比: ${liq > 0 ? ((vol5m/liq)*100).toFixed(2) : 0}% | 買/賣: ${buys}/${sells}`);
                    console.log(`======================================================\n`);

                    // 🛡️ V9.1 核心：呼叫 100 分量化漏斗
                    const secResult = await securityGuard.calculateQuantScore(mintAddress, 'TRENDING');
                    
                    if (!secResult.isSafe) {
                        console.log(`🗑️ [Trending Security] 安檢判定危險: ${secResult.reason}`);
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                        await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                        continue; 
                    }

                    // 🚦 V9.1 核心：送入 Router 分流 (Fast-Track 或 AI 微調)
                    const isBought = await routerService.routeSignal(mintAddress, 'TRENDING', secResult);

                    if (isBought) {
                        // 買入成功，踢出保溫箱
                        await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                    } else {
                        // 沒買入 (可能 AI 否決、環境矩陣攔截 或 倉位滿)
                        if (secResult.numeric_score >= survivalScore) {
                            console.log(`⏳ [Trending] 潛力仍在 (分數: ${secResult.numeric_score})，保留於保溫箱...`);
                            await supabase.from('trending_pool').update({ ai_score: secResult.numeric_score, volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
                        } else {
                            console.log(`🗑️ [Trending] 分數低於門檻 (${secResult.numeric_score} < ${survivalScore})，踢出並拉黑！`);
                            await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
                            await redis.set(`scam_blacklist:${mintAddress}`, 'TRUE', 'EX', 86400);
                        }
                    }
                } else {
                    // 動能未觸發，更新狀態
                    await supabase.from('trending_pool').update({ volume_5m: vol5m, price_change_h1: h1, updated_at: new Date().toISOString() }).eq('mint_address', mintAddress);
                }
            }

            console.log(`👑 [Trending VIP] 巡邏完畢 (觸發: ${triggeredCount} / ${poolTokens.length})。`);
            healthMonitor.setStatus('Math_Radar', `🟢 剛巡邏 ${poolTokens.length} 隻 (觸發: ${triggeredCount})`);

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
        // V9.1 節奏：藍籌池建議每 2 分鐘掃描一次即可，太快會嘥 DexScreener Quota
        radarTimer = setInterval(() => { this.runRoutine(); }, 120000); 
    },

    start() {
        radarTimer = setInterval(() => { this.runRoutine(); }, 120000); 
        console.log(`🔥 [Trending Incubator] 數學雷達已待命，由 DB 動態 JSON 配置主導換手率門檻...`);
    }
};

module.exports = { trendingJob };