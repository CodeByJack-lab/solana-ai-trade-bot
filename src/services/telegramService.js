// src/services/telegramService.js
const axios = require('axios');
const path = require('path');
const configEnv = require('../config/env');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 📈 交易戰報 Bot (Main)
const TRADE_BOT_TOKEN = configEnv.telegram.mainBotToken;
const TRADE_CHAT_ID = configEnv.telegram.channelId;

// ⚙️ 系統管理員 Bot (Admin)
const ADMIN_BOT_TOKEN = configEnv.telegram.adminBotToken;
const ADMIN_CHAT_ID = configEnv.telegram.chatId;

function safeHTML(text) {
    if (!text) return "";
    return text.toString().replace(/</g, '＜').replace(/>/g, '＞');
}

async function _send(message, token, chatId) {
    if (!token || !chatId) return;

    let finalMessage = message;
    if (finalMessage.length > 4000) {
        finalMessage = finalMessage.substring(0, 4000) + "\n\n... ✂️ (報告過長，已由系統自動截斷)";
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await axios.post(url, { 
            chat_id: chatId, 
            text: finalMessage, 
            parse_mode: 'HTML' 
        });
    } catch (err) {
        const errMsg = err.response?.data?.description || err.message || "";
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            try {
                const plainText = finalMessage.replace(/<[^>]+>/g, '');
                await axios.post(url, { chat_id: chatId, text: plainText });
            } catch (fallbackErr) {
                console.error("❌ [Telegram] 備援純文字發送也失敗:", fallbackErr.response?.data?.description || fallbackErr.message);
            }
        } else {
            console.error(`❌ [Telegram] 發送失敗 (${chatId}):`, errMsg);
        }
    }
}

async function sendTelegramAlert(message) {
    await _send(message, TRADE_BOT_TOKEN, TRADE_CHAT_ID);
}

async function sendAdminAlert(message) {
    const token = ADMIN_BOT_TOKEN || TRADE_BOT_TOKEN;
    const chat = ADMIN_CHAT_ID || TRADE_CHAT_ID;
    await _send(message, token, chat);
}

// ==========================================
// 🛡️ 健康看板 1 分鐘延遲防 Spam 系統
// ==========================================
let lastErrorState = "";
let errorStartTime = 0;
let hasAlertedError = false;

function checkSystemHealth() {
    const { healthMonitor } = require('./healthMonitor'); 
    const report = healthMonitor.getHealthReport();
    
    const lines = report.split('\n');
    const currentErrors = lines.filter(l => l.includes('🔴') || l.includes('🟡')).join('\n');
    
    if (currentErrors !== "") {
        // 有錯誤發生
        if (currentErrors !== lastErrorState) {
            // 新的錯誤，開始計時，不立即報警
            lastErrorState = currentErrors;
            errorStartTime = Date.now();
            hasAlertedError = false;
        } else if (!hasAlertedError && (Date.now() - errorStartTime > 60000)) {
            // 🚀 [新增] 相同錯誤持續超過 1 分鐘 -> 發送警報！
            const cleanReport = safeHTML(report);
            const alertMsg = `🚨 <b>【系統故障警告】偵測到持續 1 分鐘以上的異常！</b>\n請即刻檢查伺服器狀態！\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
            sendAdminAlert(alertMsg);
            hasAlertedError = true; // 標記已發送，防止每 20 秒洗版
        }
    } else {
        // 恢復全綠
        if (lastErrorState !== "") {
            if (hasAlertedError) {
                // 🚀 [新增] 如果之前有報警，依家好返，先至 send 恢復通知
                const cleanReport = safeHTML(report);
                const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已穩定超過 1 分鐘！解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
                sendAdminAlert(recoveryMsg);
            }
            // 清空狀態
            lastErrorState = "";
            errorStartTime = 0;
            hasAlertedError = false;
        }
    }
}

// 🚀 [新增] 每 20 秒 Check，滿足 60 秒條件先 Send
setInterval(checkSystemHealth, 20 * 1000);

async function sendParamSnapshot() {
    const { supabase } = require('../config/supabase');
    try {
        const { data: p1 } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
        const { data: p2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
        const { data: cfg } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();

        const msg = `\n📋 <b>當前系統參數快照</b>\n━━━━━━━━━━━━━━━━━━\n🏛️ <b>老幣防線 (Bluechip)</b>\n- 最低流動性: $${p1?.min_liquidity || 0}\n- 5分量: $${p1?.min_vol_5m || 0}\n- RSI 門檻: < ${p1?.bluechip_max_rsi || 0}\n\n🔫 <b>新幣盲狙 (Meme)</b>\n- 最低流動性: $${p2?.min_liquidity || 0}\n- 5分量: $${p2?.min_vol_5m || 0}\n- 泡沫比(Liq/FDV): ${((p2?.min_liq_fdv_ratio || 0) * 100).toFixed(1)}%\n\n🌍 <b>宏觀環境</b>\n- AI 災難指數: ${cfg?.latest_news_score || 0}/100\n━━━━━━━━━━━━━━━━━━`;
        sendAdminAlert(msg);
    } catch (err) {
        console.error("❌ 無法獲取參數快照:", err.message);
    }
}

module.exports = { sendTelegramAlert, sendAdminAlert, sendParamSnapshot, safeHTML };