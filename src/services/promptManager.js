// src/services/promptManager.js
const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;
    }

    async init() {
        console.log('🧠 [Prompt Manager] 正在將所有 9 大 AI 劇本載入 RAM 緩存...');
        const { data, error } = await supabase.from('bot_prompts').select('*');
        
        if (!error && data) {
            data.forEach(p => this.cache.set(p.prompt_id, p.content));
            console.log(`✅ [Prompt Manager] 成功載入 ${data.length} 個 AI 劇本至記憶體！`);
        } else {
            console.error(`❌ [Prompt Manager] 載入劇本失敗:`, error ? error.message : 'No data');
        }

        // ⚡ 監聽 Supabase 變動，實時熱更新 RAM
        supabase.channel('bot_prompts_hot_swap')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'bot_prompts' },
                (payload) => {
                    const promptId = payload.new?.prompt_id || payload.old?.prompt_id;
                    console.log(`\n🔄 [Hot-Swap] 偵測到 AI 劇本 [${promptId}] 更新，RAM 記憶體已同步刷新！`);
                    
                    if (payload.eventType === 'DELETE') {
                        this.cache.delete(promptId);
                    } else {
                        this.cache.set(promptId, payload.new.content);
                    }
                }
            )
            .subscribe();
            
        this.isInitialized = true;
    }

    getPrompt(promptId, dataObj = {}) {
        // 如果 RAM 冇，畀個極度安全嘅 Fallback
        let content = this.cache.get(promptId) || `{"decision": "VETO", "reason": "找不到 Prompt: ${promptId}"}`;
        
        // 動態替換 {{變數}}
        for (const [key, value] of Object.entries(dataObj)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }
        return content;
    }
}

const promptManager = new PromptManager();
module.exports = { promptManager };