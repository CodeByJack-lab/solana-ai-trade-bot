// src/services/portfolioService.js
const { supabase } = require('../config/supabase'); 
const { connection } = require('../config/solana');
const { PublicKey, Keypair } = require('@solana/web3.js'); // 🚀 加入 Keypair
const path = require('path');
const { healthMonitor } = require('./healthMonitor');

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 🚀 FIX 1: 直接由 Private Key 推算 Public Key，免除 .env 填漏風險
let walletPublicKey = null;
try {
    const rawKey = process.env.SOLANA_PRIVATE_KEY ? process.env.SOLANA_PRIVATE_KEY.trim() : null;
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
        globalMaxPositions = config?.max_positions || 8; 

        const tableName = my_portfolio.mode === 'PAPER' ? 'active_positions_paper' : 'active_positions_live';

        // 🚀 FIX 2: 無論 LIVE 定 PAPER，都在後台默默更新一次真錢餘額畀 Dashboard 睇！
        if (walletPublicKey) {
            try {
                const lamports = await connection.getBalance(walletPublicKey);
                const liveSol = lamports / 1e9;
                await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
                
                // 如果真正打緊真軍，先將內部 cash_sol 指向真錢
                if (my_portfolio.mode === 'LIVE') {
                    my_portfolio.cash_sol = liveSol;
                    my_portfolio.reference_capital = liveSol;
                }
            } catch (chainErr) {
                console.error("⚠️ [Portfolio] 獲取鏈上真實餘額失敗:", chainErr.message);
            }
        }

        // 如果係模擬模式，內部運作資金用返模擬數字
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
        console.log(`📊 [Portfolio] 資金鎖設定完畢。總額度: ${globalMaxPositions} (新幣: ${getPositionLimits().maxMeme}, 老幣: ${getPositionLimits().maxBluechip})`);
        
        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
        healthMonitor.setStatus('Portfolio_Cache', `🔴 載入失敗: ${err.message}`);
        return null;
    }
}

async function syncLiveBalanceToDB() {
    // 🚀 FIX 3: 定時同步亦都不受 PAPER 模式限制，確保 Dashboard 一直見到真錢跳動
    if (walletPublicKey) {
        try {
            const lamports = await connection.getBalance(walletPublicKey);
            const liveSol = lamports / 1e9;
            await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
            if (my_portfolio.mode === 'LIVE') {
                my_portfolio.cash_sol = liveSol;
            }
        } catch (err) {}
    }
}

function getPortfolio() { return my_portfolio; }

// ==========================================
// 🛡️ V5.5 核心：資金與倉位絕對鎖 (The Money Gate)
// ==========================================

function getPositionLimits() {
    const maxMeme = Math.ceil(globalMaxPositions * 0.6); 
    const maxBluechip = globalMaxPositions - maxMeme;
    return { maxMeme, maxBluechip };
}

function getMemeCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('MEME')
    ).length;
}

function getBlueChipCount() {
    return my_portfolio.positions.filter(p => 
        p.strategy_type && p.strategy_type.includes('BLUECHIP')
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