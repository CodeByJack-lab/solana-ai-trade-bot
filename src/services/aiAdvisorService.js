// src/services/aiAdvisorService.js
// 📝 檔案功能用途：V10.9 獨立的 AI 參謀大腦 (全自動駕駛版)。
// 🚀 升級功能：廢除手動批准按鈕，實裝「安全護欄 (Range Bound)」，直接自動更新 DB 參數。通知移至 Admin Channel，遇 Timeout 則靜默保底變陣，不作滋擾。

const axios = require('axios');
const { sendAdminAlert } = require('./telegramService'); // 👈 改用 Admin Alert
const { promptManager } = require('./promptManager'); 
const { supabase } = require('../config/supabase'); // 👈 引入 DB 進行自動更新

class AIAdvisorService {

    async evaluateClimateChange(climate, envState) {
        console.log(`🧠 [AI Advisor] 接收到氣候轉變訊號 (${climate})，啟動自動變陣評估...`);

        try {
            // 1. 📝 從 Prompt Manager 獲取動態劇本
            const promptContext = {
                climate: climate,
                newsScore: envState.newsScore,
                volSurge: (envState.volSurge * 100).toFixed(0),
                jitoP50: envState.jitoP50
            };
            
            const aiConfig = promptManager.getPromptConfig('CLIMATE_ADVISOR', promptContext);
            const finalPrompt = aiConfig.parsedPrompt;
            const models = aiConfig.models; 

            const geminiApiKey = process.env.GEMINI_API_KEY_1;
            if (!geminiApiKey || models.length === 0) {
                console.warn("⚠️ [AI Advisor] 找不到 GEMINI API Key，退回靜默保底邏輯...");
                return await this._fallbackLogic(climate, envState);
            }

            let responseText = null;
            let usedModel = null;

            // 2. 🤖 Gemini 模型輪替呼叫
            for (let i = 0; i < models.length; i++) {
                const currentModel = models[i];
                console.log(`🤖 嘗試呼叫 Gemini 模型: ${currentModel} (嘗試 ${i+1}/${models.length})`);
                
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${geminiApiKey}`;
                    const payload = {
                        contents: [{ parts: [{ text: finalPrompt }] }],
                        generationConfig: {
                            temperature: 0.2, 
                            responseMimeType: "application/json" 
                        }
                    };

                    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
                    responseText = response.data.candidates[0].content.parts[0].text;
                    usedModel = currentModel;
                    break; 
                } catch (apiErr) {
                    console.warn(`⚠️ 模型 ${currentModel} 請求失敗: ${apiErr.response?.status || apiErr.message}`);
                    if (i === models.length - 1) throw new Error("所有 Gemini 後備模型均已陣亡");
                }
            }

            // 3. 解析與安全護欄 (Range Bound) 🛡️
            const aiResult = JSON.parse(responseText);
            
            const rawTp = parseFloat(aiResult.tp_level_1);
            const rawSl = parseFloat(aiResult.stop_loss);
            const rawTip = parseFloat(aiResult.max_tip_pct);

            // 絕對限制：TP (50% ~ 150%), SL (-25% ~ -10%), Tip (0.5% ~ 5%)
            const safeTp = Math.max(50, Math.min(150, isNaN(rawTp) ? 80 : rawTp));
            const safeSl = Math.max(-25, Math.min(-10, isNaN(rawSl) ? -15 : rawSl));
            const safeTip = Math.max(0.5, Math.min(5.0, isNaN(rawTip) ? 2.0 : rawTip));

            console.log(`✅ [AI Advisor] Gemini 決策成功。準備套用安全參數 -> SL: ${safeSl}%, TP1: ${safeTp}%, Tip: ${safeTip}%`);

            // 4. 全自動寫入資料庫
            await this._applyParametersToDb(safeTp, safeSl, safeTip);

            // 5. 靜悄悄發送 Admin 報告 (不煩擾主群)
            const alertMsg = `🤖 <b>【參謀總長 自動變陣】</b>\n\n` +
                             `🌡️ 氣候判定: <code>${climate}</code>\n` +
                             `📊 局勢: 新聞 ${envState.newsScore}, 湧浪 ${(envState.volSurge * 100).toFixed(0)}%\n\n` +
                             `⚙️ <b>參數已鎖定更新:</b>\n` +
                             `   • 止損 (SL): <code>${safeSl}%</code>\n` +
                             `   • 止盈 (TP1): <code>${safeTp}%</code>\n` +
                             `   • Jito Tip: <code>${safeTip}%</code>\n\n` +
                             `🧠 <b>分析:</b> <i>「${aiResult.analysis}」</i>`;
                             
            if (typeof sendAdminAlert === 'function') {
                await sendAdminAlert(alertMsg);
            }

        } catch (error) {
            console.error(`❌ [AI Advisor] 呼叫 AI 失敗 (${error.message})，執行靜默保底邏輯...`);
            await this._fallbackLogic(climate, envState);
        }
    }

    // 🤫 遇錯靜默保底 (不再發 Telegram，直接暗中改 DB)
    async _fallbackLogic(climate, envState) {
        console.warn("⚠️ [AI Advisor] 啟動靜默保底變陣，不發送 Telegram 滋擾通知。");
        const isBear = climate === 'BEAR_PANIC';
        const isBull = climate === 'RAGING_BULL';
        
        const tp1 = isBear ? 50.0 : (isBull ? 80.0 : 60.0);
        // 配合 V10.8 策略，保底止損不能太闊，熊市收緊至 -10%，牛市最多 -20%
        const sl = isBear ? -10.0 : (isBull ? -20.0 : -15.0); 
        const tip = isBear ? 0.5 : (isBull ? 5.0 : 2.0);
        
        await this._applyParametersToDb(tp1, sl, tip);
    }

    // 💾 統一 DB 寫入介面
    async _applyParametersToDb(tp1, sl, tip) {
        try {
            const { error } = await supabase.from('ai_strategy_params')
                .update({
                    stop_loss_pct: sl.toString(),
                    tp_level_1_pct: tp1.toString(),
                    max_buy_tip_pct: tip.toString(),
                    updated_at: new Date().toISOString()
                })
                .in('id', [2, 3]); // 同時更新 MEME(2) 同 TRENDING(3) 嘅參數

            if (error) throw error;
            console.log(`✅ [AI Advisor] 參數已成功寫入 Database (SL: ${sl}, TP1: ${tp1}, Tip: ${tip})`);
        } catch (dbErr) {
            console.error(`❌ [AI Advisor] 寫入 DB 失敗:`, dbErr.message);
        }
    }
}

const aiAdvisorService = new AIAdvisorService();
module.exports = { aiAdvisorService };