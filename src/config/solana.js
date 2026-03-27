// src/config/solana.js
const { Connection } = require('@solana/web3.js');
const configEnv = require('./env'); // 👈 引入中央彈藥庫

// ==========================================
// 🚀 Tier 1 & 2: 用戶專屬 VIP 節點
// ==========================================
const alchemyUrl = configEnv.rpc.alchemy.url;
const heliusUrl = configEnv.rpc.helius1.url;
const heliusUrl2 = configEnv.rpc.helius2.url; 

// ==========================================
// 🌍 Tier 3: 終極免費公共節點池 (無需 API Key)
// ==========================================
const PUBLIC_RPCS = [
    'https://solana.drpc.org',              // dRPC (極高防 429)
    'https://rpc.ankr.com/solana',          // Ankr Public
    'https://solana-rpc.publicnode.com'     // PublicNode
];

// 🚀 智能分流邏輯 (Load Balancing)
const vipRpcs = [alchemyUrl, heliusUrl, heliusUrl2].filter(Boolean);
const availableRpcs = vipRpcs.length > 0 ? vipRpcs : PUBLIC_RPCS;

const primaryIndex = Math.floor(Math.random() * availableRpcs.length);
const selectedPrimaryUrl = availableRpcs[primaryIndex];

const fallbackOptions = availableRpcs.filter(url => url !== selectedPrimaryUrl);
const selectedFallbackUrl = fallbackOptions.length > 0 ? fallbackOptions[0] : PUBLIC_RPCS[0];

const publicIndex = Math.floor(Math.random() * PUBLIC_RPCS.length);
const selectedPublicUrl = PUBLIC_RPCS[publicIndex];

console.log(`\n🔌 [System] 初始化 Solana 多核連線 (具備極速超時切換與公共池備援)...`);
console.log(`🎯 [RPC 主力] ${selectedPrimaryUrl.replace(/\?api-key=.*/, '?api-key=***')}`);
console.log(`🛡️ [RPC 備援] ${selectedFallbackUrl.replace(/\?api-key=.*/, '?api-key=***')}`);

const connectionConfig = { commitment: 'confirmed', maxRetries: 0 };

const primaryConnection = new Connection(selectedPrimaryUrl, connectionConfig);
const fallbackConnection = new Connection(selectedFallbackUrl, connectionConfig);
const publicConnection = new Connection(selectedPublicUrl, connectionConfig);

const withTimeout = (promise, ms, operationName) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`⏳ [Timeout] 主節點執行 ${operationName} 超過 ${ms}ms 無反應！`)), ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const NO_TIMEOUT_METHODS = ['sendTransaction', 'sendRawTransaction', 'confirmTransaction', 'simulateTransaction'];

const connection = new Proxy(primaryConnection, {
    get(target, propKey) {
        const origMethod = target[propKey];
        
        if (typeof origMethod === 'function') {
            return async function (...args) {
                if (NO_TIMEOUT_METHODS.includes(propKey)) {
                    try {
                        return await origMethod.apply(target, args);
                    } catch (err) {
                        console.warn(`\n⚠️ [${propKey}] 主節點執行失敗: ${err.message}`);
                        console.warn(`🔄 切換至備援水喉補救...`);
                        try {
                            const fallbackMethod = fallbackConnection[propKey];
                            return await fallbackMethod.apply(fallbackConnection, args);
                        } catch (err2) {
                            console.warn(`⚠️ 備援節點亦失效，啟動 Tier 3 終極公共節點 (Public RPC)...`);
                            const publicMethod = publicConnection[propKey];
                            return await publicMethod.apply(publicConnection, args);
                        }
                    }
                }

                try {
                    return await withTimeout(origMethod.apply(target, args), 2000, propKey);
                } catch (err) {
                    console.warn(`\n⚠️ 觸發備援機制！原因: ${err.message}`);
                    console.warn(`🔄 瞬間無縫切換至備援水喉補救...`);
                    
                    try {
                        const fallbackMethod = fallbackConnection[propKey];
                        return await fallbackMethod.apply(fallbackConnection, args);
                    } catch (err2) {
                        console.warn(`⚠️ 雙節點皆觸發 429/超時，瞬間駁入免 Key 公共節點 (dRPC/Ankr)...`);
                        const publicMethod = publicConnection[propKey];
                        return await publicMethod.apply(publicConnection, args);
                    }
                }
            };
        }
        return origMethod;
    }
});

module.exports = { connection, primaryConnection, fallbackConnection };