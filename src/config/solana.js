// src/config/solana.js
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');

// 🚀 核心急救：直接讀取系統變數，避開循環依賴
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ALCHEMY_API_KEY_2 = process.env.ALCHEMY_API_KEY_2;
const HELIUS_API_KEY_1 = process.env.HELIUS_API_KEY;
const HELIUS_API_KEY_2 = process.env.HELIUS_API_KEY_2;

// ==========================================
// 🚀 VIP 專屬節點池 (自動組合最多 4 條命)
// ==========================================
const alchemyUrl = process.env.ALCHEMY_RPC_URL || (ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null);
const alchemyUrl2 = process.env.ALCHEMY_RPC_URL_2 || (ALCHEMY_API_KEY_2 ? `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY_2}` : null);
const heliusUrl = process.env.HELIUS_RPC_URL || (HELIUS_API_KEY_1 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_1}` : null);
const heliusUrl2 = process.env.HELIUS_RPC_URL_2 || (HELIUS_API_KEY_2 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_2}` : null);

// ==========================================
// 🌍 終極免費公共節點池 (Tier 3)
// ==========================================
const PUBLIC_RPCS = [
    'https://solana.drpc.org',              // dRPC (極高防 429)
    'https://rpc.ankr.com/solana',          // Ankr Public
    'https://solana-rpc.publicnode.com'     // PublicNode
];

// 篩選出所有有效嘅 VIP 水喉
let vipUrls = [alchemyUrl, heliusUrl, alchemyUrl2, heliusUrl2].filter(url => url && !url.includes('undefined'));
if (vipUrls.length === 0) vipUrls = PUBLIC_RPCS; // 如果無 Key，自動降級用公共池

// ⚡ 核心殺招：Fetch 攔截器 (防止 web3.js 儍等)
async function smartFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 429) {
        throw new Error("HTTP_429_TOO_MANY_REQUESTS");
    }
    return response;
}

const connectionConfig = { 
    commitment: 'confirmed', 
    maxRetries: 0, 
    disableRetryOnRateLimit: true, 
    fetch: smartFetch 
};

// 🎯 建立「實體水喉陣列」
const vipConnections = vipUrls.map(url => new Connection(url, connectionConfig));
const publicConnections = PUBLIC_RPCS.map(url => new Connection(url, connectionConfig));

// 🔄 輪替指標 (記住目前邊條喉係主力，起步設為第 0 條)
let currentVipIndex = 0; 
let currentPublicIndex = 0;

const withTimeout = (promise, ms, operationName) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`⏳ [Timeout] 節點執行 ${operationName} 超過 ${ms}ms 無反應！`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const NO_TIMEOUT_METHODS = ['sendTransaction', 'sendRawTransaction', 'confirmTransaction', 'simulateTransaction'];

function maskUrl(url) {
    return url.replace(/\?api-key=[^&]*/, '?api-key=***').replace(/\/v2\/[^/]*/, '/v2/***');
}

console.log(`\n🔌 [System] 初始化 Solana 動態輪替引擎 (掛載 ${vipConnections.length} 條 VIP 水喉)...`);
console.log(`🎯 [起步主力] 節點 ${currentVipIndex}: ${maskUrl(vipUrls[currentVipIndex])}`);

// ==========================================
// 🛡️ 智能代理 (Proxy)：動態將 Request 派去「當前主力」
// ==========================================
const dummyTarget = vipConnections[0] || publicConnections[0]; 

const connection = new Proxy(dummyTarget, {
    get(target, propKey) {
        const origMethod = target[propKey];
        
        if (typeof origMethod === 'function') {
            return async function (...args) {
                
                // 🔄 執行器：包裝咗「失敗即換喉」嘅邏輯
                const runWithRetry = async (isVip, attempt = 1) => {
                    const pool = isVip ? vipConnections : publicConnections;
                    if (pool.length === 0) throw new Error("空水喉池");
                    
                    const activeIndex = isVip ? currentVipIndex : currentPublicIndex;
                    const activeConn = pool[activeIndex];
                    const methodToRun = activeConn[propKey];

                    try {
                        // 防超時機制
                        if (NO_TIMEOUT_METHODS.includes(propKey)) {
                            return await methodToRun.apply(activeConn, args);
                        } else {
                            return await withTimeout(methodToRun.apply(activeConn, args), 5000, propKey);
                        }
                    } catch (err) {
                        const is429 = err.message.includes('429') || err.message.includes('TOO_MANY_REQUESTS') || err.message.includes('Too Many Requests');
                        const isTimeout = err.message.includes('Timeout');

                        // 🚨 觸發換線條件：429 或 Timeout
                        if (is429 || isTimeout) {
                            if (isVip) {
                                // 🚀 將指標推向下一條喉，永久生效！
                                currentVipIndex = (currentVipIndex + 1) % vipConnections.length;
                                const reason = is429 ? '🚦 429 限流' : '⏳ 超時無反應';
                                console.warn(`\n⚠️ ${reason}！VIP 節點 ${activeIndex} 癱瘓。已自動將【主力水喉】切換至 ➡️ 節點 ${currentVipIndex} (${maskUrl(vipUrls[currentVipIndex])})`);
                            } else {
                                currentPublicIndex = (currentPublicIndex + 1) % publicConnections.length;
                                console.warn(`\n⚠️ Public 節點 ${activeIndex} 失效，切換至 ➡️ 節點 ${currentPublicIndex}`);
                            }
                        } else {
                            console.warn(`\n⚠️ [RPC Error] 節點 ${activeIndex} 異常: ${err.message}`);
                        }

                        // 如果呢個 Request 仲未試勻晒池入面所有喉，即刻用新主力重試！
                        if (attempt < pool.length) {
                            return await runWithRetry(isVip, attempt + 1);
                        } else {
                            throw new Error(`池內所有 ${isVip ? 'VIP' : 'Public'} 節點均已陣亡`);
                        }
                    }
                };

                try {
                    // 第一防線：用 VIP 池無限輪替
                    if (vipConnections.length > 0) {
                        return await runWithRetry(true, 1);
                    } else {
                        throw new Error("無 VIP 節點");
                    }
                } catch (vipErr) {
                    console.warn(`🚨 [致命警告] ${vipConnections.length} 條 VIP 水喉全面癱瘓！緊急下降至 Tier 3 公共免 Key 節點群...`);
                    // 第二防線：用 Public 池無限輪替
                    try {
                        return await runWithRetry(false, 1);
                    } catch (pubErr) {
                        console.error(`💀 [末日] 所有 Solana 節點均無法使用！`);
                        throw new Error(`[Fatal RPC Error] Network offline.`);
                    }
                }
            };
        }
        return origMethod;
    }
});

// 向下兼容匯出
module.exports = { 
    connection, 
    primaryConnection: vipConnections[0] || publicConnections[0], 
    fallbackConnection: vipConnections[1] || publicConnections[1] || publicConnections[0], 
    PublicKey, 
    Keypair 
};