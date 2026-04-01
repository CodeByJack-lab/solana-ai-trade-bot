// src/services/tradeService.js
// 📝 檔案功能及用途：交易執行大腦。負責對接報價 API、管理雙軌倉位額度、實裝不對稱滑點並攔截連輸黑名單。

const { getPortfolio, updateCache } = require('./portfolioService');
const { supabase } = require('../config/supabase'); 
const axios = require('axios');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js'); 
const { connection } = require('../config/solana'); 
const BigNumber = require('bignumber.js'); 
const { executeLiveSwapUAT } = require('./liveTradeService');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService'); 
const { healthMonitor } = require('./healthMonitor');
const { getPersonNameByAddress, logNewDeposit, logNewWithdrawal, getContributionStats } = require('./dbService');
const configEnv = require('../config/config'); 

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

const SOL_MINT = "So11111111111111111111111111111111111111112";

const PUBLIC_RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com', 
    'https://solana-rpc.publicnode.com'    
];

async function executeReadWithFailover(operationName, readFunction) {
    for (let i = 0; i < PUBLIC_RPC_ENDPOINTS.length; i++) {
        const currentEndpoint = PUBLIC_RPC_ENDPOINTS[i];
        const readConnection = new Connection(currentEndpoint, 'confirmed');
        try {
            return await readFunction(readConnection);
        } catch (error) {
            console.warn(`⚠️ [Read Fallback] ${operationName} 於免費節點 ${i+1} 失敗，嘗試切換備援...`);
            if (i === PUBLIC_RPC_ENDPOINTS.length - 1) {
                try { return await readFunction(connection); } 
                catch (mainErr) { return null; }
            }
        }
    }
}

let globalWalletPublicKey = null;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    if (rawKey) {
        if (rawKey.startsWith('[')) globalWalletPublicKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))).publicKey.toString();
        else globalWalletPublicKey = Keypair.fromSecretKey(bs58.decode(rawKey)).publicKey.toString();
    }
} catch (e) { console.error("⚠️ [TradeService] 無法解析 Private Key"); }

async function getRealTokenBalance(walletPubKeyStr, tokenMintStr) {
    return await executeReadWithFailover('getRealTokenBalance', async (readConn) => {
        const walletKey = new PublicKey(walletPubKeyStr);
        const mintKey = new PublicKey(tokenMintStr);
        
        let attempts = 0;
        let totalUiAmount = 0;
        
        while (attempts < 3) {
            const parsedTokenAccounts = await readConn.getParsedTokenAccountsByOwner(walletKey, { mint: mintKey });
            if (parsedTokenAccounts.value.length === 0) {
                attempts++;
                if (attempts < 3) await new Promise(r => setTimeout(r, 1500)); 
                continue;
            }
            
            totalUiAmount = 0;
            for (const accountInfo of parsedTokenAccounts.value) {
                totalUiAmount += accountInfo.account.data.parsed.info.tokenAmount.uiAmount;
            }
            return totalUiAmount; 
        }
        return totalUiAmount; 
    });
}

async function getJupiterFinalQuote(tokenMint, isBuying, amount, customSlippageBps = null) {
    try {
        let decimals = 6; 
        const decimalsResult = await executeReadWithFailover('getTokenSupply', async (readConn) => {
            const supplyInfo = await readConn.getTokenSupply(new PublicKey(tokenMint));
            return supplyInfo.value?.decimals;
        });
        if (decimalsResult !== undefined && decimalsResult !== null) decimals = decimalsResult;

        let inputMint = isBuying ? SOL_MINT : tokenMint;
        let outputMint = isBuying ? tokenMint : SOL_MINT;
        
        let amountRaw = isBuying 
            ? new BigNumber(amount).times(1e9).integerValue().toString() 
            : new BigNumber(amount).times(new BigNumber(10).pow(decimals)).integerValue().toString();

        const defaultSlippage = isBuying ? 250 : 1500;
        const SLIPPAGE_BPS = customSlippageBps !== null ? customSlippageBps : defaultSlippage; 

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

    const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
    const maxMemePositions = config?.max_meme_positions || 0; 
    const maxTrendingPositions = config?.max_trending_positions || 5;

    const currentMemeCount = portfolio.positions.filter(p => p.strategy_type.includes('MEME')).length;
    const currentTrendingCount = portfolio.positions.filter(p => p.strategy_type.includes('TRENDING')).length;

    if (strategyType.includes('MEME') && currentMemeCount >= maxMemePositions) {
        console.log(`🛑 [倉位鎖] Meme 敢死隊已達上限 (${maxMemePositions} 隻)`);
        return false; 
    }
    if (strategyType.includes('TRENDING') && currentTrendingCount >= maxTrendingPositions) {
        console.log(`🛑 [倉位鎖] Top 100 藍籌已達上限 (${maxTrendingPositions} 隻)`);
        return false;
    }

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
                console.log(`🚫 [Blacklist] ${tokenSymbol} 最近連續兩次虧損，觸發黑名單防禦，拒絕建倉！`);
                return false;
            }
        }
    } catch (dbErr) {}

    const safetyBufferSol = portfolio.reference_capital * 0.1;
    const requiredTotalSol = configTradeAmountSol + safetyBufferSol;

    if (portfolio.cash_sol < requiredTotalSol) { 
        console.log(`❌ [Execution] 餘額不足 (${portfolio.cash_sol.toFixed(2)} < ${requiredTotalSol.toFixed(2)})，取消開倉。`);
        return false;
    }

    // 🚀 V9.1 階梯式滑點 + 狙擊等候環 (減壓版：解決 429 問題)
    const buySlippageSteps = [250, 500, 750, 1000];
    let quoteData = null;
    let actualSlippageUsed = 0;
    const maxRetries = 8; // 📉 減壓：最多等 40 秒 (8 次 x 5秒)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const stepSlippage of buySlippageSteps) {
            quoteData = await getJupiterFinalQuote(mintAddress, true, configTradeAmountSol, stepSlippage);
            if (quoteData) {
                actualSlippageUsed = stepSlippage;
                if (stepSlippage > 250) {
                    console.log(`⚠️ [Execution] 需放寬至 ${(stepSlippage/100).toFixed(1)}% 滑點方可成功獲取報價！`);
                }
                break; 
            }
            // 🛡️ 防奪命連環 Call：每次內部試不同滑點失敗後，微停 500ms
            await new Promise(r => setTimeout(r, 500));
        }
        
        if (quoteData) {
            if (attempt > 1) console.log(`✅ [Execution] Jupiter 終於載入新池路線！(等候咗大約 ${(attempt-1)*5} 秒)`);
            break; 
        }

        if (attempt < maxRetries) {
            console.log(`⏳ [Execution] Jupiter 尚未建立此幣路由 (嘗試 ${attempt}/${maxRetries})，等 5 秒再問...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    if (!quoteData) {
        console.log(`❌ [Execution] 等候 40 秒後 Jupiter 依然無報價 (可能為無流動性假池)，果斷放棄。`);
        
        // 🛡️ 終極防線：無路由假幣打入冷宮 24 小時，防無限 Loop 鞭屍
        try {
            const Redis = require('ioredis');
            const tempRedis = new Redis(configEnv.cache.redisUrl);
            await tempRedis.set(`scam_blacklist:${mintAddress}`, 'UNROUTABLE', 'EX', 86400);
            tempRedis.quit();
            
            console.log(`🗑️ [Blacklist] 已將 $${tokenSymbol} 加入 24 小時無法路由黑名單，停止盲目追擊。`);

            if (strategyType.includes('TRENDING')) {
                await supabase.from('trending_pool').delete().eq('mint_address', mintAddress);
            }
        } catch (redisErr) {
            console.error(`⚠️ [Blacklist Error] 無法寫入黑名單: ${redisErr.message}`);
        }
        
        return false;
    }
    
    let buyPriceSol = quoteData.pricePerToken;
    let tokenQuantity = new BigNumber(configTradeAmountSol).div(buyPriceSol).toNumber(); 
    let tradeSuccess = false;
    let finalTxid = "BUY_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 
    let totalCostSol = configTradeAmountSol;

    const JITO_TIP_SOL = (config?.jito_tip_lamports || 150000) / 1e9; 
    const PAPER_SLIPPAGE_PCT = 0.025; 

    if (isLive) {
        const liveResult = await executeLiveSwapUAT(quoteData.rawResponse, "BUY", aiReason);
        tradeSuccess = liveResult?.success || false;
        if (tradeSuccess && liveResult?.txid) {
            finalTxid = liveResult.txid; 
            console.log(`🔍 [Live Check] 正在驗證鏈上真實到帳數量...`);
            await new Promise(r => setTimeout(r, 5000));

            if (globalWalletPublicKey) {
                const realBal = await getRealTokenBalance(globalWalletPublicKey, mintAddress);
                if (realBal !== null && realBal > 0) tokenQuantity = realBal; 
                else if (realBal === 0) return false; 
            }
        }
    } else {
        buyPriceSol = buyPriceSol * (1 + PAPER_SLIPPAGE_PCT);
        tokenQuantity = new BigNumber(configTradeAmountSol).div(buyPriceSol).toNumber();
        totalCostSol = configTradeAmountSol + JITO_TIP_SOL; 
        tradeSuccess = true;
    }

    if (tradeSuccess && tokenQuantity > 0) {
        updateCache('BUY', totalCostSol, {
            mint_address: mintAddress, token_symbol: tokenSymbol,
            quantity: tokenQuantity, entry_price_sol: buyPriceSol,
            highest_price_sol: buyPriceSol, strategy_type: strategyType,
            created_at: new Date().toISOString() 
        });

        let currentBalance = isLive ? Number(config.live_wallet_balance || 0) : Number(config.simulated_balance || 10);
        let newBalance = currentBalance - Number(totalCostSol);

        if (isLive && globalWalletPublicKey) {
            const realLamports = await executeReadWithFailover('getBalance(Buy)', async (readConn) => {
                return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
            });
            if (realLamports !== null) newBalance = realLamports / 1e9;
        }

        await supabase.from('system_config').update(isLive ? { live_wallet_balance: newBalance } : { simulated_balance: newBalance }).eq('id', 1);

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

        console.log(`✅ 🟢 【買入成功 - ${tokenSymbol}】 🟢 ✅`);
        if(typeof sendTelegramAlert === 'function') {
            const modeTag = isLive ? '🔴 [實盤]' : '🟢 [模擬]';
            const typeTag = strategyType.includes('MEME') ? '🐣 Meme' : '🔥 TOP 100';
            sendTelegramAlert(`${modeTag} <b>✅ 買入成功</b>\n🏷️ 類別: ${typeTag}\n🪙 代幣: $${tokenSymbol}\n💰 投入: ${totalCostSol.toFixed(4)} SOL\n🔗 TX: ${isLive ? `<a href="https://solscan.io/tx/${finalTxid}">Solscan</a>` : finalTxid}\n🧠 理由: ${aiReason}`);
        }
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
                console.error(`🚨 [FATAL] 鏈上餘額確認為 0，自動執行本地撇帳。`);
                await forceWriteOff(mintAddress, "實盤餘額為 0，假持倉撇帳");
                return false;
            }
            sellQuantity = new BigNumber(realBal).times(sellFraction).toNumber();
        }
    }

    const isStopLoss = reason.includes('止損') || reason.includes('硬止損') || reason.includes('拔線') || reason.includes('瀑布') || reason.includes('EXIT');
    
    let currentSlippage = isStopLoss ? 1500 : 500; 
    let quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
    
    if (!quoteData) {
        console.warn(`⚠️ [Liquidity Warning] ${tokenSymbol} 無法於 ${(currentSlippage/100).toFixed(0)}% 滑點報價，啟動絕命放寬...`);
        const fallbackSteps = isStopLoss ? [2000, 3000, 5000] : [1000, 1500]; 
        
        for (const stepSlippage of fallbackSteps) {
            quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, stepSlippage);
            if (quoteData) {
                currentSlippage = stepSlippage;
                break; 
            }
        }
    }

    if (!quoteData) {
        console.error(`❌ [Fatal] 已達極限滑點仍無法取得報價，放棄本次平倉。`);
        return false; 
    }

    let impactPct = Number(quoteData.rawResponse.priceImpactPct || 0);
    
    if (isStopLoss && impactPct > 0.15) {
        console.log(`\n🚨 [DEFCON 2] 警告！偵測到毀滅性砸盤影響 (${(impactPct*100).toFixed(2)}%)！`);
        const expectedTotalSol = Number(quoteData.rawResponse.outAmount || 0) / 1e9;
        
        if (expectedTotalSol < 0.05 && sellFraction === 1.0) {
            console.log(`⚔️ 啟動「斷頭台模式」：解鎖極限滑點 (50%) 執行一刀切清倉止血！`);
            currentSlippage = 5000; 
            quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
            if (!quoteData) return false;
        } else {
            console.log(`🛡️ 啟動「分拆砸盤」機制，本次僅平倉原定比例的 50%。`);
            sellFraction = sellFraction * 0.5;
            sellQuantity = new BigNumber(pos.quantity).times(sellFraction).toNumber();
            quoteData = await getJupiterFinalQuote(mintAddress, false, sellQuantity, currentSlippage);
            if (!quoteData) return false;
        }
    }
    
    let finalPriceSol = quoteData.pricePerToken;
    let tradeSuccess = false;
    let finalTxid = "SELL_" + Math.random().toString(36).substring(2, 8).toUpperCase(); 

    const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
    const JITO_TIP_SOL = (config?.jito_tip_lamports || 150000) / 1e9; 
    const PAPER_SLIPPAGE_PCT = isStopLoss ? 0.05 : 0.01;

    let preSellBalanceLamports = 0;
    let sellValueSol = 0;

    if (isLive) {
        if (globalWalletPublicKey) {
            const preBal = await executeReadWithFailover('getBalance(PreSell)', async (readConn) => {
                return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
            });
            if (preBal !== null) preSellBalanceLamports = preBal;
        }
        
        let liveResult = await executeLiveSwapUAT(quoteData.rawResponse, "SELL", reason);
        tradeSuccess = liveResult?.success || false;
        
        if (!tradeSuccess && isStopLoss) {
            console.log(`⚔️ [DEFCON 1] 上鏈失敗！啟動階梯加碼強平與 Jito 暴力插隊！`);
            const liveFallbackSteps = [2000, 3000, 5000].filter(s => s > currentSlippage);
            for (const stepSlippage of liveFallbackSteps) {
                let desperateQuote = await getJupiterFinalQuote(mintAddress, false, sellQuantity, stepSlippage);
                if (desperateQuote) {
                    liveResult = await executeLiveSwapUAT(desperateQuote.rawResponse, "SELL", reason + " 拔線");
                    tradeSuccess = liveResult?.success || false;
                    if (tradeSuccess) {
                        quoteData = desperateQuote; 
                        finalPriceSol = quoteData.pricePerToken;
                        break; 
                    }
                }
            }
        }

        if (tradeSuccess && liveResult?.txid) {
            finalTxid = liveResult.txid;
            sellValueSol = new BigNumber(sellQuantity).times(finalPriceSol).toNumber();
            
            if (globalWalletPublicKey) {
                await new Promise(r => setTimeout(r, 5000));
                const postBal = await executeReadWithFailover('getBalance(PostSell)', async (readConn) => {
                    return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
                });
                if (postBal !== null) {
                    const actualSolReceived = (postBal - preSellBalanceLamports) / 1e9;
                    if (actualSolReceived > 0) sellValueSol = actualSolReceived;
                }
            }
        }
    } else {
        finalPriceSol = finalPriceSol * (1 - PAPER_SLIPPAGE_PCT);
        sellValueSol = (sellQuantity * finalPriceSol) - JITO_TIP_SOL; 
        tradeSuccess = true;
    }

    if (tradeSuccess) {
        const entryTotalValue = new BigNumber(pos.quantity).times(sellFraction).times(pos.entry_price_sol);
        const pnlSol = new BigNumber(sellValueSol).minus(entryTotalValue).toNumber();
        const pnlPct = new BigNumber(pnlSol).div(entryTotalValue).times(100).toNumber();

        await commitTradeToDb(posIndex, sellValueSol, finalPriceSol, pnlSol, pnlPct, reason, sellQuantity, sellFraction, pos.strategy_type, finalTxid);
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
                entry_price_sol: pos.entry_price_sol, quantity: pos.quantity, strategy_type: pos.strategy_type
            }]);
        } catch (err) {}
    }
    await commitTradeToDb(posIndex, 0, 0, -pos.entry_price_sol * pos.quantity, -100, reason, pos.quantity, 1.0, pos.strategy_type, "FORCE_WRITE_OFF");
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

    if (isLive && globalWalletPublicKey) {
        const realLamports = await executeReadWithFailover('getBalance(CommitDB)', async (readConn) => {
            return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
        });
        if (realLamports !== null) newBalance = realLamports / 1e9;
    }

    await supabase.from('system_config').update(isLive ? { live_wallet_balance: newBalance } : { simulated_balance: newBalance }).eq('id', 1);

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
        const typeTag = safeStrategyType.includes('MEME') ? '🐣 Meme' : '🔥 TOP 100';
        sendTelegramAlert(`${modeTag} <b>📦 平倉完成</b>\n🏷️ 類別: ${typeTag}\n🪙 代幣: $${pos.token_symbol}\n📈 PNL: ${pnlTag}\n🔗 TX: ${isLive && !txid.includes('FORCE') ? `<a href="https://solscan.io/tx/${txid}">Solscan</a>` : txid}\n🧠 理由: ${finalReason}`);
    }
}

async function runSellPipeline(position, currentPrice, reason, fraction = 1.0) {
    try {
        console.log(`🎬 [Pipeline] 準備賣出 ${position.token_symbol || position.mint_address.substring(0,6)}...`);
        return await executeSell(position.mint_address, currentPrice, reason, fraction);
    } catch (err) { return false; }
}

async function handleIncomingFund(address, amount, txid) {
    console.log(`🚀 [Process] 處理新入帳: ${amount} SOL from ${address}`);
    const personName = await getPersonNameByAddress(address);
    if (!personName) return;

    const isInserted = await logNewDeposit(address, personName, amount, txid);
    if (!isInserted) return;

    if (globalWalletPublicKey) {
        const realLamports = await executeReadWithFailover('getBalance(IncomingFund)', async (readConn) => {
            return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
        });
        if (realLamports !== null) await supabase.from('system_config').update({ live_wallet_balance: realLamports / 1e9 }).eq('id', 1);
    }

    const stats = await getContributionStats(personName);
    if (stats) {
        const percentage = parseFloat(stats.percentage) || 0;
        const currentBalance = parseFloat(stats.current_balance) || 0;
        if (typeof sendTelegramAlert === 'function') sendTelegramAlert(`💰 <b>資金到帳</b>\n👤 來源: ${stats.person_name}\n💵 入帳: <code>${amount}</code> SOL\n📊 佔比: <code>${percentage.toFixed(2)}%</code>\n🏛️ 資產: <code>${currentBalance.toFixed(4)}</code> SOL`);
    }
}

async function handleOutgoingFund(address, amount, txid) {
    console.log(`💸 [Process] 處理新出金: ${amount} SOL to ${address}`);
    let personName = await getPersonNameByAddress(address) || "未知金主"; 

    const isInserted = await logNewWithdrawal(address, personName, amount, txid);
    if (!isInserted) return;

    if (globalWalletPublicKey) {
        await new Promise(r => setTimeout(r, 2000));
        const realLamports = await executeReadWithFailover('getBalance(OutgoingFund)', async (readConn) => {
            return await readConn.getBalance(new PublicKey(globalWalletPublicKey));
        });
        if (realLamports !== null) await supabase.from('system_config').update({ live_wallet_balance: realLamports / 1e9 }).eq('id', 1);
    }

    const stats = await getContributionStats(personName);
    if (stats) {
        const percentage = parseFloat(stats.percentage) || 0;
        const currentBalance = parseFloat(stats.current_balance) || 0;
        if (typeof sendTelegramAlert === 'function') sendTelegramAlert(`💸 <b>資金提款</b>\n👤 對象: ${personName}\n💵 提走: <code>${amount}</code> SOL\n📊 佔比: <code>${percentage.toFixed(2)}%</code>\n🏛️ 資產: <code>${currentBalance.toFixed(4)}</code> SOL`);
    }
}

module.exports = { 
    executeBuy, executeSell, executeSellRaydium, forceWriteOff, runSellPipeline, handleIncomingFund, handleOutgoingFund
};