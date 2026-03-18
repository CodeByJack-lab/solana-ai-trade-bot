const axios = require('axios');
const { supabase } = require('../config/supabase'); // 🚀 完美修復大括號
const { analyzeMacroTrend } = require('./aiService');
const { sendTelegramAlert } = require('./telegramService');

let btcHistory = []; 
let pauseCooldownUntil = 0; 

async function startBtcMonitor() {
    console.log(`🌍 [Macro] 啟動 Bitcoin 大盤防禦雷達 (加入手動 Override 冷卻機制)...`);
    
    setInterval(async () => {
        try {
            const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).maybeSingle();
            if (!config?.is_running) return;

            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 });
            const currentPrice = parseFloat(response.data.price);
            const now = Date.now();

            btcHistory.push({ timestamp: now, price: currentPrice });
            btcHistory = btcHistory.filter(h => now - h.timestamp <= 30 * 60 * 1000);

            if (now < pauseCooldownUntil) {
                const remainingMins = Math.ceil((pauseCooldownUntil - now) / 60000);
                if (remainingMins % 15 === 0) {
                    console.log(`⏳ [Macro] 大盤警報處於冷卻期 (剩餘 ${remainingMins} 分鐘)...`);
                }
                return; 
            }

            const pastData = btcHistory.find(h => now - h.timestamp >= 14 * 60 * 1000); 

            if (pastData) {
                const changePct = ((currentPrice - pastData.price) / pastData.price) * 100;

                if (Math.abs(changePct) >= 2.0) {
                    console.log(`\n🚨 [Macro Alert] 偵測到 BTC 劇烈波動: ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}% (現價: $${currentPrice})`);
                    
                    const aiDecision = await analyzeMacroTrend(changePct, currentPrice, 15);

                    if (aiDecision.pause) {
                        console.log(`🛡️ [System] AI 建議避險，正在關閉新交易總掣...`);
                        
                        await supabase.from('system_config').update({ is_running: false }).eq('id', 1);
                        
                        const directionIcon = changePct > 0 ? '📈' : '📉';
                        sendTelegramAlert(`
🚨 <b>大盤緊急避險觸發</b>
${directionIcon} <b>BTC 劇烈波動</b>: ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}% (15分鐘內)
💲 <b>最新價格</b>: $${currentPrice.toLocaleString()}
🛑 <b>系統動作</b>: 已自動暫停接收新交易
⏳ <b>狀態</b>: 進入 60 分鐘冷卻期
🧠 <b>AI 分析</b>: ${aiDecision.reason}
                        `);
                        
                        pauseCooldownUntil = now + (60 * 60 * 1000); 
                        btcHistory = []; 
                    }
                }
            }
        } catch (err) {}
    }, 3 * 60 * 1000); 
}

module.exports = { startBtcMonitor };