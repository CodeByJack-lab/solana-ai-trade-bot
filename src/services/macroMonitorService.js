// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

let pauseCooldownUntil = 0; 

const macroMonitorService = {
    /**
     * 💡 獲取高位回撤數據 (修正 CryptoCompare URL 路徑大小寫)
     */
    async fetchHighAndDrop(symbol) {
        const fsym = symbol.replace('USDT', '');
        
        // 🛡️ 修正點：將 histoMinute 改為 histominute (全細寫)
        const url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${fsym}&tsym=USD&limit=15`;
        
        // 1. 呼叫 CryptoCompare，超時設為 8 秒確保穩定
        const res = await axios.get(url, { timeout: 8000 });
        
        // 🛡️ 防禦 A：檢查 CryptoCompare 是否回傳業務錯誤
        if (res.data?.Response === 'Error') {
            throw new Error(`CryptoCompare 報錯: ${res.data.Message}`);
        }

        // 🛡️ 防禦 B：安全獲取 Data 陣列，防止 "not iterable" 錯誤
        const klines = res.data?.Data?.Data; 
        
        if (!klines || !Array.isArray(klines) || klines.length === 0) {
            throw new Error(`${symbol} 數據格式異常或陣列為空`);
        }
        
        let highestPrice = 0;
        for (const k of klines) {
            const high = parseFloat(k.high); // CryptoCompare 使用物件屬性 .high
            if (high > highestPrice) highestPrice = high;
        }
        
        const currentPrice = parseFloat(klines[klines.length - 1].close);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    start() {
        console.log(`🌍 [Macro] 雙龍大盤防禦雷達運作中 (CryptoCompare 全球數據源)...`);
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

                // 核心拉閘邏輯
                if (btcData.dropPct <= -2.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>BTC 崩盤預警 (CryptoCompare)</b>\n15分鐘高位: $${btcData.highestPrice}\n最新價格: $${btcData.currentPrice}\n回撤幅度: <b>${btcData.dropPct.toFixed(2)}%</b>`;
                } else if (solData.dropPct <= -3.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>SOL 崩盤預警 (CryptoCompare)</b>\n15分鐘高位: $${solData.highestPrice}\n最新價格: $${solData.currentPrice}\n回撤幅度: <b>${solData.dropPct.toFixed(2)}%</b>`;
                }

                if (triggered) {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    sendTelegramAlert(`${alertMsg}\n\n🛑 <b>系統動作</b>: 已自動關閉新交易總掣\n⏳ <b>狀態</b>: 進入 60 分鐘冷卻期`);
                    pauseCooldownUntil = now + (60 * 60 * 1000); 
                }
            } catch (err) {
                // 呢度會捕捉到所有「數據格式異常」或者「API 報錯」
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
            }
        }, 60 * 1000); 
    }
};

module.exports = { macroMonitorService };