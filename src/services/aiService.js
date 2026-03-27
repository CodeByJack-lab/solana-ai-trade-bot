// src/services/aiService.js
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator');
const { healthMonitor } = require('./healthMonitor');

const aiService = {
    /**
     * ☁️ 從 Supabase 拉取 Prompt 並動態替換變數
     */
    async _getPromptFromDB(promptId, data) {
        try {
            const { data: promptRecord, error } = await supabase
                .from('bot_prompts')
                .select('content')
                .eq('prompt_id', promptId)
                .single();

            if (error || !promptRecord) {
                console.warn(`⚠️ [AIService] 搵唔到 Prompt: ${promptId}，使用緊急備用預設詞...`);
                return aiService._getFallbackPrompt(promptId, data);
            }

            let content = promptRecord.content;
            for (const [key, value] of Object.entries(data)) {
                // 自動將 {{token_symbol}} 等 placeholder 換成真數據
                content = content.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
            }
            return content;
        } catch (e) {
            console.error(`❌ [AIService] 獲取 Prompt 失敗: ${e.message}`);
            return this._getFallbackPrompt(promptId, data);
        }
    },

    /**
     * 👁️ 持倉巡邏 (Overseer) - 對應舊版 reviewActivePosition
     */
    async reviewActivePosition(mintAddress, posData) {
        console.log(`\n👁️‍🗨️ [Overseer] 開始巡邏持倉: ${posData.token_symbol || mintAddress.substring(0,6)}`);

        try {
            // 1. 獲取大盤災難指數 (極重要，決定 AI 斬倉容忍度)
            let currentNewsScore = 0;
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            if (config) currentNewsScore = config.latest_news_score || 0;

            // 2. 判斷使用 Meme 監軍還是老幣監軍
            const isBluechip = posData.strategy_type && posData.strategy_type.includes('BLUECHIP');
            const promptId = isBluechip ? 'reviewer_bluechip' : 'reviewer_overseer';

            // 3. 嚴格對齊 Supabase 的 Placeholders
            const promptData = {
                token_symbol: posData.token_symbol || 'UNKNOWN',
                pnl_pct: posData.pnlPct ? posData.pnlPct.toFixed(2) : '0.00',
                ai_reason: posData.ai_reason || '未知',
                latest_news_score: currentNewsScore
            };

            const promptText = await aiService._getPromptFromDB(promptId, promptData);

            // 4. 🚀 經 Orchestrator 派單，主力用 GEMINI
            const result = await aiOrchestrator.executeTask('OVERSEER', 'GEMINI', promptText);

            const cleanDecision = (result.decision || result.verdict || '').trim().toUpperCase();
            console.log(`🤖 監軍判決 (${isBluechip ? '老幣' : 'Meme'}): ${cleanDecision} | 理由: ${result.reason}`);

            // 5. 確保回傳標準化格式畀 Monitor (EXIT / HOLD)
            if (cleanDecision.includes('SELL') || cleanDecision.includes('EXIT') || cleanDecision.includes('TAKE_PROFIT')) {
                return { decision: 'EXIT', reason: result.reason };
            }
            return { decision: 'HOLD', reason: result.reason };

        } catch (error) {
            console.error(`❌ [AI Service] 持倉審查失敗:`, error.message);
            return { decision: "HOLD", reason: "AI 服務暫時無回應，防禦性持有" };
        }
    },

    /**
     * 🦅 接回機制 (Re-entry Analyst)
     */
    async analyzeReentry(mintAddress, tokenSymbol, baselinePriceSol) {
        console.log(`\n🦅 [Analyst] 評估接回潛力: ${tokenSymbol}`);

        try {
            let currentNewsScore = 0;
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            if (config) currentNewsScore = config.latest_news_score || 0;

            // 嚴格對齊 reentry_analyst 的 Placeholders
            const promptData = {
                token_symbol: tokenSymbol,
                baseline_price: baselinePriceSol,
                latest_news_score: currentNewsScore
            };

            const promptText = await aiService._getPromptFromDB('reentry_analyst', promptData);

            // 接回分析需要高智商，主將用 GROQ，後備用 GEMINI
            const result = await aiOrchestrator.executeTask('ANALYST', 'GROQ', promptText);

            const cleanDecision = (result.decision || result.verdict || '').trim().toUpperCase();
            console.log(`🤖 分析師判決: ${cleanDecision} | 理由: ${result.reason}`);

            if (cleanDecision.includes('BUY') || cleanDecision.includes('REENTRY')) {
                return { decision: 'BUY', score: result.score || 80, reason: result.reason };
            }

            return { decision: 'SKIP', reason: result.reason };

        } catch (error) {
            console.error(`❌ [AI Service] 橫盤接回分析失敗:`, error.message);
            return { decision: "SKIP", reason: "AI 服務異常，放棄接回" };
        }
    },

    /**
     * 🚨 緊急備用 Prompt
     */
    _getFallbackPrompt(promptId, data) {
        if (promptId === 'reviewer_overseer') {
            return `You are a crypto holding overseer. Token: ${data.token_symbol}, PNL: ${data.pnl_pct}%. If PNL < -12%, output {"decision": "EXIT", "reason": "Stop loss"}. Else {"decision": "HOLD", "reason": "Normal fluctuation"}.`;
        }
        if (promptId === 'reviewer_bluechip') {
            return `You are a bluechip analyst. Token: ${data.token_symbol}, PNL: ${data.pnl_pct}%. Output {"decision": "HOLD", "reason": "Fallback hold for bluechip"}.`;
        }
        if (promptId === 'reentry_analyst') {
            return `Evaluate reentry for ${data.token_symbol}. Output {"decision": "SKIP", "reason": "Fallback skip"}.`;
        }
        return `Analyze the data and return {"decision": "PASS", "reason": "Fallback mode"}.`;
    }
};

// 直接 Export 方法，確保 Monitor Destructuring 時唔會報錯
module.exports = aiService;