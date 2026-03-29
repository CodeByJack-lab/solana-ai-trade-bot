// src/services/securityGuard.js
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const configEnv = require('../config/env');

// 🚀 [V8.2] 引入 Redis 快取，拯救 RPC 免受 429 之災
const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

// 🛡️ 偽裝 Header
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

// ⏳ 全局 API 節流鎖
let lastDexRequestTime = 0;

const securityGuard = {
    sanitizeAddress(address) {
        if (!address) return null;
        const clean = address.toString().trim().replace(/[\n\r\t\s]/g, '');
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return null;
        return clean;
    },

    isGarbageToken(name, symbol) {
        const target = `${name} ${symbol}`.toLowerCase();
        
        const badPatterns = [
            /\.com/i, /\.io/i, /\.org/i, /\.xyz/i, /t\.me\//i,         
            /test\s*token/i, /testnet/i, /presale/i, /airdrop/i,         
            /claim/i, /free/i, /scam/i, /fake/i, /honeypot/i
        ];
        for (const pattern of badPatterns) {
            if (pattern.test(target)) return { isGarbage: true, match: `垃圾字眼: ${pattern.toString()}` };
        }

        const hasStandardChar = /[a-zA-Z0-9]/.test(symbol);
        if (!hasStandardChar) return { isGarbage: true, match: '無英數純符號代號' };

        const weirdSymbolRegex = /[\u2000-\u3300\uFE00-\uFEFF\uD83C-\uD83E\uDC00-\uDFFF]/;
        if (weirdSymbolRegex.test(symbol) || weirdSymbolRegex.test(name)) {
            return { isGarbage: true, match: '偵測到顏文字/古怪符號' };
        }

        if (symbol.length > 15) return { isGarbage: true, match: '代號長度異常 (>15字)' };

        return { isGarbage: false };
    },

    async getProfileFromDexScreener(mint) {
        try {
            const now = Date.now();
            const timeSinceLast = now - lastDexRequestTime;
            if (timeSinceLast < 1000) {
                const waitTime = 1000 - timeSinceLast;
                console.log(`⏳ [Security Guard] 魚群擁擠，觸發 Dex API 節流等待 ${waitTime}ms...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
            lastDexRequestTime = Date.now();

            const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
            const res = await axios.get(url, { timeout: 5000, headers: BROWSER_HEADERS });

            if (res.data && res.data.pairs) {
                const pairs = res.data.pairs.filter(p => p.chainId === 'solana' && p.baseToken.address === mint);
                if (pairs.length > 0) {
                    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                    const pair = pairs[0];

                    const socials = pair.info?.socials || [];
                    const websites = pair.info?.websites || [];
                    const priceSol = parseFloat(pair.priceNative) || 0;

                    // 🚀 [新增] 嚴格判斷是否有任何社交媒體或網站
                    const hasSocials = socials.length > 0 || websites.length > 0;
                    const socialLabels = [...socials.map(s => s.type), ...(websites.length > 0 ? ['website'] : [])];

                    return {
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        priceSol: priceSol,
                        liquidity: pair.liquidity?.usd || 0,
                        volume5m: pair.volume?.m5 || 0,
                        fdv: pair.fdv || 0,
                        buys5m: pair.txns?.m5?.buys || 0,
                        sells5m: pair.txns?.m5?.sells || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0,
                        h24: parseFloat(pair.priceChange?.h24) || 0,
                        hasSocials: hasSocials, // 🚩 布林值，方便攔截
                        socials: hasSocials ? `有 (${socialLabels.join('/')})` : '無'
                    };
                }
            }
            return null;
        } catch (e) {
            console.warn(`⚠️ [Security Guard] DexScreener 查價失敗 (${mint.substring(0,6)}...):`, e.message);
            return null;
        }
    },

    async checkAll(mintAddress, poolType = 'NURSERY') {
        try {
            healthMonitor.setStatus('Security_Guard', '🟢 運作中');

            const cleanMint = this.sanitizeAddress(mintAddress);
            if (!cleanMint) return { isSafe: false, reason: '🛑 無效的 Base58 地址格式' };

            // 🚀 [V8.2] 第一重快取：帳戶是否存在
            const accountCacheKey = `SEC_ACC:${cleanMint}`;
            let isAccountValid = await redis.get(accountCacheKey);

            if (!isAccountValid) {
                try {
                    const accountInfo = await connection.getAccountInfo(new PublicKey(cleanMint));
                    if (!accountInfo) {
                        return { isSafe: false, isPurgatory: true, reason: '⏳ 鏈上查無帳戶 (等待廣播中)' };
                    }
                    await redis.set(accountCacheKey, 'VALID', 'EX', 86400); 
                } catch (rpcErr) {
                    return { isSafe: false, isPurgatory: true, reason: `⏳ RPC連線異常: ${rpcErr.message}` };
                }
            }

            const targetParamId = poolType === 'TRENDING' ? 3 : 2;
            const { data: params, error: dbErr } = await supabase.from('ai_strategy_params').select('*').eq('id', targetParamId).single();
            if (dbErr) throw new Error(`無法讀取參數 ID ${targetParamId}`);

            const limits = {
                minLiq: params.min_liquidity || 4000,
                minVol: params.min_vol_5m || 500,
                minRatio: parseFloat(params.min_liq_fdv_ratio || 0.01)
            };

            // 活數據：永遠直連 DexScreener 拿取
            let marketData = await this.getProfileFromDexScreener(cleanMint);
            if (!marketData) return { isSafe: false, isPurgatory: true, reason: '⏳ Indexer 尚未索引資料 (等待報價中)' };

            // 🚨 [V8.2 終極過濾] 項目三無攔截 (無 X / Telegram / 網站)
            if (!marketData.hasSocials) {
                return { isSafe: false, reason: '🛑 項目三無 (無 X/Telegram/網站等社交連結，極高危)' };
            }

            const garbageCheck = this.isGarbageToken(marketData.name, marketData.symbol);
            if (garbageCheck.isGarbage) return { isSafe: false, reason: `🛑 垃圾幣特徵攔截 (${garbageCheck.match})` };

            const isBlindSnipe = (marketData.liquidity < 1000 && marketData.volume5m === 0);

            if (!isBlindSnipe) {
                if (marketData.liquidity < limits.minLiq) {
                    if (poolType === 'TRENDING') return { isSafe: false, reason: `📉 流動性未達熱門標準 ($${marketData.liquidity.toFixed(0)} < $${limits.minLiq})` };
                    
                    const purgatoryThreshold = limits.minLiq * 0.8;
                    if (marketData.liquidity >= purgatoryThreshold) {
                        return { isSafe: false, isPurgatory: true, reason: `⏳ 流動性緩刑 ($${marketData.liquidity.toFixed(0)} < $${limits.minLiq})` };
                    }
                    return { isSafe: false, reason: `📉 流動性太窮 ($${marketData.liquidity.toFixed(0)} < $${limits.minLiq})` };
                }

                if (marketData.volume5m < limits.minVol) return { isSafe: false, reason: `📉 5分量死水 ($${marketData.volume5m.toFixed(0)} < $${limits.minVol})` };

                const currentRatio = marketData.fdv > 0 ? (marketData.liquidity / marketData.fdv) : 0;
                if (currentRatio < limits.minRatio) return { isSafe: false, reason: `📉 泡沫極大 (比例 ${(currentRatio * 100).toFixed(2)}%)` };
            }

            // 🚀 [V8.2] 第二重快取：合約權限與 RugPull 檢查
            const rugCacheKey = `SEC_RUG:${cleanMint}`;
            const cachedRugResult = await redis.get(rugCacheKey);
            
            if (cachedRugResult === 'SAFE') {
                console.log(`🛡️ [Security Cache] 命中快取: ${marketData.symbol} 合約權限已驗證為安全`);
            } else {
                const rugResult = await this.checkRugPull(cleanMint);
                if (!rugResult.isSafe) return rugResult; 
                
                await redis.set(rugCacheKey, 'SAFE', 'EX', 86400);
            }

            return {
                isSafe: true,
                isBlindSnipe: isBlindSnipe,
                marketData: marketData,
                reason: '✅ 物理與合約防線全數通過'
            };

        } catch (err) {
            console.error(`❌ [Security] Guard 異常:`, err.message);
            healthMonitor.setStatus('Security_Guard', `🔴 異常: ${err.message}`);
            return { isSafe: false, isPurgatory: true, reason: '🛑 系統探測異常' };
        }
    },

    async checkRugPull(mintAddress) {
        try {
            const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`;
            const response = await axios.get(url, {
                timeout: 5000, 
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });

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

            if (info.mintAuthority !== null && info.mintAuthority !== undefined) return { isSafe: false, reason: "🛑 未放棄 Mint 權限" };
            if (info.freezeAuthority !== null && info.freezeAuthority !== undefined) return { isSafe: false, reason: "🛑 未放棄 Freeze 權限" };

            return { isSafe: true };
        } catch (err) {
            return { isSafe: false, reason: `🛑 原生 RPC 連線異常` };
        }
    }
};

module.exports = { securityGuard };
