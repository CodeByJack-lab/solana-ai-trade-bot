// src/services/cacheManager.js
// 📝 檔案功能用途：V9.2 終極全域大腦。統一快取 AI 戰略參數、防偽白名單、以及所有核心 AI Prompt 劇本與模型輪替陣列。

const { supabase } = require('../config/supabase');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' },
            strategies: {
                MEME: { min_liquidity: 2500, min_vol_5m: 1000, tp_level_1_pct: 50.0, tp_level_2_pct: 100.0, time_stop_mins: 30, time_stop_target_pct: 15.0, base_jito_tip: 150000, max_buy_tip_pct: 0.02, base_slippage: 500, stop_loss_pct: -15.0, trailing_pullback: 20.0 },
                TRENDING: { min_liquidity: 20000, min_vol_5m: 5000, tp_level_1_pct: 30.0, tp_level_2_pct: 100.0, time_stop_mins: 1440, time_stop_target_pct: 5.0, base_jito_tip: 150000, max_buy_tip_pct: 0.01, base_slippage: 500, stop_loss_pct: -20.0, trailing_pullback: 10.0 }
            },
            prompts: new Map() // 存放 AI 劇本
        };
        this.isLoaded = false;

        // 🛡️ Prompt 底稿保命符 (已徹底清除冗餘的 Scout/Auditor，並全線升級為英文思維鏈)
        this.fallbackPrompts = {
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI', 
                models: ['gemma-3-27b-it', 'gemma-3-12b-it', 'gemma-3-4b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Current climate: {{climate}}. Data: News {{newsScore}}, VolSurge {{volSurge}}%, Jito P50 {{jitoP50}}. [Task] Recommend parameter adjustments. [Rules] 1. Think in English first. 2. The final "analysis" must be in Traditional Chinese (Cantonese). Output pure JSON exactly: {"english_thought_process": "your step-by-step reasoning in English", "tp_level_1": <number>, "stop_loss": <negative number>, "max_tip_pct": <number>, "analysis": "<Cantonese explanation>"}`
            },
            'quant_consensus': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust score based on momentum. [Rules] 1. Think in English first. 2. Reason in Cantonese. Output pure JSON exactly: {"english_thought_process": "reasoning in English", "confidence": <float 0.0-1.0>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            },
            'reviewer_trending': {
                provider: 'MISTRAL', 
                models: ['mistral-large-latest', 'mistral-small-latest', 'open-mixtral-8x22b'],
                content: `You are a Swing Trader for Top 100 assets. Target: {{token_symbol}}. Current PnL: {{pnl_pct}}%. Memory: {{ai_memory}}. [Task] Evaluate position. [Rules] Think in English first. Output pure JSON exactly: {"english_thought_process": "reasoning", "decision": "HOLD"|"EXIT", "reason": "<Cantonese explanation>"}`
            },
            'reviewer_overseer': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a Ruthless Meme Trader. Target: {{token_symbol}}. Current PnL: {{pnl_pct}}%. Memory: {{ai_memory}}. [Task] Evaluate position. Cut losers fast. [Rules] Think in English first. Output pure JSON exactly: {"english_thought_process": "reasoning", "decision": "HOLD"|"EXIT", "reason": "<Cantonese explanation>"}`
            },
            'backtest_analyst': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are the Chief Quant Analyst. Context: {{promptContext}}. [Task] Write a concise report explaining parameter split logic. [Rules] Think in English first, output report in Cantonese. Output pure JSON exactly: {"english_thought_process": "reasoning in English", "report": "<Cantonese text>"}`
            }
        };
    }

    /**
     * 🚀 初始化：從 Supabase 讀取完整配置並寫入 RAM，同時監聽熱更新。
     */
    async init() {
        console.log('🧠 [Cache Manager] 終極大腦啟動！戰略參數、白名單與 AI 劇本已全數載入 RAM。');
        await this.refreshFromDB();
        
        // 每 5 分鐘背景靜默同步 DB
        setInterval(() => this.refreshFromDB(), 5 * 60 * 1000); 

        // ⚡ 監聽 Prompts 熱更新
        supabase.channel('bot_prompts_hot_swap')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, (payload) => {
                const pId = payload.new?.prompt_id || payload.old?.prompt_id;
                if (payload.eventType === 'DELETE') {
                    this.cache.prompts.delete(pId);
                } else {
                    const p = payload.new;
                    this.cache.prompts.set(pId, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content
                    });
                }
                console.log(`🔄 [Cache Manager] AI 劇本 [${pId}] 已熱更新！`);
            }).subscribe();
            
        this.isLoaded = true;
    }

    /**
     * 🔄 從 Supabase 拉取最新數據覆寫 RAM
     */
    async refreshFromDB() {
        try {
            // 1. 同步戰略參數
            const { data: aiParams } = await supabase.from('ai_strategy_params').select('*').in('id', [2, 3]);
            if (aiParams) {
                aiParams.forEach(row => {
                    const key = row.id === 2 ? 'MEME' : 'TRENDING';
                    this.cache.strategies[key] = { ...this.cache.strategies[key], ...row };
                });
            }

            // 2. 同步白名單
            const { data: tokensData } = await supabase.from('verified_tokens').select('token_symbol, mint_address').eq('is_active', true);
            if (tokensData) {
                const tokenDict = {};
                tokensData.forEach(row => { tokenDict[row.token_symbol] = row.mint_address; });
                this.cache.verified_tokens = tokenDict;
            }

            // 3. 同步 AI 劇本
            const { data: promptsData } = await supabase.from('bot_prompts').select('*');
            if (promptsData) {
                promptsData.forEach(p => {
                    this.cache.prompts.set(p.prompt_id, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content
                    });
                });
            }
        } catch (err) {
            console.error('⚠️ [Cache Manager] 背景同步 DB 失敗:', err.message);
        }
    }

    // --- 獲取戰略參數 ---
    getConfig(type = 'MEME') { return this.getStrategy(type); }
    
    getStrategy(type) {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.cache.strategies[safeType];
    }
    
    updateLocally(type, newConfigPayload) {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        this.cache.strategies[safeType] = { ...this.cache.strategies[safeType], ...newConfigPayload };
    }

    // --- 獲取 AI 劇本 ---
    getPromptConfig(promptId, dataObj = {}) {
        const config = this.cache.prompts.get(promptId) || this.fallbackPrompts[promptId];
        
        if (!config) {
            return { 
                provider: 'UNKNOWN', 
                models: [], 
                parsedPrompt: `{"decision": "VETO", "reason": "Missing Prompt: ${promptId}"}` 
            };
        }
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }

        return { 
            provider: config.provider, 
            models: config.models.length > 0 ? config.models : (this.fallbackPrompts[promptId]?.models || []), 
            parsedPrompt: parsedContent 
        };
    }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };