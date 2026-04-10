// src/services/securityGuard.js
// 📝 檔案功能用途：V10.11 100分量化安檢中樞。
// 🚀 升級功能：動態讀取 DB 的 buy_score_threshold，拒絕死板硬編碼。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 

class SecurityGuard {
    
    analyzeTextFeatures(symbol, name, description) {
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
            if (p.test(fullText)) { result.safetyPenalty += 30; result.reasons.push(`高危分配/私募字眼 (${p.source}, 安全分 -30)`); break; }
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
            result.fomoPenalty += 20; result.reasons.push('重度 FOMO 情緒誘騙 (動能分 -20)');
        }

        return result;
    }

    async _fetchMarketData(mint) {
        let retries = 0;
        const maxRetries = 3;
        while (retries < maxRetries) {
            try {
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
                    retries++; await new Promise(r => setTimeout(r, 1100)); 
                } else return null; 
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
                if (metadataAcc && metadataAcc.data && metadataAcc.data[0] === 4) {
                    let offset = 1 + 32 + 32; 
                    const nameLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + nameLen;
                    const symbolLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + symbolLen;
                    const uriLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + uriLen;
                    offset += 2; 
                    const hasCreators = metadataAcc.data.readUInt8(offset); offset += 1;
                    if (hasCreators === 1) { const creatorsLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + (creatorsLen * 34); }
                    offset += 1; 
                    isMutable = metadataAcc.data.readUInt8(offset) === 1;
                }
            } catch (metaErr) {}

            return { isSafe: true, isMutable: isMutable };
        } catch (err) { return { isSafe: false, isMutable: false }; }
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
        const dbParams = cacheManager.getStrategy(type);
        const buyThreshold = dbParams.buy_score_threshold || 70; // 🚀 動態讀取買入底線

        const marketData = await this._fetchMarketData(mint);
        if (!marketData) return { numeric_score: 0, isSafe: false, reason: '無法獲取報價數據', marketData: null };

        const upperSymbol = marketData.symbol.toUpperCase();
        if (upperSymbol.startsWith('USD')) return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截`, marketData };

        if (marketData.liquidity < dbParams.min_liquidity) return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: $${marketData.liquidity.toFixed(0)}`, marketData };

        const deadPoolVolReq = dbParams.min_vol_5m * 5; 
        if (marketData.liquidity > 100000 && marketData.volume5m < deadPoolVolReq) return { numeric_score: 0, isSafe: false, reason: `🛑 假池/貔貅攔截: 高流動但低交易`, marketData };

        const buys = marketData.buys5m;
        const sells = marketData.sells5m;
        const totalTxs5m = buys + sells;

        const minTxsRequired = type === 'TRENDING' ? 20 : 10;
        if (totalTxs5m < minTxsRequired) return { numeric_score: 0, isSafe: false, reason: `🛑 OFI 數據缺失: 5m內交易量極低`, marketData };
        if (totalTxs5m >= 10 && sells === 0) return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 活躍交易但 0 賣單`, marketData };

        const avgTradeSize = totalTxs5m > 0 ? (marketData.volume5m / totalTxs5m) : 0;
        if (totalTxs5m >= 15 && avgTradeSize < 30) return { numeric_score: 0, isSafe: false, reason: `🛑 納米刷量: 單筆均價極低 ($${avgTradeSize.toFixed(2)})`, marketData };

        const turnover5m = marketData.liquidity > 0 ? (marketData.volume5m / marketData.liquidity) : 0;
        if (turnover5m > 0.60) return { numeric_score: 0, isSafe: false, reason: `🛑 極端換手率護盾: 5m換手率達 ${(turnover5m*100).toFixed(0)}%`, marketData };
        if (turnover5m > 1.5 && marketData.h1 < 50) return { numeric_score: 0, isSafe: false, reason: `🛑 量價背離: 高換手率但不漲`, marketData };

        const buyRatio = buys / totalTxs5m;
        if (totalTxs5m > 30 && buyRatio > 0.45 && buyRatio < 0.55) return { numeric_score: 0, isSafe: false, reason: `🛑 女巫刷量: 買賣極度對稱`, marketData };

        const pseudoOfi = (buys - sells) / totalTxs5m; 
        if (totalTxs5m >= 10 && pseudoOfi < -0.2) return { numeric_score: 0, isSafe: false, reason: `🛑 惡劣 OFI: 買賣力道嚴重失衡`, marketData };

        const VERIFIED_TOKENS = cacheManager.getVerifiedTokens();
        if (VERIFIED_TOKENS[upperSymbol] && mint !== VERIFIED_TOKENS[upperSymbol]) return { numeric_score: 0, isSafe: false, reason: `🛑 終極防偽攔截: 假冒幣`, marketData };

        let score = 0;
        let reasons = [];

        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description);
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
        } else reasons.push('合約高危');

        const isHoldersSafe = await this._checkTop10Holders(mint);
        if (!isHoldersSafe) { coreScore -= 20; reasons.push('籌碼過度集中'); }

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

        // 🚀 使用動態 buyThreshold 取代 config 固定的 rejectThreshold
        const isSafe = score >= buyThreshold; 
        const finalReason = isSafe 
            ? `量化得分: ${score}/100 [防:${coreScore}, 動:${momentumScore}] 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${score}/100, 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: score, isSafe, reason: finalReason, marketData };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };