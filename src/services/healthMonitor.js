// src/services/healthMonitor.js
const healthStatus = new Map();

const healthMonitor = {
    /**
     * 更新某個 Service 的狀態
     * @param {string} serviceName - 服務名稱 (如 'AI_Scout', 'Meme_Radar')
     * @param {string} status - 狀態標籤 (如 '🟢 OK', '🔴 Timeout')
     */
    setStatus(serviceName, status) {
        healthStatus.set(serviceName, {
            status: status,
            timestamp: new Date().toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong' })
        });
    },

    /**
     * 獲取並格式化所有服務的狀態，供戰報打印
     */
    getHealthReport() {
        if (healthStatus.size === 0) return "  ⏳ 系統初始化中，等待各服務回報...";
        
        let report = "";
        for (const [service, data] of healthStatus.entries()) {
            let icon = '🟡';
            if (data.status.includes('🟢')) icon = '🟢';
            if (data.status.includes('🔴')) icon = '🔴';
            
            report += `  ${icon} [${service}] ${data.status} (最後更新: ${data.timestamp})\n`;
        }
        return report.trimEnd();
    }
};

// 初始化預設狀態
healthMonitor.setStatus('Supabase_DB', '🟡 系統啟動中...');
healthMonitor.setStatus('Meme_Radar', '🟡 等待啟動...');
healthMonitor.setStatus('Bluechip_Radar', '🟡 等待啟動...');
healthMonitor.setStatus('AI_Consensus', '🟡 等待啟動...');

module.exports = { healthMonitor };