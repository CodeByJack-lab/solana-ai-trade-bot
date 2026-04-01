// /config/keyRotator.js
// 📝 檔案功能用途：V9.1 統一 AI 資源池與請求排隊機。負責 6 把 Key 的 Round-Robin 輪替，嚴格落實 429 錯誤的 5 分鐘冷卻，以及每次請求間隔 1 秒的併發限制。

const config = require('../config/config');

class KeyRotator {
    constructor() {
        this.keys = config.aiKeys;
        
        if (this.keys.length === 0) {
            console.warn("⚠️ [KeyRotator] 系統未偵測到任何 AI API 金鑰！將強制進入純量化降級模式。");
        } else {
            console.log(`🧠 [KeyRotator] 成功載入 ${this.keys.length} 把 AI 金鑰進入統一資源池。`);
        }

        this.currentIndex = 0;
        this.cooldowns = new Map(); // 記錄進入冷卻的 Key 與解凍時間戳
        this.queue = [];            // 請求排隊列
        this.isProcessing = false;  // 是否正在處理隊列
    }

    /**
     * 🛡️ 獲取下一把可用且未在冷卻中的 Key
     * @returns {string|null} 可用的 API Key；若全部陣亡則回傳 null
     */
    _getNextAvailableKey() {
        if (this.keys.length === 0) return null;

        const now = Date.now();
        let attempts = 0;

        while (attempts < this.keys.length) {
            const key = this.keys[this.currentIndex];
            const cooldownUntil = this.cooldowns.get(key) || 0;

            // 如果該 Key 已經過咗冷卻期 (或者根本無被冷卻)
            if (now >= cooldownUntil) {
                // 取用後，指標向前推動 (Round-Robin)
                this.currentIndex = (this.currentIndex + 1) % this.keys.length;
                return key;
            }

            // 若此 Key 在冷卻中，檢查下一把
            this.currentIndex = (this.currentIndex + 1) % this.keys.length;
            attempts++;
        }

        // 所有 Key 都在冷卻中
        return null;
    }

    /**
     * 🧊 將觸發 429 的 Key 放入 5 分鐘冷卻池
     */
    _markKeyOnCooldown(key) {
        const cooldownMinutes = 5;
        const cooldownUntil = Date.now() + (cooldownMinutes * 60 * 1000);
        this.cooldowns.set(key, cooldownUntil);
        console.warn(`🔥 [KeyRotator] 金鑰觸發 429 Rate Limit！已將其關入小黑屋，冷卻 ${cooldownMinutes} 分鐘。`);
    }

    /**
     * ⚙️ 內部隊列處理器：保證每次請求之間「絕對相隔 1 秒」
     */
    async _processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            
            try {
                // 取用金鑰
                const apiKey = this._getNextAvailableKey();
                
                if (!apiKey) {
                    // 全部金鑰癱瘓，直接拋出特定錯誤，讓外層觸發「純量化算分」降級
                    task.reject(new Error('ALL_KEYS_ON_COOLDOWN'));
                } else {
                    // 執行真正嘅 AI 請求 (將 apiKey 傳遞畀回呼函數)
                    const result = await task.executeFn(apiKey);
                    task.resolve(result);
                }
            } catch (error) {
                // 如果任務自己報錯 (例如網絡錯誤、被伺服器 ban)
                const is429 = error.message?.includes('429') || error.response?.status === 429;
                
                if (is429 && task.apiKeyUsed) {
                    this._markKeyOnCooldown(task.apiKeyUsed);
                    // 重新推回隊列前面，畀下一次用新 Key 重試
                    this.queue.unshift(task);
                } else {
                    // 非 429 錯誤，直接宣告失敗
                    task.reject(error);
                }
            }

            // ⏳ V9.1 鐵律：每次 AI 呼叫完畢後，強制等待 1000 毫秒
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        this.isProcessing = false;
    }

    /**
     * 🚀 外部接口：將 AI 請求推入排隊引擎
     * @param {Function} executeFn 實際執行 Axios/Gemini SDK 請求的匿名函數，接收 apiKey 為參數
     */
    async enqueueRequest(executeFn) {
        return new Promise((resolve, reject) => {
            // 包裝任務
            const task = {
                executeFn: async (key) => {
                    task.apiKeyUsed = key; // 記錄用咗邊把 Key，方便 429 溯源
                    return await executeFn(key);
                },
                resolve,
                reject,
                apiKeyUsed: null
            };

            this.queue.push(task);
            
            // 觸發隊列消化
            this._processQueue();
        });
    }
}

// 實例化單例匯出
const keyRotator = new KeyRotator();
module.exports = { keyRotator };