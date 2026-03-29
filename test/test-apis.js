// test-apis.js
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
require('dotenv').config();

// 🚀 自動優先選用 Alchemy 或 Helius 的 URL
const RPC_URL = process.env.ALCHEMY_RPC_URL || process.env.HELIUS_RPC_URL;
const MINT_ADDRESS = "貼入你要測試的代幣地址"; 

async function debugToken() {
    console.log(`\n🔍 正在驗證環境變數...`);
    
    if (!RPC_URL || !RPC_URL.startsWith('http')) {
        console.error(`❌ [Error] RPC_URL 無效！請檢查 .env 是否有 ALCHEMY_RPC_URL 或 HELIUS_RPC_URL`);
        console.error(`當前讀取值: "${RPC_URL}"`);
        process.exit(1);
    }

    console.log(`✅ [Env] RPC 終端已鎖定: ${RPC_URL.substring(0, 30)}...`);
    const connection = new Connection(RPC_URL, 'confirmed');

    try {
        console.log(`🚀 正在深度診斷代幣: ${MINT_ADDRESS}`);

        // 1. 測試直接 RPC (最高優先級)
        const info = await connection.getAccountInfo(new PublicKey(MINT_ADDRESS));
        console.log(`✅ [1. Direct RPC] 狀態: ${info ? '存在於鏈上' : '不存在 (404)'}`);

        // 2. 測試 Jupiter v6 報價 (路徑建立情況)
        try {
            const res = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${MINT_ADDRESS}&amount=100000000&slippageBps=50`);
            console.log(`✅ [2. Jupiter v6] 狀態: ${res.data.outAmount ? '有交易路由' : '無路由'}`);
        } catch (e) {
            console.error(`❌ [Jupiter] 失敗: ${e.response?.status || e.message}`);
        }

        // 3. 測試 Dexscreener
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${MINT_ADDRESS}`);
            console.log(`✅ [3. Dexscreener] 狀態: ${res.data.pairs?.length > 0 ? '有流動性池' : '未收錄'}`);
        } catch (e) {
            console.error(`❌ [Dexscreener] 失敗: ${e.message}`);
        }

    } catch (err) {
        console.error(`💀 診斷過程中發生致命錯誤: ${err.message}`);
    }
}

debugToken();