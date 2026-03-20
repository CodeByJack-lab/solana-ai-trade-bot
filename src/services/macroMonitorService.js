// backend/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

let pauseCooldownUntil = 0; 

const macroMonitorService = {
    async fetchHighAndDrop(symbol) {
        const fsym = symbol.replace('USDT', '');
        // 💡 增加防護，確保 CryptoCompare 請求穩定
        const res = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoMinute?fsym=${fsym}&tsym=USD&limit=15`, { timeout: 8000 });
        
        // 🛡️ 安全獲取數據結構
        const klines = res.data?.Data?.Data; 
        
        if (!klines || !Array.isArray(klines) || klines.length === 0) {
            throw new Error(`${symbol} 數據格式異常`);
        }
        
        let highestPrice = 0;
        for (const k of klines) {
            const high = parseFloat(k.high);
            if (high > highestPrice) highestPrice = high;
        }
        
        const currentPrice = parseFloat(klines[klines.length - 1].close);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    start() {
        console.log(`🌍 [Macro] 雙龍雷達運作中 (CryptoCompare 數據源)...`);
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

                const [btcData, solData] = await Promise.all([
                    this.fetchHighAndDrop('BTCUSDT'),
                    this.fetchHighAndDrop('SOLUSDT')
                ]);

                healthMonitor.setStatus('Macro_Radar', '🟢 正常');

                let triggered = false;
                let alertMsg = '';

                if (btcData.dropPct <= -2.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>BTC 崩盤預警</b>\n15分鐘高位: $${btcData.highestPrice}\n回撤幅度: <b>${btcData.dropPct.toFixed(2)}%</b>`;
                } else if (solData.dropPct <= -3.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>SOL 崩盤預警</b>\n15分鐘高位: $${solData.highestPrice}\n回撤幅度: <b>${solData.dropPct.toFixed(2)}%</b>`;
                }

                if (triggered) {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌避險' }).eq('id', 1);
                    sendTelegramAlert(`${alertMsg}\n\n🛑 <b>動作</b>: 自動關閉總掣 60 分鐘`);
                    pauseCooldownUntil = now + (60 * 60 * 1000); 
                }
            } catch (err) {
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
            }
        }, 60 * 1000); 
    }
};

module.exports = { macroMonitorService };