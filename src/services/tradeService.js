// src/services/tradeService.js
const { getPortfolio, updateCache } = require('./portfolioService');
const { supabase } = require('../config/supabase'); 
const axios = require('axios');
const { PublicKey, Keypair } = require('@solana/web3.js'); 
const { connection } = require('../config/solana'); 
const BigNumber = require('bignumber.js'); 
const { executeLiveSwapUAT } = require('./liveTradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService'); 
const { healthMonitor } = require('./healthMonitor');
const { getPersonNameByAddress, logNewDeposit, logNewWithdrawal, getContributionStats } = require('./dbService');
const configEnv = require('../config/env'); 

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

let globalWalletPublicKey = null;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
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

// ⚠️ V8.2 RPC 節食：此函數僅在 Live 交易確認後調用
async function getRealTokenBalance(walletPubKeyStr, tokenMintStr) {
    try {
        const walletKey = new PublicKey(walletPubKeyStr);
        const mintKey = new PublicKey(tokenMintStr);
        const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKey, { mint: mintKey });
        if (parsedTokenAccounts.value.length === 0) return 0;

        let totalUiAmount = 0;
        for (const accountInfo of parsedTokenAccounts.value) {
            totalUiAmount += accountInfo.account.data.parsed.info.tokenAmount.uiAmount;
        }
        return totalUiAmount;
    } catch (e) {
        console.error(`⚠️ [Balance Check] 無法獲取真實代幣餘額:`, e.message);
        return null; 
    }
}

// 🎯 V8.2 核心：無論 Live 定 Paper，都要 Call Jupiter 問真實報價與滑點
async function getJupiterFinalQuote(tokenMint, isBuying, amount, customSlippageBps = null) {
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

        const SLIPPAGE_BPS = customSlippageBps !== null ? customSlippageBps : (isBuying ? 1000 : 1500); 

        const baseUrl = (configEnv.external.jupiterBaseUrl || 'https://quote-api.jup.ag').replace(/\/$/, '');
        const endpoint = baseUrl.includes('quote-api') ? '/v6/quote' : '/swap/v1/quote';
        const url = `${baseUrl}${endpoint}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`;

        const config = { headers: {} };
        if (configEnv.external.jupiterApiKey) {
            config.headers['x-api-key'] = configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim();
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

    // ==========================================
    // 👑 V8.2 上帝視角倉位鎖
    // ==========================================
    const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
    const maxMemePositions = config?.max_meme_positions || 2; 
    const maxTrendingPositions = config?.max_trending_positions || 3;

    const currentMemeCount = portfolio.positions.filter(p => p.strategy_type.includes('MEME')).length;
    const currentTrendingCount = portfolio.positions.filter(p => p.strategy_type.includes('TRENDING')).length;

    if (strategyType.includes('MEME') && currentMemeCount >= maxMemePositions) {
        console.log(`🛑 [倉位鎖] Meme 敢死隊已達上限 (${maxMemePositions} 隻)，停止買入！`);
        return false; 
    }
    if (strategyType.includes('TRENDING') && currentTrendingCount >= maxTrendingPositions) {
        console.log(`🛑 [倉位鎖] Top 100 提款機已達上限 (${maxTrendingPositions} 隻)，停止買入！`);
        return false;
    }

    // 檢查連敗黑名單
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

    // 資金檢查 (Live & Paper 共用)
    const safetyBufferSol = portfolio.reference_capital * 0.1;
    const requiredTotalSol = configTradeAmountSol + safetyBufferSol;

    if (portfolio.cash_sol < requiredTotalSol) { 
        console.log(`❌ [Execution] 餘額不足 (${portfolio.cash_sol.toFixed(2)} < ${requiredTotalSol.toFixed(2)})，取消開倉。`);
        return false;
    }

    // 🎯 取得真實報價
    const quoteData = await getJupiterFinalQuote(mintAddress, true, configTradeAmountSol); 
    if (!quoteData) {
        console.log(`❌ [Execution] 無法獲取 Jupiter 報價，放棄買入。`);
        return false;
    }
    
    let buyPriceSol = quoteData.pricePerToken;
    let tokenQuantity = new BigNumber(configTradeAmountSol).div(buyPriceSol).toNumber(); 
    let tradeSuccess = false;
    let finalTxid = "BUY_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 
    let totalCostSol = configTradeAmountSol;

    // ==========================================
    // 🩸 V8.2 真實模擬交易引擎 (扣滑點 + Jito)
    // ==========================================
    const JITO_TIP_SOL = (config?.jito_tip_lamports || 100000) / 1e9; 
    const isMeme = strategyType.includes('MEME');
    const PAPER_SLIPPAGE_PCT = isMeme ? 0.02 : 0.005; // Meme 預設 2% 滑點損耗，藍籌 0.5%

    if (isLive) {
        // 真倉執行
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
        }
    } else {
        // 紙黃金執行：硬扣真實滑點 + Jito
        buyPriceSol = buyPriceSol * (1 + PAPER_SLIPPAGE_PCT);
        tokenQuantity = new BigNumber(configTradeAmountSol).div(buyPriceSol).toNumber();
        totalCostSol = configTradeAmountSol + JITO_TIP_SOL; 
        
        console.log(`📝 [Paper Buy] 模擬買入 $${tokenSymbol} | 原價: ${(quoteData.pricePerToken).toFixed(8)} | 扣滑點後買價: ${buyPriceSol.toFixed(8)}`);
        console.log(`💸 [Paper Buy] 總成本(含 ${JITO_TIP_SOL} SOL 賄賂): ${totalCostSol.toFixed(4)} SOL`);
        tradeSuccess = true;
    }

    // 寫入資料庫
    if (tradeSuccess && tokenQuantity > 0) {
        updateCache('BUY', totalCostSol, {
            mint_address: mintAddress, token_symbol: tokenSymbol,
            quantity: tokenQuantity, entry_price_sol: buyPriceSol,
            highest_price_sol: buyPriceSol, strategy_type: strategyType,
            created_at: new Date().toISOString() 
        });

        let currentBalance = isLive ? Number(config.live_wallet_balance || 0) : Number(config.simulated_balance || 10);
        let newBalance = currentBalance - Number(totalCostSol);

        // Live 模式下，更新真實 RPC 餘額
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
            total_value_sol: totalCostSol, post_trade_balance: newBalance, 
            txid: finalTxid, ai_factcheck_result: aiReason, review_history: aiReason 
        }]);

        console.log(`\n======================================================`);
        console.log(`✅ 🟢 【買入成功 - ${tokenSymbol}】 🟢 ✅`);
        console.log(`📍 策略: ${strategyType}`);
        console.log(`💰 價格: $${buyPriceSol.toFixed(8)} SOL`);
        console.log(`投入金額: ${totalCostSol} SOL (含 Jito)`);
        console.log(`🤖 AI 理由: ${aiReason}`);
        console.log(`======================================================\n`);

        if(typeof sendTelegramAlert === 'function') {
            const modeTag = isLive ? '🔴 [實盤]' : '🟢 [模擬]';
            sendTelegramAlert(`${modeTag} <b>✅ 買入成功</b>\n🪙 代幣: $${tokenSymbol}\n💰 投入: ${totalCostSol.toFixed(4)} SOL\n🔗 TX: ${isLive ? `<a href="https://solscan.io/tx/${finalTxid}">Solscan</a>` : finalTxid}\n🧠 理由: ${aiReason}`);
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

    const isStopLoss = reason.includes('止損') || reason.includes('硬止損') || reason.includes('虧損') || reason.includes('拔線') || reason.includes('瀑布');
    let currentSlippage = isStopLoss ? 1500 : 500; 

    let quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
    
    if (!quoteData) {
        console.log(`⚠️ [Liquidity Warning] ${tokenSymbol} 查無常規報價，流動性可能枯竭。嘗試最高絕望滑點 (30%) 強平...`);
        currentSlippage = 3000;
        quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
    }

    if (!quoteData) {
        try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 3000 });
            const pair = dexRes.data?.pairs?.find(p => p.chainId === 'solana');
            if ((pair?.liquidity?.usd || 0) < 500) await forceWriteOff(mintAddress, "流動性枯竭，強行撇帳");
        } catch (e) {}
        return false; 
    }

    let impactPct = Number(quoteData.rawResponse.priceImpactPct || 0);
    if (isStopLoss && impactPct > 0.15) {
        console.log(`\n🚨 [Slippage Control] 警告！偵測到毀滅性砸盤影響 (${(impactPct*100).toFixed(2)}%)！`);
        
        const expectedTotalSol = Number(quoteData.rawResponse.outAmount || 0) / 1e9;
        
        if (expectedTotalSol < 0.05 && sellFraction === 1.0) {
            console.log(`🗑️ [Dust Clean] 剩餘預期價值極低 (${expectedTotalSol.toFixed(4)} SOL < 0.05 SOL)！`);
            console.log(`⚔️ 啟動「斷頭台模式」：解鎖極限滑點 (50%) 執行一刀切清倉止血！`);
            currentSlippage = 5000; 
            quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
            if (!quoteData) return false;
        } else {
            console.log(`🛡️ 啟動「分拆砸盤」機制，本次僅平倉原定比例的 50%。`);
            sellFraction = sellFraction * 0.5;
            let baseQuantity = pos.quantity;
            if (isLive && globalWalletPublicKey) {
                const realBal = await getRealTokenBalance(globalWalletPublicKey, mintAddress);
                if (realBal !== null && realBal > 0) baseQuantity = realBal;
            }
            sellQuantity = new BigNumber(baseQuantity).times(sellFraction).toNumber();

            quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
            if (!quoteData) return false;
        }
    }
    
    let finalPriceSol = quoteData.pricePerToken;
    let tradeSuccess = false;
    let finalTxid = "SELL_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 

    // ==========================================
    // 🩸 V8.2 真實模擬交易引擎 (扣滑點 + Jito)
    // ==========================================
    const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
    const JITO_TIP_SOL = (config?.jito_tip_lamports || 100000) / 1e9; 
    const isMeme = pos.strategy_type.includes('MEME');
    const PAPER_SLIPPAGE_PCT = isMeme ? 0.02 : 0.005;

    let preSellBalanceLamports = 0;
    let actualSolReceived = 0;
    let sellValueSol = 0;

    if (isLive) {
        if (globalWalletPublicKey) {
            try { preSellBalanceLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey)); } catch (e) {}
        }
        
        const liveResult = await executeLiveSwapUAT(quoteData.rawResponse, "SELL");
        tradeSuccess = liveResult?.success || false;
        
        if (tradeSuccess && liveResult?.txid) {
            finalTxid = liveResult.txid;
            sellValueSol = new BigNumber(sellQuantity).times(finalPriceSol).toNumber();
            
            if (globalWalletPublicKey) {
                console.log(`🔍 [Live Check] 正在驗證鏈上真實 SOL 收益 (等待 5 秒確認區塊)...`);
                await new Promise(r => setTimeout(r, 5000));
                try {
                    const postSellBalanceLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
                    actualSolReceived = (postSellBalanceLamports - preSellBalanceLamports) / 1e9;
                    if (actualSolReceived > 0) sellValueSol = actualSolReceived;
                    console.log(`✅ [Live Check] 實際淨賺: ${actualSolReceived.toFixed(6)} SOL`);
                } catch (e) { console.warn("⚠️ [Live Check] 無法獲取售後餘額"); }
            }
        }
    } else {
        // 紙黃金執行：硬扣真實滑點 - Jito
        finalPriceSol = finalPriceSol * (1 - PAPER_SLIPPAGE_PCT);
        sellValueSol = (sellQuantity * finalPriceSol) - JITO_TIP_SOL; 
        
        console.log(`📝 [Paper Sell] 模擬賣出 $${tokenSymbol} | 原價: ${(quoteData.pricePerToken).toFixed(8)} | 扣滑點後賣價: ${finalPriceSol.toFixed(8)}`);
        console.log(`💸 [Paper Sell] 實收(已扣 ${JITO_TIP_SOL} SOL 賄賂): ${sellValueSol.toFixed(4)} SOL`);
        tradeSuccess = true;
    }

    if (tradeSuccess) {
        const entryTotalValue = new BigNumber(pos.quantity).times(sellFraction).times(pos.entry_price_sol);
        const pnlSol = new BigNumber(sellValueSol).minus(entryTotalValue).toNumber();
        const pnlPct = new BigNumber(pnlSol).div(entryTotalValue).times(100).toNumber();

        const pnlIcon = pnlPct > 0 ? '🚀 止盈' : '🩸 止損';
        console.log(`\n======================================================`);
        console.log(`💳 🔴 【賣出成功 - ${tokenSymbol}】 🔴 💳`);
        console.log(`📊 動作: ${pnlIcon} (${pnlPct.toFixed(2)}%)`);
        console.log(`💰 淨賺/虧損: ${pnlSol.toFixed(4)} SOL`);
        console.log(`🤖 AI 理由: ${reason}`);
        console.log(`======================================================\n`);

        await commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, reason, sellQuantity, sellFraction, pos.strategy_type, finalTxid);
        return true;
    }
    return false;
}

// 💀 老幣火化：為了相容性保留此 function 名稱，但直接導向 executeSell
async function executeSellRaydium(mintAddress, marketRefPriceSol, reason, sellFraction = 1.0) {
    return await executeSell(mintAddress, marketRefPriceSol, reason, sellFraction);
}

// 💀 假持倉撇帳 (流動性歸零用)
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

    await commitTradeToDb(posIndex, 0, 0, -pos.entry_price_sol * pos.quantity, -100, reason, pos.quantity, 1.0, pos.strategy_type, "FORCE_WRITE_OFF");
}

// 💾 寫入資料庫
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

// ... 保留 handleIncomingFund 同 handleOutgoingFund 唔變 ...
async function handleIncomingFund(address, amount, txid) {
    console.log(`🚀 [Process] 處理新入帳: ${amount} SOL from ${address}`);
    const personName = await getPersonNameByAddress(address);
    if (!personName) return;

    const isInserted = await logNewDeposit(address, personName, amount, txid);
    if (!isInserted) return;

    if (globalWalletPublicKey) {
        try {
            const realLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
            await supabase.from('system_config').update({ live_wallet_balance: realLamports / 1e9 }).eq('id', 1);
        } catch (e) {}
    }

    const stats = await getContributionStats(personName);
    if (stats) {
        let rankIcon = "🐟";
        const percentage = parseFloat(stats.percentage) || 0;
        if (percentage > 10) rankIcon = "🐬"; if (percentage > 30) rankIcon = "🦈"; if (percentage > 50) rankIcon = "🐋";
        const currentBalance = parseFloat(stats.current_balance) || 0;
        const message = `💰 <b>實時報捷 - 資金到帳</b>\n----------------------------\n👤 <b>來源錢包</b>: ${stats.person_name} ${rankIcon}\n💵 <b>本次入帳</b>: <code>${amount}</code> SOL\n📊 <b>系統佔比</b>: <code>${percentage.toFixed(2)}%</code>\n🏛️ <b>淨資產值</b>: <code>${currentBalance.toFixed(4)}</code> SOL\n\n🔗 <a href="https://solscan.io/address/${stats.wallet_address}">在 Solscan 查看帳戶</a>\n🔍 <a href="https://solscan.io/tx/${txid}">查看此筆交易</a>\n----------------------------\n📅 <i>更新時間: ${new Date().toLocaleString('zh-HK')}</i>`;
        if (typeof sendTelegramAlert === 'function') sendTelegramAlert(message);
    }
}

async function handleOutgoingFund(address, amount, txid) {
    console.log(`💸 [Process] 處理新出金: ${amount} SOL to ${address}`);
    let personName = await getPersonNameByAddress(address);
    if (!personName) personName = "未知金主"; 

    const isInserted = await logNewWithdrawal(address, personName, amount, txid);
    if (!isInserted) return;

    if (globalWalletPublicKey) {
        try {
            await new Promise(r => setTimeout(r, 2000));
            const realLamports = await connection.getBalance(new PublicKey(globalWalletPublicKey));
            await supabase.from('system_config').update({ live_wallet_balance: realLamports / 1e9 }).eq('id', 1);
        } catch (e) {}
    }

    const stats = await getContributionStats(personName);
    if (stats) {
        const percentage = parseFloat(stats.percentage) || 0;
        const currentBalance = parseFloat(stats.current_balance) || 0;
        const message = `💸 <b>實時戰報 - 資金提款</b>\n----------------------------\n👤 <b>提款對象</b>: ${personName} \n💵 <b>提走金額</b>: <code>${amount}</code> SOL\n📊 <b>剩餘佔比</b>: <code>${percentage.toFixed(2)}%</code>\n🏛️ <b>剩餘資產</b>: <code>${currentBalance.toFixed(4)}</code> SOL\n\n🔍 <a href="https://solscan.io/tx/${txid}">查看此筆交易</a>\n----------------------------\n📅 <i>更新時間: ${new Date().toLocaleString('zh-HK')}</i>`;
        if (typeof sendTelegramAlert === 'function') sendTelegramAlert(message);
    }
}

module.exports = { 
    executeBuy, 
    executeSell, 
    executeSellRaydium, 
    forceWriteOff, 
    runSellPipeline, 
    handleIncomingFund,
    handleOutgoingFund
};