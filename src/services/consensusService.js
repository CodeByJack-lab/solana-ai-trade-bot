// src/services/consensusService.js
// 📝 檔案功能用途：V10.23 純粹動態降級版 AI 議事廳
// 🚀 核心升級：嚴格遵守 Zero-Config 原則，模型排序 100% 由 Supabase 決定，代碼僅負責偵測異常並觸發降級。

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

        if (!config.aiKeys.GROQ || config.aiKeys.GROQ.length === 0) return { narrative_score: 0, reason: "GROQ 未啟用" };

        try {
            // 1. 從 Cache (Supabase 同步過來) 讀取動態設定
            const promptConfig = cacheManager.getPromptConfig(promptId, { token_symbol: symbol, name: name });
            const systemPrompt = promptConfig.parsedPrompt;
            
            // 🛡️ 嚴格依賴 DB 傳入的陣列，絕不 Hardcode 覆蓋 (除非 DB 崩潰才用墊底陣列)
            const models = promptConfig.models && promptConfig.models.length > 0 
                ? promptConfig.models 
                : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];

            const aiResult = await keyRotator.runWithKey('GROQ', async (apiKey, retryCount, providerName) => {
                // 根據失敗次數，順序抽取 Supabase 設定的 Model
                const safeIndex = Math.min((retryCount || 0), models.length - 1);
                const selectedModel = models[safeIndex];

                if (retryCount > 0) {
                    console.warn(`🔄 [Consensus] 第 ${retryCount} 次重試，自動降級使用模型: ${selectedModel}`);
                }

                try {
                    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model: selectedModel,
                        messages: [{ role: "system", content: systemPrompt }],
                        temperature: 0.3,
                        max_tokens: 150,
                        response_format: { type: "json_object" }
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        timeout: 5000 // 5秒超時
                    });

                    const content = response.data.choices[0]?.message?.content;
                    
                    // 🚨 核心防禦：如果 Model 回傳空字串 (免費版塞車常見)，當作失敗，拋給排隊系統換 Backup！
                    if (!content || content.trim() === '') {
                        console.warn(`⚠️ [Consensus] 模型 ${selectedModel} 回傳空內容，觸發降級切換...`);
                        throw new Error('NO_CONTENT_FOUND');
                    }

                    const parsed = JSON.parse(content);
                    parsed.ai_signature = `${providerName}_${selectedModel}`;
                    return parsed;
                } catch (e) {
                    throw e; // 將 Error 掟返出去畀 keyRotator 處理 (加 retryCount)
                }
            }, promptId); 

            let nScore = parseInt(aiResult.narrative_score);
            nScore = isNaN(nScore) ? 0 : Math.max(-5, Math.min(10, nScore)); 
            
            console.log(`[Consensus] 🗣️ LLM 評分: ${nScore} 分 | 理由: ${aiResult.reason || '無解釋'}`);
            return { narrative_score: nScore, reason: `[${aiResult.ai_signature}] ${aiResult.reason}` };

        } catch (err) {
            console.warn(`⚠️ [Consensus] 鑒定異常 (全線降級失敗): ${err.message}`);
            return { narrative_score: 0, reason: "LLM 資源池全線異常" };
        }
    }
}

module.exports = { consensusService: new ConsensusService() };