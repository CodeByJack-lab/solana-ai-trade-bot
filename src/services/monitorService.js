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
// 1. 放大接收容量到 50MB，應付 Helius 巨型 Payload
app.use(express.json({ limit: '50mb' }));

// 2. 全局錯誤攔截器 (防止 Webhook 傳輸斷線導致 Bot Crash)
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

// 🎯 【原汁原味保留】全網無死角監控
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
const nurseryMap = new Map();
const processingMints = new Set(); 
const reviewTracking = new Map(); 

// 🚀 Webhook 狀態追蹤
let isWebhookActive = true;       // Helius 主雷達狀態
let isAlchemyActive = false;      // Alchemy 備援雷達狀態 (預設 OFF)

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
        console.log(`🌐 [Helius] 主雷達已成功 ${enable ? '啟動 🟢 (接收新盤中)' : '暫停 🔴 (停止接收)'}`);
    } catch (err) {
        console.error("⚠️ [Helius] Webhook 切換失敗:", err.response?.data || err.message);
    }
}

// ==========================================
// 🛡️ Alchemy Webhook 控制系統 (API Call + 軟開關)
// ==========================================
async function toggleAlchemyWebhook(enable) {
    const authToken = process.env.ALCHEMY_AUTH_TOKEN;
    const webhookId = process.env.ALCHEMY_WEBHOOK_ID;
    
    // 程式內部軟開關 (最硬淨嘅防線：就算 API 失敗，Bot 都唔會處理)
    isAlchemyActive = enable;

    if (!authToken || !webhookId) return;

    try {
        // 使用 Alchemy 官方標準 Update API
        const url = `https://dashboard.alchemy.com/api/update-webhook`;
        await axios.put(url, { 
            webhook_id: webhookId,
            is_active: enable 
        }, {
            headers: {
                'X-Alchemy-Token': authToken,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log(`🛡️ [Alchemy] 備援雷達已成功 ${enable ? '啟動 🟢' : '暫停 🔴'} (API 切換成功)`);
    } catch (err) {
        // 如果 Beta 限制唔畀 API 控制，我哋依然有 isAlchemyActive 軟開關頂住
        console.log(`⚠️ [Alchemy] API 控制無效 (Beta限制)，已轉用本地軟開關 ${enable ? '🟢' : '🔴'}`);
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
            const usagePct = (res.data.current_month_usage / res.data.limit) * 100;
            return usagePct;
        }
        return 0;
    } catch (e) {
        return 0; // 如果查唔到就當安全，避免亂切換
    }
}

// ==========================================
// ⚖️ 雙核水位線與配額管理 (優化版)
// ==========================================
async function checkWebhookWatermark(currentCount, maxCount) {
    if (!process.env.HELIUS_API_KEY || !process.env.HELIUS_WEBHOOK_ID) return;

    // 1. 檢查 Helius 係咪準備爆額 (>90%)
    const heliusUsagePct = await checkHeliusUsage();
    const isHeliusExhausted = heliusUsagePct > 90;

    const isFull = currentCount >= maxCount;
    const hasSpace = currentCount <= Math.floor(maxCount * 0.7);

    // 2. 滿倉：強制閂晒所有雷達
    if (isFull) {
        if (isWebhookActive) {
            console.log(`🛑 倉位已達上限 (${currentCount}/${maxCount})，自動關閉所有雷達節省 Credit...`);
            await toggleHeliusWebhook(false);
        }
        if (isAlchemyActive) {
            await toggleAlchemyWebhook(false);
        }
    } 
    // 3. 有位：決定開邊部雷達
    else if (hasSpace) {
        if (isHeliusExhausted) {
            // Helius 就快爆，熄 Helius，開 Alchemy
            if (isWebhookActive) await toggleHeliusWebhook(false);
            if (!isAlchemyActive) {
                console.log(`🚨 [配額警告] Helius 用量達 ${heliusUsagePct.toFixed(1)}%，啟動 Alchemy 備援機制！`);
                await toggleAlchemyWebhook(true);
            }
        } else {
            // Helius 仲有錢，熄 Alchemy，開 Helius
            if (isAlchemyActive) await toggleAlchemyWebhook(false);
            if (!isWebhookActive) {
                console.log(`🟢 倉位已釋出 30%+ 空間 (${currentCount}/${maxCount})，重啟 Helius 主雷達...`);
                await toggleHeliusWebhook(true);
            }
        }
    }
}

async function syncWebhookStateOnStartup() {
    const apiKey = process.env.HELIUS_API_KEY;
    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    
    if (!apiKey || !webhookId) {
        console.log("⚠️ 未設定 HELIUS_API_KEY 或 HELIUS_WEBHOOK_ID，自動開關 Webhook 功能已停用。");
        return;
    }

    try {
        // 開機一律確保 Alchemy 先熄，以防走火
        await toggleAlchemyWebhook(false);

        const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;
        const { data: config } = await axios.get(url);

        const currentlyEnabled = config.active === true;
        isWebhookActive = currentlyEnabled;

        console.log(`🔄 [系統重啟] 檢測到 Helius Webhook 目前狀態: ${currentlyEnabled ? '🟢 啟動中' : '🔴 暫停中'}`);

        const portfolio = getPortfolio();
        const configDb = await getDynamicConfig();
        const currentCount = portfolio.positions?.length || 0;
        const maxCount = configDb.max_positions || 5;

        console.log(`🔄 [系統重啟] 正在檢查倉位水位線: ${currentCount} / ${maxCount}`);

        // 使用新版雙核檢查機制
        await checkWebhookWatermark(currentCount, maxCount);
        
    } catch (err) {
        console.error("⚠️ [系統重啟] 無法同步 Webhook 狀態:", err.response?.data || err.message);
    }
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

const MAX_CONCURRENT = 3;             
const MAX_QUEUE_SIZE = 15;            
let analysisQueue = [];
let isProcessingQueue = false;

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
    
    if (sellFraction === 1.0) await forceWriteOff(pos.mint_address, "無法平倉 (可能 Rug)");
    return false;
}

// ==========================================
// 👁️ 持倉雷達 (包含水位線檢查與智能預警)
// ==========================================
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
                    const table = portfolio.mode === 'LIVE' ? 'live' : 'paper';
                    supabase.from(`active_positions_${table}`).update({ highest_price_sol: currentPrice }).eq('mint_address', pos.mint_address).then(()=>{});
                }
                
                const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
                const drawdownPct = ((pos.highest_price_sol - currentPrice) / pos.highest_price_sol) * 100;
                const isHalfSold = (pos.strategy_type || '').includes('HALF_SOLD');

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
                        await supabase.from(table)
                            .update({ last_review_comment: aiReview.reason })
                            .eq('mint_address', pos.mint_address);
                    }

                    if (aiReview && aiReview.decision === 'EXIT') {
                        console.log(`🛡️ [AI 指揮] 決定撤退: ${pos.token_symbol || pos.mint_address.substring(0,6)} | 原因: ${aiReview.reason}`);
                        await runSellPipeline(pos, currentPrice, `AI 監軍撤退: ${aiReview.reason}`, 1.0);
                        continue; 
                    }
                }

                // =====================================
                // 觸發賣出邏輯 (Meme 幣黃金移動止盈版)
                // =====================================
                let triggerSell = false;
                let sellReason = "";
                let sellFraction = 1.0; 

                // 1. 翻倍保本
                if (pnlPct >= 100 && !isHalfSold) {
                    triggerSell = true;
                    sellReason = `翻倍保本出局 (+${pnlPct.toFixed(1)}%)`;
                    sellFraction = 0.5;
                }
                // 2. 破底硬止損
                else if (pnlPct <= config.stop_loss_pct && !isHalfSold) {
                    triggerSell = true;
                    sellReason = `死線硬止損 (${pnlPct.toFixed(1)}%)`;
                    sellFraction = 1.0;
                }
                // 3. 高位回落 20% 智能預警
                else if (drawdownPct >= 20 && drawdownPct < 30) {
                    const track = reviewTracking.get(pos.mint_address) || {};
                    if (!track.warned20) {
                        track.warned20 = true; 
                        reviewTracking.set(pos.mint_address, track);
                        
                        console.log(`🚨 [趨勢預警] ${pos.token_symbol || pos.mint_address.substring(0,6)} 從高位回落 ${drawdownPct.toFixed(1)}%，呼叫 AI 判斷是否見頂...`);
                        const { predictTrend } = require('./aiService');
                        if (predictTrend) {
                            const prediction = await predictTrend(pos.mint_address, { ...pos, pnlPct }, drawdownPct);
                            if (prediction && prediction.decision === 'DUMP') {
                                triggerSell = true;
                                sellReason = `高位回落 ${drawdownPct.toFixed(1)}%，AI 判斷見頂 DUMP (${prediction.reason})`;
                                sellFraction = 1.0;
                            } else {
                                console.log(`🛡️ [AI 判斷] ${pos.token_symbol || pos.mint_address.substring(0,6)} 只是健康洗盤 (WASH)，繼續持有博取新高。`);
                            }
                        } else {
                            console.warn(`⚠️ [系統] 未找到 predictTrend 函數，跳過 AI 趨勢預警判斷。`);
                        }
                    }
                }
                // 4. 終極回落 30% 鐵血止盈/止損
                else if (drawdownPct >= 30) { 
                    triggerSell = true;
                    sellReason = `高位回撤達 30% 警戒線 (鐵血全清鎖盈)`;
                    sellFraction = 1.0;
                }

                if (triggerSell) {
                    const isSold = await runSellPipeline(pos, currentPrice, sellReason, sellFraction);
                    
                    // 如果全倉賣出成功，加入橫盤觀察名單等待接回
                    if (isSold && sellFraction === 1.0) {
                        console.log(`📋 [Watchlist] 將 ${pos.token_symbol || pos.mint_address.substring(0,6)} 加入橫盤觀察名單，等待洗盤結束後接回...`);
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

function startNurseryMonitor() {
    setInterval(async () => {
        if (nurseryMap.size === 0) return;
        const config = await getDynamicConfig();
        if (!config.is_running) return;
        const now = Date.now();
        for (const [mint, detectedAt] of nurseryMap.entries()) {
            const ageMins = (now - detectedAt) / 60000;
            if (ageMins >= config.min_age_mins) {
                nurseryMap.delete(mint);
                if (analysisQueue.length < MAX_QUEUE_SIZE) {
                    analysisQueue.push({ mint, strategy: 'HUNTER' });
                    if (!isProcessingQueue) processQueue();
                }
            } else if (ageMins > config.max_age_mins) { nurseryMap.delete(mint); }
        }
    }, 10000); 
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    try {
        while (analysisQueue.length > 0) {
            const config = await getDynamicConfig();
            if (!config.is_running) { analysisQueue = []; break; }
            
            const portfolio = getPortfolio();
            if (portfolio.positions.length >= config.max_positions) { analysisQueue = []; break; }
            
            const batch = analysisQueue.splice(0, MAX_CONCURRENT);
            
            for (const task of batch) {
                const { mint, strategy } = task;
                const currentPortfolio = getPortfolio();
                if (currentPortfolio.positions.length >= config.max_positions) break;
                if (currentPortfolio.positions.some(p => p.mint_address === mint)) continue;

                try {
                    const dsInfo = await getDexScreenerInfo(mint, 1);
                    if (!dsInfo) continue;
                    
                    const safety = await securityGuard.checkTokenSafety(mint);
                    if (!safety.isSafe) { addToBlacklist(mint, "合約危險"); continue; }
                    
                    const aiDecision = await analyzeToken(mint, { strategy_type: strategy });
                    if (aiDecision?.decision === 'BUY') {
                        await executeBuy(mint, dsInfo.symbol, strategy, aiDecision.score, aiDecision.reason, await getSafeSolPrice(), config.trade_amount_sol);
                    } else { addToBlacklist(mint, "AI 拒絕"); }
                } catch (err) {}
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } finally { isProcessingQueue = false; }
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
// 📡 原版 Helius Webhook 接收端
// ==========================================
app.post('/webhook/helius', async (req, res) => {
    res.sendStatus(200); 
    try {
        const config = await getDynamicConfig();
        if (!config.is_running) return;

        const portfolio = getPortfolio();
        const activeMints = portfolio.positions.map(p => p.mint_address);
        
        let incomingMints = new Map(); 

        if (Array.isArray(req.body)) {
            req.body.forEach(ev => {
                let detectedProgram = "UNKNOWN";
                
                const isTargetDex = ev.instructions?.some(ix => {
                    if (TARGET_PROGRAMS.includes(ix.programId)) {
                        detectedProgram = ix.programId;
                        return true;
                    }
                    return false;
                });

                if (isTargetDex && ev.tokenTransfers) {
                    ev.tokenTransfers.forEach(tf => {
                        const tMint = sanitizeAddress(tf.mint);
                        const isQueueing = analysisQueue.some(q => q.mint === tMint);
                        
                        if (
                            tMint && 
                            !IGNORED_MINTS.includes(tMint) && 
                            !isBlacklisted(tMint) && 
                            !nurseryMap.has(tMint) &&
                            !activeMints.includes(tMint) && 
                            !isQueueing &&
                            !processingMints.has(tMint) 
                        ) {
                            incomingMints.set(tMint, detectedProgram); 
                        }
                    });
                }
            });
        }

        incomingMints.forEach((programId, mint) => {
            if (nurseryMap.size >= 10) return;
            processingMints.add(mint); 
            
            let sourceName = "UNKNOWN";
            if (programId === '6EF8rrecthR5Dkzon8Nwu78hrvfCKubJ14M5uBEwF6P') sourceName = "Pump.fun (Helius)";
            else if (programId === 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG') sourceName = "Moonshot (Helius)";
            else if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') sourceName = "Raydium V4 (Helius)";
            else if (programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C') sourceName = "Raydium CPMM (Helius)";
            else if (programId === 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc') sourceName = "Orca (Helius)";

            console.log(`🐟 [Helius Radar] 發現新幣 ${mint.substring(0,6)}... | 來源: ${sourceName}`);
            
            nurseryMap.set(mint, Date.now());
            setTimeout(() => processingMints.delete(mint), 5000);
        });
    } catch (err) {}
});

// ==========================================
// 🛡️ 新增：Alchemy Custom Webhook 接收端
// ==========================================
app.post('/webhook/alchemy', async (req, res) => {
    res.sendStatus(200); 

    if (!isAlchemyActive) return; 

    try {
        const config = await getDynamicConfig();
        if (!config.is_running) return;

        const portfolio = getPortfolio();
        const activeMints = portfolio.positions.map(p => p.mint_address);
        
        let incomingMints = new Map(); 

        const transactions = req.body.event?.data?.block?.transactions || [];

        transactions.forEach(tx => {
            let detectedProgram = "UNKNOWN";
            
            if (tx.accountKeys) {
                const matched = tx.accountKeys.find(key => TARGET_PROGRAMS.includes(key));
                if (matched) detectedProgram = matched;
            }

            if (tx.tokenTransfers) {
                tx.tokenTransfers.forEach(tf => {
                    const tMint = sanitizeAddress(tf.mint);
                    const isQueueing = analysisQueue.some(q => q.mint === tMint);
                    
                    if (
                        tMint && 
                        !IGNORED_MINTS.includes(tMint) && 
                        !isBlacklisted(tMint) && 
                        !nurseryMap.has(tMint) &&
                        !activeMints.includes(tMint) && 
                        !isQueueing &&
                        !processingMints.has(tMint) 
                    ) {
                        incomingMints.set(tMint, detectedProgram); 
                    }
                });
            }
        });

        incomingMints.forEach((programId, mint) => {
            if (nurseryMap.size >= 10) return;
            processingMints.add(mint); 
            
            let sourceName = "UNKNOWN";
            if (programId === '6EF8rrecthR5Dkzon8Nwu78hrvfCKubJ14M5uBEwF6P') sourceName = "Pump.fun (Alchemy)";
            else if (programId === 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG') sourceName = "Moonshot (Alchemy)";
            else if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') sourceName = "Raydium V4 (Alchemy)";

            console.log(`🐟 [Alchemy Radar] 發現新幣 ${mint.substring(0,6)}... | 來源: ${sourceName}`);
            
            nurseryMap.set(mint, Date.now());
            setTimeout(() => processingMints.delete(mint), 5000);
        });
    } catch (err) {
        console.error("⚠️ [Alchemy Radar] Webhook 解析出錯:", err.message);
    }
});

// ==========================================
// 📋 橫盤觀察名單巡邏員 (Meme 幣極速版)
// ==========================================
function startWatchlistMonitor() {
    console.log(`📋 [Watchlist Radar] 橫盤吸籌監控已啟動 (每 10 分鐘巡邏)...`);
    const { analyzeReentry } = require('./aiService');
    
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;

            console.log(`🔍 [Watchlist] 正在巡邏 ${watchlist.length} 隻觀察中代幣...`);

            for (const token of watchlist) {
                const dsInfo = await getDexScreenerInfo(token.mint_address, 0);
                const currentPrice = dsInfo?.priceNative;
                if (!currentPrice) continue;

                const baseline = token.baseline_price_sol;
                const priceDiffPct = Math.abs((currentPrice - baseline) / baseline) * 100;

                // 🎯 調整 1：橫盤容忍區間擴闊到 20% (Meme 幣專用箱體)
                if (priceDiffPct <= 20) {
                    const startTime = new Date(token.consolidation_start_time).getTime();
                    const consolidationMins = (Date.now() - startTime) / 60000;

                    console.log(`📊 [Watchlist] ${token.token_symbol} 橫盤中 (${consolidationMins.toFixed(0)} 分鐘), 價格浮動: ${priceDiffPct.toFixed(2)}%`);

                    // 🎯 調整 2：橫盤滿 30 分鐘即刻評估第二波爆發！
                    if (consolidationMins >= 30) {
                        if (analyzeReentry) {
                            const aiReview = await analyzeReentry(token.mint_address, token.token_symbol, currentPrice);
                            
                            if (aiReview && aiReview.decision === 'BUY') {
                                const config = await getDynamicConfig();
                                console.log(`💥 [Re-entry BUY] 莊家洗盤完畢！AI 決定接回 ${token.token_symbol}！理由: ${aiReview.reason}`);
                                await executeBuy(token.mint_address, token.token_symbol, 'REENTRY', aiReview.score || 10, aiReview.reason, await getSafeSolPrice(), config.trade_amount_sol);
                            } else {
                                console.log(`🗑️ [Watchlist Drop] AI 判定 ${token.token_symbol} 已成死水 (${aiReview?.reason || '無理由'})，放棄接回。`);
                            }
                        } else {
                            console.warn(`⚠️ [系統] 未找到 analyzeReentry 函數，跳過評估。`);
                        }
                        
                        await supabase.from('reentry_watchlist').delete().eq('mint_address', token.mint_address);
                    }
                } else {
                    console.log(`📉📈 [Watchlist] ${token.token_symbol} 價格偏離基準超過 20%，重置箱體基準線。`);
                    await supabase.from('reentry_watchlist').update({
                        baseline_price_sol: currentPrice,
                        consolidation_start_time: new Date().toISOString()
                    }).eq('mint_address', token.mint_address);
                }
            }
        } catch (err) {
            console.error("❌ [Watchlist Radar] 巡邏發生錯誤:", err.message);
        }
    }, 10 * 60 * 1000); 
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        await syncWebhookStateOnStartup();
        startPositionMonitor(); 
        startNurseryMonitor(); 
        startCommandListener();
        startWatchlistMonitor(); // 👈 正式啟動橫盤監控
    });
}

module.exports = { startMarketMonitor };