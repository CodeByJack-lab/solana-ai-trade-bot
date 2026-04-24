// src/services/tradeService.js
// 📝 檔案功能及用途：V10.40 交易執行大腦 (零影子極速結算版)
// 🚀 核心升級：模擬盤平倉強制提取 Jupiter 真實報價結算盈虧，徹底消滅 0% PnL 幻象。
// 🛡️ 數據防護：強制寫入 review_history (平倉原因) 及 hold_time_mins，確保歷史數據完整。
// 📊 ML 對接：全面寫入 applied_ml_strategy_id 供 Python 進行回測。
// 🚨 極限逃生：加入動態 Slippage (Dynamic Slippage)，遇緊急止損將滑點放寬至 50% 確保成交。
// ✂️ 邏輯精簡：徹底移除 Shadow 倉位相關判斷與 DB 操作，加快平倉與結算速度。

require('dotenv').config();
const axios = require('axios');
const Redis = require('ioredis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PublicKey } = require('@solana/web3.js'); 
const { connection } = require('../config/solana'); 
const { getPortfolio, updateCache } = require('./portfolioService');
const { sendTelegramAlert } = require('./telegramService');
const { fallbackEscapeService } = require('./fallbackEscapeService');
const { executeLiveSwapUAT } = require('./liveTradeService');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function getJupiterFinalQuote(mint, isBuy, amount, slippageBps, strategyType = 'NEWBORN', knownDecimals = null) {
    try {
        const inputMint = isBuy ? SOL_MINT : mint;
        const outputMint = isBuy ? mint : SOL_MINT;
        
        let tokenDecimals = knownDecimals;
        if (tokenDecimals === null) {
            try {
                const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
                tokenDecimals = mintInfo.value?.data?.parsed?.info?.decimals;
                if (tokenDecimals === undefined) tokenDecimals = 6; 
            } catch(e) {
                tokenDecimals = 6;
            }
        }

        const inputDecimals = isBuy ? 9 : tokenDecimals;
        const outputDecimals = isBuy ? tokenDecimals : 9;

        const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

        let url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
        
        if (strategyType.includes('NEWBORN') || strategyType.includes('MEME') || strategyType.includes('v10')) {
            url += `&onlyDirectRoutes=true`;
        }

        const res = await axios.get(url, { timeout: 3000 });
        if (res.data && res.data.outAmount) {
            const outLamports = parseFloat(res.data.outAmount);
            
            const outAmountUi = outLamports / Math.pow(10, outputDecimals);
            const inAmountUi = amount; 
            
            const pricePerToken = isBuy 
                ? inAmountUi / outAmountUi
                : outAmountUi / inAmountUi;

            return {
                quoteResponse: res.data,
                pricePerToken: pricePerToken,
                decimals: tokenDecimals 
            };
        }
        return null;
    } catch (e) {
        console.warn(`❌ [Jupiter Quote] 獲取 ${mint} 報價失敗:`, e.response?.data || e.message);
        return null;
    }
}

async function executeBuy(mint, symbol, strategyVersion, aiScore, reason, finalTradeAmountSol, marketData, envState, appliedMlStrategyId = 0, safeMultiplier = 1.0) {
    try {
        console.log(`🛒 [Trade Service] 準備買入 ${symbol} (${mint}) | 分數: ${aiScore} | 注碼: ${finalTradeAmountSol} SOL`);

        const { data: sysConfig } = await supabase.from('system_config').select('trade_mode').eq('id', 1).single();
        const mode = sysConfig ? (sysConfig.trade_mode || 'PAPER') : 'PAPER';

        if (mode === 'SHUTDOWN') {
            console.log(`⏸️ [Trade Service] 系統處於休眠狀態，拒絕下單。`);
            return false;
        }

        if (mode === 'PAPER') {
            const { data: preCheck } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
            if (parseFloat(preCheck?.simulated_balance || 0) < finalTradeAmountSol) {
                console.error(`❌ [Trade Service] 模擬資金不足，拒絕下單！`);
                return false;
            }
        }

        const quote = await getJupiterFinalQuote(mint, true, finalTradeAmountSol, 500, strategyVersion);
        if (!quote || !quote.quoteResponse) {
            console.log(`⚠️ [Trade Service] 無法獲取 ${symbol} 的 Jupiter 買入報價，放棄交易。`);
            return false;
        }

        const entryPrice = quote.pricePerToken;
        const actualDecimals = quote.decimals || 6;
        
        if (isNaN(entryPrice) || entryPrice <= 0 || !isFinite(entryPrice)) {
            console.error(`💀 [Trade Service] 致命計算錯誤：${symbol} 入場價異常。拒絕執行！`);
            return false;
        }

        let txid = `BUY_${crypto.randomBytes(3).toString('hex').toUpperCase()}`; 

        if (mode === 'LIVE') {
            console.log(`⚡ [Live Engine] 觸發實盤買入: ${symbol}`);
            const buyResult = await executeLiveSwapUAT(quote.quoteResponse, 'BUY', reason);
            
            if (buyResult && buyResult.success) {
                txid = buyResult.txid;
                console.log(`🎉 [Live Trade] ${symbol} 真實買入成功！TX: ${txid}`);
            } else {
                console.error(`❌ [Live Trade] ${symbol} 真實買入失敗或超時，中止建倉！`);
                return false; 
            }
        } else {
            const { data: freshConfig } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
            const newBalance = parseFloat(freshConfig?.simulated_balance || 0) - finalTradeAmountSol;
            await supabase.from('system_config').update({ simulated_balance: newBalance }).eq('id', 1);
            updateCache('BUY', finalTradeAmountSol); 
        }

        const positionData = {
            mint_address: mint,
            token_symbol: symbol,
            strategy_type: strategyVersion,
            entry_price_sol: entryPrice,
            highest_price_sol: entryPrice,
            quantity: (finalTradeAmountSol / entryPrice),
            token_decimals: actualDecimals, 
            ai_score: aiScore,
            ai_reason: reason,
            buy_dex_label: mode === 'LIVE' ? 'JUPITER_LIVE' : 'JUPITER_PAPER', 
            market_climate: envState.climate || 'UNKNOWN',
            entry_liquidity_usd: marketData.l || 0,
            entry_volume_5m_usd: marketData.v || 0,
            entry_ofi: marketData.b && marketData.s ? (marketData.b - marketData.s) / (marketData.b + marketData.s) : 0,
            applied_ml_strategy_id: appliedMlStrategyId
        };

        const tableName = mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
        const { error: insertErr } = await supabase.from(tableName).insert([positionData]);
        
        if (insertErr) {
            console.error(`❌ [Main Route] 寫入 ${tableName} 失敗:`, insertErr.message);
            if (mode === 'PAPER') {
                const { data: rollbackConfig } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
                const revertedBalance = parseFloat(rollbackConfig?.simulated_balance || 0) + finalTradeAmountSol;
                await supabase.from('system_config').update({ simulated_balance: revertedBalance }).eq('id', 1);
            }
            return false; 
        }
        
        console.log(`⚔️ [Main Route] ${symbol} 已建立 ${mode} 倉位 (Decimals: ${actualDecimals})！`);
        
        const historyTable = mode === 'LIVE' ? 'trade_history_live' : 'trade_history_paper';
        await supabase.from(historyTable).insert([{
            token_mint: mint,
            token_symbol: symbol,
            action: 'BUY',
            strategy_type: strategyVersion,
            ai_score: aiScore,
            review_history: reason,
            price_sol: entryPrice,
            quantity: (finalTradeAmountSol / entryPrice),
            total_value_sol: finalTradeAmountSol,
            realized_pnl_pct: 0,
            realized_pnl_sol: 0,
            txid: txid, 
            market_climate: envState.climate || 'UNKNOWN',
            entry_liquidity_usd: marketData.l || 0,
            entry_volume_5m_usd: marketData.v || 0,
            entry_ofi: marketData.b && marketData.s ? (marketData.b - marketData.s) / (marketData.b + marketData.s) : 0,
            applied_ml_strategy_id: appliedMlStrategyId,
            ml_confidence_multiplier: safeMultiplier     
        }]);

        if (typeof sendTelegramAlert === 'function') {
            const modeText = mode === 'LIVE' ? '[實盤]' : '[模擬]';
            const catText = strategyVersion.includes('TRENDING') ? '🔥 TRENDING' : '🐣 NEWBORN';
            const msg = `🟢 ${modeText} ✅ 買入成功\n🏷️ 類別: ${catText}\n🪙 代幣: $${symbol}\n💰 投入: ${finalTradeAmountSol} SOL\n🔗 TX: <code>${txid}</code>\n🧠 理由: ${reason}`;
            await sendTelegramAlert(msg);
        }
        return true;
    } catch (err) {
        console.error(`❌ [Trade Service] 買入執行失敗:`, err.message);
        return false;
    }
}

async function runSellPipeline(position, currentPrice, reason, fraction = 1.0) {
    const mint = position.mint_address;
    const lockKey = `sell_lock:${mint}`;

    console.log(`📉 [Sell Pipeline] 啟動平倉程序: ${position.token_symbol} | 原因: ${reason}`);

    try {
        const sellQuantity = position.quantity * fraction;
        const tokenDecimals = position.token_decimals || 6; 

        // 🚀 動態 Slippage 判定：遇到極端情況放寬滑點至 50%
        let dynamicSlippage = 1500; // 預設 15%
        if (reason && (reason.includes('硬止損') || reason.includes('VWAP 防線崩潰') || reason.includes('Rugpull') || reason.includes('CVD 背離') || reason.includes('DEFCON'))) {
            dynamicSlippage = 5000; // 50%
            console.warn(`🚨 [Emergency Mode] 偵測到恐慌拋售/止損信號，Slippage 已拉升至 50% (5000 bps) 以確保逃生！`);
        }

        // 🚀 核心升級：強制所有模式向 Jupiter 獲取真實報價
        const quoteData = await getJupiterFinalQuote(mint, false, sellQuantity, dynamicSlippage, position.strategy_version || position.strategy_type || 'v10', tokenDecimals);

        let txid = `SELL_${Date.now()}`;
        let success = false;
        let actualExecutionPrice = currentPrice; // 預設使用 RAM 傳入價格兜底

        if (quoteData && quoteData.pricePerToken) {
            actualExecutionPrice = quoteData.pricePerToken; // 🚀 使用 Jupiter 真實報價結算！
        } else {
            console.warn(`⚠️ [Sell Pipeline] ${position.token_symbol} 無法獲取 Jupiter 真實報價，將使用 RAM 緩存價格結算！`);
        }

        const { data: sysConfig } = await supabase.from('system_config').select('trade_mode').eq('id', 1).single();
        const mode = sysConfig ? (sysConfig.trade_mode || 'PAPER') : 'PAPER';

        if (mode === 'LIVE') {
            if (quoteData && quoteData.quoteResponse) {
                const txPromise = executeLiveSwapUAT(quoteData.quoteResponse, 'SELL', reason);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TX_TIMEOUT')), 15000));

                try {
                    const result = await Promise.race([txPromise, timeoutPromise]);
                    if (result && result.success) {
                        txid = result.txid;
                        success = true;
                    }
                } catch (e) {
                    console.warn(`⏳ [Trade Service] 常規賣出超時或失敗: ${e.message}`);
                }
            }

            if (!success) {
                console.log(`🚨 [Sell Pipeline] 常規賣出失敗，啟動神風逃生艙！`);
                const escapeResult = await fallbackEscapeService.executeEscape(position, sellQuantity);
                
                if (escapeResult && escapeResult.success) {
                    txid = escapeResult.txid;
                    success = true;
                    console.log(`🎉 [Sell Pipeline] 逃生艙發射成功！TX: ${txid}`);
                }
            }
        } else {
            success = true; 
        }

        if (mode === 'LIVE' && !success) {
            console.warn(`⚠️ [Sell Pipeline] $${position.token_symbol} 賣出未能成功上鏈，終止結算流程以防重覆轟炸。`);
            return false; 
        }

        // 🛡️ 防護網：使用 Jupiter 價格計算真實 PnL
        const safeCurrentPrice = actualExecutionPrice || position.entry_price_sol || 0;
        const entryPrice = position.entry_price_sol || 0;
        const realizedPnlPct = entryPrice > 0 ? ((safeCurrentPrice - entryPrice) / entryPrice) * 100 : 0;
        const sellValueSol = sellQuantity * safeCurrentPrice;

        if (mode === 'PAPER') {
             const { data: freshConfig } = await supabase.from('system_config').select('simulated_balance').eq('id', 1).single();
             const newBalance = parseFloat(freshConfig?.simulated_balance || 0) + sellValueSol;
             await supabase.from('system_config').update({ simulated_balance: newBalance }).eq('id', 1);
             updateCache('SELL', sellValueSol); 
        }

        // ✂️ 移除 Shadow DB 刪除邏輯
        const activeTables = ['active_positions_live', 'active_positions_paper'];
        if (fraction === 1.0) {
            for (const table of activeTables) await supabase.from(table).delete().eq('id', position.id);
        } else {
            const table = mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            await supabase.from(table).update({
                quantity: position.quantity - sellQuantity,
                strategy_type: position.strategy_type + '_HALF_SOLD'
            }).eq('id', position.id);
        }

        const climateStr = await redis.get('global_env_state');
        const climate = climateStr ? JSON.parse(climateStr).climate : 'UNKNOWN';
        const holdTimeMins = position.created_at ? Math.floor((Date.now() - new Date(position.created_at).getTime()) / 60000) : 0;

        await supabase.from('trade_patterns').insert([{
            mint_address: mint, 
            is_shadow: false, // ✂️ 寫死 false，徹底閹割
            strategy_version: position.strategy_type || 'v10_default',
            entry_ofi: position.entry_ofi || 0, 
            entry_liquidity_usd: position.entry_liquidity_usd || 0,
            max_vwap_deviation: position.max_vwap_dev || 0, 
            final_cvd_slope: position.final_cvd_slope || 0,
            realized_pnl_pct: realizedPnlPct, 
            market_climate: climate,
            entry_price_sol: entryPrice, 
            entry_volume_5m: position.entry_volume_5m_usd || 0,
            token_symbol: position.token_symbol || 'UNKNOWN',
            applied_ml_strategy_id: position.applied_ml_strategy_id
        }]);

        const historyTable = mode === 'LIVE' ? 'trade_history_live' : 'trade_history_paper';
        const { error: historyErr } = await supabase.from(historyTable).insert([{
            token_mint: mint,
            token_symbol: position.token_symbol,
            action: fraction === 1.0 ? 'SELL' : 'SELL_HALF',
            strategy_type: position.strategy_type,
            price_sol: safeCurrentPrice,
            quantity: sellQuantity,
            total_value_sol: sellValueSol,
            realized_pnl_pct: realizedPnlPct,
            realized_pnl_sol: (safeCurrentPrice - entryPrice) * sellQuantity,
            txid: txid,
            market_climate: climate,
            applied_ml_strategy_id: position.applied_ml_strategy_id,
            review_history: reason, // 🚀 補回寫入平倉原因 (包括 Time-Stop 等)
            hold_time_mins: holdTimeMins // 🚀 補回持倉時間
        }]);

        if (historyErr) {
            console.error(`❌ [Sell Pipeline] 寫入 ${historyTable} 失敗:`, historyErr.message);
        }

        if (typeof sendTelegramAlert === 'function') {
            const icon = realizedPnlPct > 0 ? '🟢' : '🔴';
            const modeText = mode === 'LIVE' ? '[實盤]' : '[模擬]';
            // 🚀 統一個 TG 字眼：平倉結算
            const fractionText = fraction === 1.0 ? '平倉結算' : '半倉平倉結算';
            await sendTelegramAlert(`${icon} ${modeText} <b>${fractionText}</b>\n幣種: <b>${position.token_symbol}</b>\n原因: ${reason}\n利潤: ${realizedPnlPct.toFixed(2)}%\nTX: <code>${txid}</code>`);
        }

        console.log(`✅ [Sell Pipeline] ${position.token_symbol} 歸檔完畢。`);
        return true;

    } catch (err) {
        console.error(`❌ [Sell Pipeline] 崩潰:`, err.message);
        return false;
    }
}

module.exports = { getJupiterFinalQuote, executeBuy, runSellPipeline };