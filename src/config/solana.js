// src/config/solana.js
const { Connection } = require('@solana/web3.js');
const path = require('path');

// 🛡️ 強制覆蓋：讀取 .env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const alchemyUrl = process.env.ALCHEMY_RPC_URL || 'https://api.mainnet-beta.solana.com';
const heliusUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const heliusUrl2 = process.env.HELIUS_RPC_URL_2; // 🚀 新增第二條 Helius RPC

console.log(`\n🔌 [System] 初始化 Solana 多核連線 (具備 2 秒極速超時切換與負載平衡)...`);

// 🚀 智能分流邏輯 (Load Balancing)
// 將所有可用的 RPC 放入陣列
const availableRpcs = [alchemyUrl, heliusUrl];
if (heliusUrl2) availableRpcs.push(heliusUrl2);

// 隨機選一個做主節點 (打亂順序，平均分配壓力)
const primaryIndex = Math.floor(Math.random() * availableRpcs.length);
const selectedPrimaryUrl = availableRpcs[primaryIndex];

// 備援節點選用與主節點唔同嘅一條 (確保真係有 fallback 作用)
const fallbackOptions = availableRpcs.filter(url => url !== selectedPrimaryUrl);
// 如果冇其他選擇，就退回用原本第一條
const selectedFallbackUrl = fallbackOptions.length > 0 
    ? fallbackOptions[Math.floor(Math.random() * fallbackOptions.length)] 
    : availableRpcs[0];

// 隱藏 API Key 印出 Log，保護私隱
console.log(`🎯 [RPC 主力] ${selectedPrimaryUrl.replace(/api-key=[^&]+/, 'api-key=***')}`);
console.log(`🛡️ [RPC 備援] ${selectedFallbackUrl.replace(/api-key=[^&]+/, 'api-key=***')}`);

const primaryConnection = new Connection(selectedPrimaryUrl, 'confirmed');
const fallbackConnection = new Connection(selectedFallbackUrl, 'confirmed');

// ⏱️ 超時炸彈函數 (超過設定時間就強行引爆 Reject)
const withTimeout = (promise, ms, actionName) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`⏳ [Timeout] 主節點執行 ${actionName} 超過 ${ms}ms 無反應！`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

// 🚀 核心修復：這幾個動作絕對不能 2 秒斬斷，必須給予充分時間！
const NO_TIMEOUT_METHODS = [
    'confirmTransaction',       // 確認交易上鏈 (通常需 5-20 秒)
    'sendRawTransaction',       // 發送交易
    'sendTransaction',          // 發送交易
    'simulateTransaction'       // 模擬交易 (有時需 3-5 秒)
];

// 🤖 智能切換代理 (Proxy) - 完全保留你的完美超時邏輯
const connection = new Proxy(primaryConnection, {
    get(target, propKey) {
        const origMethod = target[propKey];
        
        if (typeof origMethod === 'function') {
            return async function (...args) {
                // 🛡️ 如果是白名單內的耗時操作，不使用 withTimeout，但保留失敗切換機制
                if (NO_TIMEOUT_METHODS.includes(propKey)) {
                    try {
                        return await origMethod.apply(target, args);
                    } catch (err) {
                        console.warn(`\n⚠️ [${propKey}] 主節點執行失敗: ${err.message}`);
                        console.warn(`🔄 瞬間無縫切換至備援水喉補救...`);
                        const fallbackMethod = fallbackConnection[propKey];
                        return await fallbackMethod.apply(fallbackConnection, args);
                    }
                }

                // ⚡ 其他普通查詢 (getBalance, getLatestBlockhash 等)，嚴格執行 2 秒死亡倒數！
                try {
                    return await withTimeout(origMethod.apply(target, args), 2000, propKey);
                } catch (err) {
                    console.warn(`\n⚠️ 觸發備援機制！原因: ${err.message}`);
                    console.warn(`🔄 瞬間無縫切換至備援水喉補救...`);
                    
                    const fallbackMethod = fallbackConnection[propKey];
                    return await fallbackMethod.apply(fallbackConnection, args);
                }
            };
        }
        return origMethod;
    }
});

module.exports = { connection, primaryConnection, fallbackConnection };