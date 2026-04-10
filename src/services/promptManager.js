// src/services/promptManager.js
// 📝 檔案功能用途：AI 劇本記憶體庫。負責載入 DB 提示詞。
// 🛡️ V9.9 終極陣型版：完美對齊 8 大核心 AI 劇本與最新模型備援機制。

const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;

        this.strategies = {
            MEME: { 
                min_liquidity: 2500, min_vol_5m: 1000, buy_score_threshold: 70,
                tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, time_stop_mins: 30, time_stop_target_pct: 15.0, 
                base_jito_tip: 150000, max_buy_tip_pct: 0.02, base_slippage: 500, 
                stop_loss_pct: -15.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 
            },
            TRENDING: { 
                min_liquidity: 20000, min_vol_5m: 5000, buy_score_threshold: 70,
                tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, time_stop_mins: 1440, time_stop_target_pct: 5.0, 
                base_jito_tip: 150000, max_buy_tip_pct: 0.01, base_slippage: 500, 
                stop_loss_pct: -20.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 
            }
        };
        this.verified_tokens = { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' };

        // 🛡️ 核心後備底稿 (完美對齊最新 JSON 配置與防刪除規則)
        this.fallbackConfigs = {
            'backtest_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are the Chief Quant Analyst. Context: {{promptContext}}. [Task] Write a concise, professional 150-word report in simple English explaining why splitting these parameters (Trailing TP Trigger and Pullback) improves our win rate and captures fatter tails for different asset classes. (Do NOT mention Stop Loss). [Rules] 1. Think deeply in English first. 2. The final "report" MUST be in simple English. 3. Output pure JSON: {"english_thought_process": "reasoning", "report": "final report in simple English"}`
            },
            'CLIMATE_ADVISOR': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust trading parameters. [Rules] Final analysis MUST be in brief English. Output JSON exactly like this: {"english_thought_process": "...", "trailing_trigger": <num 15 to 40>, "stop_loss": <num -25 to -10>, "max_tip_pct": <num 0.5 to 5.0>, "analysis": "<Concise English under 30 words>"}`
            },
            'master_retrospective': {
                provider: 'GEMINI', models: ['gemini-2.5-flash', 'gemma-3-27b-it', 'gemini-1.5-flash'],
                content: `You are the HEAD OF TRADING. Update prompts based on yesterday's performance. Win Rate: {{winRate}}%. Autopsy: {{autopsyReport}}. Trending Scout: "{{currentTrendingScout}}". Meme Scout: "{{currentMemeScout}}". Task: Output JSON with COMPLETELY REWRITTEN prompts. 🚨 CRITICAL RULE: You MUST retain ALL placeholders (e.g., {{baseScore}}, {{ofi}}, {{liquidity}}, {{h1}}, {{avg_trade}}) in the new prompts! Do NOT delete them! Format: {"new_trending_scout_prompt": "<string>", "new_meme_scout_prompt": "<string>", "briefing_notes": "<Cantonese summary>"}`
            },
            'meme_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Ruthless Meme Coin Sniper. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Rules] 1. If OFI is 'N/A' or missing -> VETO. 2. If Liquidity < $2500 -> VETO. 3. If AvgTrade < $15 -> VETO. [Task] Think deeply. Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            },
            'news_sentiment_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 market sentiment analyst. Analyze these recent crypto news titles. Determine the overall macroeconomic sentiment score from -5 (extreme fear/panic) to 5 (extreme greed/euphoria). 0 is neutral. Ignore routine individual token news. Focus on macro events (e.g., SEC actions, ETF inflows, major hacks, macro economy). Output ONLY pure JSON. Titles: {{titles}} Output exact JSON format: {"score": <integer>}`
            },
            'POSITION_WATCHDOG': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are an elite, emotionless Cryptocurrency Quantitative Trading Watchdog. Your sole directive is to maximize realized gains while ruthlessly protecting capital. You will evaluate the current open position based on strict deterministic logic and output a single JSON response.\n\n**Inputs Provided:**\n- Token: {{token_symbol}}\n- Current_Profit_Pct: {{current_profit_pct}}\n- Max_Profit_Pct: {{max_profit_pct}}\n- Hold_Time_Mins: {{hold_time_mins}}\n- Market_Climate: {{market_climate}}\n\n**Execution Rules (No Exceptions):**\n1. ACTION: "HOLD" -> Current_Profit_Pct is less than 10% below the Max_Profit_Pct, AND Market_Climate is NOT "BEAR_PANIC".\n2. ACTION: "SELL_HALF" -> Current_Profit_Pct has retraced between 10% to 15% from the Max_Profit_Pct, OR Hold_Time_Mins > 30 with stagnant price action.\n3. ACTION: "SELL_ALL" -> Market_Climate is "BEAR_PANIC", OR extreme volume exhaustion.\n\nOutput JSON ONLY: {"thought_process": "<Max 30 words>", "action": "HOLD" | "SELL_HALF" | "SELL_ALL", "confidence": 0.9}`
            },
            'quant_consensus': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust the base score. [Rules] 1. Think in English first. 2. Output reason in Cantonese. 3. CRITICAL RULE: If OFI is 'N/A' or missing, you MUST deduct at least 15 points. You must never let the final score be >= 70 if OFI is missing. Output pure JSON: {"english_thought_process": "reasoning", "confidence": <float>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            },
            'trending_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Quant Order Flow Analyst. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Rules] 1. If OFI is 'N/A' or missing -> VETO. 2. If AvgTrade < $50 -> VETO. 3. If OFI < -0.3 -> VETO. [Task] Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            }
        };
    }

    async init() {
        console.log('🧠 [Prompt Manager] 正在向 Supabase 請求 AI 劇本與模型配置...');
        
        const { data: aiParams } = await supabase.from('ai_strategy_params').select('*').in('id', [2, 3]);
        if (aiParams && aiParams.length > 0) {
            aiParams.forEach(row => {
                const key = row.id === 2 ? 'MEME' : 'TRENDING';
                this.strategies[key] = { ...this.strategies[key], ...row };
            });
            console.log(`✅ [Cache] 戰略參數載入成功 (MEME 買入底線: ${this.strategies.MEME.buy_score_threshold || 70} 分)`);
        }

        const { data: tokensData } = await supabase.from('verified_tokens').select('token_symbol, mint_address').eq('is_active', true);
        if (tokensData) {
            const tokenDict = {};
            tokensData.forEach(row => { tokenDict[row.token_symbol] = row.mint_address; });
            this.verified_tokens = tokenDict;
        }

        const { data, error } = await supabase.from('bot_prompts').select('*');
        if (error) {
            console.error(`❌ [Prompt Manager] 讀取 Supabase 發生錯誤: ${error.message}`);
        } else if (data) {
            this.cache.clear();
            data.forEach(p => {
                const cleanId = (p.prompt_id || '').trim();
                if (cleanId) {
                    this.cache.set(cleanId, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m), 
                        content: p.content || p.system_prompt
                    });
                }
            });
        }

        supabase.channel('system_hot_swap')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, (payload) => {
                const promptId = (payload.new?.prompt_id || payload.old?.prompt_id || '').trim();
                if (!promptId) return;
                if (payload.eventType === 'DELETE') this.cache.delete(promptId);
                else {
                    const p = payload.new;
                    this.cache.set(promptId, { provider: p.provider || 'GROQ', models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m), content: p.content || p.system_prompt });
                }
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_strategy_params' }, (payload) => {
                if (payload.new && (payload.new.id === 2 || payload.new.id === 3)) {
                    const key = payload.new.id === 2 ? 'MEME' : 'TRENDING';
                    this.strategies[key] = { ...this.strategies[key], ...payload.new };
                    console.log(`🔄 [Hot-Swap] 戰略參數已熱更新！(${key} 買入底線: ${this.strategies[key].buy_score_threshold} 分)`);
                }
            }).subscribe();
            
        this.isInitialized = true;
    }

    getConfig(type = 'MEME') {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.strategies[safeType];
    }

    getStrategy(type = 'MEME') { return this.getConfig(type); }
    getVerifiedTokens() { return this.verified_tokens || {}; }

    getPromptConfig(promptId, dataObj = {}) {
        const cleanId = (promptId || '').trim();
        let config = this.cache.get(cleanId);
        
        if (!config) {
            config = this.fallbackConfigs[cleanId];
            if (!config) return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "找不到 Prompt: ${cleanId}"}` };
        }
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }

        return { provider: config.provider, models: config.models?.length > 0 ? config.models : (this.fallbackConfigs[cleanId]?.models || ['llama-3.3-70b-versatile']), parsedPrompt: parsedContent };
    }
}

const promptManager = new PromptManager();
module.exports = { promptManager, cacheManager: promptManager };