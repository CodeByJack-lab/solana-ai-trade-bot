const { getPortfolio } = require('./portfolioService');
const { supabase } = require('../config/supabase'); 
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana'); 
const path = require('path');
const BigNumber = require('bignumber.js'); 

const { executeLiveSwapUAT } = require('./liveTradeService');
const { sendTelegramAlert } = require('./telegramService'); 

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

/**
 * [Final Guard] 從 Jupiter 獲取真實報價
 */
async function getJupiterFinalQuote(tokenMint, isBuying, amount) {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        let decimals = 6; 

        try {
            const supplyInfo = await connection.getTokenSupply(new PublicKey(tokenMint));
            decimals = supplyInfo.value?.decimals ?? 6; 
        } catch (e) {
            console.warn(`⚠️ [Quote] 無法獲取 ${tokenMint} 精度，預設使用 6`);
        }

        let inputMint, outputMint, amountRaw;

        if (isBuying) {
            inputMint = SOL_MINT;
            outputMint = tokenMint;
            amountRaw = new BigNumber(amount).times(1e9).integerValue().toString(); 
        } else {
            inputMint = tokenMint;
            outputMint = SOL_MINT;
            amountRaw = new BigNumber(amount).times(new BigNumber(10).pow(decimals)).integerValue().toString(); 
        }

        const baseUrl = (process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag').replace(/\/$/, '');
        const endpoint = baseUrl.includes('api.jup.ag') ? '/swap/v1/quote' : '/v6/quote';
        const url = `${baseUrl}${endpoint}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=100`;

        const config = { headers: {} };
        if (process.env.JUPITER_API_KEY) {
            config.headers['x-api-key'] = process.env.JUPITER_API_KEY.replace(/['"]/g, '').trim();
        }

        const response = await axios.get(url, config);
        
        let pricePerTokenSol;
        if (isBuying) {
            const outAmountToken = new BigNumber(response.data.outAmount).div(new BigNumber(10).pow(decimals));
            pricePerTokenSol = new BigNumber(amount).div(outAmountToken).toNumber(); 
        } else {
            const outAmountSol = new BigNumber(response.data.outAmount).div(1e9);
            pricePerTokenSol = outAmountSol.div(amount).toNumber(); 
        }
        
        if (!Number.isFinite(pricePerTokenSol)) return null;

        return { pricePerToken: pricePerTokenSol, rawResponse: response.data, decimals };
    } catch (err) {
        console.error(`❌ [Jupiter Quote] 獲取報價失敗:`, err.message);
        return null;
    }
}

/**
 * 1. 執行買入操作
 */
async function executeBuy(mintAddress, tokenSymbol, strategyType, aiScore, aiReason, currentSolHkdPrice, configTradeAmountSol = 0.1) {
    console.log(`\n========================================`);
    console.log(`⚡ [Execution] 啟動下單程序: 狙擊目標 ${tokenSymbol} (${mintAddress})`);

    let finalTradeAmountSol = configTradeAmountSol; 
    let macroTag = "平穩";

    try {
        const { data: config } = await supabase.from('system_config').select('fear_greed_index').eq('id', 1).maybeSingle();
        const fgIndex = config?.fear_greed_index || 50;
        if (fgIndex < 20) {
            finalTradeAmountSol = finalTradeAmountSol / 2; 
            macroTag = `極度恐慌 (${fgIndex})`;
        } else if (fgIndex > 80) {
            macroTag = `極度貪婪 (${fgIndex})`;
        }
    } catch (err) {}

    const portfolio = getPortfolio();
    if (portfolio.cash_sol < finalTradeAmountSol) { 
        console.log(`❌ [Execution] 餘額不足 ${finalTradeAmountSol.toFixed(4)} SOL，取消開倉。`);
        return;
    }

    const quoteData = await getJupiterFinalQuote(mintAddress, true, finalTradeAmountSol); 
    if (!quoteData) return;

    const buyPriceSol = quoteData.pricePerToken;
    const tokenQuantity = new BigNumber(finalTradeAmountSol).div(buyPriceSol).toNumber(); 
    const mockTxid = "BUY_" + Math.random().toString(36).substring(2, 8).toUpperCase();

    if (!Number.isFinite(tokenQuantity) || tokenQuantity <= 0) return;

    const isLive = portfolio.mode === 'LIVE';
    const tableSuffix = isLive ? 'live' : 'paper';
    let tradeSuccess = true; 

    if (isLive) {
        tradeSuccess = await executeLiveSwapUAT(quoteData.rawResponse, "BUY");
        if (!tradeSuccess) return; 
    }

    if (tradeSuccess) {
        portfolio.cash_sol -= finalTradeAmountSol;
        portfolio.positions.push({
            mint_address: mintAddress,
            token_symbol: tokenSymbol,
            quantity: tokenQuantity, 
            entry_price_sol: buyPriceSol,
            highest_price_sol: buyPriceSol, 
            strategy_type: strategyType 
        });

        if (!isLive) {
            await supabase.from('system_config').update({ simulated_balance: portfolio.cash_sol }).eq('id', 1);
        } else {
            // 實盤買完，即刻 Update DB 觸發 Dashboard 同 Index.js 記憶體同步
            await supabase.from('system_config').update({ live_wallet_balance: portfolio.cash_sol }).eq('id', 1);
        }

        supabase.from(`active_positions_${tableSuffix}`).insert([{
            mint_address: mintAddress,
            token_symbol: tokenSymbol,
            strategy_type: strategyType,
            entry_price_sol: buyPriceSol,
            highest_price_sol: buyPriceSol, 
            quantity: tokenQuantity, 
            ai_reason: aiReason
        }]).then(({ error }) => { if (error) console.error(`❌ DB 寫入錯誤:`, error.message); });

        supabase.from(`trade_history_${tableSuffix}`).insert([{
            token_mint: mintAddress,
            token_symbol: tokenSymbol,
            action: 'BUY',
            strategy_type: strategyType,
            price_sol: buyPriceSol,
            quantity: tokenQuantity,
            total_value_sol: finalTradeAmountSol, 
            post_trade_balance: portfolio.cash_sol,
            txid: mockTxid,
            ai_factcheck_result: aiReason
        }]).then(({ error }) => { if (error) console.error(`❌ DB 歷史錯誤:`, error.message); });

        if(typeof sendTelegramAlert === 'function') {
            const modeTag = isLive ? '🔴 [實盤]' : '🟢 [模擬]';
            const approxHkd = (finalTradeAmountSol * currentSolHkdPrice).toFixed(0);
            sendTelegramAlert(`
${modeTag} <b>✅ 買入成功</b>
🌍 <b>大市</b>: ${macroTag}
🪙 <b>代幣</b>: $${tokenSymbol}
💰 <b>投入</b>: ${finalTradeAmountSol.toFixed(4)} SOL (約 $${approxHkd} HKD)
🧠 <b>理由</b>: ${aiReason}
            `);
        }
    }
}

/**
 * 2. 執行賣出操作 (支援部分平倉 sellFraction)
 */
async function executeSell(mintAddress, marketRefPriceSol, reason, sellFraction = 1.0) {
    const portfolio = getPortfolio();
    const posIndex = portfolio.positions.findIndex(p => p.mint_address === mintAddress);
    if (posIndex === -1) return false;
    
    const pos = portfolio.positions[posIndex];
    const tokenSymbol = pos.token_symbol || 'UNKNOWN';
    
    // 🛠️ 按比例計算賣出數量
    const sellQuantity = new BigNumber(pos.quantity).times(sellFraction).toNumber();

    console.log(`\n⚡ [Jupiter] 正在嘗試平倉: ${tokenSymbol} (比例: ${sellFraction * 100}%)`);

    const quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity);
    
    if (!quoteData && portfolio.mode === 'LIVE') {
        console.error(`❌ [Jupiter] ${tokenSymbol} 攞唔到報價`);
        return false; 
    }

    const finalPriceSol = quoteData ? quoteData.pricePerToken : marketRefPriceSol; 
    const sellValueSol = new BigNumber(sellQuantity).times(finalPriceSol).toNumber();
    
    const entryTotalValue = new BigNumber(sellQuantity).times(pos.entry_price_sol);
    const pnlSol = new BigNumber(sellValueSol).minus(entryTotalValue).toNumber();
    const pnlPct = new BigNumber(pnlSol).div(entryTotalValue).times(100).toNumber();

    if (!Number.isFinite(pnlPct)) return false;

    const isLive = portfolio.mode === 'LIVE';
    let tradeSuccess = true;

    if (isLive && quoteData) {
        tradeSuccess = await executeLiveSwapUAT(quoteData.rawResponse, "SELL");
        if (!tradeSuccess) return false; 
    }

    if (tradeSuccess) {
        await commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, `Jupiter: ${reason}`, sellQuantity, sellFraction);
        return true;
    }
    return false;
}

/**
 * 3. 🚀 Raydium 直接賣出備援
 */
async function executeSellRaydium(mintAddress, marketRefPriceSol, reason, sellFraction = 1.0) {
    const portfolio = getPortfolio();
    const posIndex = portfolio.positions.findIndex(p => p.mint_address === mintAddress);
    if (posIndex === -1) return false;
    
    const pos = portfolio.positions[posIndex];
    const sellQuantity = new BigNumber(pos.quantity).times(sellFraction).toNumber();

    console.log(`\n🛡️ [Raydium Fallback] 正在嘗試透過 Raydium 直接平倉: ${pos.token_symbol}`);

    const finalPriceSol = marketRefPriceSol; 
    const sellValueSol = new BigNumber(sellQuantity).times(finalPriceSol).toNumber();
    
    const entryTotalValue = new BigNumber(sellQuantity).times(pos.entry_price_sol);
    const pnlSol = new BigNumber(sellValueSol).minus(entryTotalValue).toNumber();
    const pnlPct = new BigNumber(pnlSol).div(entryTotalValue).times(100).toNumber();

    if (!Number.isFinite(pnlPct)) return false;

    if (portfolio.mode === 'LIVE') {
        console.warn("⚠️ 實盤 Raydium SDK 尚未配置，目前僅支援模擬逃生。");
        return false; 
    }

    await commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, `Raydium: ${reason}`, sellQuantity, sellFraction);
    return true;
}

async function forceWriteOff(mintAddress, reason) {
    const portfolio = getPortfolio();
    const posIndex = portfolio.positions.findIndex(p => p.mint_address === mintAddress);
    if (posIndex === -1) return;

    const pos = portfolio.positions[posIndex];
    const quantity = pos.quantity;
    const totalLoss = -(quantity * pos.entry_price_sol);
    
    await commitTradeToDb(posIndex, 0, 0, totalLoss, -99.9, `💀 強制平帳: ${reason}`, quantity, 1.0);
}

/**
 * 內部輔助：統一寫入 DB 與更新餘額 (支援部分平倉)
 */
async function commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, finalReason, sellQuantity, sellFraction) {
    const portfolio = getPortfolio();
    const pos = portfolio.positions[posIndex];
    const mintAddress = pos.mint_address;
    const isLive = portfolio.mode === 'LIVE';
    const tableSuffix = isLive ? 'live' : 'paper';

    portfolio.cash_sol += sellValueSol;

    // 🛠️ 根據平倉比例決定係「刪除」定係「更新」倉位
    if (sellFraction === 1.0) {
        portfolio.positions.splice(posIndex, 1);
        await supabase.from(`active_positions_${tableSuffix}`).delete().eq('mint_address', mintAddress);
    } else {
        // 部分平倉：扣減數量，並打上 HALF_SOLD 標記
        pos.quantity = new BigNumber(pos.quantity).minus(sellQuantity).toNumber();
        pos.strategy_type = (pos.strategy_type || '') + '_HALF_SOLD';
        
        await supabase.from(`active_positions_${tableSuffix}`).update({
            quantity: pos.quantity,
            strategy_type: pos.strategy_type
        }).eq('mint_address', mintAddress);
    }

    if (!isLive) {
        await supabase.from('system_config').update({ simulated_balance: portfolio.cash_sol }).eq('id', 1);
    } else {
        // 實盤賣完，即刻 Update DB 觸發 Dashboard 同 Index.js 記憶體同步
        await supabase.from('system_config').update({ live_wallet_balance: portfolio.cash_sol }).eq('id', 1);
    }

    await supabase.from(`trade_history_${tableSuffix}`).insert([{
        token_mint: mintAddress,
        token_symbol: pos.token_symbol,
        action: sellFraction === 1.0 ? 'SELL' : 'SELL_HALF',
        price_sol: finalPriceSol,
        quantity: sellQuantity,
        total_value_sol: sellValueSol,
        realized_pnl_sol: pnlSol,    
        realized_pnl_pct: pnlPct,    
        post_trade_balance: portfolio.cash_sol,
        txid: "SELL_" + Math.random().toString(36).substring(7).toUpperCase(),
        ai_factcheck_result: finalReason
    }]);

    if(typeof sendTelegramAlert === 'function') {
        if (sellFraction < 1.0) {
            sendTelegramAlert(`🛡️ <b>翻倍出本成功</b>\n🪙 代幣: $${pos.token_symbol}\n賣出比例: 50%\n收回本金: ${sellValueSol.toFixed(4)} SOL\n*(剩餘倉位將自動轉為免費抽獎，容忍 30% 回撤)*`);
        } else if (sellFraction === 1.0 && (pos.strategy_type || '').includes('HALF_SOLD')) {
            sendTelegramAlert(`✅ <b>免費抽獎倉位已平倉</b>\n🪙 代幣: $${pos.token_symbol}\n原因: ${finalReason}\n*(本次利潤為純利)*`);
        }
    }
}

module.exports = { executeBuy, executeSell, executeSellRaydium, forceWriteOff };