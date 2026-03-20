// testAI.js
const { consensusService } = require('./src/services/consensusService');
const { initPortfolio } = require('./src/services/portfolioService');
const { healthMonitor } = require('./src/services/healthMonitor');

async function runTest() {
    console.log("🧪 [AI Test] 正在初始化環境並測試三白劍俠 API...");
    
    // 1. 初始化資料庫連線 (攞 Prompt)
    await initPortfolio();

    // 2. 模擬一隻通過保安亭嘅 Meme 幣數據
    const mockMint = "TestMint11111111111111111111111111111111111";
    const mockMarketData = {
        symbol: "TESTAI",
        name: "Test AI Coin",
        liquidity: 15000,
        vol5m: 5000,
        buys5m: 80,
        sells5m: 20,
        socials: "有 (X/Telegram)"
    };

    console.log(`\n🚀 [Test] 正在發送模擬請求到議事廳...`);
    console.log(`--- 參與 AI ---`);
    console.log(`⚡ 先鋒: Cerebras (llama3.1-8b)`);
    console.log(`🧠 軍師: Google (gemini-3.1-flash-lite)`);
    console.log(`⚖️ 判官: Groq (llama-3.3-70b)`);
    console.log(`---------------\n`);

    try {
        // 3. 執行會審邏輯 (會進入 Meme 專屬隊列)
        const result = await consensusService.runMemeConsensus(mockMint, mockMarketData, { isReentry: false });

        console.log(`\n🎉 [Test 結果]`);
        console.log(`✅ 是否買入: ${result.buy ? '🟢 BUY' : '🔴 SKIP'}`);
        console.log(`📝 最終理由: ${result.reason}`);
        
        console.log(`\n🩺 [看板狀態]`);
        console.log(healthMonitor.getHealthReport());

    } catch (err) {
        console.error(`\n❌ [Test 失敗] 偵測到 API 報錯:`, err.message);
        if (err.response) {
            console.error(`狀態碼: ${err.response.status}`);
            console.error(`詳細錯誤:`, JSON.stringify(err.response.data));
        }
    }

    process.exit(0);
}

runTest();