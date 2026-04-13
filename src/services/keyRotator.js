// src/services/keyRotator.js
// 📝 檔案功能用途：AI 金鑰輪替與佇列排程器。
// 🚀 核心升級：實裝「1秒絕對冷卻 (Free Tier Survival)」與排隊機制，完美適配 V10 高頻防爆。

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

    // 🎯 新增：強制常規冷卻 (預設 1 秒)
    _markKeyOnCooldown(key, durationMs = 1000) {
        this.cooldowns.set(key, Date.now() + durationMs);
    }

    // 🛑 懲罰性冷卻 (中咗 429 罰停 5 分鐘)
    _markKeyPenalty(key) {
        const cooldownMinutes = 5;
        this.cooldowns.set(key, Date.now() + (cooldownMinutes * 60 * 1000));
        console.warn(`🔥 [KeyRotator] 金鑰觸發 429 限流！關入小黑屋冷卻 ${cooldownMinutes} 分鐘。`);
    }

    _getKey(provider) {
        const keys = this.keys[provider] || [];
        if (keys.length === 0) return null;

        // 輪詢尋找一條「不在冷卻期」的 Key
        for (let i = 0; i < keys.length; i++) {
            this.currentIndex[provider] = (this.currentIndex[provider] + 1) % keys.length;
            const candidate = keys[this.currentIndex[provider]];
            if (!this._isOnCooldown(candidate)) {
                return candidate;
            }
        }
        return null; // 如果全部 Key 都喺 1 秒冷卻期內，回傳 null 叫 Queue 等候
    }

    async _processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue[0];
            const key = this._getKey(task.provider);

            if (!key) {
                // 🛡️ 所有 Key 都在冷卻中，排隊器休息 200ms 後再試
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            // 成功攞到 Key，將 Task 移出隊列
            this.queue.shift();
            task.apiKeyUsed = key;

            try {
                const result = await task.executeFn(key);
                
                // 🎯 執行成功後，強制這條 Key 進入 1 秒冷卻！
                this._markKeyOnCooldown(key, 1000);
                
                task.resolve(result);
            } catch (error) {
                const is429 = error.message?.includes('429') || error.response?.status === 429;
                const isTimeout = error.message?.includes('timeout') || error.code === 'ECONNABORTED';
                
                if (is429) {
                    this._markKeyPenalty(key); // 中 429 罰 5 分鐘
                } else {
                    this._markKeyOnCooldown(key, 1000); // 一般錯誤也強制冷卻 1 秒
                }

                if (is429 || isTimeout || error.response?.status >= 500) {
                    task.retryCount = (task.retryCount || 0) + 1;
                    if (task.retryCount <= 3) {
                        this.queue.unshift(task); // 塞回隊列最前面重試
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
                executeFn: async (key) => { return await executeFn(key); },
                resolve, reject, apiKeyUsed: null, retryCount: 0
            });
            this._processQueue();
        });
    }

    // 🚀 新增：完美橋樑！將 consensusService 的呼叫轉接入 Queue 系統
    async runWithKey(providerName, taskFn, promptId = 'default') {
        return this.enqueueRequest(providerName, async (apiKey) => {
            // 將 API Key 注入，並將 modelName 設為 null 交由外部處理 fallback
            return await taskFn(apiKey, null, providerName);
        }, promptId);
    }
}

module.exports = { keyRotator: new KeyRotator() };