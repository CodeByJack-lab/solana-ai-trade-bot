// src/services/telegramService.js
const axios = require('axios');
const path = require('path');
const configEnv = require('../config/env');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 📈 交易戰報 Bot (Main) -> 對應 TELEGRAM_CHANNEL_ID
const TRADE_BOT_TOKEN = configEnv.telegram.mainBotToken;
const TRADE_CHAT_ID = configEnv.telegram.channelId; // 👈 修正：改為 channelId

// ⚙️ 系統管理員 Bot (Admin) -> 對應 TELEGRAM_CHAT_ID
const ADMIN_BOT_TOKEN = configEnv.telegram.adminBotToken;
const ADMIN_CHAT_ID = configEnv.telegram.chatId; // 👈 修正：改為 chatId

/**
 * 🚀 安全清洗函數：防止 AI 輸出的 < 或 > 破壞 HTML 看板結構
 */
function safeHTML(text) {
    if (!text) return "";
    return text.toString().replace(/</g, '＜').replace(/>/g, '＞');
}

/**
 * 🚀 底層發送邏輯 (防 HTML 衝突 + 4000 字元超長截斷裝甲)
 */
async function _send(message, token, chatId) {
    if (!token || !chatId) return;

    // 🛡️ V7.2 核心修復：Telegram 訊息有 4096 字元限制，AI 報告通常會超標！
    // 強制喺 4000 字元截斷，防止 400 Bad Request 導致靜默失敗
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
        
        // 🛡️ 如果 AI 吐出的內容帶有奇怪的 HTML tags 導致 parse error，觸發降級為純文字
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            try {
                // 抹除所有 HTML 標籤後重新發送
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
// 🛡️ 健康看板巡邏系統
// ==========================================
let lastErrorState = "";

function checkSystemHealth() {
    // 👈 [核心修復] 動態載入，打破循環依賴
    const { healthMonitor } = require('./healthMonitor'); 
    
    const report = healthMonitor.getHealthReport();
    const hasError = report.includes('🔴') || report.includes('🟡');
    
    if (hasError) {
        const lines = report.split('\n');
        let currentErrors = lines.filter(l => l.includes('🔴') || l.includes('🟡')).join('\n');
        
        if (currentErrors !== lastErrorState) {
            const cleanReport = safeHTML(report);
            const alertMsg = `🚨 <b>【系統故障警告】偵測到模組異常！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
            sendAdminAlert(alertMsg);
            lastErrorState = currentErrors; 
        }
    } else {
        if (lastErrorState !== "") {
            const cleanReport = safeHTML(report);
            const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
            sendAdminAlert(recoveryMsg);
            lastErrorState = ""; 
        }
    }
}

// 每 10 分鐘巡邏一次健康看板
setInterval(checkSystemHealth, 10 * 60 * 1000);

/**
 * 📋 傳送簡潔版參數快照
 */
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