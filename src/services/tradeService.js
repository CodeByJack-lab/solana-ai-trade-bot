// src/services/tradeService.js
const { getPortfolio, updateCache } = require('./portfolioService');
const { supabase } = require('../config/supabase'); 
const axios = require('axios');
const { PublicKey, Keypair } = require('@solana/web3.js'); // 🚀 FIX: 加入 Keypair 防止 Crash
const { connection } = require('../config/solana'); 
const path = require('path');
const BigNumber = require('bignumber.js'); 
const { executeLiveSwapUAT } = require('./liveTradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService'); 
const { healthMonitor } = require('./healthMonitor');

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🚀 頂層初始化：只解析一次 Private Key，供全檔案使用
let globalWalletPublicKey = null;
try {
    const rawKey = process.env.SOLANA_PRIVATE_KEY ? process.env.SOLANA_PRIVATE_KEY.trim() : null;
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            globalWalletPublicKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))).publicKey.toString();
        } else {
            globalWalletPublicKey = Keypair.fromSecretKey(bs58.decode(rawKey)).publicKey.toString();
        }
    }
} catch (e) {
    console.error("⚠️ [TradeService] 無法解析 Private Key");
}

// 實盤核數師 (獲取鏈上真實 SPL Token 餘額)
async function getRealTokenBalance(walletPubKeyStr, tokenMintStr) {
    try {
        const walletKey = new PublicKey(walletPubKeyStr);
        const mintKey = new PublicKey(tokenMintStr);
        
        const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKey, {
            mint: mintKey
        });

        if (parsedTokenAccounts.value.length === 0) return 0;

        let totalUiAmount = 0;
        for (const accountInfo of parsedTokenAccounts.value) {
            totalUiAmount += accountInfo.account.data.parsed.info.tokenAmount.uiAmount;
        }
        
        return totalUiAmount;
    } catch (e) {
        console.error(`⚠️ [Balance Check] 無法獲取真實代幣餘額 (${tokenMintStr.substring(0,6)}):`, e.message);
        return null; 
    }
}

async function getJupiterFinalQuote(tokenMint, isBuying, amount) {
    try {
        let decimals = 6; 
        try {
            const supplyInfo = await connection.getTokenSupply(new PublicKey(tokenMint));
            decimals = supplyInfo.value?.decimals ?? 6; 
        } catch (e) {}

        let inputMint = isBuying ? SOL_MINT : tokenMint;
        let outputMint = isBuying ? tokenMint : SOL_MINT;
        
        let amountRaw = isBuying 
            ? new BigNumber(amount).times(1e9).integerValue().toString() 
            : new BigNumber(amount).times(new BigNumber(10).pow(decimals)).integerValue().toString();

        const SLIPPAGE_BPS = isBuying ? 1000 : 1500; 

        const baseUrl = (process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag').replace(/\/$/, '');
        const endpoint = baseUrl.includes('quote-api') ? '/v6/quote' : '/swap/v1/quote';
        const url = `${baseUrl}${endpoint}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`;

        const config = { headers: {} };
        if (process.env.JUPITER_API_KEY) {
            config.headers['x-api-key'] = process.env.JUPITER_API_KEY.replace(/['"]/g, '').trim();
        }

        const response = await axios.get(url, config);
        
        let pricePerTokenSol = isBuying 
            ? new BigNumber(amount).div(new BigNumber(response.data.outAmount).div(new BigNumber(10).pow(decimals))).toNumber()
            : new BigNumber(response.data.outAmount).div(1e9).div(amount).toNumber();
        
        if (!Number.isFinite(pricePerTokenSol)) return null;

        return { pricePerToken: pricePerTokenSol, rawResponse: response.data, decimals };
    } catch (err) {
        return null;
    }
}

async function executeBuy(mintAddress, tokenSymbol, strategyType, aiScore, aiReason, configTradeAmountSol) {
    console.log(`\n========================================`);
    console.log(`⚡ [Execution] 啟動下單程序: 狙擊目標 ${tokenSymbol}`);

    const portfolio = getPortfolio();
    const isLive = portfolio.mode === 'LIVE';
    const tableSuffix = isLive ? 'live' : 'paper';

    if (portfolio.positions.some(p => p.mint_address === mintAddress)) {
        console.log(`🚫 [Trade] 已經持有 ${tokenSymbol}，取消加倉。`);
        return false;
    }

    if (!strategyType.includes('BLUECHIP')) {
        try {
            const { data: recentTrades } = await supabase
                .from(`trade_history_${tableSuffix}`)
                .select('realized_pnl_sol')
                .eq('token_mint', mintAddress)
                .eq('action', 'SELL') 
                .order('created_at', { ascending: false })
                .limit(2);

            if (recentTrades && recentTrades.length === 2) {
                const allLoss = recentTrades.every(t => (t.realized_pnl_sol || 0) < 0);
                if (allLoss) {
                    console.log(`🚫 [Blacklist] ${tokenSymbol} 最近連輸兩次，強制放棄新幣狙擊！`);
                    return false;
                }
            }
        } catch (dbErr) {}
    }

    const safetyBufferSol = portfolio.reference_capital * 0.1;
    const requiredTotalSol = configTradeAmountSol + safetyBufferSol;

    if (portfolio.cash_sol < requiredTotalSol) { 
        console.log(`❌ [Execution] 餘額不足，取消開倉。`);
        return false;
    }

    const quoteData = await getJupiterFinalQuote(mintAddress, true, configTradeAmountSol); 
    if (!quoteData) return false;
    
    const buyPriceSol = quoteData.pricePerToken;
    let tokenQuantity = new BigNumber(configTradeAmountSol).div(buyPriceSol).toNumber(); 
    let tradeSuccess = true;
    let finalTxid = "BUY_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 

    if (isLive) {
        const liveResult = await executeLiveSwapUAT(quoteData.rawResponse, "BUY");
        tradeSuccess = liveResult?.success || false;
        if (tradeSuccess && liveResult?.txid) {
            finalTxid = liveResult.txid; 
            
            console.log(`🔍 [Live Check] 正在驗證鏈上真實到帳數量...`);
            await new Promise(r => setTimeout(r, 5000));

            if (globalWalletPublicKey) {
                const realBal = await getRealTokenBalance(globalWalletPublicKey, mintAddress);
                if (realBal !== null && realBal > 0) {
                    console.log(`✅ [Live Check] 預期: ${tokenQuantity.toFixed(4)} | 鏈上真實: ${realBal.toFixed(4)}`);
                    tokenQuantity = realBal; 
                } else if (realBal === 0) {
                    console.error(`🚨 [FATAL] Jito 報告成功，但鏈上查無餘額！可能是假成功/跌單，放棄寫入 DB！`);
                    return false; 
                }
            }
        } else {
            return false; 
        }
    } 

    if (tradeSuccess && tokenQuantity > 0) {
        updateCache('BUY', configTradeAmountSol, {
            mint_address: mintAddress, token_symbol: tokenSymbol,
            quantity: tokenQuantity, entry_price_sol: buyPriceSol,
            highest_price_sol: buyPriceSol, strategy_type: strategyType 
        });

        const { data: dbConfig } = await supabase.from('system_config').select('*').eq('id', 1).single();
        let currentBalance = isLive ? Number(dbConfig.live_wallet_balance || 0) : Number(dbConfig.simulated_balance || 10);
        let newBalance = currentBalance - Number(configTradeAmountSol);

        // 🚀 實盤：更新錢包餘額為鏈上真實數字 (已扣除 ATA 租金與 Tip)
        if (isLive && globalWalletPublicKey) {
            try {
                const realLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
                newBalance = realLamports / 1e9;
            } catch (e) {}
        }

        await supabase.from('system_config')
            .update(isLive ? { live_wallet_balance: newBalance } : { simulated_balance: newBalance })
            .eq('id', 1);

        await supabase.from(`active_positions_${tableSuffix}`).insert([{
            mint_address: mintAddress, token_symbol: tokenSymbol, strategy_type: strategyType,
            entry_price_sol: buyPriceSol, highest_price_sol: buyPriceSol, quantity: tokenQuantity, ai_reason: aiReason
        }]);

        await supabase.from(`trade_history_${tableSuffix}`).insert([{
            token_mint: mintAddress, token_symbol: tokenSymbol, action: 'BUY',
            strategy_type: strategyType, price_sol: buyPriceSol, quantity: tokenQuantity,
            total_value_sol: configTradeAmountSol, post_trade_balance: newBalance, 
            txid: finalTxid, ai_factcheck_result: aiReason, review_history: aiReason 
        }]);

        if(typeof sendTelegramAlert === 'function') {
            const modeTag = isLive ? '🔴 [實盤]' : '🟢 [模擬]';
            sendTelegramAlert(`${modeTag} <b>✅ 買入成功</b>\n🪙 代幣: $${tokenSymbol}\n💰 投入: ${configTradeAmountSol.toFixed(4)} SOL\n🔗 TX: ${isLive ? `<a href="https://solscan.io/tx/${finalTxid}">Solscan</a>` : finalTxid}\n🧠 理由: ${aiReason}`);
        }
        healthMonitor.setStatus('Trade_Engine', `🟢 最近買入 ${tokenSymbol}`);
        return true;
    }
    return false;
}

async function executeSell(mintAddress, marketRefPriceSol, reason, sellFraction = 1.0) {
    const portfolio = getPortfolio();
    const posIndex = portfolio.positions.findIndex(p => p.mint_address === mintAddress);
    if (posIndex === -1) return false;
    
    const pos = portfolio.positions[posIndex];
    const tokenSymbol = pos.token_symbol || 'UNKNOWN';
    const isLive = portfolio.mode === 'LIVE';
    
    let sellQuantity = new BigNumber(pos.quantity).times(sellFraction).toNumber();

    console.log(`\n⚡ [Sell] 正在嘗試平倉: ${tokenSymbol} (預期比例: ${sellFraction * 100}%)`);

    if (isLive && globalWalletPublicKey) {
        const realBal = await getRealTokenBalance(globalWalletPublicKey, mintAddress);
        if (realBal !== null) {
            if (realBal === 0) {
                console.error(`🚨 [FATAL] 鏈上餘額為 0，無法賣出！自動執行本地撇帳。`);
                await forceWriteOff(mintAddress, "實盤餘額為 0，假持倉撇帳");
                return false;
            }
            sellQuantity = new BigNumber(realBal).times(sellFraction).toNumber();
            console.log(`🔍 [Live Check] 調整真實賣出數量為: ${sellQuantity.toFixed(4)}`);
        }
    }

    const quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity);
    
    if (!quoteData) {
        try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 3000 });
            const pair = dexRes.data?.pairs?.find(p => p.chainId === 'solana');
            if ((pair?.liquidity?.usd || 0) < 500) await forceWriteOff(mintAddress, "流動性枯竭，強行撇帳");
        } catch (e) {}
        return false; 
    }
    
    const finalPriceSol = quoteData.pricePerToken;
    let tradeSuccess = true;
    let finalTxid = "SELL_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 

    // 🚀 紀錄售前餘額 (對撞起點)
    let preSellBalanceLamports = 0;
    if (isLive && globalWalletPublicKey) {
        try {
            preSellBalanceLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
        } catch (e) {}
    }

    if (isLive) {
        const liveResult = await executeLiveSwapUAT(quoteData.rawResponse, "SELL");
        tradeSuccess = liveResult?.success || false;
        if (tradeSuccess && liveResult?.txid) {
            finalTxid = liveResult.txid;
        }
    }

    // 🚀 計算真實入袋 SOL (對撞終點)
    let actualSolReceived = 0;
    if (isLive && tradeSuccess && finalTxid.startsWith('3') && globalWalletPublicKey) { // Jito TXID 通常長過一般 string，以此判斷真 TX
        console.log(`🔍 [Live Check] 正在驗證鏈上真實 SOL 收益 (等待 5 秒確認區塊)...`);
        await new Promise(r => setTimeout(r, 5000));
        try {
            const postSellBalanceLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
            actualSolReceived = (postSellBalanceLamports - preSellBalanceLamports) / 1e9;
            console.log(`✅ [Live Check] 售前: ${(preSellBalanceLamports/1e9).toFixed(4)} | 售後: ${(postSellBalanceLamports/1e9).toFixed(4)} | 實際淨賺: ${actualSolReceived.toFixed(6)} SOL`);
        } catch (e) { console.warn("⚠️ [Live Check] 無法獲取售後餘額"); }
    }

    if (tradeSuccess) {
        let sellValueSol = new BigNumber(sellQuantity).times(finalPriceSol).toNumber();

        // 🚀 實盤精準對撞：使用真實入袋 SOL (已全數扣除 Tip/Gas/滑點摩擦)
        if (isLive && actualSolReceived !== 0) {
            sellValueSol = actualSolReceived;
        }

        const entryTotalValue = new BigNumber(pos.quantity).times(sellFraction).times(pos.entry_price_sol);
        const pnlSol = new BigNumber(sellValueSol).minus(entryTotalValue).toNumber();
        const pnlPct = new BigNumber(pnlSol).div(entryTotalValue).times(100).toNumber();

        await commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, `Jupiter: ${reason}`, sellQuantity, sellFraction, pos.strategy_type, finalTxid);
        return true;
    }
    return false;
}

async function executeSellRaydium(mintAddress, marketRefPriceSol, reason, sellFraction = 1.0) {
    return await executeSell(mintAddress, marketRefPriceSol, reason, sellFraction);
}

async function forceWriteOff(mintAddress, reason) {
    const portfolio = getPortfolio();
    const posIndex = portfolio.positions.findIndex(p => p.mint_address === mintAddress);
    if (posIndex === -1) return;
    const pos = portfolio.positions[posIndex];
    const isLive = portfolio.mode === 'LIVE'; 
    
    if (isLive) {
        try {
            await supabase.from('graveyard_pool').insert([{
                mint_address: pos.mint_address, token_symbol: pos.token_symbol,
                entry_price_sol: pos.entry_price_sol, quantity: pos.quantity,
                locked_rent_sol: 0.00203928, strategy_type: pos.strategy_type
            }]);
        } catch (err) {}
    }

    await commitTradeToDb(posIndex, 0, 0, -pos.entry_price_sol * pos.quantity, -100, `FORCE: ${reason}`, pos.quantity, 1.0, pos.strategy_type, "FORCE_WRITE_OFF");
}

async function commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, finalReason, sellQuantity, sellFraction, originalStrategyType, txid) {
    const portfolio = getPortfolio();
    const pos = portfolio.positions[posIndex];
    const mintAddress = pos.mint_address;
    const isLive = portfolio.mode === 'LIVE';
    const tableSuffix = isLive ? 'live' : 'paper';
    
    const safeStrategyType = originalStrategyType || 'AUTO';

    updateCache('SELL', sellValueSol, sellFraction >= 0.99 ? pos : null);

    if (sellFraction >= 0.99) {
        await supabase.from(`active_positions_${tableSuffix}`).delete().eq('mint_address', mintAddress);
    } else {
        const newQty = new BigNumber(pos.quantity).minus(sellQuantity).toNumber();
        pos.quantity = newQty;
        pos.strategy_type = safeStrategyType + '_HALF_SOLD';
        await supabase.from(`active_positions_${tableSuffix}`).update({
            quantity: newQty, strategy_type: pos.strategy_type
        }).eq('mint_address', mintAddress);
    }

    const { data: dbConfig } = await supabase.from('system_config').select('*').eq('id', 1).single();
    let currentBalance = isLive ? Number(dbConfig.live_wallet_balance || 0) : Number(dbConfig.simulated_balance || 10);
    let newBalance = currentBalance + Number(sellValueSol);

    // 🚀 實盤精準對撞：更新 DB 的錢包餘額為鏈上真實數字
    if (isLive && globalWalletPublicKey) {
        try {
            const realLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
            newBalance = realLamports / 1e9;
        } catch (e) {}
    }

    await supabase.from('system_config')
        .update(isLive ? { live_wallet_balance: newBalance } : { simulated_balance: newBalance })
        .eq('id', 1);

    await supabase.from(`trade_history_${tableSuffix}`).insert([{
        token_mint: mintAddress, token_symbol: pos.token_symbol,
        action: sellFraction >= 0.99 ? 'SELL' : 'SELL_HALF',
        strategy_type: safeStrategyType, price_sol: finalPriceSol,
        quantity: sellQuantity, total_value_sol: sellValueSol,
        realized_pnl_sol: pnlSol, realized_pnl_pct: pnlPct,
        post_trade_balance: newBalance, txid: txid,
        ai_factcheck_result: finalReason, review_history: pos.last_review_comment || pos.ai_reason 
    }]);

    if(typeof sendTelegramAlert === 'function') {
        const modeTag = isLive ? '🔴 [實盤]' : '🟢 [模擬]';
        const pnlTag = pnlPct >= 0 ? `🟢 +${pnlPct.toFixed(2)}%` : `🔴 ${pnlPct.toFixed(2)}%`;
        sendTelegramAlert(`${modeTag} <b>📦 平倉完成</b>\n🪙 代幣: $${pos.token_symbol}\n📈 PNL: ${pnlTag}\n🔗 TX: ${isLive && !txid.includes('FORCE') ? `<a href="https://solscan.io/tx/${txid}">Solscan</a>` : txid}\n🧠 理由: ${finalReason}`);
    }
}

async function runSellPipeline(position, currentPrice, reason, fraction = 1.0) {
    try {
        console.log(`🎬 [Pipeline] 準備賣出 ${position.token_symbol || position.mint_address.substring(0,6)}...`);
        return await executeSell(position.mint_address, currentPrice, reason, fraction);
    } catch (err) {
        return false;
    }
}

module.exports = { executeBuy, executeSell, executeSellRaydium, forceWriteOff, runSellPipeline };