// src/testAiRoles.js
const { aiOrchestrator } = require('./src/services/aiOrchestrator');

async function runValidation() {
    console.log("🚀 [AI Validation] 啟動大腦岗位驗證程序...");
    console.log("💡 提示：你可以依家去 Supabase 改 ai_roles 嘅設定，觀察呢度嘅變化。\n");

    // 定義一個簡單嘅測試任務
    const testPrompt = "Please return a valid JSON: {\"status\": \"ok\"}. Keep reasoning under 5 words.";

    // 每 10 秒執行一次測試
    setInterval(async () => {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`--- [${timestamp}] 正在呼叫 OVERSEER 崗位 ---`);

        try {
            // 呼叫 OVERSEER (注意：Orchestrator 會自動根據 DB 決定用邊間廠，唔再理會傳入嘅 'GEMINI')
            const result = await aiOrchestrator.executeTask('OVERSEER', 'GEMINI', testPrompt);
            
            console.log(`✅ 成功回傳！`);
            console.log(`📍 實質使用模型: ${result.usedProvider}`);
            console.log(`🧠 AI 回應內容: ${JSON.stringify(result)}`);

        } catch (err) {
            console.error(`❌ 測試失敗: ${err.message}`);
        }
        console.log(`------------------------------------------\n`);
    }, 10000);
}

runValidation();