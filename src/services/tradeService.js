// src/services/tradeService.js
// 📝 檔案功能及用途：V10.22 交易執行大腦 (Microservice Core)
// 🚀 核心升級：徹底修復實盤買入斷層，正式呼叫 executeLiveSwapUAT 進行真金白銀上鏈！動態感應 Dashboard 的 LIVE/PAPER 模式。
// 🛡️ 數據防護：加入 Infinity PnL 阻截機制，防止 entry_price 為 0 時搞冧 ML 大腦。

require('dotenv').config();
const axios = require('axios');
const Redis = require('ioredis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getPortfolio } = require('./portfolioService');
const { sendTelegramAlert } = require('./telegramService');
const { fallbackEscapeService } = require('./fallbackEscapeService');
const { executeLiveSwapUAT } = require('./liveTradeService');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function getJupiterFinalQuote(mint, isBuy, amount, slippageBps, strategyType = 'NEWBORN') {
    try {
        const inputMint = isBuy ? SOL_MINT : mint;
        const outputMint = isBuy ? mint : SOL_MINT;
        
        const decimals = isBuy ? 9 : 6;
        const amountRaw = Math.floor(amount * Math.pow(10, decimals));

        let url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
        
        if (strategyType.includes('NEWBORN') || strategyType.includes('MEME') || strategyType.includes('v10')) {
            url += `&onlyDirectRoutes=true`;
        }

        const res = await axios.get(url, { timeout: 3000 });
        if (res.data && res.data.outAmount) {
            const outLamports = parseFloat(res.data.outAmount);
            const pricePerToken = isBuy 
                ? amount / (outLamports / 1e6) 
                : (outLamports / 1e9) / amount;

            return {
                quoteResponse: res.data,
                pricePerToken: pricePerToken
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

        let buyThreshold = 70;
        try {
            const mlParamsStr = await redis.get('ml_strategy_params');
            if (mlParamsStr) {
                const mlParams = JSON.parse(mlParamsStr);
                const currentClimate = envState.climate || 'CHOPPY';
                const poolType = strategyVersion.includes('NEWBORN') ? 'NEWBORN' : 'TRENDING';
                buyThreshold = mlParams?.[poolType]?.[currentClimate]?.buyThreshold || 70;
            }
        } catch(e) {}
        const isShadow = aiScore < buyThreshold; 

        const quote = await getJupiterFinalQuote(mint, true, finalTradeAmountSol, 500, strategyVersion);
        if (!quote || !quote.quoteResponse) {
            console.log(`⚠️ [Trade Service] 無法獲取 ${symbol} 的 Jupiter 買入報價，放棄交易。`);
            return false;
        }

        const entryPrice = quote.pricePerToken;
        let txid = `BUY_${crypto.randomBytes(3).toString('hex').toUpperCase()}`; 

        if (!isShadow && mode === 'LIVE') {
            console.log(`⚡ [Live Engine] 觸發實盤買入: ${symbol}`);
            const buyResult = await executeLiveSwapUAT(quote.quoteResponse, 'BUY', reason);
            
            if (buyResult && buyResult.success) {
                txid = buyResult.txid;
                console.log(`🎉 [Live Trade] ${symbol} 真實買入成功！TX: ${txid}`);
            } else {
                console.error(`❌ [Live Trade] ${symbol} 真實買入失敗或超時，中止建倉！`);
                return false; 
            }
        }

        const positionData = {
            mint_address: mint,
            token_symbol: symbol,
            strategy_version: strategyVersion,
            entry_price_sol: entryPrice,
            highest_price_sol: entryPrice,
            quantity: (finalTradeAmountSol / entryPrice),
            ai_score: aiScore,
            ai_reason: reason,
            buy_dex_label: mode === 'LIVE' ? 'JUPITER_LIVE' : 'JUPITER_PAPER',
        };

        if (isShadow) {
            await supabase.from('active_positions_shadow').insert([positionData]);
            console.log(`👻 [Shadow Route] ${symbol} 已建立影子倉位 (供 ML 訓練用)。`);
        } else {
            const tableName = mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            await supabase.from(tableName).insert([positionData]);
            console.log(`⚔️ [Main Route] ${symbol} 已建立 ${mode} 倉位！`);
            
            const historyTable = mode === 'LIVE' ? 'trade_history_live' : 'trade_history_paper';
            await supabase.from(historyTable).insert([{
                token_mint: mint,
                token_symbol: symbol,
                action: 'BUY',
                strategy_type: strategyVersion,
                strategy_version: strategyVersion,
                ai_used: true,
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
                applied_ml_strategy_id: appliedMlStrategyId, 
                ml_confidence_multiplier: safeMultiplier     
            }]);

            if (typeof sendTelegramAlert === 'function') {
                await sendTelegramAlert(`🟢 <b>買入建倉</b>\n幣種: <b>${symbol}</b>\n模式: ${mode}\n策略: ${strategyVersion} (ID: ${appliedMlStrategyId})\n分數: ${aiScore}\n注碼: ${finalTradeAmountSol} SOL (${safeMultiplier}x)\n買入價: ${entryPrice.toFixed(8)} SOL\nTX: <code>${txid}</code>`);
            }
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
        const quoteData = await getJupiterFinalQuote(mint, false, sellQuantity, 1500, position.strategy_version || 'v10');

        let txid = null;
        let success = false;

        if (quoteData && quoteData.quoteResponse) {
            const txPromise = executeLiveSwapUAT(quoteData.quoteResponse, 'SELL', reason);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TX_TIMEOUT')), 10000));

            try {
                const result = await Promise.race([txPromise, timeoutPromise]);
                if (result && result.success) {
                    txid = result.txid;
                    success = true;
                }
            } catch (e) {
                console.warn(`⏳ [Trade Service] 常規賣出超時或失敗: ${e.message}`);
            }
        } else {
            console.warn(`⚠️ [Trade Service] 無法獲取 Jupiter 賣出報價！`);
        }

        if (!success) {
            console.log(`🚨 [Sell Pipeline] 常規賣出失敗，啟動神風逃生艙！`);
            const escapeResult = await fallbackEscapeService.executeEscape(position, sellQuantity);
            
            if (escapeResult && escapeResult.success) {
                txid = escapeResult.txid;
                success = true;
                console.log(`🎉 [Sell Pipeline] 逃生艙發射成功！TX: ${txid}`);
            } else {
                throw new Error("常規賣出與神風逃生艙均告失敗");
            }
        }

        // 🚨 PREVENT INFINITY BUG: 確保 entryPrice 大於 0
        const entryPrice = position.entry_price_sol || 0;
        let realizedPnlPct = 0;
        if (entryPrice > 0) {
            realizedPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
        } else {
            console.warn(`⚠️ [Sell Pipeline] 警告: ${position.token_symbol} 入場價為 0，已強制將 PnL% 歸零以防 ML 大腦崩潰！`);
        }
        
        const isShadow = position.strategy_version?.includes('shadow') || false; 

        const activeTables = ['active_positions_live', 'active_positions_paper', 'active_positions_shadow'];
        for (const table of activeTables) {
            await supabase.from(table).delete().eq('mint_address', mint);
        }

        const climateStr = await redis.get('global_env_state');
        const climate = climateStr ? JSON.parse(climateStr).climate : 'UNKNOWN';

        await supabase.from('trade_patterns').insert([{
            mint_address: mint,
            is_shadow: isShadow,
            strategy_version: position.strategy_version || 'v10_default',
            entry_ofi: position.entry_ofi || 0,
            entry_liquidity_usd: position.entry_liquidity_usd || 0,
            max_vwap_deviation: position.max_vwap_dev || 0, 
            final_cvd_slope: position.final_cvd_slope || 0,
            realized_pnl_pct: realizedPnlPct,
            market_climate: climate,
            entry_price_sol: entryPrice, // 補回紀錄供參考
            entry_volume_5m: position.entry_volume_5m_usd || 0,
            token_symbol: position.token_symbol || 'UNKNOWN'
        }]);

        if (!isShadow) {
            const { data: sysConfig } = await supabase.from('system_config').select('trade_mode').eq('id', 1).single();
            const mode = sysConfig ? (sysConfig.trade_mode || 'PAPER') : 'PAPER';

            const historyTable = mode === 'LIVE' ? 'trade_history_live' : 'trade_history_paper';
            await supabase.from(historyTable).insert([{
                token_mint: mint,
                token_symbol: position.token_symbol,
                action: fraction === 1.0 ? 'SELL' : 'SELL_HALF',
                strategy_type: position.strategy_type,
                strategy_version: position.strategy_version || 'v10_default',
                ai_used: true,
                price_sol: currentPrice,
                quantity: sellQuantity,
                total_value_sol: sellQuantity * currentPrice,
                realized_pnl_pct: realizedPnlPct,
                realized_pnl_sol: (currentPrice - entryPrice) * sellQuantity,
                txid: txid,
                market_climate: climate,
            }]);

            if (typeof sendTelegramAlert === 'function') {
                const icon = realizedPnlPct > 0 ? '🟢' : '🔴';
                await sendTelegramAlert(`${icon} <b>平倉結算</b>\n幣種: <b>${position.token_symbol}</b>\n模式: ${mode}\n原因: ${reason}\n利潤: ${realizedPnlPct.toFixed(2)}%\nTX: <code>${txid}</code>`);
            }
        }

        console.log(`✅ [Sell Pipeline] ${position.token_symbol} 平倉與歸檔完成！`);
        return true;

    } catch (err) {
        console.error(`❌ [Sell Pipeline] 平倉異常:`, err.message);
        await redis.del(lockKey);
        return false;
    }
}

module.exports = {
    getJupiterFinalQuote,
    executeBuy,
    runSellPipeline
};