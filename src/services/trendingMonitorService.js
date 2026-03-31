// src/services/trendingMonitorService.js
// 📝 檔案功能用途：隱形獵人爬蟲。每小時從 GeckoTerminal 獲取 Top 100，實裝「去重機制」解決 Primary Key 衝突，確保真假幣防偽表成功寫入。

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
let geckoErrorCount = 0;

const trendingMonitorService = {
    /**
     * 🌐 呼叫 GeckoTerminal 獲取 Pool 名單 (加大獲取量以備去重)
     */
    async fetchTop100FromGecko() {
        let allPools = [];
        console.log('🌐 [Gecko Crawler] 開始分批抓取 Top 150 榜單 (預留空間去重)...');

        // 擴大獲取至 6 頁 (約 180 個 Pool)，確保去重後依然有 100 隻 Token
        for (let page = 1; page <= 6; page++) {
            try {
                const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                const res = await axios.get(url, { headers: { 'accept': 'application/json' }, timeout: 8000 });
                
                if (res.data?.data) {
                    allPools = allPools.concat(res.data.data);
                }

                if (page < 6) await new Promise(r => setTimeout(r, 2000)); // 嚴格冷卻防 429
            } catch (err) {
                geckoErrorCount++;
                console.warn(`⚠️ [Gecko Crawler] 獲取第 ${page} 頁失敗 (${geckoErrorCount}/3):`, err.message);
                
                if (geckoErrorCount === 3) {
                    sendAdminAlert(`🚨 <b>爬蟲 API 連續故障</b>\n\n🦎 <b>供應商:</b> GeckoTerminal\n🔑 <b>陣亡變數:</b> <code>無 (公開 API)</code>\n❌ <b>錯誤:</b> 連續 3 次分頁獲取失敗！\n\nTrending 保溫箱暫時停止更新新幣。`);
                    geckoErrorCount = 0; 
                }
                break; 
            }
        }
        
        if (allPools.length > 0) geckoErrorCount = 0; 
        return allPools;
    },

    start() {
        console.log('🦎 [Gecko Crawler] 隱形獵人爬蟲已啟動 (每 1 小時大換血，附帶去重機制)...');
        
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
                const dynamicMinLiquidity = stratParams?.min_liquidity || 20000;

                const pools = await this.fetchTop100FromGecko();
                if (pools.length === 0) { isCrawlerRunning = false; return; }

                let top100Array = [];
                let incubatorArray = [];
                
                // 🚀 核心修復：使用 Set 追蹤已加入的 Token，防止同一個 Token 的多個 Pool 導致 Primary Key 衝突
                let uniqueMints = new Set();
                let currentRank = 1;

                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                for (let i = 0; i < pools.length; i++) {
                    const pool = pools[i];
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;
                    if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].includes(mintAddress)) continue;

                    // 🚨 去重過濾：如果這隻幣已經入咗榜，直接 Skip
                    if (uniqueMints.has(mintAddress)) continue;
                    uniqueMints.add(mintAddress);

                    // 如果已經集齊 100 隻不重複代幣，就停止
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

                    // 🛡️ 過濾 Rank 11-100 且達標的潛力幣進入保溫箱 (Rank 1-10 通常係 SOL, USDC 等)
                    if (currentRank >= 10 && liquidityUsd >= dynamicMinLiquidity) {
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

                // 3. 雙表同步 (Sync to Supabase) 增加 Error Logging
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
                        console.log(`🦎 [Gecko Crawler] 成功將 ${incubatorArray.length} 隻潛力幣送入保溫箱！`);
                        healthMonitor.setStatus('Top200_Crawler', `🟢 剛推平 ${incubatorArray.length} 隻幣`);
                        
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
        setInterval(runTask, 1 * 60 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };