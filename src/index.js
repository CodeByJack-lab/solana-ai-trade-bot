// src/index.js
// 📝 檔案功能用途：V9.1.9 系統啟動核心 (Bootloader)。喚醒多路聚合器、啟動各類防禦排程、實時監聽 DB，並啟動 Webhook 伺服器接收出入金通知。

const express = require('express'); // 👈 新增 Express 模組
const config = require('./config/config');
const { supabase } = require('./config/supabase');
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService');
const { getSolPriceInHKD } = require('./services/priceService');
const { sourceAggregator } = require('./services/sourceAggregator');
const { healthMonitor } = require('./services/healthMonitor');
const { environmentService } = require('./services/environmentService');
const { walletMonitorRouter } = require('./services/walletMonitor'); // 👈 引入 Wallet Monitor 路由器

// 背景排程 (Jobs)
const { weeklyBacktestJob } = require('./jobs/weeklyBacktestJob');
const { retrospectiveJob } = require('./jobs/retrospectiveJob');
const { graveyardJob } = require('./jobs/graveyardJob');
const { janitorJob } = require('./jobs/janitorJob');
const { trendingMonitorService } = require('./services/trendingMonitorService');
const { trendingJob } = require('./jobs/trendingJob');
const { promptManager } = require('./services/promptManager');
const { autoApplyJob } = require('./jobs/autoApplyJob');

async function forceUpdateStatusAndPrint(newData = null, isFromLoop = false) {
    try {
        const currentCache = getPortfolio();
        if (!currentCache) return;
        
        const solHkdPrice = await getSolPriceInHKD();
        
        let sysConfig = newData;
        if (!sysConfig) {
            const { data } = await supabase.from('system_config').select('*').eq('id', 1).single();
            sysConfig = data;
        }
        if (!sysConfig) return;

        const isPaper = sysConfig.trade_mode === 'PAPER';
        const modeText = isPaper ? '📝 模擬盤' : '🔥 實盤';
        const statusIcon = sysConfig.is_running ? '🟢 監控中' : '🛑 已暫停';
        
        const investedSol = currentCache.positions.reduce((sum, pos) => sum + ((pos.quantity || 0) * (pos.entry_price_sol || 0)), 0);
        const totalCapitalSol = currentCache.cash_sol + investedSol;
        const totalCapitalHkd = totalCapitalSol * solHkdPrice;
        
        if (isFromLoop) {
            console.log(`\n========================================`);
            console.log(`📊 [實時戰報] ${modeText} | 總資產: $${totalCapitalHkd.toFixed(2)} HKD | 現金: ${currentCache.cash_sol.toFixed(4)} SOL`);
            console.log(`持倉數: ${currentCache.positions.length} 隻`);
            console.log(`--- 🩺 系統健康看板 ---`);
            console.log(healthMonitor.getHealthReport()); 
            console.log(`========================================`);
        }
        
        await updateSystemStatus(`${statusIcon} | ${modeText} | 總資產: $${totalCapitalHkd.toFixed(2)} HKD`);
    } catch (e) {
        console.error("⚠️ 狀態更新失敗:", e.message);
    }
}

async function startApp() {
    console.log("======================================================");
    console.log("🚀 SOL_QUANT V9.1.9 (多路冗餘 + AI 降級限流版) 啟動...");
    console.log("======================================================");

    // 1. 初始化 AI 劇本快取
    await promptManager.init();

    // 2. 啟動 Webhook、Express 伺服器與 0 延遲監控
    startMarketMonitor(); 
    
    // 🌐 [新增] 啟動 Express 伺服器，專門接收 Alchemy Webhook
    const app = express();
    app.use(express.json());
    app.use('/', walletMonitorRouter); // 掛載錢包監聽器
    
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 [Webhook Server] 已啟動於 Port ${PORT}，準備接收出入金通知`);
    });

    let isFirstLoad = true; 

    // 3. 監聽全域配置變更
    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            async (payload) => {
                const newData = payload.new;
                
                // 處理交易模式切換
                if (global.tradeMode !== newData.trade_mode) {
                    console.log(`\n🔄 [系統指令] 偵測到交易模式切換 (${global.tradeMode} ➡️ ${newData.trade_mode})`);
                    console.log(`🧹 正在清洗大腦記憶體，重新載入 ${newData.trade_mode} 專屬數據庫...`);
                    await initPortfolio(); 
                }

                // 更新本地 RAM 餘額
                const portfolio = getPortfolio();
                if (portfolio) {
                    if (newData.trade_mode === 'PAPER') {
                        if (Math.abs(portfolio.cash_sol - newData.simulated_balance) > 0.0001) {
                            portfolio.cash_sol = newData.simulated_balance;
                            portfolio.reference_capital = newData.reference_capital;
                        }
                    } else if (newData.trade_mode === 'LIVE') {
                        if (Math.abs(portfolio.cash_sol - newData.live_wallet_balance) > 0.0001) {
                            portfolio.cash_sol = newData.live_wallet_balance;
                            portfolio.reference_capital = newData.live_wallet_balance;
                        }
                    }
                }

                if (global.isRunning === newData.is_running && global.tradeMode === newData.trade_mode) return;

                global.isRunning = newData.is_running;
                global.tradeMode = newData.trade_mode;

                if (!isFirstLoad) {
                    console.log(`\n🔔 [遠端指令] 狀態: ${newData.is_running ? '🟢 運行中' : '🔴 已暫停'} | 模式: ${newData.trade_mode}`);
                    await forceUpdateStatusAndPrint(newData, false); 
                }
                isFirstLoad = false;
            }
        )
        .subscribe();

    // 4. 載入倉位記憶體
    const portfolio = await initPortfolio();
    if (!portfolio) {
        console.error("❌ [Boot] 倉位記憶體載入失敗，系統終止。");
        process.exit(1);
    }
    
    global.isRunning = true;
    global.tradeMode = portfolio.mode;

    console.log("⚙️ [Boot] 正在錯峰喚醒多路聚合器與背景排程...");
    
    // 5. 錯峰啟動各類服務，避免瞬間佔滿 CPU 與連線數
    setTimeout(() => { sourceAggregator.start(); }, 5000);              
    setTimeout(() => { trendingMonitorService.start(); }, 16000);       
    setTimeout(() => { trendingJob.start(); }, 18000);                  
    setTimeout(() => { janitorJob.start(); }, 20000);                   
    setTimeout(() => { graveyardJob.start(); }, 22000);                 
    setTimeout(() => { retrospectiveJob.start(); }, 24000);             
    setTimeout(() => { autoApplyJob.start(); }, 25000);                 
    setTimeout(() => { weeklyBacktestJob.start(); }, 26000);            
    setTimeout(() => { environmentService.start(); }, 12000);

    // 6. 背景定時回報循環
    async function backgroundReportLoop() {
        if (global.isRunning === false) {
            console.log("💤 系統暫停中...");
        } else {
            await syncLiveBalanceToDB();
            await forceUpdateStatusAndPrint(null, true);
        }
        setTimeout(backgroundReportLoop, 30 * 60 * 1000); 
    }

    backgroundReportLoop();
}

startApp().catch(err => {
    console.error("❌ 系統啟動發生致命錯誤:", err.message);
});