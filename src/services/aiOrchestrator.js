// src/services/aiOrchestrator.js
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require('../config/env');
const { healthMonitor } = require('./healthMonitor');
const { supabase } = require('../config/supabase'); 

/**
 * 🧠 系統大腦總機：AI Orchestrator (終極崗位化 + 獨立 Fallback + 多金鑰分流版)
 */
class AIOrchestrator {
    constructor() {
        this.defaultConfigs = {
            MISTRAL: { model: 'mistral-large-latest', keyName: 'MISTRAL_API_KEY', defaultKey: config.ai.mistralKey },
            GROQ: { model: 'llama-3.3-70b-versatile', keyName: 'GROQ_API_KEY', defaultKey: config.ai.groqKey },
            GEMINI: { model: 'gemini-3-flash', keyName: 'GEMINI_API_KEY_1', defaultKey: config.ai.geminiKeys?.[0] }
        };

        this.roleConfigs = {}; 
        this.requestCount = 0; 
        
        this._initDynamicRoles();
    }

    async _initDynamicRoles() {
        try {
            const { data, error } = await supabase.from('ai_roles').select('*');
            if (!error && data) {
                data.forEach(row => { this.roleConfigs[row.role_name] = row; });
                console.log(`✅ [AI Orchestrator] 已從 DB 加載 ${data.length} 個 AI 崗位配置。`);
            }

            supabase.channel('ai_roles_hot_swap')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'ai_roles' },
                    (payload) => {
                        const roleName = payload.new?.role_name || payload.old?.role_name;
                        console.log(`\n🔄 [Hot-Swap] 偵測到崗位 [${roleName}] 更新，大腦記憶體已靜默刷新！`);
                        if (payload.eventType === 'DELETE') {
                            delete this.roleConfigs[roleName];
                        } else {
                            this.roleConfigs[roleName] = payload.new;
                        }
                    }
                )
                .subscribe();
        } catch (err) {
            console.error("⚠️ [AI Orchestrator] 崗位載入失敗，將維持保底運作:", err.message);
        }
    }

    _getFallbackProvider(primary) {
        if (primary === 'GROQ' || primary === 'MISTRAL') return 'GEMINI';
        return 'GROQ'; 
    }

    // 🚀 修復 1：加入 options 參數，特權放行 Master AI
    _enforceTokenLimit(prompt, options = {}) {
        if (options.bypassLimit) return prompt; // 特權放行，允許長篇大論！
        return prompt + "\n\n(CRITICAL INSTRUCTION: You MUST keep your output reasoning strictly under 50 words to minimize latency. Return valid JSON only without markdown tags.)";
    }

    /**
     * 📡 統一底層呼叫器
     */
    // 🚀 修復 2：接收 options 並傳遞給 _enforceTokenLimit
    async _callProvider(provider, promptText, timeoutLimit, specificModel, specificKeyName, options = {}) {
        const limitedPrompt = this._enforceTokenLimit(promptText, options);
        
        const actualApiKey = process.env[specificKeyName] || this.defaultConfigs[provider]?.defaultKey;

        if (!actualApiKey) {
            throw new Error(`找不到有效金鑰變數: ${specificKeyName}`);
        }
        
        if (provider === 'GEMINI') {
            const client = new GoogleGenerativeAI(actualApiKey);
            const model = client.getGenerativeModel({ model: specificModel });
            
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
                    return JSON.parse(match ? match[0] : rawText); 
                } catch (e) { throw new Error(`JSON 解析失敗: ${e.message}`); }
            } catch (error) {
                clearTimeout(timeoutId);
                throw error; 
            }
        } else {
            const url = (provider === 'GROQ') ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
            const source = axios.CancelToken.source();
            
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    source.cancel(`[${provider}] 觸發死亡線 (${timeoutLimit/1000}s)`);
                    reject(new Error(`[${provider}] 觸發死亡線 (${timeoutLimit/1000}s)`));
                }, timeoutLimit);
            });

            try {
                const fetchPromise = axios.post(url, {
                    model: specificModel, 
                    messages: [{ role: "user", content: limitedPrompt }],
                    response_format: { type: "json_object" }
                }, {
                    headers: { 'Authorization': `Bearer ${actualApiKey}`, 'Content-Type': 'application/json' },
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
     * 🛡️ 三級瀑布式執行任務
     */
    async executeTask(role, legacyProvider, promptText, options = {}) {
        const isHeavyTask = ['EVOLUTION_MASTER', 'BOARD_OF_DIRECTORS', 'MASTER_AI'].includes(role);
        let timeoutLimit = isHeavyTask ? 45000 : 25000;
        if (options.bypassLimit) timeoutLimit = 60000;

        const roleCfg = this.roleConfigs[role] || {};
        
        const primaryProv = roleCfg.provider || legacyProvider;
        const def = this.defaultConfigs[primaryProv] || this.defaultConfigs['GROQ'];

        const pM1 = roleCfg.model_1 || def.model;
        const pK1 = roleCfg.key_1 || def.keyName;
        try {
            // 🚀 修復 3：將 options 傳遞給 _callProvider
            const res1 = await this._callProvider(primaryProv, promptText, timeoutLimit, pM1, pK1, options);
            healthMonitor.setStatus(`AI_${role}`, `🟢 正常 (${primaryProv}_M1)`);
            return { ...res1, usedProvider: `${primaryProv}_M1` };
        } catch (err1) {
            console.warn(`⚠️ [AI_${role}] 主將 M1 (${pM1}) 失效: ${err1.message}`);

            const pM2 = roleCfg.model_2 || pM1;
            const pK2 = roleCfg.key_2 || pK1;
            try {
                console.log(`🔄 [AI_${role}] 嘗試同廠後備: ${pM2} (Key: ${pK2})`);
                const res2 = await this._callProvider(primaryProv, promptText, timeoutLimit, pM2, pK2, options);
                healthMonitor.setStatus(`AI_${role}`, `🟡 同廠降級 (${primaryProv}_M2)`);
                return { ...res2, usedProvider: `${primaryProv}_M2` };
            } catch (err2) {
                console.warn(`⚠️ [AI_${role}] 後備 M2 (${pM2}) 亦失效: ${err2.message}`);

                const fbProv = roleCfg.fallback_provider || this._getFallbackProvider(primaryProv);
                const fbDef = this.defaultConfigs[fbProv] || this.defaultConfigs['GROQ'];
                const fbM = roleCfg.fallback_model || fbDef.model;
                const fbK = roleCfg.fallback_key || fbDef.keyName;

                console.warn(`🔄 [AI_${role}] 啟動最後防線，切換至跨廠補位: ${fbProv} (${fbM})`);
                try {
                    const resFB = await this._callProvider(fbProv, promptText, timeoutLimit, fbM, fbK, options);
                    healthMonitor.setStatus(`AI_${role}`, `🟠 跨廠補位 (${fbProv})`);
                    return { ...resFB, usedProvider: `${fbProv}_FB` };
                } catch (errFB) {
                    console.error(`❌ [AI_${role}] 瀑布式備援全線崩潰！強制 VETO。(${errFB.message})`);
                    healthMonitor.setStatus(`AI_${role}`, `🔴 系統停擺`);
                    // 🚀 修復 4：加上 usedProvider: "FAILED" 解決 undefined 問題
                    return { decision: "VETO", reason: "API 全線崩潰，系統強制防禦", score: 0, usedProvider: "FAILED" };
                }
            }
        }
    }

    getRoutingPlan() {
        this.requestCount++;
        const routes = [['GROQ', 'GEMINI', 'MISTRAL'], ['GEMINI', 'MISTRAL', 'GROQ'], ['MISTRAL', 'GROQ', 'GEMINI']];
        const selected = routes[this.requestCount % 3];
        return { scout: selected[0], strategist: selected[1], auditor: selected[2] };
    }

    async analyzeSentiment(promptText) {
        return await this.executeTask('SENTIMENT', 'GROQ', promptText);
    }
}

const aiOrchestrator = new AIOrchestrator();
module.exports = { aiOrchestrator };