const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const axios = require('axios');
const path = require('path');

// 🛠️ 修正 bs58 導入
let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

// 🛡️ 載入環境變數
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

/**
 * 🔐 智能初始化錢包
 */
let wallet;
try {
    const rawKey = process.env.SOLANA_PRIVATE_KEY ? process.env.SOLANA_PRIVATE_KEY.trim() : null;
    
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            const Uint8ArrayKey = Uint8Array.from(JSON.parse(rawKey));
            wallet = Keypair.fromSecretKey(Uint8ArrayKey);
        } else {
            const decodedKey = bs58.decode(rawKey);
            wallet = Keypair.fromSecretKey(decodedKey);
        }
        console.log(`🔑 [Live Engine] 錢包已掛載。地址: ${wallet.publicKey.toString()}`);
    } else {
        console.log(`❌ [Live Engine] .env 中找不到 SOLANA_PRIVATE_KEY 變數。`);
    }
} catch (err) {
    console.log(`⚠️ [Live Engine] 私鑰解析失敗: ${err.message}`);
}

/**
 * 從 Jupiter 獲取真實交易指令
 */
async function getJupiterSwapTransaction(quoteResponse) {
    try {
        if (!wallet) return null;

        const baseUrl = (process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag').replace(/\/$/, '');
        const endpoint = baseUrl.includes('api.jup.ag') ? '/swap/v1/swap' : '/v6/swap';
        
        const config = { headers: {} };
        if (process.env.JUPITER_API_KEY) {
            config.headers['x-api-key'] = process.env.JUPITER_API_KEY;
        }

        const response = await axios.post(`${baseUrl}${endpoint}`, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true, 
            dynamicComputeUnitLimit: true, 
            prioritizationFeeLamports: "auto" 
        }, config);

        return response.data.swapTransaction;
    } catch (err) {
        console.error(`❌ [Jupiter Swap] 構建交易失敗:`, err.response?.data?.error || err.message);
        return null;
    }
}

/**
 * 🚀 執行真實交易 (Jito Anti-MEV 引擎 - 由 Dashboard LIVE 模式觸發)
 */
async function executeLiveSwapUAT(quoteResponse, action) {
    if (!wallet) {
        console.log(`❌ [Live Execution] 錢包未就緒，無法執行實盤操作。`);
        return false;
    }

    console.log(`\n⚡ [Live Execution] 正在向 Jupiter 請求構建 ${action} 交易...`);
    const swapTransactionBase64 = await getJupiterSwapTransaction(quoteResponse);
    
    if (!swapTransactionBase64) return false;

    try {
        // 1. 解碼 Base64 交易
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        
        // 2. 用你的真實私鑰簽名
        transaction.sign([wallet]);
        console.log(`✍️ [Live Execution] 交易已成功使用私鑰簽名！`);

        // 3. 🔬 起飛前檢查 (Pre-flight Check)
        // 在正式送出真金白銀前，本地模擬一次，確保交易不會直接 Failed 浪費時間
        console.log(`🔬 [Pre-flight Check] 正在本地模擬交易...`);
        const simulationResult = await connection.simulateTransaction(transaction);

        if (simulationResult.value.err) {
            console.error(`❌ [Pre-flight Failed] 模擬失敗，取消送出 Jito:`, JSON.stringify(simulationResult.value.err));
            return false;
        } 
        
        console.log(`✅ [Pre-flight Success] 模擬通過，準備進入 Jito 隱私通道！`);

        // ==========================================
        // 🛡️ 實戰發射：經 Jito Block Engine 提交 (防夾)
        // ==========================================
        console.log(`🚀 [Jito Engine] 正在將真金白銀交易送出 (Anti-MEV)...`);
        
        const serializedTransaction = transaction.serialize();
        const base64Tx = Buffer.from(serializedTransaction).toString('base64');

        // Jito Tokyo Endpoint (延遲最低)
        const jitoUrl = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
        
        const jitoResponse = await axios.post(jitoUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [base64Tx, { encoding: "base64" }]
        }, { headers: { 'Content-Type': 'application/json' } });

        const txid = jitoResponse.data.result;
        console.log(`✅ [Jito Success] 交易已成功送出！`);
        console.log(`🔗 追蹤連結: https://solscan.io/tx/${txid}`);

        // 等待確認 (Confirm)
        console.log(`⏳ 等待區塊鏈確認...`);
        const latestBlockHash = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid
        });
        
        console.log(`🎉 [Live Trade] ${action} 交易已在鏈上確認！`);
        return true;

    } catch (err) {
        console.error(`❌ [Live Execution] 發送或確認時發生錯誤:`, err.response?.data || err.message);
        return false;
    }
}

module.exports = { executeLiveSwapUAT };