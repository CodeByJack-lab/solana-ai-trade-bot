// src/index.js - V7.0 Protocol-level Diagnosis
const configEnv = require('./config/env'); 
const { supabase } = require('./config/supabase'); 
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService'); 
const { getSolPriceInHKD } = require('./services/priceService'); 

const { macroMonitorService } = require('./services/macroMonitorService'); 
const { blueChipJob } = require('./jobs/blueChipJob');                     
const { retrospectiveJob } = require('./jobs/retrospectiveJob');           
const { healthMonitor } = require('./services/healthMonitor');             

const { graveyardJob } = require('./jobs/graveyardJob');                   
const { janitorJob } = require('./jobs/janitorJob');   

const { trendingMonitorService } = require('./services/trendingMonitorService');
const { trendingJob } = require('./jobs/trendingJob');

// 👇 [V7.0] 引入 Price Oracle
const { priceOracleService } = require('./services/priceOracleService');

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
    console.log("🚀 SOL_Trade V7.0 協議級防彈版啟動...");
    console.log("======================================================");

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
                    const newPortfolio = await initPortfolio(); 
                    
                    if (newPortfolio && newPortfolio.positions) {
                        priceOracleService.setPortfolioMints(newPortfolio.positions.map(p => p.mint_address));
                    }
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

    // 將現有持倉加入 Oracle 2秒 VIP 專線
    const currentMints = portfolio.positions.map(p => p.mint_address);
    if (currentMints.length > 0) {
        priceOracleService.setPortfolioMints(currentMints);
        console.log(`✅ [Oracle] 已將 ${currentMints.length} 隻幣登記至 2 秒極速心跳線`);
    }

    macroMonitorService.start(); 
    blueChipJob.start();         
    retrospectiveJob.start();    
    janitorJob.start();    
    
    if (trendingMonitorService && typeof trendingMonitorService.start === 'function') {
        trendingMonitorService.start();
    }
    if (trendingJob && typeof trendingJob.start === 'function') {
        trendingJob.start();      
    }
    if (graveyardJob && typeof graveyardJob.start === 'function') {
        graveyardJob.start();    
    }

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