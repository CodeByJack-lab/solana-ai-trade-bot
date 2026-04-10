// src/services/cacheManager.js
// 📝 檔案功能用途：V9.2.2 終極全域大腦。統一快取 AI 戰略參數、白名單與 bot_prompts 劇本。
// 🛡️ V9.2.7 升級：完美對齊 8 大核心劇本，修復 Scout 劇本 Context 遺失問題。

const { supabase } = require('../config/supabase');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' },
            strategies: {
                MEME: { 
                    min_liquidity: 2500, min_vol_5m: 1000, buy_score_threshold: 70,
                    tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, 
                    time_stop_mins: 30, time_stop_target_pct: 15.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.02, base_slippage: 500, 
                    stop_loss_pct: -15.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 
                },
                TRENDING: { 
                    min_liquidity: 20000, min_vol_5m: 5000, buy_score_threshold: 70,
                    tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, 
                    time_stop_mins: 1440, time_stop_target_pct: 5.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.01, base_slippage: 500, 
                    stop_loss_pct: -20.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 
                }
            },
            prompts: new Map() 
        };
        this.isLoaded = false;

        // 🛡️ 核心後備底稿 (完美對齊最新 JSON 配置與防刪除規則)
        this.fallbackPrompts = {
            'backtest_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are the Chief Quant Analyst. Context: {{promptContext}}. [Task] Write a concise, professional 150-word report in simple English explaining why splitting these parameters (Trailing TP Trigger and Pullback) improves our win rate. [Rules] Output pure JSON: {"english_thought_process": "reasoning", "report": "final report in simple English"}`
            },
            'news_sentiment_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 market sentiment analyst. Determine macro sentiment score from -5 (fear) to 5 (greed). Titles: {{titles}} Output exact JSON format: {"score": <integer>}`
            },
            'CLIMATE_ADVISOR': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust trading parameters. Output JSON exactly like this: {"english_thought_process": "...", "trailing_trigger": <num 15 to 40>, "stop_loss": <num -25 to -10>, "max_tip_pct": <num 0.5 to 5.0>, "analysis": "<Concise English under 30 words>"}`
            },
            'master_retrospective': {
                provider: 'GEMINI', models: ['gemini-2.5-flash', 'gemma-3-27b-it', 'gemini-1.5-flash'],
                content: `You are the HEAD OF TRADING. Update prompts based on yesterday's performance. Win Rate: {{winRate}}%. Autopsy: {{autopsyReport}}. Trending Scout: "{{currentTrendingScout}}". Meme Scout: "{{currentMemeScout}}". Task: Output JSON with COMPLETELY REWRITTEN prompts. 🚨 CRITICAL RULE: You MUST retain ALL placeholders (e.g., {{baseScore}}, {{ofi}}, {{liquidity}}, {{h1}}, {{avg_trade}}) in the new prompts! Format: {"new_trending_scout_prompt": "<string>", "new_meme_scout_prompt": "<string>", "briefing_notes": "<Cantonese summary>"}`
            },
            'POSITION_WATCHDOG': {
                provider: 'MISTRAL', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
                content: `You are an elite Crypto Watchdog. Token: {{token_symbol}}, Pnl: {{current_profit_pct}}%, MaxPnl: {{max_profit_pct}}%, Climate: {{market_climate}}. Output JSON: {"thought_process": "...", "action": "HOLD"|"SELL_HALF"|"SELL_ALL", "confidence": 0.9}`
            },
            'meme_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Ruthless Meme Coin Sniper. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Rules] 1. If OFI is 'N/A' or missing -> VETO. 2. If Liquidity < $2500 -> VETO. 3. If AvgTrade < $15 -> VETO. [Task] Think deeply. Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            },
            'trending_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Quant Order Flow Analyst. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Rules] 1. If OFI is 'N/A' or missing -> VETO. 2. If AvgTrade < $50 -> VETO. 3. If OFI < -0.3 -> VETO. [Task] Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            },
            'quant_consensus': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust the base score. [Rules] 1. Think in English first. 2. Output reason in Cantonese. 3. CRITICAL RULE: If OFI is 'N/A' or missing, you MUST deduct at least 15 points. Output JSON: {"english_thought_process": "reasoning", "confidence": <float>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            }
        };
    }

    async init() {
        console.log('🧠 [Cache Manager] 系統大腦啟動中，準備與 Supabase 進行神經同步...');
        
        await this.refreshFromDB();
        setInterval(() => this.refreshFromDB(), 5 * 60 * 1000); 

        const systemChannel = supabase.channel('system_realtime_updates');

        systemChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, (payload) => {
            console.log(`⚡ [Hot Update] 偵測到 bot_prompts 變更！正在熱重載 AI 劇本...`);
            const pId = payload.new?.prompt_id || payload.old?.prompt_id;
            if (payload.eventType === 'DELETE') {
                this.cache.prompts.delete(pId);
            } else {
                const p = payload.new;
                this.cache.prompts.set(pId, {
                    provider: p.provider || 'GROQ',
                    models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                    content: p.content || p.system_prompt
                });
            }
        });

        systemChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'verified_tokens' }, (payload) => {
            console.log(`⚡ [Hot Update] 偵測到 verified_tokens 變更！正在熱重載防偽裝甲...`);
            this.refreshFromDB(); 
        });

        systemChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'ai_strategy_params' }, (payload) => {
            console.log(`⚡ [Hot Update] 偵測到 ai_strategy_params 變更！正在熱重載戰略參數...`);
            this.refreshFromDB(); 
        });

        systemChannel.subscribe((status) => {
            if (status === 'SUBSCRIBED') console.log('🔗 [Cache Manager] Realtime Websocket 已成功連線，全域熱更新啟動！');
        });
            
        this.isLoaded = true;
    }

    async refreshFromDB() {
        try {
            console.log('📡 [Cache Manager] 正在向 Supabase 請求最新數據...');

            const { data: aiParams, error: paramError } = await supabase.from('ai_strategy_params').select('*').in('id', [2, 3]);
            if (paramError) throw new Error(`戰略參數讀取失敗: ${paramError.message}`);
            if (aiParams && aiParams.length > 0) {
                aiParams.forEach(row => {
                    const key = row.id === 2 ? 'MEME' : 'TRENDING';
                    this.cache.strategies[key] = { ...this.cache.strategies[key], ...row };
                });
            }

            const { data: tokensData, error: tokenError } = await supabase.from('verified_tokens').select('token_symbol, mint_address').eq('is_active', true);
            if (tokenError) throw new Error(`防偽名單讀取失敗: ${tokenError.message}`);
            if (tokensData) {
                const tokenDict = {};
                tokensData.forEach(row => { tokenDict[row.token_symbol] = row.mint_address; });
                this.cache.verified_tokens = tokenDict;
            }

            const { data: promptsData, error: promptError } = await supabase.from('bot_prompts').select('*');
            if (promptError) throw new Error(`AI 劇本讀取失敗: ${promptError.message}`);
            if (promptsData) {
                this.cache.prompts.clear(); 
                promptsData.forEach(p => {
                    this.cache.prompts.set(p.prompt_id, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content || p.system_prompt
                    });
                });
            }

            this._verifyCacheState();
        } catch (err) {
            console.error('\n❌ [Cache Manager Fatal Error] 無法與 Supabase 同步數據！', err.message);
        }
    }

    _verifyCacheState() {
        const memeKeys = Object.keys(this.cache.strategies.MEME).length;
        const trendingKeys = Object.keys(this.cache.strategies.TRENDING).length;
        const tokenCount = Object.keys(this.cache.verified_tokens).length;
        const promptCount = this.cache.prompts.size;

        console.log(`\n✅ [Cache Verification] RAM 快取狀態核實完畢:`);
        console.log(`   🔸 戰略參數: MEME (${memeKeys} 參數), TRENDING (${trendingKeys} 參數)`);
        console.log(`   🔸 防偽名單: 成功防護 ${tokenCount} 個熱門/巨頭代幣名`);
        console.log(`   🔸 AI 劇本 : 成功裝載 ${promptCount} 條自訂 Prompt`);
        console.log('--------------------------------------------------\n');
    }

    getConfig(type = 'MEME') {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.cache.strategies[safeType];
    }

    getStrategy(type = 'MEME') { return this.getConfig(type); }
    getVerifiedTokens() { return this.cache.verified_tokens || {}; }

    updateLocally(type, dataObj) {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        this.cache.strategies[safeType] = { ...this.cache.strategies[safeType], ...dataObj };
        console.log(`🔄 [Cache Manager] 已熱更新 ${safeType} 的 RAM 參數。`);
    }

    getPromptConfig(promptId, dataObj = {}) {
        const config = this.cache.prompts.get(promptId) || this.fallbackPrompts[promptId];
        
        if (!config) return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "Prompt Error"}` };
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value ?? 'N/A');
        }

        return { provider: config.provider, models: config.models?.length > 0 ? config.models : [], parsedPrompt: parsedContent };
    }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };