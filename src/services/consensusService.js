// src/services/consensusService.js
// 📝 檔案功能用途：V9.1.5 降級防彈版 AI 議事廳。對接 keyRotator 資源池，利用正則提取 JSON 解決 400 報錯。

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
Output ONLY a valid JSON object. Do not use markdown formatting, do not explain anything outside the JSON.
{
    "confidence": <float between 0.0 and 1.0>,
    "adjustment": <integer between -20 and +20>,
    "reason": "<Cantonese explanation under 20 words>"
}`;

        try {
            // 將請求推入 1秒延遲 與 429輪替 的資源池
            const aiResult = await keyRotator.enqueueRequest(async (apiKey) => {
                
                // 🛡️ 終極防彈洗底：清走所有單雙引號同前後空格
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                
                // 自動判別 Groq (gsk_...) 或 Mistral 金鑰
                const isGroq = cleanKey.startsWith('gsk_');
                const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                // 將 Mistral 降級為免費 API 肯定支援的 mistral-small-latest
                // Groq 換成更穩定的 llama3-70b-8192 確保高頻不死
                const modelName = isGroq ? 'llama3-70b-8192' : 'mistral-small-latest';

                const providerName = isGroq ? 'GROQ' : 'MISTRAL';
                console.log(`[KeyRotator] 🔫 系統抽中 ${providerName} (${modelName}) 進行審批...`);

                const payload = {
                    model: modelName,
                    messages: [{ role: "user", content: prompt }]
                    // 🚨 移除了 response_format，防止 Mistral 等模型彈 400 Bad Request
                };

                const res = await axios.post(apiUrl, payload, {
                    headers: { 
                        'Authorization': `Bearer ${cleanKey}`,
                        'Content-Type': 'application/json' 
                    },
                    timeout: 8000 // 8秒極速 Timeout
                });

                const rawText = res.data.choices[0].message.content;
                
                // 🛠️ 暴力正則提取：無視 AI 前後廢話，硬抽 { ... } 出嚟
                const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("AI 未回傳有效 JSON 格式");
                
                return JSON.parse(jsonMatch[0]);
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
            // 若觸發 ALL_KEYS_ON_COOLDOWN、網路異常或解析失敗，平滑降級 (Graceful Degradation)
            console.warn(`⚠️ [Consensus] AI 資源池解析異常或全數冷卻，降級為純量化分數: ${err.message}`);
            return { 
                buy: baseScore >= config.quant.rejectThreshold, 
                score: baseScore, 
                reason: "AI 資源池異常或解析失敗，降級採用純量化結果" 
            };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };