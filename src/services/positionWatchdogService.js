// src/services/positionWatchdogService.js
// 📝 檔案功能用途：V2.0 AI 督導員 (Watchdog)。負責階梯式體檢 (20%, 40%...) 並呼叫 Gemma 3 進行智能平倉決策。
// 🛡️ V2.1 修復：實裝 Redis 併發鎖防衝突、攔截重複 SELL_HALF、強化 JSON 解析容錯。

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

        // 🛡️ 督導員只負責「高位套現」，跌市或未達標 ( < 20%) 交由 monitorService 的純 Code 硬止損處理
        if (milestoneLevel < 20) return;

        const lockKey = `watchdog_checked:${position.mint_address}:L${milestoneLevel}`;
        const isChecked = await redis.get(lockKey);
        
        if (!isChecked) {
            console.log(`🕵️‍♂️ [Watchdog] 觸發 ${milestoneLevel}% 階梯體檢！準備呼叫 AI 評估 $${position.token_symbol}...`);
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
            const match = responseText.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("AI 吐出的不是有效 JSON");
            
            const decision = JSON.parse(match[0]);
            console.log(`🤖 [AI Watchdog] $${position.token_symbol} | 判定: ${decision.action} | 理由: ${decision.thought_process}`);

            // ⚡ 執行智能平倉 (實裝 Redis 併發鎖與防呆機制)
            if (decision.action === 'SELL_HALF' || decision.action === 'SELL_ALL') {
                
                // 1. 檢查是否已經賣過一半，防止重複切香腸
                const isHalfSold = position.strategy_type?.includes('HALF_SOLD');
                if (decision.action === 'SELL_HALF' && isHalfSold) {
                    console.log(`🛡️ [Watchdog] 已經平過半倉，無視重複的 SELL_HALF 指令，繼續讓利潤奔跑！`);
                    return;
                }

                // 2. 獲取全域交易鎖，防止與 monitorService 撞車
                const tradeLockKey = `sell_lock:${position.mint_address}`;
                const acquired = await redis.set(tradeLockKey, 'LOCKED', 'EX', 30, 'NX');
                
                if (acquired) {
                    try {
                        const fraction = decision.action === 'SELL_HALF' ? 0.5 : 1.0;
                        const actionText = decision.action === 'SELL_HALF' ? '鎖定一半利潤' : '全數撤退';
                        await runSellPipeline(position, position.highest_price_sol, `🤖 AI 階梯體檢：${actionText} (${decision.thought_process})`, fraction);
                    } finally {
                        await redis.del(tradeLockKey); // 釋放鎖
                    }
                } else {
                    console.log(`🛡️ [Watchdog] 發現 monitorService 正在處理 $${position.token_symbol} 的平倉，AI 督導員主動避讓。`);
                }
            }

        } catch (error) {
            console.error(`⚠️ [Watchdog] AI 體檢超時或失敗，繼續交由純 Code 追蹤回撤防守。`);
        }
    }
};

module.exports = { positionWatchdogService };