// src/utils/currency.js
const axios = require('axios');

// 🧠 斷路器：紀錄每隻 API 嘅冷卻到期時間 (Timestamp)
const apiCooldowns = {
    cdn: 0,
    frankfurter: 0
};

// 🚀 全局記憶體：記住最後一次成功獲取嘅匯率 (預設聯繫匯率中心價 7.8)
let lastValidRate = 7.8;

function isApiAvailable(apiName) {
    return Date.now() > apiCooldowns[apiName];
}

function markApiFailed(apiName) {
    console.warn(`🚨 [Exchange API] ${apiName} 發生故障，已觸發斷路器，進入 60 秒冷卻期！`);
    apiCooldowns[apiName] = Date.now() + 60000; // 鎖 60 秒，防止拖慢系統
}

async function getUSDHKDRate() {
    let rate = null;

    // 🥇 路線 1: 極高 Limit 嘅開源 CDN API (jsDelivr)
    if (!rate && isApiAvailable('cdn')) {
        try {
            // timeout 設短啲 (3秒)，保證極速反應
            const res = await axios.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { timeout: 3000 });
            if (res.data?.usd?.hkd) {
                rate = parseFloat(res.data.usd.hkd);
            }
        } catch (e) {
            markApiFailed('cdn');
        }
    }

    // 🥈 路線 2: 歐洲央行開源 API (Frankfurter)
    if (!rate && isApiAvailable('frankfurter')) {
        try {
            const res = await axios.get('https://api.frankfurter.app/latest?from=USD&to=HKD', { timeout: 3000 });
            if (res.data?.rates?.HKD) {
                rate = parseFloat(res.data.rates.HKD);
            }
        } catch (e) {
            markApiFailed('frankfurter');
        }
    }

    // 💰 結算與記憶更新
    if (rate && !isNaN(rate)) {
        lastValidRate = rate; // 🚀 成功！更新記憶體入面嘅最後生還匯率
        return rate;
    }

    // 🛑 🥉 終極保底：如果全地球嘅匯率 API 都死晒，用記憶體最後一口價！
    console.error(`💥 [Exchange API] 所有匯率情報源癱瘓！使用最後成功記憶匯率: ${lastValidRate}`);
    return lastValidRate; 
}

module.exports = { getUSDHKDRate };
