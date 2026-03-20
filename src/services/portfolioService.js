// src/services/portfolioService.js
const { supabase } = require('../config/supabase'); 
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const path = require('path');
const { healthMonitor } = require('./healthMonitor'); // 🩺 引入健康看板

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const walletPublicKey = process.env.MY_WALLET_PUBLIC_KEY ? new PublicKey(process.env.MY_WALLET_PUBLIC_KEY) : null;

let my_portfolio = {
    mode: 'PAPER',
    cash_sol: 0,
    reference_capital: 10,
    nav_sol: 0,
    positions: [],
    last_sync: null
};

// 儲存全域 max_positions
let globalMaxPositions = 8; 

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
        console.log("🏰 [Portfolio] 正在初始化記憶體並執行變量對齊...");
        await updateSystemStatus("🔄 正在初始化記憶體...");
        
        const { data: config, error: configErr } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        if (configErr) throw configErr;

        my_portfolio.mode = config ? (config.trade_mode || 'PAPER') : 'PAPER';
        globalMaxPositions = config?.max_positions || 8; // 讀取總倉位上限

        const tableName = my_portfolio.mode === 'PAPER' ? 'active_positions_paper' : 'active_positions_live';

        if (my_portfolio.mode === 'PAPER') {
            my_portfolio.reference_capital = config?.reference_capital || 10;
            my_portfolio.cash_sol = config?.simulated_balance || 10;
        } else if (walletPublicKey) {
            const lamports = await connection.getBalance(walletPublicKey);
            const liveSol = lamports / 1e9;
            my_portfolio.cash_sol = liveSol;
            my_portfolio.reference_capital = liveSol; 
            await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
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
        console.log(`📊 [Portfolio] 資金鎖設定完畢。總額度: ${globalMaxPositions} (新幣: ${getPositionLimits().maxMeme}, 老幣: ${getPositionLimits().maxBluechip})`);
        
        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
        healthMonitor.setStatus('Portfolio_Cache', `🔴 載入失敗: ${err.message}`);
        return null;
    }
}

async function syncLiveBalanceToDB() {
    if (my_portfolio.mode === 'LIVE' && walletPublicKey) {
        try {
            const lamports = await connection.getBalance(walletPublicKey);
            const liveSol = lamports / 1e9;
            my_portfolio.cash_sol = liveSol;
            await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
        } catch (err) {}
    }
}

function getPortfolio() { return my_portfolio; }

// ==========================================
// 🛡️ V5.5 核心：資金與倉位絕對鎖 (The Money Gate)
// ==========================================

/**
 * 獲取動態倉位上限 (單雙數 5:5 智能分配，單數側重新幣)
 */
function getPositionLimits() {
    return {
        maxMeme: Math.ceil(globalMaxPositions / 2),
        maxBluechip: Math.floor(globalMaxPositions / 2)
    };
}

/**
 * 獲取當前 Meme 幣 (新幣 + 接回) 的持倉數量
 * 標籤對應: MEME_HUNTER, MEME_REENTRY
 */
function getMemeCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('MEME')
    ).length;
}

/**
 * 獲取當前 老幣波段 的持倉數量
 * 標籤對應: BLUECHIP_SWING
 */
function getBlueChipCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('BLUECHIP')
    ).length;
}

// ==========================================

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
    getBlueChipCount,
    getPositionLimits
};