// src/services/trendingMonitorService.js
const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');

let isCrawlerRunning = false;

const trendingMonitorService = {
    // 🌐 呼叫 GeckoTerminal 免費 API 獲取熱門池
    async fetchTrendingFromGecko() {
        try {
            const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools';
            const res = await axios.get(url, { 
                headers: { 'accept': 'application/json' }, 
                timeout: 8000 
            });
            return res.data?.data || [];
        } catch (err) {
            console.warn('⚠️ [Gecko Crawler] 獲取熱門榜失敗:', err.message);
            return [];
        }
    },

    start() {
        console.log('🦎 [Gecko Crawler] 熱門榜爬蟲已啟動 (每 10 分鐘出動尋找獵物)...');
        
        setInterval(async () => {
            if (isCrawlerRunning) return;
            isCrawlerRunning = true;

            try {
                // 1. 前置倉位檢查：如果 Trending 倉位已滿，爬蟲就休息，慳資源
                if (!canBuyTrending()) {
                    isCrawlerRunning = false;
                    return;
                }

                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config || !config.is_running) {
                    isCrawlerRunning = false;
                    return;
                }

                // 🚀 V8.2 核心修正：動態讀取 Database 中 Trending (ID=3) 的最新門檻，拒絕 Hardcode！
                const { data: stratParams } = await supabase.from('ai_strategy_params').select('min_liquidity').eq('id', 3).single();
                const dynamicMinLiquidity = stratParams?.min_liquidity || 40000;

                // 2. 獲取熱門池數據
                const pools = await this.fetchTrendingFromGecko();
                if (pools.length === 0) {
                    isCrawlerRunning = false;
                    return;
                }

                const portfolio = getPortfolio();
                const activePositions = portfolio.positions || [];
                const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

                let addedCount = 0;

                for (const pool of pools) {
                    const baseTokenId = pool.relationships?.base_token?.data?.id || '';
                    const mintAddress = baseTokenId.replace('solana_', ''); 
                    
                    if (!mintAddress || mintAddress.length < 32) continue;

                    // 過濾穩定幣與公鏈幣
                    if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(mintAddress)) {
                        continue;
                    }

                    const attr = pool.attributes || {};
                    const liquidityUsd = parseFloat(attr.reserve_in_usd) || 0;

                    // 🛡️ RAM 初篩：使用 Master AI 動態設定的門檻！
                    if (liquidityUsd < dynamicMinLiquidity) continue; 

                    // 檢查是否已持倉
                    const isHolding = activePositions.some(p => p.mint_address === mintAddress);
                    if (isHolding) continue;

                    // 檢查是否已經在保溫箱中排隊
                    const { data: existingInPool } = await supabase.from('trending_pool').select('mint_address').eq('mint_address', mintAddress).single();
                    if (existingInPool) continue;

                    // 🛡️ 智能冷卻防線：贏錢追擊，輸錢面壁 (24小時 / 7日)
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

                    // 3. 獵物入池！交由 trendingJob.js 進行安檢與 AI 審判
                    await supabase.from('trending_pool').insert([{
                        mint_address: mintAddress,
                        token_symbol: attr.name?.split(' /')[0] || 'UNKNOWN', 
                        token_name: attr.name || 'UNKNOWN',
                        liquidity: liquidityUsd,
                        volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                        price_change_24h: parseFloat(attr.price_change_percentage?.h24) || 0
                    }]);

                    addedCount++;
                    if (addedCount >= 5) break; 
                }

                if (addedCount > 0) {
                    console.log(`🦎 [Gecko Crawler] 成功將 ${addedCount} 隻潛力熱門幣扔入魚池 (動態過濾門檻: $${dynamicMinLiquidity})！`);
                }

            } catch (err) {
                console.error(`❌ [Gecko Crawler] 運行異常:`, err.message);
            } finally {
                isCrawlerRunning = false;
            }
        }, 10 * 60 * 1000); // 🚀 每 10 分鐘爬一次
    }
};

module.exports = { trendingMonitorService };