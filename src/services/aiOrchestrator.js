// src/services/aiOrchestrator.js
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require('../config/env');
const { healthMonitor } = require('./healthMonitor');

/**
 * 🧠 系統大腦總機：AI Orchestrator
 * 負責統籌所有 LLM 請求，實施左輪手槍輪換、對角線錯位與 8 秒死亡線機制。
 */
class AIOrchestrator {
    constructor() {
        // 1. 「左輪手槍」式密鑰輪換 (Key Round-Robin)
        this.geminiKeys = config.ai.geminiKeys;
        this.currentGeminiIndex = 0;
        this.geminiClients = this.geminiKeys.map(key => new GoogleGenerativeAI(key));

        if (this.geminiClients.length === 0) {
            console.error("❌ [AI Orchestrator] 嚴重錯誤：找不到任何 Gemini API Key！");
        }

        // 定義各家 API 接口
        this.apiConfig = {
            MISTRAL: { 
                url: 'https://api.mistral.ai/v1/chat/completions', 
                key: config.ai.mistralKey, 
                model: 'mistral-large-latest' 
            },
            GROQ: { 
                url: 'https://api.groq.com/openai/v1/chat/completions', 
                key: config.ai.groqKey, 
                model: 'llama3-70b-8192' 
            },
            GEMINI: { 
                model: 'gemini-3.1-flash-lite-preview' 
            }
        };

        this.requestCount = 0; // 用於對角線錯位計算
    }

    /**
     * 🔄 獲取下一個可用的 Gemini Client (轉動左輪手槍彈倉)
     */
    _getNextGeminiClient() {
        if (this.geminiClients.length === 0) throw new Error("無可用的 Gemini API Key");
        const client = this.geminiClients[this.currentGeminiIndex];
        this.currentGeminiIndex = (this.currentGeminiIndex + 1) % this.geminiClients.length;
        return client;
    }

    /**
     * 2. 「對角線錯位」流水線 (Diagonal Staggering)
     * 確保同一時間唔會超過 2 隻幣喺同一個模型度爭位
     */
    getRoutingPlan() {
        this.requestCount++;
        const routes = [
            ['GROQ', 'GEMINI', 'MISTRAL'],
            ['GEMINI', 'MISTRAL', 'GROQ'],
            ['MISTRAL', 'GROQ', 'GEMINI']
        ];
        const selectedRoute = routes[this.requestCount % 3];
        return {
            scout: selectedRoute[0],
            strategist: selectedRoute[1],
            auditor: selectedRoute[2]
        };
    }

    /**
     * 3. 「拉鍊式」墊底緩衝 (Interleaved Buffering)
     * 如果主將係 Groq/Mistral，副將必定配一個無限水喉 Gemini
     */
    _getFallbackProvider(primary) {
        if (primary === 'GROQ' || primary === 'MISTRAL') return 'GEMINI';
        return 'GROQ'; // 如果 Gemini 死，就用 Groq 頂上
    }

    /**
     * 🛡️ 50 字限縮令 (Token Limiter)
     */
    _enforceTokenLimit(prompt) {
        return prompt + "\n\n(CRITICAL INSTRUCTION: You MUST keep your output reasoning strictly under 50 words to minimize latency. Return valid JSON only without markdown tags.)";
    }

    /**
     * 📡 底層 API 呼叫器 (含 8 秒死亡線 Hard Timeout)
     */
    async _callProvider(provider, promptText) {
        const limitedPrompt = this._enforceTokenLimit(promptText);
        
        if (provider === 'GEMINI') {
            const client = this._getNextGeminiClient();
            const model = client.getGenerativeModel({ model: this.apiConfig.GEMINI.model });
            
            // 🛡️ 8 秒死亡線
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`[GEMINI] 8秒死亡線超時，強行斬斷`)), 8000);
            });

            try {
                const fetchPromise = model.generateContent({
                    contents: [{ role: "user", parts: [{ text: limitedPrompt }] }],
                    generationConfig: { responseMimeType: "application/json" }
                });

                const result = await Promise.race([fetchPromise, timeoutPromise]);
                clearTimeout(timeoutId);

                let rawText = result.response.text();
                
                // 🚀 防彈 JSON 提取：先試 Regex，失敗再試原生 Parse
                try {
                    const match = rawText.match(/\{[\s\S]*\}/);
                    if (match) return JSON.parse(match[0]);
                    return JSON.parse(rawText); // 終極 Fallback
                } catch (parseErr) {
                    throw new Error(`JSON 解析失敗: ${parseErr.message}`);
                }

            } catch (error) {
                clearTimeout(timeoutId);
                throw error; 
            }
        } else {
            // Groq 或 Mistral 呼叫
            const cfg = this.apiConfig[provider];
            const source = axios.CancelToken.source();
            const timeoutId = setTimeout(() => source.cancel(`[${provider}] 8秒死亡線超時，強行斬斷`), 8000);

            try {
                const res = await axios.post(cfg.url, {
                    model: cfg.model,
                    messages: [{ role: "user", content: limitedPrompt }],
                    response_format: { type: "json_object" }
                }, {
                    headers: { 'Authorization': `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
                    cancelToken: source.token
                });
                clearTimeout(timeoutId);
                return JSON.parse(res.data.choices[0].message.content);
            } catch (err) {
                clearTimeout(timeoutId);
                throw err;
            }
        }
    }

    /**
     * 🛡️ 錯誤自癒 (Auto-Fallback)
     * 主將失敗，副將無縫補位
     */
    async executeTask(role, primaryProvider, promptText) {
        try {
            const result = await this._callProvider(primaryProvider, promptText);
            healthMonitor.setStatus(`AI_${role}`, `🟢 正常 (${primaryProvider})`);
            return { ...result, usedProvider: primaryProvider };
        } catch (err) {
            const fallbackProvider = this._getFallbackProvider(primaryProvider);
            console.warn(`⚠️ [AI_${role}] ${primaryProvider} 觸發死亡線或報錯，瞬間切換至 ${fallbackProvider} 補位！`);
            healthMonitor.setStatus(`AI_${role}`, `🟡 錯峰補位 (${fallbackProvider})`);
            
            try {
                const fallbackResult = await this._callProvider(fallbackProvider, promptText);
                return { ...fallbackResult, usedProvider: fallbackProvider };
            } catch (fallbackErr) {
                console.error(`❌ [AI_${role}] 雙端失效！強制輸出 VETO 防禦。`);
                healthMonitor.setStatus(`AI_${role}`, `🔴 雙端失效`);
                return { decision: "VETO", reason: "API 雙端崩潰，系統強制防禦", score: 0 };
            }
        }
    }

    /**
     * 🧠 專屬通道：快速情感分析 (用於新聞大盤)
     */
    async analyzeSentiment(promptText) {
        try {
            // 新聞大盤分析預設走 GROQ，速度最快
            const result = await this._callProvider('GROQ', promptText);
            return result;
        } catch (err) {
            throw err;
        }
    }
}

// 導出單例模式
const aiOrchestrator = new AIOrchestrator();
module.exports = { aiOrchestrator };