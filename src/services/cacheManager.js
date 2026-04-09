// src/services/cacheManager.js
// 📝 檔案功能用途：V9.2.2 終極全域大腦。統一快取 AI 戰略參數、白名單與 bot_prompts 劇本。
// 🛡️ 內建防幻覺機制：當 DB 讀取失敗時，自動降級至純英文後備底稿。
// 🛠️ 包含最新加入的新聞情緒分析師 (news_sentiment_analyst) 後備底稿。
// 🚀 V9.2.6 升級：全域真·熱更新 (Realtime Hot Update)。毫秒級監聽 Prompts、防偽名單與戰略參數。

const { supabase } = require('../config/supabase');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: { 'VDOR': 'VDoRrZix72Er41foJAdKrwFqYNozPbktuPa4Xy1A7Au' },
            strategies: {
                MEME: { 
                    min_liquidity: 2500, min_vol_5m: 1000, 
                    tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, // 🚀 廢除硬止盈
                    time_stop_mins: 30, time_stop_target_pct: 15.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.02, base_slippage: 500, 
                    stop_loss_pct: -15.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 // 🚀 追蹤機制
                },
                TRENDING: { 
                    min_liquidity: 20000, min_vol_5m: 5000, 
                    tp_level_1_pct: 999.0, tp_level_2_pct: 999.0, // 🚀 廢除硬止盈
                    time_stop_mins: 1440, time_stop_target_pct: 5.0, 
                    base_jito_tip: 150000, max_buy_tip_pct: 0.01, base_slippage: 500, 
                    stop_loss_pct: -20.0, trailing_tp_trigger: 20.0, trailing_pullback: 15.0 // 🚀 追蹤機制
                }
            },
            prompts: new Map() 
        };
        this.isLoaded = false;

        // 🛡️ 核心後備底稿 (Fallback Prompts) - 確保 100% 英文輸出
        this.fallbackPrompts = {
            'news_sentiment_analyst': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'llama3-8b-8192'],
                content: `You are a top-tier Web3 market sentiment analyst. Analyze these recent crypto news titles. Determine the overall macroeconomic sentiment score from -5 (extreme fear/panic) to 5 (extreme greed/euphoria). 0 is neutral. Output ONLY pure JSON: {"score": <integer>}`
            },
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI', 
                models: ['gemini-2.5-flash', 'gemma-4-31b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust trading parameters. [Rules] Final analysis MUST be in brief English. Output JSON exactly like this: {"english_thought_process": "...", "trailing_trigger": <num>, "stop_loss": <num>, "max_tip_pct": <num>, "analysis": "<Concise English under 30 words>"}`
            },
            'POSITION_WATCHDOG': {
                provider: 'GEMINI',
                models: ['gemma-3-27b-it', 'gemini-2.5-flash-lite'],
                content: `You are an elite Crypto Watchdog. Inputs: Token: {{token_symbol}}, Pnl: {{current_profit_pct}}%, MaxPnl: {{max_profit_pct}}%, HoldTime: {{hold_time_mins}}m, Climate: {{market_climate}}. Output JSON: {"thought_process": "...", "action": "HOLD"|"SELL_HALF"|"SELL_ALL", "confidence": 0.9}`
            },
            'quant_consensus': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
                content: `You are a strict AI Auditor. Symbol: {{symbol}}, Score: {{baseScore}}. Output JSON: {"english_thought_process": "...", "confidence": <float>, "adjustment": <int>, "reason": "<Concise English under 20 words>"}`
            },
            'meme_scout': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile'],
                content: `Analyze Meme: {{token_symbol}}. Liq: {{liquidity}}. Output JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": <int>, "risk_tag": "...", "reason": "<Concise English under 20 words>"}`
            },
            'trending_scout': {
                provider: 'MISTRAL',
                models: ['mistral-large-latest'],
                content: `Analyze Trending: {{token_symbol}}. Output JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": <int>, "risk_tag": "...", "reason": "<Concise English under 20 words>"}`
            }
        };
    }

    /**
     * 🚀 初始化 RAM 快取 (保證啟動時強制抓取與驗證)
     */
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
            if (status === 'SUBSCRIBED') {
                console.log('🔗 [Cache Manager] Realtime Websocket 已成功連線，全域熱更新啟動！');
            }
        });
            
        this.isLoaded = true;
    }

    /**
     * 🔄 同步資料庫數據至 RAM (包含嚴格 Error Checking 與深度驗證)
     */
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
            console.error('\n❌ [Cache Manager Fatal Error] 無法與 Supabase 同步數據！');
            console.error('⚠️ 詳細原因:', err.message);
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
        
        if (!config) {
            return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "Prompt Error"}` };
        }
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value ?? 'N/A');
        }

        return { provider: config.provider, models: config.models?.length > 0 ? config.models : [], parsedPrompt: parsedContent };
    }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };