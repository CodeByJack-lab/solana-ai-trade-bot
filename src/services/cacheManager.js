// src/services/cacheManager.js
// 📝 檔案功能用途：V10 橋樑版全域大腦。不再連接 Supabase，只負責從 Redis 拉取 macro_sync_center 準備好的數據，供舊有服務同步讀取。

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: {},
            strategies: { MEME: {}, TRENDING: {} },
            prompts: new Map()
        };
        
        // 🛡️ 核心後備底稿 (防止 Redis 未準備好時冷啟動報錯)
        this.fallbackPrompts = {
            'backtest_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-2512', 'mistral-small-2603', 'open-mistral-nemo'],
                content: `You are the Chief Quant Analyst. Context: {{promptContext}}. [Task] Write a concise, professional 150-word report in simple English explaining why splitting these parameters (Trailing TP Trigger and Pullback) improves our win rate. [Rules] Output pure JSON: {"english_thought_process": "reasoning", "report": "final report in simple English"}`
            },
            'news_sentiment_analyst': {
                provider: 'MISTRAL', models: ['mistral-large-2512', 'mistral-small-2603', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 market sentiment analyst. Determine macro sentiment score from -5 (fear) to 5 (greed). Titles: {{titles}} Output exact JSON format: {"score": <integer>}`
            },
            'CLIMATE_ADVISOR': {
                provider: 'MISTRAL', models: ['mistral-large-2512', 'mistral-small-2603', 'open-mistral-nemo'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust trading parameters. Output JSON exactly like this: {"english_thought_process": "...", "trailing_trigger": <num 15 to 40>, "stop_loss": <num -25 to -10>, "max_tip_pct": <num 0.5 to 5.0>, "analysis": "<Concise English under 30 words>"}`
            },
            'master_retrospective': {
                provider: 'GEMINI', models: ['gemini-2.5-flash', 'gemma-3-27b-it', 'gemini-1.5-flash'],
                content: `You are the HEAD OF TRADING. Update prompts based on yesterday's performance. Win Rate: {{winRate}}%. Autopsy: {{autopsyReport}}. Task: Output JSON with COMPLETELY REWRITTEN prompts. Format: {"new_trending_scout_prompt": "<string>", "new_meme_scout_prompt": "<string>", "briefing_notes": "<Cantonese summary>"}`
            },
            'POSITION_WATCHDOG': {
                provider: 'MISTRAL', models: ['mistral-large-2512', 'mistral-small-2603', 'open-mistral-nemo'],
                content: `You are an elite Crypto Watchdog. Token: {{token_symbol}}, Pnl: {{current_profit_pct}}%, MaxPnl: {{max_profit_pct}}%, Climate: {{market_climate}}. Output JSON: {"thought_process": "...", "action": "HOLD"|"SELL_HALF"|"SELL_ALL", "confidence": 0.9}`
            },
            'meme_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Ruthless Meme Coin Sniper. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Task] Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            },
            'trending_scout': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a Quant Order Flow Analyst. Target: {{token_symbol}}. Climate: {{climate}}. Base Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, Vol=\${{volume}}, OFI={{ofi}}, AvgTrade=\${{avg_trade}}, 1H={{h1}}%. [Task] Output JSON exactly: {"english_thought_process": "check", "decision": "PASS"|"VETO", "score": <int 60-100>, "reason": "<Concise Cantonese explanation>"}`
            },
            'quant_consensus': {
                provider: 'GROQ', models: ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Output JSON: {"english_thought_process": "reasoning", "confidence": <float>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            }
        };
        this.isLoaded = false;
    }

    async init() {
        console.log('🧠 [Cache Manager] V10 橋樑啟動，正在與 Redis 同步神經網絡...');
        await this.refreshFromRedis();
        
        // 每 30 秒從 Redis 拉取最新數據，取代舊版 Supabase Realtime
        setInterval(() => this.refreshFromRedis(), 30000); 
        this.isLoaded = true;
    }

    async refreshFromRedis() {
        try {
            // 1. 同步 AI 劇本
            const promptsStr = await redis.get('cache:bot_prompts');
            if (promptsStr) {
                const promptsData = JSON.parse(promptsStr);
                this.cache.prompts.clear();
                for (const [id, p] of Object.entries(promptsData)) {
                    this.cache.prompts.set(id, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                        content: p.content || p.system_prompt
                    });
                }
            }

            // 2. 同步防偽名單
            const tokensStr = await redis.get('cache:verified_tokens');
            if (tokensStr) this.cache.verified_tokens = JSON.parse(tokensStr);

            // 3. 同步戰略參數
            const paramsStr = await redis.get('cache:ai_strategy_params');
            if (paramsStr) {
                const paramsData = JSON.parse(paramsStr);
                paramsData.forEach(row => {
                    const key = row.id === 2 ? 'MEME' : 'TRENDING';
                    this.cache.strategies[key] = { ...this.cache.strategies[key], ...row };
                });
            }
        } catch (err) {
            console.error('❌ [Cache Manager] 從 Redis 同步失敗:', err.message);
        }
    }

    // 👇 完美保留 V9 的同步讀取接口，舊服務無需修改任何一行 Code！
    getConfig(type = 'MEME') {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        return this.cache.strategies[safeType] || {};
    }
    
    getStrategy(type = 'MEME') { return this.getConfig(type); }
    
    getVerifiedTokens() { return this.cache.verified_tokens || {}; }

    updateLocally(type, dataObj) {
        const safeType = (type && type.includes('TRENDING')) ? 'TRENDING' : 'MEME';
        this.cache.strategies[safeType] = { ...this.cache.strategies[safeType], ...dataObj };
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
// 立即初始化，供全局使用
cacheManager.init().catch(console.error);
module.exports = { cacheManager };