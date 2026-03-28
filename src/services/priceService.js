// src/services/priceService.js
const axios = require('axios');
const { getUSDHKDRate } = require('../utils/currency');

async function getSolPriceInHKD() {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        
        // 🚀 V8.2 輕量化：直接問 Jupiter V2 攞 SOL 美金價 (每分鐘先 call 一次)
        const res = await axios.get(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`, { timeout: 3000 });
        
        if (res.data?.data?.[SOL_MINT]?.price) {
            const priceUsd = parseFloat(res.data.data[SOL_MINT].price);
            const hkdRate = await getUSDHKDRate(); 
            return priceUsd * hkdRate; 
        }
        
        return 1150; // 保底價
    } catch (err) {
        console.warn(`⚠️ [PriceService] 獲取 SOL 價格失敗，使用保底價:`, err.message);
        return 1150; 
    }
}

module.exports = { getSolPriceInHKD };