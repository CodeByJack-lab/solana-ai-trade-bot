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

// 🚀 獨立抽出的狀態更新引擎 (解決切換 Mode 延遲問題)
async function forceUpdateStatusAndPrint(newData = null, isFromLoop = false) {
    try {
        const currentCache = getPortfolio();
        const solHkdPrice = await getSolPriceInHKD();
        
        let config = newData;
        if (!config) {
            const { data } = await supabase.from('system_config').select('*').eq('id', 1).single();
            config = data;
        }
        if (!config) return;

        const isPaper = config.trade_mode === 'PAPER';
        const modeText = isPaper ? '📝 模擬盤' : '🔥 實盤';
        const statusIcon = config.is_running ? '🟢 監控中' : '🛑 已暫停';
        
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
        
        // 🚀 一步到位：同時覆蓋 Icon、模式與資產
        await updateSystemStatus(`${statusIcon} | ${modeText} | 總資產: $${totalCapitalHkd.toFixed(2)} HKD`);
    } catch (e) {
        console.error("⚠️ 狀態更新失敗:", e.message);
    }
}

async function startApp() {
    console.log("======================================================");
    console.log("🚀 SOL_Trade V6.0 實盤防彈版啟動...");
    console.log("======================================================");

    let isFirstLoad = true; 

    /**
     * 1. 🚀 指令線：監聽 system_config
     */
    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            (payload) => {
                const newData = payload.new;
                const portfolio = getPortfolio();

                if (portfolio) {
                    // 🚀 致命 Bug 修正：即時將 Bot 底層記憶體切換為實盤/模擬盤！
                    portfolio.mode = newData.trade_mode; 
                    
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

                if (global.isRunning === newData.is_running && global.tradeMode === newData.trade_mode) {
                    return; 
                }

                global.isRunning = newData.is_running;
                global.tradeMode = newData.trade_mode;

                if (!isFirstLoad) {
                    console.log(`\n🔔 [遠端指令] 狀態: ${newData.is_running ? '🟢 運行中' : '🔴 已暫停'} | 模式: ${newData.trade_mode}`);
                    // 🚀 呼叫獨立引擎，一撳掣 0 秒即刻轉字眼！
                    forceUpdateStatusAndPrint(newData, false); 
                }
                isFirstLoad = false;
            }
        )
        .subscribe();

    const portfolio = await initPortfolio();
    if (!portfolio) {
        process.exit(1);
    }

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
        if (global.isRunning === false) {
            console.log("💤 系統暫停中...");
        } else {
            await syncLiveBalanceToDB();
            // 🚀 直接呼叫共用函數
            await forceUpdateStatusAndPrint(null, true);
        }
        setTimeout(backgroundReportLoop, 60000); 
    }

    backgroundReportLoop();
}

startApp().catch(err => {
    console.error("❌ 系統啟動發生致命錯誤:", err.message);
});