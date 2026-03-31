// src/services/aiOrchestrator.js
// 📝 檔案功能及用途：系統 AI 大腦總機。實裝企業級「狀態指針輪替」與「三振出局Alert」。精確溯源環境變數名稱 (Env Var Name)，100% 保障安全且方便維護！

const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { healthMonitor } = require('./healthMonitor');
const { supabase } = require('../config/supabase'); 
const { sendAdminAlert } = require('./telegramService');

class AIOrchestrator {
    constructor() {
        // 🚀 V9.0 升級：直接追蹤環境變數名稱，而非 Token 字串
        this.defaultConfigs = {
            MISTRAL: { model: 'mistral-large-latest', keyNames: ['MISTRAL_API_KEY_1', 'MISTRAL_API_KEY_2', 'MISTRAL_API_KEY_3'] },
            GROQ: { model: 'llama-3.3-70b-versatile', keyNames: ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3'] },
            GEMINI: { model: 'gemini-3.1-flash-lite-preview', keyNames: ['GEMINI_API_KEY_1', 'GEMINI_API_KEY_2'] }
        };

        this.roleConfigs = {}; 
        this.activePointers = {}; 
        this.errorCounts = {};    
        
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
                .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_roles' }, (payload) => {
                    const roleName = payload.new?.role_name || payload.old?.role_name;
                    console.log(`\n🔄 [Hot-Swap] 偵測到崗位 [${roleName}] 更新，大腦記憶體已靜默刷新！`);
                    if (payload.eventType === 'DELETE') delete this.roleConfigs[roleName];
                    else this.roleConfigs[roleName] = payload.new;
                    
                    this.activePointers[roleName] = 0; 
                }).subscribe();
        } catch (err) {
            console.error("⚠️ [AI Orchestrator] 崗位載入失敗，將維持保底運作:", err.message);
        }
    }

    _enforceTokenLimit(prompt, options = {}) {
        if (options.bypassLimit) return prompt; 
        return prompt + "\n\n(CRITICAL INSTRUCTION: You MUST keep your output reasoning strictly under 50 words to minimize latency. Return valid JSON only without markdown tags.)";
    }

    /**
     * 🛡️ 獲取該供應商目前有填寫的環境變數名稱清單
     */
    _getAvailableKeyNames(provider) {
        const names = this.defaultConfigs[provider]?.keyNames || [];
        return names.filter(name => !!process.env[name]);
    }

    async _callProvider(provider, promptText, timeoutLimit, specificModel, specificKeyName, options = {}) {
        const limitedPrompt = this._enforceTokenLimit(promptText, options);
        
        let actualKeyName = specificKeyName;
        let actualApiKey = process.env[actualKeyName];
        
        // 如果特定 Key 搵唔到，自動喺可用陣列入面抽一把
        if (!actualApiKey) {
            const availableNames = this._getAvailableKeyNames(provider);
            if (availableNames.length > 0) {
                actualKeyName = availableNames[Math.floor(Math.random() * availableNames.length)];
                actualApiKey = process.env[actualKeyName];
            }
        }

        if (!actualApiKey) {
            const noKeyErr = new Error(`未配置有效的 API 金鑰變數`);
            noKeyErr.usedKeyName = actualKeyName || 'N/A';
            throw noKeyErr;
        }

        if (provider === 'GEMINI') {
            const client = new GoogleGenerativeAI(actualApiKey);
            const model = client.getGenerativeModel({ model: specificModel });
            
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`[Timeout] 觸發死亡線 (${timeoutLimit/1000}s)`)), timeoutLimit);
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
                error.usedKeyName = actualKeyName; // 🎯 掛載陣亡變數名稱
                throw error; 
            }
        } else {
            const url = (provider === 'GROQ') ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
            const source = axios.CancelToken.source();
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    source.cancel(`觸發死亡線 (${timeoutLimit/1000}s)`);
                    reject(new Error(`[Timeout] 觸發死亡線 (${timeoutLimit/1000}s)`));
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
                err.usedKeyName = actualKeyName; // 🎯 掛載陣亡變數名稱
                throw err;
            }
        }
    }

    _getProviderQueue(role, legacyProvider) {
        const roleCfg = this.roleConfigs[role] || {};
        let queue = [];

        if (roleCfg.provider) {
            queue.push({ prov: roleCfg.provider, model: roleCfg.model_1 || this.defaultConfigs[roleCfg.provider].model, key: roleCfg.key_1 });
            if (roleCfg.model_2) queue.push({ prov: roleCfg.provider, model: roleCfg.model_2, key: roleCfg.key_2 || roleCfg.key_1 });
            if (roleCfg.fallback_provider) queue.push({ prov: roleCfg.fallback_provider, model: roleCfg.fallback_model || this.defaultConfigs[roleCfg.fallback_provider].model, key: roleCfg.fallback_key });
        } else {
            if (role === 'SENTIMENT' || legacyProvider === 'GEMINI') {
                queue.push({ prov: 'GEMINI', model: this.defaultConfigs['GEMINI'].model, key: null });
                queue.push({ prov: 'GROQ', model: this.defaultConfigs['GROQ'].model, key: null }); 
                queue.push({ prov: 'MISTRAL', model: this.defaultConfigs['MISTRAL'].model, key: null });
            } else {
                queue.push({ prov: 'GROQ', model: this.defaultConfigs['GROQ'].model, key: null });
                queue.push({ prov: 'MISTRAL', model: this.defaultConfigs['MISTRAL'].model, key: null });
            }
        }
        return queue;
    }

    async executeTask(role, legacyProvider, promptText, options = {}) {
        const isHeavyTask = ['EVOLUTION_MASTER', 'BOARD_OF_DIRECTORS', 'MASTER_AI'].includes(role);
        let timeoutLimit = isHeavyTask ? 45000 : 20000;
        if (options.bypassLimit) timeoutLimit = 60000;

        const queue = this._getProviderQueue(role, legacyProvider);
        if (queue.length === 0) throw new Error(`[AI Gateway] 崗位 ${role} 無可用列陣！`);

        if (this.activePointers[role] === undefined) this.activePointers[role] = 0;
        
        for (let i = 0; i < queue.length; i++) {
            const idx = (this.activePointers[role] + i) % queue.length;
            const target = queue[idx];
            const errKey = `${role}_${target.prov}_${target.model}`;

            try {
                const result = await this._callProvider(target.prov, promptText, timeoutLimit, target.model, target.key, options);
                
                this.activePointers[role] = idx;
                this.errorCounts[errKey] = 0;
                
                healthMonitor.setStatus(`AI_${role}`, `🟢 正常 (${target.prov})`);
                return { ...result, usedProvider: target.prov };

            } catch (err) {
                this.errorCounts[errKey] = (this.errorCounts[errKey] || 0) + 1;
                const deadKeyName = err.usedKeyName || 'UNKNOWN_VAR';
                
                console.warn(`⚠️ [AI Gateway] 崗位 ${role} 呼叫 ${target.prov} 失敗 (${this.errorCounts[errKey]}/3): ${err.message} (Var: ${deadKeyName})`);

                // 🚨 帶有安全變數名稱追蹤的 三振出局 Alert
                if (this.errorCounts[errKey] === 3) {
                    sendAdminAlert(`🚨 <b>AI 狀態指針輪替</b>\n\n🛡️ <b>崗位:</b> ${role}\n🤖 <b>供應商:</b> ${target.prov}\n🔑 <b>陣亡變數:</b> <code>${deadKeyName}</code>\n❌ <b>錯誤:</b> ${err.message}\n\n⚠️ 連續 3 次崩潰！系統已自動將主力指針切換至下一順位備援。`);
                    this.errorCounts[errKey] = 0; 
                }
            }
        }

        healthMonitor.setStatus(`AI_${role}`, `🔴 全線癱瘓`);
        return { decision: "VETO", reason: "所有 AI 供應商均已宕機，為安全起見強制否決。", score: 0, usedProvider: "FAILED" };
    }

    getRoutingPlan() {
        return { scout: 'GROQ', strategist: 'MISTRAL', auditor: 'GROQ' }; 
    }
}

const aiOrchestrator = new AIOrchestrator();
module.exports = { aiOrchestrator };