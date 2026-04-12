// src/services/consensusService.js
// 📝 檔案功能用途：V10 終極防彈版 AI 議事廳。唯一負責買入把關的 AI。
// 🚀 升級功能：全線轉用 GROQ，完美對接 cacheManager，並加入純數動態量化兜底。

const { keyRotator } = require('./keyRotator');
const { cacheManager } = require('./cacheManager');
const config = require('../config/config');
const axios = require('axios');

class ConsensusService {
    
    async runMemeConsensus(mint, marketData, options = {}) {
        const poolType = options.poolType || 'TRENDING';
        const climate = options.climate || 'CHOPPY';
        const buyThreshold = options.buyThreshold || 70;

        const isMeme = poolType === 'NEWBORN';
        const promptId = isMeme ? 'meme_scout' : 'trending_scout';

        const buys = marketData.buys5m || 0;
        const sells = marketData.sells5m || 0;
        const totalTxs = buys + sells;
        const avgTrade = totalTxs > 0 ? (marketData.volume5m / totalTxs).toFixed(2) : 0;
        const pseudoOfi = totalTxs > 0 ? ((buys - sells) / totalTxs).toFixed(2) : 'N/A';

        // 🧮 V10 核心升級：若 AI 失效，讀取 Python 智腦計算的「動態量化評分」兜底
        let dynamicMathScore = options.baseScore || 70;
        try {
            const modelStr = await cacheManager.redis.get("cache:dynamic_scoring_model");
            if (modelStr) {
                const mlModel = JSON.parse(modelStr);
                const ofiNum = totalTxs > 0 ? (buys - sells) / totalTxs : 0;
                const liq = marketData.liquidity || 0;
                const vol = marketData.volume5m || 0;
                const turnover = liq > 0 ? vol / liq : 0;
                
                let score = mlModel.base_math_score || 50;
                if (ofiNum >= (mlModel.avg_ofi || 0.1)) score += (mlModel.ofi_bonus_score || 15);
                if (liq >= (mlModel.avg_entry_liq || 5000) * 0.8) score += (mlModel.liq_bonus_score || 10);
                if (turnover >= 0.2 && turnover <= 2.0) score += (mlModel.volume_bonus_score || 15);
                
                dynamicMathScore = Math.min(100, Math.max(0, Math.floor(score)));
            }
        } catch(e) {
            // 忽略讀取錯誤，使用預設 baseScore
        }

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) {
            console.log(`[Consensus] ⚠️ 無 GROQ 金鑰，直接使用量化動態原判 (${dynamicMathScore} 分)`);
            return { buy: dynamicMathScore >= buyThreshold, score: dynamicMathScore, reason: "純量化動態模式 (GROQ 未啟用)" };
        }

        // 🚀 核心：對接 cacheManager，確保所有 {{變數}} 都有對應的數值傳入，並注入動態基準分
        const aiConfig = cacheManager.getPromptConfig(promptId, {
            token_symbol: marketData.symbol,
            climate: climate,
            baseScore: dynamicMathScore, 
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

            // 🧮 提取最終分數 (如果 AI 無畀，用動態基準分)
            let finalScore = dynamicMathScore;
            if (aiResult.score !== undefined && !isNaN(aiResult.score)) {
                finalScore = parseInt(aiResult.score);
            }

            const isBuy = finalScore >= buyThreshold;
            console.log(`[Consensus] 🧠 AI 最終裁決: 得分 ${finalScore}`);

            return { buy: isBuy, score: finalScore, reason: `[${aiSignature}] 裁決: ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] AI 資源池異常，降級為純量化動態分數: ${err.message}`);
            return { buy: dynamicMathScore >= buyThreshold, score: dynamicMathScore, reason: "AI 資源池異常或全線冷卻，降級採用純量化動態結果" };
        }
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };