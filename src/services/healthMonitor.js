// src/services/healthMonitor.js

class HealthMonitor {
    constructor() {
        this.statuses = new Map();
        this.aiLatencies = []; 
        this.apiUsage = { requests: 0, errors429: 0 };
        this.oracleQueueSize = 0;
        
        // 🚀 V8.9 全面升級清單，確保「真・Top 200」架構無盲區
        this.initStatuses();
    }

    initStatuses() {
        const components = [
            'Live_Engine',      // 實盤引擎
            'Supabase_DB',      // 數據庫連線
            'Portfolio_Cache',  // 記憶體對齊
            'Trade_Engine',     // 交易執行器
            'Meme_Radar',       // 🎣 Helius 撈魚 (野生 Meme)
            'Top200_Crawler',   // 🦎 Gecko 兩小時大換血 (新增)
            'Math_Radar',       // 📡 15分鐘數學雷達 (新增)
            'Security_Guard',   // 🛡️ 物理與合約安檢 (新增)
            'Macro_Radar',      // 🌊 宏觀避險
            'AI_Evolution',     // 🧠 自我進化
            'Telegram_Webhook', // 💬 HITL 審批中樞 (新增)
            'Janitor_Service',  // 🧹 自動回收
            'Wallet_Radar'      // 🏦 Alchemy 錢包監控
        ];
        // 預設全部顯示「待命中」，等各個 Service 起機後自己覆蓋狀態
        components.forEach(c => this.statuses.set(c, '🟡 待命中'));
    }

    setStatus(component, status) {
        this.statuses.set(component, status);
    }

    recordAiLatency(latencyMs) {
        this.aiLatencies.push(latencyMs);
        if (this.aiLatencies.length > 50) this.aiLatencies.shift();
    }

    recordApiRequest() {
        this.apiUsage.requests++;
    }

    async report429Error(provider, keyIndex) {
        this.apiUsage.errors429++;
        const msg = `🚨 <b>[API 限流警告]</b>\n🤖 供應商: ${provider}\n🔑 Key 索引: 第 ${keyIndex + 1} 把 Key\n⚠️ 狀態: 觸發 429 Too Many Requests，系統已自動切換備用 Key！`;
        
        console.log(`\n======================================================`);
        console.log(`🔥 [警告] 觸發 429 限流！(${provider} - Key ${keyIndex + 1})`);
        console.log(`======================================================\n`);
        
        try {
            const { sendAdminAlert } = require('./telegramService');
            await sendAdminAlert(msg);
        } catch (e) {
            console.error("❌ 無法發送 429 Telegram 警告:", e.message);
        }
    }

    setOracleQueueSize(size) {
        this.oracleQueueSize = size;
    }

    getHealthReport() {
        let report = '';
        
        // 將狀態排序，確保報告排版整齊
        const sortedKeys = Array.from(this.statuses.keys()).sort();

        for (const component of sortedKeys) {
            const status = this.statuses.get(component);
            report += `  🔹 ${component.padEnd(20, ' ')}: ${status}\n`;
        }

        const avgLatency = this.aiLatencies.length > 0 
            ? (this.aiLatencies.reduce((a, b) => a + b, 0) / this.aiLatencies.length / 1000).toFixed(2) 
            : '0.00';

        report += `  ----------------------------------------------------\n`;
        report += `  📈 [效能指標] AI 總請求: ${this.apiUsage.requests.toString().padEnd(6, ' ')} | 平均延遲: ${avgLatency}s\n`;
        report += `  ⏳ [資源狀態] Oracle排隊: ${this.oracleQueueSize.toString().padEnd(5, ' ')} | 429 阻截: ${this.apiUsage.errors429} 次`;
        
        return report;
    }
}

const healthMonitor = new HealthMonitor();
module.exports = { healthMonitor };