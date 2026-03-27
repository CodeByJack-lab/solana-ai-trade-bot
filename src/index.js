// src/services/healthMonitor.js
const { sendAdminAlert } = require('./telegramService');

class HealthMonitor {
    constructor() {
        this.statuses = new Map();
        this.aiLatencies = []; // 儲存最近 50 次 AI 延遲
        this.apiUsage = { requests: 0, errors429: 0 };
        this.oracleQueueSize = 0;
    }

    // 1. 基本組件狀態
    setStatus(component, status) {
        this.statuses.set(component, status);
    }

    // 2. 紀錄 AI 延遲 (毫秒)
    recordAiLatency(latencyMs) {
        this.aiLatencies.push(latencyMs);
        if (this.aiLatencies.length > 50) this.aiLatencies.shift(); // 防 RAM 爆
    }

    // 3. 紀錄 API 請求次數
    recordApiRequest() {
        this.apiUsage.requests++;
    }

    // 4. 🚨 觸發 429 警告並發送 Telegram
    async report429Error(provider, keyIndex) {
        this.apiUsage.errors429++;
        const msg = `🚨 <b>[API 限流警告]</b>\n🤖 供應商: ${provider}\n🔑 Key 索引: 第 ${keyIndex + 1} 把 Key\n⚠️ 狀態: 觸發 429 Too Many Requests，系統已自動切換備用 Key！`;
        
        console.log(`\n======================================================`);
        console.log(`🔥 [警告] 觸發 429 限流！(${provider} - Key ${keyIndex + 1})`);
        console.log(`======================================================\n`);
        
        try {
            await sendAdminAlert(msg);
        } catch (e) {
            console.error("❌ 無法發送 429 Telegram 警告:", e.message);
        }
    }

    // 5. 更新 Oracle 排隊人數
    setOracleQueueSize(size) {
        this.oracleQueueSize = size;
    }

    // 6. 產出完美排版的 Dashboard
    getHealthReport() {
        let report = '';
        
        // 上半部：各組件狀態
        for (const [component, status] of this.statuses.entries()) {
            // 用 padEnd 令到冒號對齊，強迫症福音
            report += `  🔹 ${component.padEnd(20, ' ')}: ${status}\n`;
        }

        // 計算平均延遲 (秒)
        const avgLatency = this.aiLatencies.length > 0 
            ? (this.aiLatencies.reduce((a, b) => a + b, 0) / this.aiLatencies.length / 1000).toFixed(2) 
            : '0.00';

        // 下半部：高級效能指標
        report += `  ----------------------------------------------------\n`;
        report += `  📈 [效能指標] AI 總請求: ${this.apiUsage.requests.toString().padEnd(6, ' ')} | 平均延遲: ${avgLatency}s\n`;
        report += `  ⏳ [資源狀態] Oracle排隊: ${this.oracleQueueSize.toString().padEnd(5, ' ')} | 429 阻截: ${this.apiUsage.errors429} 次`;
        
        return report;
    }
}

const healthMonitor = new HealthMonitor();
module.exports = { healthMonitor };