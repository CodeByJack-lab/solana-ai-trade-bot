const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true });

// ✅ 修正：使用真正的 BONK 官方合約地址
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; 
const RPC_URL = process.env.SOLANA_RPC_URL;
const JUP_KEY = process.env.JUPITER_API_KEY;

async function runTest() {
    console.log(`\n🚀 開始連線測試 (真實代幣): ${MINT}`);
    console.log(`🔗 使用 RPC URL: ${RPC_URL ? RPC_URL.substring(0, 45) + '...' : '未找到'}`);
    
    if (!RPC_URL) {
        console.error("❌ 找不到 SOLANA_RPC_URL，請檢查 .env 檔案！");
        return;
    }

    const conn = new Connection(RPC_URL, 'confirmed');

    // 0. 🌍 網路身份驗證
    try {
        const hash = await conn.getGenesisHash();
        console.log(`\n🌍 [Network] Genesis Hash: ${hash}`);
        if (hash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
            console.log(`✅ [Network] 身份確認：這是正宗 Mainnet (主網)`);
        } else {
            console.log(`❌ [Network] 身份錯誤：這是 Devnet/Testnet (測試網)！`);
        }
    } catch (e) { 
        console.error("❌ [Network] 獲取 Genesis Hash 失敗:", e.message); 
    }

    // 1. 🛡️ RPC 測試
    try {
        const supplyInfo = await conn.getTokenSupply(new PublicKey(MINT));
        console.log(`✅ [RPC] 連線成功! 獲取到小數點 (Decimals): ${supplyInfo.value.decimals}`);
    } catch (e) {
        console.error(`❌ [RPC] 失敗: ${e.message}`);
    }

    // 2. 🛡️ Jupiter 測試 (帶上 API Key)
    try {
        const headers = JUP_KEY ? { 'x-api-key': JUP_KEY } : {};
        const res = await axios.get(`https://api.jup.ag/price/v2?ids=${MINT}`, { headers });
        console.log(`✅ [Jupiter] 報價成功: ${res.data.data[MINT]?.price} USDC`);
    } catch (e) {
        console.error(`❌ [Jupiter] 失敗: Status ${e.response?.status} - ${JSON.stringify(e.response?.data || e.message)}`);
    }

    // 3. 🛡️ DexScreener 測試
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (res.data && res.data.pairs && res.data.pairs.length > 0) {
            console.log(`✅ [DexScreener] 找到 Pairs 數量: ${res.data.pairs.length} (首個流動性池: $${res.data.pairs[0].liquidity?.usd})`);
        } else {
            console.log(`⚠️ [DexScreener] API 找不到該代幣的交易對。`);
        }
    } catch (e) {
        console.error(`❌ [DexScreener] 失敗: ${e.message}`);
    }
    console.log("\n========================================");
}

runTest();