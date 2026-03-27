// src/services/trendingMonitorService.js
const axios = require('axios');
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
// 👇👇👇 [V7.0 新增] 引入 Price Oracle 進行批次查價
const { priceOracleService } = require('./priceOracleService');
// 👆👆👆
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const trendingMonitorService = {
    async scanTrending() {
        console.log(`\n🔥 [Trending Radar] 啟動全網金狗海選掃描 (GeckoTerminal 免費版)...`);
        healthMonitor.setStatus('Trending_Radar', '🟢 掃描中...');

        try {
            const { data: config } = await supabase.from('system_config').select('latest_news_score, is_running').eq('id', 1).single();
            if (!config?.is_running) {
                healthMonitor.setStatus('Trending_Radar', '🟡 系統暫停中');
                return;
            }
            if (config?.latest_news_score > 70) {
                console.log(`🛡️ [Trending Radar] 大盤災難指數過高 (${config.latest_news_score})，暫停掃描熱門 Meme 幣防禦風險。`);
                healthMonitor.setStatus('Trending_Radar', '🟡 大盤恐慌避險中');
                return;
            }

            const { data: bluechips } = await supabase.from('bluechip_pool').select('mint_address');
            const bluechipMints = new Set(bluechips?.map(b => b.mint_address) || []);

            // ==============================================================
            // 🚀 V7.0 升級 1：飛起 Birdeye，改用 GeckoTerminal 免費榜單
            // ==============================================================
            let trendingMints = [];
            try {
                const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools`;
                const response = await axios.get(url, {
                    headers: { 'Accept': 'application/json' },
                    timeout: 8000
                });

                if (response.data && response.data.data) {
                    const pools = response.data.data;
                    for (const pool of pools) {
                        // GeckoTerminal 的 token ID 格式通常為 "solana_MINTADDRESS"
                        const tokenId = pool.relationships?.base_token?.data?.id;
                        if (tokenId && tokenId.includes('_')) {
                            const mint = tokenId.split('_')[1];
                            if (mint && mint.length >= 32 && mint !== 'So11111111111111111111111111111111111111112') {
                                trendingMints.push(mint);
                            }
                        }
                    }
                    console.log(`   📥 成功從 GeckoTerminal 獲取 ${trendingMints.length} 隻熱門代幣地址`);
                }
            } catch (err) {
                console.error(`❌ [Trending Radar] 獲取 GeckoTerminal 數據失敗:`, err.message);
                healthMonitor.setStatus('Trending_Radar', `🔴 獲取數據失敗`);
                return;
            }

            if (trendingMints.length === 0) {
                console.log(`❌ [Trending Radar] 無法解析任何熱門代幣。`);
                return;
            }

            // ==============================================================
            // 🚀 V7.0 升級 2：掟入 Oracle 坐 10 秒大巴，一次過獲取豐富數據
            // ==============================================================
            console.log(`   🚌 將 ${trendingMints.length} 隻代幣送入 Oracle 批次查價...`);
            const pricesMap = await priceOracleService.getPrices(trendingMints);

            let newAddedCount = 0;
            let ignoredBluechipCount = 0;
            let addedSymbols = []; 

            // ==============================================================
            // 🚀 V7.0 升級 3：死水過濾 (Dead Water Filter)
            // ==============================================================
            for (const mint of trendingMints) {
                if (bluechipMints.has(mint)) {
                    ignoredBluechipCount++;
                    continue;
                }

                const dog = pricesMap[mint];
                
                // 1. 如果 Oracle 查無報價，或者 5分鐘成交量係 0 (死水)，直接扔！
                if (!dog || dog.priceUsd === 0 || dog.volume5m === 0) continue;
                
                // 2. 流動性硬指標 (熱門榜單要求流動性至少 3萬美金)
                if (dog.liquidity < 30000) continue;

                // 寫入數據庫 (Trending Pool)
                await supabase.from('trending_pool').upsert([{
                    mint_address: mint,
                    token_symbol: dog.symbol,
                    token_name: dog.name,
                    liquidity: dog.liquidity,
                    volume_24h: dog.volume5m * 288, // 粗略估算 24h 量，供舊版 DB 相容
                    price_change_24h: 0, // Oracle 暫未緩存此欄位，給預設值
                    created_at: new Date().toISOString()
                }], { onConflict: 'mint_address' });
                
                newAddedCount++;
                addedSymbols.push(dog.symbol);
            }

            console.log(`✅ [Trending Radar] 掃描與過濾完畢！共分析 ${trendingMints.length} 隻熱門幣。`);
            console.log(`   - 成功過濾並入池: ${newAddedCount} 隻潛力幣 (無死水)`);
            
            if (addedSymbols.length > 0) {
                console.log(`   🏷️ 入池清單: ${addedSymbols.join(', ')}`);
            }

            if (ignoredBluechipCount > 0) {
                console.log(`   - 已跳過 ${ignoredBluechipCount} 隻老幣 (交由 Bluechip 部門處理)`);
            }

            healthMonitor.setStatus('Trending_Radar', '🟢 待機中 (每30分鐘掃描)');

        } catch (error) {
            console.error(`❌ [Trending Radar] 掃描主迴圈失敗:`, error.message);
            healthMonitor.setStatus('Trending_Radar', `🔴 異常: ${error.message}`);
        }
    },

    start() {
        cron.schedule('*/30 * * * *', () => {
            this.scanTrending();
        });
        console.log(`🔥 [Trending Radar] GeckoTerminal 海選雷達已啟動 (每 30 分鐘運作)...`);
    }
};

module.exports = { trendingMonitorService };