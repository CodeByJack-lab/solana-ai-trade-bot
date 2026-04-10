// src/services/router.js
// 📝 檔案功能用途：V9.3 漏斗大腦分流器。掛載「2D 動態倉位矩陣」，加入 VIP OFI 攔截防線。

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

        // 🌍 0 毫秒極速讀取大市環境狀態
        const envStateStr = await redis.get('global_env_state');
        const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'CHOPPY', newsScore: 0 };
        const { climate, newsScore } = envState;

        // 🧠 套用 2D 動態倉位矩陣 (Dynamic Position Sizing Matrix)
        let multiplier = 0;
        if (climate === 'RAGING_BULL') {
            multiplier = score >= 90 ? 1.5 : 1.0;
        } else if (climate === 'CHOPPY') {
            multiplier = score >= 90 ? 1.0 : 0.5;
        } else if (climate === 'BEAR_PANIC') {
            multiplier = score >= 90 ? 0.5 : 0;
        }

        // 🛡️ 風控矩陣：大市極差且質素平庸 (BEAR_PANIC + 70-89) -> 直接 0x 攔截
        if (multiplier === 0) {
            console.log(`[Router] 🛑 風控矩陣攔截: 大市高危 (${climate}) 且質素平庸 (${score}分)。放棄建倉，節省彈藥！`);
            return false;
        }

        console.log(`[Router] 🌍 大市環境: ${climate} | 分數: ${score} | 預期倉位乘數: ${multiplier}x`);

        // 🚀 >= 90 分 (VIP Fast-Track)
        if (score >= config.quant.fastTrackThreshold) {
            // 🚀 VIP 專屬 OFI 攔截防線
            const buys = marketData.buys5m || 0;
            const sells = marketData.sells5m || 0;
            const totalTxs = buys + sells;
            const ofi = totalTxs > 0 ? (buys - sells) / totalTxs : null;

            if (ofi === null || ofi < 0) {
                console.log(`[Router] 🛑 VIP 攔截: ${mint} 雖然 ${score} 分，但 OFI 異常或缺失 (OFI: ${ofi})，取消 Fast-Track 直購！`);
                return false;
            }

            console.log(`[Router] 🚀 高質幣湧現！${mint} 獲得 ${score} 分且 OFI 健康 (${ofi.toFixed(2)})，啟動 VIP Fast-Track (乘數: ${multiplier}x)！`);
            return await this._handleFastTrack(mint, poolType, score, marketData, multiplier, envState);
        } 
        // ⚖️ 70-89 分，進入 AI 議事廳微調
        else if (score >= config.quant.aiReviewMin) {
            console.log(`[Router] ⚖️ 潛力標的: ${mint} (${score} 分)，進入 AI 議事廳微調審批...`);
            return await this._handleAiReview(mint, poolType, score, marketData, multiplier, newsScore, envState);
        }
        return false;
    }

    /**
     * 🚀 處理 Fast-Track 極速直購與汰弱留強
     */
    async _handleFastTrack(mint, poolType, score, marketData, multiplier, envState) {
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
        
        return await executeBuy(mint, marketData.symbol, strategyBase, score, `🌟 VIP 高質幣直購 (OFI 驗證通過)`, finalAmount, marketData, envState);
    }

    /**
     * 🔪 汰弱留強機制：宰殺最弱持倉
     */
    async _weedOutWeakest(isMeme) {
        const portfolio = getPortfolio();
        const positions = portfolio.positions.filter(p => p.strategy_type.includes(isMeme ? 'MEME' : 'TRENDING'));
        if (positions.length === 0) return false;

        const weakest = positions.sort((a, b) => (a.ai_score || 50) - (b.ai_score || 50))[0];

        console.log(`[Router] 🔪 鎖定最弱持倉: $${weakest.token_symbol}，準備市價處決...`);
        const success = await executeSell(weakest.mint_address, weakest.highest_price_sol || weakest.entry_price_sol, "🚨 汰弱留強：為 90+ 分極品騰出彈藥空間", 1.0);
        
        if (success) await new Promise(r => setTimeout(r, 2000));
        return success;
    }

    /**
     * ⚖️ 處理 AI 議事廳微調與動態倉位
     */
    async _handleAiReview(mint, poolType, baseScore, marketData, multiplier, newsScore, envState) {
        const aiDecision = await consensusService.runMemeConsensus(mint, marketData, { 
            baseScore,
            poolType,
            climate: envState.climate
        });
        
        if (!aiDecision.buy) {
            console.log(`[Router] 🧠 AI 否決: ${aiDecision.reason}`);
            return false;
        }

        let finalScore = aiDecision.score || baseScore;

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

        if (finalScore >= config.trade.sizeHalfPts && finalScore < config.trade.sizeFullPts) {
            strategySuffix += '_TIMESTOP';
            console.log(`[Router] ⚖️ 最終分數 ${finalScore} 落在 70-79 區間，套用 TimeStop 規則 (投入: ${finalAmount} SOL)`);
        } else {
            console.log(`[Router] ⚖️ 最終分數 ${finalScore} >= 80，優質建倉 (投入: ${finalAmount} SOL)`);
        }

        return await executeBuy(mint, marketData.symbol, strategySuffix, finalScore, aiDecision.reason, finalAmount, marketData, envState);
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