// src/services/aiAdvisorService.js
// 📝 檔案功能用途：V9.2 獨立的 AI 參謀大腦。從 DB 動態載入劇本，呼叫 Gemini API 進行「英文思維鏈」高質量推理，並交由郵差發送 JSON 提案。

const axios = require('axios');
const { enqueueMessage, MAIN_BOT_TOKEN, CHAT_ID } = require('./telegramService');
const { promptManager } = require('./promptManager'); 

class AIAdvisorService {

    async evaluateClimateChange(climate, envState) {
        console.log(`🧠 [AI Advisor] 接收到氣候轉變訊號 (${climate})，正在請示 AI 參謀總長...`);

        try {
            // 1. 📝 從 Prompt Manager 獲取動態劇本與模型配置 (支援 Fallback)
            const promptContext = {
                climate: climate,
                newsScore: envState.newsScore,
                volSurge: (envState.volSurge * 100).toFixed(0),
                jitoP50: envState.jitoP50
            };
            
            const aiConfig = promptManager.getPromptConfig('CLIMATE_ADVISOR', promptContext);
            const finalPrompt = aiConfig.parsedPrompt;
            const models = aiConfig.models; // 陣列：[首選, 後備1, 後備2]

            // 2. 🤖 Gemini 模型輪替呼叫 (Model Fallback)
            const geminiApiKey = process.env.GEMINI_API_KEY_1;
            if (!geminiApiKey || models.length === 0) {
                console.warn("⚠️ [AI Advisor] 找不到 GEMINI API Key 或模型配置，退回本地保底邏輯...");
                return await this._fallbackLogic(climate, envState);
            }

            let responseText = null;
            let usedModel = null;

            for (let i = 0; i < models.length; i++) {
                const currentModel = models[i];
                console.log(`🤖 嘗試呼叫 Gemini 模型: ${currentModel} (嘗試 ${i+1}/${models.length})`);
                
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${geminiApiKey}`;
                    const payload = {
                        contents: [{ parts: [{ text: finalPrompt }] }],
                        generationConfig: {
                            temperature: 0.2, // 低溫確保邏輯穩定
                            responseMimeType: "application/json" // 強制 JSON 輸出
                        }
                    };

                    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
                    responseText = response.data.candidates[0].content.parts[0].text;
                    usedModel = currentModel;
                    break; // 成功獲取，跳出輪替迴圈
                } catch (apiErr) {
                    console.warn(`⚠️ 模型 ${currentModel} 請求失敗: ${apiErr.response?.status || apiErr.message}`);
                    if (i === models.length - 1) throw new Error("所有 Gemini 後備模型均已陣亡");
                }
            }

            // 3. 解析 Gemini 回應 (已強制 JSON 輸出)
            const aiResult = JSON.parse(responseText);
            console.log(`✅ [AI Advisor] Gemini (${usedModel}) 提案生成成功:`, aiResult);

            // 4. 發送至 Telegram 隊列
            // 注意：我們故意忽略 aiResult.english_thought_process，只將 tp_level_1, stop_loss, max_tip_pct, analysis 傳給郵差
            await this._dispatchProposal(
                climate, 
                envState, 
                parseFloat(aiResult.tp_level_1), 
                parseFloat(aiResult.stop_loss), 
                parseFloat(aiResult.max_tip_pct), 
                aiResult.analysis
            );

        } catch (error) {
            console.error(`❌ [AI Advisor] 呼叫 AI 失敗 (${error.message})，使用安全保底邏輯...`);
            await this._fallbackLogic(climate, envState);
        }
    }

    async _fallbackLogic(climate, envState) {
        const isBear = climate === 'BEAR_PANIC';
        const isBull = climate === 'RAGING_BULL';
        
        const tp1 = isBear ? 20.0 : (isBull ? 80.0 : 50.0);
        const sl = isBear ? -10.0 : (isBull ? -20.0 : -15.0);
        const tip = isBear ? 0.5 : (isBull ? 5.0 : 2.0);
        const analysis = "⚠️ AI 暫時無法連線或處理超時，系統基於當前氣候自動啟動預設保底戰略。";
        
        await this._dispatchProposal(climate, envState, tp1, sl, tip, analysis);
    }

    async _dispatchProposal(climate, envState, tp1, sl, tip, aiAnalysis) {
        let text = `🤖 <b>【Gemini 參謀總長提案】</b>\n\n`;
        text += `📊 <b>當前局勢</b>：新聞情緒 ${envState.newsScore}，交易量湧浪 ${(envState.volSurge * 100).toFixed(0)}%。\n`;
        text += `🌡️ <b>氣候判定</b>：<code>${climate}</code>\n\n`;
        text += `🧠 <b>參謀分析</b>：<i>「${aiAnalysis}」</i>\n\n`;
        text += `💡 <b>建議動作</b>：切換至『${climate === 'BEAR_PANIC' ? '熊市防禦' : (climate === 'RAGING_BULL' ? '牛市進攻' : '市場波動')}』。\n\n`;

        const keyboard = {
            inline_keyboard: [
                [{ text: "✅ 全部批准", callback_data: `APPROVE_ALL_${climate}` }, { text: "❌ 全部忽略", callback_data: "REJECT_ALL_PROP" }],
                [{ text: `✅ 批准 (TP1: ${tp1}%)`, callback_data: `APPROVE_TP1_${tp1}` }],
                [{ text: `✅ 批准 (SL: ${sl}%)`, callback_data: `APPROVE_SL_${sl}` }],
                [{ text: `✅ 批准 (Tip上限: ${tip}%)`, callback_data: `APPROVE_TIP_${tip}` }]
            ]
        };

        const payload = { chat_id: CHAT_ID, text: text, parse_mode: 'HTML', reply_markup: keyboard };
        await enqueueMessage(MAIN_BOT_TOKEN, 'sendMessage', payload);
        console.log(`✅ [AI Advisor] 戰略提案已成功遞交至 Telegram 隊列。`);
    }
}

const aiAdvisorService = new AIAdvisorService();
module.exports = { aiAdvisorService };