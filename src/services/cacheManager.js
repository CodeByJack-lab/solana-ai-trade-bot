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
            'news_sentiment_analyst': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'llama3-8b-8192'],
                content: `You are a top-tier Web3 market sentiment analyst. Analyze these recent crypto news titles. Determine the overall macroeconomic sentiment score from -5 (extreme fear/panic) to 5 (extreme greed/euphoria). 0 is neutral. Ignore routine individual token news. Focus on macro events (e.g., SEC actions, ETF inflows, major hacks, macro economy). Output ONLY pure JSON. Titles: {{titles}} Output exact JSON format: {"score": <integer>}`
            },
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
     * 🚀 初始化 RAM 快取 (保證啟動時強制抓取與驗證)
     */
    async init() {
        console.log('🧠 [Cache Manager] 系統大腦啟動中，準備與 Supabase 進行神經同步...');
        
        // 強制等待第一次同步完成
        await this.refreshFromDB();
        
        // 每 5 分鐘自動背景同步 (兜底保險)
        setInterval(() => this.refreshFromDB(), 5 * 60 * 1000); 

        // ⚡ 終極全域熱更新監聽 (Realtime Hot Update)
        const systemChannel = supabase.channel('system_realtime_updates');

        // 1. 監聽 AI 劇本變更
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
                    content: p.content
                });
            }
        });

        // 2. 監聽防偽名單 (黑/白名單) 變更
        systemChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'verified_tokens' }, (payload) => {
            console.log(`⚡ [Hot Update] 偵測到 verified_tokens 變更！正在熱重載防偽裝甲...`);
            this.refreshFromDB(); // 觸發全域刷新以確保名單一致性
        });

        // 3. 監聽戰略參數 (止盈止損、流動性門檻等) 變更
        systemChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'ai_strategy_params' }, (payload) => {
            console.log(`⚡ [Hot Update] 偵測到 ai_strategy_params 變更！正在熱重載戰略參數...`);
            this.refreshFromDB(); // 觸發全域刷新以確保策略一致性
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

            // 1. 同步戰略參數
            const { data: aiParams, error: paramError } = await supabase.from('ai_strategy_params').select('*').in('id', [2, 3]);
            if (paramError) throw new Error(`戰略參數讀取失敗: ${paramError.message}`);
            if (aiParams && aiParams.length > 0) {
                aiParams.forEach(row => {
                    const key = row.id === 2 ? 'MEME' : 'TRENDING';
                    this.cache.strategies[key] = { ...this.cache.strategies[key], ...row };
                });
            }

            // 2. 同步黑白名單 (終極防偽盾)
            const { data: tokensData, error: tokenError } = await supabase.from('verified_tokens').select('token_symbol, mint_address').eq('is_active', true);
            if (tokenError) throw new Error(`防偽名單讀取失敗: ${tokenError.message}`);
            if (tokensData) {
                const tokenDict = {};
                tokensData.forEach(row => { tokenDict[row.token_symbol] = row.mint_address; });
                this.cache.verified_tokens = tokenDict;
            }

            // 3. 🎯 同步 AI 劇本 (對準 bot_prompts)
            const { data: promptsData, error: promptError } = await supabase.from('bot_prompts').select('*');
            if (promptError) throw new Error(`AI 劇本讀取失敗: ${promptError.message}`);
            if (promptsData) {
                // 清空舊快取，確保被刪除的 Prompt 不會殘留
                this.cache.prompts.clear(); 
                promptsData.forEach(p => {
                    this.cache.prompts.set(p.prompt_id, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content
                    });
                });
            }

            // 🔍 終極校驗：印出 RAM 快取真實狀態，證明成功 Cache 落嚟
            this._verifyCacheState();

        } catch (err) {
            console.error('\n❌ [Cache Manager Fatal Error] 無法與 Supabase 同步數據！');
            console.error('⚠️ 詳細原因:', err.message);
            console.error('⚠️ 系統將繼續使用上一次成功的 RAM 數據或本地 Fallback 底稿維持運作！\n');
        }
    }

    /**
     * 🔍 深度檢查 RAM 狀態 (證明 DB 數據真係入咗屋)
     */
    _verifyCacheState() {
        const memeKeys = Object.keys(this.cache.strategies.MEME).length;
        const trendingKeys = Object.keys(this.cache.strategies.TRENDING).length;
        const tokenCount = Object.keys(this.cache.verified_tokens).length;
        const promptCount = this.cache.prompts.size;

        console.log(`\n✅ [Cache Verification] RAM 快取狀態核實完畢:`);
        console.log(`   🔸 戰略參數: MEME (${memeKeys} 參數), TRENDING (${trendingKeys} 參數)`);
        console.log(`   🔸 防偽名單: 成功防護 ${tokenCount} 個熱門/巨頭代幣名`);
        console.log(`   🔸 AI 劇本 : 成功裝載 ${promptCount} 條自訂 Prompt`);

        if (tokenCount === 0) {
            console.warn(`   ⚠️ [警告] 防偽名單為空，請確認 Database 是否已被清空！`);
        }
        if (promptCount === 0) {
            console.warn(`   ⚠️ [警告] 未能從 DB 載入任何 AI 劇本，將全面依賴本地 Fallback 英文底稿！`);
        }
        console.log('--------------------------------------------------\n');
    }

    // 🚀 核心：讀取戰略參數 (支援新舊兩種叫法，防止其他 Service 報錯)
    getConfig(type = 'MEME') {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.cache.strategies[safeType];
    }

    // 🛠️ 補回：為咗兼容 securityGuard.js 同 trendingMonitorService.js
    getStrategy(type = 'MEME') {
        return this.getConfig(type);
    }

    // 🛠️ 補回：為咗 Gecko Crawler 嘅防偽名單可以正常運作
    getVerifiedTokens() {
        return this.cache.verified_tokens || {};
    }

    // 🛠️ 補回：為咗 Telegram Webhook 撳掣改參數嗰陣可以熱更新 RAM
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

        return { 
            provider: config.provider, 
            models: config.models?.length > 0 ? config.models : [], 
            parsedPrompt: parsedContent 
        };
    }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };
