// src/services/consensusService.js
// 📝 檔案功能用途：V9.1 降級版 AI 議事廳。對接 keyRotator 資源池，針對 60-89 分區間進行信心度過濾與 ±20 分的微調，若 AI 癱瘓則降級為純量化。

const { keyRotator } = require('./keyRotator');
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    /**
     * 🧠 執行 AI 數據共識微調
     * @param {string} mint 代幣地址
     * @param {object} marketData 報價與量化數據
     * @param {object} options 包含 baseScore (基礎量化分)
     */
    async runMemeConsensus(mint, marketData, options = {}) {
        const baseScore = options.baseScore || 60;

        // 若系統未配置任何 AI Key，直接降級為純量化模式
        if (config.aiKeys.length === 0) {
            console.log(`[Consensus] ⚠️ 無 AI 金鑰，直接使用量化原判 (${baseScore} 分)`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "純量化模式 (AI 未啟用)" };
        }

        // 簡潔且聚焦數據的 V9.1 AI Prompt
        const prompt = `You are a strict Quantitative AI Auditor. Evaluate the crypto asset ${marketData.symbol}.
Base Quant Score: ${baseScore}/100.
Data Points: 
- Liquidity: $${marketData.liquidity.toFixed(0)}
- 5m Volume: $${marketData.volume5m.toFixed(0)}
- OFI (Order Flow Imbalance): ${marketData.ofi ? marketData.ofi.toFixed(2) : 'N/A'}
- 1H Price Change: ${marketData.h1.toFixed(2)}%

Task: Adjust the base score based purely on the data momentum and safety. 
Output STRICTLY IN JSON FORMAT: 
{
    "confidence": <float between 0.0 and 1.0>,
    "adjustment": <integer between -20 and +20>,
    "reason": "<Cantonese explanation under 20 words>"
}`;

        try {
            // 將請求推入 1秒延遲 與 429輪替 的資源池
            const aiResult = await keyRotator.enqueueRequest(async (apiKey) => {
                // 自動判別 Groq (gsk_...) 或 Mistral 金鑰，路由至對應的 OpenAI Compatible Endpoint
                const isGroq = apiKey.startsWith('gsk_');
                const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                const modelName = isGroq ? 'llama-3.3-70b-versatile' : 'mistral-large-latest';

                const res = await axios.post(apiUrl, {
                    model: modelName,
                    messages: [{ role: "user", content: prompt }],
                    response_format: { type: "json_object" }
                }, {
                    headers: { 
                        'Authorization': `Bearer ${apiKey}`, 
                        'Content-Type': 'application/json' 
                    },
                    timeout: 8000 // 8秒極速 Timeout
                });

                return JSON.parse(res.data.choices[0].message.content);
            });

            const confidence = parseFloat(aiResult.confidence) || 0;
            let adjustment = parseInt(aiResult.adjustment) || 0;

            // 🛡️ 風控 1：信心度不足，無視調整
            if (confidence < config.aiRules.minConfidence) {
                console.log(`[Consensus] 🛡️ AI 信心不足 (${confidence})，維持原判 ${baseScore} 分。`);
                return { 
                    buy: baseScore >= config.quant.rejectThreshold, 
                    score: baseScore, 
                    reason: `AI 信心不足 (${confidence})，維持量化原判` 
                };
            }

            // 🛡️ 風控 2：嚴格限制加減分上限 (75-89 可調 ±20；60-74 僅可調 ±10)
            const maxAdjust = (baseScore >= 75) ? config.aiRules.adjustLimitHigh : config.aiRules.adjustLimitLow;
            adjustment = Math.max(-maxAdjust, Math.min(maxAdjust, adjustment));

            const finalScore = baseScore + adjustment;
            const isBuy = finalScore >= config.quant.rejectThreshold;
            const sign = adjustment >= 0 ? '+' : '';

            console.log(`[Consensus] 🧠 AI 裁決完成: ${baseScore} ${sign}${adjustment} = ${finalScore} 分`);

            return { 
                buy: isBuy, 
                score: finalScore, 
                reason: `AI 裁決 (${sign}${adjustment}分): ${aiResult.reason}` 
            };

        } catch (err) {
            // 若觸發 ALL_KEYS_ON_COOLDOWN 或網路異常，平滑降級 (Graceful Degradation)
            console.warn(`⚠️ [Consensus] AI 資源池全數冷卻或超時，降級為純量化分數: ${err.message}`);
            return { 
                buy: baseScore >= config.quant.rejectThreshold, 
                score: baseScore, 
                reason: "AI 資源池冷卻中，降級採用純量化結果" 
            };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };