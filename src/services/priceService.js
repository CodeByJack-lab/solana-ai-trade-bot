// src/services/priceService.js
const axios = require('axios');
const { getUSDHKDRate } = require('../utils/currency');
const configEnv = require('../config/env');

const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🧠 斷路器：紀錄每隻 API 嘅冷卻到期時間 (Timestamp)
const apiCooldowns = {
    coingecko: 0,
    birdeye: 0,
    jupiterV3: 0,
    jupiterV6: 0
};

// 🚀 [新增] 全局記憶體：記住最後一次成功獲取嘅 SOL 價格 (預設 150 USD)
let lastValidPriceUsd = 150;

function isApiAvailable(apiName) {
    return Date.now() > apiCooldowns[apiName];
}

function markApiFailed(apiName) {
    console.warn(`🚨 [Price Fallback] ${apiName} 發生故障，已觸發斷路器，進入 60 秒冷卻期！`);
    apiCooldowns[apiName] = Date.now() + 60000;
}

async function getSolPriceInHKD() {
    let priceUsd = null;

    // 🛡️ 路線 1: CoinGecko
    if (!priceUsd && isApiAvailable('coingecko') && configEnv.external.coingeckoApiKey) {
        try {
            const config = { timeout: 3000, headers: { 'x-cg-demo-api-key': configEnv.external.coingeckoApiKey.replace(/['"]/g, '').trim() } };
            const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`, config);
            if (res.data?.solana?.usd) priceUsd = parseFloat(res.data.solana.usd);
        } catch (err) { markApiFailed('coingecko'); }
    }

    // 🛡️ 路線 2: Birdeye
    if (!priceUsd && isApiAvailable('birdeye') && configEnv.external.birdeyeApiKey) {
        try {
            const config = { timeout: 3000, headers: { 'X-API-KEY': configEnv.external.birdeyeApiKey.replace(/['"]/g, '').trim() } };
            const res = await axios.get(`https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`, config);
            if (res.data?.data?.value) priceUsd = parseFloat(res.data.data.value);
        } catch (err) { markApiFailed('birdeye'); }
    }

    // 🛡️ 路線 3: Jupiter V3 專線
    if (!priceUsd && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
        try {
            const config = { timeout: 3000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
            const res = await axios.get(`https://api.jup.ag/price/v3?ids=${SOL_MINT}`, config);
            if (res.data?.[SOL_MINT]?.usdPrice) priceUsd = parseFloat(res.data[SOL_MINT].usdPrice);
        } catch (err) { markApiFailed('jupiterV3'); }
    }

    // 🛡️ 路線 4: Jupiter V6 免費公海 (終極保底)
    if (!priceUsd && isApiAvailable('jupiterV6')) {
        try {
            const res = await axios.get(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`, { timeout: 3000 });
            if (res.data?.data?.[SOL_MINT]?.price) priceUsd = parseFloat(res.data.data[SOL_MINT].price);
        } catch (err) { markApiFailed('jupiterV6'); }
    }

    // 💰 結算與記憶更新
    try {
        if (priceUsd) {
            lastValidPriceUsd = priceUsd; // 🚀 更新最後生還記憶
            const hkdRate = await getUSDHKDRate(); 
            return priceUsd * hkdRate; 
        }
        
        // 🛑 如果真係 4 條喉都死晒，用記憶體入面最後一口有效價！
        console.error(`💥 [PriceService] 所有情報源均已癱瘓！使用最後成功記憶報價: $${lastValidPriceUsd} USD`);
        const hkdRate = await getUSDHKDRate().catch(() => 7.8); // 防止 HKD API 亦同時癱瘓
        return lastValidPriceUsd * hkdRate; 

    } catch (e) {
        return lastValidPriceUsd * 7.8;
    }
}

module.exports = { getSolPriceInHKD };
