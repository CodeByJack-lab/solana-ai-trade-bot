// src/services/portfolioService.js
const { supabase } = require('../config/supabase'); 
const { connection } = require('../config/solana');
const { PublicKey, Keypair } = require('@solana/web3.js'); 
const { healthMonitor } = require('./healthMonitor');
const configEnv = require('../config/env'); // 👈 引入彈藥庫

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

let walletPublicKey = null;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            walletPublicKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))).publicKey;
        } else {
            walletPublicKey = Keypair.fromSecretKey(bs58.decode(rawKey)).publicKey;
        }
    }
} catch (e) {
    console.error("⚠️ [Portfolio] 無法解析 Private Key，實盤餘額將無法同步");
}

// ... (保留上面嘅 imports 同 wallet 處理) ...

let my_portfolio = {
    mode: 'PAPER',
    cash_sol: 0,
    reference_capital: 10,
    nav_sol: 0,
    positions: [],
    last_sync: null
};

// 🌟 V8.2 新增：全域保存 Database 設定嘅倉位上限
let limitsCache = {
    maxMeme: 2,
    maxTrending: 3,
    maxBluechip: 0 // 永久歸零
};

async function updateSystemStatus(msg) {
    try {
        await supabase.from('bot_status').update({ 
            message: msg,
            updated_at: new Date()
        }).eq('id', 1);
        healthMonitor.setStatus('Supabase_DB', '🟢 連線正常');
    } catch (err) {
        healthMonitor.setStatus('Supabase_DB', `🔴 寫入失敗: ${err.message}`);
    }
}

async function initPortfolio() {
    try {
        console.log("🏰 [Portfolio] 正在初始化記憶體並執行上帝視角對齊...");
        await updateSystemStatus("🔄 正在初始化記憶體...");
        
        const { data: config, error: configErr } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        if (configErr) throw configErr;

        my_portfolio.mode = config ? (config.trade_mode || 'PAPER') : 'PAPER';
        
        // 🌟 V8.2 升級：直接讀取 Dashboard 設定嘅倉位上限 (上帝視角)
        limitsCache.maxMeme = config?.max_meme_positions || 2;
        limitsCache.maxTrending = config?.max_trending_positions || 3;

        const tableName = my_portfolio.mode === 'PAPER' ? 'active_positions_paper' : 'active_positions_live';

        // ⚠️ V8.2 升級：禁止喺平時巡邏/初始化時 Call getBalance 查真倉！
        // 如果係 LIVE 模式，直接讀取 DB 上次紀錄嘅 live_wallet_balance
        if (my_portfolio.mode === 'LIVE') {
             my_portfolio.cash_sol = config?.live_wallet_balance || 0;
             my_portfolio.reference_capital = my_portfolio.cash_sol;
             console.log(`💰 [Portfolio] LIVE 模式：從 DB 讀取上次真倉餘額 (${my_portfolio.cash_sol} SOL)，跳過 RPC 查詢。`);
        }

        if (my_portfolio.mode === 'PAPER') {
            my_portfolio.reference_capital = config?.reference_capital || 10;
            my_portfolio.cash_sol = config?.simulated_balance || 10;
        }

        const { data: positions } = await supabase.from(tableName).select('*');
        
        my_portfolio.positions = (positions || []).map(pos => ({
            ...pos,
            quantity: parseFloat(pos.quantity || pos.amount || 0),
            entry_price_sol: parseFloat(pos.entry_price_sol),
            highest_price_sol: parseFloat(pos.highest_price_sol || pos.entry_price_sol || 0),
            strategy_type: pos.strategy_type || 'UNKNOWN' 
        }));

        my_portfolio.nav_sol = my_portfolio.cash_sol; 
        my_portfolio.last_sync = new Date();

        healthMonitor.setStatus('Portfolio_Cache', '🟢 載入完成');
        console.log(`📊 [Portfolio] 上帝視角鎖設定完畢。額度 -> (Meme 敢死隊: ${limitsCache.maxMeme}, Top 100 提款機: ${limitsCache.maxTrending})`);
        
        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
        healthMonitor.setStatus('Portfolio_Cache', `🔴 載入失敗: ${err.message}`);
        return null;
    }
}

// ⚠️ V8.2 升級：廢除平時 Sync Live Balance，只允許喺真正交易後被 TradeService 呼叫
async function syncLiveBalanceToDB() {
    if (walletPublicKey) {
        try {
            const lamports = await connection.getBalance(walletPublicKey);
            const liveSol = lamports / 1e9;
            await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
            if (my_portfolio.mode === 'LIVE') {
                my_portfolio.cash_sol = liveSol;
            }
            console.log(`🏦 [RPC] 已成功同步最新真倉餘額: ${liveSol} SOL`);
        } catch (err) {
            console.error("⚠️ [RPC Error] 同步真倉餘額失敗:", err.message);
        }
    }
}

function getPortfolio() { return my_portfolio; }

// 🌟 獲取全域倉位限制
function getPositionLimits() {
    return limitsCache;
}

function getMemeCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && (p.strategy_type.includes('MEME_SNIPE') || p.strategy_type.includes('MEME_BLIND'))
    ).length;
}

function getTrendingCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('TRENDING')
    ).length;
}

function getBlueChipCount() {
    return 0; // 老幣已火化
}

// ... (保留 updateCache 函數) ...
function updateCache(action, solAmount, positionData = null) {
    if (action === 'BUY') {
        my_portfolio.cash_sol -= solAmount;
        if (positionData) {
            const safePos = { 
                ...positionData, 
                quantity: parseFloat(positionData.quantity || positionData.amount || 0) 
            };
            my_portfolio.positions.push(safePos);
        }
    } else if (action === 'SELL') {
        my_portfolio.cash_sol += solAmount;
        if (positionData) {
            my_portfolio.positions = my_portfolio.positions.filter(p => p.mint_address !== positionData.mint_address);
        }
    }
}

module.exports = { 
    initPortfolio, 
    getPortfolio, 
    updateCache, 
    syncLiveBalanceToDB, 
    updateSystemStatus,
    getMemeCount,
    getTrendingCount, 
    getBlueChipCount,
    getPositionLimits,
    canBuyMeme: () => getMemeCount() < limitsCache.maxMeme,
    canBuyTrending: () => getTrendingCount() < limitsCache.maxTrending,
    canBuyBluechip: () => false // 永久禁止買入
};