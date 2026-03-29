const axios = require('axios');
const path = require('path');

// 🛡️ 強制從絕對路徑載入 .env，防止讀取失敗
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true });

// 清洗 API Key，防止任何隱藏空格或引號破壞驗證
const rawJupKey = process.env.JUPITER_API_KEY || '';
const JUP_KEY = rawJupKey.replace(/['"]/g, '').trim(); 

const JUP_BASE = (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/$/, '');
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // 官方真實 BONK
const SOL = "So11111111111111111111111111111111111111112";

async function testJupiter() {
    console.log("========================================");
    console.log("🚀 Jupiter API 專屬除錯引擎啟動");
    console.log("========================================");
    
    console.log(`🌐 設定的 Base URL: ${JUP_BASE}`);
    if (JUP_KEY) {
        console.log(`🔑 API Key 狀態: ✅ 已成功載入 (開頭: ${JUP_KEY.substring(0, 4)}...)`);
    } else {
        console.log(`❌ API Key 狀態: 找不到 JUPITER_API_KEY，請檢查 .env 檔案！`);
        return;
    }

    const headers = { 'x-api-key': JUP_KEY };

    // ==========================================
    // 測試 1: 核心 Quote API (機器人真正用來買賣的 API)
    // ==========================================
    try {
        const endpoint = JUP_BASE.includes('api.jup.ag') ? '/swap/v1/quote' : '/v6/quote';
        // 模擬將 0.1 SOL 換成 BONK
        const amountLamports = 100000000; 
        const quoteUrl = `${JUP_BASE}${endpoint}?inputMint=${SOL}&outputMint=${MINT}&amount=${amountLamports}&slippageBps=50`;
        
        console.log(`\n[Test 1] 測試 Quote API (核心交易路由)...`);
        console.log(`🔗 請求網址: ${quoteUrl}`);
        
        const res = await axios.get(quoteUrl, { headers, timeout: 5000 });
        console.log(`✅ [Quote API] 測試成功！API Key 驗證通過！`);
        console.log(`💰 報價結果: 0.1 SOL = ${(res.data.outAmount / 1e5).toFixed(2)} BONK`);
    } catch (e) {
        console.error(`❌ [Quote API] 失敗: Status ${e.response?.status}`);
        console.error(`📄 錯誤詳情: ${JSON.stringify(e.response?.data || e.message)}`);
    }

    // ==========================================
    // 測試 2: Price API (價格參考用)
    // ==========================================
    try {
        const priceUrl = `https://price.jup.ag/v6/price?ids=${MINT}`;
        console.log(`\n[Test 2] 測試 Price API (價格獲取)...`);
        console.log(`🔗 請求網址: ${priceUrl}`);
        
        const res = await axios.get(priceUrl, { headers, timeout: 5000 });
        console.log(`✅ [Price API] 測試成功！`);
        console.log(`💵 現價: ${res.data.data[MINT]?.price} USDC`);
    } catch (e) {
        console.error(`❌ [Price API] 失敗: Status ${e.response?.status}`);
        console.error(`📄 錯誤詳情: ${JSON.stringify(e.response?.data || e.message)}`);
    }
    
    console.log("\n========================================");
}

testJupiter();