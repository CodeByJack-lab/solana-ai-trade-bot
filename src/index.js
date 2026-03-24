// src/index.js - V6.0 實盤防彈版
const { supabase } = require('./config/supabase'); 
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService'); 
const { getSolPriceInHKD } = require('./services/priceService'); 

// 🚨 核心模組匯入
const { macroMonitorService } = require('./services/macroMonitorService'); 
const { blueChipJob } = require('./jobs/blueChipJob');                     
const { retrospectiveJob } = require('./jobs/retrospectiveJob');           
const { healthMonitor } = require('./services/healthMonitor');             

// 💀 後勤系統
const { graveyardJob } = require('./jobs/graveyardJob');                   
const { janitorJob } = require('./jobs/janitorJob');                       

async function startApp() {
    console.log("======================================================");
    console.log("🚀 SOL_Trade V6.0 實盤防彈版啟動...");
    console.log("======================================================");

    let isFirstLoad = true; // 🚀 新增：首次載入鎖，防開機洗版

    /**
     * 1. 🚀 指令線：監聽 system_config (熱更新開關與資金同步)
     */
    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            (payload) => {
                const newData = payload.new;
                const portfolio = getPortfolio();

                // 💡 資金同步邏輯
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

                // 🛡️ 終極防洗版鎖：只有當開關或模式【真的發生改變】時，才處理並印出 Log
                if (global.isRunning === newData.is_running && global.tradeMode === newData.trade_mode) {
                    return; // 狀態沒變，純粹係 60 秒餘額同步，直接忽略！
                }

                global.isRunning = newData.is_running;
                global.tradeMode = newData.trade_mode;

                if (!isFirstLoad) {
                    console.log(`\n🔔 [遠端指令] 狀態: ${newData.is_running ? '🟢 運行中' : '🔴 已暫停'} | 模式: ${newData.trade_mode}`);
                    updateSystemStatus(newData.is_running ? "🟢 系統指令：開始作戰" : "🛑 系統指令：暫停交易");
                }
                isFirstLoad = false;
            }
        )
        .subscribe();

    // 2. 🏰 初始化資產數據與資金鎖
    const portfolio = await initPortfolio();
    if (!portfolio) {
        console.error("❌ 系統初始化失敗，程序退出。");
        process.exit(1);
    }

    // ==========================================
    // 3. 🚀 啟動全軍列陣 (V6.0 核心模組)
    // ==========================================
    startMarketMonitor();        
    macroMonitorService.start(); 
    blueChipJob.start();         
    retrospectiveJob.start();    
    janitorJob.start();          
    
    if (graveyardJob && typeof graveyardJob.start === 'function') {
        graveyardJob.start();    
    }

    /**
     * 4. 💤 回報線：一體化「單行戰報」Loop
     */
    async function backgroundReportLoop() {
        try {
            if (global.isRunning === false) {
                console.log("💤 系統暫停中...");
                setTimeout(backgroundReportLoop, 60000);
                return;
            }

            await syncLiveBalanceToDB();
            const currentCache = getPortfolio();
            const solHkdPrice = await getSolPriceInHKD();
            
            const investedSol = currentCache.positions.reduce((sum, pos) => {
                return sum + ((pos.quantity || 0) * (pos.entry_price_sol || 0));
            }, 0);
            
            const totalCapitalSol = currentCache.cash_sol + investedSol;
            const totalCapitalHkd = totalCapitalSol * solHkdPrice;
            
            console.log(`\n========================================`);
            console.log(`📊 [實時戰報] 總資產: $${totalCapitalHkd.toFixed(2)} HKD | 現金: ${currentCache.cash_sol.toFixed(4)} SOL`);
            console.log(`持倉數: ${currentCache.positions.length} 隻`);
            console.log(`--- 🩺 系統健康看板 ---`);
            console.log(healthMonitor.getHealthReport()); 
            console.log(`========================================`);
            
            await updateSystemStatus(`🦅 監控中 | 總資產: $${totalCapitalHkd.toFixed(2)} HKD`);
            
        } catch (loopErr) {
            console.error("⚠️ 戰報 Loop 發生錯誤:", loopErr.message);
        }

        setTimeout(backgroundReportLoop, 60000); 
    }

    backgroundReportLoop();
}

startApp().catch(err => {
    console.error("❌ 系統啟動發生致命錯誤:", err.message);
});