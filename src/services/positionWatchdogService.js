// src/services/positionWatchdogService.js
// 📝 檔案功能用途：V2.2 AI 督導員 (Watchdog)。負責階梯式體檢 (20%, 40%...) 並呼叫 Mistral 進行智能平倉決策。
// 🛡️ V2.2 升級：全線轉交 MISTRAL 處理，並對接 KeyRotator 獨立使用 Key 3 避免 429 衝突。

const axios = require('axios');
const Redis = require('ioredis');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager');
const { runSellPipeline } = require('./tradeService'); 
const { keyRotator } = require('./keyRotator'); // 🚀 引入排隊引擎
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
            console.log(`🕵️‍♂️ [Watchdog] 觸發 ${milestoneLevel}% 階梯體檢！準備呼叫 MISTRAL 評估 $${position.token_symbol}...`);
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

            // 🚀 透過 KeyRotator 呼叫 MISTRAL (指定 promptId 以獲取專屬 Key 3)
            const decision = await keyRotator.enqueueRequest('MISTRAL', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const apiUrl = 'https://api.mistral.ai/v1/chat/completions';
                const modelName = aiConfig.models[0] || 'mistral-large-latest';

                console.log(`[KeyRotator] 🔫 系統抽中 MISTRAL (${modelName}) 進行持倉體檢 [劇本: POSITION_WATCHDOG]...`);

                const payload = {
                    model: modelName,
                    messages: [{ role: "user", content: aiConfig.parsedPrompt }],
                    response_format: { type: "json_object" },
                    temperature: 0.1
                };

                const response = await axios.post(apiUrl, payload, { 
                    headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, 
                    timeout: 15000 
                });

                const responseText = response.data.choices[0].message.content;
                const match = responseText.match(/\{[\s\S]*\}/);
                if (!match) throw new Error("AI 吐出的不是有效 JSON");

                return JSON.parse(match[0]);
            }, 'POSITION_WATCHDOG'); // 👈 傳入 promptId 讓 KeyRotator 派發 Key 3

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
            console.error(`⚠️ [Watchdog] AI 體檢超時或失敗 (${error.message})，繼續交由純 Code 追蹤回撤防守。`);
        }
    }
};

module.exports = { positionWatchdogService };