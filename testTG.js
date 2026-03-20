// testTG.js
const { sendTelegramAlert, sendAdminAlert } = require('./src/services/telegramService'); // 注意路徑是否需要改為 ./backend/services/telegramService

async function runTest() {
    console.log("🚀 [TG 測試] 開始發送訊號到 Telegram...");

    // 測試 1: 發送去 Main Bot (日常戰報)
    console.log("📨 測試 1: 正在呼叫 Main Bot...");
    await sendTelegramAlert("🟢 <b>[測試] 買入成功</b>\n這是一條來自 <b>Main Bot</b> 的日常交易戰報測試！\n代幣: $TEST\n狀態: 運作正常 ✅");

    // 測試 2: 發送去 Admin Bot (救火/警報)
    console.log("🚨 測試 2: 正在呼叫 Admin Bot...");
    await sendAdminAlert("🔴 <b>[測試] 系統警報</b>\n這是一條來自 <b>Admin Bot</b> 的系統管理員警告測試！\n狀態: 測試分流功能是否正常運作 ⚙️");

    console.log("✅ 測試指令已全部送出！請打開你嘅 Telegram 檢查下兩邊收唔收到。");
    
    // 等待 2 秒確保 Axios request 行完
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}

runTest();