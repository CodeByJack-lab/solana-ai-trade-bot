// src/services/securityGuard.js
// 📝 檔案功能用途：V9.2 100分量化安檢中樞。實裝「懶漢判定法」保護 RPC、防 429 智能重試、原生 RPC Top 10 籌碼分佈檢查，廢除對 Birdeye 依賴。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');

class SecurityGuard {
    
    /**
     * 🕵️ 4 維度制度化文字快篩
     */
    analyzeTextFeatures(symbol, name, description) {
        const fullText = `${symbol} ${name} ${description}`.toLowerCase();
        let result = { isFatal: false, safetyPenalty: 0, fomoPenalty: 0, requireAuthCheck: false, requireLpCheck: false, reasons: [] };

        // 1. 空投/免費 (Airdrop/Promo) -> 直接封殺
        const airdropPatterns = [/free mint/i, /free claim/i, /airdrop/i, /claim now/i, /connect wallet/i];
        for (const p of airdropPatterns) {
            if (p.test(fullText)) {
                result.isFatal = true;
                result.reasons.push(`空投釣魚騙局 (${p.source})`);
                return result; 
            }
        }

        // 假鎖定聲稱 -> 必須觸發鏈上 LP 驗證
        if (/lp locked/i.test(fullText) || /burned lp/i.test(fullText)) {
            result.requireLpCheck = true;
            result.reasons.push('聲稱鎖定 LP (需鏈上核實)');
        }

        // 2. 供應分配/私募 (Supply/Allocation) -> 扣安全分 30 分
        const allocationPatterns = [/presale/i, /private sale/i, /team token/i, /marketing wallet/i, /seed/i];
        for (const p of allocationPatterns) {
            if (p.test(fullText)) {
                result.safetyPenalty += 30;
                result.reasons.push(`高危分配/私募字眼 (${p.source}, 安全分 -30)`);
                break;
            }
        }

        // 3. 權限控制 (Authority Control) -> 觸發深層權限檢查
        const authorityPatterns = [/mint authority/i, /freeze authority/i, /update authority/i, /we keep control/i];
        for (const p of authorityPatterns) {
            if (p.test(fullText)) {
                result.requireAuthCheck = true;
                result.reasons.push(`觸及權限敏感字 (${p.source}, 需鏈上深查)`);
            }
        }

        // 4. FOMO / 情緒誘騙 (FOMO Marketing) -> 扣動能分 20 分
        const fomoPatterns = [/100x/i, /1000x/i, /to the moon/i, /guaranteed profit/i, /🚀/];
        let hasFomo = false;
        for (const p of fomoPatterns) {
            if (p.test(fullText)) hasFomo = true;
        }
        // 表情轟炸
        const emojiMatches = fullText.match(/[\u{1F680}\u{1F525}\u{1F4A5}\u{1F4B0}]/gu);
        if (hasFomo || (emojiMatches && emojiMatches.length >= 5)) {
            result.fomoPenalty += 20;
            result.reasons.push('重度 FOMO 情緒誘騙 (動能分 -20)');
        }

        return result;
    }

    /**
     * 📊 獲取 DexScreener 報價 (具備 429 智能重試防護)
     */
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
                return null; // 有效回應但無池
            } catch (err) {
                if (err.response?.status === 429) {
                    retries++;
                    console.log(`⏳ [DexScreener] 觸發 429 限制，冷卻 1.1 秒後重試 (${retries}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, 1100)); // 精確 1.1 秒防抖
                } else {
                    return null; // 其他錯誤直接放棄
                }
            }
        }
        return null; // 耗盡重試次數
    }

    /**
     * 🛡️ 原生 RPC 權限審計 (免費)
     */
    async _checkContractSafety(mint, requireAuthCheck) {
        try {
            const accInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
            const info = accInfo.value?.data?.parsed?.info;
            if (!info) return false;
            
            if (info.mintAuthority || (requireAuthCheck && info.freezeAuthority)) return false;
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * 🦅 原生 RPC 籌碼分佈探測 (取代 Birdeye)
     */
    async _checkTop10Holders(mint) {
        try {
            const mintPubkey = new PublicKey(mint);
            
            // 1. 獲取總發行量
            const supplyRes = await connection.getTokenSupply(mintPubkey);
            const totalSupply = supplyRes.value?.uiAmount;
            if (!totalSupply || totalSupply === 0) return true; 

            // 2. 獲取最大持倉帳戶
            const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
            if (!largestAccounts.value || largestAccounts.value.length === 0) return true;

            // 3. 撇除最大池 (通常為 Raydium AMM)，計算第 2 至第 11 名的總和
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
            console.warn(`⚠️ [Top 10 Guard] 查閱籌碼失敗: ${err.message}`);
            return true; // 若 RPC 失敗，為免誤殺預設放行
        }
    }

    /**
     * 🎯 V9.2 量化 100 分核心引擎 (懶漢判定法：先快篩，後 RPC)
     */
    async calculateQuantScore(mint, type = 'NEWBORN') {
        // 🛡️ [0 成本] 藍籌白名單鐵閘
        if (type === 'TRENDING' && config.trade.enableTrendingWhitelist) {
            const whitelist = config.trade.trendingWhitelist || [];
            if (!whitelist.includes(mint)) {
                return { numeric_score: 0, isSafe: false, reason: `🛑 藍籌鐵閘攔截: 不在 Trending 白名單內`, marketData: null };
            }
        }

        // 📊 [低成本] 獲取 DexScreener 數據
        const marketData = await this._fetchMarketData(mint);
        if (!marketData) return { numeric_score: 0, isSafe: false, reason: '無法獲取報價數據 (DexScreener 異常或無池)', marketData: null };

        const upperSymbol = marketData.symbol.toUpperCase();

        // 🛑 [0 成本] 穩定幣攔截
        if (upperSymbol.startsWith('USD')) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截: 系統不交易 ${upperSymbol} 系列代幣`, marketData };
        }

        // 🛑 [0 成本] 絕對流動性底線 (未來會換成 DB 參數，目前暫時 hardcode 保底)
        const absoluteMinLiq = type === 'TRENDING' ? 20000 : 2500; 
        if (marketData.liquidity < absoluteMinLiq) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: 僅有 $${marketData.liquidity.toFixed(0)}`, marketData };
        }

        // 🛑 [0 成本] 死水大池與假池過濾
        if (marketData.liquidity > 100000 && marketData.volume5m < 5000) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 假池攔截: $10萬以上流動性但缺乏真實交易量 ($${marketData.volume5m.toFixed(0)})`, marketData };
        }

        // 🛑 [0 成本] 活人真實度與貔貅檢測
        const totalTxs5m = marketData.buys5m + marketData.sells5m;
        if (totalTxs5m > 0) {
            if (marketData.buys5m > 10 && marketData.sells5m === 0) {
                return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 完全沒有賣單 (Buy:${marketData.buys5m}, Sell:0)`, marketData };
            }
            const avgTrade = marketData.volume5m / totalTxs5m;
            if (totalTxs5m >= 100 && avgTrade < 15) {
                return { numeric_score: 0, isSafe: false, reason: `🛑 刷量攔截: 異常高頻但單筆均價極低 ($${avgTrade.toFixed(2)})`, marketData };
            }
        }

        // 🌟 [0 成本] 終極實體防偽
        const VERIFIED_TOKENS = { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' };
        if (VERIFIED_TOKENS[upperSymbol] && mint !== VERIFIED_TOKENS[upperSymbol]) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 終極防偽攔截: 假冒 ${upperSymbol} 幣`, marketData };
        }

        let score = 0;
        let reasons = [];

        // 🛡️ [0 成本] 四維度文字快篩
        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description);
        if (textAnalysis.isFatal) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        }
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        // ==========================================
        // 💎 進入高昂成本區：只有精英代幣才會呼叫 RPC
        // ==========================================
        let coreScore = 20; // 基礎分
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        const minLiqToScore = type === 'TRENDING' ? 50000 : 5000; 
        if (marketData.liquidity >= minLiqToScore) coreScore += 20;
        else reasons.push(`流動性未達優質線 ($${marketData.liquidity.toFixed(0)})`);

        // 1. 呼叫 RPC 查合約權限
        const isContractSafe = await this._checkContractSafety(mint, textAnalysis.requireAuthCheck);
        if (isContractSafe) coreScore += 20;
        else reasons.push('合約權限未放棄 (高危)');

        // 2. 呼叫 RPC 查 Top 10 籌碼分佈
        const isHoldersSafe = await this._checkTop10Holders(mint);
        if (!isHoldersSafe) {
            coreScore -= 20;
            reasons.push('籌碼過度集中 (Top10 > 50%)');
        }

        coreScore = Math.max(0, coreScore);

        // ==========================================
        // 🚀 Part 2: Momentum 結構與 OFI 濾波器
        // ==========================================
        let momentumScore = 0;

        if (marketData.h1 > 10) momentumScore += 15;
        else if (marketData.h1 > 0) momentumScore += 5;

        if (marketData.hasSocials) momentumScore += config.quant.socialPresenceScore; // 5分

        if (totalTxs5m > 0) {
            const volOFI = (marketData.buys5m - marketData.sells5m) / totalTxs5m;
            const countRatio = marketData.sells5m > 0 ? (marketData.buys5m / marketData.sells5m) : 2;
            const avgTrade = marketData.volume5m / totalTxs5m;

            if (totalTxs5m >= 20 && avgTrade < 20) {
                reasons.push('疑似納米刷量機器人 (動能無效)');
            } else if (volOFI > 0.3 && countRatio > 1.5) {
                momentumScore += 15;
                reasons.push(`OFI 動能強勁 (VolOFI:${volOFI.toFixed(2)}, Ratio:${countRatio.toFixed(1)})`);
            }
        }

        momentumScore = Math.max(0, momentumScore - textAnalysis.fomoPenalty);
        score = coreScore + momentumScore;

        // 🎯 廢除 Meme 幣 Fast-Track 特權
        if (type !== 'TRENDING' && score >= 90) {
            score = 89; 
            reasons.push('🛡️ 預防盲狙: Meme幣強制降至 89 分等待 AI 審批');
        }

        const isSafe = score >= config.quant.rejectThreshold; 
        const finalReason = isSafe 
            ? `量化得分: ${score}/100 [防禦:${coreScore}, 動能:${momentumScore}] 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${score}/100, 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: score, isSafe, reason: finalReason, marketData };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };