// src/config/solana.js
// 📝 檔案功能用途：V9.2 Solana 區塊鏈連線引擎。支援 RPC 智能輪替、防併發切換風暴 (Debounce)、429 攔截及 Promise.any 極限併發廣播。
// 🚀 V9.2.4 升級：動態放寬 getTokenLargestAccounts 超時限制，防範安檢中樞 Fail-Open 漏洞。

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');

// 🚀 直接讀取系統變數
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const HELIUS_API_KEY_1 = process.env.HELIUS_API_KEY;
const HELIUS_API_KEY_2 = process.env.HELIUS_API_KEY_2;

// VIP 專屬節點池
const alchemyUrl = process.env.ALCHEMY_RPC_URL || (ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null);
const heliusUrl = process.env.HELIUS_RPC_URL || (HELIUS_API_KEY_1 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_1}` : null);
const heliusUrl2 = process.env.HELIUS_RPC_URL_2 || (HELIUS_API_KEY_2 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_2}` : null);

// 終極免費公共節點池
const PUBLIC_RPCS = [
    'https://solana.drpc.org',              
    'https://rpc.ankr.com/solana',          
    'https://solana-rpc.publicnode.com'     
];

// 🛠️ 確保只使用認可的 VIP 水喉
let vipUrls = [alchemyUrl, heliusUrl, heliusUrl2].filter(url => url && !url.includes('undefined'));
if (vipUrls.length === 0) vipUrls = PUBLIC_RPCS; 

/**
 * ⚡ Fetch 攔截器：自訂 fetch 行為，當遇到 429 狀態碼時立即拋出錯誤，防止儍等。
 */
async function smartFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 429) {
        throw new Error("HTTP_429_TOO_MANY_REQUESTS");
    }
    return response;
}

const connectionConfig = { commitment: 'confirmed', maxRetries: 0, disableRetryOnRateLimit: true, fetch: smartFetch };

const vipConnections = vipUrls.map(url => new Connection(url, connectionConfig));
const publicConnections = PUBLIC_RPCS.map(url => new Connection(url, connectionConfig));

let currentVipIndex = 0; 
let currentPublicIndex = 0;
let lastRotationTime = 0; // 🛡️ V9.2 新增：防併發切換鎖

/**
 * ⏳ 防超時機制：為 Promise 加上強制死亡線，超時即拋出錯誤觸發輪替。
 */
const withTimeout = (promise, ms, operationName) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`⏳ [Timeout] 節點執行 ${operationName} 超過 ${ms}ms 無反應！`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const NO_TIMEOUT_METHODS = ['sendTransaction', 'sendRawTransaction', 'confirmTransaction', 'simulateTransaction'];

/**
 * 🔒 隱藏 API Key：在日誌中遮蔽敏感的 URL 參數，保護金鑰安全。
 */
function maskUrl(url) {
    return url.replace(/\?api-key=[^&]*/, '?api-key=***').replace(/\/v2\/[^/]*/, '/v2/***');
}

console.log(`\n🔌 [System] 初始化 Solana 動態輪替引擎 (掛載 ${vipConnections.length} 條 VIP 水喉)...`);

const dummyTarget = vipConnections[0] || publicConnections[0]; 

/**
 * 🛡️ 智能代理 (Proxy)：動態攔截所有 RPC 請求，若遇到 429 或超時，自動切換至下一個可用節點重試。
 */
const connection = new Proxy(dummyTarget, {
    get(target, propKey) {
        const origMethod = target[propKey];
        if (typeof origMethod === 'function') {
            return async function (...args) {
                const runWithRetry = async (isVip, attempt = 1) => {
                    const pool = isVip ? vipConnections : publicConnections;
                    if (pool.length === 0) throw new Error("空水喉池");
                    const activeIndex = isVip ? currentVipIndex : currentPublicIndex;
                    const activeConn = pool[activeIndex];
                    const methodToRun = activeConn[propKey];

                    try {
                        if (NO_TIMEOUT_METHODS.includes(propKey)) {
                            return await methodToRun.apply(activeConn, args);
                        } else {
                            // 🚀 V9.2.4 動態分配 Timeout：針對重型查詢放寬限制
                            let timeoutMs = 5000;
                            if (propKey === 'getTokenLargestAccounts') {
                                timeoutMs = 6500; // 畀夠 6.5 秒佢查 Top 10 籌碼
                            } else if (propKey.includes('get')) {
                                timeoutMs = 3500; // 其他普通 get 維持 3.5 秒極速 Failover
                            }
                            
                            return await withTimeout(methodToRun.apply(activeConn, args), timeoutMs, propKey);
                        }
                    } catch (err) {
                        const is429 = err.message.includes('429') || err.message.includes('TOO_MANY_REQUESTS') || err.message.includes('Too Many Requests');
                        const isTimeout = err.message.includes('Timeout');

                        if (is429 || isTimeout) {
                            const now = Date.now();
                            // 🛡️ V9.2 核心：防併發切換風暴。2秒內只允許切換一次節點
                            if (now - lastRotationTime > 2000) {
                                if (isVip) {
                                    currentVipIndex = (currentVipIndex + 1) % vipConnections.length;
                                    console.warn(`\n⚠️ 節點限流/超時！全局鎖定切換至 ➡️ VIP 節點 ${currentVipIndex} (${maskUrl(vipUrls[currentVipIndex])})`);
                                } else {
                                    currentPublicIndex = (currentPublicIndex + 1) % publicConnections.length;
                                }
                                lastRotationTime = now;
                            }
                        }

                        // 畀少少時間新節點抖氣 (防抖)
                        await new Promise(r => setTimeout(r, 500));

                        if (attempt < pool.length) {
                            return await runWithRetry(isVip, attempt + 1);
                        } else {
                            throw new Error(`池內所有 ${isVip ? 'VIP' : 'Public'} 節點均已陣亡`);
                        }
                    }
                };

                try {
                    if (vipConnections.length > 0) return await runWithRetry(true, 1);
                    else throw new Error("無 VIP 節點");
                } catch (vipErr) {
                    try { return await runWithRetry(false, 1); } 
                    catch (pubErr) { throw new Error(`[Fatal RPC Error] Network offline.`); }
                }
            };
        }
        return origMethod;
    }
});

/**
 * 🚀 多路並發廣播 (Multicast)：同時向所有可用節點發射已簽名交易，最先成功回傳者勝出，極限防擁堵。
 */
async function broadcastWithPromiseAny(serializedTx) {
    if (vipConnections.length === 0 && publicConnections.length === 0) throw new Error("❌ 無任何可用嘅 RPC 節點！");

    const allEndpoints = [...vipConnections, ...publicConnections];
    console.log(`\n🌐 [Multicast] 啟動多路併發廣播，同時向 ${allEndpoints.length} 個節點發射 Signed Tx！`);

    const broadcastPromises = allEndpoints.map(conn => {
        // skipPreflight 設為 true 節省時間，直接推入 Mempool
        return conn.sendRawTransaction(serializedTx, { skipPreflight: true, maxRetries: 0 });
    });

    try {
        const fastestSignature = await Promise.any(broadcastPromises);
        console.log(`✅ [Multicast] 競速成功！最快上鏈 Signature: ${fastestSignature}`);
        return fastestSignature;
    } catch (aggregateError) {
        console.error(`❌ [Multicast] 所有節點廣播均失敗！`);
        throw new Error("多路併發廣播全數陣亡");
    }
}

module.exports = { 
    connection, 
    primaryConnection: vipConnections[0] || publicConnections[0], 
    fallbackConnection: vipConnections[1] || publicConnections[1] || publicConnections[0], 
    PublicKey, 
    Keypair,
    broadcastWithPromiseAny
};