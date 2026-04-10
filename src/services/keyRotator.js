// src/services/keyRotator.js
const config = require('../config/config');

class KeyRotator {
    constructor() {
        this.keys = config.aiKeys || { GROQ: [], MISTRAL: [], GEMINI: [] };
        console.log(`🧠 [KeyRotator] 資源池就緒: GROQ(${this.keys.GROQ?.length || 0}) | MISTRAL(${this.keys.MISTRAL?.length || 0}) | GEMINI(${this.keys.GEMINI?.length || 0})`);

        this.currentIndex = { GROQ: 0, MISTRAL: 0, GEMINI: 0 };
        this.cooldowns = new Map(); 
        this.queue = [];            
        this.isProcessing = false;  
    }

    _isOnCooldown(key) {
        return Date.now() < (this.cooldowns.get(key) || 0);
    }

    _markKeyOnCooldown(key) {
        const cooldownMinutes = 5;
        this.cooldowns.set(key, Date.now() + (cooldownMinutes * 60 * 1000));
        console.warn(`🔥 [KeyRotator] 金鑰觸發 429！關入小黑屋冷卻 ${cooldownMinutes} 分鐘。`);
    }

    // 🚀 Mistral 專屬智能派 Key 邏輯
    _getMistralKey(promptId) {
        const mKeys = this.keys.MISTRAL || [];
        if (mKeys.length === 0) return null;

        let preferredIndex = 0; // 預設共用 Key 1 (Index 0)
        if (promptId === 'POSITION_WATCHDOG' && mKeys.length >= 3) preferredIndex = 2; // 獨立用 Key 3
        else if (promptId === 'backtest_analyst' && mKeys.length >= 2) preferredIndex = 1; // 獨立用 Key 2

        // 優先使用指定 Key
        if (!this._isOnCooldown(mKeys[preferredIndex])) return mKeys[preferredIndex];

        // 如果專屬 Key 冷卻中，借用其他可用 Key 保命
        for (let key of mKeys) {
            if (!this._isOnCooldown(key)) return key;
        }
        return null;
    }

    _getNextAvailableKey(provider, promptId) {
        if (provider === 'MISTRAL') return this._getMistralKey(promptId);

        // GROQ 同 GEMINI 保持 Round-Robin
        const providerKeys = this.keys[provider] || [];
        if (providerKeys.length === 0) return null;

        let attempts = 0;
        while (attempts < providerKeys.length) {
            const key = providerKeys[this.currentIndex[provider]];
            if (!this._isOnCooldown(key)) {
                this.currentIndex[provider] = (this.currentIndex[provider] + 1) % providerKeys.length;
                return key;
            }
            this.currentIndex[provider] = (this.currentIndex[provider] + 1) % providerKeys.length;
            attempts++;
        }
        return null;
    }

    async _processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            try {
                const apiKey = this._getNextAvailableKey(task.provider, task.promptId);
                
                if (!apiKey) {
                    task.reject(new Error(`ALL_KEYS_ON_COOLDOWN_FOR_${task.provider}`));
                } else {
                    task.apiKeyUsed = apiKey;
                    const result = await task.executeFn(apiKey);
                    task.resolve(result);
                }
            } catch (error) {
                const is429 = error.message?.includes('429') || error.response?.status === 429;
                const isTimeout = error.message?.includes('timeout') || error.code === 'ECONNABORTED';
                
                if (is429 && task.apiKeyUsed) this._markKeyOnCooldown(task.apiKeyUsed);

                if ((is429 || isTimeout || error.response?.status >= 500) && task.apiKeyUsed) {
                    task.retryCount = (task.retryCount || 0) + 1;
                    if (task.retryCount <= 3) {
                        this.queue.unshift(task);
                    } else {
                        task.reject(new Error(`MAX_RETRIES_EXCEEDED: ${error.message}`));
                    }
                } else {
                    task.reject(error);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.isProcessing = false;
    }

    // 🚀 傳入 promptId 讓引擎知道點派 Key
    async enqueueRequest(provider, executeFn, promptId = 'default') {
        return new Promise((resolve, reject) => {
            this.queue.push({
                provider, promptId,
                executeFn: async (key) => { return await executeFn(key); },
                resolve, reject, apiKeyUsed: null, retryCount: 0
            });
            this._processQueue();
        });
    }
}

const keyRotator = new KeyRotator();
module.exports = { keyRotator };