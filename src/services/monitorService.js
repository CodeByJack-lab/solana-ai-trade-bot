// src/services/monitorService.js
// 📝 檔案功能用途：V9.1 大本營樞紐與 0 延遲風控中心。掛載 Webhook 路由，接收 0 延遲報價與動能衰退拔線訊號，實作 Time-Stop。

const express = require('express');
const cors = require('cors');
const { supabase } = require('../config/supabase');
const config = require('../config/config');
const { runSellPipeline } = require('./tradeService');
const { getPortfolio } = require('./portfolioService');
const { processTelegramCallback, sendAdminAlert, sendTelegramAlert } = require('./telegramService');

const Redis = require('ioredis');
const redis = new Redis(config.cache.redisUrl);
const redisSub = new Redis(config.cache.redisUrl); 

// 引入 V9.1 解耦後的獨立路由
const { aggregatorRouter } = require('./sourceAggregator');
const { walletMonitorRouter } = require('./walletMonitor');
const { securityGuard } = require('./securityGuard');
const { routerService } = require('./router');

const app = express();
app.use(cors());
app.use(express.json());

// 🟢 [優化 1] 建立全域變數緩存，防止高頻轟炸 Database
let globalSysConfig = { is_running: true };
let cachedSolPriceUsd = 150;

app.get('/', (req, res) => res.status(200).send('🟢 SOL_QUANT V9.1.1 系統正常運行中 (高併發優化版)'));

app.use(aggregatorRouter);
app.use(walletMonitorRouter);

// ========================================================
// 🚨 Telegram 0 延遲恐慌按鈕 Webhook
// ========================================================
app.post('/webhook/telegram', async (req, res) => {
    res.status(200).send('OK'); 
    try {
        if (req.body && req.body.callback_query) {
            const query = req.body.callback_query;
            const actionData = query.data;
            const userName = query.from?.first_name || 'Boss';
            
            console.log(`📥 [Telegram Webhook] 收到 ${userName} 的 0 延遲風控指令: ${actionData}`);

            if (actionData === 'PANIC_PAUSE_BUY') {
                globalSysConfig.is_running = false; // 先改 Memory 擋截
                await supabase.from('system_config').update({ is_running: false, status_msg: '已手動暫停新開倉' }).eq('id', 1);
                sendAdminAlert(`⏸️ <b>系統已暫停買入</b>\n操作者: ${userName}`);
                return;
            }
            if (actionData === 'PANIC_RESUME_BUY') {
                globalSysConfig.is_running = true;
                await supabase.from('system_config').update({ is_running: true, status_msg: '正常運作中' }).eq('id', 1);
                sendAdminAlert(`▶️ <b>系統已恢復正常</b>\n操作者: ${userName}`);
                return;
            }
            if (actionData === 'PANIC_SELL_ALL_CONFIRM') {
                globalSysConfig.is_running = false;
                await supabase.from('system_config').update({ is_running: false, status_msg: '手動緊急全平倉中' }).eq('id', 1);
                sendAdminAlert(`🚨 <b>手動啟動核按鈕</b>\n操作者: ${userName}\n正在全線併發市價強平！`);

                const positions = getPortfolio().positions;
                // 🟢 [優化 2] 併發執行緊急平倉，不再排隊槍斃
                const sellPromises = positions.map(async (pos) => {
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                    if (acquired) {
                        return runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, "🚨 Telegram 0延遲手動併發拔線", 1.0)
                            .finally(() => redis.del(lockKey));
                    }
                });
                await Promise.allSettled(sellPromises);
                return;
            }

            if (actionData.startsWith('APPROVE_') || actionData.startsWith('REJECT_')) {
                await processTelegramCallback(query);
            }
        }
    } catch (err) {
        console.error("❌ [Telegram Webhook 故障]:", err.message);
    }
});

// ========================================================
// 🎯 核心：0 延遲持倉秒斬與動能衰退防線
// ========================================================
const priceHistory1Min = new Map(); 

async function handleZeroLatencyCheck(mint, currentPriceSol, portfolio) {
    if (!currentPriceSol || currentPriceSol <= 0) return;
    
    const pos = portfolio.positions.find(p => p.mint_address === mint);
    if (!pos) {
        // 清理殘留 Memory Leak
        if (priceHistory1Min.has(mint)) priceHistory1Min.delete(mint);
        return; 
    }

    const now = Date.now();
    if (!priceHistory1Min.has(mint)) priceHistory1Min.set(mint, []);
    const history = priceHistory1Min.get(mint);
    history.push({ price: currentPriceSol, time: now });
    while (history.length > 0 && now - history[0].time > 60000) history.shift();
    priceHistory1Min.set(mint, history);

    const maxPriceLast60s = Math.max(...history.map(h => h.price));
    const dropFrom1MinHigh = ((currentPriceSol - maxPriceLast60s) / maxPriceLast60s) * 100;
    
    const pnlPct = (((currentPriceSol - pos.entry_price_sol) * pos.quantity) / (pos.entry_price_sol * pos.quantity)) * 100;
    
    if (currentPriceSol > pos.highest_price_sol) {
        if (currentPriceSol / (pos.highest_price_sol || pos.entry_price_sol) < 50) { 
            pos.highest_price_sol = currentPriceSol;
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            // 🟢 [優化 3] 加入 catch 避免 Unhandled Promise Rejection
            supabase.from(`active_positions_${tableSuffix}`).update({ highest_price_sol: currentPriceSol }).eq('mint_address', pos.mint_address).then().catch(()=> {});
        }
    }

    const drawdownFromHigh = ((currentPriceSol - pos.highest_price_sol) / pos.highest_price_sol) * 100;
    const highestPnlPct = ((pos.highest_price_sol - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');

    let action = 'HOLD'; let reason = ''; let sellFraction = 1.0; 
    
    // 安全讀取 Config (加防呆)
    const timeStopMins = config?.trade?.timeStopMinutes || 30;
    const timeStopTarget = config?.trade?.timeStopProfitTarget || 15;
    const stopLossLimit = config?.trade?.stopLossPct || -15; 
    const tpTrigger = 50;      
    const pullbackTolerance = 20; 
    
    if (pos.strategy_type.includes('TIMESTOP') && pos.created_at) {
        const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
        if (ageMins >= timeStopMins && pnlPct < timeStopTarget) {
            action = 'SELL';
            reason = `⏱️ Time-Stop 觸發: 持倉達 ${timeStopMins} 分鐘但利潤未達 +${timeStopTarget}%，強制離場。`;
        }
    }

    let trailingTriggered = false;
    let trailingReason = '';
    const pnlDropPoints = highestPnlPct - pnlPct; 

    if (highestPnlPct >= tpTrigger) {
        if (pnlDropPoints >= pullbackTolerance) { 
            trailingTriggered = true; 
            trailingReason = `動態網格防線: 最高 +${highestPnlPct.toFixed(0)}%，回落 ${pullbackTolerance} 個利潤點鎖潤`; 
        }
    }

    if (action === 'HOLD') {
        if (!isHalfSold && pnlPct >= 100) {
            action = 'SELL'; sellFraction = 0.5; 
            reason = `🎯 觸發硬止盈 (抽回本金)：利潤達 +${pnlPct.toFixed(2)}%，賣出 50% 鎖定本金！`;
        } 
        else if (dropFrom1MinHigh <= -15) {
            action = 'SELL'; 
            reason = `🚨 觸發瀑布防線：1 分鐘內極速插水 ${dropFrom1MinHigh.toFixed(2)}%`;
        } 
        else if (pnlPct <= stopLossLimit) {
            action = 'SELL'; 
            reason = `💥 觸發物理硬止損 (${pnlPct.toFixed(2)}% <= ${stopLossLimit}%)`;
        } 
        else if (trailingTriggered) {
            action = 'SELL'; 
            reason = `💰 ${trailingReason}`;
        }
        else if (drawdownFromHigh <= -30) {
            action = 'SELL'; 
            reason = `🚨 偵測到斷崖式崩盤 (高位回撤 ${drawdownFromHigh.toFixed(2)}%)`;
        }
    }

    if (action === 'SELL') {
        const lockKey = `sell_lock:${pos.mint_address}`;
        const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
        
        if (!acquired) return;

        priceHistory1Min.delete(pos.mint_address);
        runSellPipeline(pos, currentPriceSol, reason, sellFraction).then(sellResult => {
            if (sellResult && sellFraction === 0.5) {
                sendTelegramAlert(`🎯 <b>零風險持倉達成！</b>\n🪙 代幣: $${pos.token_symbol}\n🔥 利潤達標，已成功賣出 50% 抽回全數本金！`);
            }
        }).catch(err => console.error(`❌ [Zero Latency Error]`, err.message))
          .finally(() => redis.del(lockKey));
    }
}

// ========================================================
// 🌐 啟動大本營監控迴圈
// ========================================================
function startPositionMonitor() {
    console.log('👁️ [Monitor] V9.1 0 延遲秒斬防線與動能接收器已啟動...');
    
    // 🟢 [優化 1.1] 獨立一個 Worker 每 10 秒更新 DB 狀態，解放 Pub/Sub
    setInterval(async () => {
        try { 
            cachedSolPriceUsd = (await require('./priceService').getSolPriceInHKD()) / 7.8; 
            const { data } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
            if (data) globalSysConfig.is_running = data.is_running;
        } catch(e) {}
    }, 10000);

    redisSub.subscribe('price_updates', 'emergency_sell');
    
    redisSub.on('message', async (channel, message) => {
        const portfolio = getPortfolio();
        
        if (channel === 'price_updates') {
            try {
                if (!globalSysConfig.is_running) return; // 讀取 Memory，0 延遲
                
                const { mint, priceUsd } = JSON.parse(message);
                const currentPriceSol = priceUsd / cachedSolPriceUsd; 
                await handleZeroLatencyCheck(mint, currentPriceSol, portfolio);
            } catch (err) {}
        }
        
        if (channel === 'emergency_sell') {
            try {
                if (!globalSysConfig.is_running) return;

                const { mint, reason } = JSON.parse(message);
                const pos = portfolio.positions.find(p => p.mint_address === mint);
                
                if (pos) {
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                    if (acquired) {
                        console.log(`\n🚨 [Emergency] 收到 PriceBot 拔線指令：${reason}`);
                        runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, reason, 1.0)
                            .finally(() => redis.del(lockKey));
                    }
                }
            } catch (err) {
                console.error("❌ 處理 emergency_sell 訊號失敗:", err.message);
            }
        }
    });

    // 🌟 檢查 Nursery Queue 處理新進標的 (併發加速版)
    let isNurseryRunning = false;
    setInterval(async () => {
        if (isNurseryRunning || !globalSysConfig.is_running) return;
        isNurseryRunning = true;

        try {
            // 🟢 [優化 2] 每次拉取 5 隻幣，解決大塞車
            const queueItems = await redis.zrange('v9_nursery_queue', 0, 4);
            if (queueItems.length > 0) {
                // 從 Queue 中移除
                await redis.zrem('v9_nursery_queue', ...queueItems);

                // 並行執行 100 分量化安檢
                const evalPromises = queueItems.map(async (mint) => {
                    try {
                        const secResult = await securityGuard.calculateQuantScore(mint, 'NEWBORN');
                        await routerService.routeSignal(mint, 'NEWBORN', secResult);
                    } catch (e) {
                        console.error(`❌ [Nursery] 評估 ${mint} 失敗:`, e.message);
                    }
                });

                await Promise.allSettled(evalPromises);
            }
        } catch (err) {
            console.error(`❌ [Nursery Processor] 異常:`, err.message);
        } finally {
            isNurseryRunning = false;
        }
    }, 5000); // 縮短至每 5 秒執行一次
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 8080, '0.0.0.0', () => {
        console.log('🔄 [System] 啟動 V9.1 獨立 Webhook 伺服器與風控中心...');
        startPositionMonitor();
    });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

module.exports = { startMarketMonitor };