const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// 👈 喺度改返你想用嚟 Check 嗰條 Key 嘅變數名 (例如 GEMINI_API_KEY_1)
const KEY_NAME = 'GEMINI_API_KEY_1'; 

async function listModels() {
    const apiKey = process.env[KEY_NAME];
    
    if (!apiKey) {
        console.error(`❌ 錯誤：喺 .env 搵唔到 ${KEY_NAME}，請檢查 File 是否存在。`);
        return;
    }

    try {
        // 使用 v1beta 接口獲取最完整的清單
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await axios.get(url);
        
        console.log(`\n=== 🔍 [${KEY_NAME}] 可用的 Model ID 清單 ===\n`);
        
        const models = response.data.models || [];
        
        models.forEach(m => {
            const realId = m.name.replace('models/', '');
            
            // 只列出支援 generateContent 嘅模型（即係可以用落你隻 Bot 嘅大腦）
            if (m.supportedGenerationMethods.includes('generateContent')) {
                console.log(`👉 代碼: ${realId.padEnd(35)} | 名稱: ${m.displayName}`);
            }
        });

        console.log("\n✅ 掃描完畢！請將上面【代碼】一欄嘅文字（例如 gemini-1.5-flash）");
        console.log("放入 Supabase 的 ai_roles 表格中對應的 model_1 或 model_2。");

    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error(`❌ 查詢失敗: ${errorMsg}`);
    }
}

listModels();