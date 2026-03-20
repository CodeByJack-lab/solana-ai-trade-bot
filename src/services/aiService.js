// src/services/aiService.js
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
// 🛡️ 監軍部門 (Reviewer) - 智能持倉覆核
// 專屬 AI: Mistral (使用免費 Experiment 計劃)
// ==========================================
let lastMistralCall = 0;
const MISTRAL_COOLDOWN = 10000; // 💡 強制每次 AI 請求最少隔 10 秒

async function reviewActivePosition(mintAddress, positionData) {
    try {
        const promptText = await getDynamicPrompt('reviewer_overseer', {
            token_symbol: positionData.token_symbol,
            pnl_pct: positionData.pnlPct.toFixed(2),
            ai_reason: positionData.ai_reason
        });

        if (!promptText) throw new Error("Prompt 獲取失敗");

        // 💡 修正 1: URL 換成 Mistral 官方接口
        // 💡 修正 2: Model 換成 Mistral 的開放模型 (如 mistral-large-latest 或 pixtral-12b-2409)
        const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: "mistral-large-2411", 
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        }, {
            // 💡 修正 3: Authorization 確保對應 Mistral Key
            headers: { 
                'Authorization': `Bearer ${MISTRAL_API_KEY}`, 
                'Content-Type': 'application/json' 
            },
            timeout: 8000 // 稍微放寬 Timeout，Mistral 免費版有時會慢少少
        });

        healthMonitor.setStatus('AI_Overseer', '🟢 正常 (Mistral)');
        return JSON.parse(res.data.choices[0].message.content);
    } catch (err) {
        healthMonitor.setStatus('AI_Overseer', `🔴 失效: ${err.message}`);
        return { decision: "HOLD", reason: "AI Reviewer通訊異常，暫時觀望" };
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