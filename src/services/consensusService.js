// src/services/consensusService.js
// 📝 檔案功能用途：V10.23 盲測版 AI 議事廳 (僅依賴 Symbol/Name 進行敘事鑒定)
// 🚀 核心更新：修復 Cache 讀取 Object 導致的 .replace 錯誤，徹底廢除 Description 注入。

const { keyRotator } = require('./keyRotator');
const { cacheManager } = require('./cacheManager');
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const poolType = options.poolType || 'TRENDING';
        const climate = options.climate || 'CHOPPY';

        const isMeme = poolType === 'NEWBORN';
        const promptId = isMeme ? 'meme_scout' : 'trending_scout';

        const symbol = marketData.symbol || 'UNKNOWN';
        const name = marketData.name || 'UNKNOWN';
        // 🛡️ V10.23: 盲測模式，不再讀取 description

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) {
            console.log(`[Consensus] ⚠️ 無 GROQ 金鑰，跳過敘事評分`);
            return { narrative_score: 0, reason: "GROQ 未啟用，敘事+0" };
        }

        try {
            // 🧠 從 cacheManager 拉取 DB 裡的 Prompt (此處拉取到的可能是 Object)
            let rawPromptData = cacheManager.cache.prompts?.get(promptId);
            
            // 🛡️ 提取真正的字串內容 (處理 Object vs String 差異)
            let systemPrompt = '';
            if (rawPromptData && typeof rawPromptData === 'object' && rawPromptData.content) {
                systemPrompt = rawPromptData.content;
            } else if (typeof rawPromptData === 'string') {
                systemPrompt = rawPromptData;
            }
            
            // ⚠️ Fallback 機制：如果 Redis/DB 未同步或讀取失敗，使用內建盲測 Prompt
            if (!systemPrompt) {
                systemPrompt = `You are an elite Crypto Narrative Analyst. Evaluate: Symbol: {{token_symbol}} Name: {{name}}. Output JSON format: {"narrative_score": <integer from -5 to +10>, "reason": "<string>"}. Guide: +8 to +10: Top-tier. +1 to +7: Good meme. 0: Neutral. -1 to -4: Copycat. -5: SCAM.`;
            }

            // 🛡️ 動態注入變數 (完美解決 .replace is not a function 嘅 bug)
            systemPrompt = systemPrompt
                .replace(/{{token_symbol}}/g, symbol)
                .replace(/{{name}}/g, name);

            const aiResult = await keyRotator.runWithKey('GROQ', async (apiKey, modelName, providerName) => {
                try {
                    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model: modelName || "llama3-70b-8192",
                        messages: [{ role: "system", content: systemPrompt }],
                        temperature: 0.3,
                        max_tokens: 150,
                        response_format: { type: "json_object" }
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        timeout: 5000
                    });

                    const content = response.data.choices[0].message.content;
                    const parsed = JSON.parse(content);
                    parsed.ai_signature = `${providerName}_${modelName}`;
                    return parsed;
                } catch (e) {
                    const status = e.response?.status || 'N/A';
                    const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) 鑒定異常 | Status: ${status} | 錯誤: ${errMsg}`);
                    throw e; 
                }
            }, promptId); 

            const aiSignature = aiResult.ai_signature || 'GROQ_UNKNOWN';
            
            // 🚨 物理邊界防護：強制卡死在 -5 到 +10
            let nScore = 0;
            if (aiResult.narrative_score !== undefined && !isNaN(aiResult.narrative_score)) {
                nScore = parseInt(aiResult.narrative_score);
                nScore = Math.max(-5, Math.min(10, nScore)); 
            }

            const aiReason = aiResult.reason || '無解釋';
            console.log(`[Consensus] 🗣️ LLM 盲測敘事評分: ${nScore > 0 ? '+' : ''}${nScore} 分 | 理由: ${aiReason}`);

            return { narrative_score: nScore, reason: `[${aiSignature}] ${aiReason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] LLM 敘事鑒定異常或全線冷卻，跳過加減分: ${err.message}`);
            return { narrative_score: 0, reason: "LLM 資源池異常，敘事分數 +0" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };