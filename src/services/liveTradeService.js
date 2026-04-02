// src/services/liveTradeService.js
// 📝 檔案功能用途：實盤簽名與上鏈引擎。對接 Jito Block Engine 進行 Bundle 拍賣，實裝 V9.2 Jito 智能封頂 (max_buy_tip_pct) 與 P50 網絡感知，具備 Promise.any 絕命備援。

const { Keypair, VersionedTransaction, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { connection, broadcastWithPromiseAny } = require('../config/solana'); 
const { supabase } = require('../config/supabase'); 
const { cacheManager } = require('./cacheManager'); // 🛡️ V9.2 引入快取大腦
const axios = require('axios');
const { healthMonitor } = require('./healthMonitor'); 
const configEnv = require('../config/config'); 

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

// 💸 Jito 官方小費收集地址
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg",
    "DfXygSm4jcyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjv",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7QsBgTysiEwCAQtbNheJ4sBE",
    "3AVi9Tg9Uao68XNwNmtcwEdqvLhATCq0MExeb1Z51vtv"
];

// 🚀 Jito 全球多節點廣播
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

// 🚀 極速確認機制
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

// 🚀 加入 1.1 秒精確破盾重試 (Micro-Retry) 防 429 斷線
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
            
            if (attempt === maxRetries) {
                console.error(`❌ [Jupiter Swap] 已達最大重試次數，徹底放棄構建。`);
                return null;
            }
            
            console.log(`⏳ 觸發 1.1 秒精確冷卻以重置 API 視窗...`);
            await new Promise(r => setTimeout(r, 1100)); 
        }
    }
    return null;
}

// 📊 獲取 Jito P50 網絡擠塞指數
async function fetchJitoTipFloor() {
    try {
        const res = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { timeout: 2000 });
        if (res.data && res.data.length > 0) {
            return res.data[0].landed_tips_50th_percentile || 150000;
        }
    } catch (err) {}
    return 150000; // 預設保底 0.00015 SOL
}

// 🎯 接收 reason 參數，啟動智能環境感知、多路備援與防水魚封頂
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

        // 🛡️ V9.2 核心：極速讀取 RAM 快取，獲取小費戰略
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
            console.log(`📊 [Jito Oracle] 當前網絡 P50 小費中位數為 ${(p50Tip/1e9).toFixed(5)} SOL`);

            // 如果 P50 已經貴過我哋條底線，即刻走人
            if (p50Tip > maxBuyTipLamports) {
                console.log(`🛑 [Jito 防護] 當前網絡 P50 小費超出本金 ${maxTipPct*100}% 上限 (${(maxBuyTipLamports/1e9).toFixed(5)} SOL)！為防被當水魚，果斷放棄建倉。`);
                healthMonitor.setStatus('Live_Engine', '🔴 網絡擠塞，放棄高成本買單');
                return { success: false, txid: null };
            }

            // 用 P50 與 上限 之間嘅最小值做起步價
            currentTip = Math.min(p50Tip, maxBuyTipLamports);
            
        } else if (action === 'SELL' && reason) {
            if (reason.includes('瀑布') || reason.includes('硬止損') || reason.includes('崩盤') || reason.includes('拔線') || reason.includes('EXIT')) {
                currentTip = baseTip * 4; 
                isEmergency = true;
                console.log(`🚨 [環境感知] 偵測到極端危險，Jito 起步價直接拉升至 ${(currentTip/1e9).toFixed(5)} SOL！`);
            }
        }

        const maxRetries = isEmergency ? 4 : 3; 
        const serializedSwapTx = transaction.serialize();
        const base58SwapTx = bs58.encode(serializedSwapTx);
        const txid = bs58.encode(transaction.signatures[0]);

        // 階梯式加注迴圈 (Jito)
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`💸 [Jito 拍賣 - 第 ${attempt}/${maxRetries} 輪] 出價: ${(currentTip / 1e9).toFixed(5)} SOL`);
            healthMonitor.setStatus('Live_Engine', `🟢 Jito 第 ${attempt} 輪競價...`); 

            const latestBlockHash = await connection.getLatestBlockhash();
            const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
            
            const tipTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: tipAccount,
                    lamports: Math.floor(currentTip), 
                })
            );
            tipTx.recentBlockhash = latestBlockHash.blockhash;
            tipTx.feePayer = wallet.publicKey;
            tipTx.sign(wallet);

            const serializedTipTx = bs58.encode(tipTx.serialize());
            const bundlePayload = {
                jsonrpc: "2.0", id: 1, method: "sendBundle",
                params: [ [base58SwapTx, serializedTipTx] ]
            };

            const sendPromises = JITO_ENDPOINTS.map(url => 
                axios.post(url, bundlePayload, { headers: { 'Content-Type': 'application/json' }, timeout: 3000 }).catch(() => null) 
            );
            await Promise.all(sendPromises);

            console.log(`🔗 追蹤連結: https://solscan.io/tx/${txid}`);
            console.log(`⏳ 等待區塊鏈確認 (最大等候 5 秒)...`);

            try {
                await pollSignatureStatus(txid, 5000); 
                console.log(`🎉 [Live Trade] ${action} 交易已在鏈上確認！成交 Tip: ${(currentTip / 1e9).toFixed(5)} SOL`);
                healthMonitor.setStatus('Live_Engine', `🟢 交易確認成功`); 
                setTimeout(() => healthMonitor.setStatus('Live_Engine', '🟢 錢包已掛載 (待命)'), 5000); 
                return { success: true, txid: txid }; 
            } catch (e) {
                console.log(`⚠️ [Jito 拍賣失敗] 交易超時或被擠出。`);
                if (attempt < maxRetries) {
                    currentTip = currentTip * 2; 
                    
                    // 🛡️ V9.2 買單鎖死：加碼時絕對唔可以爆上限
                    if (action === 'BUY' && currentTip > maxBuyTipLamports) {
                        currentTip = maxBuyTipLamports;
                        console.log(`🔥 準備加碼保護費，但已達 ${maxTipPct*100}% 上限，鎖死出價: ${(currentTip/1e9).toFixed(5)} SOL`);
                    } else {
                        console.log(`🔥 準備加碼保護費，重新發送...`);
                    }
                }
            }
        }

        // 🚨 絕命備援：如果 Jito 徹底失敗，且為賣出逃生，呼叫 Promise.any 多路廣播！
        if (action === 'SELL') {
            console.error(`❌ [Jito 拍賣失敗] 已達最大重試次數。啟動 V9.0 絕命公鏈廣播 (Promise.any)...`);
            try {
                const fastestSig = await broadcastWithPromiseAny(serializedSwapTx);
                await pollSignatureStatus(fastestSig, 15000); // 畀公鏈多啲時間確認
                console.log(`🎉 [Live Trade] 絕命廣播成功！公鏈上鏈 Signature: ${fastestSig}`);
                healthMonitor.setStatus('Live_Engine', `🟢 絕命廣播成功`);
                return { success: true, txid: fastestSig };
            } catch (broadcastErr) {
                console.error(`💥 [Live Execution] 絕命廣播亦全數陣亡:`, broadcastErr.message);
            }
        } else {
            console.error(`❌ [Live Execution] Jito 拍賣失敗，買單放棄 (不追高)。`);
        }

        healthMonitor.setStatus('Live_Engine', '🔴 交易多次丟包失敗'); 
        return { success: false, txid: null };

    } catch (err) {
        console.error(`❌ [Live Execution] 發生未預期錯誤:`, err.message);
        return { success: false, txid: null };
    }
}

module.exports = { executeLiveSwapUAT };