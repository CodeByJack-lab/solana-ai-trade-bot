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

// ==========================================
// 🛡️ 系統啟動大閱兵 (初始化所有部門預設狀態)
// ==========================================
healthMonitor.setStatus('Supabase_DB', '🟡 系統啟動中...');
healthMonitor.setStatus('Portfolio_Cache', '🟡 讀取資金中...');
healthMonitor.setStatus('Meme_Radar', '🟡 等待 Helius 水閘...');
healthMonitor.setStatus('Bluechip_Radar', '🟡 等待啟動...');
healthMonitor.setStatus('Macro_Radar', '🟡 雙源探測大盤中...');
healthMonitor.setStatus('AI_Consensus', '🟡 三白劍俠就位中...');
healthMonitor.setStatus('AI_Overseer', '🟡 AI Reviewer 就位中...');
healthMonitor.setStatus('AI_Reentry', '🟡 接回分析就位中...');
healthMonitor.setStatus('Security_Guard', '🟡 防線建立中...'); // 🚀 新增保安
healthMonitor.setStatus('Trade_Engine', '🟡 交易引擎預熱中...');
healthMonitor.setStatus('Live_Engine', '🟡 檢查錢包狀態...');  // 🚀 新增實盤引擎
healthMonitor.setStatus('AI_Evolution', '🟡 待命中 (12AM/PM 執行)...');

module.exports = { healthMonitor };