// src/services/priceService.js
const axios = require('axios');
const { getUSDHKDRate } = require('../utils/currency');
const configEnv = require('../config/env'); // 👈 引入 config，攞 API Key

async function getSolPriceInHKD() {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const config = { timeout: 3000, headers: {} };

        // 🧠 智能分流：有 Key 行 V2 專線，無 Key 行 V6 免費公海
        const baseUrl = configEnv.external.jupiterApiKey ? 'https://api.jup.ag/price/v2' : 'https://price.jup.ag/v6/price';

        // 🛠️ 如果有 API Key，自動加入 Header 防 401
        if (configEnv.external.jupiterApiKey) {
            config.headers['x-api-key'] = configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim();
        }

        const res = await axios.get(`${baseUrl}?ids=${SOL_MINT}`, config);
        
        // 兼容 V2 同 V6 嘅 JSON 結構
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