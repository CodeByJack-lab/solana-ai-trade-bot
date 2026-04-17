// src/services/portfolioService.js
// 📝 檔案功能用途：倉位與資產大管家。維護 RAM 中的持倉狀態，控制 Meme 與 Trending 雙軌額度。
// 🚀 V10 實裝：真・鏈上同步心跳，確保實盤數據與 RPC 節點自動對齊。
// 🛡️ 終極修復：加入跨進程記憶體同步，並實裝「防無限 Listener 護盾」杜絕 OOM，以及修復 limitsCache 未定義錯誤。
// 👻 幽靈殺手：全面改用 Incremental Payload 更新 RAM，徹底杜絕 SELECT * 導致的異步幽靈倉位復活現象！
// ⚖️ 會計校準：新增 Auto-Calibration 機制，每次啟動自動根據本金、歷史利潤及持倉成本，完美修復 simulated_balance。

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

let limitsCache = {
    maxMeme: 2,
    maxTrending: 3
};

setInterval(async () => {
    try {
        const { data: dbConfig } = await supabase
            .from('system_config')
            .select('max_meme_positions, max_trending_positions')
            .eq('id', 1)
            .single();
            
        if (dbConfig) {
            if (dbConfig.max_meme_positions !== null) limitsCache.maxMeme = dbConfig.max_meme_positions;
            if (dbConfig.max_trending_positions !== null) limitsCache.maxTrending = dbConfig.max_trending_positions;
        }
    } catch (e) {}
}, 30000);

async function updateSystemStatus(msg) {
    try {
        await supabase.from('bot_status').update({ message: msg, updated_at: new Date() }).eq('id', 1);
        healthMonitor.setStatus('Supabase_DB', '🟢 連線正常');
    } catch (err) {
        healthMonitor.setStatus('Supabase_DB', `🔴 寫入失敗: ${err.message}`);
    }
}

async function initPortfolio() {
    try {
        console.log("🏰 [Portfolio] 正在初始化記憶體並執行上帝視角對齊...");
        
        const { data: config, error: configErr } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        if (configErr) throw configErr;

        my_portfolio.mode = config ? (config.trade_mode || 'PAPER') : 'PAPER';
        
        limitsCache.maxMeme = config?.max_meme_positions || 2;
        limitsCache.maxTrending = config?.max_trending_positions || 3;

        const tableName = my_portfolio.mode === 'PAPER' ? 'active_positions_paper' : 'active_positions_live';

        if (my_portfolio.mode === 'LIVE') {
             my_portfolio.cash_sol = config?.live_wallet_balance || 0;
             my_portfolio.reference_capital = my_portfolio.cash_sol;
             syncLiveBalanceToDB(); 
        } else {
            my_portfolio.reference_capital = config?.reference_capital || 10;
            
            // ⚖️ 核心升級：自動校準模擬資金 (Auto-Calibration)
            try {
                // 1. 計算已實現利潤 (Realized PnL)
                const { data: history } = await supabase.from('trade_history_paper')
                    .select('realized_pnl_sol')
                    .like('action', 'SELL%');
                const totalRealizedPnl = (history || []).reduce((sum, record) => sum + (parseFloat(record.realized_pnl_sol) || 0), 0);

                // 2. 計算目前持倉總成本 (Total Invested)
                const { data: activePos } = await supabase.from('active_positions_paper')
                    .select('quantity, entry_price_sol');
                const totalInvested = (activePos || []).reduce((sum, pos) => sum + ((parseFloat(pos.quantity) || 0) * (parseFloat(pos.entry_price_sol) || 0)), 0);

                // 3. 計算數學正確餘額: 初始本金 + 歷史利潤 - 目前未平倉押注
                const expectedBalance = my_portfolio.reference_capital + totalRealizedPnl - totalInvested;
                const currentDbBalance = parseFloat(config?.simulated_balance || 0);

                // 4. 如果發現資料庫餘額偏差大於 0.0001 SOL，自動修復並寫入 DB
                if (Math.abs(expectedBalance - currentDbBalance) > 0.0001) {
                    console.log(`🛠️ [Auto-Calibration] 發現模擬餘額偏差，自動修復中...`);
                    console.log(`   - 初始本金: ${my_portfolio.reference_capital} SOL`);
                    console.log(`   - 歷史總利潤: ${totalRealizedPnl.toFixed(4)} SOL`);
                    console.log(`   - 持倉總成本: ${totalInvested.toFixed(4)} SOL`);
                    console.log(`   - 校正餘額: ${currentDbBalance.toFixed(4)} -> ${expectedBalance.toFixed(4)} SOL`);
                    
                    await supabase.from('system_config').update({ simulated_balance: expectedBalance }).eq('id', 1);
                    my_portfolio.cash_sol = expectedBalance;
                } else {
                    my_portfolio.cash_sol = currentDbBalance;
                }
            } catch (calErr) {
                console.warn(`⚠️ [Auto-Calibration] 會計校準失敗，退回使用資料庫原值:`, calErr.message);
                my_portfolio.cash_sol = config?.simulated_balance || 10;
            }
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

        await supabase.removeChannel(supabase.channel('portfolio_cross_sync'));

        supabase.channel('portfolio_cross_sync')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: tableName }, (payload) => {
                const exists = my_portfolio.positions.some(p => p.mint_address === payload.new.mint_address);
                if (!exists) {
                    my_portfolio.positions.push({
                        ...payload.new,
                        quantity: parseFloat(payload.new.quantity || payload.new.amount || 0),
                        entry_price_sol: parseFloat(payload.new.entry_price_sol || 0),
                        highest_price_sol: parseFloat(payload.new.highest_price_sol || payload.new.entry_price_sol || 0),
                        strategy_type: payload.new.strategy_type || 'UNKNOWN'
                    });
                }
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: tableName }, (payload) => {
                my_portfolio.positions = my_portfolio.positions.filter(p => p.mint_address !== payload.old.mint_address);
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: tableName }, (payload) => {
                const idx = my_portfolio.positions.findIndex(p => p.mint_address === payload.new.mint_address);
                if (idx > -1) {
                    my_portfolio.positions[idx] = {
                        ...my_portfolio.positions[idx],
                        ...payload.new,
                        quantity: parseFloat(payload.new.quantity || payload.new.amount || 0),
                        highest_price_sol: parseFloat(payload.new.highest_price_sol || my_portfolio.positions[idx].highest_price_sol),
                        strategy_type: payload.new.strategy_type || my_portfolio.positions[idx].strategy_type
                    };
                }
            })
            .subscribe();

        healthMonitor.setStatus('Portfolio_Cache', '🟢 載入完成');
        return my_portfolio;
    } catch (err) {
        console.error("❌ [Portfolio] 失敗:", err.message);
        healthMonitor.setStatus('Portfolio_Cache', `🔴 載入失敗: ${err.message}`);
        return null;
    }
}

let isHeartbeatStarted = false;
if (!isHeartbeatStarted) {
    setInterval(() => {
        if (my_portfolio.mode === 'LIVE') syncLiveBalanceToDB();
    }, 30000);
    isHeartbeatStarted = true;
}

async function syncLiveBalanceToDB() {
    if (walletPublicKey) {
        try {
            const lamports = await connection.getBalance(walletPublicKey);
            const liveSol = lamports / 1e9;
            await supabase.from('system_config').update({ live_wallet_balance: liveSol }).eq('id', 1);
            
            if (my_portfolio.mode === 'LIVE') {
                my_portfolio.cash_sol = liveSol;
                my_portfolio.nav_sol = liveSol;
            }
        } catch (err) {}
    }
}

function getPortfolio() { return my_portfolio; }
function getPositionLimits() { return limitsCache; }

function getMemeCount() {
    return my_portfolio.positions.filter(p => p.strategy_type && (p.strategy_type.includes('MEME') || p.strategy_type.includes('NEWBORN') || p.strategy_type.includes('v10'))).length;
}

function getTrendingCount() {
    return my_portfolio.positions.filter(p => p.strategy_type && p.strategy_type.includes('TRENDING')).length;
}

function updateCache(action, solAmount, positionData = null) {
    if (action === 'BUY') {
        my_portfolio.cash_sol -= solAmount;
        if (positionData) {
            const safePos = { ...positionData, quantity: parseFloat(positionData.quantity || positionData.amount || 0) };
            my_portfolio.positions.push(safePos);
        }
    } else if (action === 'SELL') {
        my_portfolio.cash_sol += solAmount;
    }
}

async function resetPaperMemory() {
    if (my_portfolio.mode !== 'PAPER') return;
    my_portfolio.positions = [];
    try {
        const { data: dbConfig } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
        if (dbConfig) my_portfolio.cash_sol = dbConfig.simulated_balance;
    } catch (e) {}
}

module.exports = { 
    initPortfolio, getPortfolio, updateCache, resetPaperMemory, syncLiveBalanceToDB, updateSystemStatus,
    getMemeCount, getTrendingCount, getPositionLimits,
    canBuyMeme: () => getMemeCount() < limitsCache.maxMeme,
    canBuyTrending: () => getTrendingCount() < limitsCache.maxTrending
};