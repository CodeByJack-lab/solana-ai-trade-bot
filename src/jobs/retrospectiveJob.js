// src/services/promptManager.js
// 📝 檔案功能用途：AI 劇本記憶體庫。負責載入 DB 提示詞。
// 🧹 V9.3 大掃除版：已徹底刪除所有無用的 Scout/Strategist 幽靈底稿，保持極致輕量。

const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;

        // 🛡️ 核心後備底稿 (只保留現役 AI)
        this.fallbackConfigs = {
            'CLIMATE_ADVISOR': {
                provider: 'GEMINI',
                models: ['gemma-3-27b-it', 'gemma-3-12b-it'],
                content: `You are a top-tier Web3 Quant Strategist. Current climate: {{climate}}. Data: News {{newsScore}}, VolSurge {{volSurge}}%, Jito P50 {{jitoP50}}. [Task] Recommend parameter adjustments. [Rules] 1. Think in English first. 2. The final "analysis" must be in Traditional Chinese (Cantonese). Output pure JSON: {"english_thought_process": "reasoning in English", "trailing_trigger": <number>, "stop_loss": <negative number>, "max_tip_pct": <number>, "analysis": "<Cantonese explanation>"}`
            },
            'quant_consensus': {
                provider: 'GROQ',
                models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
                content: `You are a strict Quantitative AI Auditor. Evaluate asset {{symbol}}. Base Quant Score: {{baseScore}}/100. Data: Liq=\${{liquidity}}, 5m_Vol=\${{volume5m}}, OFI={{ofi}}, 1H_Change={{h1}}%. [Task] Adjust the base score. [Rules] 1. Think in English first. 2. Output reason in Cantonese (Traditional Chinese). Output pure JSON: {"english_thought_process": "reasoning", "confidence": <float 0.0-1.0>, "adjustment": <integer -20 to +20>, "reason": "<Cantonese explanation>"}`
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
            console.log(`✅ [Prompt Manager] 成功從 DB 載入 ${this.cache.size} 個 AI 劇本！(已剔除幽靈 AI)`);
        }

        // 熱更新監聽
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
                console.warn(`🚨 [Prompt Manager] 找不到劇本 [${cleanId}]！`);
                return { provider: 'UNKNOWN', models: [], parsedPrompt: `{"decision": "VETO", "reason": "找不到 Prompt: ${cleanId}"}` };
            }
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