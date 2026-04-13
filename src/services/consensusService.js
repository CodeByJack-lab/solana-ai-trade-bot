// src/services/consensusService.js
// 📝 檔案功能用途：V10.22 終極防彈版 AI 議事廳 (文科生敘事與防山寨中樞)。
// 🚀 升級功能：響應指揮官要求，將 LLM 最大扣分幅度限制為 -5，防止錯殺良民 (範圍: -5 到 +15)。

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
        const desc = marketData.description || 'No description';

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) {
            console.log(`[Consensus] ⚠️ 無 GROQ 金鑰，跳過敘事評分`);
            return { narrative_score: 0, reason: "GROQ 未啟用，敘事+0" };
        }

        const buys = marketData.buys5m || 0;
        const sells = marketData.sells5m || 0;
        const totalTxs = buys + sells;
        const avgTrade = totalTxs > 0 ? (marketData.volume5m / totalTxs).toFixed(2) : 0;
        const pseudoOfi = totalTxs > 0 ? ((buys - sells) / totalTxs).toFixed(2) : 'N/A';

        const aiConfig = cacheManager.getPromptConfig(promptId, {
            token_symbol: symbol,
            climate: climate,
            baseScore: 0, 
            ofi: pseudoOfi,
            avg_trade: avgTrade,
            volume: marketData.volume5m ? marketData.volume5m.toFixed(0) : 0,
            liquidity: marketData.liquidity ? marketData.liquidity.toFixed(0) : 0,
            h1: marketData.h1 ? marketData.h1.toFixed(2) : 0 
        });

        // 🚨 FIX: Prompt 指引改為 -5 到 +15
        const formatInstruction = `\n\n[CRITICAL INSTRUCTION FOR V10 SYSTEM]
You are NO LONGER making BUY or VETO decisions. Your ONLY job is to evaluate the narrative, detect cult potential, and heavily penalize fake/impersonation tokens.

Evaluate the following token:
Symbol: ${symbol}
Name: ${name}
Description: ${desc}

You MUST output EXACTLY this JSON format (no extra text):
{
  "narrative_score": <integer from -5 to +15>,
  "reason": "<short explanation>"
}

Scoring Guide:
+10 to +15: Top-tier narrative (e.g., AI Agent, Elon Musk latest trend), highly original, strong cult potential.
+1 to +9: Good normal meme, clear concept, no red flags.
0: Uncertain, lack of info, or neutral. If you are unsure if it's a scam, give 0.
-1 to -4: Emotional manipulation ("buy or stay poor"), low-effort copycat.
-5: FAKE / IMPERSONATION. If it attempts to mimic famous brands, celebrities, countries, or tickers but looks like a suspicious variation (e.g., "AppIe", "E1on", "OPENAI", "USAOIL"), apply MAXIMUM PENALTY (-5)!`;

        const prompt = aiConfig.parsedPrompt + formatInstruction;

        try {
            const aiResult = await keyRotator.enqueueRequest('GROQ', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
                const modelName = aiConfig.models[0] || 'llama-3.3-70b-versatile';
                const providerName = 'GROQ';
                
                console.log(`[KeyRotator] 🧠 系統抽中 ${providerName} (${modelName}) 進行敘事鑒定 [劇本: ${promptId}]...`);

                try {
                    const payload = {
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" }, 
                        temperature: 0.1 
                    };

                    const res = await axios.post(apiUrl, payload, {
                        headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' },
                        timeout: 10000
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
                    console.warn(`❌ [AI Failed] ${providerName} (${modelName}) 鑒定異常 | Status: ${status} | 錯誤: ${errMsg}`);
                    throw e; 
                }
            }, promptId); 

            const aiSignature = aiResult.ai_signature || 'GROQ_UNKNOWN';
            
            // 🚨 FIX: 邊界防護卡死在 -5 到 +15
            let nScore = 0;
            if (aiResult.narrative_score !== undefined && !isNaN(aiResult.narrative_score)) {
                nScore = parseInt(aiResult.narrative_score);
                nScore = Math.max(-5, Math.min(15, nScore)); 
            }

            const aiReason = aiResult.reason || '無解釋';
            
            console.log(`[Consensus] 🗣️ LLM 敘事評分: ${nScore > 0 ? '+' : ''}${nScore} 分 | 理由: ${aiReason}`);

            return { narrative_score: nScore, reason: `[${aiSignature}] ${aiReason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] LLM 敘事鑒定異常或全線冷卻，跳過加減分: ${err.message}`);
            return { narrative_score: 0, reason: "LLM 資源池異常，敘事分數 +0" };
        }
    }

    async runWatchdogConsensus(mint, symbol, pnl, cvd, vwap_dev, volatility, climate) {
        return { action: 'HOLD', reason: 'Fallback to Math Guard' }; 
    }
}

const consensusService = new ConsensusService();
module.exports = { consensusService };