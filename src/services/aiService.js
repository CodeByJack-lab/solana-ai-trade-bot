// backend/services/aiService.js
const axios = require('axios');
const path = require('path');
const { supabase } = require('../config/supabase'); // 🗄️ 引入 Supabase
const { healthMonitor } = require('./healthMonitor');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const REENTRY_GEMINI_KEY = process.env.REENTRY_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

// ==========================================
// 🧠 動態 Prompt 獲取與注入工具
// ==========================================
async function getDynamicPrompt(promptId, data) {
    try {
        const { data: promptData, error } = await supabase.from('bot_prompts').select('content').eq('prompt_id', promptId).single();
        if (error || !promptData) throw new Error("Prompt not found");
        
        let content = promptData.content;
        for (const [key, value] of Object.entries(data)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value !== undefined && value !== null ? value : 'UNKNOWN');
        }
        return content;
    } catch (err) {
        console.warn(`⚠️ [AI Engine] 無法從 DB 獲取 ${promptId}，請檢查 Supabase。`);
        return ""; // 若連線失敗，回傳空字串防止 Crash
    }
}

// ==========================================
// 🛡️ 監軍部門 (Reviewer) - 智能持倉覆核 (極速逃生)
// 專屬 AI: Cerebras gpt-oss-120b
// ==========================================
async function reviewActivePosition(mintAddress, positionData) {
    try {
        // 1. 動態從 Supabase 獲取 Prompt
        const promptText = await getDynamicPrompt('reviewer_overseer', {
            token_symbol: positionData.token_symbol,
            pnl_pct: positionData.pnlPct.toFixed(2),
            ai_reason: positionData.ai_reason
        });

        if (!promptText) throw new Error("Prompt 獲取失敗");

        // 2. 呼叫 Cerebras
        const res = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
            model: "gpt-oss-120b",
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 5000
        });

        healthMonitor.setStatus('AI_Overseer', '🟢 正常 (Cerebras)');
        return JSON.parse(res.data.choices[0].message.content);
    } catch (err) {
        healthMonitor.setStatus('AI_Overseer', `🔴 失效: ${err.message}`);
        return { decision: "HOLD", reason: "監軍通訊異常，暫時觀望" };
    }
}

// ==========================================
// 🔄 橫盤接回初審 (Re-entry)
// 專屬 AI: Google gemini-2.0-flash (Unlimited Rate)
// ==========================================
async function analyzeReentry(mintAddress, symbol, baselinePrice) {
    try {
        // 1. 動態從 Supabase 獲取 Prompt
        const promptText = await getDynamicPrompt('reentry_analyst', {
            token_symbol: symbol,
            baseline_price: baselinePrice
        });

        if (!promptText) throw new Error("Prompt 獲取失敗");

        // 2. 呼叫 Google Gemini
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${REENTRY_GEMINI_KEY}`, {
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: "application/json" }
        }, { timeout: 5000 });

        healthMonitor.setStatus('AI_Reentry', '🟢 正常 (Google)');
        let rawText = res.data.candidates[0].content.parts[0].text;
        const match = rawText.match(/\{[\s\S]*\}/);
        return JSON.parse(match[0]);
    } catch (err) {
        healthMonitor.setStatus('AI_Reentry', `🔴 失效: ${err.message}`);
        return { decision: "SKIP", reason: "API異常" };
    }
}

module.exports = { reviewActivePosition, analyzeReentry };