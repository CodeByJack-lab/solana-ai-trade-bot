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
        console.log(`\n🔥 [Trending Radar] 啟動全網 Top 50 金狗掃描...`);
        healthMonitor.setStatus('Trending_Radar', '🟢 掃描中...');

        try {
            // 1. 獲取大盤狀態 (極度恐慌時停止掃描，防止高位接飛刀)
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

            // 🚀 新增：獲取老幣 (Bluechip) 名單，防止部門搶客撞幣
            const { data: bluechips } = await supabase.from('bluechip_pool').select('mint_address');
            const bluechipMints = new Set(bluechips?.map(b => b.mint_address) || []);

            // 2. 呼叫 Birdeye Trending API (獲取 Solana 鏈上 Top 50)
            const url = `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=50`;
            const response = await axios.get(url, {
                headers: {
                    'X-API-KEY': BIRDEYE_API_KEY,
                    'x-chain': 'solana'
                },
                timeout: 8000
            });

            if (!response.data || !response.data.success) {
                throw new Error('Birdeye API 回傳格式異常');
            }

            const top50 = response.data.data.tokens;
            if (!top50 || top50.length === 0) return;

            // 3. 過濾並寫入數據庫 (Trending Pool)
            let newAddedCount = 0;
            let ignoredBluechipCount = 0;

            for (const dog of top50) {
                const mint = dog.address;
                if (!mint || mint.length < 32) continue;
                
                // 基礎流動性與交易量過濾 (太細嘅唔要)
                if (dog.liquidity < 30000 || dog.volume24hUSD < 50000) continue;

                // 🚀 核心防撞機制：如果隻幣已經喺老幣名單，直接飛走！
                if (bluechipMints.has(mint)) {
                    ignoredBluechipCount++;
                    continue;
                }

                // 🚀 修復 Bug 1：改用 upsert，防止 Unique Constraint Violation 卡死系統
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
            }

            console.log(`✅ [Trending Radar] 掃描完畢！`);
            console.log(`   - 成功更新/寫入: ${newAddedCount} 隻熱門幣`);
            if (ignoredBluechipCount > 0) {
                console.log(`   - 已跳過 ${ignoredBluechipCount} 隻老幣 (交由 Bluechip 部門處理)`);
            }

            healthMonitor.setStatus('Trending_Radar', '🟢 待機中 (每15分鐘掃描)');

        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.warn(`⚠️ [Trending Radar] Birdeye API 限流 (429)，將於下個週期重試。`);
                healthMonitor.setStatus('Trending_Radar', `🟡 API 限流`);
            } else {
                console.error(`❌ [Trending Radar] 掃描失敗:`, error.message);
                healthMonitor.setStatus('Trending_Radar', `🔴 異常: ${error.message}`);
            }
        }
    },

    start() {
        // 設定每 15 分鐘執行一次
        cron.schedule('*/15 * * * *', () => {
            this.scanTrending();
        });
        console.log(`🔥 [Trending Radar] Top 50 爆升幣雷達已啟動...`);
    }
};

module.exports = { trendingMonitorService };