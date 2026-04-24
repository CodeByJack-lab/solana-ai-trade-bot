// src/services/consensusService.js
// 📝 檔案功能用途：V10.25 純粹動態降級版 AI 議事廳 (TradFi 風控 + JSON Regex 防彈版)
// 🚀 核心升級：移除 Hardcode 嘅 response_format，改用 Regex 正則提取，徹底秒殺降級 400 報錯。
// 🛡️ 風控升級：精準提取 JSON 內的 bear_case_risk 與 thesis_breaker，並將其合併至最終報告，拒絕盲目 FOMO。

const { keyRotator } = require('./keyRotator');
const { cacheManager } = require('./cacheManager');
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const poolType = options.poolType || 'TRENDING';
        const promptId = poolType === 'NEWBORN' ? 'meme_scout' : 'trending_scout';
        const symbol = marketData.symbol || 'UNKNOWN';
        const name = marketData.name || 'UNKNOWN';

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) return { narrative_score: 0, reason: "GROQ 未啟用" };

        try {
            const promptConfig = cacheManager.getPromptConfig(promptId, { token_symbol: symbol, name: name });
            const systemPrompt = promptConfig.parsedPrompt;
            
            const models = promptConfig.models && promptConfig.models.length > 0 
                ? promptConfig.models 
                : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];

            const aiResult = await keyRotator.runWithKey('GROQ', async (apiKey, retryCount, providerName) => {
                const safeIndex = Math.min((retryCount || 0), models.length - 1);
                const selectedModel = models[safeIndex];

                if (retryCount > 0) {
                    console.warn(`🔄 [Consensus] 第 ${retryCount} 次重試，自動降級使用模型: ${selectedModel}`);
                }

                try {
                    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model: selectedModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            // 🚀 強化 Prompt：命令佢只准出 JSON，唔准加 markdown 廢話
                            { role: "user", content: "CRITICAL: Please analyze this token now and return strictly valid JSON. Do not include markdown formatting like ```json or any explanations." }
                        ],
                        temperature: 0.3,
                        max_tokens: 250
                        // ❌ 核心修復：徹底刪除 response_format: { type: "json_object" }，解放模型限制！
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        timeout: 5000 
                    });

                    const content = response.data.choices[0]?.message?.content;
                    
                    if (!content || content.trim() === '') {
                        console.warn(`⚠️ [Consensus] 模型 ${selectedModel} 回傳空內容，觸發降級切換...`);
                        throw new Error('NO_CONTENT_FOUND');
                    }

                    // 🚀 核心防禦：用 Regex 正則表達式，夾硬喺廢話堆中抽出 JSON
                    let cleanJsonString = content;
                    const jsonMatch = content.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        cleanJsonString = jsonMatch[0];
                    }

                    const parsed = JSON.parse(cleanJsonString);
                    parsed.ai_signature = `${providerName}_${selectedModel}`;
                    return parsed;
                } catch (e) {
                    throw e; 
                }
            }, promptId); 

            let nScore = parseInt(aiResult.narrative_score);
            nScore = isNaN(nScore) ? 0 : Math.max(-5, Math.min(10, nScore)); 
            
            const riskNote = aiResult.thesis_breaker || aiResult.bear_case_risk || "未提供風險警告";
            const coreReason = aiResult.reason || '無解釋';

            console.log(`[Consensus] 🗣️ LLM 評分: ${nScore} 分`);
            console.log(`   📝 敘事理由: ${coreReason}`);
            console.log(`   ⚠️ 風控警告: ${riskNote}`);

            const finalReason = `[${aiResult.ai_signature}] ${coreReason} | ⚠️ Risk: ${riskNote}`;

            return { narrative_score: nScore, reason: finalReason };

        } catch (err) {
            console.warn(`⚠️ [Consensus] 鑒定異常 (全線降級失敗): ${err.message}`);
            return { narrative_score: 0, reason: "LLM 資源池全線異常" };
        }
    }
}

module.exports = { consensusService: new ConsensusService() };