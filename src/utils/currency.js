// src/utils/currency.js
const axios = require('axios');
const configEnv = require('../config/env'); // 👈 引入中央彈藥庫

/**
 * 獲取實時 USD 到 HKD 匯率
 */
async function getUSDHKDRate() {
    try {
        const response = await axios.get(configEnv.external.exchangeRateApi);
        const rate = response.data.conversion_rates.HKD;
        //console.log(`💵 實時匯率: 1 USD = ${rate} HKD`);
        return rate;
    } catch (error) {
        console.error("❌ 匯率 API 故障，使用保底 7.82");
        return 7.82;
    }
}

module.exports = { getUSDHKDRate };