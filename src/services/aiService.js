// src/services/aiService.js
const axios = require('axios');
const path = require('path');
const { supabase } = require('../config/supabase'); 
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
        return ""; 
    }
}

// ==========================================
// 🛡️ 監軍部門 (Reviewer) - 雙引擎備援 + 自動同步 DB
// 主力: Mistral Small (高頻抗壓) -> 失敗後自動切換: Gemini 2.0 Flash Lite
// ==========================================
async function reviewActivePosition(mintAddress, positionData) {
    const promptText = await getDynamicPrompt('reviewer_overseer', {
        token_symbol: positionData.token_symbol,
        pnl_pct: positionData.pnlPct.toFixed(2),
        ai_reason: positionData.ai_reason
    });

    if (!promptText) return { decision: "HOLD", reason: "系統維護中" };

    let aiResult;
    let modelLabel = "";

    // --- 第一層：主力 Mistral (已改為 Small 最新版以應付高頻率呼叫) ---
    try {
        const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: "mistral-small-latest", // 💡 修正：改用速度快、限額高嘅模型
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 6000 
        });

        aiResult = JSON.parse(res.data.choices[0].message.content);
        modelLabel = "Mistral-Small";
        healthMonitor.setStatus('AI_Overseer', '🟢 正常 (Mistral)');

    } catch (mistralErr) {
        console.warn(`⚠️ [Mistral Failed] 正在切換 Gemini 備援: ${mistralErr.message}`);

        // --- 第二層：備援 Gemini 2.0 Flash Lite ---
        try {
            const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${REENTRY_GEMINI_KEY}`, {
                contents: [{ role: "user", parts: [{ text: promptText + " (Output JSON only)" }] }],
                generationConfig: { responseMimeType: "application/json" }
            }, { timeout: 6000 });

            const rawText = geminiRes.data.candidates[0].content.parts[0].text;
            aiResult = JSON.parse(rawText);
            modelLabel = "Gemini-Lite";
            healthMonitor.setStatus('AI_Overseer', '🟡 備援運作中 (Gemini Lite)');

        } catch (geminiErr) {
            healthMonitor.setStatus('AI_Overseer', `🔴 雙引擎全線失效: ${geminiErr.message}`);
            return { decision: "HOLD", reason: "AI 陣列暫時離線" };
        }
    }

    // 🚀 【同步核心】將 AI 評語更新回 Supabase
    if (aiResult && aiResult.reason) {
        try {
            const tableName = positionData.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            const finalComment = `(${modelLabel}) ${aiResult.reason}`;

            await supabase
                .from(tableName)
                .update({ last_review_comment: finalComment })
                .eq('mint_address', mintAddress);
                
            console.log(`✅ [Review Sync] ${positionData.token_symbol} 評語已更新至 ${tableName}`);
        } catch (dbErr) {
            console.error(`❌ [Review Sync Failed] ${dbErr.message}`);
        }
    }

    return aiResult;
}

// ==========================================
// 🔄 橫盤接回初審 (Re-entry)
// 專屬 AI: Google gemini-2.5-pro
// ==========================================
async function analyzeReentry(mintAddress, symbol, baselinePrice) {
    try {
        const promptText = await getDynamicPrompt('reentry_analyst', {
            token_symbol: symbol,
            baseline_price: baselinePrice
        });

        if (!promptText) throw new Error("Prompt 獲取失敗");

        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${REENTRY_GEMINI_KEY}`, {
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: "application/json" }
        }, { timeout: 5000 });

        healthMonitor.setStatus('AI_Reentry', '🟢 正常 (Google Pro)');
        let rawText = res.data.candidates[0].content.parts[0].text;
        const match = rawText.match(/\{[\s\S]*\}/);
        return JSON.parse(match[0]);
    } catch (err) {
        healthMonitor.setStatus('AI_Reentry', `🔴 失效: ${err.message}`);
        return { decision: "SKIP", reason: "API異常" };
    }
}

module.exports = { reviewActivePosition, analyzeReentry };