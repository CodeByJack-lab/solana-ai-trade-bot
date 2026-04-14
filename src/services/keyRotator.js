// src/services/keyRotator.js
// 📝 檔案功能用途：AI 金鑰輪替與佇列排程器。
// 🚀 核心升級：向外導出 retryCount，賦予外部微服務「自動降級 (Model Fallback)」的能力。

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

    _markKeyOnCooldown(key, durationMs = 1000) {
        this.cooldowns.set(key, Date.now() + durationMs);
    }

    _markKeyPenalty(key) {
        const cooldownMinutes = 5;
        this.cooldowns.set(key, Date.now() + (cooldownMinutes * 60 * 1000));
        console.warn(`🔥 [KeyRotator] 金鑰觸發 429 限流！關入小黑屋冷卻 ${cooldownMinutes} 分鐘。`);
    }

    _getKey(provider) {
        const keys = this.keys[provider] || [];
        if (keys.length === 0) return null;

        for (let i = 0; i < keys.length; i++) {
            this.currentIndex[provider] = (this.currentIndex[provider] + 1) % keys.length;
            const candidate = keys[this.currentIndex[provider]];
            if (!this._isOnCooldown(candidate)) {
                return candidate;
            }
        }
        return null; 
    }

    async _processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue[0];
            const key = this._getKey(task.provider);

            if (!key) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            this.queue.shift();
            task.apiKeyUsed = key;

            try {
                // 🎯 核心修改：將 retryCount 傳遞給具體的執行任務
                const result = await task.executeFn(key, task.retryCount);
                
                this._markKeyOnCooldown(key, 1000);
                task.resolve(result);
            } catch (error) {
                const is429 = error.message?.includes('429') || error.response?.status === 429;
                const isTimeout = error.message?.includes('timeout') || error.code === 'ECONNABORTED';
                
                if (is429) {
                    this._markKeyPenalty(key); 
                } else {
                    this._markKeyOnCooldown(key, 1000); 
                }

                if (is429 || isTimeout || error.response?.status >= 500) {
                    task.retryCount = (task.retryCount || 0) + 1;
                    if (task.retryCount <= 3) {
                        console.warn(`🔄 [KeyRotator] 任務失敗，準備進行第 ${task.retryCount} 次重試...`);
                        this.queue.unshift(task); 
                    } else {
                        task.reject(new Error(`MAX_RETRIES_EXCEEDED: ${error.message}`));
                    }
                } else {
                    task.reject(error);
                }
            }
        }
        this.isProcessing = false;
    }

    async enqueueRequest(provider, executeFn, promptId = 'default') {
        return new Promise((resolve, reject) => {
            this.queue.push({
                provider, promptId,
                // 🎯 核心修改：接收並傳遞 currentRetry
                executeFn: async (key, currentRetry) => { return await executeFn(key, currentRetry); },
                resolve, reject, apiKeyUsed: null, retryCount: 0
            });
            this._processQueue();
        });
    }

    async runWithKey(providerName, taskFn, promptId = 'default') {
        // 🎯 核心修改：橋樑接收 retryCount 並交給 consensusService
        return this.enqueueRequest(providerName, async (apiKey, retryCount) => {
            return await taskFn(apiKey, retryCount, providerName);
        }, promptId);
    }
}

module.exports = { keyRotator: new KeyRotator() };