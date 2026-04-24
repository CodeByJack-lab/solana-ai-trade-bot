// src/services/consensusService.js
// 📝 檔案功能用途：V10.28 純粹動態降級版 AI 議事廳 (動態路由 + 格式強制修復版)
// 🚀 核心升級：移除硬編碼的 GROQ 限制，動態根據 DB 的 Provider 切換 API Endpoint (Groq / Mistral)。
// 🛡️ 防呆攔截：若 Provider 是 GROQ 但傳入了 Mistral 專利模型 (如 magistral)，自動糾正為 Llama 3。
// 🔒 安全升級：使用 Regex 正則提取 JSON，完全免疫 response_format 的 API 兼容性 400 報錯。

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
            
            // 🚀 動態獲取 DB 的 Provider，預設為 GROQ
            const dbProvider = promptConfig.provider ? promptConfig.provider.toUpperCase() : 'GROQ';

            if (!config.aiKeys[dbProvider] || config.aiKeys[dbProvider].length === 0) {
                return { narrative_score: 0, reason: `${dbProvider} 未啟用` };
            }

            // 確保 models 絕對係 Array
            let rawModels = promptConfig.models;
            if (typeof rawModels === 'string') {
                try { rawModels = JSON.parse(rawModels); } catch(e) { rawModels = [rawModels]; }
            }
            
            let models = Array.isArray(rawModels) && rawModels.length > 0 
                ? rawModels 
                : (dbProvider === 'MISTRAL' 
                    ? ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'] 
                    : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']);

            // 🚀 啟動動態路由
            const aiResult = await keyRotator.runWithKey(dbProvider, async (apiKey, retryCount, actualProvider) => {
                const safeIndex = Math.min((retryCount || 0), models.length - 1);
                let selectedModel = models[safeIndex];

                // 🛑 終極防呆：如果去緊 Groq 餐廳，但你嗌咗 Mistral 專利菜式 (如 magistral, mistral-small)，強制轉 Llama！
                if (actualProvider === 'GROQ' && selectedModel.toLowerCase().includes('stral') && !selectedModel.toLowerCase().includes('mixtral')) {
                    console.warn(`⚠️ [Consensus] 偵測到模型錯配 (Groq 唔支援 ${selectedModel})，自動糾正為 Llama-3！`);
                    selectedModel = 'llama-3.3-70b-versatile';
                }

                // 🚀 動態切換 API 伺服器
                const apiUrl = actualProvider === 'MISTRAL' 
                    ? 'https://api.mistral.ai/v1/chat/completions'
                    : 'https://api.groq.com/openai/v1/chat/completions';

                console.log(`🤖 [Consensus] 嘗試呼叫 ${actualProvider}: ${selectedModel} (第 ${retryCount} 次重試)`);

                try {
                    const response = await axios.post(apiUrl, {
                        model: selectedModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: "CRITICAL: Return strictly valid JSON with narrative_score and reason fields. Do not output markdown code blocks." }
                        ],
                        temperature: 0.2,
                        max_tokens: 300
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        timeout: 7000 
                    });

                    const content = response.data.choices[0]?.message?.content;
                    if (!content || content.trim() === '') throw new Error('EMPTY_RESPONSE');

                    // 🚀 Regex 夾硬抽出 JSON
                    let cleanJsonString = content;
                    const jsonMatch = content.match(/\{[\s\S]*\}/);
                    if (jsonMatch) cleanJsonString = jsonMatch[0];

                    const parsed = JSON.parse(cleanJsonString);
                    parsed.ai_signature = `${actualProvider}_${selectedModel}`;
                    return parsed;
                } catch (e) {
                    if (e.response && e.response.status === 400) {
                        console.error(`❌ [API 400 Error] Provider: ${actualProvider} | 模型: ${selectedModel} | 詳細原因:`, JSON.stringify(e.response.data));
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