// src/services/trendingMonitorService.js
// 📝 檔案功能用途：隱形獵人爬蟲。每小時從 GeckoTerminal 獲取 Top 100，實裝「三振出局溯源」，失敗 3 次即 Alert 管理員。

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
let geckoErrorCount = 0; // 🎯 獨立錯誤計數器

const trendingMonitorService = {
    /**
     * 🌐 呼叫 GeckoTerminal 獲取 Top 100 名單 (帶三振出局)
     */
    async fetchTop100FromGecko() {
        let allPools = [];
        console.log('🌐 [Gecko Crawler] 開始分批抓取 Top 100 榜單...');

        for (let page = 1; page <= 5; page++) {
            try {
                const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                const res = await axios.get(url, { headers: { 'accept': 'application/json' }, timeout: 8000 });
                
                if (res.data?.data) {
                    allPools = allPools.concat(res.data.data);
                }

                if (allPools.length >= 100) {
                    allPools = allPools.slice(0, 100); 
                    break;
                }

                if (page < 5) await new Promise(r => setTimeout(r, 2000)); // 嚴格冷卻防 429
            } catch (err) {
                geckoErrorCount++;
                console.warn(`⚠️ [Gecko Crawler] 獲取第 ${page} 頁失敗 (${geckoErrorCount}/3):`, err.message);
                
                // 🚨 觸發三振出局 Alert
                if (geckoErrorCount === 3) {
                    sendAdminAlert(`🚨 <b>爬蟲 API 連續故障</b>\n\n🦎 <b>供應商:</b> GeckoTerminal\n🔑 <b>陣亡變數:</b> <code>無 (公開 API)</code>\n❌ <b>錯誤:</b> 連續 3 次分頁獲取失敗！\n\nTrending 保溫箱暫時停止更新新幣，但不影響現有持倉之平倉防線。`);
                    geckoErrorCount = 0; // 重置防止轟炸
                }
                break; 
            }
        }
        
        if (allPools.length > 0) geckoErrorCount = 0; // 成功則歸零
        return allPools;
    },

    start() {
        console.log('🦎 [Gecko Crawler] 隱形獵人爬蟲已啟動 (每 1 小時大換血，附帶三振保護)...');
        
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
                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                for (let i = 0; i < pools.length; i++) {
                    const pool = pools[i];
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;
                    if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].includes(mintAddress)) continue;

                    const attr = pool.attributes || {};
                    const liquidityUsd = parseFloat(attr.reserve_in_usd) || 0;
                    const symbol = attr.name?.split(' /')[0] || 'UNKNOWN';

                    const baseData = {
                        mint_address: mintAddress, token_symbol: symbol, token_name: attr.name || 'UNKNOWN',
                        liquidity: liquidityUsd, volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                        price_change_24h: parseFloat(attr.price_change_percentage?.h24) || 0, updated_at: new Date().toISOString()
                    };

                    top100Array.push({ ...baseData, rank: i + 1 });

                    if (i >= 10 && liquidityUsd >= dynamicMinLiquidity) {
                        const isBlacklisted = await redis.get(`scam_blacklist:${mintAddress}`);
                        if (isBlacklisted) continue;

                        const isHolding = activePositions.some(p => p.mint_address === mintAddress);
                        if (isHolding) continue;

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
                        if (isOnCooldown) continue;

                        incubatorArray.push(baseData);
                    }
                }

                if (top100Array.length > 0) {
                    await supabase.from('trending_top100').delete().neq('mint_address', 'dummy'); 
                    await supabase.from('trending_top100').insert(top100Array);
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