// src/services/cacheManager.js
// 📝 檔案功能用途：V9.2 終極全域大腦。統一快取 AI 戰略參數、白名單與 bot_prompts 劇本。
// 🛡️ 內建防幻覺機制：當 DB 讀取失敗時，自動降級至純英文後備底稿。

const { supabase } = require('../config/supabase');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' },
            strategies: {
                MEME: { 
                    min_liquidity: 2500, min_vol_5m: 1000, tp_level_1_pct: 50.0, 
                    tp_level_2_pct: 100.0, time_stop_mins: 30, time_stop_target_pct: 15.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.02, base_slippage: 500, 
                    stop_loss_pct: -15.0, trailing_pullback: 20.0 
                },
                TRENDING: { 
                    min_liquidity: 20000, min_vol_5m: 5000, tp_level_1_pct: 30.0, 
                    tp_level_2_pct: 100.0, time_stop_mins: 1440, time_stop_target_pct: 5.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.01, base_slippage: 500, 
                    stop_loss_pct: -20.0, trailing_pullback: 10.0 
                }
            },
            prompts: new Map() 
        };
        this.isLoaded = false;

        // 🛡️ 核心後備底稿 (Fallback Prompts) - 確保 100% 英文輸出
        this.fallbackPrompts = {
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI', 
                models: ['gemma-3-27b-it', 'gemma-3-12b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust parameters. [Rules] Final "analysis" field MUST be in brief English. Output JSON: {"english_thought_process": "...", "tp_level_1": <num>, "stop_loss": <num>, "max_tip_pct": <num>, "analysis": "<Concise English under 30 words>"}`
            },
            'quant_consensus': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
                content: `You are a strict AI Auditor. Symbol: {{symbol}}, Score: {{baseScore}}. [Task] Adjust score. [Rules] Reason MUST be in brief English. Output JSON: {"english_thought_process": "...", "confidence": <float>, "adjustment": <int>, "reason": "<Concise English under 20 words>"}`
            },
            'meme_scout': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile'],
                content: `Analyze Meme: {{token_symbol}}. Liq: {{liquidity}}. [Rules] Reason in brief English. Output JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": <int>, "risk_tag": "...", "reason": "<Concise English under 20 words>"}`
            },
            'trending_scout': {
                provider: 'MISTRAL',
                models: ['mistral-large-latest'],
                content: `Analyze Trending: {{token_symbol}}. [Rules] Reason in brief English. Output JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": <int>, "risk_tag": "...", "reason": "<Concise English under 20 words>"}`
            }
        };
    }

    /**
     * 🚀 初始化 RAM 快取
     */
    async init() {
        console.log('🧠 [Cache Manager] 啟動中...');
        await this.refreshFromDB();
        
        setInterval(() => this.refreshFromDB(), 5 * 60 * 1000); 

        // ⚡ 監聽 bot_prompts 表格熱更新
        supabase.channel('bot_prompts_realtime')
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
                console.log(`🔄 [Cache Manager] AI 劇本 [${pId}] 已同步熱更新！`);
            }).subscribe();
            
        this.isLoaded = true;
    }

    /**
     * 🔄 同步資料庫數據至 RAM
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

            // 3. 🎯 同步 AI 劇本 (對準 bot_prompts)
            const { data: promptsData } = await supabase.from('bot_prompts').select('*');
            if (promptsData) {
                promptsData.forEach(p => {
                    this.cache.prompts.set(p.prompt_id, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content
                    });
                });
                console.log(`✅ [Cache Manager] 已從 DB 載入 ${promptsData.length} 條劇本。`);
            }
        } catch (err) {
            console.error('⚠️ [Cache Manager] 同步 DB 失敗:', err.message);
        }
    }

    getConfig(type = 'MEME') {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.cache.strategies[safeType];
    }

    getPromptConfig(promptId, dataObj = {}) {
        const config = this.cache.prompts.get(promptId) || this.fallbackPrompts[promptId];
        
        if (!config) {
            return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "Prompt Error"}` };
        }
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value ?? 'N/A');
        }

        return { 
            provider: config.provider, 
            models: config.models?.length > 0 ? config.models : [], 
            parsedPrompt: parsedContent 
        };
    }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };