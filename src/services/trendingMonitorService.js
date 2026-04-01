// src/services/trendingMonitorService.js
// 📝 檔案功能用途：隱形獵人爬蟲。每 2 小時從 GeckoTerminal 獲取 Solana 真實 Volume Top 100，具備防 429 智能重試與去重機制。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');
const { trendingJob } = require('../jobs/trendingJob');
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

                    if (is429) {
                        const penaltyDelay = Math.floor(Math.random() * 5000) + 10000; 
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
                
                // 🟢 修正：將預設最低流動性要求由 150,000 改為 50,000 美金
                const dynamicMinLiquidity = stratParams?.min_liquidity || 50000; 

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

                for (let i = 0; i < pools.length; i++) {
                    const pool = pools[i];
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;
                    if (blacklist.includes(mintAddress)) continue;

                    if (uniqueMints.has(mintAddress)) continue;
                    uniqueMints.add(mintAddress);

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

                    // 🟢 修正：放寬 Rank 要求，由 Rank 1 至 Rank 100 全數納入考慮
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
        setInterval(runTask, 2 * 60 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };