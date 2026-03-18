// src/index.js - 物理隔離 + 整合單行戰報完全體 + 宏觀風控探測器

const { supabase } = require('./config/supabase'); 
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService');
const { getSolPriceInHKD } = require('./services/priceService'); 
const { startBtcMonitor } = require('./services/btcMonitorService');
const { macroJob } = require('./jobs/macroJob'); 

async function startApp() {
    console.log("========================================");
    console.log("🚀 SOL_Trade 終極防禦 + 翻倍保本版啟動...");
    console.log("========================================");

    /**
     * 1. 🚀 指令線：監聽 system_config 
     * 🛠️ 核心修復：加入前端「資金 SET」與「實盤同步」的即時記憶體刷新
     */
    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            (payload) => {
                const oldData = payload.old;
                const newData = payload.new;
                const portfolio = getPortfolio();

                // 💡 [修復 BUG] 偵測到 DB 資金改變，強制刷新 Node.js 記憶體
                if (portfolio) {
                    if (newData.trade_mode === 'PAPER') {
                        // 模擬模式：監聽 simulated_balance
                        if (Math.abs(portfolio.cash_sol - newData.simulated_balance) > 0.0001) {
                            console.log(`\n💰 [PAPER 同步] 記憶體餘額刷新為 ${newData.simulated_balance.toFixed(4)} SOL`);
                            portfolio.cash_sol = newData.simulated_balance;
                            portfolio.reference_capital = newData.reference_capital;
                        }
                    } else if (newData.trade_mode === 'LIVE') {
                        // 🚀 實盤模式：監聽 live_wallet_balance
                        if (Math.abs(portfolio.cash_sol - newData.live_wallet_balance) > 0.0001) {
                            console.log(`\n💰 [LIVE 同步] 實盤記憶體餘額刷新為 ${newData.live_wallet_balance.toFixed(4)} SOL`);
                            portfolio.cash_sol = newData.live_wallet_balance;
                            portfolio.reference_capital = newData.live_wallet_balance;
                        }
                    }
                }

                // 檢查是否只是狀態開關 (避免資金同步觸發重複廣播)
                if (oldData && oldData.is_running === newData.is_running && oldData.trade_mode === newData.trade_mode) {
                    return; 
                }

                console.log(`\n🔔 [遠端指令] 狀態: ${newData.is_running ? '🟢 運行中' : '🔴 已暫停'} | 模式: ${newData.trade_mode}`);
                
                global.isRunning = newData.is_running;
                global.tradeMode = newData.trade_mode;

                updateSystemStatus(newData.is_running ? "🟢 系統指令：開始作戰" : "🛑 系統指令：暫停交易");
            }
        )
        .subscribe();

    // 2. 🏰 初始化資產數據
    const portfolio = await initPortfolio();
    if (!portfolio) {
        console.error("❌ 系統初始化失敗，程序退出。");
        process.exit(1);
    }

    // 3. 啟動後台服務
    startMarketMonitor(); 
    startBtcMonitor();    
    macroJob.start();     

    /**
     * 2. 💤 回報線：一體化「單行戰報」Loop (每 60 秒印一次)
     */
    async function backgroundReportLoop() {
        try {
            if (global.isRunning === false) {
                setTimeout(backgroundReportLoop, 60000);
                return;
            }

            await syncLiveBalanceToDB();
            const currentCache = getPortfolio();
            const solHkdPrice = await getSolPriceInHKD();
            
            // 🧮 核心精算：使用統一的 quantity 變量，避免 NaN 崩潰
            const investedSol = currentCache.positions.reduce((sum, pos) => {
                const qty = pos.quantity || 0;
                const price = pos.entry_price_sol || 0;
                return sum + (qty * price);
            }, 0);
            
            const totalCapitalSol = currentCache.cash_sol + investedSol;
            const totalCapitalHkd = totalCapitalSol * solHkdPrice;
            
            const totalUnits = Math.floor(totalCapitalHkd / 200);
            const reserveUnits = Math.max(2, Math.floor(totalUnits * 0.2)); 
            const maxPositions = Math.max(0, totalUnits - reserveUnits);

            // 📢 構建單行過「終極戰報」
            const summaryLog = `🛰️ 雷達掃描中...`;
            
            console.log(summaryLog);
            await updateSystemStatus(summaryLog.replace('📊 ', '🦅 '));
            
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