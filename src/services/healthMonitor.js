// src/services/healthMonitor.js
const { sendAdminAlert } = require('./telegramService');

class HealthMonitor {
    constructor() {
        this.statuses = new Map();
        this.aiLatencies = []; // 儲存最近 50 次 AI 延遲
        this.apiUsage = { requests: 0, errors429: 0 };
        this.oracleQueueSize = 0;
    }

    // 1. 基本組件狀態 (🟢 運作中 / 🔴 異常)
    setStatus(component, status) {
        this.statuses.set(component, status);
    }

    // 2. 紀錄 AI 延遲 (毫秒)
    recordAiLatency(latencyMs) {
        this.aiLatencies.push(latencyMs);
        if (this.aiLatencies.length > 50) this.aiLatencies.shift(); // 只保留最近 50 次，防 RAM 爆
    }

    // 3. 紀錄 API 請求次數
    recordApiRequest() {
        this.apiUsage.requests++;
    }

    // 4. 🚨 觸發 429 警告並發送 Telegram
    async report429Error(provider, keyIndex) {
        this.apiUsage.errors429++;
        const msg = `🚨 <b>[API 限流警告]</b>\n🤖 供應商: ${provider}\n🔑 Key 索引: 第 ${keyIndex + 1} 把 Key\n⚠️ 狀態: 觸發 429 Too Many Requests，系統已自動切換備用 Key！`;
        
        console.log(`\n${msg.replace(/<[^>]*>?/gm, '')}`); // Terminal 顯示 (去除 HTML tag)
        
        try {
            await sendAdminAlert(msg); // 射去 Admin Telegram
        } catch (e) {
            console.error("❌ 無法發送 429 Telegram 警告:", e.message);
        }
    }

    // 5. 更新 Oracle 排隊人數
    setOracleQueueSize(size) {
        this.oracleQueueSize = size;
    }

    // 6. 產出你想要嘅完美 Dashboard
    getHealthReport() {
        let report = '';
        for (const [component, status] of this.statuses.entries()) {
            report += `[${component}]: ${status}\n`;
        }

        // 計算平均延遲 (秒)
        const avgLatency = this.aiLatencies.length > 0 
            ? (this.aiLatencies.reduce((a, b) => a + b, 0) / this.aiLatencies.length / 1000).toFixed(1) 
            : '0.0';

        // 📊 組合高級 Metrics
        report += `\n📊 系統效能: AI_Requests: ${this.apiUsage.requests} | Oracle_Queue_Size: ${this.oracleQueueSize} | Avg_AI_Latency: ${avgLatency}s | 429_Errors: ${this.apiUsage.errors429}`;
        
        return report.trim();
    }
}

const healthMonitor = new HealthMonitor();
module.exports = { healthMonitor };