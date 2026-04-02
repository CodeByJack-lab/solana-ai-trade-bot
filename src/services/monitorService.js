// src/services/monitorService.js
// 📝 檔案功能用途：V9.1.9 終極風控樞紐。結合 Telegram Webhook、LP 驟降逃生、100% 強制翻本、1 分鐘瀑布防線、無差別 Time-Stop、滿倉節流，以及「主動清道夫 (具備實時防誤殺機制)」。

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

const { walletMonitorRouter } = require('./walletMonitor');
const { securityGuard } = require('./securityGuard');
const { routerService } = require('./router');

const app = express();
app.use(cors());
app.use(express.json());

let globalSysConfig = { is_running: true };
let cachedSolPriceUsd = 150;

app.get('/', (req, res) => res.status(200).send('🟢 SOL_QUANT V9.1.9 系統正常運行中 (主動清道夫 + 防 Rug 拔線 + 實時防誤殺版)'));

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
                globalSysConfig.is_running = false; 
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
// 🎯 核心風控：0 延遲監控與 LP 拔線邏輯 (記憶體防跳頻版)
// ========================================================
const tokenStateRadar = new Map(); 

async function handleZeroLatencyCheck(mint, currentPriceSol, currentLiquidityUsd, portfolio) {
    if (!currentPriceSol || currentPriceSol <= 0) return;
    
    const pos = portfolio.positions.find(p => p.mint_address === mint);
    if (!pos) {
        tokenStateRadar.delete(mint);
        return; 
    }

    const now = Date.now();

    // --- 🛡️ 數據初始化與狀態監控 ---
    if (!tokenStateRadar.has(mint)) {
        tokenStateRadar.set(mint, { 
            maxLiquidity: currentLiquidityUsd || 0, 
            halfSellTriggered: false,
            priceHistory1Min: []
        });
    }
    const radar = tokenStateRadar.get(mint);

    // 1. 更新歷史最高流動性
    if (currentLiquidityUsd && currentLiquidityUsd > radar.maxLiquidity) {
        radar.maxLiquidity = currentLiquidityUsd;
    }

    // 2. 更新 1 分鐘價格軌跡 (瀑布防線用)
    radar.priceHistory1Min.push({ price: currentPriceSol, time: now });
    while (radar.priceHistory1Min.length > 0 && now - radar.priceHistory1Min[0].time > 60000) {
        radar.priceHistory1Min.shift();
    }
    const maxPriceLast60s = Math.max(...radar.priceHistory1Min.map(h => h.price));
    const dropFrom1MinHigh = ((currentPriceSol - maxPriceLast60s) / maxPriceLast60s) * 100;

    const pnlPct = ((currentPriceSol - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const isHalfSold = pos.strategy_type?.includes('HALF_SOLD') || radar.halfSellTriggered;

    let action = 'HOLD';
    let reason = '';
    let sellFraction = 1.0;

    // ==========================================
    // 🚨 優先級 1：Rug Pull 拔線 (LP 抽走 40%)
    // ==========================================
    if (currentLiquidityUsd && radar.maxLiquidity > 5000) { 
        if (currentLiquidityUsd < radar.maxLiquidity * 0.60) {
            action = 'SELL';
            sellFraction = 1.0;
            reason = `🛑 RUG PULL 拔線：流動性由 $${radar.maxLiquidity.toFixed(0)} 暴跌至 $${currentLiquidityUsd.toFixed(0)} (流失 > 40%)`;
        }
    }

    // ==========================================
    // 🎯 優先級 2：100% 強制翻本 (適用於 ALL 幣種)
    // ==========================================
    if (action === 'HOLD' && !isHalfSold && pnlPct >= 100) {
        action = 'SELL';
        sellFraction = 0.5; // 賣出 50%
        radar.halfSellTriggered = true; // 記憶體防跳頻
        reason = `🎯 翻本機制：PnL 達 +${pnlPct.toFixed(0)}%，回收 50% 本金 (零風險持倉)`;
    }

    // ==========================================
    // 🚨 優先級 3：1 分鐘極速瀑布防線
    // ==========================================
    if (action === 'HOLD' && dropFrom1MinHigh <= -15) {
        action = 'SELL'; 
        reason = `🚨 觸發瀑布防線：1 分鐘內極速插水 ${dropFrom1MinHigh.toFixed(2)}%`;
    }

    // ==========================================
    // ⏱️ 優先級 4：無差別 Time-Stop 時間止損
    // ==========================================
    const timeStopMins = config?.trade?.timeStopMinutes || 30;
    const timeStopTarget = config?.trade?.timeStopProfitTarget || 15;
    if (action === 'HOLD' && pos.created_at) {
        const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
        if (ageMins >= timeStopMins && pnlPct < timeStopTarget) {
            action = 'SELL';
            reason = `⏱️ Time-Stop 觸發: 持倉達 ${timeStopMins} 分鐘但利潤未達 +${timeStopTarget}%，強制離場。`;
        }
    }

    // ==========================================
    // 📉 優先級 5：其他止損/止盈邏輯
    // ==========================================
    if (action === 'HOLD') {
        const highestPnlPct = (((pos.highest_price_sol || pos.entry_price_sol) - pos.entry_price_sol) / pos.entry_price_sol) * 100;
        const stopLossLimit = config?.trade?.stopLossPct || -15;
        
        // 物理硬止損
        if (pnlPct <= stopLossLimit) {
            action = 'SELL';
            reason = `💥 硬止損觸發: ${pnlPct.toFixed(1)}% <= ${stopLossLimit}%`;
        }
        // 動態追蹤止損 (Trailing Stop)
        else if (highestPnlPct >= 50 && (highestPnlPct - pnlPct) >= 20) {
            action = 'SELL';
            reason = `💰 獲利回撤保護: 高位 +${highestPnlPct.toFixed(0)}% 回落 20 點`;
        }
    }

    // ==========================================
    // ⚡ 執行區：鎖衝突優化
    // ==========================================
    if (action === 'SELL') {
        const lockKey = `sell_lock:${mint}`;
        const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
        if (!acquired) return; 

        try {
            console.log(`🎬 [ACTION] ${reason}`);
            await runSellPipeline(pos, currentPriceSol, reason, sellFraction);
            
            if (sellFraction === 0.5 && typeof sendTelegramAlert === 'function') {
                sendTelegramAlert(`🎯 <b>零風險持倉達成！</b>\n🪙 代幣: $${pos.token_symbol}\n🔥 利潤達標，已成功賣出 50% 抽回全數本金！`);
            }
        } finally {
            await redis.del(lockKey); 
        }
    } else {
        // --- 📝 非同步更新最高價 (發射後不管，絕不阻塞風控) ---
        if (currentPriceSol > (pos.highest_price_sol || 0)) {
            pos.highest_price_sol = currentPriceSol;
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            supabase.from(`active_positions_${tableSuffix}`)
                .update({ highest_price_sol: currentPriceSol })
                .eq('mint_address', mint)
                .then()
                .catch(()=>{}); 
        }
    }
}

// ========================================================
// 🧹 獨立主動清道夫 (Active Death Sweeper - 雙軌制防誤殺版)
// ========================================================
function startActiveSweeper() {
    console.log('🧹 [Sweeper] 主動清道夫已上線，具備 2 秒實時查價防誤殺機制。');
    
    setInterval(async () => {
        if (!globalSysConfig.is_running) return;
        
        const portfolio = getPortfolio();
        const now = Date.now();

        for (const pos of portfolio.positions) {
            if (!pos.created_at) continue;
            
            const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
            
            // 🚀 核心修復：優先使用 PriceBot 每 2 秒寫入 RAM 的最新實時價 (current_price_sol)
            const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
            const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
            
            const isHalfSold = pos.strategy_type?.includes('HALF_SOLD');
            const isTrending = pos.strategy_type?.includes('TRENDING');

            // 🚦 雙軌制核心
            const timeStopMins = isTrending ? 1440 : (config?.trade?.timeStopMinutes || 30);
            const timeStopTarget = isTrending ? 5 : (config?.trade?.timeStopProfitTarget || 15);
            const zombieMins = isTrending ? 2880 : 120;

            let shouldSell = false;
            let reason = '';

            // 1. 動態 Time-Stop 判斷
            if (ageMins >= timeStopMins) {
                // 🛡️ 實時防誤殺：如果利潤其實已經大於目標 (+15%)，攔截清道夫！
                if (pnlPct >= timeStopTarget) {
                    console.log(`🛡️ [Sweeper] 攔截！${pos.token_symbol} 實時已達標 (+${pnlPct.toFixed(2)}%)，收回屠刀，交由常規雷達止盈！`);
                } else {
                    shouldSell = true;
                    reason = `🧹 [主動清道夫] ${isTrending ? '藍籌' : 'Meme'} 滯留過久 (${ageMins.toFixed(0)} 分鐘未達 +${timeStopTarget}%)，無差別清倉！`;
                }
            }

            // 2. 動態殭屍防線
            if (!shouldSell && ageMins >= zombieMins && !isHalfSold) {
                shouldSell = true;
                reason = `🧟 [主動清道夫] ${isTrending ? '藍籌' : 'Meme'} 殭屍幣超時 (${ageMins.toFixed(0)} 分鐘未翻本)，強制火化拔線！`;
            }

            if (shouldSell) {
                const lockKey = `sell_lock:${pos.mint_address}`;
                const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
                if (acquired) {
                    console.log(`\n🚨 [Sweeper] 發現違規卡死倉位: $${pos.token_symbol} - ${reason}`);
                    runSellPipeline(pos, currentPrice, reason, 1.0)
                        .finally(() => redis.del(lockKey));
                }
            }
        }
    }, 60000); // 每 60 秒無差別巡視一次
}

// ========================================================
// 🌐 啟動大本營監控迴圈
// ========================================================
function startPositionMonitor() {
    console.log('👁️ [Monitor] V9.1.9 終極風控啟動：主動清道夫、LP 拔線、100% 翻本、手動斬倉與滿倉節流全數就位。');
    
    // 定時同步系統狀態
    setInterval(async () => {
        try { 
            cachedSolPriceUsd = (await require('./priceService').getSolPriceInHKD()) / 7.8; 
            const { data } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
            if (data) globalSysConfig.is_running = data.is_running;
        } catch(e) {}
    }, 10000);

    // ========================================================
    // 🎧 監聽 Dashboard 手動斬倉指令
    // ========================================================
    supabase.channel('dashboard-commands')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'command_queue' }, async (payload) => {
            const cmd = payload.new;
            console.log(`\n📥 [Dashboard] 收到前端手動指令: ${cmd.command_type}`);
            
            const portfolio = getPortfolio();

            if (cmd.command_type === 'SELL_SINGLE' && cmd.mint_address) {
                const pos = portfolio.positions.find(p => p.mint_address === cmd.mint_address);
                if (pos) {
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
                    if (acquired) {
                        console.log(`⚡ 正在執行手動單獨平倉: ${pos.token_symbol}`);
                        runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, "🚨 Dashboard 手動平倉拔線", 1.0)
                            .finally(() => redis.del(lockKey));
                    }
                }
            } 
            else if (cmd.command_type === 'SELL_ALL') {
                console.log(`☢️ [核按鈕] 啟動一鍵全平倉！`);
                const sellPromises = portfolio.positions.map(async (pos) => {
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
                    if (acquired) {
                        return runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, "🚨 Dashboard 一鍵全平倉", 1.0)
                            .finally(() => redis.del(lockKey));
                    }
                });
                await Promise.allSettled(sellPromises);
            }
            else if (cmd.command_type === 'RESET_PAPER') {
                console.log(`\n🧹 [System] 收到前端重置模擬盤指令！正在進行物理失憶...`);
                tokenStateRadar.clear();
                try {
                    const keys = await redis.keys('sell_lock:*');
                    if (keys.length > 0) await redis.del(keys);
                } catch(e) {}
                try {
                    const { resetPaperMemory } = require('./portfolioService');
                    if (resetPaperMemory) await resetPaperMemory();
                } catch (e) {
                    console.log(`⚠️ 無法呼叫 resetPaperMemory: ${e.message}`);
                }
                console.log(`✅ [System] 洗腦完成！幽靈倉位已全數清除，無需重啟系統！`);
            }
            await supabase.from('command_queue').delete().eq('id', cmd.id).then().catch(()=>{});
        }).subscribe();

    redisSub.subscribe('price_updates', 'emergency_sell');
    
    // ========================================================
    // 🎧 監聽 PriceBot 2 秒報價，實時寫入 RAM
    // ========================================================
    redisSub.on('message', async (channel, message) => {
        const portfolio = getPortfolio();
        
        if (channel === 'price_updates') {
            try {
                if (!globalSysConfig.is_running) return; 
                const { mint, priceUsd, liquidity, priceSol } = JSON.parse(message);
                
                // 🚀 核心修復：優先使用 PriceBot 傳來的精確原生 SOL 價
                const currentPriceSol = priceSol || (priceUsd / cachedSolPriceUsd); 

                // 🧠 將 2 秒最新價硬寫入 RAM，供清道夫與其他雷達使用
                const pos = portfolio.positions.find(p => p.mint_address === mint);
                if (pos) {
                    pos.current_price_sol = currentPriceSol;
                    if (currentPriceSol > (pos.highest_price_sol || pos.entry_price_sol)) {
                        pos.highest_price_sol = currentPriceSol;
                    }
                }

                // 傳入流動性數據進行 Rug 檢測
                await handleZeroLatencyCheck(mint, currentPriceSol, liquidity || 0, portfolio);
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

    // 🌟 檢查 Nursery Queue 處理新進標的
    let isNurseryRunning = false;
    setInterval(async () => {
        if (isNurseryRunning || !globalSysConfig.is_running) return;
        isNurseryRunning = true;

        try {
            const now = Date.now();
            const fiveMinsAgo = now - (5 * 60 * 1000);

            const ripeTokens = await redis.zrangebyscore('v9_nursery_queue', 0, fiveMinsAgo, 'LIMIT', 0, 5);
            
            if (ripeTokens.length > 0) {
                await redis.zrem('v9_nursery_queue', ...ripeTokens);

                const portfolio = getPortfolio();
                const { data: dbConfig } = await supabase.from('system_config').select('max_meme_positions').eq('id', 1).single();
                const maxMeme = dbConfig?.max_meme_positions || 0;
                
                const currentMemeCount = portfolio.positions.filter(p => p.strategy_type.includes('MEME') || p.strategy_type.includes('NEWBORN')).length;

                if (currentMemeCount >= maxMeme) {
                    console.log(`🛑 [節流閘口] Meme 倉位已滿 (${currentMemeCount}/${maxMeme})，自動捨棄 ${ripeTokens.length} 隻新幣，節省 API 資源！`);
                    return; 
                }

                console.log(`\n🐟 [Nursery] 倉位充足，捕獲 ${ripeTokens.length} 隻新幣已養足 5 分鐘，出池進行安檢...`);

                const evalPromises = ripeTokens.map(async (mint) => {
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
    }, 10000); 
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 8080, '0.0.0.0', () => {
        console.log('🔄 [System] 啟動 V9.1.9 獨立 Webhook 伺服器與風控中心...');
        startPositionMonitor();
        startActiveSweeper(); 
    });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

module.exports = { startMarketMonitor };