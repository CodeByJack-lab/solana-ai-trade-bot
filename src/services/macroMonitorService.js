// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

let pauseCooldownUntil = 0; 

const macroMonitorService = {
    /**
     * 💡 獲取高位回撤數據 (改用 CoinGecko 免費源)
     * 支援 Railway 環境，無須 API Key
     */
    async fetchHighAndDrop(coinId) {
        // CoinGecko 市場圖表 API: 獲取最近 1 天的數據 (包含每小時/每分鐘切片)
        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        
        const res = await axios.get(url, { timeout: 10000 });
        
        // prices 結構: [[timestamp, price], [timestamp, price], ...]
        const prices = res.data?.prices;
        
        if (!prices || !Array.isArray(prices) || prices.length < 15) {
            throw new Error(`${coinId} CoinGecko 數據不足`);
        }
        
        // 取得最近 15 根數據的最高點 (約等於最近 1 小時內的高位)
        const recentPrices = prices.slice(-15);
        let highestPrice = 0;
        for (const p of recentPrices) {
            const price = parseFloat(p[1]);
            if (price > highestPrice) highestPrice = price;
        }
        
        const currentPrice = parseFloat(prices[prices.length - 1][1]);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    start() {
        console.log(`🌍 [Macro] 雙龍大盤防禦雷達運作中 (CoinGecko 數據源)...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 監聽中');

        // 改為每 3 分鐘檢查一次，避免觸發 CoinGecko 免費版 Rate Limit (10-30 calls/min)
        setInterval(async () => {
            const now = Date.now();
            
            if (now < pauseCooldownUntil) {
                healthMonitor.setStatus('Macro_Radar', '🟡 冷卻避險中');
                return; 
            }

            try {
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                // 同步獲取 BTC 同 SOL 數據
                const [btcData, solData] = await Promise.all([
                    this.fetchHighAndDrop('bitcoin'),
                    this.fetchHighAndDrop('solana')
                ]);

                healthMonitor.setStatus('Macro_Radar', '🟢 正常');

                let triggered = false;
                let alertMsg = '';

                // 核心拉閘邏輯
                if (btcData.dropPct <= -2.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>BTC 崩盤預警 (CoinGecko)</b>\n近期高位: $${btcData.highestPrice.toFixed(2)}\n最新價格: $${btcData.currentPrice.toFixed(2)}\n回撤幅度: <b>${btcData.dropPct.toFixed(2)}%</b>`;
                } else if (solData.dropPct <= -3.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>SOL 崩盤預警 (CoinGecko)</b>\n近期高位: $${solData.highestPrice.toFixed(2)}\n最新價格: $${solData.currentPrice.toFixed(2)}\n回撤幅度: <b>${solData.dropPct.toFixed(2)}%</b>`;
                }

                if (triggered) {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    sendTelegramAlert(`${alertMsg}\n\n🛑 <b>系統動作</b>: 已自動關閉新交易總掣\n⏳ <b>狀態</b>: 進入 60 分鐘冷卻期`);
                    pauseCooldownUntil = now + (60 * 60 * 1000); 
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] Error: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
            }
        }, 180000); // 180000ms = 3 分鐘
    }
};

module.exports = { macroMonitorService };