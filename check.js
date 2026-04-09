// check_gemini_models.js
// 📝 用途：一鍵查詢你個 API Key 可以調用嘅所有 Gemini / Gemma 模型名稱。

const axios = require('axios');
require('dotenv').config(); // 讀取你個 .env 檔案入面嘅 API Key

async function listGeminiModels() {
    // 優先讀取 .env 入面嘅 GEMINI_API_KEY_1，如果無就硬塞落去
    const apiKey = process.env.GEMINI_API_KEY_1 || '請喺度貼上你嘅_GEMINI_API_KEY'; 

    if (!apiKey || apiKey.includes('請喺度貼上')) {
        console.error('❌ 錯誤：請先設定 GEMINI_API_KEY_1');
        return;
    }

    console.log('🔍 正在向 Google 總部索取模型清單...\n');

    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        
        const models = response.data.models;
        
        console.log('✅ 成功獲取！以下係你可以用嘅模型清單 (請留意 name 欄位)：\n');
        
        models.forEach(model => {
            // 我哋只篩選出支援 "generateContent" (生成文字) 嘅模型
            if (model.supportedGenerationMethods.includes('generateContent')) {
                console.log(`🤖 模型名稱: ${model.name.replace('models/', '')}`);
                console.log(`   - 簡介: ${model.displayName}`);
                console.log(`   - 版本: ${model.version}`);
                console.log('----------------------------------------');
            }
        });

        console.log('💡 提示：請將上面【模型名稱】(例如 gemini-1.5-pro) 填入 Supabase 嘅 model_main / model_backup 欄位！');

    } catch (error) {
        console.error('❌ 獲取失敗！API 報錯：', error.response ? error.response.data : error.message);
    }
}

listGeminiModels();