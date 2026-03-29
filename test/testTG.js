// test-tg.js
const axios = require('axios');
require('dotenv').config();

// 讀取你 .env 嘅變數
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PERSONAL_ID = process.env.TELEGRAM_CHAT_ID;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

async function sendMsg(targetId, targetName) {
    if (!targetId) {
        console.log(`⚠️ 跳過 ${targetName} 測試：未設定 ID。`);
        return;
    }

    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const message = `🔔 <b>【${targetName} 連線測試】</b>\n\n狀態: 🟢 正常運作\n目標 ID: <code>${targetId}</code>`;

    try {
        await axios.post(url, {
            chat_id: targetId,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(`✅ 【成功】訊息已發送到 ${targetName} (${targetId})`);
    } catch (err) {
        console.error(`❌ 【失敗】${targetName} 發送失敗`);
        console.error(`原因: ${err.response?.data?.description || err.message}`);
    }
}

async function runTest() {
    console.log(`🚀 正在啟動 Telegram 雙路測試...`);
    
    if (!TOKEN) {
        console.error('❌ 錯誤: 缺少 TELEGRAM_BOT_TOKEN');
        return;
    }

    // 1. 測試個人私聊
    await sendMsg(PERSONAL_ID, "個人私聊 (TELEGRAM_CHAT_ID)");
    
    // 2. 測試頻道發送
    await sendMsg(CHANNEL_ID, "Telegram 頻道 (TELEGRAM_CHANNEL_ID)");

    console.log(`\n💡 如果 Channel 測試失敗，請檢查：`);
    console.log(`1. 隻 Bot 係咪已經加咗入 Channel 做 Admin。`);
    console.log(`2. CHANNEL_ID 係咪以 -100 開頭。`);
}

runTest();