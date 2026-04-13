// src/services/healthMonitor.js
// 📝 檔案功能用途：V10.22 系統維運中樞 (The Overseer)
// 🚀 核心功能：實時心跳同步、AI 延遲監控、API 流量統計、Koyeb 哨兵邏輯。

const { supabase } = require('../config/supabase');

class HealthMonitor {
    constructor() {
        this.statuses = new Map();
        this.aiLatencies = []; // 存儲最近 50 次 AI 請求的延遲時間 (ms)
        this.apiUsage = { requests: 0, errors429: 0 };
        this.oracleQueueSize = 0;
        this.lastSync = 0;
        this.SYNC_INTERVAL = 15000; // 每 15 秒同步一次到 Supabase 防止高頻 I/O
    }

    /**
     * 🟢 更新本機服務狀態並同步至 Supabase
     * @param {string} serviceName 服務名稱 (如 'Hunter_Frontline')
     * @param {string} status 狀態描述 (🟢 正常 / 🟡 待命 / 🔴 報錯)
     * @param {string} message 具體訊息
     */
    async setStatus(serviceName, status, message = '') {
        const cleanStatus = status.includes('🟢') ? 'ONLINE' : (status.includes('🔴') ? 'ERROR' : 'STANDBY');
        
        this.statuses.set(serviceName, { 
            status: cleanStatus, 
            message, 
            lastUpdate: Date.now() 
        });

        // 定時同步到 Supabase 的 service_health 表格
        if (Date.now() - this.lastSync > this.SYNC_INTERVAL) {
            this._syncToSupabase(serviceName, cleanStatus, message);
        }
    }

    /**
     * 📡 記錄外部服務心跳 (專為 Koyeb PriceBot 設計)
     * @param {string} externalName 服務名稱
     */
    recordHeartbeat(externalName) {
        this.statuses.set(externalName, {
            status: 'ONLINE',
            lastUpdate: Date.now(),
            message: '接收到外部心跳訊號'
        });
    }

    /**
     * 🧠 記錄 AI 推論延遲
     * @param {number} ms 毫秒數
     */
    recordAiLatency(ms) {
        this.aiLatencies.push(ms);
        if (this.aiLatencies.length > 50) this.aiLatencies.shift(); // 保持最近 50 筆
    }

    /**
     * 📊 獲取平均 AI 延遲
     */
    getAverageLatency() {
        if (this.aiLatencies.length === 0) return 0;
        const sum = this.aiLatencies.reduce((a, b) => a + b, 0);
        return (sum / this.aiLatencies.length).toFixed(0);
    }

    /**
     * ⚠️ 記錄 API 錯誤 (用於斷路器監控)
     * @param {boolean} isRateLimit 是否為 429 錯誤
     */
    recordApiRequest(isRateLimit = false) {
        this.apiUsage.requests++;
        if (isRateLimit) this.apiUsage.errors429++;
    }

    /**
     * 🔄 內部函數：寫入 Supabase
     */
    async _syncToSupabase(serviceName, status, message) {
        try {
            const { error } = await supabase
                .from('service_health')
                .upsert({ 
                    service_name: serviceName, 
                    status: status,
                    last_heartbeat: new Date().toISOString(),
                    error_msg: message,
                    // 附帶效能指標到 message
                    performance_data: {
                        avg_latency: this.getAverageLatency(),
                        api_errors: this.apiUsage.errors429
                    }
                }, { onConflict: 'service_name' });
            
            if (!error) this.lastSync = Date.now();
        } catch (e) {
            console.error(`❌ [HealthMonitor] 同步 ${serviceName} 失敗:`, e.message);
        }
    }

    getStatus(serviceName) {
        return this.statuses.get(serviceName);
    }

    /**
     * 🧹 獲取所有當前狀態快照 (供 API 直接呼叫)
     */
    getAllStatuses() {
        const result = [];
        this.statuses.forEach((val, key) => {
            result.push({ name: key, ...val });
        });
        return result;
    }
}

const healthMonitor = new HealthMonitor();
module.exports = { healthMonitor };