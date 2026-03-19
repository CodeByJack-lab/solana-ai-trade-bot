const express = require('express');
const { supabase } = require('../config/supabase'); 
const axios = require('axios'); 
const { getPortfolio } = require('./portfolioService'); 
const { analyzeToken, reviewActivePosition } = require('./aiService'); 
const { executeBuy, executeSell, executeSellRaydium, forceWriteOff } = require('./tradeService');
const { getSolPriceInHKD } = require('./priceService');
const { securityGuard } = require('./securityGuard');

const app = express();

// ==========================================
// 🛡️ [網絡防護] 升級版 Express JSON 解析器
// ==========================================
app.use(express.json({ limit: '50mb' }));

app.use((err, req, res, next) => {
    if (err.type === 'request.aborted' || err.code === 'ECONNABORTED') {
        console.warn(`⚠️ [網絡防護] Webhook 傳輸突然中斷 (對面斬纜)，已攔截並忽略此錯誤。`);
        return res.status(400).end(); 
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.warn(`⚠️ [網絡防護] 收到損壞嘅 Webhook JSON 格式，已攔截。`);
        return res.status(400).end();
    }
    next(err); 
});

const IGNORED_MINTS = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 
    "So11111111111111111111111111111111111111112"  
];

const TARGET_PROGRAMS = [
    '6EF8rrecthR5Dkzon8Nwu78hrvfCKubJ14M5uBEwF6P', // Pump.fun
    'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', // Moonshot
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DYN
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'   // Orca
];

const blacklistedMints = new Map();
const BLACKLIST_TTL = 60 * 60 * 1000; 

// 🎯 V3 升級：移除 nurseryMap, analysisQueue，改用 Database 同時控制
let isProcessingBatch = false; 

let isWebhookActive = true;       
let isAlchemyActive = false;      

// ==========================================
// 🌐 Helius Webhook 控制系統
// ==========================================
async function toggleHeliusWebhook(enable) {
    const apiKey = process.env.HELIUS_API_KEY;
    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (!apiKey || !webhookId) return;

    try {
        const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;
        await axios.patch(url, { active: enable });
        isWebhookActive = enable;
        console.log(`🌐 [Helius] 主雷達已成功 ${enable ? '啟動 🟢' : '暫停 🔴'}`);
    } catch (err) {
        console.error("⚠️ [Helius] 切換失敗:", err.response?.data || err.message);
    }
}

// ==========================================
// 🛡️ Alchemy Webhook 控制系統
// ==========================================
async function toggleAlchemyWebhook(enable) {
    const authToken = process.env.ALCHEMY_AUTH_TOKEN;
    const webhookId = process.env.ALCHEMY_WEBHOOK_ID;
    isAlchemyActive = enable;
    if (!authToken || !webhookId) return;

    try {
        const url = `https://dashboard.alchemy.com/api/update-webhook`;
        await axios.put(url, { webhook_id: webhookId, is_active: enable }, {
            headers: { 'X-Alchemy-Token': authToken, 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
        console.log(`🛡️ [Alchemy] 備援雷達已成功 ${enable ? '啟動 🟢' : '暫停 🔴'}`);
    } catch (err) {
        console.log(`⚠️ [Alchemy] API 控制無效 (Beta限制)，轉用本地軟開關 ${enable ? '🟢' : '🔴'}`);
    }
}

// ==========================================
// 📊 Helius 額度檢查器
// ==========================================
async function checkHeliusUsage() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) return 0;
    try {
        const res = await axios.get(`https://api.helius.xyz/v0/usage?api-key=${apiKey}`);
        if (res.data && res.data.limit) {
            return (res.data.current_month_usage / res.data.limit) * 100;
        }
        return 0;
    } catch (e) { return 0; }
}

async function checkWebhookWatermark(currentCount, maxCount) {
    if (!process.env.HELIUS_API_KEY || !process.env.HELIUS_WEBHOOK_ID) return;

    const heliusUsagePct = await checkHeliusUsage();
    const isHeliusExhausted = heliusUsagePct > 90;
    const isFull = currentCount >= maxCount;
    const hasSpace = currentCount <= Math.floor(maxCount * 0.7);

    if (isFull) {
        if (isWebhookActive) {
            console.log(`🛑 倉位已滿 (${currentCount}/${maxCount})，關閉所有雷達...`);
            await toggleHeliusWebhook(false);
        }
        if (isAlchemyActive) await toggleAlchemyWebhook(false);
    } 
    else if (hasSpace) {
        if (isHeliusExhausted) {
            if (isWebhookActive) await toggleHeliusWebhook(false);
            if (!isAlchemyActive) {
                console.log(`🚨 [配額警告] Helius 用量達 ${heliusUsagePct.toFixed(1)}%，啟動 Alchemy！`);
                await toggleAlchemyWebhook(true);
            }
        } else {
            if (isAlchemyActive) await toggleAlchemyWebhook(false);
            if (!isWebhookActive) {
                console.log(`🟢 倉位釋出 (${currentCount}/${maxCount})，重啟 Helius...`);
                await toggleHeliusWebhook(true);
            }
        }
    }
}

async function syncWebhookStateOnStartup() {
    const apiKey = process.env.HELIUS_API_KEY;
    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (!apiKey || !webhookId) return;

    try {
        await toggleAlchemyWebhook(false);
        const url = `https://api.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;
        const { data: config } = await axios.get(url);
        isWebhookActive = config.active === true;
        console.log(`🔄 [系統重啟] 檢測到 Helius 狀態: ${isWebhookActive ? '🟢' : '🔴'}`);

        const portfolio = getPortfolio();
        const configDb = await getDynamicConfig();
        await checkWebhookWatermark(portfolio.positions?.length || 0, configDb.max_positions || 5);
    } catch (err) {}
}

// ==========================================
// 核心輔助工具
// ==========================================
function isBlacklisted(mint) {
    if (blacklistedMints.has(mint)) {
        if (Date.now() - blacklistedMints.get(mint) > BLACKLIST_TTL) {
            blacklistedMints.delete(mint); return false;
        }
        return true; 
    }
    return false;
}

function addToBlacklist(mint, reason) {
    blacklistedMints.set(mint, Date.now());
    console.log(`⛔ [Blacklist] ${mint.substring(0,6)}... 已Block`);
}

function sanitizeAddress(addr) {
    if (!addr) return null;
    const clean = String(addr).replace(/[^A-Za-z0-9]/g, '').trim();
    return (clean.length >= 32 && clean.length <= 44) ? clean : null;
}

async function getDynamicConfig() {
    try {
        const { data } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        return {
            is_running: data?.is_running ?? false,
            trade_amount_sol: data?.trade_amount_sol ?? 0.1,
            max_positions: data?.max_positions ?? 5,
            min_age_mins: data?.min_age_mins ?? 3,
            max_age_mins: data?.max_age_mins ?? 60,
            stop_loss_pct: data?.stop_loss_pct ?? -10
        };
    } catch (err) {
        return { is_running: false, trade_amount_sol: 0.1, max_positions: 5, min_age_mins: 3, max_age_mins: 60, stop_loss_pct: -10 };
    }
}

async function getDexScreenerInfo(mintAddress, retries = 1) {
    for (let i = 0; i <= retries; i++) {
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
            const response = await axios.get(url, { timeout: 5000 });
            const pair = response.data?.pairs?.find(p => p.chainId === 'solana');
            if (pair) return { priceNative: parseFloat(pair.priceNative), symbol: pair.baseToken?.symbol || 'UNKNOWN' };
        } catch (err) {}
        if (i < retries) await new Promise(r => setTimeout(r, 2000)); 
    }
    return null;
}

async function getSafeSolPrice() {
    try { return await getSolPriceInHKD(); } catch (err) { return 1200; }
}

async function runSellPipeline(pos, currentPrice, reason, sellFraction = 1.0) {
    let sold = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        sold = await executeSell(pos.mint_address, currentPrice, reason, sellFraction);
        if (sold) return true;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
    sold = await executeSellRaydium(pos.mint_address, currentPrice, reason, sellFraction);
    if (sold) return true;
    
    // 🛡️ V3.1 修正：交由 tradeService 嘅 Death Protocol 判斷是否 Rug。
    // 如果流動性 > 500，保留持倉，等待下一個雷達 Loop (10秒後) 自動再試！
    console.warn(`⏳ [Pipeline] ${pos.token_symbol} 暫時無法平倉，保留持倉等待下一次嘗試...`);
    return false;
}

// ==========================================
// 👁️ 持倉雷達 (AI Review + 移動止盈/止損)
// ==========================================
const reviewTracking = new Map(); 

function startPositionMonitor() {
    console.log(`👁️ [Radar] 智能 AI Review + 移動止盈/止損 + 橫盤接回 已啟動...`);
    setInterval(async () => {
        try {
            const portfolio = getPortfolio();
            const config = await getDynamicConfig();
            
            await checkWebhookWatermark(portfolio.positions.length, config.max_positions);

            if (portfolio.positions.length === 0) return;
            const positionsSnapshot = [...portfolio.positions];

            for (const pos of positionsSnapshot) {
                const dsInfo = await getDexScreenerInfo(pos.mint_address, 0); 
                const currentPrice = dsInfo?.priceNative;
                if (!currentPrice) continue;
                
                if (currentPrice > pos.highest_price_sol) {
                    pos.highest_price_sol = currentPrice;
                    const table = portfolio.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
                    supabase.from(table).update({ highest_price_sol: currentPrice }).eq('mint_address', pos.mint_address).then(()=>{});
                }
                
                const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
                const drawdownPct = ((pos.highest_price_sol - currentPrice) / pos.highest_price_sol) * 100;
                const isHalfSold = (pos.strategy_type || '').includes('HALF_SOLD');
                const isAthAbove50Pct = pos.highest_price_sol >= (pos.entry_price_sol * 1.5);

                const now = Date.now();
                const track = reviewTracking.get(pos.mint_address) || { lastPrice: pos.entry_price_sol, lastTime: 0 };
                const changeSinceLastReview = ((currentPrice - track.lastPrice) / track.lastPrice) * 100;
                
                const isTimeUp = (now - track.lastTime > 30 * 60 * 1000); 
                const isBigRise = (changeSinceLastReview >= 25);         
                const isBigDrop = (changeSinceLastReview <= -10);        

                if (isTimeUp || isBigRise || isBigDrop) {
                    const triggerReason = isTimeUp ? "滿30分鐘" : (isBigRise ? "暴升25%" : "暴跌10%");
                    console.log(`🧠 [Trigger] ${pos.token_symbol || pos.mint_address.substring(0,6)} 觸發AI Review (${triggerReason})`);
                    
                    reviewTracking.set(pos.mint_address, { lastPrice: currentPrice, lastTime: now });
                    const aiReview = await reviewActivePosition(pos.mint_address, { ...pos, pnlPct });
                    
                    if (aiReview && aiReview.reason) {
                        const table = portfolio.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
                        await supabase.from(table).update({ last_review_comment: aiReview.reason }).eq('mint_address', pos.mint_address);
                    }

                    if (aiReview && aiReview.decision === 'EXIT') {
                        console.log(`🛡️ [AI 指揮] 決定撤退: ${pos.token_symbol || pos.mint_address.substring(0,6)} | 原因: ${aiReview.reason}`);
                        await runSellPipeline(pos, currentPrice, `AI 監軍撤退: ${aiReview.reason}`, 1.0);
                        continue; 
                    }
                }

                let triggerSell = false;
                let sellReason = "";
                let sellFraction = 1.0; 

                if (pnlPct >= 100 && !isHalfSold) {
                    triggerSell = true;
                    sellReason = `翻倍保本出局 (+${pnlPct.toFixed(1)}%)`;
                    sellFraction = 0.5;
                }
                else if (pnlPct <= config.stop_loss_pct && !isHalfSold) {
                    triggerSell = true;
                    sellReason = `死線硬止損 (${pnlPct.toFixed(1)}%)`;
                    sellFraction = 1.0;
                }
                else if (isAthAbove50Pct && drawdownPct >= 20 && drawdownPct < 30) {
                    const track = reviewTracking.get(pos.mint_address) || {};
                    if (!track.warned20) {
                        track.warned20 = true; 
                        reviewTracking.set(pos.mint_address, track);
                        
                        console.log(`🚨 [趨勢預警] ${pos.token_symbol || pos.mint_address.substring(0,6)} 回落 ${drawdownPct.toFixed(1)}%，呼叫 AI...`);
                        const { predictTrend } = require('./aiService');
                        if (predictTrend) {
                            const prediction = await predictTrend(pos.mint_address, { ...pos, pnlPct }, drawdownPct);
                            if (prediction && prediction.decision === 'DUMP') {
                                triggerSell = true;
                                sellReason = `AI 預測見頂 DUMP (${prediction.reason})`;
                                sellFraction = 1.0;
                            }
                        }
                    }
                }
                else if (isAthAbove50Pct && drawdownPct >= 30) { 
                    triggerSell = true;
                    sellReason = `高位回撤達 30% (鐵血全清鎖盈)`;
                    sellFraction = 1.0;
                }

                if (triggerSell) {
                    const isSold = await runSellPipeline(pos, currentPrice, sellReason, sellFraction);
                    if (isSold && sellFraction === 1.0) {
                        await supabase.from('reentry_watchlist').upsert({
                            mint_address: pos.mint_address,
                            token_symbol: pos.token_symbol || pos.mint_address.substring(0,6),
                            sold_price_sol: currentPrice,
                            baseline_price_sol: currentPrice,
                            consolidation_start_time: new Date().toISOString()
                        }, { onConflict: 'mint_address' });
                    }
                }
            }
        } catch (err) {}
    }, 5000); 
}

function startCommandListener() {
    supabase.channel('command_listener').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'command_queue' }, async (payload) => {
        const cmd = payload.new;
        try {
            const portfolio = getPortfolio();
            if (cmd.command_type === 'SELL_SINGLE' && cmd.mint_address) {
                const pos = portfolio.positions.find(p => p.mint_address === cmd.mint_address);
                if (pos) {
                    const dsInfo = await getDexScreenerInfo(cmd.mint_address, 0);
                    await runSellPipeline(pos, dsInfo?.priceNative || 0, "手動斬倉", 1.0);
                }
            } else if (cmd.command_type === 'SELL_ALL') {
                for (const pos of [...portfolio.positions]) {
                    const dsInfo = await getDexScreenerInfo(pos.mint_address, 0);
                    await runSellPipeline(pos, dsInfo?.priceNative || 0, "核彈平倉", 1.0);
                }
            }
            await supabase.from('command_queue').delete().eq('id', cmd.id);
        } catch (err) {}
    }).subscribe();
}

// ==========================================
// 🚨 V3 升級：五發左輪 - 自動撈魚排程
// ==========================================
function startDatabaseNurseryMonitor() {
    console.log(`🐟 [Nursery Radar] 五發左輪排程已啟動 (每 10 秒撈魚)...`);
    
    setInterval(async () => {
        if (isProcessingBatch) return; 
        
        const config = await getDynamicConfig();
        if (!config.is_running) return;
        
        const portfolio = getPortfolio();
        if (portfolio.positions.length >= config.max_positions) return; 

        isProcessingBatch = true;
        try {
            // 計算閾值時間 (例如：3 分鐘前)
            const thresholdTime = new Date(Date.now() - config.min_age_mins * 60 * 1000).toISOString();
            const deadTime = new Date(Date.now() - config.max_age_mins * 60 * 1000).toISOString();

            // 1. 清理過期死魚 (大過 max_age_mins)
            await supabase.from('nursery_pool').delete().lte('created_at', deadTime);

            // 2. 撈出 5 隻成熟代幣 (FIFO)
            const { data: matureTokens } = await supabase
                .from('nursery_pool')
                .select('mint_address')
                .lte('created_at', thresholdTime)
                .order('created_at', { ascending: true })
                .limit(5);

            if (!matureTokens || matureTokens.length === 0) {
                isProcessingBatch = false;
                return; 
            }

            const mintsToProcess = matureTokens.map(t => t.mint_address);

            // 3. Pop 機制：立即喺 DB 剷走，防重複
            await supabase.from('nursery_pool').delete().in('mint_address', mintsToProcess);
            
            console.log(`🎣 [Nursery] 成功撈出 ${mintsToProcess.length} 隻成熟代幣，開始 AI 審查...`);

            // 4. 逐隻審查 (五發左輪)
            for (const mint of mintsToProcess) {
                if (portfolio.positions.length >= config.max_positions) break;
                if (portfolio.positions.some(p => p.mint_address === mint)) continue;
                if (isBlacklisted(mint)) continue;

                try {
                    const dsInfo = await getDexScreenerInfo(mint, 1);
                    if (!dsInfo) continue;
                    
                    const safety = await securityGuard.checkTokenSafety(mint);
                    if (!safety.isSafe) { addToBlacklist(mint, "合約危險"); continue; }
                    
                    const aiDecision = await analyzeToken(mint, { strategy_type: 'HUNTER' });
                    if (aiDecision?.decision === 'BUY') {
                        await executeBuy(mint, dsInfo.symbol, 'HUNTER', aiDecision.score, aiDecision.reason, await getSafeSolPrice(), config.trade_amount_sol);
                    } else { 
                        addToBlacklist(mint, "AI 拒絕"); 
                    }
                } catch (err) {}
            }
        } catch (err) {
            console.error(`❌ [Nursery Error] 撈魚排程出錯:`, err.message);
        } finally {
            isProcessingBatch = false;
        }
    }, 10000); 
}

// ==========================================
// 📡 原版 Helius Webhook 接收端 (V3 極限閘門版)
// ==========================================
app.post('/webhook/helius', async (req, res) => {
    res.sendStatus(200); 
    try {
        const config = await getDynamicConfig();
        if (!config.is_running) return;

        // 🛡️ V3 極限閘門：查 COUNT
        const { count } = await supabase.from('nursery_pool').select('*', { count: 'exact', head: true });
        if (count >= 50) {
            return; // 魚池爆滿，直接 Drop 訊號
        }

        const portfolio = getPortfolio();
        const activeMints = portfolio.positions.map(p => p.mint_address);
        let incomingMints = new Set();

        if (Array.isArray(req.body)) {
            req.body.forEach(ev => {
                const isTargetDex = ev.instructions?.some(ix => TARGET_PROGRAMS.includes(ix.programId));
                if (isTargetDex && ev.tokenTransfers) {
                    ev.tokenTransfers.forEach(tf => {
                        const tMint = sanitizeAddress(tf.mint);
                        if (tMint && !IGNORED_MINTS.includes(tMint) && !isBlacklisted(tMint) && !activeMints.includes(tMint)) {
                            incomingMints.add(tMint);
                        }
                    });
                }
            });
        }

        if (incomingMints.size > 0) {
            const inserts = Array.from(incomingMints).map(mint => ({ mint_address: mint }));
            await supabase.from('nursery_pool').upsert(inserts, { onConflict: 'mint_address' });
            console.log(`🐟 [Helius Radar] 成功將 ${inserts.length} 隻新幣放入魚池。`);
        }
    } catch (err) {}
});

// ==========================================
// 🛡️ Alchemy Custom Webhook 接收端 (V3 極限閘門版)
// ==========================================
app.post('/webhook/alchemy', async (req, res) => {
    res.sendStatus(200); 
    if (!isAlchemyActive) return; 

    try {
        const config = await getDynamicConfig();
        if (!config.is_running) return;

        // 🛡️ V3 極限閘門
        const { count } = await supabase.from('nursery_pool').select('*', { count: 'exact', head: true });
        if (count >= 50) return;

        const portfolio = getPortfolio();
        const activeMints = portfolio.positions.map(p => p.mint_address);
        let incomingMints = new Set(); 

        const transactions = req.body.event?.data?.block?.transactions || [];

        transactions.forEach(tx => {
            const isTargetDex = tx.accountKeys?.some(key => TARGET_PROGRAMS.includes(key));
            if (isTargetDex && tx.tokenTransfers) {
                tx.tokenTransfers.forEach(tf => {
                    const tMint = sanitizeAddress(tf.mint);
                    if (tMint && !IGNORED_MINTS.includes(tMint) && !isBlacklisted(tMint) && !activeMints.includes(tMint)) {
                        incomingMints.add(tMint);
                    }
                });
            }
        });

        if (incomingMints.size > 0) {
            const inserts = Array.from(incomingMints).map(mint => ({ mint_address: mint }));
            await supabase.from('nursery_pool').upsert(inserts, { onConflict: 'mint_address' });
            console.log(`🐟 [Alchemy Radar] 成功將 ${inserts.length} 隻新幣放入魚池。`);
        }
    } catch (err) {}
});

function startWatchlistMonitor() {
    console.log(`📋 [Watchlist Radar] 橫盤吸籌監控已啟動 (每 10 分鐘巡邏)...`);
    const { analyzeReentry } = require('./aiService');
    
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;

            for (const token of watchlist) {
                const dsInfo = await getDexScreenerInfo(token.mint_address, 0);
                const currentPrice = dsInfo?.priceNative;
                if (!currentPrice) continue;

                const baseline = token.baseline_price_sol;
                const priceDiffPct = Math.abs((currentPrice - baseline) / baseline) * 100;

                if (priceDiffPct <= 20) {
                    const startTime = new Date(token.consolidation_start_time).getTime();
                    const consolidationMins = (Date.now() - startTime) / 60000;

                    if (consolidationMins >= 30) {
                        if (analyzeReentry) {
                            const aiReview = await analyzeReentry(token.mint_address, token.token_symbol, currentPrice);
                            if (aiReview && aiReview.decision === 'BUY') {
                                const config = await getDynamicConfig();
                                await executeBuy(token.mint_address, token.token_symbol, 'REENTRY', aiReview.score || 10, aiReview.reason, await getSafeSolPrice(), config.trade_amount_sol);
                            } 
                        }
                        await supabase.from('reentry_watchlist').delete().eq('mint_address', token.mint_address);
                    }
                } else {
                    await supabase.from('reentry_watchlist').update({
                        baseline_price_sol: currentPrice,
                        consolidation_start_time: new Date().toISOString()
                    }).eq('mint_address', token.mint_address);
                }
            }
        } catch (err) {}
    }, 10 * 60 * 1000); 
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        await syncWebhookStateOnStartup();
        startPositionMonitor(); 
        startDatabaseNurseryMonitor(); // 👈 V3 升級：啟用資料庫五發左輪撈魚
        startCommandListener();
        startWatchlistMonitor(); 
    });
}

module.exports = { startMarketMonitor };