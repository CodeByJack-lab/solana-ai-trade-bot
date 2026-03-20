// backend/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

let pauseCooldownUntil = 0; 

const macroMonitorService = {
    /**
     * 💡 改用 CryptoCompare 獲取歷史數據 (避開 Binance 451 封鎖)
     */
    async fetchHighAndDrop(symbol) {
        // CryptoCompare 接口：獲取最近 15 分鐘的 K 線
        const fsym = symbol.replace('USDT', '');
        const res = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoMinute?fsym=${fsym}&tsym=USD&limit=15`, { timeout: 5000 });
        
        const klines = res.data.Data.Data; // CryptoCompare 數據結構
        
        let highestPrice = 0;
        for (const k of klines) {
            const high = parseFloat(k.high); // 取 1 分鐘最高價
            if (high > highestPrice) highestPrice = high;
        }
        
        const currentPrice = parseFloat(klines[klines.length - 1].close); // 最新收盤價
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    start() {
        console.log(`🌍 [Macro] 雙龍大盤防禦雷達已啟動 (CryptoCompare 數據源)...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 監控中');

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
                    this.fetchHighAndDrop('BTCUSDT'),
                    this.fetchHighAndDrop('SOLUSDT')
                ]);

                healthMonitor.setStatus('Macro_Radar', '🟢 正常');

                let triggered = false;
                let alertMsg = '';

                // 核心邏輯維持不變：BTC 跌 2% 或 SOL 跌 3% 即拉閘
                if (btcData.dropPct <= -2.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>BTC 崩盤預警 (CryptoCompare)</b>\n15分鐘高位: $${btcData.highestPrice.toLocaleString()}\n最新價格: $${btcData.currentPrice.toLocaleString()}\n回撤幅度: <b>${btcData.dropPct.toFixed(2)}%</b>`;
                } else if (solData.dropPct <= -3.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>SOL 崩盤預警 (CryptoCompare)</b>\n15分鐘高位: $${solData.highestPrice.toLocaleString()}\n最新價格: $${solData.currentPrice.toLocaleString()}\n回撤幅度: <b>${solData.dropPct.toFixed(2)}%</b>`;
                }

                if (triggered) {
                    console.log(`\n🛑 [Macro Alert] 偵測到系統性風險，緊急拉閘！`);
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    
                    sendTelegramAlert(`${alertMsg}\n\n🛑 <b>系統動作</b>: 已自動關閉新交易總掣\n⏳ <b>狀態</b>: 進入 60 分鐘冷卻期`);
                    
                    pauseCooldownUntil = now + (60 * 60 * 1000); 
                }
            } catch (err) {
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
            }
        }, 60 * 1000); 
    }
};

module.exports = { macroMonitorService };