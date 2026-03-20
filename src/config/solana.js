// src/config/solana.js
const { Connection } = require('@solana/web3.js');
const path = require('path');

// 🛡️ 強制覆蓋：讀取 .env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const alchemyUrl = process.env.ALCHEMY_RPC_URL;
const heliusUrl = process.env.HELIUS_RPC_URL;

console.log(`\n🔌 [System] 初始化 Solana 雙核連線 (具備 2 秒極速超時切換)...`);
if (!alchemyUrl || !heliusUrl) {
    console.log(`❌ [警告] 你缺少了 ALCHEMY_RPC_URL 或 HELIUS_RPC_URL！`);
}

const primaryConnection = new Connection(alchemyUrl, 'confirmed');
const fallbackConnection = new Connection(heliusUrl, 'confirmed');

// ⏱️ 超時炸彈函數 (超過設定時間就強行引爆 Reject)
const withTimeout = (promise, ms, actionName) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`⏳ [Timeout] Alchemy 執行 ${actionName} 超過 ${ms}ms 無反應！`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

// 🤖 智能切換代理 (Proxy)
const connection = new Proxy(primaryConnection, {
    get(target, propKey) {
        const origMethod = target[propKey];
        
        if (typeof origMethod === 'function') {
            return async function (...args) {
                try {
                    // 優先使用 Alchemy，但加上 2000 毫秒 (2秒) 嘅死亡倒數
                    // 如果係 getLatestBlockhash 呢啲緊急要求，2秒都嫌多！
                    return await withTimeout(origMethod.apply(target, args), 2000, propKey);
                } catch (err) {
                    console.warn(`\n⚠️ 觸發備援機制！原因: ${err.message}`);
                    console.warn(`🔄 瞬間無縫切換至 Helius 黃金水喉補救...`);
                    
                    // Alchemy 失敗或超時，即刻用 Helius 補飛
                    const fallbackMethod = fallbackConnection[propKey];
                    return await fallbackMethod.apply(fallbackConnection, args);
                }
            };
        }
        return origMethod;
    }
});

module.exports = { connection, primaryConnection, fallbackConnection };