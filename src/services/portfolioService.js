const { supabase } = require('../config/supabase'); 
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const path = require('path');
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

/**
 * 📢 狀態廣播器 (物理隔離版)
 */
async function updateSystemStatus(msg) {
    try {
        await supabase.from('bot_status').update({ 
            message: msg,
            updated_at: new Date()
        }).eq('id', 1);
    } catch (err) {}
}

async function initPortfolio() {
    try {
        console.log("🏰 [Portfolio] 正在初始化記憶體並執行變量對齊...");
        await updateSystemStatus("🔄 正在初始化記憶體...");

        const { data: config, error: configErr } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        if (configErr) throw configErr;

        my_portfolio.mode = config ? (config.trade_mode || 'PAPER') : 'PAPER';
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
        
        // 🛠️ 核心修復：確保全系統統一使用 quantity，兼容舊資料的 amount
        my_portfolio.positions = (positions || []).map(pos => ({
            ...pos,
            quantity: parseFloat(pos.quantity || pos.amount || 0),
            entry_price_sol: parseFloat(pos.entry_price_sol),
            highest_price_sol: parseFloat(pos.highest_price_sol || pos.entry_price_sol || 0)
        }));

        my_portfolio.nav_sol = my_portfolio.cash_sol; 
        my_portfolio.last_sync = new Date();

        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
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

function updateCache(action, solAmount, positionData = null) {
    if (action === 'BUY') {
        my_portfolio.cash_sol -= solAmount;
        if (positionData) {
            // 寫入記憶體時，強制使用 quantity
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

module.exports = { initPortfolio, getPortfolio, updateCache, syncLiveBalanceToDB, updateSystemStatus };