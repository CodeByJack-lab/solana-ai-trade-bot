// src/microservices/monitor_guards.js
// 📝 檔案功能用途：V10.42 【護盤鐵衛】微服務 (Microservice Core) - 零影子淨化版
// 🚀 核心升級：O(1) 無迴圈運算、事件驅動觸發 AI Watchdog、完整繼承 V9 神風逃生艙與硬止損。
// 👻 幽靈殺手：全面將神風逃生艙的 DB 刪除條件由 mint_address 改為精準的 id，配合 Incremental RAM 徹底防復活。
// ✂️ 動態止損：實裝 Dynamic Time-Stop，偵測到早期動能衰退立即提早斬纜，改善資金利用率。
// 🎯 千人千面風控：自動讀取每隻幣專屬的 SL/TP (由 Frontline 寫入 Redis)，實現客製化止盈止損。
// 🛠️ 併發修復：突破 Node.js 預設 10 個 TLSSocket 監聽限制，解決 MaxListenersExceededWarning。
// ✂️ 邏輯精簡：徹底移除無用的 Shadow (影子倉位) 巡邏邏輯，釋放系統資源。

require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 50; // 🚀 突破 Node.js 預設 TLSSocket 併發監聽限制

const Redis = require('ioredis');
const axios = require('axios');
const { supabase } = require('../config/supabase');

const { getPortfolio, initPortfolio } = require('../services/portfolioService'); 
const { runSellPipeline } = require('../services/tradeService');
const { fallbackEscapeService } = require('../services/fallbackEscapeService');
const { healthMonitor } = require('../services/healthMonitor');

const redisSub = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');
const redisClient = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');

let globalConfig = { is_running: true };
let localClimate = 'CHOPPY'; 
let global_dynamic_sl_limit = -15.0; 
let global_dynamic_tp_step = 20.0;   

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
        
        // 🚀 專屬風控參數
        this.sl = null; 
        this.tp = null; 
        this.tp_level = 0; // 記錄最高觸發過的 TP 階梯
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
            // 🚀 核心修復：使用 id 精準刪除，防止幽靈倉位復活
            for (const table of activeTables) await supabase.from(table).delete().eq('id', pos.id);
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

async function executeV9HardStopLoss(pos, pnlPct, currentPrice, portfolio, actual_sl) {
    if (pnlPct <= actual_sl) { 
        const lockKey = `sell_lock:${pos.mint_address}`;
        const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
        if (acquired) {
            console.log(`💥 [Grace Period] ${pos.token_symbol} 跌穿專屬 ${actual_sl.toFixed(2)}% 硬止損底線！`);
            const sold = await runSellPipeline(pos, currentPrice, `💥 硬止損觸發 (${actual_sl.toFixed(2)}%)`, 1.0);
            
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

// 每 10 秒拉取一次全域預設值兜底
setInterval(async () => {
    try {
        const envStr = await redisClient.get('global_env_state');
        if (envStr) localClimate = JSON.parse(envStr).climate || 'CHOPPY';
        const paramsStr = await redisClient.get('cache:dynamic_scoring_model');
        if (paramsStr) {
            const mlModel = JSON.parse(paramsStr);
            if (mlModel.dynamic_sl !== undefined) global_dynamic_sl_limit = parseFloat(mlModel.dynamic_sl);
            if (mlModel.dynamic_tp_trigger !== undefined) global_dynamic_tp_step = parseFloat(mlModel.dynamic_tp_trigger);
        }
    } catch(e) {}
}, 10000);

async function executeV10MathGuards(pos, state, pnlPct, currentPrice, portfolio, actual_sl, actual_tp) {
    const vwap = state.getVWAP();
    const volatility = state.getVolatility();
    const cvd = state.getCVD(); 
    const vwapDev = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

    let defconPct = localClimate === 'BEAR_PANIC' ? -30.0 : -40.0;
    if (pnlPct <= defconPct || (vwap > 0 && currentPrice < vwap * 0.5)) {
        await triggerDefconEscape(pos, portfolio);
        return;
    }

    if (vwap > 0 && currentPrice < vwap * 0.90 && pnlPct <= (actual_sl * 0.5)) {
        const lockKey = `sell_lock:${pos.mint_address}`;
        if (await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX')) {
            console.log(`📉 [V10 Guard] ${pos.token_symbol} 跌穿 VWAP 防線 (虧損達 SL 一半)，執行常規止損。`);
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
    
    // 🚀 使用專屬 TP 進行階梯體檢
    const milestoneLevel = Math.floor(pnlPct / actual_tp) * actual_tp;

    if (milestoneLevel >= actual_tp && milestoneLevel > state.tp_level) {
        const checkedKey = `watchdog_checked:${pos.mint_address}:L${milestoneLevel}`;
        const isChecked = await redisClient.set(checkedKey, 'DONE', 'EX', 86400, 'NX');
        if (isChecked) {
            state.tp_level = milestoneLevel; // 更新最高觸發點
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
                    
                    // 🚀 嘗試獲取專屬 SL/TP
                    try {
                        const sltpStr = await redisClient.get(`pos_sl_tp:${mint}`);
                        if (sltpStr) {
                            const sltp = JSON.parse(sltpStr);
                            state.sl = sltp.sl;
                            state.tp = sltp.tp;
                        }
                    } catch(e) {}
                    
                    guard_states.set(mint, state); 
                }
                
                // 動態決定使用專屬參數還是全域兜底
                const actual_sl = state.sl !== null ? state.sl : global_dynamic_sl_limit;
                const actual_tp = state.tp !== null ? state.tp : global_dynamic_tp_step;

                state.updateTick(marketData.p, marketData.v);
                const pnlPct = ((marketData.p - pos.entry_price_sol) / pos.entry_price_sol) * 100;

                if (state.ticks_collected < 30) {
                    const sold = await executeV9HardStopLoss(pos, pnlPct, marketData.p, portfolio, actual_sl);
                    if (sold) { guard_states.delete(mint); last_valid_ts.delete(mint); }
                } else {
                    await executeV10MathGuards(pos, state, pnlPct, marketData.p, portfolio, actual_sl, actual_tp);
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
// 7. 主動清道夫 (Zombie Sweeper) - 僅清理真/模擬倉 (加入 Dynamic Time-Stop)
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

        for (let i = portfolio.positions.length - 1; i >= 0; i--) {
            const pos = portfolio.positions[i];
            if (quarantine_lock.has(pos.mint_address)) continue;
            
            const ageMins = pos.created_at ? (now - new Date(pos.created_at).getTime()) / 60000 : 0;
            const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
            const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
            
            const timeStopLimit = pos.strategy_type?.includes('TRENDING') ? dynamicAgeTrending : dynamicAgeMeme; 
            
            let shouldTimeStop = false;
            let stopReason = '';

            // 🚀 動態提早斬纜 (Dynamic Time-Stop): Weed out the weak
            const state = guard_states.get(pos.mint_address);
            if (ageMins >= 10 && ageMins < timeStopLimit && pnlPct < -5.0 && state) {
                const vwap = state.getVWAP();
                const cvd = state.getCVD();
                const isBelowVWAP = vwap > 0 && currentPrice < vwap * 0.95;

                // 若買入超過 10 分鐘，依然浮虧大於 5%，且 (大戶資金淨流出 或 跌穿 VWAP 5% 以上)
                if (cvd < 0 || isBelowVWAP) {
                    shouldTimeStop = true;
                    stopReason = `✂️ Dynamic Time-Stop: 早期動能衰退，提早斬纜 (持有 ${Math.floor(ageMins)}m)`;
                }
            }

            // ⏱️ 常規 Time-Stop
            if (!shouldTimeStop && ageMins >= timeStopLimit && pnlPct < requiredPnlPct) {
                shouldTimeStop = true;
                stopReason = `⏱️ Time-Stop: 超時未達標`;
            }
            
            if (shouldTimeStop) {
                const lockKey = `sell_lock:${pos.mint_address}`;
                const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                if (acquired) {
                    console.log(`🧹 [Zombie Sweeper] ${pos.token_symbol} 觸發清倉: ${stopReason}`);
                    const sold = await runSellPipeline(pos, currentPrice, stopReason, 1.0);
                    
                    if (sold) { 
                        guard_states.delete(pos.mint_address); 
                        last_valid_ts.delete(pos.mint_address); 
                        portfolio.positions.splice(i, 1);
                    } else {
                        await redisClient.del(lockKey);
                    }
                }
            }
        }
    } catch (e) {}
}, 60 * 1000);

// ------------------------------------------------------------------
// 9. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🛡️ SOL QUANT MONITOR_GUARDS V10.42 (零影子淨化版) 啟動中...");
    await initPortfolio();
    await healthMonitor.setStatus('Monitor_Guards', '🟢 鐵衛巡邏中');
}

bootstrap();