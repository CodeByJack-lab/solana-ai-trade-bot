// src/services/monitorService.js
// 📝 檔案功能用途：V9.2 終極風控樞紐。結合 Telegram Webhook 裝甲、Redis 瀑布防線、全域快取參數 O(1) 讀取、精準分批止盈、動態追蹤止損、無差別 Time-Stop、主動清道夫及 AMM 報價崩潰防護。
// 🛡️ 新增裝甲：Helius Webhook 對接、OFI 缺失攔截防線、3階段指數退避解決 404 API 延遲。

const express = require('express');
const cors = require('cors');
const { supabase } = require('../config/supabase');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 
const { runSellPipeline } = require('./tradeService');
const { getPortfolio } = require('./portfolioService');
const { processTelegramCallback, sendAdminAlert, sendTelegramAlert } = require('./telegramService');

const Redis = require('ioredis');
const redis = new Redis(config.cache.redisUrl);
const redisSub = new Redis(config.cache.redisUrl); 

const { walletMonitorRouter } = require('./walletMonitor');
const { securityGuard } = require('./securityGuard');
const { routerService } = require('./router');

// 📦 新增依賴：用於 API 退避查詢與 RPC 降級
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const solanaConnection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

const app = express();
app.use(cors());
app.use(express.json());

let globalSysConfig = { is_running: true };
let cachedSolPriceUsd = 150;

app.get('/', (req, res) => res.status(200).send('🟢 SOL_QUANT V9.2 系統正常運行中 (全域快取 + Webhook 裝甲 + Redis 瀑布防線 + OFI 硬防線)'));

app.use(walletMonitorRouter);

// ========================================================
// 🛡️ 核心輔助函數：Payload 清洗與 OFI 安檢引擎
// ========================================================
function extractBase58(payload) {
    if (!payload) return null;
    const rawMint = String(payload.mint || payload).replace(/[\n\r\s]/g, '');
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(rawMint) ? rawMint : null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function checkOnChainExistence(mintAddress) {
    try {
        const pubKey = new PublicKey(mintAddress);
        const accountInfo = await solanaConnection.getAccountInfo(pubKey);
        return accountInfo !== null;
    } catch (error) {
        console.error(`❌ [RPC ERROR] 檢查鏈上狀態失敗 ${mintAddress}:`, error.message);
        return false;
    }
}

// ========================================================
// 🛡️ 核心輔助函數：獲取市場數據及 OFI/女巫攻擊安檢引擎
// ========================================================
async function fetchMarketDataWithOFI(mintAddress) {
    const delays = [2000, 5000, 10000]; // 2s -> 5s -> 10s 應對 Dexscreener/Helius 索引延遲
    for (let attempt = 0; attempt < delays.length; attempt++) {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
            const pairs = response.data?.pairs;

            if (pairs && pairs.length > 0) {
                const pair = pairs[0]; 
                const liquidity = pair.liquidity?.usd || 0;
                const volume = pair.volume?.h1 || 0;
                const buys = pair.txns?.h1?.buys || 0;
                const sells = pair.txns?.h1?.sells || 0;

                let ofiStatus = "N/A";
                let isOFIOk = false;
                const totalTxns = buys + sells;
                
                if (totalTxns > 0) {
                    const buyRatio = buys / totalTxns;
                    const ofiRatio = (buys - sells) / totalTxns;
                    ofiStatus = (ofiRatio * 100).toFixed(2) + "%";
                    
                    // 1. 基礎活躍度檢查 (確保唔係死水)
                    if (buys >= 5 && sells >= 5) {
                        isOFIOk = true;
                    }

                    // 2. 🚨 女巫攻擊防禦 (Sybil Wash Trading Shield)
                    // 真實市場極少出現完美 50:50 的買賣次數。如果交易次數多 (>50)，且比例落在 48% - 52% 之間，極度可疑。
                    if (totalTxns > 50 && buyRatio > 0.48 && buyRatio < 0.52) {
                        isOFIOk = false;
                        console.error(`🚨 [SYBIL DETECTED] 買賣極度對稱 (Buys: ${buys}, Sells: ${sells}, Ratio: ${(buyRatio*100).toFixed(1)}%)。判定為莊家腳本刷單！`);
                    }

                    // 3. 🚨 換手率異常防禦 (Churn Rate Anomaly)
                    // 如果 1 小時交易量是流動性池的 5 倍以上，且買賣訂單流失衡率 < 5% (接近 0)，代表資金在空轉。
                    if (liquidity > 0 && (volume / liquidity) > 5 && totalTxns > 50 && Math.abs(ofiRatio) < 0.05) {
                        isOFIOk = false;
                        console.error(`🚨 [CHURN ANOMALY] 換手率極度異常 (Vol: $${volume}, Liq: $${liquidity}) 且 OFI 趨零，刷量特徵明顯！`);
                    }
                }

                return { success: true, indexed: true, liquidity, volume, ofiStatus, isOFIOk };
            }
        } catch (error) {
            console.warn(`⚠️ [API WARNING] 獲取 ${mintAddress} 失敗. 嘗試 ${attempt + 1}/${delays.length}`);
        }
        console.log(`⏳ [BACKOFF] 等待 ${delays[attempt]}ms 讓 Indexer 建立流動性池資料庫...`);
        await sleep(delays[attempt]);
    }
    return { success: false, indexed: false };
}

// ========================================================
// 🚀 Helius Radar Webhook (解決 100ms 404 問題的雷達入口)
// ========================================================
app.post('/webhook/radar', async (req, res) => {
    res.status(200).send('OK'); // 防止 Helius 超時重試

    const mint = extractBase58(req.body[0] || req.body);
    if (!mint) return;

    console.log(`\n🚀 [RADAR] Helius Webhook 偵測到新幣: ${mint}`);

    const inNursery = await redis.zscore('v9_nursery_queue', mint);
    if (inNursery) return; // 防大洪水併發：已在處理隊列中

    const marketData = await fetchMarketDataWithOFI(mint);
    
    if (!marketData.success || !marketData.indexed) {
        const exists = await checkOnChainExistence(mint);
        if (exists) {
            console.log(`⚠️ [LATENCY ALERT] ${mint} 鏈上存在但 API 未同步，已加入 Nursery 緩衝池等待孵化。`);
            await redis.zadd('v9_nursery_queue', Date.now(), mint);
        } else {
            console.error(`☠️ [GHOST LAUNCH] ${mint} 查無此幣，疑似污染 Payload 或 Rug Pull 放棄發射。`);
        }
        return;
    }

    if (!marketData.isOFIOk) {
        console.error(`🚨 [OFI SHIELD] 攔截 ${mint} | OFI: ${marketData.ofiStatus} | 判定: 莊家左手交右手刷量或貔貅盤 (Wash Trading/Honeypot)`);
        return;
    }

    if (marketData.liquidity > 30000 && marketData.liquidity < 200000) {
        console.warn(`⚠️ [LIQUIDITY TRAP RISK] ${mint} 流動性 $${marketData.liquidity} 處於半鹹淡危險區間，請保持警惕。`);
    } else if (marketData.liquidity < 30000) {
        console.error(`🛑 [LIQUIDITY TOO LOW] ${mint} 流動性只有 $${marketData.liquidity}，直接丟棄。`);
        return;
    }

    console.log(`✅ [OFI PASSED] ${mint} 買賣流健康 (${marketData.ofiStatus})，發送至量化安檢...`);
    try {
        const secResult = await securityGuard.calculateQuantScore(mint, 'TRENDING');
        await routerService.routeSignal(mint, 'TRENDING', secResult);
    } catch (e) {
        console.error(`❌ [Radar Route] 評估失敗:`, e.message);
    }
});

// ========================================================
// 🚨 Telegram 0 延遲恐慌按鈕 Webhook (V9.2 裝甲化)
// ========================================================
app.post('/webhook/telegram', async (req, res) => {
    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    if (process.env.TELEGRAM_SECRET_TOKEN && secretToken !== process.env.TELEGRAM_SECRET_TOKEN) {
        console.warn(`🛡️ [Webhook] 攔截到未經授權的 POST 請求！(Secret 錯誤)`);
        return res.status(403).send('Forbidden');
    }

    res.status(200).send('OK'); 
    try {
        if (req.body && req.body.callback_query) {
            const query = req.body.callback_query;
            const actionData = query.data;
            const userName = query.from?.first_name || 'Boss';
            
            console.log(`📥 [Telegram Webhook] 收到 ${userName} 的 0 延遲指令: ${actionData}`);

            if (actionData === 'UPDATE_CACHE_LOCALLY') {
                await cacheManager.refreshFromDB();
                sendAdminAlert(`⚡ <b>參數熱更新完成</b>\n操作者: ${userName}\nRAM 已同步最新 DB 戰略！`);
                return;
            }

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
// 🎯 核心風控：0 延遲監控與 LP 拔線邏輯 (V9.2 Redis 防護版)
// ========================================================
async function handleZeroLatencyCheck(mint, currentPriceSol, currentLiquidityUsd, portfolio) {
    if (!currentPriceSol || currentPriceSol <= 0) return;
    
    const pos = portfolio.positions.find(p => p.mint_address === mint);
    if (!pos) {
        redis.del(`radar_state:${mint}`);
        redis.del(`radar_history:${mint}`);
        return; 
    }

    const now = Date.now();
    const stateKey = `radar_state:${mint}`;
    const historyKey = `radar_history:${mint}`;

    let radarState = await redis.hgetall(stateKey);
    if (!radarState || Object.keys(radarState).length === 0) {
        radarState = { maxLiquidity: currentLiquidityUsd || 0, halfSellTriggered: 'false' };
        await redis.hset(stateKey, radarState);
        await redis.expire(stateKey, 86400); 
        await redis.expire(historyKey, 86400);
    }

    let maxLiquidity = parseFloat(radarState.maxLiquidity) || 0;
    if (currentLiquidityUsd && currentLiquidityUsd > maxLiquidity) {
        maxLiquidity = currentLiquidityUsd;
        await redis.hset(stateKey, 'maxLiquidity', maxLiquidity.toString());
    }

    await redis.lpush(historyKey, `${now}:${currentPriceSol}`);
    await redis.ltrim(historyKey, 0, 30); 

    const history = await redis.lrange(historyKey, 0, 30);
    let maxPriceLast60s = currentPriceSol;
    for (const item of history) {
        const [timeStr, priceStr] = item.split(':');
        if (now - parseInt(timeStr) <= 60000) {
            maxPriceLast60s = Math.max(maxPriceLast60s, parseFloat(priceStr));
        }
    }
    const dropFrom1MinHigh = ((currentPriceSol - maxPriceLast60s) / maxPriceLast60s) * 100;

    const pnlPct = ((currentPriceSol - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const isHalfSold = pos.strategy_type?.includes('HALF_SOLD') || radarState.halfSellTriggered === 'true';
    const isTrending = pos.strategy_type?.includes('TRENDING');

    const cache = cacheManager.getConfig(isTrending ? 'TRENDING' : 'MEME');
    
    const timeStopMins = cache.time_stop_mins || (isTrending ? 90 : 30);
    const timeStopTarget = cache.time_stop_target_pct || (isTrending ? 5.0 : 15.0);
    const stopLossLimit = cache.stop_loss_pct || (isTrending ? -20.0 : -25.0);
    
    const trailingTpTrigger = cache.trailing_tp_trigger || 50.0; 
    const trailingPullback = cache.trailing_pullback || (isTrending ? 10.0 : 20.0);
    
    const tpLevel1 = cache.tp_level_1_pct || (isTrending ? 30.0 : 50.0);
    const tpLevel2 = cache.tp_level_2_pct || 100.0;

    let action = 'HOLD';
    let reason = '';
    let sellFraction = 1.0;

    // 🚨 優先級 0：防騙濾鏡 (AMM 報價崩潰 / Rug Pull 瞬間暴漲偵測)
    // 正常 100 倍金狗是慢慢升的。如果 2 秒內報價突然跨越式狂飆超過前高 5 倍，且帳面利潤 > 500%，絕對是莊家抽池！
    const previousHigh = pos.highest_price_sol || pos.entry_price_sol;
    if ((currentPriceSol / previousHigh) > 5 && pnlPct > 500) {
        action = 'SELL';
        sellFraction = 1.0;
        reason = `☠️ 慘遭 Rug Pull (流動性歸零導致報價幻象)，強制撇帳`;
    }

    // 🚨 優先級 1：Rug Pull 拔線 (LP 抽走 40%)
    if (action === 'HOLD' && currentLiquidityUsd && maxLiquidity > 5000) { 
        if (currentLiquidityUsd < maxLiquidity * 0.60) {
            action = 'SELL';
            sellFraction = 1.0;
            reason = `🛑 RUG PULL 拔線：流動性由 $${maxLiquidity.toFixed(0)} 暴跌至 $${currentLiquidityUsd.toFixed(0)} (流失 > 40%)`;
        }
    }

    // 🎯 優先級 2：分批與終極止盈
    if (action === 'HOLD') {
        if (!isHalfSold && pnlPct >= tpLevel1) {
            action = 'SELL';
            sellFraction = 0.5; 
            await redis.hset(stateKey, 'halfSellTriggered', 'true');
            reason = `🎯 分批落袋：PnL 達 +${pnlPct.toFixed(0)}% (目標: ${tpLevel1}%)，回收 50% 倉位`;
        } else if (isHalfSold && pnlPct >= tpLevel2) {
            action = 'SELL';
            sellFraction = 1.0; 
            reason = `🎯 終極止盈：PnL 達標 +${pnlPct.toFixed(0)}% (目標: ${tpLevel2}%)，全數平倉落袋！`;
        }
    }

    // 🚨 優先級 3：1 分鐘極速瀑布防線
    if (action === 'HOLD' && dropFrom1MinHigh <= -15) {
        action = 'SELL'; 
        reason = `🚨 觸發瀑布防線：1 分鐘內極速插水 ${dropFrom1MinHigh.toFixed(2)}%`;
    }

    // ⏱️ 優先級 4：動態 Time-Stop 時間止損
    if (action === 'HOLD' && pos.created_at) {
        const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
        if (ageMins >= timeStopMins && pnlPct < timeStopTarget) {
            action = 'SELL';
            reason = `⏱️ Time-Stop 觸發: 持倉達 ${timeStopMins} 分鐘但利潤未達 +${timeStopTarget}%，強制離場。`;
        }
    }

    // 📉 優先級 5：動態硬止損與獲利回撤保護
    if (action === 'HOLD') {
        const highestPnlPct = (((pos.highest_price_sol || pos.entry_price_sol) - pos.entry_price_sol) / pos.entry_price_sol) * 100;
        
        if (pnlPct <= stopLossLimit) {
            action = 'SELL';
            reason = `💥 硬止損觸發: ${pnlPct.toFixed(1)}% 跌穿 ${stopLossLimit}%`;
        }
        else if (highestPnlPct >= trailingTpTrigger && (highestPnlPct - pnlPct) >= trailingPullback) {
            action = 'SELL';
            reason = `💰 獲利回撤保護: 高位 +${highestPnlPct.toFixed(0)}% 回落 ${trailingPullback} 點`;
        }
    }

    // ⚡ 執行區：鎖衝突優化
    if (action === 'SELL') {
        const lockKey = `sell_lock:${mint}`;
        const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 30, 'NX');
        if (!acquired) return; 

        try {
            console.log(`🎬 [ACTION] ${reason}`);
            await runSellPipeline(pos, currentPriceSol, reason, sellFraction);
            
            if (sellFraction === 0.5 && typeof sendTelegramAlert === 'function') {
                sendTelegramAlert(`🎯 <b>分批落袋為安！</b>\n🪙 代幣: $${pos.token_symbol}\n🔥 利潤達標，已配合 Decimals 精準賣出 50% 倉位！`);
            }
        } finally {
            await redis.del(lockKey); 
        }
    } else {
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
// 🧹 獨立主動清道夫 (Active Death Sweeper)
// ========================================================
function startActiveSweeper() {
    console.log('🧹 [Sweeper] 主動清道夫已上線，具備實時查價防誤殺機制。');
    
    setInterval(async () => {
        if (!globalSysConfig.is_running) return;
        
        const portfolio = getPortfolio();
        const now = Date.now();

        for (const pos of portfolio.positions) {
            if (!pos.created_at) continue;
            
            const ageMins = (now - new Date(pos.created_at).getTime()) / 60000;
            const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
            const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
            
            const isHalfSold = pos.strategy_type?.includes('HALF_SOLD');
            const isTrending = pos.strategy_type?.includes('TRENDING');

            const posCache = cacheManager.getConfig(isTrending ? 'TRENDING' : 'MEME');
            const timeStopMins = posCache.time_stop_mins || (isTrending ? 90 : 30);
            const timeStopTarget = posCache.time_stop_target_pct || (isTrending ? 5.0 : 15.0);
            const zombieMins = timeStopMins * 4; 

            let shouldSell = false;
            let reason = '';

            if (ageMins >= timeStopMins && pnlPct < timeStopTarget) {
                shouldSell = true;
                reason = `🧹 [主動清道夫] ${isTrending ? 'Top 100 熱門幣' : 'Meme'} 滯留過久 (${ageMins.toFixed(0)} 分鐘未達 +${timeStopTarget}%)，無差別清倉！`;
            }

            if (!shouldSell && !isTrending && ageMins >= zombieMins && !isHalfSold) {
                shouldSell = true;
                reason = `🧟 [主動清道夫] Meme 殭屍幣超時 (${ageMins.toFixed(0)} 分鐘未翻本)，強制火化拔線！`;
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
    }, 60000); 
}

// ========================================================
// 🌐 啟動大本營監控迴圈
// ========================================================
function startPositionMonitor() {
    console.log('👁️ [Monitor] V9.2 終極風控啟動：主動清道夫、LP 拔線、分批止盈、手動斬倉、OFI 防護與滿倉節流全數就位。');
    
    setInterval(async () => {
        try { 
            cachedSolPriceUsd = (await require('./priceService').getSolPriceInHKD()) / 7.8; 
            const { data } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
            if (data) globalSysConfig.is_running = data.is_running;
        } catch(e) {}
    }, 10000);

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
                try {
                    const radarKeys = await redis.keys('radar_*:*');
                    if (radarKeys.length > 0) await redis.del(radarKeys);
                    const lockKeys = await redis.keys('sell_lock:*');
                    if (lockKeys.length > 0) await redis.del(lockKeys);
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
    
    redisSub.on('message', async (channel, message) => {
        const portfolio = getPortfolio();
        
        if (channel === 'price_updates') {
            try {
                if (!globalSysConfig.is_running) return; 
                
                const pricesMap = JSON.parse(message);
                
                for (const [mint, priceSol] of Object.entries(pricesMap)) {
                    const currentPriceSol = parseFloat(priceSol);
                    if (isNaN(currentPriceSol)) continue;

                    const pos = portfolio.positions.find(p => p.mint_address === mint);
                    if (pos) {
                        pos.current_price_sol = currentPriceSol;
                    }
                    
                    await handleZeroLatencyCheck(mint, currentPriceSol, 0, portfolio);
                }
            } catch (err) {
                console.error("❌ 處理 price_updates 發生錯誤:", err.message);
            }
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

                console.log(`\n🐟 [Nursery] 倉位充足，捕獲 ${ripeTokens.length} 隻新幣已養足 5 分鐘，進行 OFI 二次安檢...`);

                const evalPromises = ripeTokens.map(async (mint) => {
                    try {
                        // 🛡️ OFI 二次防線：阻擋潛伏期 Wash Trading
                        const marketData = await fetchMarketDataWithOFI(mint);
                        if (marketData.success && !marketData.isOFIOk) {
                            console.error(`🚨 [NURSERY OFI SHIELD] 攔截 ${mint} | 判定: 潛伏期造假盤`);
                            return; 
                        }

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
        console.log('🔄 [System] 啟動 V9.2 獨立 Webhook 伺服器與風控中心 (OFI Shield Active)...');
        startPositionMonitor();
        startActiveSweeper(); 
    });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

module.exports = { startMarketMonitor };