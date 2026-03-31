// src/services/trendingMonitorService.js
// 📝 檔案功能用途：隱形獵人爬蟲。每 2 小時從 GeckoTerminal 獲取 Solana 鏈上真實 Volume Top 100，具備防 429 智能重試與去重機制。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');
const { trendingJob } = require('../jobs/trendingJob');
const configEnv = require('../config/env');
const Redis = require('ioredis');
const { sendAdminAlert } = require('./telegramService');
const redis = new Redis(configEnv.cache.redisUrl);

let isCrawlerRunning = false;

const trendingMonitorService = {
    /**
     * 🌐 呼叫 GeckoTerminal 獲取 Solana 真實 Volume 排行榜 (支援智能防 429 重試)
     */
    async fetchTop100FromGecko() {
        let allPools = [];
        console.log('🌐 [Gecko Crawler] 開始分批抓取 8 頁 (約 160 個池)，準備過濾 Solana 真・Top 100...');

        const targetPages = 8; // 攞 8 頁，確保去重後有 100 隻幣

        for (let page = 1; page <= targetPages; page++) {
            let success = false;
            let retryCount = 0;
            const maxRetries = 3;

            // 🛡️ 智能重試 Loop：專擋 429 Too Many Requests
            while (!success && retryCount < maxRetries) {
                try {
                    // 🎯 這裡的 /networks/solana/ 已經完美鎖死只拿 Solana 鏈的數據
                    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                    const res = await axios.get(url, { headers: { 'accept': 'application/json' }, timeout: 10000 });
                    
                    if (res.data?.data) {
                        allPools = allPools.concat(res.data.data);
                    }
                    success = true; // 成功攞到，跳出 Retry Loop
                    console.log(`📑 [Gecko] 第 ${page} 頁抓取成功！`);

                    // 正常成功後，隨機休息 3 - 5 秒，扮真人，極大減低被 WAF 封鎖機會
                    if (page < targetPages) {
                        const delay = Math.floor(Math.random() * 2000) + 3000;
                        await new Promise(r => setTimeout(r, delay));
                    }

                } catch (err) {
                    retryCount++;
                    const is429 = err.response?.status === 429;
                    console.warn(`⚠️ [Gecko Crawler] 獲取第 ${page} 頁失敗 (嘗試 ${retryCount}/${maxRetries}):`, err.message);
                    
                    if (retryCount >= maxRetries) {
                        console.error(`🚨 [Gecko Crawler] 第 ${page} 頁徹底陣亡，跳過此頁繼續...`);
                        sendAdminAlert(`🚨 <b>爬蟲 API 局部故障</b>\n\n🦎 <b>目標:</b> GeckoTerminal 第 ${page} 頁\n❌ <b>錯誤:</b> 連續 3 次獲取失敗，已跳過。`);
                        break; 
                    }

                    // 如果係 429，代表被限流，重重地罰息 10-15 秒先再試
                    if (is429) {
                        const penaltyDelay = Math.floor(Math.random() * 5000) + 10000; // 10s - 15s
                        console.log(`⏳ 觸發 API 429 保護，強制冷卻 ${Math.round(penaltyDelay/1000)} 秒後重試...`);
                        await new Promise(r => setTimeout(r, penaltyDelay));
                    } else {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            }
        }
        
        return allPools;
    },

    start() {
        console.log('🦎 [Gecko Crawler] 真・Top 100 監控啟動 (每 2 小時大換血，附帶智能重試機制)...');
        
        const runTask = async () => {
            if (isCrawlerRunning) return;
            isCrawlerRunning = true;

            try {
                if (!canBuyTrending()) {
                    console.log('⏸️ [Gecko Crawler] Trending 倉位已滿，跳過本次榜單更新。');
                    isCrawlerRunning = false;
                    return;
                }

                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config || !config.is_running) { isCrawlerRunning = false; return; }

                const { data: stratParams } = await supabase.from('ai_strategy_params').select('min_liquidity').eq('id', 3).single();
                const dynamicMinLiquidity = stratParams?.min_liquidity || 150000; // 預設 15萬美金流動性

                const pools = await this.fetchTop100FromGecko();
                if (pools.length === 0) { isCrawlerRunning = false; return; }

                let top100Array = [];
                let incubatorArray = [];
                
                // 🚀 使用 Set 追蹤已加入的 Token 去重
                let uniqueMints = new Set();
                let currentRank = 1;

                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                // 黑名單：WSOL, USDC, USDT 等
                const blacklist = [
                    'So11111111111111111111111111111111111111112', 
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
                ];

                for (let i = 0; i < pools.length; i++) {
                    const pool = pools[i];
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;
                    if (blacklist.includes(mintAddress)) continue;

                    // 🚨 去重過濾：如果這隻幣已經入咗榜，直接 Skip
                    if (uniqueMints.has(mintAddress)) continue;
                    uniqueMints.add(mintAddress);

                    // 🎯 攞夠 100 隻 Unique Solana Token 就收工
                    if (top100Array.length >= 100) break;

                    const attr = pool.attributes || {};
                    const liquidityUsd = parseFloat(attr.reserve_in_usd) || 0;
                    const symbol = attr.name?.split(' /')[0] || 'UNKNOWN';

                    const baseData = {
                        mint_address: mintAddress, 
                        token_symbol: symbol, 
                        token_name: attr.name || 'UNKNOWN',
                        liquidity: liquidityUsd, 
                        volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                        price_change_24h: parseFloat(attr.price_change_percentage?.h24) || 0, 
                        updated_at: new Date().toISOString()
                    };

                    top100Array.push({ ...baseData, rank: currentRank });

                    // 🛡️ 過濾 Rank 11-100 且達標的潛力幣進入保溫箱 (Rank 1-10 放棄，太熱門多夾子)
                    if (currentRank >= 11 && currentRank <= 100 && liquidityUsd >= dynamicMinLiquidity) {
                        const isBlacklisted = await redis.get(`scam_blacklist:${mintAddress}`);
                        if (isBlacklisted) {
                            currentRank++;
                            continue;
                        }

                        const isHolding = activePositions.some(p => p.mint_address === mintAddress);
                        if (isHolding) {
                            currentRank++;
                            continue;
                        }

                        // 檢查冷卻期 (保留你原本優良的防打臉機制)
                        const { data: tradeHistory } = await supabase
                            .from(`trade_history_${tableSuffix}`)
                            .select('created_at, realized_pnl_pct')
                            .eq('token_mint', mintAddress)
                            .eq('action', 'SELL')
                            .order('created_at', { ascending: false })
                            .limit(2);

                        let isOnCooldown = false;
                        if (tradeHistory && tradeHistory.length > 0) {
                            const lastTrade = tradeHistory[0];
                            const timeSinceLastTrade = Date.now() - new Date(lastTrade.created_at).getTime();
                            // 虧損賣出後 24 小時內不碰
                            if (lastTrade.realized_pnl_pct < 0 && timeSinceLastTrade < 24 * 60 * 60 * 1000) isOnCooldown = true; 
                        }
                        
                        if (!isOnCooldown) incubatorArray.push(baseData);
                    }
                    
                    currentRank++;
                }

                // 3. 雙表同步 (Sync to Supabase)
                if (top100Array.length > 0) {
                    await supabase.from('trending_top100').delete().neq('mint_address', 'dummy'); 
                    const { error: insertErr } = await supabase.from('trending_top100').insert(top100Array);
                    
                    if (insertErr) {
                        console.error(`❌ [Gecko Crawler] 寫入 Top100 失敗:`, insertErr.message);
                    } else {
                        console.log(`📋 [Gecko Crawler] 成功更新 Top 100 真假幣對照表 (${top100Array.length} 隻不重複代幣)！`);
                    }
                }

                if (incubatorArray.length > 0) {
                    const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
                    if (!error) {
                        console.log(`🦎 [Gecko Crawler] 成功將 ${incubatorArray.length} 隻 Rank 11-100 的藍籌幣送入保溫箱！`);
                        healthMonitor.setStatus('Top200_Crawler', `🟢 已佈局 ${incubatorArray.length} 隻大藍籌`);
                        
                        if (trendingJob && typeof trendingJob.triggerImmediateAndResetClock === 'function') {
                            trendingJob.triggerImmediateAndResetClock();
                        }
                    }
                }
            } catch (err) {
                console.error(`❌ [Gecko Crawler] 運行異常:`, err.message);
            } finally {
                isCrawlerRunning = false;
            }
        };

        // 啟動 5 秒後行第一次，之後每 2 小時行一次
        setTimeout(() => { runTask(); }, 5000); 
        setInterval(runTask, 2 * 60 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };