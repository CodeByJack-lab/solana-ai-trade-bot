const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * 發送 Telegram 訊息 (具備 HTML 衝突自動修復機制)
 * @param {string} message - 要發送的文字訊息
 */
async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        // console.warn("⚠️ 尚未設定 Telegram Bot Token 或 Chat ID，略過發送。");
        return; 
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML' // 支援 HTML 標籤，例如 <b>粗體</b>
        });
        // console.log("📨 [Telegram] 訊息發送成功");
    } catch (err) {
        const errMsg = err.response?.data?.description || "";
        
        // 🚨 核心防護：如果因為 AI 理由入面有 < 或 > 符號導致 HTML 解析崩潰
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            console.warn(`⚠️ [Telegram] 偵測到 HTML 標籤衝突 (可能包含 < 或 >)，啟動純文字保底發送...`);
            try {
                // 將 <b>, <i> 等 HTML 標籤拔除，變成純文字發送，確保你一定收得到！
                const plainText = message.replace(/<[^>]+>/g, '');
                await axios.post(url, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: plainText
                });
            } catch (fallbackErr) {
                console.error(`❌ [Telegram] 純文字重發依然失敗:`, fallbackErr.response?.data || fallbackErr.message);
            }
        } else {
            console.error(`❌ [Telegram] 發送失敗:`, err.response?.data || err.message);
        }
    }
}

module.exports = { sendTelegramAlert };