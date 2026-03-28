// src/index.js - V8.2 Protocol-level Diagnosis
const configEnv = require('./config/env'); 
const { supabase } = require('./config/supabase'); 
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService'); 
const { getSolPriceInHKD } = require('./services/priceService'); 

const { macroMonitorService } = require('./services/macroMonitorService'); 
const { retrospectiveJob } = require('./jobs/retrospectiveJob');           
const { healthMonitor } = require('./services/healthMonitor');             

const { graveyardJob } = require('./jobs/graveyardJob');                   
const { janitorJob } = require('./jobs/janitorJob');   

const { trendingMonitorService } = require('./services/trendingMonitorService');
const { trendingJob } = require('./jobs/trendingJob');

// 👇 [V8.2] 引入 Macro Job 與 RAM Prompt Manager
const { macroJob } = require('./jobs/macroJob');
const { promptManager } = require('./services/promptManager');

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
        
        await updateSystemStatus(`${statusIcon} | ${modeText} | 總資產: $${totalCapitalHkd.toFixed(2)} HKD`);
    } catch (e) {
        console.error("⚠️ 狀態更新失敗:", e.message);
    }
}

async function startApp() {
    console.log("======================================================");
    console.log("🚀 SOL_Trade V8.2 雙核防彈版啟動...");
    console.log("======================================================");

    // 🚀 [V8.2] 第一時間載入 AI RAM 劇本
    await promptManager.init();

    // 🚀 [核心修復] 第一時間 Bind Port，滿足 Railway Healthcheck
    startMarketMonitor(); 

    let isFirstLoad = true; 

    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            async (payload) => {
                const newData = payload.new;
                
                if (global.tradeMode !== newData.trade_mode) {
                    console.log(`\n🔄 [系統指令] 偵測到交易模式切換 (${global.tradeMode} ➡️ ${newData.trade_mode})`);
                    console.log(`🧹 正在清洗大腦記憶體，重新載入 ${newData.trade_mode} 專屬數據庫...`);
                    await initPortfolio(); 
                }

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

    const portfolio = await initPortfolio();
    if (!portfolio) {
        process.exit(1);
    }
    
    global.isRunning = true;
    global.tradeMode = portfolio.mode;

    // ==========================================
    // Phase 5: 啟動各路背景雷達與排程 (🚀 錯峰啟動版)
    // ==========================================
    console.log("⚙️ [Boot] 正在錯峰喚醒背景雷達與排程任務...");
    
    setTimeout(() => { macroMonitorService.start(); }, 12000);  // 12s: 大盤即時預警
    setTimeout(() => { macroJob.start(); }, 14000);             // 14s: 恐懼貪婪指數
    setTimeout(() => { trendingMonitorService.start(); }, 16000); // 16s: Gecko 爬蟲
    setTimeout(() => { trendingJob.start(); }, 18000);          // 18s: 熱門幣追擊
    setTimeout(() => { janitorJob.start(); }, 20000);           // 20s: 清道夫
    setTimeout(() => { graveyardJob.start(); }, 22000);         // 22s: 墓地火化
    setTimeout(() => { retrospectiveJob.start(); }, 24000);     // 24s: 大腦進化

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