// src/services/consensusService.js
// 📝 檔案功能用途：V9.2 終極防彈版 AI 議事廳。動態對接 Prompt Manager 獲取英文思維鏈劇本，並透過 KeyRotator 發送請求。

const { keyRotator } = require('./keyRotator');
const { promptManager } = require('./promptManager'); // 🛡️ 引入 Prompt 大腦
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    /**
     * 🧠 執行 AI 數據共識微調
     */
    async runMemeConsensus(mint, marketData, options = {}) {
        const baseScore = options.baseScore || 60;

        if (config.aiKeys.length === 0) {
            console.log(`[Consensus] ⚠️ 無 AI 金鑰，直接使用量化原判 (${baseScore} 分)`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "純量化模式 (AI 未啟用)" };
        }

        // 🚀 動態獲取 V9.2 英文思維鏈 Prompt
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
            // 將請求推入 1秒延遲 與 429輪替 的資源池
            const aiResult = await keyRotator.enqueueRequest(async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                
                let keyName = 'UNKNOWN_KEY';
                for (const [envKey, envVal] of Object.entries(process.env)) {
                    if (envVal && typeof envVal === 'string' && envVal.replace(/['"]/g, '').trim() === cleanKey) {
                        keyName = envKey;
                        break;
                    }
                }
                
                // 自動判別 API 供應商
                const isGroq = cleanKey.startsWith('gsk_');
                const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                
                // 為求穩定，Consensus 依然使用預設的高頻模型
                const modelName = isGroq ? 'llama-3.3-70b-versatile' : 'mistral-small-latest';
                const providerName = isGroq ? 'GROQ' : 'MISTRAL';
                
                console.log(`[KeyRotator] 🔫 系統抽中 ${providerName} (${modelName}) [Key Name: ${keyName}] 進行審批...`);

                try {
                    const payload = {
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" } // 強制 JSON 輸出
                    };

                    const res = await axios.post(apiUrl, payload, {
                        headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' },
                        timeout: 10000 
                    });

                    const rawText = res.data.choices[0].message.content;
                    
                    // 🛠️ 暴力正則提取：無視 AI 前後廢話，硬抽 { ... } 出嚟
                    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error("AI 未回傳有效 JSON 格式");
                    
                    const parsedJson = JSON.parse(jsonMatch[0]);
                    
                    // JSON.parse 會自動將 english_thought_process 分離，我們只抽需要的數值
                    console.log(`✅ [AI Success] ${providerName} (${modelName}) [Key Name: ${keyName}] 回傳成功！信心度: ${parsedJson.confidence}, 調整分: ${parsedJson.adjustment}, 理由: "${parsedJson.reason}"`);
                    
                    return parsedJson;

                } catch (e) {
                    const status = e.response?.status || 'N/A';
                    const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) [Key Name: ${keyName}] 審批陣亡 | Status: ${status} | 死因: ${errMsg}`);
                    throw e; 
                }
            });

            const confidence = parseFloat(aiResult.confidence) || 0;
            let adjustment = parseInt(aiResult.adjustment) || 0;

            if (confidence < config.aiRules.minConfidence) {
                console.log(`[Consensus] 🛡️ AI 信心不足 (${confidence})，維持原判 ${baseScore} 分。`);
                return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: `AI 信心不足 (${confidence})，維持量化原判` };
            }

            const maxAdjust = (baseScore >= 75) ? config.aiRules.adjustLimitHigh : config.aiRules.adjustLimitLow;
            adjustment = Math.max(-maxAdjust, Math.min(maxAdjust, adjustment));

            const finalScore = baseScore + adjustment;
            const isBuy = finalScore >= config.quant.rejectThreshold;
            const sign = adjustment >= 0 ? '+' : '';

            console.log(`[Consensus] 🧠 AI 最終裁決: ${baseScore} ${sign}${adjustment} = ${finalScore} 分`);

            return { buy: isBuy, score: finalScore, reason: `AI 裁決 (${sign}${adjustment}分): ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] AI 資源池全線陣亡，降級為純量化分數: ${err.message}`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "AI 資源池異常或全線冷卻，降級採用純量化結果" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };