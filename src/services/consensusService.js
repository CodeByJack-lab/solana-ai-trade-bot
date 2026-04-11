// src/services/consensusService.js
// 📝 檔案功能用途：V10 終極防彈版 AI 議事廳。唯一負責買入把關的 AI。
// 🚀 升級功能：全線轉用 GROQ，並完美對接 cacheManager 讀取 Redis 熱更新劇本。

const { keyRotator } = require('./keyRotator');
const { cacheManager } = require('./cacheManager');
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const baseScore = options.baseScore || 70; 
        const poolType = options.poolType || 'TRENDING';
        const climate = options.climate || 'CHOPPY';
        const buyThreshold = options.buyThreshold || 70;

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) {
            console.log(`[Consensus] ⚠️ 無 GROQ 金鑰，直接使用量化原判 (${baseScore} 分)`);
            return { buy: baseScore >= buyThreshold, score: baseScore, reason: "純量化模式 (GROQ 未啟用)" };
        }

        const isMeme = poolType === 'NEWBORN';
        const promptId = isMeme ? 'meme_scout' : 'trending_scout';

        const buys = marketData.buys5m || 0;
        const sells = marketData.sells5m || 0;
        const totalTxs = buys + sells;
        const avgTrade = totalTxs > 0 ? (marketData.volume5m / totalTxs).toFixed(2) : 0;
        const pseudoOfi = totalTxs > 0 ? ((buys - sells) / totalTxs).toFixed(2) : 'N/A';

        // 🚀 核心：對接 cacheManager，確保所有 {{變數}} 都有對應的數值傳入
        const aiConfig = cacheManager.getPromptConfig(promptId, {
            token_symbol: marketData.symbol,
            climate: climate,
            baseScore: baseScore,
            ofi: pseudoOfi,
            avg_trade: avgTrade,
            volume: marketData.volume5m ? marketData.volume5m.toFixed(0) : 0,
            liquidity: marketData.liquidity ? marketData.liquidity.toFixed(0) : 0,
            h1: marketData.h1 ? marketData.h1.toFixed(2) : 0 
        });

        const prompt = aiConfig.parsedPrompt;

        try {
            // 🚀 指定 GROQ 並傳入 promptId 供 KeyRotator 識別
            const aiResult = await keyRotator.enqueueRequest('GROQ', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
                const modelName = aiConfig.models[0] || 'llama-3.3-70b-versatile';
                const providerName = 'GROQ';
                
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
                    
                    return parsedJson;

                } catch (e) {
                    const status = e.response?.status || 'N/A';
                    const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) 審批陣亡 | Status: ${status} | 死因: ${errMsg}`);
                    throw e; 
                }
            }, promptId); 

            const aiSignature = aiResult.ai_signature || 'GROQ_UNKNOWN';
            const decision = aiResult.decision || 'PASS';

            // 🛑 VETO 攔截
            if (decision === 'VETO') {
                console.log(`[Consensus] 🛑 AI 強制否決 (VETO)！`);
                return { buy: false, score: 0, reason: `[${aiSignature}] 🛑 觸發 VETO: ${aiResult.reason}` };
            }

            // 🧮 提取最終分數
            let finalScore = baseScore;
            if (aiResult.score !== undefined && !isNaN(aiResult.score)) {
                finalScore = parseInt(aiResult.score);
            }

            const isBuy = finalScore >= buyThreshold;
            console.log(`[Consensus] 🧠 AI 最終裁決: 得分 ${finalScore}`);

            return { buy: isBuy, score: finalScore, reason: `[${aiSignature}] 裁決: ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] AI 資源池異常，降級為純量化分數: ${err.message}`);
            return { buy: baseScore >= buyThreshold, score: baseScore, reason: "AI 資源池異常或全線冷卻，降級採用純量化結果" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };