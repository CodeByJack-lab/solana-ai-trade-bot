// src/services/securityGuard.js
// 📝 檔案功能用途：V10.16 量化安檢中樞 (動態 OFI + 防 429 限流版)
// 🚀 升級功能：加入動態 OFI 容忍度 (防殺錯良民)，並保留 DexScreener 全局防爆閥。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 
const Redis = require('ioredis');

const redisClient = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

// 🎯 新增：全局 DexScreener 請求鎖，防止併發轟炸
let lastDexRequestTime = 0;
const DEX_COOLDOWN_MS = 500; // 每個請求之間最少隔 0.5 秒

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
            const penalty = climate === 'BEAR_PANIC' ? 30 : 15;
            if (p.test(fullText)) { result.safetyPenalty += penalty; result.reasons.push(`高危分配/私募字眼 (${p.source})`); break; }
        }

        const authorityPatterns = [/mint authority/i, /freeze authority/i, /update authority/i, /we keep control/i];
        for (const p of authorityPatterns) {
            if (p.test(fullText)) { result.requireAuthCheck = true; result.reasons.push(`觸及權限敏感字 (${p.source}, 需鏈上深查)`); }
        }

        const fomoPatterns = [/100x/i, /1000x/i, /to the moon/i, /guaranteed profit/i, /🚀/];
        let hasFomo = false;
        for (const p of fomoPatterns) { if (p.test(fullText)) hasFomo = true; }
        const emojiMatches = fullText.match(/[\u{1F680}\u{1F525}\u{1F4A5}\u{1F4B0}]/gu);
        if (hasFomo || (emojiMatches && emojiMatches.length >= 5)) {
            const penalty = climate === 'RAGING_BULL' ? 0 : (climate === 'BEAR_PANIC' ? 20 : 10);
            result.fomoPenalty += penalty; 
            if (penalty > 0) result.reasons.push('重度 FOMO 情緒誘騙');
        }

        return result;
    }

    async _fetchMarketData(mint) {
        let retries = 0;
        const maxRetries = 3;
        while (retries < maxRetries) {
            try {
                // 🎯 核心修復：強制排隊機制，確保請求不會堆疊撞埋一齊
                const now = Date.now();
                if (now - lastDexRequestTime < DEX_COOLDOWN_MS) {
                    await delay(DEX_COOLDOWN_MS - (now - lastDexRequestTime));
                }
                lastDexRequestTime = Date.now(); // 更新最後請求時間

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
                    console.warn(`⚠️ [SecurityGuard] DexScreener 觸發 429 限流，等待 2 秒後重試 (${retries}/${maxRetries})...`);
                    await delay(2000 + (retries * 1000)); // 動態加長退避時間
                } else {
                    console.error(`❌ [SecurityGuard] DexScreener 請求錯誤: ${err.message}`);
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
            } catch (metaErr) {
                console.warn(`⚠️ [SecurityGuard] 無法解析 ${mint} 的 Metadata:`, metaErr.message);
            }

            return { isSafe: true, isMutable: isMutable };
        } catch (err) { 
            console.error(`❌ [SecurityGuard] 合約檢查失敗:`, err.message);
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

    async calculateQuantScore(mint, type = 'NEWBORN') {
        const { climate, newsScore } = await this._getMacroClimate();
        const dbParams = cacheManager.getStrategy(type);
        
        let activeParams = {
            buyThreshold: dbParams.buy_score_threshold || 70,
            minTxs: type === 'TRENDING' ? 15 : 5,
            minTradeSize: 10,
            maxTurnover: 0.80
        };

        if (climate === 'RAGING_BULL' || newsScore >= 4) {
            activeParams.buyThreshold = Math.max(50, activeParams.buyThreshold - 10);
            activeParams.minTxs = type === 'TRENDING' ? 8 : 2;
            activeParams.minTradeSize = 5;
            activeParams.maxTurnover = 2.00; 
        } else if (climate === 'BEAR_PANIC' || newsScore <= -3) {
            activeParams.buyThreshold = Math.min(95, activeParams.buyThreshold + 15);
            activeParams.minTxs = type === 'TRENDING' ? 30 : 15;
            activeParams.minTradeSize = 50;
            activeParams.maxTurnover = 0.40; 
        }

        const marketData = await this._fetchMarketData(mint);
        
        // 🎯 強化錯誤記錄，等你知道係因為 429 而被 reject
        if (!marketData) {
            console.log(`🛑 [Quant Reject] ${mint} 無法獲取 DexScreener 報價數據 (可能觸發了 429 限制)`);
            return { numeric_score: 0, isSafe: false, reason: '無法獲取 DexScreener 報價數據 (API 限制)', marketData: null };
        }

        const upperSymbol = marketData.symbol.toUpperCase();
        if (upperSymbol.startsWith('USD')) return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截`, marketData };

        if (marketData.liquidity < dbParams.min_liquidity) return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: $${marketData.liquidity.toFixed(0)}`, marketData };

        const deadPoolVolReq = dbParams.min_vol_5m * 5; 
        if (marketData.liquidity > 100000 && marketData.volume5m < deadPoolVolReq) return { numeric_score: 0, isSafe: false, reason: `🛑 假池/貔貅攔截: 高流動但低交易`, marketData };

        const buys = marketData.buys5m;
        const sells = marketData.sells5m;
        const totalTxs5m = buys + sells;

        if (totalTxs5m < activeParams.minTxs) return { numeric_score: 0, isSafe: false, reason: `🛑 OFI 數據缺失: 5m交易量僅 ${totalTxs5m} 筆 (需 ${activeParams.minTxs})`, marketData };
        if (totalTxs5m >= 10 && sells === 0) return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 活躍交易但 0 賣單`, marketData };

        const avgTradeSize = totalTxs5m > 0 ? (marketData.volume5m / totalTxs5m) : 0;
        if (totalTxs5m >= 15 && avgTradeSize < activeParams.minTradeSize) return { numeric_score: 0, isSafe: false, reason: `🛑 納米刷量: 單筆均價極低 ($${avgTradeSize.toFixed(2)} < $${activeParams.minTradeSize})`, marketData };

        const turnover5m = marketData.liquidity > 0 ? (marketData.volume5m / marketData.liquidity) : 0;
        if (turnover5m > activeParams.maxTurnover) return { numeric_score: 0, isSafe: false, reason: `🛑 極端換手率護盾: 達 ${(turnover5m*100).toFixed(0)}% (上限 ${(activeParams.maxTurnover*100).toFixed(0)}%)`, marketData };
        if (turnover5m > 1.5 && marketData.h1 < 50) return { numeric_score: 0, isSafe: false, reason: `🛑 量價背離: 高換手率但不漲`, marketData };

        const buyRatio = buys / totalTxs5m;
        if (totalTxs5m > 30 && buyRatio > 0.45 && buyRatio < 0.55) return { numeric_score: 0, isSafe: false, reason: `🛑 女巫刷量: 買賣極度對稱`, marketData };

        // 🎯 V10.16 核心升級：動態 OFI 容忍度 (防禦殺錯良民)
        let minOFI = -0.4; // CHOPPY 震盪市容許 30%買/70%賣 (正常回調)
        if (climate === 'RAGING_BULL' || newsScore >= 4) {
            minOFI = -0.7; // 狂牛市容許短暫極端洗盤 (15%買/85%賣)，等接大回調底
        } else if (climate === 'BEAR_PANIC' || newsScore <= -3) {
            minOFI = -0.2; // 熊市嚴防瀑布 (40%買/60%賣即斬)
        }

        const pseudoOfi = (buys - sells) / totalTxs5m; 
        if (totalTxs5m >= 10 && pseudoOfi < minOFI) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 惡劣 OFI: 買賣失衡 (OFI: ${pseudoOfi.toFixed(2)} < ${minOFI})`, marketData };
        }

        const VERIFIED_TOKENS = cacheManager.getVerifiedTokens();
        if (VERIFIED_TOKENS[upperSymbol] && mint !== VERIFIED_TOKENS[upperSymbol]) return { numeric_score: 0, isSafe: false, reason: `🛑 終極防偽攔截: 假冒幣`, marketData };

        let score = 0;
        let reasons = [];

        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description, climate);
        if (textAnalysis.isFatal) return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        let coreScore = 20; 
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        const minLiqToScore = type === 'TRENDING' ? 50000 : 5000; 
        if (marketData.liquidity >= minLiqToScore) coreScore += 20;
        else reasons.push(`流動性未達優質線`);

        const safetyCheck = await this._checkContractSafety(mint, textAnalysis.requireAuthCheck);
        if (safetyCheck.isSafe) {
            coreScore += 20;
            if (safetyCheck.isMutable) { coreScore -= 20; reasons.push('Metadata 未鎖定'); }
        } else {
            return { numeric_score: 0, isSafe: false, reason: `🛑 合約高危或鏈上查詢失敗`, marketData };
        }

        const isHoldersSafe = await this._checkTop10Holders(mint);
        if (!isHoldersSafe) { 
            if (climate === 'BEAR_PANIC') { coreScore -= 20; reasons.push('籌碼過度集中 (熊市嚴懲)'); }
            else { reasons.push('⚠️ 籌碼過度集中 (Top10 > 50%)'); }
        }

        coreScore = Math.max(0, coreScore);

        let momentumScore = 0;
        if (marketData.h1 > 10) momentumScore += 15;
        else if (marketData.h1 > 0) momentumScore += 5;

        if (marketData.hasSocials) momentumScore += config.quant.socialPresenceScore; 

        if (totalTxs5m > 0) {
            const volOFI = (buys - sells) / totalTxs5m;
            const countRatio = sells > 0 ? (buys / sells) : 2;
            if (volOFI > 0.3 && countRatio > 1.5) { momentumScore += 15; reasons.push(`OFI 動能強勁`); }
        }

        momentumScore = Math.max(0, momentumScore - textAnalysis.fomoPenalty);
        score = coreScore + momentumScore;

        if (type !== 'TRENDING' && score >= 90) {
            score = 89; 
            reasons.push('🛡️ 預防盲狙: Meme幣強制降至 89 分等待 AI 審批');
        }

        const isSafe = score >= activeParams.buyThreshold; 
        const finalReason = isSafe 
            ? `量化得分: ${score}/100 [防:${coreScore}, 動:${momentumScore}] 氣候: ${climate} | 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${score}/100 (底線: ${activeParams.buyThreshold}), 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: score, isSafe, reason: finalReason, marketData };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };