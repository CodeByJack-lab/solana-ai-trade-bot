// src/services/trendingMonitorService.js
const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');

let isCrawlerRunning = false;

const trendingMonitorService = {
    // 🌐 呼叫 GeckoTerminal 獲取「真實交易量 (Volume)」最高嘅 Top 200 池 (Page 1-10)
    async fetchTrendingFromGecko() {
        let allPools = [];
        console.log('🌐 [Gecko Crawler] 開始分頁抓取 Top 200 真實交易榜單 (Page 1-10)...');

        for (let page = 1; page <= 10; page++) {
            try {
                const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                const res = await axios.get(url, { 
                    headers: { 'accept': 'application/json' }, 
                    timeout: 8000 
                });
                
                if (res.data?.data) {
                    allPools = allPools.concat(res.data.data);
                }

                // 🚦 [防 429 護盾] 每爬一頁，強制休息 1.5 秒
                if (page < 10) {
                    await new Promise(r => setTimeout(r, 1500));
                }
            } catch (err) {
                console.warn(`⚠️ [Gecko Crawler] 獲取第 ${page} 頁失敗，提早結束爬蟲:`, err.message);
                break; // 如果中咗 429，就拎住手上現有嘅 Data 繼續去馬，唔好死谷
            }
        }
        return allPools;
    },

    start() {
        console.log('🦎 [Gecko Crawler] 藍籌熱門榜爬蟲已啟動 (開機即時執行 + 每 2 小時大換血)...');
        
        // 🚀 [核心修復] 將邏輯包裝成獨立 Function
        const runTask = async () => {
            if (isCrawlerRunning) return;
            isCrawlerRunning = true;

            try {
                // 1. 前置倉位檢查：如果 Trending 倉位已滿，爬蟲就休息，慳資源
                if (!canBuyTrending()) {
                    console.log('⏸️ [Gecko Crawler] Trending 倉位已滿，跳過本次榜單更新。');
                    isCrawlerRunning = false;
                    return;
                }

                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config || !config.is_running) {
                    isCrawlerRunning = false;
                    return;
                }

                // 動態讀取 Database 中 Trending (ID=3) 的最新門檻！(現為 15萬美金)
                const { data: stratParams } = await supabase.from('ai_strategy_params').select('min_liquidity').eq('id', 3).single();
                const dynamicMinLiquidity = stratParams?.min_liquidity || 150000;

                // 2. 獲取熱門池數據 (已升級為 1-10 頁批量獲取)
                const pools = await this.fetchTrendingFromGecko();
                if (pools.length === 0) {
                    isCrawlerRunning = false;
                    return;
                }

                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                let upsertArray = []; 

                for (const pool of pools) {
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;

                    if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(mintAddress)) continue;

                    const attr = pool.attributes || {};
                    const liquidityUsd = parseFloat(attr.reserve_in_usd) || 0;

                    // 🛡️ RAM 初篩：使用 Master AI 動態設定的門檻！
                    if (liquidityUsd < dynamicMinLiquidity) continue; 

                    const isHolding = activePositions.some(p => p.mint_address === mintAddress);
                    if (isHolding) continue;

                    // 🛡️ 智能冷卻防線
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
                        
                        if (lastTrade.realized_pnl_pct < 0) {
                            const isLoss2 = tradeHistory.length > 1 && tradeHistory[1].realized_pnl_pct < 0;
                            if (isLoss2 && timeSinceLastTrade < 7 * 24 * 60 * 60 * 1000) isOnCooldown = true; 
                            else if (!isLoss2 && timeSinceLastTrade < 24 * 60 * 60 * 1000) isOnCooldown = true; 
                        }
                    }

                    if (isOnCooldown) continue;

                    upsertArray.push({
                        mint_address: mintAddress,
                        token_symbol: attr.name?.split(' /')[0] || 'UNKNOWN', 
                        token_name: attr.name || 'UNKNOWN',
                        liquidity: liquidityUsd,
                        volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                        price_change_24h: parseFloat(attr.price_change_percentage?.h24) || 0,
                        updated_at: new Date().toISOString()
                    });

                    if (upsertArray.length >= 200) break; 
                }

                // 3. 一次過批量 Upsert 入 Database！
                if (upsertArray.length > 0) {
                    const { error } = await supabase.from('trending_pool').upsert(
                        upsertArray, 
                        { onConflict: 'mint_address' }
                    );
                    
                    if (error) {
                        console.error(`❌ [Gecko Crawler] 批量 Upsert 寫入魚池失敗:`, error.message);
                        healthMonitor.setStatus('Top200_Crawler', '🔴 批量寫入失敗');
                    } else {
                        console.log(`🦎 [Gecko Crawler] 掃貨！成功將 ${upsertArray.length} 隻 Top 200 藍籌幣 Upsert 入魚池 (門檻: $${dynamicMinLiquidity})！`);
                        healthMonitor.setStatus('Top200_Crawler', `🟢 剛推平 ${upsertArray.length} 隻幣`);
                    }
                }

            } catch (err) {
                console.error(`❌ [Gecko Crawler] 運行異常:`, err.message);
            } finally {
                isCrawlerRunning = false;
            }
        };

        // 🚀 [核心修復] Bot 著機即刻強迫隻爬蟲行一次！
        setTimeout(() => {
            console.log('🦎 [Gecko Crawler] 執行開機首次強制掃描...');
            runTask();
        }, 5000); // 畀系統 5 秒鐘 Init Database 連線先

        // 然後先開始每 2 小時嘅循環
        setInterval(runTask, 2 * 60 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };
