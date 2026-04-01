// src/services/portfolioService.js
// 📝 檔案功能用途：倉位與資產大管家。維護 RAM 中的持倉狀態，控制 Meme 與 Trending 雙軌額度，防止資金互相擠佔。

const { supabase } = require('../config/supabase'); 
const { connection } = require('../config/solana');
const { PublicKey, Keypair } = require('@solana/web3.js'); 
const { healthMonitor } = require('./healthMonitor');
const configEnv = require('../config/config'); 

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

let my_portfolio = {
    mode: 'PAPER',
    cash_sol: 0,
    reference_capital: 10,
    nav_sol: 0,
    positions: [],
    last_sync: null
};

// 🌟 全域保存 Database 設定嘅倉位上限
let limitsCache = {
    maxMeme: 2,
    maxTrending: 3
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
        
        // 🌟 直接讀取 Dashboard 設定嘅倉位上限 (上帝視角)
        limitsCache.maxMeme = config?.max_meme_positions || 2;
        limitsCache.maxTrending = config?.max_trending_positions || 3;

        const tableName = my_portfolio.mode === 'PAPER' ? 'active_positions_paper' : 'active_positions_live';

        // ⚠️ 禁止平時巡邏查真倉！直接讀取 DB 上次紀錄
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

// ⚠️ 只允許喺真正交易後被 TradeService 呼叫
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

function getPositionLimits() { return limitsCache; }

function getMemeCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && (p.strategy_type.includes('MEME_SNIPE') || p.strategy_type.includes('MEME_BLIND') || p.strategy_type === 'MEME')
    ).length;
}

function getTrendingCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('TRENDING')
    ).length;
}

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

// 🧹 [新增] 專門用來清洗模擬盤記憶體 (一鍵失憶)
async function resetPaperMemory() {
    if (portfolio.mode !== 'PAPER') return;
    
    // 1. 強制清空記憶體中的持倉
    portfolio.positions = [];
    
    // 2. 重新去資料庫讀取 (因為資料庫已經被 Dashboard 清空，所以會讀返 0 出嚟)
    try {
        const { supabase } = require('../config/supabase');
        const { data: dbConfig } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
        if (dbConfig) portfolio.cash_sol = dbConfig.simulated_balance;
        console.log(`🧠 [Portfolio] 記憶體已被強制重置！目前模擬盤餘額: ${portfolio.cash_sol} SOL，持倉數: 0`);
    } catch (e) {
        console.error("無法重置 Portfolio 餘額:", e.message);
    }
}

module.exports = { 
    initPortfolio, 
    getPortfolio, 
    updateCache, 
    resetPaperMemory, 
    syncLiveBalanceToDB, 
    updateSystemStatus,
    getMemeCount,
    getTrendingCount, 
    getPositionLimits,
    canBuyMeme: () => getMemeCount() < limitsCache.maxMeme,
    canBuyTrending: () => getTrendingCount() < limitsCache.maxTrending
};