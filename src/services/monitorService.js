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

app.get('/', (req, res) => res.status(200).send('🟢 SOL_QUANT V9.1.0 系統正常運行中 (多路冗餘 + Fast-Track)'));

// 掛載解耦的 Webhook
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

            // 1. 處理 0 延遲核按鈕
            if (actionData === 'PANIC_PAUSE_BUY') {
                await supabase.from('system_config').update({ is_running: false, status_msg: '已手動暫停新開倉' }).eq('id', 1);
                sendAdminAlert(`⏸️ <b>系統已暫停買入</b>\n操作者: ${userName}`);
                return;
            }
            if (actionData === 'PANIC_RESUME_BUY') {
                await supabase.from('system_config').update({ is_running: true, status_msg: '正常運作中' }).eq('id', 1);
                sendAdminAlert(`▶️ <b>系統已恢復正常</b>\n操作者: ${userName}`);
                return;
            }
            if (actionData === 'PANIC_SELL_ALL_CONFIRM') {
                await supabase.from('system_config').update({ is_running: false, status_msg: '手動緊急全平倉中' }).eq('id', 1);
                sendAdminAlert(`🚨 <b>手動啟動核按鈕</b>\n操作者: ${userName}\n正在全線市價強平！`);

                const positions = getPortfolio().positions;
                for (const pos of positions) {
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                    if (acquired) {
                        await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, "🚨 Telegram 0延遲手動拔線", 1.0)
                            .finally(() => redis.del(lockKey));
                        await new Promise(r => setTimeout(r, 1000)); // 避免 RPC 擁堵
                    }
                }
                return;
            }

            // 2. 處理原有的 AI 回測提案審批
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

async function handleZeroLatencyCheck(mint, currentPriceSol, sysConfig, portfolio) {
    if (!currentPriceSol || currentPriceSol <= 0) return;
    
    const pos = portfolio.positions.find(p => p.mint_address === mint);
    if (!pos) return; 

    // 維護 1 分鐘價格快取
    const now = Date.now();
    if (!priceHistory1Min.has(mint)) priceHistory1Min.set(mint, []);
    const history = priceHistory1Min.get(mint);
    history.push({ price: currentPriceSol, time: now });
    while (history.length > 0 && now - history[0].time > 60000) history.shift();
    priceHistory1Min.set(mint, history);

    const maxPriceLast60s = Math.max(...history.map(h => h.price));
    const dropFrom1MinHigh = ((currentPriceSol - maxPriceLast60s) / maxPriceLast60s) * 100;
    
    const pnlPct = (((currentPriceSol - pos.entry_price_sol) * pos.quantity) / (pos.entry_price_sol * pos.quantity)) * 100;
    
    // 更新歷史最高價
    if (currentPriceSol > pos.highest_price_sol) {
        if (currentPriceSol / (pos.highest_price_sol || pos.entry_price_sol) < 50) { 
            pos.highest_price_sol = currentPriceSol;
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            supabase.from(`active_positions_${tableSuffix}`).update({ highest_price_sol: currentPriceSol }).eq('mint_address', pos.mint_address).then();
        }
    }

    const drawdownFromHigh = ((currentPriceSol - pos.highest_price_sol) / pos.highest_price_sol) * 100;
    const highestPnlPct = ((pos.highest_price_sol - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const isHalfSold = pos.strategy_type && pos.strategy_type.includes('HALF_SOLD');

    let action = 'HOLD'; let reason = ''; let sellFraction = 1.0; 
    
    // 讀取 config 中的動態門檻
    const stopLossLimit = -15; // 預設物理止損 15%
    const tpTrigger = 50;      // 預設追蹤止盈觸發點 50%
    const pullbackTolerance = 20; // 預設回落容忍 20%
    
    // ⏳ 檢查 V9.1 專屬 Time-Stop 標籤 (30分鐘未達利潤即斬)
    if (pos.strategy_type.includes('TIMESTOP')) {
        const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
        if (ageMins >= config.trade.timeStopMinutes && pnlPct < config.trade.timeStopProfitTarget) {
            action = 'SELL';
            reason = `⏱️ Time-Stop 觸發: 持倉達 ${config.trade.timeStopMinutes} 分鐘但利潤未達 +${config.trade.timeStopProfitTarget}%，強制離場。`;
        }
    }

    let trailingTriggered = false;
    let trailingReason = '';
    const pnlDropPoints = highestPnlPct - pnlPct; 

    // 動態網格防線邏輯
    if (highestPnlPct >= tpTrigger) {
        if (pnlDropPoints >= pullbackTolerance) { 
            trailingTriggered = true; 
            trailingReason = `動態網格防線: 最高 +${highestPnlPct.toFixed(0)}%，回落 ${pullbackTolerance} 個利潤點鎖潤`; 
        }
    }

    // 決策樹判定
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

    // 執行賣出
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
    let cachedSolPriceUsd = 150; 
    
    setInterval(async () => {
        try { cachedSolPriceUsd = (await require('./priceService').getSolPriceInHKD()) / 7.8; } catch(e) {}
    }, 60000);

    // 🎯 訂閱 2 秒報價更新 與 動能衰退拔線訊號
    redisSub.subscribe('price_updates', 'emergency_sell');
    
    redisSub.on('message', async (channel, message) => {
        const portfolio = getPortfolio();
        
        if (channel === 'price_updates') {
            try {
                const { data: sysConfig } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!sysConfig?.is_running) return;
                
                const { mint, priceUsd } = JSON.parse(message);
                const currentPriceSol = priceUsd / cachedSolPriceUsd; 
                await handleZeroLatencyCheck(mint, currentPriceSol, sysConfig, portfolio);
            } catch (err) {}
        }
        
        // 🚀 接收 priceBot.js 傳來的動能衰退拔線訊號
        if (channel === 'emergency_sell') {
            try {
                const { data: sysConfig } = await supabase.from('system_config').select('*').eq('id', 1).single();
                if (!sysConfig?.is_running) return;

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

    // 🌟 每 10 秒檢查 Nursery Queue 處理新進標的
    let isNurseryRunning = false;
    setInterval(async () => {
        if (isNurseryRunning) return;
        isNurseryRunning = true;

        try {
            const { data: sysConfig } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!sysConfig || !sysConfig.is_running) return;

            // 從 Redis 取出最新 1 個排隊的 Mint
            const queueItems = await redis.zrange('v9_nursery_queue', 0, 0);
            if (queueItems.length > 0) {
                const mint = queueItems[0];
                await redis.zrem('v9_nursery_queue', mint);

                // 執行 100 分量化安檢
                const secResult = await securityGuard.calculateQuantScore(mint, 'NEWBORN');
                
                // 送入 Router 分流 (Fast-Track 或 AI 微調)
                await routerService.routeSignal(mint, 'NEWBORN', secResult);
            }
        } catch (err) {
            console.error(`❌ [Nursery Processor] 異常:`, err.message);
        } finally {
            isNurseryRunning = false;
        }
    }, 10000);
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