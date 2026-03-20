// src/services/telegramService.js
const axios = require('axios');
const path = require('path');
const { healthMonitor } = require('./healthMonitor'); // 🩺 引入看板讀取狀態
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 📈 交易戰報 Bot (Main) - 舊有不變
const TRADE_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TRADE_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ⚙️ 系統管理員 Bot (Admin) - 使用新命名，如果未設定，自動 Fallback 用 Main Bot
const ADMIN_BOT_TOKEN = process.env.TELEGRAM_ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

/**
 * 底層發送邏輯 (防 HTML 衝突)
 */
async function _send(message, token, chatId) {
    if (!token || !chatId) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: message, parse_mode: 'HTML' });
    } catch (err) {
        const errMsg = err.response?.data?.description || "";
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            try {
                const plainText = message.replace(/<[^>]+>/g, '');
                await axios.post(url, { chat_id: chatId, text: plainText });
            } catch (fallbackErr) {
                console.error(`❌ [Telegram] 純文字發送失敗:`, fallbackErr.message);
            }
        } else {
            console.error(`❌ [Telegram] 發送失敗:`, err.message);
        }
    }
}

/**
 * 📈 供 tradeService 等發送日常交易戰報 (維持舊有函數名，無痛兼容)
 */
async function sendTelegramAlert(message) {
    return _send(message, TRADE_BOT_TOKEN, TRADE_CHAT_ID);
}

/**
 * ⚙️ 供系統發送維護、警告、報錯 (Admin 專屬)
 */
async function sendAdminAlert(message) {
    return _send(message, ADMIN_BOT_TOKEN, ADMIN_CHAT_ID);
}

// ==========================================
// ⏰ 1. API Key 到期提醒排程 (每 55 日)
// ==========================================
const START_DATE = new Date('2026-03-20T00:00:00+08:00'); // 起點：2026年3月20日
let lastReminderDay = -1;

function checkApiKeyExpiration() {
    const now = new Date();
    const diffTime = now - START_DATE;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 0 && diffDays % 55 === 0 && lastReminderDay !== diffDays) {
        lastReminderDay = diffDays;
        const alertMsg = `
⚠️ <b>【系統維護提醒】API Key 換證期到了！</b>
📅 距離上次設定已過 <b>${diffDays}</b> 日。
🔑 <b>GROQ</b> 及 <b>MISTRAL</b> 嘅 API Key 只有 90 日壽命，即將失效！
👉 請盡快去官網 Generate 新 Key，並更新至 Railway 變數！
        `;
        sendAdminAlert(alertMsg.trim());
    }
}
checkApiKeyExpiration();
setInterval(checkApiKeyExpiration, 12 * 60 * 60 * 1000); 

// ==========================================
// 🩺 2. 系統健康看板防呆監控 (捕捉 🔴 故障)
// ==========================================
let lastErrorState = "";

function checkSystemHealth() {
    const report = healthMonitor.getHealthReport();
    
    if (report.includes('🔴')) {
        // 抽取出具體死咗邊條 Line，用作防重複比對
        const currentErrors = report.split('\n').filter(line => line.includes('🔴')).join('\n');

        // 如果出現咗「新」嘅錯誤組合，先會觸發 TG Alert (防每分鐘轟炸)
        if (currentErrors !== lastErrorState) {
            const alertMsg = `🚨 <b>【系統故障警告】偵測到模組異常！</b>\n\n🩺 <b>當前看板狀態：</b>\n${report}`;
            sendAdminAlert(alertMsg);
            lastErrorState = currentErrors; 
        }
    } else {
        // 如果全部恢復正常 (無 🔴)，且之前有報過錯
        if (lastErrorState !== "") {
            const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${report}`;
            sendAdminAlert(recoveryMsg);
            lastErrorState = ""; // 清空錯誤紀錄
        }
    }
}
// 系統啟動後，每 60 秒巡邏一次健康看板
setInterval(checkSystemHealth, 60 * 1000);

module.exports = { sendTelegramAlert, sendAdminAlert };