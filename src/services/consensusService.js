// src/services/consensusService.js
// 📝 檔案功能用途：V10.29 純粹動態降級版 AI 議事廳 (全面遷移至 Mistral 版)
// 🚀 核心升級：全面棄用 GROQ，強制將所有決策任務導向 MISTRAL 資源池。
// 🔒 安全升級：使用 Regex 正則提取 JSON，完全免疫 API 兼容性 400 報錯。

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

        try {
            const promptConfig = cacheManager.getPromptConfig(promptId, { token_symbol: symbol, name: name });
            const systemPrompt = promptConfig.parsedPrompt;
            
            // 🛑 核心修改：無管 DB 寫咩，強制使用 MISTRAL！
            const targetProvider = 'MISTRAL';

            if (!config.aiKeys[targetProvider] || config.aiKeys[targetProvider].length === 0) {
                return { narrative_score: 0, reason: `${targetProvider} 未啟用，請檢查環境變數` };
            }

            let rawModels = promptConfig.models;
            if (typeof rawModels === 'string') {
                try { rawModels = JSON.parse(rawModels); } catch(e) { rawModels = [rawModels]; }
            }
            
            let models = Array.isArray(rawModels) && rawModels.length > 0 
                ? rawModels 
                : ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'];

            // 呼叫 keyRotator (內置全域鎖)
            const aiResult = await keyRotator.runWithKey(targetProvider, async (apiKey, retryCount) => {
                const safeIndex = Math.min((retryCount || 0), models.length - 1);
                const selectedModel = models[safeIndex];

                console.log(`🤖 [Consensus] 呼叫 Mistral: ${selectedModel}`);

                try {
                    const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                        model: selectedModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: "CRITICAL: Return strictly valid JSON with narrative_score and reason fields. Do not output markdown code blocks." }
                        ],
                        temperature: 0.2,
                        max_tokens: 300
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey.replace(/['"]/g, '').trim()}`, 'Content-Type': 'application/json' },
                        timeout: 10000 
                    });

                    const content = response.data.choices[0]?.message?.content;
                    if (!content || content.trim() === '') throw new Error('EMPTY_RESPONSE');

                    // Regex 夾硬抽出 JSON
                    let cleanJsonString = content;
                    const jsonMatch = content.match(/\{[\s\S]*\}/);
                    if (jsonMatch) cleanJsonString = jsonMatch[0];

                    const parsed = JSON.parse(cleanJsonString);
                    parsed.ai_signature = `MISTRAL_${selectedModel}`;
                    return parsed;
                } catch (e) {
                    if (e.response && e.response.status === 400) {
                        console.error(`❌ [API 400 Error] 模型: ${selectedModel} | 詳細原因:`, JSON.stringify(e.response.data));
                    }
                    throw e; 
                }
            }, promptId); 

            let nScore = parseInt(aiResult.narrative_score);
            nScore = isNaN(nScore) ? 0 : Math.max(-5, Math.min(10, nScore)); 
            
            const riskNote = aiResult.thesis_breaker || aiResult.bear_case_risk || "未提供風險警告";
            const coreReason = aiResult.reason || '無解釋';

            const finalReason = `[${aiResult.ai_signature}] ${coreReason} | ⚠️ Risk: ${riskNote}`;
            return { narrative_score: nScore, reason: finalReason };

        } catch (err) {
            console.warn(`⚠️ [Consensus] 最終判定異常: ${err.message}`);
            return { narrative_score: 0, reason: "LLM 資源池全線過載" };
        }
    }
}

module.exports = { consensusService: new ConsensusService() };