// src/services/tradeService.js
// 📝 檔案功能及用途：V10.36 交易執行大腦 (終極修復資金扣減與 TG 顯示版)
// 🚀 核心升級：徹底修復 simulated_balance 買賣不扣款問題，並於 TG 訊息明確區分「半倉」與「全倉」。
// 🛡️ 數據防護：實施「結算與廣播的一票否決權」，交易未上鏈絕不結算，杜絕 TG 轟炸。
// 🧠 記憶體同步：實裝「秒速 RAM 清除」機制，斬斷 Zombie Sweeper 的無限鞭屍循環。
// 📊 ML 對接：全面寫入 applied_ml_strategy_id 供 Python 進行回測。

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

        // 💰 資金防護：同時拉取 mode 與 simulated_balance
        const { data: sysConfig } = await supabase.from('system_config').select('trade_mode, simulated_balance').eq('id', 1).single();
        const mode = sysConfig ? (sysConfig.trade_mode || 'PAPER') : 'PAPER';

        if (mode === 'SHUTDOWN') {
            console.log(`⏸️ [Trade Service] 系統處於休眠狀態，拒絕下單。`);
            return false;
        }

        // 🛑 Paper 模式下，先檢查餘額夠不夠
        if (mode === 'PAPER') {
            const currentSimulatedBalance = parseFloat(sysConfig.simulated_balance || 0);
            if (currentSimulatedBalance < finalTradeAmountSol) {
                console.error(`❌ [Trade Service] 模擬資金不足！餘額: ${currentSimulatedBalance} SOL, 需要: ${finalTradeAmountSol} SOL`);
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
            // 💸 PAPER 模式正式扣款 (寫入 DB 並更新 RAM)
            const newBalance = parseFloat(sysConfig.simulated_balance || 0) - finalTradeAmountSol;
            await supabase.from('system_config').update({ simulated_balance: newBalance }).eq('id', 1);
            updateCache('BUY', finalTradeAmountSol); // 立即扣減 RAM 的現金
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
            // 容錯：若寫入失敗，把錢退回模擬倉
            if (mode === 'PAPER') {
                await supabase.from('system_config').update({ simulated_balance: parseFloat(sysConfig.simulated_balance || 0) }).eq('id', 1);
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

        const quoteData = await getJupiterFinalQuote(mint, false, sellQuantity, 1500, position.strategy_version || position.strategy_type || 'v10', tokenDecimals);

        let txid = `SELL_${Date.now()}`;
        let success = false;

        const { data: sysConfig } = await supabase.from('system_config').select('trade_mode, simulated_balance').eq('id', 1).single();
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

        // 💰 資金結算 (PAPER)
        const entryPrice = position.entry_price_sol || 0;
        const realizedPnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
        const sellValueSol = sellQuantity * currentPrice;
        const isShadow = position.strategy_type?.includes('SHADOW') || false; 

        if (mode === 'PAPER' && !isShadow) {
             // 將賣出得益加回 simulated_balance
             const newBalance = parseFloat(sysConfig.simulated_balance || 0) + sellValueSol;
             await supabase.from('system_config').update({ simulated_balance: newBalance }).eq('id', 1);
             updateCache('SELL', sellValueSol); // 立即增加 RAM 的現金
        }

        const activeTables = ['active_positions_live', 'active_positions_paper', 'active_positions_shadow'];
        if (fraction === 1.0) {
            for (const table of activeTables) await supabase.from(table).delete().eq('mint_address', mint);
        } else {
            const table = mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            await supabase.from(table).update({
                quantity: position.quantity - sellQuantity,
                strategy_type: position.strategy_type + '_HALF_SOLD'
            }).eq('mint_address', mint);
        }

        const climateStr = await redis.get('global_env_state');
        const climate = climateStr ? JSON.parse(climateStr).climate : 'UNKNOWN';

        await supabase.from('trade_patterns').insert([{
            mint_address: mint, 
            is_shadow: isShadow,
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

        if (!isShadow) {
            const historyTable = mode === 'LIVE' ? 'trade_history_live' : 'trade_history_paper';
            const { error: historyErr } = await supabase.from(historyTable).insert([{
                token_mint: mint,
                token_symbol: position.token_symbol,
                action: fraction === 1.0 ? 'SELL' : 'SELL_HALF',
                strategy_type: position.strategy_type,
                price_sol: currentPrice,
                quantity: sellQuantity,
                total_value_sol: sellValueSol,
                realized_pnl_pct: realizedPnlPct,
                realized_pnl_sol: (currentPrice - entryPrice) * sellQuantity,
                txid: txid,
                market_climate: climate,
                applied_ml_strategy_id: position.applied_ml_strategy_id 
            }]);

            if (historyErr) {
                console.error(`❌ [Sell Pipeline] 寫入 ${historyTable} 失敗:`, historyErr.message);
            }

            if (typeof sendTelegramAlert === 'function') {
                const icon = realizedPnlPct > 0 ? '🟢' : '🔴';
                const modeText = mode === 'LIVE' ? '[實盤]' : '[模擬]';
                // 📣 明確顯示是半倉還是全倉
                const fractionText = fraction === 1.0 ? '全倉平倉結算' : '半倉平倉結算';
                await sendTelegramAlert(`${icon} ${modeText} <b>${fractionText}</b>\n幣種: <b>${position.token_symbol}</b>\n原因: ${reason}\n利潤: ${realizedPnlPct.toFixed(2)}%\nTX: <code>${txid}</code>`);
            }
        }

        console.log(`✅ [Sell Pipeline] ${position.token_symbol} 歸檔完畢。`);
        return true;

    } catch (err) {
        console.error(`❌ [Sell Pipeline] 崩潰:`, err.message);
        return false;
    }
}

module.exports = { getJupiterFinalQuote, executeBuy, runSellPipeline };