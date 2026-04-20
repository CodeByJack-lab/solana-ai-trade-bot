// src/services/securityGuard.js
// 📝 檔案功能用途：V10.40 量化安檢中樞 (全自動 ML 參數接管版 - 三權分立之第一權)
// 🚀 升級功能：加入 ML 動態參數接收器，實現真正 AI 驅動。分數重構為 0-20 物理安全及格線，為 ML 騰出 60 分龐大計分空間。
// 🛡️ 終極修復：加入 preFetchedData 綠色通道，完美解決與前線批次查價的 DexScreener 429 API 撞車問題。
// 💰 CVD 淨流防禦：實裝偽 CVD (Cumulative Volume Delta) 估算法，防禦大戶左手交右手之假 OFI 陷阱。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 
const Redis = require('ioredis');

const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

// 🎯 全局 DexScreener 請求鎖，防止併發轟炸
let lastDexRequestTime = 0;
const DEX_COOLDOWN_MS = 1000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class SecurityGuard {
    
    async _getMacroClimate() {
        try {
            const envStr = await redisClient.get('global_env_state');
            if (envStr) {
                const env = JSON.parse(envStr);
                return { climate: env.climate || 'CHOPPY', newsScore: env.newsScore || 0 };
            }
        } catch(e) {}
        return { climate: 'CHOPPY', newsScore: 0 };
    }

    analyzeTextFeatures(symbol, name, description, climate) {
        const fullText = `${symbol} ${name} ${description}`.toLowerCase();
        let result = { isFatal: false, safetyPenalty: 0, fomoPenalty: 0, requireAuthCheck: false, requireLpCheck: false, reasons: [] };

        const airdropPatterns = [/free mint/i, /free claim/i, /airdrop/i, /claim now/i, /connect wallet/i];
        for (const p of airdropPatterns) {
            if (p.test(fullText)) { result.isFatal = true; result.reasons.push(`空投釣魚騙局 (${p.source})`); return result; }
        }

        if (/lp locked/i.test(fullText) || /burned lp/i.test(fullText)) {
            result.requireLpCheck = true; result.reasons.push('聲稱鎖定 LP (需鏈上核實)');
        }

        const allocationPatterns = [/presale/i, /private sale/i, /team token/i, /marketing wallet/i, /seed/i];
        for (const p of allocationPatterns) {
            const penalty = climate === 'BEAR_PANIC' ? 10 : 5;
            if (p.test(fullText)) { result.safetyPenalty += penalty; result.reasons.push(`高危分配/私募字眼 (${p.source})`); break; }
        }

        const authorityPatterns = [/mint authority/i, /freeze authority/i, /update authority/i, /we keep control/i];
        for (const p of authorityPatterns) {
            if (p.test(fullText)) { result.requireAuthCheck = true; result.reasons.push(`觸及權限敏感字 (${p.source}, 需鏈上深查)`); }
        }

        return result;
    }

    async _fetchMarketData(mint) {
        let retries = 0;
        const maxRetries = 3;
        while (retries < maxRetries) {
            try {
                const now = Date.now();
                if (now - lastDexRequestTime < DEX_COOLDOWN_MS) {
                    await delay(DEX_COOLDOWN_MS - (now - lastDexRequestTime));
                }
                lastDexRequestTime = Date.now(); 

                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
                
                if (res.data && res.data.pairs && res.data.pairs.length > 0) {
                    const pair = res.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                    return {
                        symbol: pair.baseToken?.symbol || 'UNKNOWN', name: pair.baseToken?.name || 'UNKNOWN',
                        description: pair.info?.description || '', liquidity: pair.liquidity?.usd || 0, fdv: pair.fdv || 0,
                        volume5m: pair.volume?.m5 || 0, buys5m: pair.txns?.m5?.buys || 0, sells5m: pair.txns?.m5?.sells || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0, priceUsd: parseFloat(pair.priceUsd) || 0,
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                    };
                }
                return null; 
            } catch (err) {
                if (err.response?.status === 429) {
                    retries++; 
                    console.warn(`⚠️ [SecurityGuard] DexScreener 觸發 429 限流，等待重試 (${retries}/${maxRetries})...`);
                    await delay(2000 + (retries * 1000)); 
                } else {
                    return null; 
                }
            }
        }
        return null; 
    }

    async _checkContractSafety(mint, requireAuthCheck) {
        try {
            const mintPubkey = new PublicKey(mint);
            const accInfo = await connection.getParsedAccountInfo(mintPubkey);
            const info = accInfo.value?.data?.parsed?.info;
            if (!info) return { isSafe: false, isMutable: false };
            
            const extensions = info.extensions || [];
            if (extensions.some(ext => ext.extension === 'transferFeeConfig')) return { isSafe: false, isMutable: false };
            if (info.mintAuthority || (requireAuthCheck && info.freezeAuthority)) return { isSafe: false, isMutable: false };

            let isMutable = false;
            try {
                const metaplexProgramId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
                const [metadataPDA] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), metaplexProgramId.toBuffer(), mintPubkey.toBuffer()], metaplexProgramId);
                const metadataAcc = await connection.getAccountInfo(metadataPDA);
                
                if (metadataAcc && metadataAcc.data && metadataAcc.data.length > 0) {
                    isMutable = true; 
                }
            } catch (metaErr) {}

            return { isSafe: true, isMutable: isMutable };
        } catch (err) { 
            return { isSafe: false, isMutable: false }; 
        }
    }

    async _checkTop10Holders(mint) {
        try {
            const mintPubkey = new PublicKey(mint);
            const supplyRes = await connection.getTokenSupply(mintPubkey);
            const totalSupply = supplyRes.value?.uiAmount;
            if (!totalSupply || totalSupply === 0) return true; 

            const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
            if (!largestAccounts.value || largestAccounts.value.length === 0) return true;

            let top10Sum = 0;
            for (const account of largestAccounts.value.slice(1, 11)) top10Sum += account.uiAmount || 0;
            
            const top10Pct = top10Sum / totalSupply;
            if (top10Pct > 0.50) return false; 
            return true;
        } catch (err) { return true; }
    }

    async calculateQuantScore(mint, type = 'NEWBORN', preFetchedData = null) {
        const { climate, newsScore } = await this._getMacroClimate();
        const dbParams = cacheManager.getStrategy(type);
        
        let mlParams = null;
        let targetParam = null;
        try {
            const mlParamsStr = await redisClient.get('ml_strategy_params');
            if (mlParamsStr) {
                mlParams = JSON.parse(mlParamsStr);
                const paramsArray = Array.isArray(mlParams) ? mlParams : (mlParams.data || []);
                targetParam = paramsArray.find(x => x.token_type === type && x.market_climate === climate);
            }
        } catch (e) {
            console.warn("⚠️ 無法讀取 ML 動態參數，降級使用經驗預設值");
        }

        // 🚀 新增讀取 min_cvd_usd，預設為 0
        let activeParams = {
            buyThreshold: targetParam?.buy_threshold ? Number(targetParam.buy_threshold) : (mlParams?.buy_threshold ?? 70), 
            minOFI: parseFloat(targetParam?.min_ofi ?? targetParam?.minOfi ?? (type === 'TRENDING' ? -0.4 : -0.2)),
            minTxs: parseInt(targetParam?.min_txs_5m ?? targetParam?.minTxs5m ?? (type === 'TRENDING' ? 8 : 5)),
            minTradeSize: parseFloat(targetParam?.min_avg_trade_usd ?? targetParam?.minAvgTradeUsd ?? 10),
            maxTurnover: parseFloat(targetParam?.max_turnover_5m ?? targetParam?.maxTurnover5m ?? (type === 'TRENDING' ? 0.50 : 0.80)),
            zombieVolReq: parseFloat(targetParam?.zombie_vol_req ?? targetParam?.zombieVolReq ?? 500),
            minLiquidityUsd: Math.max(2000, parseFloat(targetParam?.optimal_min_liquidity_usd ?? targetParam?.optimalMinLiquidityUsd ?? (dbParams?.min_liquidity || 2000))),
            minCvdUsd: parseFloat(targetParam?.min_cvd_usd ?? 0) 
        };

        let marketData = null;
        if (preFetchedData && preFetchedData.symbol && preFetchedData.p !== undefined) {
            marketData = {
                symbol: preFetchedData.symbol,
                name: preFetchedData.name || 'UNKNOWN',
                description: preFetchedData.description || '',
                liquidity: preFetchedData.l || 0,
                fdv: preFetchedData.fdv || 0,
                volume5m: preFetchedData.v || 0,
                buys5m: preFetchedData.b || 0,
                sells5m: preFetchedData.s || 0,
                h1: preFetchedData.h1 || 0,
                priceUsd: preFetchedData.p || 0,
                hasSocials: preFetchedData.hasSocials || false
            };
        } else {
            marketData = await this._fetchMarketData(mint);
        }
        
        if (!marketData) {
            console.log(`🛑 [Quant Reject] ${mint} 無法獲取 DexScreener 報價數據 (API 限制)`);
            return { numeric_score: 0, isSafe: false, reason: '無法獲取 DexScreener 報價數據', marketData: null, applied_ml_strategy_id: targetParam?.id || 0 };
        }

        const upperSymbol = marketData.symbol.toUpperCase();
        if (upperSymbol.startsWith('USD')) return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截`, marketData };

        if (marketData.liquidity < activeParams.minLiquidityUsd) return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: $${marketData.liquidity.toFixed(0)} < $${activeParams.minLiquidityUsd}`, marketData };

        if (type === 'NEWBORN') {
            const deadPoolVolReq = parseFloat(targetParam?.dead_pool_vol_req ?? targetParam?.deadPoolVolReq ?? (dbParams?.min_vol_5m * 5 || 5000)); 
            if (marketData.liquidity > 100000 && marketData.volume5m < deadPoolVolReq) {
                return { numeric_score: 0, isSafe: false, reason: `🛑 假池/貔貅攔截 (NEWBORN): 高流動但低交易`, marketData };
            }
        } else if (type === 'TRENDING') {
            if (marketData.liquidity > 1000000 && marketData.volume5m < activeParams.zombieVolReq) {
                return { numeric_score: 0, isSafe: false, reason: `🛑 殭屍幣攔截 (TRENDING): 極高流動但近乎零交易 ($${marketData.volume5m.toFixed(0)})`, marketData };
            }
        }

        const buys = marketData.buys5m;
        const sells = marketData.sells5m;
        const totalTxs5m = buys + sells;

        if (totalTxs5m < activeParams.minTxs) return { numeric_score: 0, isSafe: false, reason: `🛑 交易量缺失: 5m僅 ${totalTxs5m} 筆 (ML要求: ${activeParams.minTxs})`, marketData };
        if (totalTxs5m >= 10 && sells === 0) return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 活躍交易但 0 賣單`, marketData };

        const avgTradeSize = totalTxs5m > 0 ? (marketData.volume5m / totalTxs5m) : 0;
        if (totalTxs5m >= 15 && avgTradeSize < activeParams.minTradeSize) return { numeric_score: 0, isSafe: false, reason: `🛑 納米刷量: 單筆均價極低 ($${avgTradeSize.toFixed(2)} < $${activeParams.minTradeSize})`, marketData };

        const turnover5m = marketData.liquidity > 0 ? (marketData.volume5m / marketData.liquidity) : 0;
        if (turnover5m > activeParams.maxTurnover) return { numeric_score: 0, isSafe: false, reason: `🛑 極端換手率: 達 ${(turnover5m*100).toFixed(0)}% (ML上限 ${(activeParams.maxTurnover*100).toFixed(0)}%)`, marketData };
        if (turnover5m > 1.5 && marketData.h1 < 50) return { numeric_score: 0, isSafe: false, reason: `🛑 量價背離: 高換手率但不漲`, marketData };

        const buyRatio = buys / totalTxs5m;
        if (totalTxs5m > 30 && buyRatio > 0.45 && buyRatio < 0.55) return { numeric_score: 0, isSafe: false, reason: `🛑 女巫刷量: 買賣極度對稱`, marketData };

        // 🚀 核心升級：OFI 與 CVD 雙重淨流防禦
        const pseudoOfi = totalTxs5m > 0 ? (buys - sells) / totalTxs5m : 0;
        const pseudoCvdUsd = marketData.volume5m * pseudoOfi; 

        if (totalTxs5m >= 10 && pseudoOfi < activeParams.minOFI) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 惡劣 OFI: 買賣失衡 (OFI: ${pseudoOfi.toFixed(2)} < ML底線: ${activeParams.minOFI})`, marketData };
        }
        if (totalTxs5m >= 10 && pseudoCvdUsd < activeParams.minCvdUsd) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 資金淨流出/不足: 估算 CVD $${pseudoCvdUsd.toFixed(0)} < ML要求 $${activeParams.minCvdUsd}`, marketData };
        }

        const VERIFIED_TOKENS = cacheManager.getVerifiedTokens();
        if (VERIFIED_TOKENS[upperSymbol] && mint !== VERIFIED_TOKENS[upperSymbol]) return { numeric_score: 0, isSafe: false, reason: `🛑 終極防偽攔截: 假冒幣`, marketData };

        let score = 0;
        let reasons = [];

        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description, climate);
        if (textAnalysis.isFatal) return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        let coreScore = 10; 
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        const safetyCheck = await this._checkContractSafety(mint, textAnalysis.requireAuthCheck);
        if (safetyCheck.isSafe) {
            coreScore += 5; 
            if (safetyCheck.isMutable) { coreScore -= 5; reasons.push('Metadata 未鎖定'); }
        } else {
            return { numeric_score: 0, isSafe: false, reason: `🛑 合約高危或鏈上查詢失敗`, marketData };
        }

        const isHoldersSafe = await this._checkTop10Holders(mint);
        if (isHoldersSafe) {
            coreScore += 5; 
        } else { 
            if (climate === 'BEAR_PANIC') { coreScore -= 10; reasons.push('籌碼集中 (熊市嚴懲)'); }
            else { reasons.push('⚠️ 籌碼過度集中 (Top10 > 50%)'); }
        }

        coreScore = Math.max(0, coreScore);

        const isSafe = coreScore >= 10; 
        const finalReason = isSafe 
            ? `量化及格: ${coreScore}/20 [物理防禦] 氣候: ${climate} | 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${coreScore}/20 (未達物理安全底線), 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: coreScore, isSafe, reason: finalReason, marketData, applied_ml_strategy_id: targetParam?.id || 0 };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };