// src/services/priceService.js
// 📝 檔案功能及用途：跨鏈資產報價中心。實裝「狀態指針輪替」與「三振出局溯源」，三路水喉 (CoinGecko/JupV3/JupV6) 動態切換，附帶 RAM 記憶體終極保底。
// 🚀 V9.2.4 升級：徹底拔除不穩定之 Birdeye API。

const axios = require('axios');
const { getUSDHKDRate } = require('../utils/currency');
const configEnv = require('../config/config');
const { sendAdminAlert } = require('./telegramService');

const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🔄 狀態指針系統 (Stateful Pointer) - 已移除 BIRDEYE
const PROVIDERS = [
    { name: 'COINGECKO', keyName: 'COINGECKO_API_KEY' },
    { name: 'JUPITER_V6', keyName: null }, // 免費又快，提早上位
    { name: 'JUPITER_V3', keyName: 'JUPITER_API_KEY' }
];

let activeProviderIdx = 0;
const providerErrorCounts = { COINGECKO: 0, JUPITER_V3: 0, JUPITER_V6: 0 };

// 🚀 全局記憶體：記住最後一次成功獲取嘅 SOL 價格 (預設 150 USD)
let lastValidPriceUsd = 150;

/**
 * 📡 獨立查價呼叫器
 */
async function fetchPrice(provider) {
    const keyName = provider.keyName;
    const apiKey = keyName ? process.env[keyName] : null;

    if (keyName && !apiKey) {
        const err = new Error(`未配置 API 金鑰變數`);
        err.usedKeyName = keyName;
        throw err;
    }

    try {
        if (provider.name === 'COINGECKO') {
            const config = { timeout: 3000, headers: { 'x-cg-demo-api-key': apiKey.replace(/['"]/g, '').trim() } };
            const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`, config);
            if (res.data?.solana?.usd) return parseFloat(res.data.solana.usd);
            throw new Error("回傳格式無效");
        }
        if (provider.name === 'JUPITER_V6') {
            const res = await axios.get(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`, { timeout: 3000 });
            if (res.data?.data?.[SOL_MINT]?.price) return parseFloat(res.data.data[SOL_MINT].price);
            throw new Error("回傳格式無效");
        }
        if (provider.name === 'JUPITER_V3') {
            const config = { timeout: 3000, headers: { 'x-api-key': apiKey.replace(/['"]/g, '').trim() } };
            const res = await axios.get(`https://api.jup.ag/price/v3?ids=${SOL_MINT}`, config);
            if (res.data?.[SOL_MINT]?.usdPrice) return parseFloat(res.data[SOL_MINT].usdPrice);
            throw new Error("回傳格式無效");
        }
    } catch (e) {
        const err = new Error(e.message);
        err.usedKeyName = keyName || '無 (公開 API)';
        throw err;
    }
}

/**
 * 💰 獲取 SOL 實時港幣價格 (狀態指針輪替)
 */
async function getSolPriceInHKD() {
    for (let i = 0; i < PROVIDERS.length; i++) {
        const idx = (activeProviderIdx + i) % PROVIDERS.length;
        const provider = PROVIDERS[idx];

        try {
            const priceUsd = await fetchPrice(provider);
            if (priceUsd) {
                activeProviderIdx = idx; // 🎯 鎖定為新主力
                providerErrorCounts[provider.name] = 0;
                lastValidPriceUsd = priceUsd; // 🚀 更新記憶
                
                const hkdRate = await getUSDHKDRate().catch(() => 7.8); 
                return priceUsd * hkdRate; 
            }
        } catch (err) {
            providerErrorCounts[provider.name]++;
            const deadKeyName = err.usedKeyName || 'UNKNOWN_VAR';
            
            console.warn(`⚠️ [PriceService] ${provider.name} 查價失敗 (${providerErrorCounts[provider.name]}/3): ${err.message} (Var: ${deadKeyName})`);

            if (providerErrorCounts[provider.name] === 3) {
                sendAdminAlert(`🚨 <b>查價 API 狀態指針輪替</b>\n\n🤖 <b>供應商:</b> ${provider.name}\n🔑 <b>陣亡變數:</b> <code>${deadKeyName}</code>\n❌ <b>錯誤:</b> 連續 3 次擷取失敗！\n\n系統已將查價主力切換至下一個備援。`);
                providerErrorCounts[provider.name] = 0;
            }
        }
    }

    // 🛑 四條喉全滅：啟用 RAM 保底
    console.error(`💥 [PriceService] 所有情報源均已癱瘓！使用最後成功記憶報價: $${lastValidPriceUsd} USD`);
    const hkdRate = await getUSDHKDRate().catch(() => 7.8);
    return lastValidPriceUsd * hkdRate; 
}

module.exports = { getSolPriceInHKD };