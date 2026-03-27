// src/services/aiOrchestrator.js
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require('../config/env');
const { healthMonitor } = require('./healthMonitor');

/**
 * 🧠 系統大腦總機：AI Orchestrator
 * 負責統籌所有 LLM 請求，實施左輪手槍輪換、對角線錯位與死亡線機制。
 */
class AIOrchestrator {
    constructor() {
        this.geminiKeys = config.ai.geminiKeys;
        this.currentGeminiIndex = 0;
        this.geminiClients = this.geminiKeys.map(key => new GoogleGenerativeAI(key));

        if (this.geminiClients.length === 0) {
            console.error("❌ [AI Orchestrator] 嚴重錯誤：找不到任何 Gemini API Key！");
        }

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

        this.requestCount = 0; 
    }

    _getNextGeminiClient() {
        if (this.geminiClients.length === 0) throw new Error("無可用的 Gemini API Key");
        const client = this.geminiClients[this.currentGeminiIndex];
        this.currentGeminiIndex = (this.currentGeminiIndex + 1) % this.geminiClients.length;
        return client;
    }

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

    _getFallbackProvider(primary) {
        if (primary === 'GROQ' || primary === 'MISTRAL') return 'GEMINI';
        return 'GROQ'; 
    }

    _enforceTokenLimit(prompt) {
        return prompt + "\n\n(CRITICAL INSTRUCTION: You MUST keep your output reasoning strictly under 50 words to minimize latency. Return valid JSON only without markdown tags.)";
    }

    /**
     * 📡 底層 API 呼叫器 (🚀 修正：正確接收並應用 timeoutLimit)
     */
    async _callProvider(provider, promptText, timeoutLimit = 25000) {
        const limitedPrompt = this._enforceTokenLimit(promptText);
        
        if (provider === 'GEMINI') {
            const client = this._getNextGeminiClient();
            const model = client.getGenerativeModel({ model: this.apiConfig.GEMINI.model });
            
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`[GEMINI] 觸發死亡線 (${timeoutLimit/1000}s)`)), timeoutLimit);
            });

            try {
                const fetchPromise = model.generateContent({
                    contents: [{ role: "user", parts: [{ text: limitedPrompt }] }],
                    generationConfig: { responseMimeType: "application/json" }
                });

                const result = await Promise.race([fetchPromise, timeoutPromise]);
                clearTimeout(timeoutId);

                let rawText = result.response.text();
                
                try {
                    const match = rawText.match(/\{[\s\S]*\}/);
                    if (match) return JSON.parse(match[0]);
                    return JSON.parse(rawText); 
                } catch (parseErr) {
                    throw new Error(`JSON 解析失敗: ${parseErr.message}`);
                }

            } catch (error) {
                clearTimeout(timeoutId);
                throw error; 
            }
        } else {
            const cfg = this.apiConfig[provider];
            const source = axios.CancelToken.source();
            
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    source.cancel(`[${provider}] 觸發死亡線 (${timeoutLimit/1000}s)`);
                    reject(new Error(`[${provider}] 觸發死亡線 (${timeoutLimit/1000}s)`));
                }, timeoutLimit);
            });

            try {
                const fetchPromise = axios.post(cfg.url, {
                    model: cfg.model,
                    messages: [{ role: "user", content: limitedPrompt }],
                    response_format: { type: "json_object" }
                }, {
                    headers: { 'Authorization': `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
                    cancelToken: source.token
                });
                
                const res = await Promise.race([fetchPromise, timeoutPromise]);
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
     * 🚀 修正：正確處理 options 並傳遞 timeoutLimit
     */
    async executeTask(role, primaryProvider, promptText, options = {}) {
        // 判斷是否為重型任務 (例如 Master AI 檢討)
        const isHeavyTask = ['EVOLUTION_MASTER', 'BOARD_OF_DIRECTORS', 'MASTER_AI'].includes(role);
        
        // 基礎 25 秒，重型任務 45 秒，如果強制 bypassLimit 則給足 60 秒
        let timeoutLimit = isHeavyTask ? 45000 : 25000;
        if (options.bypassLimit) timeoutLimit = 60000;

        try {
            const result = await this._callProvider(primaryProvider, promptText, timeoutLimit);
            healthMonitor.setStatus(`AI_${role}`, `🟢 正常 (${primaryProvider})`);
            return { ...result, usedProvider: primaryProvider };
        } catch (err) {
            const fallbackProvider = this._getFallbackProvider(primaryProvider);
            console.warn(`⚠️ [AI_${role}] ${primaryProvider} 失效 (${err.message})，瞬間切換至 ${fallbackProvider} 補位！`);
            healthMonitor.setStatus(`AI_${role}`, `🟡 錯峰補位 (${fallbackProvider})`);
    
            try {
                const fallbackResult = await this._callProvider(fallbackProvider, promptText, timeoutLimit);
                return { ...fallbackResult, usedProvider: fallbackProvider };
           } catch (fallbackErr) {
                console.error(`❌ [AI_${role}] 雙端失效！強制輸出 VETO 防禦。(${fallbackErr.message})`);
                healthMonitor.setStatus(`AI_${role}`, `🔴 雙端失效`);
                return { decision: "VETO", reason: "API 雙端崩潰，系統強制防禦", score: 0 };
            }
        }
    }

    async analyzeSentiment(promptText) {
        try {
            const result = await this._callProvider('GROQ', promptText, 25000);
            return result;
        } catch (err) {
            throw err;
        }
    }
}

const aiOrchestrator = new AIOrchestrator();
module.exports = { aiOrchestrator };