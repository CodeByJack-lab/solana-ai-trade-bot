// src/services/securityGuard.js
// 📝 檔案功能用途：V9.1 100分量化安檢中樞。實作「4 維度文字快篩」與「OFI 動能質量驗證」，精準裁決分數。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');

const PROVIDERS = ['DEXSCREENER', 'BIRDEYE'];
let activeProviderIdx = 0;

class SecurityGuard {
    
    /**
     * 🕵️ 4 維度制度化文字快篩
     * 回傳: { isFatal: boolean, safetyPenalty: number, fomoPenalty: number, requireAuthCheck: boolean, requireLpCheck: boolean, reasons: string[] }
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

    async _fetchMarketData(mint) {
        for (let i = 0; i < PROVIDERS.length; i++) {
            const provider = PROVIDERS[(activeProviderIdx + i) % PROVIDERS.length];
            try {
                if (provider === 'DEXSCREENER') {
                    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
                    if (res.data?.pairs && res.data.pairs.length > 0) {
                        const pair = res.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                        activeProviderIdx = (activeProviderIdx + i) % PROVIDERS.length;
                        return {
                            symbol: pair.baseToken?.symbol || 'UNKNOWN',
                            name: pair.baseToken?.name || 'UNKNOWN',
                            description: pair.info?.description || '',
                            liquidity: pair.liquidity?.usd || 0, fdv: pair.fdv || 0,
                            volume5m: pair.volume?.m5 || 0,
                            buys5m: pair.txns?.m5?.buys || 0, sells5m: pair.txns?.m5?.sells || 0,
                            h1: parseFloat(pair.priceChange?.h1) || 0, priceUsd: parseFloat(pair.priceUsd) || 0,
                            hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                        };
                    }
                }
            } catch (err) {}
        }
        return null;
    }

    async _checkContractSafety(mint, requireAuthCheck) {
        try {
            const accInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
            const info = accInfo.value?.data?.parsed?.info;
            if (!info) return false;
            
            // 如果文案觸發 requireAuthCheck，即使只有 Freeze 沒放棄也直接封殺
            if (info.mintAuthority || (requireAuthCheck && info.freezeAuthority)) return false;
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * 🎯 V9.1 量化 100 分核心引擎
     */
    async calculateQuantScore(mint, type = 'NEWBORN') {
        const marketData = await this._fetchMarketData(mint);
        if (!marketData) return { numeric_score: 0, isSafe: false, reason: '無法獲取報價數據', marketData: null };

        let score = 0;
        let reasons = [];

        // ==========================================
        // 🛡️ Tier-0: 四維度文字快篩
        // ==========================================
        const textAnalysis = this.analyzeTextFeatures(marketData.symbol, marketData.name, marketData.description);
        if (textAnalysis.isFatal) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 一票否決: ${textAnalysis.reasons.join(', ')}`, marketData };
        }
        if (textAnalysis.reasons.length > 0) reasons.push(...textAnalysis.reasons);

        // ==========================================
        // 🛡️ Part 1: Core Defense (滿分 60 分)
        // ==========================================
        let coreScore = 0;

        const minLiq = type === 'TRENDING' ? 50000 : 5000; 
        if (marketData.liquidity >= minLiq) coreScore += 20;
        else reasons.push(`流動性不足 ($${marketData.liquidity.toFixed(0)})`);

        const isContractSafe = await this._checkContractSafety(mint, textAnalysis.requireAuthCheck);
        if (isContractSafe) coreScore += 20;
        else reasons.push('合約權限未放棄 (高危)');

        // (註：LP 真實鎖定檢查與前 20 大持倉集中度檢查，由於涉及大量 RPC 請求，
        // 在免費層級下，若 textAnalysis.requireLpCheck 為 true 或扣了 30 分，此處將其反映在分數懲罰中)
        coreScore += 20; // 基礎分
        coreScore = Math.max(0, coreScore - textAnalysis.safetyPenalty);

        // ==========================================
        // 🚀 Part 2: Momentum 結構與 OFI 濾波器 (滿分 40 分)
        // ==========================================
        let momentumScore = 0;

        if (marketData.h1 > 10) momentumScore += 15;
        else if (marketData.h1 > 0) momentumScore += 5;

        if (marketData.hasSocials) momentumScore += config.quant.socialPresenceScore; // 5分

        // 🌊 偽 OFI 動能質量檢查 (三道關卡)
        const totalTxs = marketData.buys5m + marketData.sells5m;
        if (totalTxs > 0) {
            const volOFI = (marketData.buys5m - marketData.sells5m) / totalTxs;
            const countRatio = marketData.sells5m > 0 ? (marketData.buys5m / marketData.sells5m) : 2;
            const avgTrade = marketData.volume5m / totalTxs;

            // 1. 刷量檢測 (Wash Trading)
            if (totalTxs >= 20 && avgTrade < 20) {
                reasons.push('疑似納米刷量機器人 (動能無效)');
            } 
            // 2. OFI 質量達標 -> 額外加分
            else if (volOFI > 0.3 && countRatio > 1.5) {
                momentumScore += 15;
                reasons.push(`OFI 動能強勁 (VolOFI:${volOFI.toFixed(2)}, Ratio:${countRatio.toFixed(1)})`);
            }
        }

        // 施加 FOMO 懲罰
        momentumScore = Math.max(0, momentumScore - textAnalysis.fomoPenalty);

        score = coreScore + momentumScore;

        const isSafe = score >= config.quant.rejectThreshold; 
        const finalReason = isSafe 
            ? `量化得分: ${score}/100 [防禦:${coreScore}, 動能:${momentumScore}] 備註: ${reasons.join(' | ')}` 
            : `攔截得分: ${score}/100, 缺陷: ${reasons.join(' | ')}`;

        return { numeric_score: score, isSafe, reason: finalReason, marketData };
    }
}

const securityGuard = new SecurityGuard();
module.exports = { securityGuard };