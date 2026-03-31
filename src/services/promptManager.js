// src/services/promptManager.js
// 📝 檔案功能用途：AI 劇本記憶體庫。負責載入 DB 提示詞；內建 V9.0 藍籌與 Meme 防偽量化英文 Fallback 劇本，確保 DB 異常時系統不崩潰。

const { supabase } = require('../config/supabase');

class PromptManager {
    constructor() {
        this.cache = new Map();
        this.isInitialized = false;

        // 🛡️ V9.0 內建機構級 Fallback 劇本底稿 (包含 OFI 與 AvgTrade 邏輯)
        this.fallbackPrompts = {
            'trending_scout': `You are a Quant Order Flow Analyst for Top 100 assets. Target: {{token_symbol}}. Data: OFI={{ofi}}, AvgTrade=${{avg_trade}}. Rules: 1. If AvgTrade < $20 and Buys >> Sells, this is bot Wash Trading -> VETO. 2. If OFI < -0.2 (Heavy selling) -> VETO. 3. If Spread Delta {{spread_delta}}% > 5%, API is lagging -> VETO. Output JSON: {"decision": "PASS"|"VETO", "reason": "<Cantonese explanation under 30 words>"}`,
            
            'trending_strategist': `You are a Web3 Macro Strategist for Top 100 assets. Target: {{token_symbol}}. Data: Liq=${{liquidity}}, 5m_Vol=${{vol_5m}}, DisasterScore={{latest_news_score}}/100. Rules: 1. If Disaster Score > 65, VETO. 2. Focus on V/L (Volume/Liquidity) ratio. If V/L > 0.05 and narrative is solid -> PASS. 3. Assign a score (0-100). Output JSON: {"decision": "PASS"|"VETO", "score": 85, "reason": "<Cantonese explanation under 30 words>"}`,
            
            'trending_auditor': `You are the Chief Risk Auditor for Top 100 assets. Final defense for {{token_symbol}}. Review Scout and Strategist reports. If both agree and Spread Delta {{spread_delta}}% is safe, approve. Output JSON: {"decision": "PASSED"|"VETO", "reason": "<Cantonese verdict under 30 words>"}`,
            
            'meme_scout': `You are a High-Frequency Meme Sniper. Target: {{token_symbol}}. Data: OFI={{ofi}}, AvgTrade=${{avg_trade}}. Rules: 1. Strict Wash Trade filter: If Buys > 15 but Sells == 0 (Honeypot) -> VETO. 2. If OFI < 0 (Dump phase) -> VETO. Output JSON: {"decision": "PASS"|"VETO", "reason": "<Cantonese explanation under 30 words>"}`,
            
            'meme_strategist': `You are a Meme Narrative Psychologist. Target: {{token_symbol}}. Look at social links: {{social_links}} and description: {{description}}. Rules: 1. If description is garbage/empty -> VETO. 2. If narrative is viral -> PASS. Output JSON: {"decision": "PASS"|"VETO", "score": 80, "reason": "<Cantonese explanation under 30 words>"}`,
            
            'meme_auditor': `You are the Meme Risk Auditor for {{token_symbol}}. Combine Scout and Strategist data. If high potential and low risk -> PASSED. Output JSON: {"decision": "PASSED"|"VETO", "reason": "<Cantonese verdict under 30 words>"}`,
            
            'reviewer_trending': `You are a Swing Trader for Top 100 assets. Target: {{token_symbol}}. Current PnL: {{pnl_pct}}%. Memory: {{ai_memory}}. Rules: Tolerate normal volatility. If PnL crashed >15% from recent peak -> EXIT. Output JSON: {"decision": "HOLD"|"EXIT", "reason": "<Cantonese reason under 30 words>"}`,
            
            'reviewer_overseer': `You are a Ruthless Meme Trader. Target: {{token_symbol}}. Current PnL: {{pnl_pct}}%. Memory: {{ai_memory}}. Rules: Cut losers fast. If momentum exhausted -> EXIT. Output JSON: {"decision": "HOLD"|"EXIT", "reason": "<Cantonese reason under 30 words>"}`
        };
    }

    /**
     * 🚀 初始化：從 Supabase 讀取劇本並寫入 RAM，同時監聽熱更新。
     */
    async init() {
        console.log('🧠 [Prompt Manager] 正在將 AI 劇本載入 RAM 緩存...');
        const { data, error } = await supabase.from('bot_prompts').select('*');
        
        if (!error && data) {
            data.forEach(p => this.cache.set(p.prompt_id, p.content));
            console.log(`✅ [Prompt Manager] 成功從 DB 載入 ${data.length} 個 AI 劇本！`);
        } else {
            console.error(`⚠️ [Prompt Manager] 載入劇本失敗，將依賴內建 Fallback 底稿運作。`);
        }

        // ⚡ 監聽 Supabase 變動，實時熱更新 RAM
        supabase.channel('bot_prompts_hot_swap')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'bot_prompts' },
                (payload) => {
                    const promptId = payload.new?.prompt_id || payload.old?.prompt_id;
                    console.log(`\n🔄 [Hot-Swap] 偵測到 AI 劇本 [${promptId}] 更新，RAM 記憶體已同步刷新！`);
                    if (payload.eventType === 'DELETE') this.cache.delete(promptId);
                    else this.cache.set(promptId, payload.new.content);
                }
            ).subscribe();
            
        this.isInitialized = true;
    }

    /**
     * 📝 獲取劇本：注入變數，若 DB 缺失則使用內建 Fallback。
     */
    getPrompt(promptId, dataObj = {}) {
        // 優先讀取 DB 快取，若無則讀取內建 Fallback
        let content = this.cache.get(promptId) || this.fallbackPrompts[promptId];
        
        if (!content) {
            return `{"decision": "VETO", "reason": "找不到 Prompt: ${promptId}，強制攔截"}`;
        }
        
        // 動態替換 {{變數}}
        for (const [key, value] of Object.entries(dataObj)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }
        return content;
    }
}

const promptManager = new PromptManager();
module.exports = { promptManager };