// src/services/promptManager.js
// 📝 檔案功能用途：AI 劇本記憶體庫。負責載入 DB 提示詞與「多級後備模型輪替配置」。內建 V9.2 英文思維鏈 (Chain-of-Thought) 防崩潰底稿。
// 🛠️ V9.2.7 修正：加入深度 Debug 日誌，精準識別 DB 讀取狀態，徹底解決「大腦分裂」與「永遠讀 Code」之謎。

const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;

        // 🛡️ V9.2 內建機構級 Fallback 劇本 (全線升級為英文思維鏈 + 廣東話輸出)
        this.fallbackConfigs = {
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI',
                models: ['gemma-3-27b-it', 'gemma-3-12b-it', 'gemma-3-4b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Current climate: {{climate}}. Data: News {{newsScore}}, VolSurge {{volSurge}}%, Jito P50 {{jitoP50}}. [Task] Recommend parameter adjustments. [Rules] 1. Think in English first. 2. The final "analysis" must be in Traditional Chinese (Cantonese). Output pure JSON: {"english_thought_process": "reasoning in English", "tp_level_1": <number>, "stop_loss": <negative number>, "max_tip_pct": <number>, "analysis": "<Cantonese explanation>"}`
            },
            'quant_consensus': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust the base score. [Rules] 1. Think in English first. 2. Output reason in Cantonese. Output pure JSON: {"english_thought_process": "reasoning", "confidence": <float 0.0-1.0>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
            },
            'trending_scout': {
                provider: 'MISTRAL',
                models: ['mistral-large-latest', 'mistral-small-latest', 'open-mixtral-8x22b'],
                content: `You are a Quant Order Flow Analyst for Top 100 assets. Target: {{token_symbol}}. Data: OFI={{ofi}}, AvgTrade=\${{avg_trade}}. Rules: 1. If AvgTrade < $20 and Buys >> Sells -> Wash Trading -> VETO. 2. If OFI < -0.2 -> VETO. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "reason": "<Cantonese explanation under 30 words>"}`
            },
            'trending_strategist': {
                provider: 'MISTRAL',
                models: ['mistral-large-latest', 'mistral-small-latest', 'open-mixtral-8x22b'],
                content: `You are a Web3 Macro Strategist for Top 100. Target: {{token_symbol}}. Data: Liq=\${{liquidity}}, 5m_Vol=\${{vol_5m}}, DisasterScore={{latest_news_score}}/100. Rules: If Disaster Score > 65 -> VETO. Focus on V/L ratio. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": 85, "reason": "<Cantonese explanation>"}`
            },
            'trending_auditor': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are the Chief Risk Auditor for Top 100. Final defense for {{token_symbol}}. Review Scout and Strategist reports. If both agree, approve. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASSED"|"VETO", "reason": "<Cantonese verdict>"}`
            },
            'meme_scout': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a High-Frequency Meme Sniper. Target: {{token_symbol}}. Data: OFI={{ofi}}, AvgTrade=\${{avg_trade}}. Rules: 1. Strict Wash Trade filter: If Buys > 15 but Sells == 0 (Honeypot) -> VETO. 2. If OFI < 0 -> VETO. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "reason": "<Cantonese explanation>"}`
            },
            'meme_strategist': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are a Meme Narrative Psychologist. Target: {{token_symbol}}. Look at social links: {{social_links}} and description: {{description}}. Rules: If description is garbage -> VETO. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASS"|"VETO", "score": 80, "reason": "<Cantonese explanation>"}`
            },
            'meme_auditor': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'],
                content: `You are the Meme Risk Auditor for {{token_symbol}}. Combine Scout and Strategist data. If high potential -> PASSED. [Task] Think in English first. Output pure JSON: {"english_thought_process": "...", "decision": "PASSED"|"VETO", "reason": "<Cantonese verdict>"}`
            }
        };
    }

    async init() {
        console.log('🧠 [Prompt Manager] 正在向 Supabase 請求 AI 劇本與模型配置...');
        const { data, error } = await supabase.from('bot_prompts').select('*');
        
        if (error) {
            console.error(`❌ [Prompt Manager] 讀取 Supabase 發生錯誤: ${error.message}`);
        } else if (data && data.length === 0) {
            console.warn(`⚠️ [Prompt Manager] 讀取成功，但 bot_prompts 內無數據！(請檢查表是否為空，或是否被 RLS 權限阻擋)`);
        } else if (data) {
            this.cache.clear();
            data.forEach(p => {
                const cleanId = (p.prompt_id || '').trim();
                if (cleanId) {
                    this.cache.set(cleanId, {
                        provider: p.provider || 'GROQ',
                        models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m), 
                        content: p.content
                    });
                }
            });
            console.log(`✅ [Prompt Manager] 成功從 DB 載入 ${this.cache.size} 個 AI 劇本與模型配置！`);
        }

        // 熱更新監聽 (需確保 Supabase 後台 Replication 已開啟)
        supabase.channel('bot_prompts_hot_swap')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, (payload) => {
                    const promptId = (payload.new?.prompt_id || payload.old?.prompt_id || '').trim();
                    if (!promptId) return;
                    
                    console.log(`\n🔄 [Hot-Swap] 偵測到 AI 劇本 [${promptId}] 於 DB 更新，RAM 記憶體已同步刷新！`);
                    if (payload.eventType === 'DELETE') {
                        this.cache.delete(promptId);
                    } else {
                        const p = payload.new;
                        this.cache.set(promptId, {
                            provider: p.provider || 'GROQ',
                            models: [p.model_main, p.model_backup_1, p.model_backup_2].filter(m => m),
                            content: p.content
                        });
                    }
                }
            ).subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('🔗 [Prompt Manager] 劇本熱更新 Websocket 已成功連線！');
                }
            });
            
        this.isInitialized = true;
    }

    getPromptConfig(promptId, dataObj = {}) {
        const cleanId = (promptId || '').trim();
        let isUsingDB = true;
        
        let config = this.cache.get(cleanId);
        
        // 🛡️ 如果 DB 搵唔到 (例如斷網、串錯字、無開 RLS)，跌落 Fallback 底稿
        if (!config) {
            isUsingDB = false;
            config = this.fallbackConfigs[cleanId];
            
            if (!config) {
                console.error(`🚨 [Prompt Manager] 嚴重錯誤：完全找不到劇本 [${cleanId}]！`);
                return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "找不到 Prompt: ${cleanId}"}` };
            }
        }
        
        // 🔦 高調 Debug 照妖鏡：印出到底係用緊 DB 定 Code
        console.log(`📜 [Prompt Request] 索取劇本 [${cleanId}] -> 來源: ${isUsingDB ? '☁️ 雲端 DB (Supabase)' : '💻 本地 Code (Fallback)'}`);
        
        let parsedContent = config.content;
        for (const [key, value] of Object.entries(dataObj)) {
            parsedContent = parsedContent.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }

        return { 
            provider: config.provider, 
            models: config.models.length > 0 ? config.models : (this.fallbackConfigs[cleanId]?.models || ['llama-3.3-70b-versatile']), 
            parsedPrompt: parsedContent 
        };
    }
}

const promptManager = new PromptManager();
module.exports = { promptManager };
