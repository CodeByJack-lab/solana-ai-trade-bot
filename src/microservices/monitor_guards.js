// src/microservices/monitor_guards.js
// 📝 檔案功能用途：V10.33 【護盤鐵衛】微服務 (Microservice Core)
// 🚀 核心升級：O(1) 無迴圈運算、事件驅動觸發 AI Watchdog、完整繼承 V9 神風逃生艙與硬止損。
// 👻 影子獨立：新增每 15 分鐘執行的 Shadow Tracker，無痛查價並於 24 小時後自動結算寫入 ML。
// 🚦 API 讓路：Shadow 查價前會檢查 DEXSCREENER_LOCK，若 Main Bot 佔用則強制等待 10 秒 (已隱藏等待 Log 防洗版)。
// 💥 連環斬修復：拔除所有 finally 解鎖，改為成功後即斬 RAM 倉位，失敗才解鎖重試，徹底根絕無限平倉 Loop。

require('dotenv').config();
const Redis = require('ioredis');
const axios = require('axios');
const { supabase } = require('../config/supabase');

const { getPortfolio, initPortfolio } = require('../services/portfolioService'); 
const { runSellPipeline } = require('../services/tradeService');
const { fallbackEscapeService } = require('../services/fallbackEscapeService');
const { healthMonitor } = require('../services/healthMonitor');

const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

let globalConfig = { is_running: true };
let localClimate = 'CHOPPY'; 
let dynamic_sl_limit = -15.0; 
let dynamic_tp_step = 20.0;   

const last_valid_ts = new Map();
const quarantine_lock = new Set();
const guard_states = new Map();

class MathGuardState {
    constructor() {
        this.p_arr = new Float64Array(500); this.v_arr = new Float64Array(500);
        this.idx = 0; this.ticks_collected = 0;
        this.sum_pv = 0; this.sum_v = 0;
        this.w_count = 0; this.w_mean = 0; this.w_m2 = 0;
        this.highest_price = 0; this.cvd = 0; this.last_p = 0;
    }
    updateTick(p, v) {
        if (p > this.highest_price) this.highest_price = p;
        if (this.last_p > 0) {
            const jumpPct = Math.abs((p - this.last_p) / this.last_p);
            if (jumpPct <= 0.02) { if (p > this.last_p) this.cvd += v; else if (p < this.last_p) this.cvd -= v; }
        }
        this.last_p = p;
        const old_p = this.p_arr[this.idx]; const old_v = this.v_arr[this.idx];
        this.sum_pv = this.sum_pv - (old_p * old_v) + (p * v); this.sum_v = this.sum_v - old_v + v;
        this.p_arr[this.idx] = p; this.v_arr[this.idx] = v;
        this.idx = (this.idx + 1) % 500; this.ticks_collected++;
        this.w_count++; const delta = p - this.w_mean; this.w_mean += delta / this.w_count;
        const delta2 = p - this.w_mean; this.w_m2 += delta * delta2;
    }
    getVWAP() { return this.sum_v > 0 ? (this.sum_pv / this.sum_v) : 0; }
    getVolatility() { return this.w_count < 2 ? 0 : Math.sqrt(this.w_m2 / this.w_count); }
    getCVD() { return this.cvd; } 
}

async function triggerDefconEscape(pos, portfolio) {
    if (quarantine_lock.has(pos.mint_address)) return;
    quarantine_lock.add(pos.mint_address);
    const actualIndex = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
    if (actualIndex > -1) portfolio.positions.splice(actualIndex, 1); 

    console.log(`🚨 [DEFCON] ${pos.token_symbol} 觸發極端崩盤，已實體隔離進入神風逃生艙！`);

    try {
        const escapeResult = await fallbackEscapeService.executeEscape(pos, pos.quantity);
        if (escapeResult && escapeResult.success) {
            console.log(`☠️ [DEFCON] ${pos.token_symbol} 逃生成功！正在清理 Database 幽靈紀錄...`);
            const activeTables = ['active_positions_live', 'active_positions_paper'];
            for (const table of activeTables) await supabase.from(table).delete().eq('mint_address', pos.mint_address);
            guard_states.delete(pos.mint_address);
            last_valid_ts.delete(pos.mint_address);
        } else {
            portfolio.positions.push(pos);
        }
    } catch (e) {
        portfolio.positions.push(pos);
    } finally {
        quarantine_lock.delete(pos.mint_address);
    }
}

async function executeV9HardStopLoss(pos, pnlPct, currentPrice, portfolio) {
    if (pnlPct <= dynamic_sl_limit) { 
        const lockKey = `sell_lock:${pos.mint_address}`;
        const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
        if (acquired) {
            console.log(`💥 [Grace Period] ${pos.token_symbol} 跌穿 ${dynamic_sl_limit.toFixed(2)}% 硬止損底線！`);
            const sold = await runSellPipeline(pos, currentPrice, `💥 硬止損觸發 (${dynamic_sl_limit.toFixed(2)}%)`, 1.0);
            
            // 🚀 核心修復：成功後即斬 RAM，失敗先解鎖
            if (sold) {
                const idx = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
                if (idx > -1) portfolio.positions.splice(idx, 1);
            } else {
                await redisClient.del(lockKey);
            }
            return sold;
        }
    }
    return false;
}

setInterval(async () => {
    try {
        const envStr = await redisClient.get('global_env_state');
        if (envStr) localClimate = JSON.parse(envStr).climate || 'CHOPPY';
        const paramsStr = await redisClient.get('cache:dynamic_scoring_model');
        if (paramsStr) {
            const mlModel = JSON.parse(paramsStr);
            if (mlModel.dynamic_sl !== undefined) dynamic_sl_limit = parseFloat(mlModel.dynamic_sl);
            if (mlModel.dynamic_tp_trigger !== undefined) dynamic_tp_step = parseFloat(mlModel.dynamic_tp_trigger);
        }
    } catch(e) {}
}, 10000);

async function executeV10MathGuards(pos, state, pnlPct, currentPrice, portfolio) {
    const vwap = state.getVWAP();
    const volatility = state.getVolatility();
    const cvd = state.getCVD(); 
    const vwapDev = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

    let defconPct = localClimate === 'BEAR_PANIC' ? -30.0 : -40.0;
    if (pnlPct <= defconPct || (vwap > 0 && currentPrice < vwap * 0.5)) {
        await triggerDefconEscape(pos, portfolio);
        return;
    }

    if (vwap > 0 && currentPrice < vwap * 0.90 && pnlPct <= (dynamic_sl_limit * 0.5)) {
        const lockKey = `sell_lock:${pos.mint_address}`;
        if (await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX')) {
            console.log(`📉 [V10 Guard] ${pos.token_symbol} 跌穿 VWAP 防線，執行常規止損。`);
            const sold = await runSellPipeline(pos, currentPrice, "📉 V10 VWAP 防線崩潰", 1.0);
            
            if (sold) { 
                guard_states.delete(pos.mint_address); last_valid_ts.delete(pos.mint_address); 
                const idx = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
                if (idx > -1) portfolio.positions.splice(idx, 1);
            } else {
                await redisClient.del(lockKey);
            }
        }
        return;
    }

    const highestPnlPct = ((state.highest_price - pos.entry_price_sol) / pos.entry_price_sol) * 100;
    const milestoneLevel = Math.floor(pnlPct / dynamic_tp_step) * dynamic_tp_step;

    if (milestoneLevel >= dynamic_tp_step) {
        const checkedKey = `watchdog_checked:${pos.mint_address}:L${milestoneLevel}`;
        const isChecked = await redisClient.set(checkedKey, 'DONE', 'EX', 86400, 'NX');
        if (isChecked) {
            await redisClient.publish('watchdog_alerts', JSON.stringify({
                mint: pos.mint_address, symbol: pos.token_symbol,
                pnl: pnlPct, cvd: cvd, vwap_dev: vwapDev, volatility: volatility, climate: localClimate
            }));
        }
    }

    if (highestPnlPct > 30.0 && volatility > (currentPrice * 0.15)) {
        if (pnlPct < highestPnlPct - 15.0 || cvd < 0) { 
            const lockKey = `sell_lock:${pos.mint_address}`;
            if (await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX')) {
                console.log(`🌪️ [V10 Guard] ${pos.token_symbol} 偵測到大戶派發 (CVD背離)，執行逃頂。`);
                const sold = await runSellPipeline(pos, currentPrice, "🌪️ CVD 背離/波幅直斬", 1.0);
                
                if (sold) { 
                    guard_states.delete(pos.mint_address); last_valid_ts.delete(pos.mint_address); 
                    const idx = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
                    if (idx > -1) portfolio.positions.splice(idx, 1);
                } else {
                    await redisClient.del(lockKey);
                }
            }
        }
    }
}

redisSub.subscribe('price_updates', 'emergency_action');
redisSub.on('message', async (channel, message) => {
    if (channel === 'emergency_action') {
        try {
            const { action, reason } = JSON.parse(message);
            if (action === 'LIQUIDATE_ALL') {
                globalConfig.is_running = false; 
                const portfolio = getPortfolio();
                if (!portfolio || !portfolio.positions) return;

                const sellPromises = portfolio.positions.map(async (pos) => {
                    if (quarantine_lock.has(pos.mint_address)) return; 
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                    if (acquired) {
                        const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
                        const sold = await runSellPipeline(pos, currentPrice, reason, 1.0);
                        if (sold) { 
                            guard_states.delete(pos.mint_address); last_valid_ts.delete(pos.mint_address); 
                            const idx = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
                            if (idx > -1) portfolio.positions.splice(idx, 1);
                        } else {
                            await redisClient.del(lockKey);
                        }
                    }
                });
                await Promise.allSettled(sellPromises);
            }
        } catch (err) {}
        return;
    }

    if (channel === 'price_updates' && globalConfig.is_running) {
        try {
            const payload = JSON.parse(message);
            const portfolio = getPortfolio();
            if (!portfolio || !portfolio.positions) return;

            for (let i = portfolio.positions.length - 1; i >= 0; i--) {
                const pos = portfolio.positions[i];
                const mint = pos.mint_address;

                if (quarantine_lock.has(mint)) continue;

                const marketData = payload[mint];
                if (!marketData) continue;

                if (marketData.ts <= (last_valid_ts.get(mint) || 0)) continue;
                last_valid_ts.set(mint, marketData.ts);
                pos.current_price_sol = marketData.p; 

                let state = guard_states.get(mint);
                if (!state) { 
                    state = new MathGuardState(); 
                    state.highest_price = pos.highest_price_sol || pos.entry_price_sol; 
                    guard_states.set(mint, state); 
                }
                
                state.updateTick(marketData.p, marketData.v);
                const pnlPct = ((marketData.p - pos.entry_price_sol) / pos.entry_price_sol) * 100;

                if (state.ticks_collected < 30) {
                    const sold = await executeV9HardStopLoss(pos, pnlPct, marketData.p, portfolio);
                    if (sold) { guard_states.delete(mint); last_valid_ts.delete(mint); }
                } else {
                    await executeV10MathGuards(pos, state, pnlPct, marketData.p, portfolio);
                }
            }
        } catch (err) {}
    }
});

setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    const portfolio = getPortfolio();
    const activeMints = new Set(portfolio.positions?.map(p => p.mint_address) || []);
    
    for (const [mint, ts] of last_valid_ts.entries()) {
        if ((now - ts > 10 * 60 * 1000) || !activeMints.has(mint)) { 
            last_valid_ts.delete(mint);
            guard_states.delete(mint);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) console.log(`🧹 [Garbage Collector] 已徹底釋放 ${cleanedCount} 隻已平倉或過期代幣的 RAM 緩存。`);
}, 60 * 1000); 

// ------------------------------------------------------------------
// 7. 主動清道夫 (Zombie Sweeper) - 僅清理真/模擬倉
// ------------------------------------------------------------------
setInterval(async () => {
    if (!globalConfig.is_running) return;
    try {
        const portfolio = getPortfolio();
        if (!portfolio || !portfolio.positions) return;
        const now = Date.now();

        let baseMaxAgeMeme = 15;
        let baseMaxAgeTrending = 120;
        try {
            const { data: dbConfig } = await supabase.from('system_config').select('min_age_mins, max_age_mins').eq('id', 1).single();
            if (dbConfig) { baseMaxAgeMeme = dbConfig.min_age_mins || 15; baseMaxAgeTrending = dbConfig.max_age_mins || 120; }
        } catch (dbErr) {}

        let timeMultiplier = 1.0;
        let requiredPnlPct = 5.0;
        switch (localClimate) {
            case 'RAGING_BULL': timeMultiplier = 2.0; requiredPnlPct = 1.0; break;
            case 'BULL_FRENZY': timeMultiplier = 1.5; requiredPnlPct = 2.0; break;
            case 'BEAR_PANIC':  timeMultiplier = 0.5; requiredPnlPct = 8.0; break;
            default:            timeMultiplier = 1.0; requiredPnlPct = 5.0; break;
        }

        const dynamicAgeMeme = Math.floor(baseMaxAgeMeme * timeMultiplier);
        const dynamicAgeTrending = Math.floor(baseMaxAgeTrending * timeMultiplier);

        // 💥 核心修復：反向迴圈確保 Splice 時不會跳過元素
        for (let i = portfolio.positions.length - 1; i >= 0; i--) {
            const pos = portfolio.positions[i];
            if (quarantine_lock.has(pos.mint_address)) continue;
            
            const ageMins = pos.created_at ? (now - new Date(pos.created_at).getTime()) / 60000 : 0;
            const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
            const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
            
            const timeStopLimit = pos.strategy_type?.includes('TRENDING') ? dynamicAgeTrending : dynamicAgeMeme; 
            
            if (ageMins >= timeStopLimit && pnlPct < requiredPnlPct) {
                const lockKey = `sell_lock:${pos.mint_address}`;
                const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                if (acquired) {
                    console.log(`🧹 [Zombie Sweeper] ${pos.token_symbol} 滯留過久，無差別清倉！`);
                    const sold = await runSellPipeline(pos, currentPrice, `⏱️ Time-Stop: 超時未達標`, 1.0);
                    
                    if (sold) { 
                        guard_states.delete(pos.mint_address); 
                        last_valid_ts.delete(pos.mint_address); 
                        portfolio.positions.splice(i, 1); // 🚀 成功即斬 RAM，根絕無限鞭屍
                    } else {
                        await redisClient.del(lockKey);
                    }
                }
            }
        }
    } catch (e) {}
}, 60 * 1000);

// ------------------------------------------------------------------
// 8. 👻 專屬的影子清道夫 (每 15 分鐘慢速查價，並懂得避開 Main Bot)
// ------------------------------------------------------------------
setInterval(async () => {
    if (!globalConfig.is_running) return;
    try {
        const { data: shadows, error } = await supabase.from('active_positions_shadow').select('*');
        if (error || !shadows || shadows.length === 0) return;

        console.log(`\n👻 [Shadow Tracker] 正在每 15 分鐘緩慢巡邏 ${shadows.length} 隻影子幣...`);

        const mints = shadows.map(s => s.mint_address);
        const priceMap = new Map();

        for (let i = 0; i < mints.length; i += 30) {
            // 🚦 核心防禦：檢查 Main Bot 有冇用緊 DexScreener API
            let apiLocked = await redisClient.get('DEXSCREENER_LOCK');
            while (apiLocked === 'MAIN_BOT') {
                // 🤫 隱藏 Log，保護 Server 唔洗版
                // console.log(`⏳ [Shadow Tracker] Main Bot 正在使用 DexScreener，影子查價讓路，等待 10 秒...`);
                await new Promise(r => setTimeout(r, 10000));
                apiLocked = await redisClient.get('DEXSCREENER_LOCK');
            }

            // 宣告 Shadow Bot 用緊，防禦 5 秒
            await redisClient.set('DEXSCREENER_LOCK', 'SHADOW_BOT', 'EX', 5);

            const chunk = mints.slice(i, i + 30).join(',');
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`, { timeout: 5000 });
                const pairs = res.data?.pairs || [];
                for (const p of pairs) {
                    if (p.chainId === 'solana' && p.baseToken?.address) {
                        const currentPrice = parseFloat(p.priceNative); 
                        if (!priceMap.has(p.baseToken.address) || currentPrice > priceMap.get(p.baseToken.address)) {
                            priceMap.set(p.baseToken.address, currentPrice);
                        }
                    }
                }
            } catch (err) {
                console.warn(`⚠️ [Shadow Tracker] DexScreener 查價失敗，休息 10 秒:`, err.message);
                await new Promise(r => setTimeout(r, 10000)); // 俾 429 抖抖
            }
            await new Promise(r => setTimeout(r, 3000));
        }

        const now = Date.now();
        const SHADOW_MAX_AGE_MINS = 1440; // 24小時結算
        let settledCount = 0;

        for (const pos of shadows) {
            const currentPrice = priceMap.get(pos.mint_address);
            if (!currentPrice) continue;

            const ageMins = pos.created_at ? (now - new Date(pos.created_at).getTime()) / 60000 : 0;
            
            if (currentPrice > (pos.highest_price_sol || 0)) {
                await supabase.from('active_positions_shadow').update({ highest_price_sol: currentPrice }).eq('id', pos.id);
            }

            if (ageMins >= SHADOW_MAX_AGE_MINS) {
                const entryPrice = pos.entry_price_sol || 0;
                let realizedPnlPct = 0;
                if (entryPrice > 0) realizedPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

                await supabase.from('trade_patterns').insert([{
                    mint_address: pos.mint_address,
                    is_shadow: true,
                    strategy_version: pos.strategy_type || 'v10_shadow',
                    entry_ofi: pos.entry_ofi || 0,
                    entry_liquidity_usd: pos.entry_liquidity_usd || 0,
                    realized_pnl_pct: realizedPnlPct,
                    market_climate: pos.market_climate || 'UNKNOWN',
                    entry_price_sol: entryPrice,
                    entry_volume_5m: pos.entry_volume_5m_usd || 0,
                    token_symbol: pos.token_symbol || 'UNKNOWN'
                }]);

                await supabase.from('active_positions_shadow').delete().eq('id', pos.id);
                settledCount++;
            }
        }

        if (settledCount > 0) {
            console.log(`👻 [Shadow Tracker] 本輪成功結算 ${settledCount} 隻滿 24 小時的影子幣，寫入 ML 訓練庫！`);
        }
    } catch (e) {
        console.error("❌ [Shadow Tracker] 巡邏崩潰:", e.message);
    }
}, 15 * 60 * 1000); 

// ------------------------------------------------------------------
// 9. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🛡️ SOL QUANT MONITOR_GUARDS V10.33 (防洗版 + RAM 徹底清倉版) 啟動中...");
    await initPortfolio();
    await healthMonitor.setStatus('Monitor_Guards', '🟢 鐵衛巡邏中');
}

bootstrap();