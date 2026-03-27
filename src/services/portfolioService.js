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

let my_portfolio = {
    mode: 'PAPER',
    cash_sol: 0,
    reference_capital: 10,
    nav_sol: 0,
    positions: [],
    last_sync: null
};

let globalMaxPositions = 10;

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

        if (walletPublicKey) {
            try {
                const lamports = await connection.getBalance(walletPublicKey);
                const liveSol = lamports / 1e9;
                await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
                
                if (my_portfolio.mode === 'LIVE') {
                    my_portfolio.cash_sol = liveSol;
                    my_portfolio.reference_capital = liveSol;
                }
            } catch (chainErr) {
                console.error("⚠️ [Portfolio] 獲取鏈上真實餘額失敗:", chainErr.message);
            }
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
        const limits = getPositionLimits();
        console.log(`📊 [Portfolio] 資金鎖設定完畢。總額度: ${globalMaxPositions} (老幣: ${limits.maxBluechip}, Trending: ${limits.maxTrending}, 新幣: ${limits.maxMeme})`);
        
        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
        healthMonitor.setStatus('Portfolio_Cache', `🔴 載入失敗: ${err.message}`);
        return null;
    }
}

async function syncLiveBalanceToDB() {
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

function getPositionLimits() {
    const maxBluechip = Math.floor(globalMaxPositions * 0.2); // 10 * 0.2 = 2 (老幣)
    const maxTrending = Math.floor(globalMaxPositions * 0.6); // 10 * 0.6 = 6 (Top60) 👈 改呢度
    const maxMeme = globalMaxPositions - maxBluechip - maxTrending; // 10 - 2 - 6 = 2 (新幣)
    return { maxMeme, maxTrending, maxBluechip };
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
    getTrendingCount, 
    getBlueChipCount,
    getPositionLimits,
    canBuyMeme: () => getMemeCount() < getPositionLimits().maxMeme,
    canBuyTrending: () => getTrendingCount() < getPositionLimits().maxTrending,
    canBuyBluechip: () => getBlueChipCount() < getPositionLimits().maxBluechip
};