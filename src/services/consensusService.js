// src/services/consensusService.js
// 📝 檔案功能用途：V9.3 終極防彈版 AI 議事廳。唯一負責買入把關的 AI。
// 🚀 升級功能：強制植入「AI 簽名水印」，精準識別哪個模型 (Groq/Mistral) 唔識寫繁體中文。

const { keyRotator } = require('./keyRotator');
const { promptManager } = require('./promptManager'); 
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const baseScore = options.baseScore || 60; // 遵循指揮官 60 分基礎邏輯

        if (config.aiKeys.length === 0) {
            console.log(`[Consensus] ⚠️ 無 AI 金鑰，直接使用量化原判 (${baseScore} 分)`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "純量化模式 (AI 未啟用)" };
        }

        // 動態獲取劇本
        const aiConfig = promptManager.getPromptConfig('quant_consensus', {
            symbol: marketData.symbol,
            baseScore: baseScore,
            liquidity: marketData.liquidity.toFixed(0),
            volume5m: marketData.volume5m.toFixed(0),
            ofi: marketData.ofi ? marketData.ofi.toFixed(2) : 'N/A',
            h1: marketData.h1.toFixed(2)
        });

        const prompt = aiConfig.parsedPrompt;

        try {
            const aiResult = await keyRotator.enqueueRequest(async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                
                let keyName = 'UNKNOWN_KEY';
                for (const [envKey, envVal] of Object.entries(process.env)) {
                    if (envVal && typeof envVal === 'string' && envVal.replace(/['"]/g, '').trim() === cleanKey) {
                        keyName = envKey;
                        break;
                    }
                }
                
                const isGroq = cleanKey.startsWith('gsk_');
                const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                const modelName = isGroq ? 'llama-3.3-70b-versatile' : 'mistral-small-latest';
                const providerName = isGroq ? 'GROQ' : 'MISTRAL';
                
                console.log(`[KeyRotator] 🔫 系統抽中 ${providerName} (${modelName}) 進行審批...`);

                try {
                    const payload = {
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" }, 
                        temperature: 0.1 
                    };

                    const res = await axios.post(apiUrl, payload, {
                        headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' },
                        timeout: 15000 
                    });

                    const rawText = res.data.choices[0].message.content;
                    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error("AI 未回傳有效 JSON 格式");
                    
                    const parsedJson = JSON.parse(jsonMatch[0]);
                    
                    // 🚀 核心：強行烙印 AI 簽名
                    parsedJson.ai_signature = `${providerName} | ${modelName}`;
                    
                    console.log(`✅ [AI Success] 獲取裁決。簽名: [${parsedJson.ai_signature}] | 調整分: ${parsedJson.adjustment}`);
                    return parsedJson;

                } catch (e) {
                    const status = e.response?.status || 'N/A';
                    const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) 審批陣亡 | Status: ${status} | 死因: ${errMsg}`);
                    throw e; 
                }
            });

            const confidence = parseFloat(aiResult.confidence) || 0;
            let adjustment = parseInt(aiResult.adjustment) || 0;
            const aiSignature = aiResult.ai_signature || 'UNKNOWN_AI';

            if (confidence < config.aiRules.minConfidence) {
                console.log(`[Consensus] 🛡️ AI 信心不足 (${confidence})，維持原判 ${baseScore} 分。`);
                return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: `[${aiSignature}] 信心不足 (${confidence})，維持量化原判` };
            }

            const maxAdjust = (baseScore >= 75) ? config.aiRules.adjustLimitHigh : config.aiRules.adjustLimitLow;
            adjustment = Math.max(-maxAdjust, Math.min(maxAdjust, adjustment));

            const finalScore = baseScore + adjustment;
            const isBuy = finalScore >= config.quant.rejectThreshold;
            const sign = adjustment >= 0 ? '+' : '';

            console.log(`[Consensus] 🧠 AI 最終裁決: ${baseScore} ${sign}${adjustment} = ${finalScore} 分`);

            // 🚀 將簽名加入到最終原因中
            return { buy: isBuy, score: finalScore, reason: `[${aiSignature}] 裁決 (${sign}${adjustment}分): ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] AI 資源池全線陣亡，降級為純量化分數: ${err.message}`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "AI 資源池異常，降級採用純量化結果" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };