// src/services/securityGuard.js
// 📝 檔案功能用途：V10.52 量化安檢中樞 (終極防刷量與社群背離版)
// 🚀 核心升級 1：徹底移除 Math.random() Mock，實裝真實 RPC 交易金額分桶熵值計算 (Shannon Entropy)，秒殺規律刷量機器人。
// 🚀 核心升級 2：加入「社群與價格背離」偵測，高成交量但無綁定 Socials 連結的項目一票否決。
// 🛡️ 終極修復：加入 preFetchedData 綠色通道，完美解決與前線批次查價的 DexScreener 429 API 撞車問題。
// 💰 CVD 淨流防禦：實裝偽 CVD (Cumulative Volume Delta) 估算法，防禦大戶左手交右手之假 OFI 陷阱。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 
const Redis = require('ioredis');

const redisClient = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');

// 🎯 全局 DexScreener 請求鎖，防止併發轟炸
let lastDexRequestTime = 0;
const DEX_COOLDOWN_MS = 1000; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class SecurityGuard {
    
    // 🧬 數學引擎：計算香農熵 (Shannon Entropy) - 衡量交易金額分佈混亂度
    _calculateEntropy(sequence) {
        const len = sequence.length;
        if (len === 0) return 0;
        const counts = {};
        for (const char of sequence) {
            counts[char] = (counts[char] || 0) + 1;
        }
        
        let entropy = 0;
        for (const key in counts) {
            const p = counts[key] / len;
            if (p > 0) entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    // 🚀 核心升級：抓取真實 RPC 交易，按資金規模分桶 (Bucketing) 計算資訊熵
    // 🛡️ V10.53 優化：加入 Redis Cache，同一 mint 30 分鐘內唔重複打 RPC，消除 [Fatal RPC Error] 警告
    async _checkTradeEntropy(mint) {
        // ✅ 先查 Redis Cache，有就直接返回，唔打 RPC
        try {
            const cached = await redisClient.get(`entropy_cache:${mint}`);
            if (cached !== null) return parseFloat(cached);
        } catch (_) {}

        try {
            const mintPubkey = new PublicKey(mint);
            const sigs = await connection.getSignaturesForAddress(mintPubkey, { limit: 15 });
            if (sigs.length < 10) {
                await redisClient.set(`entropy_cache:${mint}`, '1.0', 'EX', 1800);
                return 1.0; // 樣本太少，暫不判定為刷量
            }

            const txSignatures = sigs.map(s => s.signature);
            // 輕量級抓取 Parsed Txs
            const txs = await connection.getParsedTransactions(txSignatures, { maxSupportedTransactionVersion: 0 });

            let sequence = "";
            for (const tx of txs) {
                if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) continue;

                // 粗略估算交易發起人 (Fee Payer) 的資金變動 (以 SOL 為單位)
                const preBal = tx.meta.preBalances[0];
                const postBal = tx.meta.postBalances[0];
                const solSpent = Math.abs(preBal - postBal) / 1e9;

                // 資金分桶 (Bucketing)
                if (solSpent < 0.05) sequence += "0";      // 微塵單 (Dust)
                else if (solSpent < 0.5) sequence += "1";  // 散戶單 (Retail)
                else if (solSpent < 5.0) sequence += "2";  // 大戶單 (Dolphin)
                else sequence += "3";                      // 巨鯨單 (Whale)
            }

            if (sequence.length < 5) {
                await redisClient.set(`entropy_cache:${mint}`, '1.0', 'EX', 1800);
                return 1.0;
            }

            const h = this._calculateEntropy(sequence);
            // ✅ 計算成功後寫入 cache，30 分鐘內唔再打 RPC
            await redisClient.set(`entropy_cache:${mint}`, h.toString(), 'EX', 1800);
            return h;

        } catch (e) {
            console.warn(`⚠️ [Entropy Check] RPC 查核失敗 (${e.message.substring(0, 80)})，降級放行`);
            return 1.0; // 若 RPC 失敗或 Rate Limit，預設放行以免誤殺
        }
    }

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
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0),
                        pairCreatedAt: pair.pairCreatedAt || null  // P0-3: LP age check
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
            if (top10Pct > 0.80) return false; 
            return true;
        } catch (err) { return true; }
    }

    // P0-3: LP 流動性風險評估（零額外 API，使用已取得 marketData）
    _checkLpRisk(marketData) {
        try {
            const liquidity = parseFloat(marketData?.liquidity || 0);
            const pairAgeMs = marketData?.pairCreatedAt
                ? Date.now() - marketData.pairCreatedAt
                : null;
            const pairAgeMins = pairAgeMs ? pairAgeMs / 60000 : 9999;

            if (liquidity < 1000) {
                return { riskLevel: 'CRITICAL', penaltyPts: 0, reason: '流動性極低 (<$1000)，拒絕入場' };
            }
            if (pairAgeMins < 5 && liquidity < 5000) {
                return { riskLevel: 'HIGH', penaltyPts: 8, reason: `超新幣 (${pairAgeMins.toFixed(1)}m) + 低流動性 ($${liquidity.toFixed(0)})` };
            }
            if (liquidity < 5000) {
                return { riskLevel: 'MEDIUM', penaltyPts: 4, reason: `流動性偏低 ($${liquidity.toFixed(0)})` };
            }
            return { riskLevel: 'OK', penaltyPts: 0, reason: '' };
        } catch (err) {
            console.warn(`⚠️ [LP Check] 解析失敗: ${err.message}`);
            return { riskLevel: 'UNKNOWN', penaltyPts: 2, reason: '無法驗證 LP' };
        }
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

        // 🚀 核心升級：社群與價格背離偵測 (Social-Price Divergence)
        if (marketData.volume5m > 100000 && !marketData.hasSocials) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 幽靈殺豬盤: 5m成交過10萬美金，但無任何 TG/X 綁定`, marketData };
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
        
        // 🚀 微觀結構熵值檢查 (香農熵：防刷量終極過濾器)
        const entropy = await this._checkTradeEntropy(mint);
        if (entropy > 0 && entropy < 0.4) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 交易熵值極低 (${entropy.toFixed(2)})，疑似規律刷量盤`, marketData, applied_ml_strategy_id: targetParam?.id || 0 };
        }

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

        // P0-3: LP 流動性風險預篩（從已取得的 marketData 計算，零額外 API）
        const lpRisk = this._checkLpRisk(marketData);
        if (lpRisk.riskLevel === 'CRITICAL') {
            return { numeric_score: 0, isSafe: false, reason: `🔥 [LP Filter] ${lpRisk.reason}`, marketData, applied_ml_strategy_id: targetParam?.id || 0 };
        }

        let score = 0;
        let reasons = [];

        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description, climate);
        if (textAnalysis.isFatal) return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        let coreScore = 10;
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        // P0-3: LP penalty 扣分（CRITICAL 已在上方攔截，這裡只處理 HIGH/MEDIUM）
        if (lpRisk.penaltyPts > 0) {
            coreScore = Math.max(0, coreScore - lpRisk.penaltyPts);
            console.log(`🔥 [LP Filter] ${marketData.symbol} LP ${lpRisk.riskLevel}：扣 ${lpRisk.penaltyPts} 分 (${lpRisk.reason})`);
            reasons.push(`LP風險-${lpRisk.riskLevel}`);
        }

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
            else { reasons.push('⚠️ 籌碼過度集中 (Top10 > 80%)'); }
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