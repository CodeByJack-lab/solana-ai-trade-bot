// src/services/positionWatchdogService.js
// 📝 檔案功能用途：V2.0 AI 督導員 (Watchdog)。負責階梯式體檢 (20%, 40%...) 並呼叫 Gemma 3 進行智能平倉決策。

const axios = require('axios');
const Redis = require('ioredis');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager');
const { runSellPipeline } = require('./tradeService'); 
const redis = new Redis(config.cache.redisUrl || process.env.REDIS_URL);

const positionWatchdogService = {
    async checkMilestones(position, currentPriceSol, maxPriceSol) {
        const entryPrice = position.entry_price_sol;
        const currentProfitPct = ((currentPriceSol - entryPrice) / entryPrice) * 100;
        
        // 階梯設定：每 20% 一個坎
        const milestoneLevel = Math.floor(currentProfitPct / 20) * 20;

        // 如果利潤未夠 20% 或者已經過咗最高位，不干預
        if (milestoneLevel < 20) return;

        const lockKey = `watchdog_checked:${position.mint_address}:L${milestoneLevel}`;
        const isChecked = await redis.get(lockKey);
        
        if (!isChecked) {
            console.log(`🕵️‍♂️ [Watchdog] 觸發 ${milestoneLevel}% 階梯體檢！準備呼叫 Gemma 3 評估 $${position.token_symbol}...`);
            await redis.set(lockKey, 'DONE', 'EX', 86400); // 落鎖防止重複觸發
            await this.callAiWatchdog(position, currentProfitPct, maxPriceSol);
        }
    },

    async callAiWatchdog(position, currentProfitPct, maxPriceSol) {
        try {
            const maxProfitPct = ((maxPriceSol - position.entry_price_sol) / position.entry_price_sol) * 100;
            const holdTimeMins = Math.floor((Date.now() - new Date(position.created_at).getTime()) / 60000);
            const envStateStr = await redis.get('global_env_state');
            const envState = envStateStr ? JSON.parse(envStateStr) : { climate: 'UNKNOWN' };

            const aiConfig = cacheManager.getPromptConfig('POSITION_WATCHDOG', {
                token_symbol: position.token_symbol,
                current_profit_pct: currentProfitPct.toFixed(2),
                max_profit_pct: maxProfitPct.toFixed(2),
                hold_time_mins: holdTimeMins,
                market_climate: envState.climate
            });

            const geminiKey = process.env.GEMINI_API_KEY_1;
            if (!geminiKey) return;

            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${aiConfig.models[0]}:generateContent?key=${geminiKey}`, {
                contents: [{ parts: [{ text: aiConfig.parsedPrompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            }, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });

            const responseText = res.data.candidates[0].content.parts[0].text;
            const decision = JSON.parse(responseText.match(/\{[\s\S]*\}/)[0]);

            console.log(`🤖 [Gemma Watchdog] $${position.token_symbol} | 判定: ${decision.action} | 理由: ${decision.thought_process}`);

            // 執行智能平倉
            if (decision.action === 'SELL_HALF') {
                await runSellPipeline(position, position.highest_price_sol, `AI 階梯體檢：鎖定一半利潤 (${decision.thought_process})`, 0.5);
            } else if (decision.action === 'SELL_ALL') {
                await runSellPipeline(position, position.highest_price_sol, `AI 階梯體檢：全數撤退 (${decision.thought_process})`, 1.0);
            }

        } catch (error) {
            console.error(`⚠️ [Watchdog] AI 體檢超時或失敗，繼續交由純 Code 追蹤回撤防守。`);
        }
    }
};

module.exports = { positionWatchdogService };