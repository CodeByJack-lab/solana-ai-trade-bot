// src/config/solana.js
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');

// 🚀 核心急救：直接讀取系統變數，避開循環依賴 (Circular Dependency)
const ALCHEMY_API_KEY = process.env.ALCHEMY_AUTH_TOKEN || process.env.ALCHEMY_API_KEY;
const HELIUS_API_KEY_1 = process.env.HELIUS_API_KEY;
const HELIUS_API_KEY_2 = process.env.HELIUS_API_KEY_2;

// ==========================================
// 🚀 Tier 1 & 2: 用戶專屬 VIP 節點
// ==========================================
// 如果你 env 有自訂 URL 就用 URL，否則自動幫你組合
const alchemyUrl = process.env.ALCHEMY_RPC_URL || (ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null);
const heliusUrl = process.env.HELIUS_RPC_URL || (HELIUS_API_KEY_1 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_1}` : null);
const heliusUrl2 = process.env.HELIUS_RPC_URL_2 || (HELIUS_API_KEY_2 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_2}` : null);

// ==========================================
// 🌍 Tier 3: 終極免費公共節點池 (無需 API Key)
// ==========================================
const PUBLIC_RPCS = [
    'https://solana.drpc.org',              // dRPC (極高防 429)
    'https://rpc.ankr.com/solana',          // Ankr Public
    'https://solana-rpc.publicnode.com'     // PublicNode
];

// 🚀 智能分流邏輯 (Load Balancing)
const vipRpcs = [alchemyUrl, heliusUrl, heliusUrl2].filter(url => url && !url.includes('undefined'));
const availableRpcs = vipRpcs.length > 0 ? vipRpcs : PUBLIC_RPCS;

const primaryIndex = Math.floor(Math.random() * availableRpcs.length);
const selectedPrimaryUrl = availableRpcs[primaryIndex];

const fallbackOptions = availableRpcs.filter(url => url !== selectedPrimaryUrl);
const selectedFallbackUrl = fallbackOptions.length > 0 ? fallbackOptions[0] : PUBLIC_RPCS[0];

const publicIndex = Math.floor(Math.random() * PUBLIC_RPCS.length);
const selectedPublicUrl = PUBLIC_RPCS[publicIndex];

console.log(`\n🔌 [System] 初始化 Solana 多核連線 (具備極速超時切換與公共池備援)...`);
console.log(`🎯 [RPC 主力] ${selectedPrimaryUrl.replace(/\?api-key=[^&]*/, '?api-key=***').replace(/\/v2\/[^/]*/, '/v2/***')}`);
console.log(`🛡️ [RPC 備援] ${selectedFallbackUrl.replace(/\?api-key=[^&]*/, '?api-key=***').replace(/\/v2\/[^/]*/, '/v2/***')}`);

// ==========================================
// ⚡ V8.3 終極魔法：封殺 Solana 底層死等機制
// ==========================================
// ⚡ 核心殺招：Fetch 攔截器 (防止 web3.js 儍等 500ms)
async function smartFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 429) {
        // 秒速 Throw Error，直接掟畀下面個 Proxy Catch，強制瞬間換線！
        throw new Error("HTTP_429_TOO_MANY_REQUESTS");
    }
    return response;
}

const connectionConfig = { 
    commitment: 'confirmed', 
    maxRetries: 0, 
    disableRetryOnRateLimit: true, // 關閉官方死等
    fetch: smartFetch // 注入攔截器
};

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
                    return await withTimeout(origMethod.apply(target, args), 5000, propKey);
                } catch (err) {
                    const is429 = err.message.includes('429');
                    if (is429) {
                        console.warn(`\n⚠️ 觸發備援機制！原因: 🚦 [429 限流] 主節點爆 Quota，已攔截底層死等！`);
                    } else {
                        console.warn(`\n⚠️ 觸發備援機制！原因: ${err.message}`);
                    }
                    console.warn(`🔄 瞬間無縫切換至備援水喉補救...`);
                    
                    try {
                        const fallbackMethod = fallbackConnection[propKey];
                        return await fallbackMethod.apply(fallbackConnection, args);
                    } catch (err2) {
                        console.warn(`⚠️ 雙節點皆觸發異常，瞬間駁入免 Key 公共節點 (dRPC/Ankr)...`);
                        const publicMethod = publicConnection[propKey];
                        return await publicMethod.apply(publicConnection, args);
                    }
                }
            };
        }
        return origMethod;
    }
});

module.exports = { connection, primaryConnection, fallbackConnection, PublicKey, Keypair };
