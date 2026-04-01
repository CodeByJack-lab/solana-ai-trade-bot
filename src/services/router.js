// src/services/router.js
// 📝 檔案功能用途：V9.1 漏斗大腦分流器。掛載「2D 動態倉位矩陣」，結合大市風險級別 (Risk Level) 與質素分數 (Score) 精準調配火力與 AI 權限。

const config = require('../config/config');
const { supabase } = require('../config/supabase');
const { getPortfolio, canBuyTrending, canBuyMeme } = require('./portfolioService');
const { executeBuy, executeSell } = require('./tradeService');
const { consensusService } = require('./consensusService');
const { healthMonitor } = require('./healthMonitor');
const Redis = require('ioredis');

const redis = new Redis(config.cache.redisUrl);

class Router {
    
    /**
     * 🚦 核心分流引擎 (搭載 2D 動態倉位矩陣)
     */
    async routeSignal(mint, poolType, secResult) {
        healthMonitor.setStatus('Trade_Engine', `🟢 路由分析中: ${mint.substring(0,6)}`);

        if (!secResult.isSafe || secResult.numeric_score < config.quant.rejectThreshold) {
            console.log(`[Router] 🛑 攔截: ${mint} 分數過低 (${secResult.numeric_score}/100)。直接拋棄。`);
            return false;
        }

        const score = secResult.numeric_score;
        const marketData = secResult.marketData;

        // 🌍 0 毫秒極速讀取大市環境狀態 (O(1) Redis Lookup)
        const envStateStr = await redis.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { riskLevel: 'LOW', newsScore: 0 };
        const { riskLevel, newsScore } = envState;

        // 🧠 套用 2D 動態倉位矩陣 (Dynamic Position Sizing Matrix)
        let multiplier = 0;
        if (riskLevel === 'LOW') {
            multiplier = score >= 90 ? 1.5 : 1.0;
        } else if (riskLevel === 'MEDIUM') {
            multiplier = score >= 90 ? 1.0 : 0.5;
        } else if (riskLevel === 'HIGH') {
            multiplier = score >= 90 ? 0.5 : 0;
        }

        // 🛡️ 風控矩陣：大市極差且質素平庸 (HIGH + 60-89) -> 直接 0x 攔截
        if (multiplier === 0) {
            console.log(`[Router] 🛑 風控矩陣攔截: 大市高危 (${riskLevel}) 且質素平庸 (${score}分)。放棄建倉，節省彈藥！`);
            return false;
        }

        console.log(`[Router] 🌍 大市環境: ${riskLevel} | 分數: ${score} | 預期倉位乘數: ${multiplier}x`);

        // 🚀 >= 90 分 (Fast-Track)，跳過 AI 審批
        if (score >= config.quant.fastTrackThreshold) {
            console.log(`[Router] 🚀 極品湧現！${mint} 獲得 ${score} 分，啟動 Fast-Track 跳過 AI 直購！`);
            return await this._handleFastTrack(mint, poolType, score, marketData, multiplier);
        } 
        // ⚖️ 60-89 分，進入 AI 議事廳微調
        else {
            console.log(`[Router] ⚖️ 潛力標的: ${mint} (${score} 分)，進入 AI 議事廳微調審批...`);
            return await this._handleAiReview(mint, poolType, score, marketData, multiplier, newsScore);
        }
    }

    /**
     * 🚀 處理 Fast-Track 極速直購與汰弱留強
     */
    async _handleFastTrack(mint, poolType, score, marketData, multiplier) {
        const isMeme = poolType === 'NEWBORN';
        const strategyBase = isMeme ? 'MEME_FASTTRACK' : 'TRENDING_FASTTRACK';
        const hasCapacity = isMeme ? canBuyMeme() : canBuyTrending();

        // ⚠️ 倉位已滿，觸發「汰弱留強 (Weed-out)」強平機制
        if (!hasCapacity) {
            console.log(`[Router] ⚠️ ${isMeme ? 'Meme' : 'Trending'} 倉位已滿，觸發「汰弱留強 (Weed-out)」機制！`);
            const freedUp = await this._weedOutWeakest(isMeme);
            if (!freedUp) {
                console.log(`[Router] ❌ 汰弱留強失敗，放棄買入 ${marketData.symbol}`);
                return false;
            }
        }

        const baseAmount = await this._getTradeAmount(isMeme);
        const finalAmount = baseAmount * multiplier;
        
        return await executeBuy(mint, marketData.symbol, strategyBase, score, `🌟 量化 90+ 極品，Fast-Track (倍數: ${multiplier}x)`, finalAmount);
    }

    /**
     * 🔪 汰弱留強機制：宰殺最弱持倉
     */
    async _weedOutWeakest(isMeme) {
        const portfolio = getPortfolio();
        const positions = portfolio.positions.filter(p => p.strategy_type.includes(isMeme ? 'MEME' : 'TRENDING'));
        if (positions.length === 0) return false;

        // 鎖定 AI 評分最低或帳面最差的持倉
        const weakest = positions.sort((a, b) => (a.ai_score || 50) - (b.ai_score || 50))[0];

        console.log(`[Router] 🔪 鎖定最弱持倉: $${weakest.token_symbol}，準備市價處決...`);
        const success = await executeSell(weakest.mint_address, weakest.highest_price_sol || weakest.entry_price_sol, "🚨 汰弱留強：為 90+ 分極品騰出彈藥空間", 1.0);
        
        if (success) await new Promise(r => setTimeout(r, 2000)); // 等待 DB 同步
        return success;
    }

    /**
     * ⚖️ 處理 AI 議事廳微調與動態倉位
     */
    async _handleAiReview(mint, poolType, baseScore, marketData, multiplier, newsScore) {
        // 送入 consensusService
        const aiDecision = await consensusService.runMemeConsensus(mint, marketData, { baseScore });
        
        if (!aiDecision.buy) {
            console.log(`[Router] 🧠 AI 否決: ${aiDecision.reason}`);
            return false;
        }

        let finalScore = aiDecision.score || baseScore;

        // ⚠️ 環境微調因子干預：若新聞極度負面 (<= -3)，剝奪 AI 的加分權限，只准減分
        if (newsScore <= -3 && finalScore > baseScore) {
            console.log(`[Router] 📰 新聞環境惡劣 (Score: ${newsScore})，剝奪 AI 加分權限！(原擬 ${baseScore} -> ${finalScore}，強制退回 ${baseScore})`);
            finalScore = baseScore; 
        }

        const isMeme = poolType === 'NEWBORN';
        const hasCapacity = isMeme ? canBuyMeme() : canBuyTrending();

        if (!hasCapacity) {
            console.log(`[Router] ⚠️ 倉位已滿，AI 推薦標的 $${marketData.symbol} 被捨棄 (分數未達 90 不觸發強平)`);
            return false;
        }

        const baseAmount = await this._getTradeAmount(isMeme);
        const finalAmount = baseAmount * multiplier;
        let strategySuffix = isMeme ? 'MEME_AI' : 'TRENDING_AI';

        // 動態標記：若 AI 微調後分數仍落於 60-79 區間，強制套用 30 分鐘 Time-Stop 標記
        if (finalScore >= config.trade.sizeHalfPts && finalScore < config.trade.sizeFullPts) {
            strategySuffix += '_TIMESTOP';
            console.log(`[Router] ⚖️ 最終分數 ${finalScore} 落在 60-79 區間，套用 30m TimeStop 規則 (投入: ${finalAmount} SOL)`);
        } else {
            console.log(`[Router] ⚖️ 最終分數 ${finalScore} >= 80，優質建倉 (投入: ${finalAmount} SOL)`);
        }

        return await executeBuy(mint, marketData.symbol, strategySuffix, finalScore, aiDecision.reason, finalAmount);
    }

    /**
     * 💰 輔助功能：獲取基準買入金額
     */
    async _getTradeAmount(isMeme) {
        const { data: sysConfig } = await supabase.from('system_config').select('trade_amount_sol, trending_trade_amount_sol').eq('id', 1).single();
        if (!sysConfig) return 0.1;
        return isMeme ? (sysConfig.trade_amount_sol || 0.1) : (sysConfig.trending_trade_amount_sol || 0.5);
    }
}

const routerService = new Router();
module.exports = { routerService };