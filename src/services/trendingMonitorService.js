// src/services/trendingMonitorService.js
// 📝 檔案功能用途：隱形獵人爬蟲。每 15 分鐘從 GeckoTerminal 獲取 Solana 真實 Volume Top 100，具備動態防偽過濾 (Verified Tokens) 與 2-10s 擬人化防 429 盾。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');
const { trendingJob } = require('../jobs/trendingJob');
const { cacheManager } = require('./cacheManager'); // 🛡️ 引入大腦快取
const configEnv = require('../config/config');
const Redis = require('ioredis');
const { sendAdminAlert } = require('./telegramService');
const redis = new Redis(configEnv.cache.redisUrl);

let isCrawlerRunning = false;

const trendingMonitorService = {
    async fetchTop100FromGecko() {
        let allPools = [];
        console.log('🌐 [Gecko Crawler] 開始分批抓取 8 頁 (約 160 個池)，準備過濾 Solana 真・Top 100...');

        const targetPages = 8; 

        for (let page = 1; page <= targetPages; page++) {
            let success = false;
            let retryCount = 0;
            const maxRetries = 3;

            while (!success && retryCount < maxRetries) {
                try {
                    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                    const res = await axios.get(url, { headers: { 'accept': 'application/json' }, timeout: 10000 });
                    
                    if (res.data?.data) {
                        allPools = allPools.concat(res.data.data);
                    }
                    success = true; 
                    console.log(`📑 [Gecko] 第 ${page} 頁抓取成功！`);

                    if (page < targetPages) {
                        // 🤖 擬人化防護：隨機產生 2000ms 至 10000ms (即 2 至 10 秒)
                        const delay = Math.floor(Math.random() * 8000) + 2000;
                        console.log(`⏳ [Gecko Crawler] 擬人化防護：等待 ${(delay/1000).toFixed(1)} 秒後再翻下一頁...`);
                        await new Promise(r => setTimeout(r, delay));
                    }
                } catch (error) {
                    retryCount++; 
                    
                    const is429 = error.response?.status === 429 || error.message.includes('429');
                    
                    console.warn(`⚠️ [Gecko Crawler] 獲取第 ${page} 頁失敗 (嘗試 ${retryCount}/3): ${error.message}`);
                
                    if (is429) {
                        const penaltyDelay = Math.floor(Math.random() * 5000) + 10000; 
                        console.log(`⏳ 觸發 API 429 保護，後台自動冷卻 ${Math.round(penaltyDelay/1000)} 秒後重試... (已靜音 Telegram)`);
                        await new Promise(r => setTimeout(r, penaltyDelay));
                    } else {
                        if (typeof sendAdminAlert === 'function') {
                            sendAdminAlert(`⚠️ [Gecko Crawler] 第 ${page} 頁嚴重異常: ${error.message}`);
                        }
                        await new Promise(r => setTimeout(r, 3000)); 
                    }
                }
            }
        }
        return allPools;
    },

    start() {
        console.log('🦎 [Gecko Crawler] 真・Top 100 監控啟動 (每 15 分鐘大換血，附帶智能重試與防偽過濾機制)...');
        
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

                // 🧠 從大腦動態讀取最低流動性要求 (TRENDING)
                const dbParams = cacheManager.getStrategy('TRENDING');
                const dynamicMinLiquidity = dbParams?.min_liquidity || 50000; 

                const pools = await this.fetchTop100FromGecko();
                if (pools.length === 0) { isCrawlerRunning = false; return; }

                let top100Array = [];
                let incubatorArray = [];
                
                let uniqueMints = new Set();
                let currentRank = 1;

                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                const blacklist = [
                    'So11111111111111111111111111111111111111112', 
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
                ];

                // 🛡️ 從大腦讀取最新防偽名單
                const cache = cacheManager.getConfig();
                const VERIFIED_TOKENS = cache?.verified_tokens || {};

                for (let i = 0; i < pools.length; i++) {
                    const pool = pools[i];
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;
                    if (blacklist.includes(mintAddress)) continue;

                    const attr = pool.attributes || {};
                    const symbol = attr.name?.split(' /')[0]?.toUpperCase() || 'UNKNOWN';

                    // 🚨 源頭攔截：如果是防偽名單上的幣種，但地址不符，直接踢走，不准上榜！
                    if (VERIFIED_TOKENS[symbol] && mintAddress !== VERIFIED_TOKENS[symbol]) {
                        console.log(`🗑️ [Fake Shield] 發現假冒 ${symbol} (${mintAddress})，直接踢出，拒絕佔用榜單與保溫箱資源！`);
                        continue; 
                    }

                    if (uniqueMints.has(mintAddress)) continue;
                    uniqueMints.add(mintAddress);

                    if (top100Array.length >= 100) break;

                    const liquidityUsd = parseFloat(attr.reserve_in_usd) || 0;

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

                    if (currentRank >= 1 && currentRank <= 100 && liquidityUsd >= dynamicMinLiquidity) {
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
                            if (lastTrade.realized_pnl_pct < 0 && timeSinceLastTrade < 24 * 60 * 60 * 1000) isOnCooldown = true; 
                        }
                        
                        if (!isOnCooldown) incubatorArray.push(baseData);
                    }
                    
                    currentRank++;
                }

                // 🛡️ 安全降級：確保獲取足夠數據才清空並更新 DB，防止 Gecko 429 導致榜單清空誤殺真幣
                if (top100Array.length >= 50) {
                    await supabase.from('trending_top100').delete().neq('mint_address', 'dummy'); 
                    const { error: insertErr } = await supabase.from('trending_top100').insert(top100Array);
                    
                    if (insertErr) {
                        console.error(`❌ [Gecko Crawler] 寫入 Top100 失敗:`, insertErr.message);
                    } else {
                        console.log(`📋 [Gecko Crawler] 成功更新 Top 100 真假幣對照表 (${top100Array.length} 隻不重複代幣)！`);
                    }
                } else {
                    console.log(`⚠️ [Gecko Crawler] 獲取數據不足 (${top100Array.length} 隻)，為防對照表斷層，暫不更新 DB。`);
                }

                if (incubatorArray.length > 0) {
                    const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
                    if (!error) {
                        console.log(`🦎 [Gecko Crawler] 成功將 ${incubatorArray.length} 隻 Rank 1-100 的藍籌幣送入保溫箱！`);
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

        setTimeout(() => { runTask(); }, 5000); 
        // ⚡ 將大熱幣掃描頻率縮短至 15 分鐘
        setInterval(runTask, 15 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };