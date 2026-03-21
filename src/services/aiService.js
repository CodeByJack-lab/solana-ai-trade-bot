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
// 🛡️ 監軍部門 (Reviewer) - 主副雙修 AI 分離
// ==========================================
async function reviewActivePosition(mintAddress, positionData) {
    // 💡 1. 判斷兵種，選擇對應的 Supabase Prompt ID
    const isBluechip = positionData.strategy_type === 'BLUECHIP_SWING';
    const promptId = isBluechip ? 'reviewer_bluechip' : 'reviewer_overseer';

    let promptText = await getDynamicPrompt(promptId, {
        token_symbol: positionData.token_symbol,
        pnl_pct: positionData.pnlPct.toFixed(2),
        ai_reason: positionData.ai_reason
    });

    // 💡 2. 防呆機制 (萬一 DB 未加，提供硬編碼備援)
    if (!promptText && isBluechip) {
        promptText = `你是一個專業的華爾街量化分析師，負責評估「主流幣波段交易 (Bluechip Swing)」倉位。
目前持倉：${positionData.token_symbol} | 盈虧：${positionData.pnlPct.toFixed(2)}% | 買入理由：${positionData.ai_reason}
請分析目前的技術指標是否已經破壞，並給出 HOLD 或 EXIT 的決策。請回傳純 JSON 格式：{"decision": "HOLD/EXIT", "reason": "分析"}。`;
    } else if (!promptText && !isBluechip) {
        promptText = `你是一個專業的 AI 監軍，負責評估 Meme 幣倉位。
目前持倉：${positionData.token_symbol} | 盈虧：${positionData.pnlPct.toFixed(2)}% | 買入理由：${positionData.ai_reason}
請分析社群熱度與洗盤跡象，並給出 HOLD 或 EXIT 的決策。請回傳純 JSON 格式：{"decision": "HOLD/EXIT", "reason": "分析"}。`;
    }

    // 🚀 3. 強行注入「獨立審查指令」
    const roleName = isBluechip ? "量化分析師" : "獨立監軍";
    promptText += `\n\n【重要任務】\n當初買入這隻幣的理由是：「${positionData.ai_reason}」。\n請你作為${roleName}，嚴格審查目前市場情況是否已經偏離這個初衷。請給出你專屬的評語，**絕對不可**直接照抄買入理由！`;

    let aiResult;
    let modelLabel = "";

    try {
        const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: "mistral-small-latest",
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 6000 
        });

        aiResult = JSON.parse(res.data.choices[0].message.content);
        modelLabel = "Mistral-Small";
        healthMonitor.setStatus('AI_Overseer', `🟢 正常 (${isBluechip ? '老幣' : '新幣'}分析)`);

    } catch (mistralErr) {
        console.warn(`⚠️ [Mistral Failed] 正在切換 Gemini 備援: ${mistralErr.message}`);

        try {
            const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${REENTRY_GEMINI_KEY}`, {
                contents: [{ role: "user", parts: [{ text: promptText + " (Output JSON only)" }] }],
                generationConfig: { responseMimeType: "application/json" }
            }, { timeout: 6000 });

            const rawText = geminiRes.data.candidates[0].content.parts[0].text;
            aiResult = JSON.parse(rawText);
            modelLabel = "Gemini-Lite";
            healthMonitor.setStatus('AI_Overseer', `🟡 備援運作中 (${isBluechip ? '老幣' : '新幣'})`);

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