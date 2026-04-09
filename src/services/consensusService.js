// src/services/consensusService.js
// 📝 檔案功能用途：V9.4 終極防彈版 AI 議事廳。唯一負責買入把關的 AI。
// 🚀 升級功能：強制植入「AI 簽名水印」，實裝絕對 VETO 否決權。
// 🛡️ 智能切換：根據 Router 傳來的 poolType 動態切換 meme_scout / trending_scout 劇本，並注入均價數據攔截乞丐刷量。

const { keyRotator } = require('./keyRotator');
const { promptManager } = require('./promptManager'); 
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const baseScore = options.baseScore || 60; 
        const poolType = options.poolType || 'TRENDING';
        const climate = options.climate || 'CHOPPY';

        if (config.aiKeys.length === 0) {
            console.log(`[Consensus] ⚠️ 無 AI 金鑰，直接使用量化原判 (${baseScore} 分)`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "純量化模式 (AI 未啟用)" };
        }

        // 🧠 核心邏輯 1：動態選擇對應的劇本
        const isMeme = poolType === 'NEWBORN';
        const promptId = isMeme ? 'meme_scout' : 'trending_scout';

        // 🧮 核心邏輯 2：計算 avg_trade (單筆均價，攔截乞丐刷量的必殺技)
        const buys = marketData.buys5m || 0;
        const sells = marketData.sells5m || 0;
        const totalTxs = buys + sells;
        const avgTrade = totalTxs > 0 ? (marketData.volume5m / totalTxs).toFixed(2) : 0;
        
        // 計算偽 OFI (以應對 API 回傳無 OFI 的情況)
        const pseudoOfi = totalTxs > 0 ? ((buys - sells) / totalTxs).toFixed(2) : 'N/A';

        // 動態獲取劇本並注入實時數據
        const aiConfig = promptManager.getPromptConfig(promptId, {
            token_symbol: marketData.symbol,
            climate: climate,
            ofi: pseudoOfi,
            avg_trade: avgTrade,
            volume: marketData.volume5m ? marketData.volume5m.toFixed(0) : 0,
            liquidity: marketData.liquidity ? marketData.liquidity.toFixed(0) : 0
        });

        const prompt = aiConfig.parsedPrompt;

        try {
            const aiResult = await keyRotator.enqueueRequest(async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                
                const isGroq = cleanKey.startsWith('gsk_');
                const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                // 優先使用 DB 配置的模型
                const modelName = aiConfig.models[0] || (isGroq ? 'llama-3.3-70b-versatile' : 'mistral-large-latest');
                const providerName = isGroq ? 'GROQ' : 'MISTRAL';
                
                console.log(`[KeyRotator] 🔫 系統抽中 ${providerName} (${modelName}) 進行審批 [劇本: ${promptId}]...`);

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
                    parsedJson.ai_signature = `${providerName} | ${modelName}`;
                    
                    console.log(`✅ [AI Success] 獲取裁決。簽名: [${parsedJson.ai_signature}] | 決策: ${parsedJson.decision || 'N/A'}`);
                    return parsedJson;

                } catch (e) {
                    const status = e.response?.status || 'N/A';
                    const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) 審批陣亡 | Status: ${status} | 死因: ${errMsg}`);
                    throw e; 
                }
            });

            const aiSignature = aiResult.ai_signature || 'UNKNOWN_AI';
            const decision = aiResult.decision || 'PASS';

            // 🛑 核心邏輯 3：終極 VETO 攔截 (無視任何分數，直接一票否決)
            if (decision === 'VETO') {
                console.log(`[Consensus] 🛑 AI 強制否決 (VETO)！維持不買入。`);
                return { buy: false, score: 0, reason: `[${aiSignature}] 🛑 觸發 VETO 否決: ${aiResult.reason}` };
            }

            // 🧮 兼容新舊 JSON 格式的分數計算
            let finalScore = baseScore;
            if (aiResult.score !== undefined && !isNaN(aiResult.score)) {
                // 新版 meme_scout / trending_scout 模式 (AI 直接畀最終分數)
                finalScore = parseInt(aiResult.score);
            } else if (aiResult.adjustment !== undefined) {
                // 舊版 quant_consensus 模式 (加減分)
                let adjustment = parseInt(aiResult.adjustment) || 0;
                const maxAdjust = (baseScore >= 75) ? config.aiRules.adjustLimitHigh : config.aiRules.adjustLimitLow;
                adjustment = Math.max(-maxAdjust, Math.min(maxAdjust, adjustment));
                finalScore = baseScore + adjustment;
            }

            // 防護：如果 AI 給出的分數低於及格線，亦視為不買入
            const isBuy = finalScore >= config.quant.rejectThreshold;
            console.log(`[Consensus] 🧠 AI 最終裁決: 得分 ${finalScore}`);

            return { buy: isBuy, score: finalScore, reason: `[${aiSignature}] 裁決: ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] AI 資源池全線陣亡，降級為純量化分數: ${err.message}`);
            return { buy: baseScore >= config.quant.rejectThreshold, score: baseScore, reason: "AI 資源池異常，降級採用純量化結果" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };