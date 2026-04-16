// src/services/liveTradeService.js
// 📝 檔案功能用途：實盤簽名與上鏈引擎。
// 🚀 V9.3 強化：實裝交易後「秒速餘額校準」機制，杜絕 PnL 數據幻象。

const { Keypair, VersionedTransaction, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { connection, broadcastWithPromiseAny } = require('../config/solana'); 
const { supabase } = require('../config/supabase'); 
const { cacheManager } = require('./cacheManager'); 
const { syncLiveBalanceToDB } = require('./portfolioService'); // 🚀 引入同步核心
const axios = require('axios');
const { healthMonitor } = require('./healthMonitor'); 
const configEnv = require('../config/config'); 

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg",
    "DfXygSm4jcyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjv", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7QsBgTysiEwCAQtbNheJ4sBE", "3AVi9Tg9Uao68XNwNmtcwEdqvLhATCq0MExeb1Z51vtv"
];

const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles'
];

let wallet;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            const Uint8ArrayKey = Uint8Array.from(JSON.parse(rawKey));
            wallet = Keypair.fromSecretKey(Uint8ArrayKey);
        } else {
            const decodedKey = bs58.decode(rawKey);
            wallet = Keypair.fromSecretKey(decodedKey);
        }
        console.log(`🔑 [Live Engine] 錢包已掛載。地址: ${wallet.publicKey.toString()}`);
        healthMonitor.setStatus('Live_Engine', '🟢 錢包已掛載 (待命)'); 
    } else {
        healthMonitor.setStatus('Live_Engine', '🟡 模擬模式 (無私鑰)'); 
    }
} catch (err) {
    healthMonitor.setStatus('Live_Engine', `🔴 私鑰解析失敗`); 
}

async function pollSignatureStatus(signature, timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const { value: status } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
                if (status.err) {
                    throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
                }
                return true; 
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000)); 
    }
    throw new Error('Jito Bundle 確認超時 (Transaction Dropped or Pending)');
}

async function getJupiterSwapTransaction(quoteResponse) {
    if (!wallet) return null;
    const baseUrl = (configEnv.external.jupiterBaseUrl || 'https://quote-api.jup.ag').replace(/\/$/, '');
    const endpoint = baseUrl.includes('quote-api') ? '/v6/swap' : '/swap/v1/swap';
    
    const config = { headers: {} };
    if (configEnv.external.jupiterApiKey) {
        config.headers['x-api-key'] = configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim();
    }

    const payload = {
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true, 
        dynamicComputeUnitLimit: true, 
        prioritizationFeeLamports: "auto" 
    };

    const maxRetries = 3; 
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(`${baseUrl}${endpoint}`, payload, config);
            return response.data.swapTransaction;
        } catch (err) {
            const status = err.response?.status;
            console.warn(`⚠️ [Jupiter Swap] 構建交易失敗 (嘗試 ${attempt}/${maxRetries}): Status ${status} - ${err.response?.data?.error || err.message}`);
            if (attempt === maxRetries) return null;
            await new Promise(r => setTimeout(r, 1100)); 
        }
    }
    return null;
}

async function fetchJitoTipFloor() {
    try {
        const res = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { timeout: 2000 });
        if (res.data && res.data.length > 0) {
            return res.data[0].landed_tips_50th_percentile || 150000;
        }
    } catch (err) {}
    return 150000;
}

async function executeLiveSwapUAT(quoteResponse, action, reason = '') {
    if (!wallet) return { success: false, txid: null };

    console.log(`\n⚡ [Live Execution] 正在向 Jupiter 請求構建 ${action} 交易...`);
    healthMonitor.setStatus('Live_Engine', `🟢 構建 ${action} 交易中...`); 

    const swapTransactionBase64 = await getJupiterSwapTransaction(quoteResponse);
    if (!swapTransactionBase64) {
        healthMonitor.setStatus('Live_Engine', '🔴 構建交易失敗'); 
        return { success: false, txid: null };
    }

    try {
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`🔬 [Pre-flight Check] 正在本地模擬交易...`);
        const simulationResult = await connection.simulateTransaction(transaction);
        if (simulationResult.value.err) {
            console.error(`❌ [Pre-flight Failed] 模擬失敗:`, JSON.stringify(simulationResult.value.err));
            healthMonitor.setStatus('Live_Engine', '🔴 模擬交易失敗'); 
            return { success: false, txid: null };
        } 
        
        console.log(`✅ [Pre-flight Success] 模擬通過，準備進入 Jito 動態拍賣場...`);

        const cache = cacheManager.getConfig();
        const baseTip = cache.base_jito_tip || 150000;
        const maxTipPct = cache.max_jito_tip_pct || 0.02;

        let currentTip = baseTip;
        let isEmergency = false;
        let maxBuyTipLamports = Infinity;

        if (action === 'BUY') {
            const tradeAmountLamports = Number(quoteResponse.inAmount || 0);
            maxBuyTipLamports = tradeAmountLamports * maxTipPct;
            const p50Tip = await fetchJitoTipFloor();
            if (p50Tip > maxBuyTipLamports) {
                console.log(`🛑 [Jito 防護] 小費超出上限，放棄買單。`);
                return { success: false, txid: null };
            }
            currentTip = Math.min(p50Tip, maxBuyTipLamports);
        } else if (action === 'SELL' && reason) {
            if (reason.includes('瀑布') || reason.includes('硬止損') || reason.includes('崩盤') || reason.includes('拔線') || reason.includes('EXIT')) {
                currentTip = baseTip * 4; 
                isEmergency = true;
            }
        }

        const maxRetries = isEmergency ? 4 : 3; 
        const serializedSwapTx = transaction.serialize();
        const base58SwapTx = bs58.encode(serializedSwapTx);
        const txid = bs58.encode(transaction.signatures[0]);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const latestBlockHash = await connection.getLatestBlockhash();
            const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
            const tipTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tipAccount, lamports: Math.floor(currentTip) }));
            tipTx.recentBlockhash = latestBlockHash.blockhash;
            tipTx.feePayer = wallet.publicKey;
            tipTx.sign(wallet);

            const serializedTipTx = bs58.encode(tipTx.serialize());
            const bundlePayload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [ [base58SwapTx, serializedTipTx] ] };

            await Promise.all(JITO_ENDPOINTS.map(url => axios.post(url, bundlePayload, { timeout: 3000 }).catch(() => null)));

            try {
                await pollSignatureStatus(txid, 5000); 
                console.log(`🎉 [Live Trade] ${action} 交易已在鏈上確認！`);
                
                // 🚀 修復 4：交易確認後立即校準真倉餘額
                syncLiveBalanceToDB(); 
                
                healthMonitor.setStatus('Live_Engine', `🟢 交易確認成功`); 
                return { success: true, txid: txid }; 
            } catch (e) {
                if (attempt < maxRetries) currentTip = currentTip * 2; 
            }
        }

        if (action === 'SELL') {
            try {
                const fastestSig = await broadcastWithPromiseAny(serializedSwapTx);
                await pollSignatureStatus(fastestSig, 15000);
                
                // 🚀 修復 4：絕命廣播成功後也進行同步
                syncLiveBalanceToDB(); 
                
                return { success: true, txid: fastestSig };
            } catch (broadcastErr) {}
        }

        return { success: false, txid: null };
    } catch (err) {
        return { success: false, txid: null };
    }
}

module.exports = { executeLiveSwapUAT };