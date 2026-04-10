// src/services/aiAdvisorService.js
// 📝 檔案功能用途：V10.10 獨立的 AI 參謀大腦 (全自動駕駛版)。
// 🚀 升級功能：全線轉交 MISTRAL 處理，並完美對接新版 KeyRotator (共用 Key 1)。

const axios = require('axios');
const { sendAdminAlert } = require('./telegramService'); 
const { cacheManager } = require('./cacheManager'); 
const { supabase } = require('../config/supabase'); 
const { keyRotator } = require('./keyRotator'); // 🚀 引入排隊引擎

class AIAdvisorService {

    async evaluateClimateChange(climate, envState) {
        console.log(`🧠 [AI Advisor] 接收到氣候轉變訊號 (${climate})，啟動自動變陣評估...`);

        try {
            const promptContext = {
                climate: climate,
                newsScore: envState.newsScore,
                volSurge: (envState.volSurge * 100).toFixed(0),
                jitoP50: envState.jitoP50
            };
            
            const aiConfig = cacheManager.getPromptConfig('CLIMATE_ADVISOR', promptContext);
            const finalPrompt = aiConfig.parsedPrompt;
            const models = aiConfig.models; 

            // 🚀 透過 KeyRotator 呼叫 MISTRAL
            const aiResult = await keyRotator.enqueueRequest('MISTRAL', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const apiUrl = 'https://api.mistral.ai/v1/chat/completions';
                const modelName = models[0] || 'mistral-large-latest';

                console.log(`[KeyRotator] 🔫 系統抽中 MISTRAL (${modelName}) 進行大市分析 [劇本: CLIMATE_ADVISOR]...`);

                const payload = {
                    model: modelName,
                    messages: [{ role: "user", content: finalPrompt }],
                    response_format: { type: "json_object" },
                    temperature: 0.2
                };

                const response = await axios.post(apiUrl, payload, { 
                    headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, 
                    timeout: 20000 
                });

                const responseText = response.data.choices[0].message.content;
                const match = responseText.match(/\{[\s\S]*\}/);
                if (!match) throw new Error("AI 吐出的不是有效 JSON");

                return JSON.parse(match[0]);
            }, 'CLIMATE_ADVISOR'); // 👈 傳入 promptId 讓 KeyRotator 識得派 Key

            const rawTrigger = parseFloat(aiResult.trailing_trigger);
            const rawSl = parseFloat(aiResult.stop_loss);
            const rawTip = parseFloat(aiResult.max_tip_pct);

            // 護欄限制：啟動點(15%~40%), 止損(-25%~-10%)
            const safeTrigger = Math.max(15, Math.min(40, isNaN(rawTrigger) ? 20 : rawTrigger));
            const safeSl = Math.max(-25, Math.min(-10, isNaN(rawSl) ? -15 : rawSl));
            const safeTip = Math.max(0.5, Math.min(5.0, isNaN(rawTip) ? 2.0 : rawTip));

            await this._applyParametersToDb(safeTrigger, safeSl, safeTip);

            const alertMsg = `🤖 <b>【參謀總長 自動變陣】</b>\n\n🌡️ 氣候: <code>${climate}</code>\n\n⚙️ <b>參數鎖定更新:</b>\n   • 追蹤啟動點: <code>+${safeTrigger}%</code>\n   • 硬止損 (SL): <code>${safeSl}%</code>\n   • Jito Tip: <code>${safeTip}%</code>\n\n🧠 <b>分析:</b> <i>「${aiResult.analysis}」</i>`;
                             
            if (typeof sendAdminAlert === 'function') await sendAdminAlert(alertMsg);

        } catch (error) {
            console.error(`❌ [AI Advisor] 呼叫 AI 失敗 (${error.message})，執行靜默保底邏輯...`);
            await this._fallbackLogic(climate, envState);
        }
    }

    async _fallbackLogic(climate, envState) {
        const isBear = climate === 'BEAR_PANIC';
        const isBull = climate === 'RAGING_BULL';
        
        const trigger = isBear ? 15.0 : (isBull ? 30.0 : 20.0);
        const sl = isBear ? -10.0 : (isBull ? -20.0 : -15.0); 
        const tip = isBear ? 0.5 : (isBull ? 5.0 : 2.0);
        
        await this._applyParametersToDb(trigger, sl, tip);
    }

    async _applyParametersToDb(trigger, sl, tip) {
        try {
            const { error } = await supabase.from('ai_strategy_params')
                .update({
                    trailing_tp_trigger: trigger.toString(),
                    stop_loss_pct: sl.toString(),
                    max_buy_tip_pct: tip.toString(),
                    tp_level_1_pct: 999.0, // 強制封印 TP1
                    updated_at: new Date().toISOString()
                }).in('id', [2, 3]);

            if (error) throw error;
        } catch (dbErr) {
            console.error(`❌ [AI Advisor] 寫入 DB 失敗:`, dbErr.message);
        }
    }
}

const aiAdvisorService = new AIAdvisorService();
module.exports = { aiAdvisorService };