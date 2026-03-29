// 確保路徑指啱你去你嘅 solana.js 檔案
// 假設你個 solana.js 喺 ./src/config/solana.js，如果唔係請自行修改路徑
const { connection } = require('../src/config/solana'); 

async function runTest() {
    console.log("=========================================");
    console.log("🚀 [Test] 開始測試 Solana 智能雙核 Router");
    console.log("=========================================\n");

    try {
        // 測試 1: 簡單查詢 (getSlot)
        console.log("📡 測試 1: 獲取最新區塊高度 (getSlot)...");
        const start1 = Date.now();
        const slot = await connection.getSlot();
        console.log(`✅ [成功] 區塊高度: ${slot} (耗時: ${Date.now() - start1}ms)\n`);

        // 測試 2: 買賣前必做嘅查詢 (getLatestBlockhash)
        console.log("📡 測試 2: 獲取最新 Blockhash (發射交易前必備)...");
        const start2 = Date.now();
        const blockhash = await connection.getLatestBlockhash();
        console.log(`✅ [成功] Blockhash: ${blockhash.blockhash.substring(0, 15)}... (耗時: ${Date.now() - start2}ms)\n`);

        console.log("🎉 [總結] 測試完美通過！Router 運作正常！");

    } catch (error) {
        console.error("\n❌ [測試失敗] 發生無法挽回嘅錯誤:", error.message);
    }
}

runTest();