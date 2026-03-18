const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * 發送 Telegram 訊息
 * @param {string} message - 要發送的文字訊息
 */
async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return; // 如果未設定，就靜靜地略過
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML' // 支援粗體 <b> 和斜體 <i>
        });
    } catch (err) {
        console.error(`❌ [Telegram] 發送失敗:`, err.message);
    }
}

module.exports = { sendTelegramAlert };