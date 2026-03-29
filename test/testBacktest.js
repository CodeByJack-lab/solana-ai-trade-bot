// test/testbacktest.js
const path = require('path');
// 確保載入到上一層根目錄嘅 .env 檔案
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

// 🔴 呢度！要用 ../src/ 走返出去，再去 jobs 搵檔案！
const { weeklyBacktestJob } = require('../src/jobs/weeklyBacktestJob');

async function runTest() {
    console.log("🧪 [Test Mode] 準備強制觸發高精度網格回測引擎...");
    console.log("======================================================\n");

    try {
        await weeklyBacktestJob.runBacktest();
        
        console.log("\n======================================================");
        console.log("✅ [Test Mode] 測試腳本順利跑完！");
        console.log("👉 請即刻 Check 下 Telegram 收唔收到「帶有按鈕」嘅回測報告！");
        console.log("👉 試下撳 [批准] 或者 [否決]，睇下大本營有冇俾反應！");
        process.exit(0); 
    } catch (error) {
        console.error("\n❌ [Test Mode] 測試過程發生嚴重錯誤:", error);
        process.exit(1);
    }
}

// 執行測試
runTest();