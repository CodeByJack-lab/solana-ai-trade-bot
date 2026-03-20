// src/index.js - V5.5 終極對沖基金全自動化架構

const { supabase } = require('./config/supabase'); 
const { initPortfolio, getPortfolio, syncLiveBalanceToDB, updateSystemStatus } = require('./services/portfolioService');
const { startMarketMonitor } = require('./services/monitorService'); // Meme Webhook + 撈魚 + 橫盤
const { getSolPriceInHKD } = require('./services/priceService'); 

// 🚨 V5.5 新增模組匯入
const { macroMonitorService } = require('./services/macroMonitorService'); // 雙龍大盤防禦
const { blueChipJob } = require('./jobs/blueChipJob');                     // 老幣抄底雷達
const { retrospectiveJob } = require('./jobs/retrospectiveJob');           // AI 12AM/PM 復盤大腦
const { healthMonitor } = require('./services/healthMonitor');             // 全局健康看板

// 💀 墓地系統 (保留原有)
const { graveyardJob } = require('./jobs/graveyardJob'); 

async function startApp() {
    console.log("======================================================");
    console.log("🚀 SOL_Trade V5.5 終極雙軌並行 + 跨廠 AI 備援版啟動...");
    console.log("======================================================");

    /**
     * 1. 🚀 指令線：監聽 system_config (熱更新開關與資金同步)
     */
    supabase.channel('system_config_monitor')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' },
            (payload) => {
                const oldData = payload.old;
                const newData = payload.new;
                const portfolio = getPortfolio();

                // 💡 資金同步邏輯
                if (portfolio) {
                    if (newData.trade_mode === 'PAPER') {
                        if (Math.abs(portfolio.cash_sol - newData.simulated_balance) > 0.0001) {
                            console.log(`\n💰 [PAPER 同步] 記憶體餘額刷新為 ${newData.simulated_balance.toFixed(4)} SOL`);
                            portfolio.cash_sol = newData.simulated_balance;
                            portfolio.reference_capital = newData.reference_capital;
                        }
                    } else if (newData.trade_mode === 'LIVE') {
                        if (Math.abs(portfolio.cash_sol - newData.live_wallet_balance) > 0.0001) {
                            console.log(`\n💰 [LIVE 同步] 實盤記憶體餘額刷新為 ${newData.live_wallet_balance.toFixed(4)} SOL`);
                            portfolio.cash_sol = newData.live_wallet_balance;
                            portfolio.reference_capital = newData.live_wallet_balance;
                        }
                    }
                }

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

    // 2. 🏰 初始化資產數據與資金鎖
    const portfolio = await initPortfolio();
    if (!portfolio) {
        console.error("❌ 系統初始化失敗，程序退出。");
        process.exit(1);
    }

    // ==========================================
    // 3. 🚀 啟動全軍列陣 (V5.5 核心模組)
    // ==========================================
    startMarketMonitor();        // 啟動 Express Webhook, 滴水撈魚, 橫盤接回, 監軍逃生
    macroMonitorService.start(); // 啟動 BTC/SOL 雙龍防禦
    blueChipJob.start();         // 啟動 Binance RSI 老幣抄底雷達
    retrospectiveJob.start();    // 啟動 12AM/PM AI 參數微調排程
    
    if (graveyardJob && typeof graveyardJob.start === 'function') {
        graveyardJob.start();    // 啟動死囚火化排程
    }

    /**
     * 4. 💤 回報線：一體化「單行戰報」Loop (每 60 秒印一次，加入 Health Board)
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
            
            // 📢 構建終極戰報 (結合資金與全局監控狀態)
            console.log(`\n========================================`);
            console.log(`📊 [實時戰報] 總資產: $${totalCapitalHkd.toFixed(2)} HKD | 現金: ${currentCache.cash_sol.toFixed(4)} SOL`);
            console.log(`持倉數: ${currentCache.positions.length} 隻`);
            console.log(`--- 🩺 系統健康看板 ---`);
            console.log(healthMonitor.getHealthReport()); // 💡 印出所有模組嘅 🟢/🔴 狀態
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