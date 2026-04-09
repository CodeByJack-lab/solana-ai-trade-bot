// src/services/promptManager.js
// 📝 檔案功能用途：AI 劇本記憶體庫。負責載入 DB 提示詞。
// 🛡️ V9.4 終極防彈版：已對齊系統現役的「6 大核心 AI 特種部隊」，確保斷網時系統仍能全自動駕駛。

const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;

        // 🛡️ 核心後備底稿 (完美對齊 6 大現役 AI)
        this.fallbackConfigs = {
            'backtest_analyst': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are the Chief Quant Analyst. Context: {{promptContext}}. [Task] Write a concise, professional 150-word report in simple English explaining why splitting these parameters (Trailing TP Trigger and Pullback) improves our win rate and captures fatter tails for different asset classes. (Do NOT mention Stop Loss). [Rules] 1. Think deeply in English first. 2. The final "report" MUST be in simple English. 3. Output pure JSON: {"english_thought_process": "reasoning", "report": "final report in simple English"}`
            },
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI',
                models: ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemma-4-31b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Climate: {{climate}}. News: {{newsScore}}. [Task] Adjust trading parameters. [Rules] Final analysis MUST be in brief English. Output JSON exactly like this: {"english_thought_process": "...", "trailing_trigger": <num 15 to 40>, "stop_loss": <num -25 to -10>, "max_tip_pct": <num 0.5 to 5.0>, "analysis": "<Concise English under 30 words>"}`
            },
            'master_retrospective': {
                provider: 'GEMINI',
                models: ['gemini-3-flash-preview', 'gemini-2.5-flash'],
                content: `You are the HEAD OF TRADING (Prompt Engineer). Your job is to update the quantitative rules (Prompts) given to your junior AI analysts based on yesterday's performance and autopsy of top losing trades.\n\n[Yesterday's Market State & Performance]\nTotal Trades: {{totalTrades}}\nWin Rate: {{winRate}}%\nNet PnL: {{totalPnlSol}} SOL\nDisaster Score: {{newsScore}}\n\n[Losers Autopsy]\n{{autopsyReport}}\n\n[Your Memory]\n{{lastAiMemory}}\n\n[Current Gatekeeper Prompt (quant_consensus)]\n{{currentQuantConsensus}}\n\nTask: Adjust the tactical rules to prevent repeating yesterday's mistakes. Output a JSON with COMPLETELY REWRITTEN prompts:\n{\n  "briefing_notes": "<Cantonese summary explaining what data features you tightened>",\n  "new_quant_consensus_prompt": "<The complete, upgraded system prompt for quant_consensus>"\n}`
            },
            'news_sentiment_analyst': {
                provider: 'GEMINI',
                models: ['gemini-3.1-flash-lite-preview', 'gemini-2.5-flash-lite'],
                content: `You are a top-tier Web3 market sentiment analyst. Analyze these recent crypto news titles. Determine the overall macroeconomic sentiment score from -5 (extreme fear/panic) to 5 (extreme greed/euphoria). 0 is neutral. Ignore routine individual token news. Focus on macro events (e.g., SEC actions, ETF inflows, major hacks, macro economy). Output ONLY pure JSON. Titles: {{titles}} Output exact JSON format: {"score": <integer>}`
            },
            'POSITION_WATCHDOG': {
                provider: 'GEMINI',
                models: ['gemma-3-27b-it', 'gemini-2.5-flash-lite'],
                content: `You are an elite, emotionless Cryptocurrency Quantitative Trading Watchdog. Your sole directive is to maximize realized gains while ruthlessly protecting capital. You will evaluate the current open position based on strict deterministic logic and output a single JSON response.\n\n**Inputs Provided:**\n- Token: {{token_symbol}}\n- Current_Profit_Pct: {{current_profit_pct}}\n- Max_Profit_Pct: {{max_profit_pct}}\n- Hold_Time_Mins: {{hold_time_mins}}\n- Market_Climate: {{market_climate}}\n\n**Execution Rules (No Exceptions):**\n1. ACTION: "HOLD" -> Current_Profit_Pct is less than 10% below the Max_Profit_Pct, AND Market_Climate is NOT "BEAR_PANIC".\n2. ACTION: "SELL_HALF" -> Current_Profit_Pct has retraced between 10% to 15% from the Max_Profit_Pct, OR Hold_Time_Mins > 30 with stagnant price action.\n3. ACTION: "SELL_ALL" -> Market_Climate is "BEAR_PANIC", OR extreme volume exhaustion.\n\nOutput JSON ONLY: {"thought_process": "<Max 30 words>", "action": "HOLD" | "SELL_HALF" | "SELL_ALL", "confidence": 0.9}`
            },
            'quant_consensus': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust the base score. [Rules] 1. Think in English first. 2. Output reason in Cantonese. Output pure JSON: {"english_thought_process": "reasoning", "confidence": <float 0.0-1.0>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            }
        };
    }

    async init() {
        console.log('🧠 [Prompt Manager] 正在向 Supabase 請求 AI 劇本與模型配置...');
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
            console.log(`✅ [Prompt Manager] 成功從 DB 載入 ${this.cache.size} 個 AI 劇本！(已對齊 6 大核心 AI)`);
        }

        // ⚡ 熱更新監聽
        supabase.channel('bot_prompts_hot_swap')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, (payload) => {
                    const promptId = (payload.new?.prompt_id || payload.old?.prompt_id || '').trim();
                    if (!promptId) return;
                    
                    console.log(`\n🔄 [Hot-Swap] 偵測到 AI 劇本 [${promptId}] 更新，RAM 已同步！`);
                    if (payload.eventType === 'DELETE') {
                        this.cache.delete(promptId);
                    } else {
                        const p = payload.new;
                        this.cache.set(promptId, {
                            provider: p.provider || 'GROQ',
                            models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                            content: p.content || p.system_prompt
                        });
                    }
                }
            ).subscribe();
            
        this.isInitialized = true;
    }

    getPromptConfig(promptId, dataObj = {}) {
        const cleanId = (promptId || '').trim();
        let config = this.cache.get(cleanId);
        
        if (!config) {
            config = this.fallbackConfigs[cleanId];
            if (!config) {
                console.warn(`🚨 [Prompt Manager] 嚴重警告：找不到劇本 [${cleanId}]！`);
                return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "找不到 Prompt: ${cleanId}"}` };
            }
            console.log(`🛡️ [Prompt Manager] DB 讀取失敗或無資料，啟動 [${cleanId}] 的本地防彈底稿。`);
        }
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }

        return { 
            provider: config.provider, 
            models: config.models?.length > 0 ? config.models : (this.fallbackConfigs[cleanId]?.models || ['llama-3.3-70b-versatile']), 
            parsedPrompt: parsedContent 
        };
    }
}

const promptManager = new PromptManager();
module.exports = { promptManager };