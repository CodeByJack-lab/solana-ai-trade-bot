// src/services/securityGuard.js
// 📝 檔案功能用途：物理與合約安檢中樞。實裝「狀態指針輪替」，雙源獲取微觀 OFI 數據，精確溯源環境變數名稱，安全防洩漏。

const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const configEnv = require('../config/env');
const { sendAdminAlert } = require('./telegramService');

const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

let lastDexRequestTime = 0;

// 🔄 狀態指針系統 (Stateful Pointer Rotation)
const MARKET_DATA_PROVIDERS = ['DEXSCREENER', 'BIRDEYE'];
let activeProviderIdx = 0; 
const providerErrorCounts = { DEXSCREENER: 0, BIRDEYE: 0 };

async function waitForTrendingVIPLock(strategyType) {
    if (strategyType === 'TRENDING') return;
    let isLocked = await redis.get('dex_priority_lock');
    if (isLocked === 'TRENDING') {
        console.log(`🚦 [API 管制] 查價 API 畀 TOP 100 徵用緊，請稍候...`);
        while (await redis.get('dex_priority_lock') === 'TRENDING') {
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

const securityGuard = {
    sanitizeAddress(address) {
        if (!address) return null;
        const clean = address.toString().trim().replace(/[\n\r\t\s]/g, '');
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return null;
        return clean;
    },

    isGarbageToken(name, symbol) {
        const targetName = name.toLowerCase();
        const targetSymbol = symbol.toLowerCase();
        const badPatterns = [ /\.com/i, /\.io/i, /\.org/i, /\.xyz/i, /t\.me\//i, /test\s*token/i, /testnet/i, /presale/i, /airdrop/i, /claim/i, /free/i, /scam/i, /fake/i, /honeypot/i, /SOL/i ];
        for (const pattern of badPatterns) {
            if (pattern.test(targetName) || targetName.includes(pattern.source.replace(/\\/g, ''))) return { isGarbage: true, match: `垃圾字眼/網址` };
        }
        const strictSymbolRegex = /^[a-zA-Z0-9$\-]+$/;
        if (!strictSymbolRegex.test(symbol) && symbol !== 'UNKNOWN') return { isGarbage: true, match: '非標準英文代號 (涉嫌 Scam)' };
        if (symbol.length > 15) return { isGarbage: true, match: '代號長度異常 (>15字)' };
        return { isGarbage: false };
    },

    async _fetchFromDexScreener(mint) {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
        try {
            const res = await axios.get(url, { timeout: 5000, headers: BROWSER_HEADERS });
            if (res.data && res.data.pairs) {
                const pairs = res.data.pairs.filter(p => p.chainId === 'solana' && p.baseToken.address === mint);
                if (pairs.length > 0) {
                    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                    const pair = pairs[0];
                    const socials = pair.info?.socials || [];
                    const websites = pair.info?.websites || [];
                    const hasSocials = socials.length > 0 || websites.length > 0;
                    const cleanDesc = (pair.info?.description || pair.info?.header || '').trim().substring(0, 300); 

                    return {
                        symbol: pair.baseToken?.symbol || 'UNKNOWN', name: pair.baseToken?.name || 'UNKNOWN',
                        priceUsd: parseFloat(pair.priceUsd) || 0, priceSol: parseFloat(pair.priceNative) || 0,
                        liquidity: pair.liquidity?.usd || 0, volume5m: pair.volume?.m5 || 0,
                        buys5m: pair.txns?.m5?.buys || 0, sells5m: pair.txns?.m5?.sells || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0, h24: parseFloat(pair.priceChange?.h24) || 0,
                        fdv: pair.fdv || 0, hasSocials: hasSocials, socials: hasSocials ? '有 (DexScreener 驗證)' : '無',
                        description: cleanDesc.length >= 5 ? cleanDesc : '無'
                    };
                }
            }
            return null;
        } catch (e) {
            const err = new Error(e.message);
            err.usedKeyName = '無 (DexScreener 公開 API)'; // 🎯 安全標識
            throw err;
        }
    },

    async _fetchFromBirdeye(mint) {
        const apiKey = configEnv.external.birdeyeApiKey;

        if (!apiKey) {
            const err = new Error("未配置 Birdeye API Key");
            err.usedKeyName = 'BIRDEYE_API_KEY'; // 🎯 安全標識
            throw err;
        }
        
        try {
            const headers = { 'X-API-KEY': apiKey.replace(/['"]/g, '').trim(), 'accept': 'application/json' };
            const [marketRes, tradeRes] = await Promise.all([
                axios.get(`https://public-api.birdeye.so/defi/v3/token/market-data?address=${mint}`, { headers, timeout: 5000 }),
                axios.get(`https://public-api.birdeye.so/defi/v3/token/trade-data/single?address=${mint}`, { headers, timeout: 5000 })
            ]);

            const mData = marketRes.data?.data;
            const tData = tradeRes.data?.data;

            if (!mData || !tData) return null;

            return {
                symbol: mData.symbol || 'UNKNOWN', name: mData.name || 'UNKNOWN',
                priceUsd: mData.price || 0, priceSol: 0, liquidity: mData.liquidity || 0,
                volume5m: tData[0]?.volume_5m || 0, buys5m: tData[0]?.trade_5m_buys || 0, sells5m: tData[0]?.trade_5m_sells || 0,
                h1: mData.priceChange1h || 0, h24: mData.priceChange24h || 0, fdv: mData.fdv || 0,
                hasSocials: false, socials: '無 (Birdeye 備援模式)', description: '無 (Birdeye 備援模式)'
            };
        } catch (e) {
            const err = new Error(e.message);
            err.usedKeyName = 'BIRDEYE_API_KEY'; // 🎯 安全標識
            throw err;
        }
    },

    async getProfileStateful(mint) {
        const now = Date.now();
        if (now - lastDexRequestTime < 1000) await new Promise(r => setTimeout(r, 1000 - (now - lastDexRequestTime)));
        lastDexRequestTime = Date.now();

        for (let i = 0; i < MARKET_DATA_PROVIDERS.length; i++) {
            const idx = (activeProviderIdx + i) % MARKET_DATA_PROVIDERS.length;
            const providerName = MARKET_DATA_PROVIDERS[idx];

            try {
                let data = null;
                if (providerName === 'DEXSCREENER') data = await this._fetchFromDexScreener(mint);
                else if (providerName === 'BIRDEYE') data = await this._fetchFromBirdeye(mint);

                if (data) {
                    activeProviderIdx = idx; 
                    providerErrorCounts[providerName] = 0; 
                    return data;
                }
            } catch (err) {
                providerErrorCounts[providerName]++;
                const deadKeyName = err.usedKeyName || 'UNKNOWN_VAR';

                console.warn(`⚠️ [API Router] ${providerName} 獲取失敗 (${providerErrorCounts[providerName]}/3): ${err.message} (Var: ${deadKeyName})`);
                
                if (providerErrorCounts[providerName] === 3) {
                    sendAdminAlert(`🚨 <b>查價 API 狀態指針輪替</b>\n\n🤖 <b>供應商:</b> ${providerName}\n🔑 <b>陣亡變數:</b> <code>${deadKeyName}</code>\n❌ <b>錯誤:</b> 連續 3 次擷取失敗！\n\n系統已將微觀查價主力切換至下一個備援。`);
                    providerErrorCounts[providerName] = 0; 
                }
            }
        }
        return null; 
    },

    async getBatchMarketData(mintsArray) {
        const results = {};
        if (!mintsArray || mintsArray.length === 0) return results;
        const CHUNK_SIZE = 30;
        for (let i = 0; i < mintsArray.length; i += CHUNK_SIZE) {
            const chunk = mintsArray.slice(i, i + CHUNK_SIZE);
            const addresses = chunk.join(',');
            try {
                const now = Date.now();
                if (now - lastDexRequestTime < 1000) await new Promise(r => setTimeout(r, 1000 - (now - lastDexRequestTime)));
                lastDexRequestTime = Date.now();
                const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses}`;
                const res = await axios.get(url, { timeout: 8000, headers: BROWSER_HEADERS });
                if (res.data && res.data.pairs) {
                    const pairsByToken = {};
                    for (const pair of res.data.pairs) {
                        if (pair.chainId !== 'solana') continue;
                        const mint = pair.baseToken?.address;
                        if (!mint) continue;
                        if (!pairsByToken[mint]) pairsByToken[mint] = [];
                        pairsByToken[mint].push(pair);
                    }
                    for (const mint of Object.keys(pairsByToken)) {
                        const pairs = pairsByToken[mint];
                        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                        const bestPair = pairs[0];
                        results[mint] = {
                            symbol: bestPair.baseToken?.symbol || 'UNKNOWN', name: bestPair.baseToken?.name || 'UNKNOWN',
                            priceUsd: parseFloat(bestPair.priceUsd) || 0, priceSol: parseFloat(bestPair.priceNative) || 0,
                            liquidity: bestPair.liquidity?.usd || 0, volume5m: bestPair.volume?.m5 || 0, 
                            buys5m: bestPair.txns?.m5?.buys || 0, sells5m: bestPair.txns?.m5?.sells || 0,
                            h1: parseFloat(bestPair.priceChange?.h1) || 0, h24: parseFloat(bestPair.priceChange?.h24) || 0, fdv: bestPair.fdv || 0
                        };
                    }
                }
            } catch (e) { console.warn(`⚠️ [Security Guard] 批量查價失敗:`, e.message); }
        }
        return results;
    },

    async checkAll(mintAddress, poolType = 'TRENDING') {
        try {
            healthMonitor.setStatus('Security_Guard', '🟢 運作中');

            const cleanMint = this.sanitizeAddress(mintAddress);
            if (!cleanMint) return { isSafe: false, reason: '🛑 無效的 Base58 地址格式' };

            await waitForTrendingVIPLock(poolType);

            let marketData = await this.getProfileStateful(cleanMint);
            if (!marketData) return { isSafe: false, isPurgatory: true, reason: '⏳ 查價 API 均無資料 (或全線死機)' };

            const garbageCheck = this.isGarbageToken(marketData.name, marketData.symbol);
            if (garbageCheck.isGarbage) return { isSafe: false, reason: `🛑 ${garbageCheck.match}` };

            const { data: fakeCheck } = await supabase.from('trending_top100').select('mint_address').eq('token_symbol', marketData.symbol).single();
            if (fakeCheck && fakeCheck.mint_address !== cleanMint) {
                return { isSafe: false, reason: `🛑 仿冒幣攔截！與 Top 100 真品 ($${marketData.symbol}) 名稱相同但地址不符。` };
            }

            const totalTxs = marketData.buys5m + marketData.sells5m;
            let ofi = 0; let avgTrade = 0;
            
            if (totalTxs > 0) {
                ofi = (marketData.buys5m - marketData.sells5m) / totalTxs;
                avgTrade = marketData.volume5m / totalTxs;
                if (marketData.buys5m >= 15 && marketData.sells5m === 0) return { isSafe: false, reason: "🛑 貔貅盤特徵 (買單>=15但零賣單)" };
                if (totalTxs > 30 && avgTrade < 15) return { isSafe: false, reason: `🛑 納米刷量機 (均單僅 $${avgTrade.toFixed(2)})` };
            }

            marketData.ofi = ofi; marketData.avgTrade = avgTrade;

            try {
                const jupRes = await axios.get(`https://price.jup.ag/v6/price?ids=${cleanMint}`, { timeout: 3000 });
                const instantPriceUsd = parseFloat(jupRes.data?.data?.[cleanMint]?.price);
                if (instantPriceUsd && marketData.priceUsd > 0) {
                    const spreadDelta = (instantPriceUsd - marketData.priceUsd) / marketData.priceUsd;
                    marketData.spreadDelta = spreadDelta;
                    if (spreadDelta > 0.05) return { isSafe: false, reason: `🛑 Spread 偵測：即時價已飆升 ${(spreadDelta*100).toFixed(1)}%，拒絕追高接盤` };
                }
            } catch (spreadErr) { marketData.spreadDelta = 0; }

            const rugCacheKey = `SEC_RUG:${cleanMint}`;
            const cachedRugResult = await redis.get(rugCacheKey);
            
            if (cachedRugResult === 'SAFE') {
                console.log(`🛡️ [Security Cache] 命中快取: ${marketData.symbol} 合約權限已驗證為安全`);
            } else {
                const rugResult = await this.checkRugPull(cleanMint);
                if (!rugResult.isSafe) return rugResult; 
                await redis.set(rugCacheKey, 'SAFE', 'EX', 86400);
            }

            return { isSafe: true, marketData: marketData, reason: '✅ 物理與合約防線全數通過' };

        } catch (err) {
            console.error(`❌ [Security] Guard 異常:`, err.message);
            healthMonitor.setStatus('Security_Guard', `🔴 異常: ${err.message}`);
            return { isSafe: false, isPurgatory: true, reason: '🛑 系統探測異常' };
        }
    },

    async checkRugPull(mintAddress) {
        try {
            const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`;
            const response = await axios.get(url, { timeout: 5000, headers: { 'Accept': 'application/json' } });
            if (!response.data) throw new Error("RugCheck 無回應");

            const report = response.data;
            const score = report.score || 0;
            if (score > 5000) return { isSafe: false, reason: `🛑 RugCheck 危險分數過高 (${score}分)` };

            const risks = report.risks || [];
            const hasMintRisk = risks.some(r => r.name === "Mint Authority still active" || r.value === "Minting enabled");
            const hasFreezeRisk = risks.some(r => r.name === "Freeze Authority still active");
            const hasLPRisk = risks.some(r => r.name.toLowerCase().includes("liquidity not locked") || r.name.toLowerCase().includes("unlocked"));

            if (hasMintRisk) return { isSafe: false, reason: "🛑 未放棄 Mint 權限" };
            if (hasFreezeRisk) return { isSafe: false, reason: "🛑 未放棄 Freeze 權限" };
            if (hasLPRisk) return { isSafe: false, reason: "🛑 LP 池未鎖定 (高危撤資)" };

            return { isSafe: true };
        } catch (err) {
            return await this.fallbackNativeCheck(mintAddress);
        }
    },

    async fallbackNativeCheck(mintAddress) {
        try {
            const pubKey = new PublicKey(mintAddress);
            const accInfo = await connection.getParsedAccountInfo(pubKey);
            if (!accInfo.value) return { isSafe: false, reason: "🛑 找不到代幣帳戶" };
            const info = accInfo.value.data?.parsed?.info;
            if (!info) return { isSafe: false, reason: "🛑 無法解析代幣結構" };

            if (info.mintAuthority) return { isSafe: false, reason: "🛑 未放棄 Mint 權限 (原生檢查)" };
            if (info.freezeAuthority) return { isSafe: false, reason: "🛑 未放棄 Freeze 權限 (原生檢查)" };
            return { isSafe: true };
        } catch (err) {
            return { isSafe: false, reason: `🛑 原生 RPC 連線異常` };
        }
    }
};

module.exports = { securityGuard };