// src/services/priceService.js
const { priceOracleService } = require('./priceOracleService');
const { getUSDHKDRate } = require('../utils/currency');

async function getSolPriceInHKD() {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        
        // 🚀 V7.0 升級：直接由中央預言機 (Oracle) 攞價，0 額外 API 消耗！
        const pricesMap = await priceOracleService.getPrices([SOL_MINT]);
        const tokenData = pricesMap[SOL_MINT];
        
        if (tokenData && tokenData.priceUsd) {
            // 🚀 V7.0 升級：使用真實匯率，精準計算資產
            const hkdRate = await getUSDHKDRate(); 
            return parseFloat(tokenData.priceUsd) * hkdRate; 
        }
        
        return 1150; // 保底價
    } catch (err) {
        console.warn(`⚠️ [PriceService] 獲取 SOL 價格失敗，使用保底價:`, err.message);
        return 1150; 
    }
}

module.exports = { getSolPriceInHKD };