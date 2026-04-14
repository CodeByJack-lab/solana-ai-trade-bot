// src/microservices/monitor_guards.js
// 📝 檔案功能用途：V10.18 【護盤鐵衛】微服務 (Microservice Core)
// 🚀 核心升級：O(1) 無迴圈運算、事件驅動觸發 AI Watchdog、完整繼承 V9 神風逃生艙與硬止損。
// 🛡️ 終極修復：完美對接 Python 動態 SL/TP 參數；修復 DEFCON 逃生後的 Database 幽靈倉位卡死 Bug。
// 🌪️ V10.24 新增：主動清道夫實裝「大市氣候動態縮放 (Dynamic Climate Scaling)」，牛市多耐心，熊市急斬倉。

require('dotenv').config();
const Redis = require('ioredis');
const { supabase } = require('../config/supabase'); // 🚨 FIX: 引入 supabase 用於斬殺幽靈倉位

// 載入 V10 底層依賴
const { getPortfolio, initPortfolio } = require('../services/portfolioService'); 
const { runSellPipeline } = require('../services/tradeService');
const { fallbackEscapeService } = require('../services/fallbackEscapeService');

// 🚀 引入維運中樞 (新增)
const { healthMonitor } = require('../services/healthMonitor');

// ------------------------------------------------------------------
// 1. 初始化與全域防禦變數
// ------------------------------------------------------------------
const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

let globalConfig = { is_running: true };
let localClimate = 'CHOPPY'; 
let dynamic_sl_limit = -15.0; // 動態止損 (將從 Redis 獲取)
let dynamic_tp_step = 20.0;   // 動態階梯體檢點 (將從 Redis 獲取)

// 🛡️ 時光倒流護盾 Map (O(1) 查詢)
const last_valid_ts = new Map();

// 🚨 逃生艙實體隔離鎖 (確保被隔離的幣不會再次觸發任何運算)
const quarantine_lock = new Set();
const guard_states = new Map();

// ------------------------------------------------------------------
// 2. O(1) 內存數學狀態機
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 3. 神風逃生艙實體隔離 (修復幽靈倉位 Bug)
// ------------------------------------------------------------------
async function triggerDefconEscape(pos, portfolio) {
    if (quarantine_lock.has(pos.mint_address)) return;

    quarantine_lock.add(pos.mint_address);
    // 從記憶體中剔除
    const actualIndex = portfolio.positions.findIndex(p => p.mint_address === pos.mint_address);
    if (actualIndex > -1) portfolio.positions.splice(actualIndex, 1); 

    console.log(`🚨 [DEFCON] ${pos.token_symbol} 觸發極端崩盤，已實體隔離進入神風逃生艙！`);

    try {
        // 呼叫底層砸盤
        const escapeResult = await fallbackEscapeService.executeEscape(pos, pos.quantity);

        if (escapeResult && escapeResult.success) {
            console.log(`☠️ [DEFCON] ${pos.token_symbol} 逃生成功！正在清理 Database 幽靈紀錄...`);
            
            // 🚨 FIX 2: 徹底清除 Database 中的幽靈倉位，防止 Dashboard 卡死
            const activeTables = ['active_positions_live', 'active_positions_paper', 'active_positions_shadow'];
            for (const table of activeTables) {
                await supabase.from(table).delete().eq('mint_address', pos.mint_address);
            }

            guard_states.delete(pos.mint_address);
            last_valid_ts.delete(pos.mint_address);
            console.log(`✅ [DEFCON] ${pos.token_symbol} 實體清理完畢。`);
        } else {
            console.warn(`❌ [DEFCON] ${pos.token_symbol} 逃生失敗！代幣重新塞回活躍陣列。`);
            portfolio.positions.push(pos);
        }
    } catch (e) {
        console.error(`❌ [DEFCON] 逃生艙發生嚴重異常:`, e.message);
        portfolio.positions.push(pos);
    } finally {
        quarantine_lock.delete(pos.mint_address);
    }
}

// ------------------------------------------------------------------
// 4. V9 硬止損與 V10 Math Guards 演算核心
// ------------------------------------------------------------------
async function executeV9HardStopLoss(pos, pnlPct, currentPrice) {
    if (pnlPct <= dynamic_sl_limit) { 
        const lockKey = `sell_lock:${pos.mint_address}`;
        const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
        if (acquired) {
            console.log(`💥 [Grace Period] ${pos.token_symbol} 建倉首分鐘跌穿 ${dynamic_sl_limit.toFixed(2)}% 硬止損底線！`);
            const sold = await runSellPipeline(pos, currentPrice, `💥 冷啟動期硬止損觸發 (${dynamic_sl_limit.toFixed(2)}%)`, 1.0)
                .finally(() => redisClient.del(lockKey));
            return sold;
        }
    }
    return false;
}

// 🎯 定期同步氣候與 Python 最新參數 (修復瞎眼鐵衛 Bug)
setInterval(async () => {
    try {
        const envStr = await redisClient.get('global_env_state');
        if (envStr) localClimate = JSON.parse(envStr).climate || 'CHOPPY';
        
        // 🚨 FIX 1: 讀取 Python 輸出的最新統一結構 cache:dynamic_scoring_model
        const paramsStr = await redisClient.get('cache:dynamic_scoring_model');
        if (paramsStr) {
            const mlModel = JSON.parse(paramsStr);
            if (mlModel.dynamic_sl !== undefined) dynamic_sl_limit = parseFloat(mlModel.dynamic_sl);
            if (mlModel.dynamic_tp_trigger !== undefined) dynamic_tp_step = parseFloat(mlModel.dynamic_tp_trigger);
        }
    } catch(e) {
        // 靜默處理
    }
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
            console.log(`📉 [V10 Guard] ${pos.token_symbol} 跌穿 VWAP 防線且虧損 (${pnlPct.toFixed(2)}% <= ${(dynamic_sl_limit * 0.5).toFixed(2)}%)，執行常規止損。`);
            const sold = await runSellPipeline(pos, currentPrice, "📉 V10 VWAP 防線崩潰", 1.0)
                .finally(() => redisClient.del(lockKey));
            if (sold) { guard_states.delete(pos.mint_address); last_valid_ts.delete(pos.mint_address); }
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
                console.log(`🌪️ [V10 Guard] ${pos.token_symbol} 偵測到大戶派發 (CVD背離) 或劇烈回撤，執行高頻波段逃頂。`);
                const sold = await runSellPipeline(pos, currentPrice, "🌪️ CVD 背離/波幅直斬", 1.0)
                    .finally(() => redisClient.del(lockKey));
                if (sold) { guard_states.delete(pos.mint_address); last_valid_ts.delete(pos.mint_address); }
            }
        }
    }
}

// ------------------------------------------------------------------
// 5. Redis 報價接收與護盤主迴圈
// ------------------------------------------------------------------
redisSub.subscribe('price_updates', 'emergency_action');

redisSub.on('message', async (channel, message) => {
    if (channel === 'emergency_action') {
        try {
            const { action, reason } = JSON.parse(message);
            if (action === 'LIQUIDATE_ALL') {
                console.log(`☢️ [DEFCON 1] 收到全域強平指令！正在併發執行大屠殺...`);
                globalConfig.is_running = false; 
                const portfolio = getPortfolio();
                if (!portfolio || !portfolio.positions) return;

                const sellPromises = portfolio.positions.map(async (pos) => {
                    if (quarantine_lock.has(pos.mint_address)) return; 
                    
                    const lockKey = `sell_lock:${pos.mint_address}`;
                    const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                    if (acquired) {
                        const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
                        const sold = await runSellPipeline(pos, currentPrice, reason, 1.0)
                            .finally(() => redisClient.del(lockKey));
                        if (sold) {
                            guard_states.delete(pos.mint_address);
                            last_valid_ts.delete(pos.mint_address);
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
                    const sold = await executeV9HardStopLoss(pos, pnlPct, marketData.p);
                    if (sold) { guard_states.delete(mint); last_valid_ts.delete(mint); }
                } else {
                    await executeV10MathGuards(pos, state, pnlPct, marketData.p, portfolio);
                }
            }
        } catch (err) {}
    }
});

// ------------------------------------------------------------------
// 6. OOM 防禦：實時交叉比對清道夫 
// ------------------------------------------------------------------
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
// 7. 主動清道夫 (Zombie Sweeper) - 🚀 V10.24 大市氣候動態縮放版
// ------------------------------------------------------------------
setInterval(async () => {
    if (!globalConfig.is_running) return;
    try {
        const portfolio = getPortfolio();
        if (!portfolio || !portfolio.positions) return;
        const now = Date.now();

        // 🎯 1. 讀取基礎設定
        let baseMaxAgeMeme = 15;
        let baseMaxAgeTrending = 120;
        try {
            const { data: dbConfig } = await supabase
                .from('system_config')
                .select('min_age_mins, max_age_mins')
                .eq('id', 1)
                .single();
            if (dbConfig) {
                baseMaxAgeMeme = dbConfig.min_age_mins || 15; 
                baseMaxAgeTrending = dbConfig.max_age_mins || 120; 
            }
        } catch (dbErr) {
            console.warn("⚠️ [Zombie Sweeper] 無法讀取 DB 時間設定，使用預設值。");
        }

        // 🧠 2. 獲取當前大市氣候 (本機已由定時器同步維護 localClimate)
        const currentClimate = localClimate;

        // ⚖️ 3. 定義「氣候乘數」與「容忍利潤線」
        let timeMultiplier = 1.0;
        let requiredPnlPct = 5.0;

        switch (currentClimate) {
            case 'RAGING_BULL':
                timeMultiplier = 2.0;    // 畀多一倍時間洗盤
                requiredPnlPct = 1.0;    // 只要唔蝕錢/微賺，就繼續 Hold
                break;
            case 'BULL_FRENZY':
                timeMultiplier = 1.5;
                requiredPnlPct = 2.0;
                break;
            case 'BEAR_PANIC':
                timeMultiplier = 0.5;    // 死線減半！快刀斬亂麻
                requiredPnlPct = 8.0;    // 如果咁惡劣都賺唔到 8%，即刻掟
                break;
            case 'CHOPPY':
            default:
                timeMultiplier = 1.0;
                requiredPnlPct = 5.0;
                break;
        }

        const dynamicAgeMeme = Math.floor(baseMaxAgeMeme * timeMultiplier);
        const dynamicAgeTrending = Math.floor(baseMaxAgeTrending * timeMultiplier);

        // 🧹 4. 執行清掃
        for (const pos of portfolio.positions) {
            if (quarantine_lock.has(pos.mint_address)) continue;
            
            const ageMins = pos.created_at ? (now - new Date(pos.created_at).getTime()) / 60000 : 0;
            const currentPrice = pos.current_price_sol || pos.highest_price_sol || pos.entry_price_sol;
            const pnlPct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100;
            
            const timeStopLimit = pos.strategy_type?.includes('TRENDING') ? dynamicAgeTrending : dynamicAgeMeme; 
            
            if (ageMins >= timeStopLimit && pnlPct < requiredPnlPct) {
                const lockKey = `sell_lock:${pos.mint_address}`;
                const acquired = await redisClient.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                if (acquired) {
                    console.log(`🧹 [Zombie Sweeper] ${pos.token_symbol} 滯留過久 (${ageMins.toFixed(0)} / ${timeStopLimit} mins 未達標 ${requiredPnlPct}%)，無差別清倉！`);
                    console.log(`   ↳ [氣候因數] 當前氣候: ${currentClimate} | 時間乘數: x${timeMultiplier}`);
                    
                    const sold = await runSellPipeline(pos, currentPrice, `⏱️ Time-Stop (${currentClimate}): 超時 ${timeStopLimit}m 未達 ${requiredPnlPct}%`, 1.0)
                        .finally(() => redisClient.del(lockKey));
                    if (sold) {
                        guard_states.delete(pos.mint_address);
                        last_valid_ts.delete(pos.mint_address);
                    }
                }
            }
        }
    } catch (e) {
        console.error("❌ [Zombie Sweeper] 執行異常:", e.message);
    }
}, 60 * 1000);

// ------------------------------------------------------------------
// 8. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🛡️ SOL QUANT MONITOR_GUARDS V10.24 (護盤鐵衛) 啟動中...");
    await initPortfolio();
    
    // 🚀 新增：啟動時寫入 Database 報平安
    await healthMonitor.setStatus('Monitor_Guards', '🟢 鐵衛巡邏中');
    
    console.log("   - O(1) Float64Array 數學引擎已就緒 (含 CVD 量價背離過濾與 Watchdog 廣播)。");
    console.log("   - 1 分鐘冷啟動靜默期與 Redis 併發平倉鎖已就緒。");
    console.log("   - 實體隔離逃生艙與 LIQUIDATE_ALL 全域強平通道已就緒。");
    console.log("   - 大市氣候動態縮放 (Dynamic Climate Scaling) 掃地機制已就緒。");
}

bootstrap();