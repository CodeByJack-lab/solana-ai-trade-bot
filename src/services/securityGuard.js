// src/services/securityGuard.js
// 📝 檔案功能用途：V10.9 100分量化安檢中樞。實裝 OFI 絕對零容忍機制，徹底杜絕無交易量之初生幣盲狙。
// 🚀 V10.9 升級：如果 5 分鐘內交易筆數 < 10 (Meme) / < 20 (Trending)，直接判死刑，連 AI 都唔准見！

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
            if (p.test(fullText)) {
                result.isFatal = true;
                result.reasons.push(`空投釣魚騙局 (${p.source})`);
                return result; 
            }
        }

        if (/lp locked/i.test(fullText) || /burned lp/i.test(fullText)) {
            result.requireLpCheck = true;
            result.reasons.push('聲稱鎖定 LP (需鏈上核實)');
        }

        const allocationPatterns = [/presale/i, /private sale/i, /team token/i, /marketing wallet/i, /seed/i];
        for (const p of allocationPatterns) {
            if (p.test(fullText)) {
                result.safetyPenalty += 30;
                result.reasons.push(`高危分配/私募字眼 (${p.source}, 安全分 -30)`);
                break;
            }
        }

        const authorityPatterns = [/mint authority/i, /freeze authority/i, /update authority/i, /we keep control/i];
        for (const p of authorityPatterns) {
            if (p.test(fullText)) {
                result.requireAuthCheck = true;
                result.reasons.push(`觸及權限敏感字 (${p.source}, 需鏈上深查)`);
            }
        }

        const fomoPatterns = [/100x/i, /1000x/i, /to the moon/i, /guaranteed profit/i, /🚀/];
        let hasFomo = false;
        for (const p of fomoPatterns) {
            if (p.test(fullText)) hasFomo = true;
        }
        const emojiMatches = fullText.match(/[\u{1F680}\u{1F525}\u{1F4A5}\u{1F4B0}]/gu);
        if (hasFomo || (emojiMatches && emojiMatches.length >= 5)) {
            result.fomoPenalty += 20;
            result.reasons.push('重度 FOMO 情緒誘騙 (動能分 -20)');
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
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        description: pair.info?.description || '',
                        liquidity: pair.liquidity?.usd || 0, 
                        fdv: pair.fdv || 0,
                        volume5m: pair.volume?.m5 || 0,
                        buys5m: pair.txns?.m5?.buys || 0, 
                        sells5m: pair.txns?.m5?.sells || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0, 
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                    };
                }
                return null; 
            } catch (err) {
                if (err.response?.status === 429) {
                    retries++;
                    console.log(`⏳ [DexScreener] 觸發 429 限制，冷卻 1.1 秒後重試 (${retries}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, 1100)); 
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
            const hasTransferFee = extensions.some(ext => ext.extension === 'transferFeeConfig');
            if (hasTransferFee) {
                console.log(`🚨 [Security Guard] 攔截！發現 Token-2022 交易稅陷阱！`);
                return { isSafe: false, isMutable: false };
            }

            if (info.mintAuthority || (requireAuthCheck && info.freezeAuthority)) {
                return { isSafe: false, isMutable: false };
            }

            let isMutable = false;
            try {
                const metaplexProgramId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from('metadata'), metaplexProgramId.toBuffer(), mintPubkey.toBuffer()],
                    metaplexProgramId
                );
                
                const metadataAcc = await connection.getAccountInfo(metadataPDA);
                
                if (metadataAcc && metadataAcc.data && metadataAcc.data[0] === 4) {
                    let offset = 1 + 32 + 32; 
                    const nameLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + nameLen;
                    const symbolLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + symbolLen;
                    const uriLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + uriLen;
                    offset += 2; 
                    
                    const hasCreators = metadataAcc.data.readUInt8(offset); offset += 1;
                    if (hasCreators === 1) {
                        const creatorsLen = metadataAcc.data.readUInt32LE(offset); 
                        offset += 4 + (creatorsLen * 34); 
                    }
                    offset += 1; 
                    
                    isMutable = metadataAcc.data.readUInt8(offset) === 1;
                }
            } catch (metaErr) {
                // 忽略 Metadata 讀取錯誤
            }

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
            const holdersToCheck = largestAccounts.value.slice(1, 11); 
            
            for (const account of holdersToCheck) {
                top10Sum += account.uiAmount || 0;
            }

            const top10Pct = top10Sum / totalSupply;
            
            if (top10Pct > 0.50) {
                console.log(`🚨 [Top 10 Guard] 籌碼過度集中！前 10 大散戶持倉(撇除最大池)佔比 ${(top10Pct*100).toFixed(2)}%: ${mint}`);
                return false; 
            }
            return true;
        } catch (err) {
            return true; 
        }
    }

    async calculateQuantScore(mint, type = 'NEWBORN') {
        const dbParams = cacheManager.getStrategy(type);

        const marketData = await this._fetchMarketData(mint);
        if (!marketData) return { numeric_score: 0, isSafe: false, reason: '無法獲取報價數據 (DexScreener 異常或無池)', marketData: null };

        const upperSymbol = marketData.symbol.toUpperCase();

        if (upperSymbol.startsWith('USD')) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截: 系統不交易 ${upperSymbol} 系列代幣`, marketData };
        }

        if (marketData.liquidity < dbParams.min_liquidity) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: 僅有 $${marketData.liquidity.toFixed(0)} (底線: $${dbParams.min_liquidity})`, marketData };
        }

        const deadPoolVolReq = dbParams.min_vol_5m * 5; 
        if (marketData.liquidity > 100000 && marketData.volume5m < deadPoolVolReq) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 假池/貔貅攔截: $10萬以上流動性但交易量不足 $${deadPoolVolReq}`, marketData };
        }

        // ==========================================
        // 🛡️ [0 成本] 終極 OFI 裝甲與防刷量天網 (V10.9)
        // ==========================================
        const buys = marketData.buys5m;
        const sells = marketData.sells5m;
        const totalTxs5m = buys + sells;

        // 1. 🚨 絕對 OFI 數據要求 (核心修復)
        // 如果 5 分鐘內交易極少，根本無法計算真實 OFI，拒絕盲狙！
        const minTxsRequired = type === 'TRENDING' ? 20 : 10;
        if (totalTxs5m < minTxsRequired) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 OFI 數據缺失: 5分鐘內僅 ${totalTxs5m} 筆真實交易 (要求:${minTxsRequired})，拒絕盲狙！`, marketData };
        }

        // 2. 貔貅盤攔截 (有活躍交易但 0 賣單)
        if (totalTxs5m >= 10 && sells === 0) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 活躍交易但完全沒有賣單 (Buy:${buys}, Sell:0)`, marketData };
        }

        // 3. 納米乞衣刷量 (專殺微型造市單)
        const avgTradeSize = totalTxs5m > 0 ? (marketData.volume5m / totalTxs5m) : 0;
        if (totalTxs5m >= 15 && avgTradeSize < 30) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 納米刷量: 發現乞衣級腳本造市，單筆均價極低 ($${avgTradeSize.toFixed(2)})`, marketData };
        }

        // 4. 量價背離死亡交叉 (高換手但不漲)
        const turnover5m = marketData.liquidity > 0 ? (marketData.volume5m / marketData.liquidity) : 0;
        if (turnover5m > 1.5 && marketData.h1 < 50) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 量價背離: 5m換手率極端異常 (${(turnover5m*100).toFixed(0)}%) 但價格並未爆發，必屬高階造市腳本互刷`, marketData };
        }

        // 5. 女巫攻擊 / 完美對稱刷量
        const buyRatio = buys / totalTxs5m;
        if (totalTxs5m > 30 && buyRatio > 0.45 && buyRatio < 0.55) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 女巫刷量: 買賣極度對稱 (Ratio:${(buyRatio*100).toFixed(1)}%)，判定為腳本對沖`, marketData };
        }

        // 6. 惡劣 OFI (強大賣壓) 攔截
        const pseudoOfi = (buys - sells) / totalTxs5m; 
        if (totalTxs5m >= 10 && pseudoOfi < -0.2) {
             return { numeric_score: 0, isSafe: false, reason: `🛑 惡劣 OFI: 買賣力道嚴重失衡 (OFI: ${pseudoOfi.toFixed(2)})，空軍壓境`, marketData };
        }

        // 🌟 終極實體防偽
        const VERIFIED_TOKENS = cacheManager.getVerifiedTokens();
        if (VERIFIED_TOKENS[upperSymbol] && mint !== VERIFIED_TOKENS[upperSymbol]) {
            console.log(`🛡️ [Fake Shield] 觸發終極防偽！秒殺假冒 ${upperSymbol} (${mint})`);
            return { numeric_score: 0, isSafe: false, reason: `🛑 終極防偽攔截: 假冒 ${upperSymbol} 幣`, marketData };
        }

        let score = 0;
        let reasons = [];

        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description);
        if (textAnalysis.isFatal) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        }
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        let coreScore = 20; 
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        const minLiqToScore = type === 'TRENDING' ? 50000 : 5000; 
        if (marketData.liquidity >= minLiqToScore) coreScore += 20;
        else reasons.push(`流動性未達優質線 ($${marketData.liquidity.toFixed(0)})`);

        const safetyCheck = await this._checkContractSafety(mint, textAnalysis.requireAuthCheck);
        if (safetyCheck.isSafe) {
            coreScore += 20;
            if (safetyCheck.isMutable) {
                coreScore -= 20;
                reasons.push('Metadata 未鎖定 (可隨時改名/換圖，極高危)');
            }
        } else {
            reasons.push('合約權限未放棄或有隱藏稅 (高危)');
        }

        const isHoldersSafe = await this._checkTop10Holders(mint);
        if (!isHoldersSafe) {
            coreScore -= 20;
            reasons.push('籌碼過度集中 (Top10 > 50%)');
        }

        coreScore = Math.max(0, coreScore);

        let momentumScore = 0;
        if (marketData.h1 > 10) momentumScore += 15;
        else if (marketData.h1 > 0) momentumScore += 5;

        if (marketData.hasSocials) momentumScore += config.quant.socialPresenceScore; 

        if (totalTxs5m > 0) {
            const volOFI = (buys - sells) / totalTxs5m;
            const countRatio = sells > 0 ? (buys / sells) : 2;

            if (volOFI > 0.3 && countRatio > 1.5) {
                momentumScore += 15;
                reasons.push(`OFI 動能強勁`);
            }
        }

        momentumScore = Math.max(0, momentumScore - textAnalysis.fomoPenalty);
        score = coreScore + momentumScore;

        if (type !== 'TRENDING' && score >= 90) {
            score = 89; 
            reasons.push('🛡️ 預防盲狙: Meme幣強制降至 89 分等待 AI 審批');
        }

        const isSafe = score >= config.quant.rejectThreshold; 
        const finalReason = isSafe 
            ? `量化得分: ${score}/100 [防:${coreScore}, 動:${momentumScore}] 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${score}/100, 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: score, isSafe, reason: finalReason, marketData };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };