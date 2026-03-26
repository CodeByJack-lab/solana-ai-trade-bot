// src/jobs/retrospectiveJob.js
const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendAdminAlert } = require('../services/telegramService'); 
const { healthMonitor } = require('../services/healthMonitor');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 🚀 核心升級：將所有 Gemini Keys 放入 Array (自動過濾空值)
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.REENTRY_GEMINI_API_KEY, 
    process.env.GEMINI_API_KEY_3 
].filter(Boolean);

let currentKeyIndex = 0; 

const GROQ_API_KEY = process.env.GROQ_API_KEY; // 董事會專用

const retrospectiveJob = {
    // 🚀 新增：帶有重試機制的主核心函數
    async runEvolutionWithRetry(attempt = 1) {
        const MAX_ATTEMPTS = 3; // 最多重試 3 次

        console.log(`\n🌞 [Evolution] 啟動 9AM/PM (HKT) 全自動自我進化程序 (第 ${attempt} 次嘗試)...`);
        healthMonitor.setStatus('AI_Evolution', `🟢 分析與修正中 (嘗試 ${attempt}/${MAX_ATTEMPTS})...`);

        try {
            if (GEMINI_KEYS.length === 0) throw new Error("系統找不到任何有效的 GEMINI_API_KEY");

            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            
            let { data: allTrades } = await supabase.from('trade_history_live').select('*').gte('created_at', twelveHoursAgo);
            if (!allTrades || allTrades.length === 0) {
                const { data: paperTrades } = await supabase.from('trade_history_paper').select('*').gte('created_at', twelveHoursAgo);
                allTrades = paperTrades;
            }

            if (!allTrades || allTrades.length === 0) {
                console.log(`✅ [Evolution] 過去 12 小時無交易，維持現狀。`);
                healthMonitor.setStatus('AI_Evolution', '🟢 待命中 (9AM/9PM 執行)...');
                return; // 正常結束，不需要 retry
            }

            const avgPnlPct = allTrades.reduce((sum, t) => sum + (t.realized_pnl_pct || 0), 0) / allTrades.length;
            const HURDLE_RATE = 5.0; 

            if (avgPnlPct >= HURDLE_RATE) {
                const msg = `過去 12 小時平均利潤達 +${avgPnlPct.toFixed(2)}% (已跨越 ${HURDLE_RATE}% 及格線)。\n🛡️ 系統處於「實質印鈔狀態」，禁止 AI 擅改參數！`;
                console.log(`✅ [Evolution] ${msg}`);
                healthMonitor.setStatus('AI_Evolution', '🟢 利潤達標，休眠中');
                sendAdminAlert(`🌞 <b>[進化防禦機制觸發]</b>\n${msg}`);
                return; // 正常結束，不需要 retry
            }

            // ==========================================
            // 🚀 核心升級：同時篩選出「最差 3 單」與「最佳 3 單」
            // ==========================================
            const badTrades = allTrades.filter(t => t.realized_pnl_pct < 0).sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct).slice(0, 3);
            const bestTrades = allTrades.filter(t => t.realized_pnl_pct > 0).sort((a, b) => b.realized_pnl_pct - a.realized_pnl_pct).slice(0, 3);
            
            if (badTrades.length === 0 && bestTrades.length === 0) {
                console.log(`✅ [Evolution] 過去 12 小時無有效虧損或獲利單，維持現狀。`);
                healthMonitor.setStatus('AI_Evolution', '🟢 待命中 (9AM/9PM 執行)...');
                return; 
            }

            const { data: lastAudit } = await supabase.from('daily_audit_reports').select('*').order('created_at', { ascending: false }).limit(1).single();
            let lastAuditText = "無歷史紀錄 (這是你第一次執行進化)。";
            
            if (lastAudit) {
                lastAuditText = `【上次你給出的敗因分析】: ${lastAudit.analysis_content}\n`;
                if (lastAudit.param_changes && lastAudit.param_changes.status === 'VETOED') {
                    lastAuditText += `\n⚠️ 【嚴重警告：上次你提出的進化提案被「獨立風控董事會」強力否決！】\n`;
                    lastAuditText += `【被否決的詳細原因】: ${lastAudit.prompt_changes}\n`;
                    lastAuditText += `(💡 核心指令：請仔細閱讀上述否決原因！你上次的提案過於危險或充滿邏輯漏洞，本次提案絕對不能再犯同樣的錯誤！)\n`;
                } else {
                    lastAuditText += `【上次你修改的參數】: ${JSON.stringify(lastAudit.param_changes)}\n`;
                    lastAuditText += `【上次你修改的Prompt紀錄】: ${JSON.stringify(lastAudit.prompt_changes)}\n`;
                }
            }

            const hasBluechipTrade = [...badTrades, ...bestTrades].some(t => (t.strategy_type || '').includes('BLUECHIP'));
            const hasMemeTrade = [...badTrades, ...bestTrades].some(t => !(t.strategy_type || '').includes('BLUECHIP'));

            const { data: param1 } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
            const { data: param2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            const { data: masterPrompt } = await supabase.from('master_auditor_prompts').select('content').eq('id', 1).single();

            // 🚀 核心升級：組合最佳與最差戰報
            const tradeDataToAI = {
                "最差3單_虧損教訓": badTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type })),
                "最佳3單_成功經驗": bestTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type }))
            };

            let promptText = masterPrompt.content
                .replace('{{last_audit_record}}', lastAuditText) 
                .replace('{{loss_trades_data}}', JSON.stringify(tradeDataToAI, null, 2))
                .replace('{{current_disaster_score}}', config?.latest_news_score || 0);
                
            promptText += `\n\n【重要系統設定說明】\n系統目前有兩套獨立參數：\n`;
            promptText += `ID 1 (老幣專用): min_liquidity=${param1?.min_liquidity}, min_vol_5m=${param1?.min_vol_5m}, bluechip_max_rsi=${param1?.bluechip_max_rsi}, bluechip_min_drop_pct=${param1?.bluechip_min_drop_pct}\n`;
            promptText += `ID 2 (Meme專用): min_liquidity=${param2?.min_liquidity}, min_vol_5m=${param2?.min_vol_5m}\n`;
            promptText += `\n【輸出要求升級】\n你的 \`recommended_params\` 必須包含 \`bluechip\` 和 \`meme\` 兩個子物件，例如：\n`;
            promptText += `"recommended_params": { "bluechip": { "min_liquidity": 20000, "bluechip_max_rsi": 40 }, "meme": { "min_liquidity": 6000 } }`;

            const { data: currentPrompts } = await supabase.from('bot_prompts').select('*');
            if (currentPrompts) {
                let contextStr = "\n\n【當前系統使用的 AI 劇本 (僅提供有包含該策略好壞單的部門供你修改)】\n";
                if (hasMemeTrade) {
                    const overseer = currentPrompts.find(p => p.prompt_id === 'reviewer_overseer');
                    if (overseer) contextStr += `\n目標ID: reviewer_overseer (Meme 幣監軍)\n內容: ${overseer.content}\n`;
                }
                if (hasBluechipTrade) {
                    const bluechip = currentPrompts.find(p => p.prompt_id === 'reviewer_bluechip');
                    if (bluechip) contextStr += `\n目標ID: reviewer_bluechip (老幣監軍)\n內容: ${bluechip.content}\n`;
                }
                promptText += contextStr;
            }

            let report = null;
            let rawText = "";

            for (let i = 0; i < GEMINI_KEYS.length; i++) {
                const activeKey = GEMINI_KEYS[currentKeyIndex % GEMINI_KEYS.length];
                const keyNumber = (currentKeyIndex % GEMINI_KEYS.length) + 1;
                currentKeyIndex++; 

                try {
                    console.log(`🧠 [Evolution] 正在呼叫 Master AI (Gemini Pro) 撰寫進化提案 (使用 Key #${keyNumber})...`);
                    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${activeKey}`, {
                        contents: [{ role: "user", parts: [{ text: promptText }] }],
                        generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
                    }, { 
                        timeout: 300000 // 🚀 關鍵優化：強制延長到 5 分鐘，給予 Gemini 充分的思考時間
                    });

                    rawText = res.data.candidates[0].content.parts[0].text;
                    report = JSON.parse(rawText.match(/\{[\s\S]*\}/)[0]);
                    
                    console.log(`✅ [Evolution] Key #${keyNumber} 成功產出報告！`);
                    break; // 成功就跳出輪替 Loop

                } catch (apiErr) {
                    // 🚀 關鍵修正：無論是 Timeout 還是 429，都只會 Warn，然後繼續嘗試下一條 Key
                    console.warn(`⚠️ [Evolution] Key #${keyNumber} 失敗 (${apiErr.response?.status || apiErr.message})，自動切換下一條...`);
                }
            }

            // 如果所有 Key 都失敗了，就會觸發 Error，進入外層的 Retry 機制
            if (!report) {
                throw new Error("所有 Gemini API Keys 均發生異常或超時，無法產出報告！");
            }

            // ==========================================
            // ⚖️ 第三方董事會審查 (Groq 8B 降級防爆 Limit)
            // ==========================================
            let isVetoed = false;
            let boardComment = "✅ 董事會無異議通過";

            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                console.log(`⚖️ [Board of Directors] Master AI 提出修改 ${report.target_prompt_id}，正在交由 Groq 董事會審批...`);
                
                const auditorPrompt = `你是量化基金的「獨立風控董事會」。首席 AI 剛剛針對近期的虧損與獲利，提出了一份系統升級提案。
【首席 AI 的敗因分析】: ${report.analysis}
【它企圖修改的 Prompt ID】: ${report.target_prompt_id}
【它寫出的新 Prompt 內容】: ${report.new_prompt_content}

【你的任務】審查這個新 Prompt 是否安全。
1. 如果它移 holistic 除止損邏輯、鼓勵盲目重倉、或出現邏輯矛盾，請果斷回覆 VETO。
2. 如果邏輯合理、防禦性足夠、且對症下藥，請回覆 PASS。
請只回傳 JSON: {"decision": "PASS" 或 "VETO", "reason": "50字內的審查意見"}`;

                try {
                    const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model: "llama-3.1-8b-instant", 
                        messages: [{ role: "user", content: auditorPrompt }],
                        response_format: { type: "json_object" },
                        temperature: 0.1
                    }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 });

                    const boardDecision = JSON.parse(groqRes.data.choices[0].message.content);
                    if (boardDecision.decision === 'VETO') {
                        isVetoed = true;
                        boardComment = `❌ 董事會否決提案: ${boardDecision.reason}`;
                        console.log(`🚨 [Board of Directors] 提案被否決！原因: ${boardDecision.reason}`);
                    } else {
                        boardComment = `✅ 董事會批准: ${boardDecision.reason}`;
                        console.log(`✅ [Board of Directors] 提案獲批！`);
                    }
                } catch (boardErr) {
                    console.warn(`⚠️ [Board of Directors] 董事會 API 故障 (${boardErr.message})，為保證運作預設放行。`);
                    boardComment = `✅ 董事會批准 (API 故障，預設放行)`;
                }
            }

            // ==========================================
            // 寫入資料庫
            // ==========================================
            let paramUpdateLog = "無變動";
            if (!isVetoed && report.recommended_params) {
                let logMsg = "";
                
                const bluechipParams = report.recommended_params.bluechip || report.recommended_params; 
                const bcUpdates = {};
                if (bluechipParams.min_liquidity !== undefined) bcUpdates.min_liquidity = Math.max(10000, Math.min(Number(bluechipParams.min_liquidity), 100000));
                if (bluechipParams.min_vol_5m !== undefined) bcUpdates.min_vol_5m = Math.max(1000, Math.min(Number(bluechipParams.min_vol_5m), 20000));
                if (bluechipParams.bluechip_max_rsi !== undefined) bcUpdates.bluechip_max_rsi = Math.max(20, Math.min(Number(bluechipParams.bluechip_max_rsi), 50));
                if (bluechipParams.bluechip_min_drop_pct !== undefined) bcUpdates.bluechip_min_drop_pct = Math.max(1, Math.min(Number(bluechipParams.bluechip_min_drop_pct), 10));
                
                if (Object.keys(bcUpdates).length > 0) {
                    await supabase.from('ai_strategy_params').update(bcUpdates).eq('id', 1);
                    logMsg += `🏛️ 老幣: ${JSON.stringify(bcUpdates)} `;
                }

                if (report.recommended_params.meme) {
                    const memeParams = report.recommended_params.meme;
                    const memeUpdates = {};
                    if (memeParams.min_liquidity !== undefined) memeUpdates.min_liquidity = Math.max(3000, Math.min(Number(memeParams.min_liquidity), 20000));
                    if (memeParams.min_vol_5m !== undefined) memeUpdates.min_vol_5m = Math.max(500, Math.min(Number(memeParams.min_vol_5m), 10000));
                    
                    if (Object.keys(memeUpdates).length > 0) {
                        await supabase.from('ai_strategy_params').update(memeUpdates).eq('id', 2);
                        logMsg += `| 🐶 Meme: ${JSON.stringify(memeUpdates)}`;
                    }
                }
                
                if (logMsg) paramUpdateLog = logMsg;
            }

            let promptUpdateLog = "無修正";
            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                if (isVetoed) {
                    promptUpdateLog = boardComment; 
                } else {
                    const isIllegalUpdate = (report.target_prompt_id === 'reviewer_bluechip' && !hasBluechipTrade);
                    if (isIllegalUpdate) {
                        promptUpdateLog = `❌ 系統攔截：老幣部門無交易紀錄，拒絕 Master AI 跨界修改 reviewer_bluechip！`;
                    } else {
                        const { error: pErr } = await supabase.from('bot_prompts').update({ content: report.new_prompt_content, updated_at: new Date() }).eq('prompt_id', report.target_prompt_id);
                        promptUpdateLog = !pErr ? `✅ 已自動更新 ${report.target_prompt_id} (${boardComment})` : `❌ 更新失敗: ${pErr.message}`;
                    }
                }
            }

            await supabase.from('daily_audit_reports').insert([{
                analysis_content: report.analysis,
                param_changes: isVetoed ? { status: "VETOED" } : report.recommended_params,
                prompt_changes: report.prompt_feedback + " | " + promptUpdateLog
            }]);

            sendAdminAlert(`
🌞 <b>[系統全自動進化完成]</b>
📊 <b>分析總結</b>: ${report.analysis}
⚖️ <b>董事會決議</b>: ${boardComment}
⚙️ <b>門檻修正</b>: ${paramUpdateLog}
📝 <b>AI劇本進化</b>: ${promptUpdateLog}
            `);
            
            healthMonitor.setStatus('AI_Evolution', '🟢 待命中 (9AM/9PM 執行)...');

        } catch (err) {
            console.error(`❌ [Evolution Error] 執行發生異常:`, err.message);

            // 🚀 關鍵優化：30 分鐘優雅延遲重試機制
            if (attempt < MAX_ATTEMPTS) {
                console.log(`⏳ [Evolution] 系統將於 30 分鐘後進行第 ${attempt + 1} 次嘗試...`);
                healthMonitor.setStatus('AI_Evolution', `🟡 API 超時或異常，30分鐘後重試...`);
                
                setTimeout(() => {
                    this.runEvolutionWithRetry(attempt + 1);
                }, 30 * 60 * 1000); // 30 分鐘後再次呼叫自己

            } else {
                console.log(`💀 [Evolution] 已達到最大嘗試次數 (${MAX_ATTEMPTS})，放棄本次進化。`);
                healthMonitor.setStatus('AI_Evolution', '🔴 進化徹底失敗，等待下個排程');
            }
        }
    },

    start() {
        // 🚀 修改：Cron Job 觸發時呼叫帶有 Retry 機制的函數
        cron.schedule('0 0 9,21 * * *', () => { 
            this.runEvolutionWithRetry(1); 
        }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        console.log(`🤖 [Evolution] 雙軌審查進化排程已啟動 (自動輪替多條 Gemini API Key)...`);
    }
};

module.exports = { retrospectiveJob };