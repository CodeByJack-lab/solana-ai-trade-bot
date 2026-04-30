// src/services/cacheManager.js
// 📝 檔案功能用途：V10 橋樑版全域大腦。不再連接 Supabase，只負責從 Redis 拉取 macro_sync_center 準備好的數據，供舊有服務同步讀取。
// 🚀 核心更新：清理所有 V9 廢棄劇本與 POSITION_WATCHDOG，完美對齊 Supabase 數據庫的最新 Prompt 與三重降級 Model。
const redis = require('../config/redis');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');

class CacheManager {
    constructor() {
        this.cache = {
            verified_tokens: {},
            strategies: { MEME: {}, TRENDING: {} },
            prompts: new Map()
        };
        
        // 🛡️ 核心後備底稿 (防止 Redis 未準備好時冷啟動報錯，已與 DB 最新版本完美對齊)
        this.fallbackPrompts = {
            'master_retrospective': {
                provider: 'GEMINI', 
                models: ['gemini-2.5-flash', 'gemma-3-27b-it', 'gemini-1.5-flash'],
                content: `You are the HEAD OF TRADING. Update narrative prompts based on yesterday's performance. Win Rate: {{winRate}}%. Autopsy: {{autopsyReport}}. Trending Scout: "{{currentTrendingScout}}". Meme Scout: "{{currentMemeScout}}". Task: Output JSON with COMPLETELY REWRITTEN prompts. 🚨 CRITICAL RULE: You MUST instruct the scouts to output JSON containing exactly "narrative_score" (-5 to +10) and "reason". Give 0 for uncertain/no info, and -5 for obvious scams/blank tokens. Do NOT ask them to output PASS/VETO. You MUST retain ALL placeholders (e.g., {{token_symbol}}, {{name}}) in the new prompts! Format: {"new_trending_scout_prompt": "<string>", "new_meme_scout_prompt": "<string>", "briefing_notes": "<Cantonese summary>"}`
            },
            'meme_scout': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
                content: `You are an elite Crypto Narrative Analyst. Your *only* mandate is to thoroughly assess the narrative and 'cult' potential of the given token. Analyze: Symbol: {{token_symbol}} Name: {{name}}. You *must* deliver your analysis in this precise JSON format: {"narrative_score": <integer from -5 to +10>, "reason": "<Concise English explanation>"}. Adhere to this scoring criteria: +8 to +10 for top-tier, original, and highly engaging meme narratives. +1 to +7 for a good, standard meme with decent community engagement. 0 for generic, uninspired, or insufficient community information, indicating a neutral or undefined narrative. -1 to -4 for low-effort, derivative copycat memes. -5 for blatant fakes, scams, or tokens that are completely blank/nameless and highly suspicious.`
            },
            'trending_scout': {
                provider: 'GROQ', 
                models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
                content: `As an institutional Web3 Trend Analyst, your sole duty is to assess the long-term narrative sustainability of the token provided. Evaluate: Symbol: {{token_symbol}} Name: {{name}}. Your output MUST be EXACTLY this JSON format: {"narrative_score": <integer from -5 to +10>, "reason": "<Concise English explanation>"}. Use the following scoring guide: +8 to +10 for a proven, strong, and enduring narrative. +1 to +7 for a solid, established token with a clear but not exceptional narrative. 0 for neutral, boring, or insufficient information to make a clear judgment. -1 to -4 for a fading or weakening narrative. -5 for an obvious scam, a completely blank token, or highly suspicious activity.`
            },
            'news_sentiment_analyst': {
                provider: 'MISTRAL', 
                models: ['mistral-small-2603', 'ministral-8b-2512', 'open-mistral-nemo'],
                content: `You are the Chief Macro Economist for a Solana High-Frequency Trading bot.\n\n[Hard Data]\n- BTC 24h Change: {{btc_change}}% (Vol: $\\{{btc_vol}}B)\n- SOL 24h Change: {{sol_change}}% (Vol: $\\{{sol_vol}}B)\n- Network Congestion (Jito Tip): {{jito_tip}} lamports\n- Bot Internal Win Rate (24h): {{winRate}}%\n\n[Latest Breaking News]\n{{titles}}\n\n[Task]\nBased on the data AND news context, is this a healthy correction, a normal chop, a raging bull, or a black swan?\nDecide the Climate: [BULL_FRENZY, CHOPPY, BEAR_PANIC]\nDetermine the News Sentiment Score: -5 (Extreme Fear) to 5 (Extreme Greed).\nOutput exact JSON format: {"climate": "CHOPPY", "news_score": 0, "reasoning": "<short cantonese explanation>"}`
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