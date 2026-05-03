// src/services/pumpfunGraduationMonitor.js
// 📝 功能：監控 Pump.fun 畢業事件 (Migration to PumpSwap)
// 🎓 策略：捕捉畢業後 15–45 分鐘的黃金窗口，唔係初生幣，唔係 Top 10，rug 風險低
// 🔗 數據源：wss://pumpportal.fun/api/data (subscribeMigration — 免費，無需 API key)
// ⚠️  注意：畢業幣現在去 PumpSwap (唔係 Raydium)，DexScreener 會在 1-3 分鐘後收錄
// 🔌 連接方式：開機自動連，斷線自動重連，唔需要額外 API key

'use strict';

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const redis = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');

const PUMPPORTAL_WS_URL  = 'wss://pumpportal.fun/api/data';
const DEX_COOLDOWN_MS    = 1200;           // DexScreener rate limit 保護
const GRADUATION_WINDOW_MAX_MINS = 60;    // 超過 60 分鐘唔入場
const GRADUATION_WINDOW_MIN_MINS = 2;     // 太新唔入場（等 DexScreener 收錄）
const MIN_LIQUIDITY_USD  = 30000;         // 畢業幣最低流動性
const MAX_LIQUIDITY_USD  = 2000000;       // 上限（太大已升完）
const MAX_TOP10_HOLDER_PCT = 35;          // Top 10 持倉不可超過 35%

let wsInstance = null;
let reconnectTimer = null;
let lastDexCall = 0;
let isRunning = false;

// ------------------------------------------------------------------
// 1. 三重安全 Check（mintAuthority + LP burn + Holder 集中度）
// ------------------------------------------------------------------
async function checkGraduationSafety(mint) {
    try {
        // Check 1: mintAuthority 係咪 null（可增發 = 直接否決）
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
        const mintAuthority = mintInfo?.value?.data?.parsed?.info?.mintAuthority;
        if (mintAuthority !== null && mintAuthority !== undefined) {
            console.log(`🚫 [GradMonitor] ${mint.slice(0, 8)}... mintAuthority 非 null，可增發，跳過`);
            return false;
        }

        // Check 2: Top 10 持倉集中度
        const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(mint));
        if (largestAccounts?.value?.length > 0) {
            const supplyInfo = await connection.getTokenSupply(new PublicKey(mint));
            const totalSupply = supplyInfo?.value?.uiAmount || 0;
            if (totalSupply > 0) {
                const top10Amount = largestAccounts.value
                    .slice(0, 10)
                    .reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
                const top10Pct = (top10Amount / totalSupply) * 100;
                if (top10Pct > MAX_TOP10_HOLDER_PCT) {
                    console.log(`🚫 [GradMonitor] ${mint.slice(0, 8)}... Top10 持倉 ${top10Pct.toFixed(1)}% > ${MAX_TOP10_HOLDER_PCT}%，跳過`);
                    return false;
                }
            }
        }

        // Check 3: LP Burn 狀態（從 Redis 讀取，由現有 SecurityGuard 寫入）
        const lpBurned = await redis.get(`lp_burned:${mint}`);
        // 畢業幣 LP burn 係可選 check（PumpSwap 本身有 LP，但唔一定 burn）
        // 唔強制要求 burn，但有 burn 加分
        const hadLpBurn = lpBurned === 'TRUE';

        console.log(`✅ [GradMonitor] ${mint.slice(0, 8)}... 三重 check 通過 | LP Burn: ${hadLpBurn}`);
        return { passed: true, hadLpBurn };

    } catch (err) {
        console.warn(`⚠️ [GradMonitor] 安全 check 失敗 (${mint.slice(0, 8)}...): ${err.message}`);
        return false;  // 查唔到 = 跳過，唔冒險
    }
}

// ------------------------------------------------------------------
// 2. 從 DexScreener 拎畢業幣的完整數據（等 1-3 分鐘 DexScreener 收錄）
// ------------------------------------------------------------------
async function fetchDexDataWithRetry(mint, maxRetries = 5, intervalMs = 15000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Rate limit 保護
        const now = Date.now();
        const wait = DEX_COOLDOWN_MS - (now - lastDexCall);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastDexCall = Date.now();

        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
            const res = await axios.get(url, { timeout: 8000 });
            const pairs = res.data?.pairs;

            if (pairs && pairs.length > 0) {
                // 優先拎 PumpSwap 的 pair
                const pair = pairs.find(p =>
                    p.dexId === 'pumpswap' || p.dexId === 'raydium' || p.dexId === 'orca'
                ) || pairs[0];

                const liquidity = parseFloat(pair.liquidity?.usd || 0);
                if (liquidity < MIN_LIQUIDITY_USD) {
                    console.log(`⚠️ [GradMonitor] ${mint.slice(0, 8)}... 流動性 $${liquidity.toFixed(0)} < $${MIN_LIQUIDITY_USD}，跳過`);
                    return null;
                }
                if (liquidity > MAX_LIQUIDITY_USD) {
                    console.log(`⚠️ [GradMonitor] ${mint.slice(0, 8)}... 流動性 $${liquidity.toFixed(0)} > $${MAX_LIQUIDITY_USD}，已升完，跳過`);
                    return null;
                }

                return {
                    mint_address:     mint,
                    token_symbol:     (pair.baseToken?.symbol || 'UNKNOWN').toUpperCase(),
                    token_name:       pair.baseToken?.name || 'UNKNOWN',
                    liquidity,
                    volume_24h:       parseFloat(pair.volume?.h24 || 0),
                    volume_h1:        parseFloat(pair.volume?.h1  || 0),
                    price_change_24h: parseFloat(pair.priceChange?.h24 || 0),
                    price_change_h1:  parseFloat(pair.priceChange?.h1  || 0),
                    buys_h24:         parseInt(pair.txns?.h24?.buys  || 0),
                    sells_h24:        parseInt(pair.txns?.h24?.sells || 0),
                    liq_base:         parseFloat(pair.liquidity?.base  || 0),
                    liq_quote:        parseFloat(pair.liquidity?.quote || 0),
                    dex_id:           pair.dexId || 'pumpswap',
                    source:           'PUMP_GRADUATION',
                };
            }

            console.log(`⏳ [GradMonitor] 嘗試 ${attempt}/${maxRetries}: DexScreener 未收錄 ${mint.slice(0, 8)}...，${intervalMs / 1000}s 後重試`);
        } catch (err) {
            console.warn(`⚠️ [GradMonitor] DexScreener 查詢失敗 (嘗試 ${attempt}): ${err.message}`);
        }

        if (attempt < maxRetries) await new Promise(r => setTimeout(r, intervalMs));
    }

    console.log(`❌ [GradMonitor] ${mint.slice(0, 8)}... ${maxRetries} 次後仍未上 DexScreener，放棄`);
    return null;
}

// ------------------------------------------------------------------
// 3. 處理畢業事件主流程
// ------------------------------------------------------------------
async function handleGraduationEvent(event) {
    const mint   = event.mint;
    const symbol = event.symbol || event.name || mint.slice(0, 8);

    if (!mint || mint.length < 32) return;

    console.log(`\n🎓 [GradMonitor] 偵測到畢業事件！幣: ${symbol} | Mint: ${mint.slice(0, 8)}...`);

    // 防重複：同一隻幣 2 小時內唔重複處理
    const recentKey = `grad_processed:${mint}`;
    const alreadyDone = await redis.get(recentKey);
    if (alreadyDone) {
        console.log(`⏭️ [GradMonitor] ${symbol} 已處理過，跳過`);
        return;
    }
    await redis.set(recentKey, Date.now().toString(), 'EX', 7200);

    // 記錄畢業時間（mins_since_graduation 計算用）
    const graduationTime = Date.now();
    await redis.set(`graduated:${mint}`, graduationTime.toString(), 'EX', 86400);

    // 冷卻期 check：此幣之前係咪輸過
    const portfolio = require('./portfolioService').getPortfolio();
    const tableSuffix = portfolio?.mode === 'LIVE' ? 'live' : 'paper';
    const { data: tradeHistory } = await supabase
        .from(`trade_history_${tableSuffix}`)
        .select('created_at, realized_pnl_pct')
        .eq('token_mint', mint)
        .eq('action', 'SELL')
        .order('created_at', { ascending: false })
        .limit(1);

    if (tradeHistory?.length > 0) {
        const last = tradeHistory[0];
        const hoursSince = (Date.now() - new Date(last.created_at).getTime()) / 3600000;
        if (last.realized_pnl_pct < 0 && hoursSince < 24) {
            console.log(`⏸️ [GradMonitor] ${symbol} 24h 冷卻期未過，跳過`);
            return;
        }
    }

    // 等 2 分鐘讓 DexScreener 收錄（GRADUATION_WINDOW_MIN_MINS）
    console.log(`⏳ [GradMonitor] 等待 ${GRADUATION_WINDOW_MIN_MINS} 分鐘讓 DexScreener 收錄 ${symbol}...`);
    await new Promise(r => setTimeout(r, GRADUATION_WINDOW_MIN_MINS * 60 * 1000));

    // 三重安全 check
    const safetyResult = await checkGraduationSafety(mint);
    if (!safetyResult || !safetyResult.passed) return;

    // 拎 DexScreener 完整數據（最多重試 5 次，每次等 15 秒）
    const dexData = await fetchDexDataWithRetry(mint);
    if (!dexData) return;

    // 確認畢業窗口未關閉（唔可以超過 GRADUATION_WINDOW_MAX_MINS 分鐘）
    const minsElapsed = (Date.now() - graduationTime) / 60000;
    if (minsElapsed > GRADUATION_WINDOW_MAX_MINS) {
        console.log(`⌛ [GradMonitor] ${symbol} 畢業已 ${minsElapsed.toFixed(1)} 分鐘，窗口已關閉，跳過`);
        return;
    }

    // 貔貅幣 check：Base/Quote 流動性比例
    if (dexData.liq_base > 0 && dexData.liq_quote > 0) {
        const liqRatio = dexData.liq_quote / dexData.liq_base;
        if (liqRatio < 0.2) {
            console.log(`🚫 [GradMonitor] ${symbol} Base/Quote 比例 ${liqRatio.toFixed(2)} < 0.2，疑似貔貅幣，跳過`);
            return;
        }
    }

    // 寫入 trending_pool（後面的 trendingJob 流程完全唔變）
    const tokenData = {
        ...dexData,
        had_lp_burn:           safetyResult.hadLpBurn,
        mins_since_graduation: minsElapsed,
        updated_at:            new Date().toISOString(),
    };

    const { error } = await supabase
        .from('trending_pool')
        .upsert([tokenData], { onConflict: 'mint_address' });

    if (error) {
        console.error(`❌ [GradMonitor] 寫入 trending_pool 失敗: ${error.message}`);
    } else {
        console.log(`✅ [GradMonitor] ${symbol} 已寫入 trending_pool！流動性: $${dexData.liquidity.toFixed(0)} | 畢業後 ${minsElapsed.toFixed(1)} 分鐘`);
    }
}

// ------------------------------------------------------------------
// 4. WebSocket 連線管理（自動重連）
// ------------------------------------------------------------------
function connect() {
    if (wsInstance) {
        try { wsInstance.terminate(); } catch (_) {}
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    console.log('🔌 [GradMonitor] 連接 pumpportal.fun WebSocket...');
    wsInstance = new WebSocket(PUMPPORTAL_WS_URL);

    wsInstance.on('open', () => {
        console.log('✅ [GradMonitor] WebSocket 已連線，訂閱 Migration 事件...');
        // 訂閱畢業事件（免費，唔需要 API key）
        wsInstance.send(JSON.stringify({ method: 'subscribeMigration' }));
    });

    wsInstance.on('message', (rawData) => {
        try {
            const event = JSON.parse(rawData.toString());
            // Migration 事件的 txType 係 'migrate'
            if (event.txType === 'migrate' || event.type === 'migration') {
                handleGraduationEvent(event).catch(err => {
                    console.error(`❌ [GradMonitor] 處理畢業事件失敗: ${err.message}`);
                });
            }
        } catch (err) {
            // 忽略 parse 錯誤
        }
    });

    wsInstance.on('close', (code, reason) => {
        console.warn(`⚠️ [GradMonitor] WebSocket 斷線 (code: ${code})，30 秒後重連...`);
        reconnectTimer = setTimeout(() => {
            if (isRunning) connect();
        }, 30000);
    });

    wsInstance.on('error', (err) => {
        console.error(`❌ [GradMonitor] WebSocket 錯誤: ${err.message}`);
        // error 後 close 事件會自動觸發重連
    });

    // 心跳（防止空閒斷線）
    const heartbeat = setInterval(() => {
        if (wsInstance.readyState === WebSocket.OPEN) {
            wsInstance.ping();
        } else {
            clearInterval(heartbeat);
        }
    }, 30000);
}

// ------------------------------------------------------------------
// 5. 對外介面（同 trendingMonitorService 一樣的 start() 格式）
// ------------------------------------------------------------------
const pumpfunGraduationMonitor = {
    start() {
        if (isRunning) {
            console.log('⚠️ [GradMonitor] 已在運行，跳過重複啟動');
            return;
        }
        isRunning = true;
        console.log('🎓 [GradMonitor] Pump.fun 畢業監控器啟動 (PumpSwap 版)...');
        connect();
    },

    stop() {
        isRunning = false;
        if (wsInstance) wsInstance.terminate();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        console.log('🛑 [GradMonitor] 已停止');
    }
};

module.exports = { pumpfunGraduationMonitor };