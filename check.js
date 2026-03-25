const axios = require('axios');
require('dotenv').config();

async function getRealModelIds() {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
        const response = await axios.get(url);
        
        console.log("🔍 [照妖鏡] 你的 API Key 支援的真實 Model ID：\n");
        
        response.data.models.forEach(m => {
            // 我哋只過濾出你有興趣嘅 Gemini 3 同 Gemma 模型
            if (m.displayName.includes('2') || m.displayName.includes('Gemma 3')) {
                // 將 'models/' 前綴切走，剩低嘅就係寫 Code 要用嘅代號
                const realId = m.name.replace('models/', '');
                console.log(`👉 顯示名稱: ${m.displayName.padEnd(25)} | 💻 真正 API 代號: ${realId}`);
            }
        });
        console.log("\n✅ 檢查完畢！請將上面嘅【真正 API 代號】放入 aiService.js！");
    } catch (error) {
        console.error("❌ 查詢失敗:", error.message);
    }
}

getRealModelIds();