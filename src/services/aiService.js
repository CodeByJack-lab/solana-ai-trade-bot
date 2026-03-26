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
        console.warn(`⚠️ [AI Engine] 無法從 DB 獲取 ${promptId}，將使用本地備援配置。`);
        return ""; 
    }
}

// ==========================================
// 🛡️ 監軍部門 (Reviewer) - 主副雙修 AI 分離
// ==========================================
async function reviewActivePosition(mintAddress, positionData) {
    const isBluechip = positionData.strategy_type === 'BLUECHIP_SWING';
    const promptId = isBluechip ? 'reviewer_bluechip' : 'reviewer_overseer';
    
    let holdingMinutes = 0; 
    if (positionData.created_at) {
        holdingMinutes = (Date.now() - new Date(positionData.created_at).getTime()) / 60000;
    }

    // 🚀 核心升級：穩健獲取大盤災難指數
    let currentNewsScore = 0;
    try {
        const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
        if (config && config.latest_news_score !== null) {
            currentNewsScore = config.latest_news_score;
        }
    } catch (e) {
        console.warn(`⚠️ [AI Engine] 無法獲取新聞指數，預設為 0`);
    }

    let promptText = await getDynamicPrompt(promptId, {
        token_symbol: positionData.token_symbol,
        pnl_pct: positionData.pnlPct.toFixed(2),
        ai_reason: positionData.ai_reason,
        latest_news_score: currentNewsScore
    });

    // 🚀 強化：如果 DB 斷線，使用具備大盤防禦意識的 Hardcoded 備援 Prompt
    if (!promptText && isBluechip) {
        promptText = `你是一個專業的華爾街量化分析師，負責評估「老幣波段交易 (Bluechip Swing)」倉位。
目前持倉：${positionData.token_symbol} | 盈虧：${positionData.pnlPct.toFixed(2)}% | 買入理由：${positionData.ai_reason} | 大盤災難指數：${currentNewsScore}/100
【重要指令】若大盤指數 > 60，代表市場動盪，必須採取極度保守態度；若 > 70，請果斷斬倉避險。
請分析目前的技術指標是否已經破壞，並給出 HOLD 或 EXIT 的決策。請回傳純 JSON 格式：{"decision": "HOLD" 或 "EXIT", "reason": "限50字內分析"}。`;
    } else if (!promptText && !isBluechip) {
        promptText = `你是一個專業的 AI 監軍，負責評估 Meme 幣倉位。
目前持倉：${positionData.token_symbol} | 盈虧：${positionData.pnlPct.toFixed(2)}% | 買入理由：${positionData.ai_reason} | 大盤災難指數：${currentNewsScore}/100
【重要指令】Meme 幣對大盤極度敏感。若大盤指數 > 50，代表資金正在撤退，請提高警覺；若 > 70 且處於虧損，請立刻果斷止損。
請分析社群熱度與洗盤跡象，並給出 HOLD 或 EXIT 的決策。請回傳純 JSON 格式：{"decision": "HOLD" 或 "EXIT", "reason": "限50字內分析"}。`;
    }

    const roleName = isBluechip ? "量化分析師" : "獨立監軍";
    promptText += `\n\n【重要任務】\n當初買入這隻幣的理由是：「${positionData.ai_reason}」。\n這筆交易目前已持倉 ${holdingMinutes.toFixed(1)} 分鐘。\n請你作為${roleName}，嚴格審查目前市場情況是否已經偏離這個初衷。請給出你專屬的評語，絕對不可直接照抄買入理由！`;

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
            const match = rawText.match(/\{[\s\S]*\}/);
            aiResult = JSON.parse(match ? match[0] : rawText);
            
            modelLabel = "Gemini-Lite";
            healthMonitor.setStatus('AI_Overseer', `🟡 備援運作中 (${isBluechip ? '老幣' : '新幣'})`);

        } catch (geminiErr) {
            healthMonitor.setStatus('AI_Overseer', `🔴 雙引擎全線失效: ${geminiErr.message}`);
            
            const tableName = positionData.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            await supabase
                .from(tableName)
                .update({ 
                    last_review_comment: `⚠️ AI 離線，等待 5 分鐘後重試 (${new Date().toLocaleTimeString()})`,
                })
                .eq('mint_address', mintAddress);

            return { decision: "RETRY_LATER", reason: "AI 陣列暫時離線" }; 
        }
    }

    // 🚀 【終極防彈裝甲：10分鐘免死金牌】
    if (aiResult && aiResult.decision === 'EXIT') {
        const pnl = positionData.pnlPct;
        if (holdingMinutes < 10 && pnl > -10.0) {
            console.log(`🛡️ [Overseer Override] AI 提議賣出，但持倉僅 ${holdingMinutes.toFixed(1)} 分鐘且 PNL (${pnl.toFixed(2)}%) 未跌破 -10%。強制給予時間發酵，改為 HOLD。`);
            aiResult.decision = 'HOLD';
            aiResult.reason = `[強制持有] 建倉不足 10 分鐘且未觸發 -10% 止損，給予時間發酵。AI 原評語: ${aiResult.reason}`;
        }
    }

    if (aiResult && aiResult.reason) {
        try {
            const tableName = positionData.mode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';
            const finalComment = `(${modelLabel}) ${aiResult.reason}`;

            await supabase
                .from(tableName)
                .update({ last_review_comment: finalComment })
                .eq('mint_address', mintAddress);
                
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
        // 🚀 核心升級：接回分析亦必須參考大盤分數
        let currentNewsScore = 0;
        try {
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            if (config && config.latest_news_score !== null) currentNewsScore = config.latest_news_score;
        } catch (e) {
            console.warn(`⚠️ [AI Engine] 無法獲取新聞指數，預設為 0`);
        }

        let promptText = await getDynamicPrompt('reentry_analyst', {
            token_symbol: symbol,
            baseline_price: baselinePrice,
            latest_news_score: currentNewsScore // 確保傳入分數
        });

        if (!promptText) {
            promptText = `你是橫盤吸籌分析師。\n目標：評估 ${symbol} 橫盤 30 分鐘後是否值得「吃回頭草」。\n基準價格: ${baselinePrice} SOL。\n當前大盤災難指數: ${currentNewsScore}/100。\n【指令】若大盤指數 > 50，代表市場資金正在離場，嚴禁接回橫盤死水，一律 SKIP。若大盤安全且流動性依然健康 (> $10,000)，代表莊家準備第二波，請回覆 BUY。\n請輸出嚴格 JSON: {"decision": "BUY" 或 "SKIP", "score": 整數, "reason": "限50字內"}`;
        }

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