// src/services/trendingMonitorService.js
const axios = require('axios');
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const trendingMonitorService = {
    async scanTrending() {
        console.log(`\n🔥 [Trending Radar] 啟動全網 Top 60 金狗分頁掃描...`);
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

            let allTrendingTokens = [];
            const offsets = [0, 20, 40]; // 擷取 0-19, 20-39, 40-59 (共 60 隻)

            for (const offset of offsets) {
                const url = `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=${offset}&limit=20`;
                
                try {
                    const response = await axios.get(url, {
                        headers: {
                            'X-API-KEY': BIRDEYE_API_KEY,
                            'x-chain': 'solana'
                        },
                        timeout: 8000
                    });

                    if (response.data && response.data.success && response.data.data.tokens) {
                        allTrendingTokens = allTrendingTokens.concat(response.data.data.tokens);
                        console.log(`   📥 成功拉取排名 ${offset + 1} - ${offset + 20} 的代幣`);
                    } else {
                        console.warn(`⚠️ [Trending Radar] Offset ${offset} 回傳格式異常`);
                    }
                } catch (pageErr) {
                    if (pageErr.response && pageErr.response.status === 429) {
                        console.warn(`⚠️ [Trending Radar] 拉取 Offset ${offset} 時觸發 429 限流，中斷後續分頁拉取。`);
                        break; 
                    } else {
                        console.warn(`⚠️ [Trending Radar] 拉取 Offset ${offset} 時發生錯誤: ${pageErr.message}`);
                        break;
                    }
                }

                if (offset !== offsets[offsets.length - 1]) {
                    console.log(`   ⏳ [API 保護] 冷卻 5 秒中...`);
                    await new Promise(r => setTimeout(r, 5000));
                }
            }

            if (allTrendingTokens.length === 0) {
                console.log(`❌ [Trending Radar] 無法獲取任何熱門代幣數據。`);
                healthMonitor.setStatus('Trending_Radar', `🔴 獲取數據失敗`);
                return;
            }

            let newAddedCount = 0;
            let ignoredBluechipCount = 0;
            let addedSymbols = []; // 🚀 新增：用來收集成功入池的代幣名稱

            // 過濾並寫入數據庫 (Trending Pool)
            for (const dog of allTrendingTokens) {
                const mint = dog.address;
                if (!mint || mint.length < 32) continue;
                
                if (dog.liquidity < 30000 || dog.volume24hUSD < 50000) continue;

                if (bluechipMints.has(mint)) {
                    ignoredBluechipCount++;
                    continue;
                }

                await supabase.from('trending_pool').upsert([{
                    mint_address: mint,
                    token_symbol: dog.symbol,
                    token_name: dog.name || 'UNKNOWN',
                    liquidity: dog.liquidity,
                    volume_24h: dog.volume24hUSD,
                    price_change_24h: dog.priceChange24h,
                    created_at: new Date().toISOString()
                }], { onConflict: 'mint_address' });
                
                newAddedCount++;
                addedSymbols.push(dog.symbol); // 🚀 收集代幣名稱
            }

            console.log(`✅ [Trending Radar] 掃描完畢！共分析 ${allTrendingTokens.length} 隻熱門幣。`);
            console.log(`   - 成功過濾並更新/寫入: ${newAddedCount} 隻潛力幣`);
            
            // 🚀 新增：將入池清單直接印出，一目了然！
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
        console.log(`🔥 [Trending Radar] 熱門爆升幣雷達已啟動 (Top 60 緩衝分頁版，每 30 分鐘運作)...`);
    }
};

module.exports = { trendingMonitorService };