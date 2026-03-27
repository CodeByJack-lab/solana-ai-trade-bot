// src/jobs/retrospectiveJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { sendAdminAlert } = require('../services/telegramService'); 
const { healthMonitor } = require('../services/healthMonitor');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const { emailService } = require('../services/emailService'); 
const configEnv = require('../config/env'); // 👈 [V7.0] 統一使用中央配置

const retrospectiveJob = {
    async runEvolutionWithRetry(attempt = 1) {
        const MAX_ATTEMPTS = 3; 

        console.log(`\n🌞 [Evolution] 啟動 9AM/PM (HKT) 全自動自我進化程序 (第 ${attempt} 次嘗試)...`);
        healthMonitor.setStatus('AI_Evolution', `🟢 分析與修正中 (嘗試 ${attempt}/${MAX_ATTEMPTS})...`);

        try {
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            
            let { data: allTrades } = await supabase.from('trade_history_live').select('*').gte('created_at', twelveHoursAgo);
            if (!allTrades || allTrades.length === 0) {
                const { data: paperTrades } = await supabase.from('trade_history_paper').select('*').gte('created_at', twelveHoursAgo);
                allTrades = paperTrades || [];
            }

            let hasTrades = false;
            let badTrades = [];
            let bestTrades = [];

            if (allTrades.length > 0) {
                const avgPnlPct = allTrades.reduce((sum, t) => sum + (t.realized_pnl_pct || 0), 0) / allTrades.length;
                const HURDLE_RATE = 5.0; 

                if (avgPnlPct >= HURDLE_RATE) {
                    const msg = `過去 12 小時平均利潤達 +${avgPnlPct.toFixed(2)}% (已跨越 ${HURDLE_RATE}% 及格線)。🛡️ 系統處於「實質印鈔狀態」，禁止 AI 擅改參數！`;
                    console.log(`✅ [Evolution] ${msg}`);
                    
                    // 🚀 關鍵改動：唔好 return，改為建立一個「唯讀分析報告」
                    const report = {
                        analysis: `【實質印鈔戰報】\n當前系統表現極佳（Avg PNL: ${avgPnlPct.toFixed(2)}%）。根據防禦協議，Master AI 已停止對核心參數與 Prompt 進行任何實質修改。建議繼續觀察。`,
                        recommended_params: null,
                        target_prompt_id: null,
                        new_prompt_content: null,
                        prompt_feedback: "防禦機制生效，略過修改。"
                    };

                    const boardComment = "🛡️ 系統自動觸發防禦機制，提案修改已凍結";
                    
                    // 1. 寫入 DB 留紀錄
                    await supabase.from('daily_audit_reports').insert([{
                        analysis_content: report.analysis,
                        param_changes: { status: "PROTECTED", avg_pnl: avgPnlPct },
                        prompt_changes: { feedback: "SAFE_MODE", log: "印鈔中，不作改動" }
                    }]);

                    // 2. 🚀 直接寄 Email 報喜！
                    await emailService.sendEvolutionReport(report, boardComment, "無變動 (利潤達標)", "無修正 (防禦中)");

                    sendAdminAlert(`🌞 <b>[戰報模式]</b>\n${msg}\n📧 <b>戰報已寄出，請查收！</b>`);
                    healthMonitor.setStatus('AI_Evolution', '🟢 印鈔防禦中 (已寄戰報)');
                    return; // 呢度先至真正完結
                }

                badTrades = allTrades.filter(t => t.realized_pnl_pct < 0).sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct).slice(0, 3);
                bestTrades = allTrades.filter(t => t.realized_pnl_pct > 0).sort((a, b) => b.realized_pnl_pct - a.realized_pnl_pct).slice(0, 3);
                
                if (badTrades.length > 0 || bestTrades.length > 0) {
                    hasTrades = true;
                }
            }

            if (!hasTrades) {
                console.log(`ℹ️ [Evolution] 過去 12 小時無有效交易。將要求 AI 進行「空倉期」例行宏觀策略檢討...`);
            }

            const { data: lastAudit } = await supabase.from('daily_audit_reports').select('*').order('created_at', { ascending: false }).limit(1).single();
            let lastAuditText = "無歷史紀錄 (這是你第一次執行進化)。";
            
            if (lastAudit) {
                lastAuditText = `【上次你給出的敗因分析】: ${lastAudit.analysis_content}\n`;
                if (lastAudit.param_changes && lastAudit.param_changes.status === 'VETOED') {
                    lastAuditText += `\n⚠️ 【嚴重警告：上次你提出的進化提案被「獨立風控董事會」強力否決！】\n`;
                    lastAuditText += `【被否決的詳細原因】: ${JSON.stringify(lastAudit.prompt_changes)}\n`;
                    lastAuditText += `(💡 核心指令：請仔細閱讀上述否決原因！你上次的提案過於危險或充滿邏輯漏洞，本次提案絕對不能再犯同樣的錯誤！)\n`;
                } else {
                    lastAuditText += `【上次你修改的參數】: ${JSON.stringify(lastAudit.param_changes)}\n`;
                    lastAuditText += `【上次你修改的Prompt紀錄】: ${JSON.stringify(lastAudit.prompt_changes)}\n`;
                }
            }

            const hasBluechipTrade = hasTrades && [...badTrades, ...bestTrades].some(t => (t.strategy_type || '').includes('BLUECHIP'));
            const hasMemeTrade = hasTrades && [...badTrades, ...bestTrades].some(t => (t.strategy_type || '').includes('MEME'));
            const hasTrendingTrade = hasTrades && [...badTrades, ...bestTrades].some(t => (t.strategy_type || '').includes('TRENDING'));

            const { data: param1 } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
            const { data: param2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
            const { data: param3 } = await supabase.from('ai_strategy_params').select('*').eq('id', 3).single(); 
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            const { data: masterPrompt } = await supabase.from('master_auditor_prompts').select('content').eq('id', 1).single();

            const tradeDataToAI = hasTrades ? {
                "最差3單_虧損教訓": badTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type })),
                "最佳3單_成功經驗": bestTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type }))
            } : {
                "系統狀態": "過去 12 小時無任何有效交易。系統處於空倉觀望狀態。"
            };

            let promptText = masterPrompt.content
                .replace('{{last_audit_record}}', lastAuditText) 
                .replace('{{loss_trades_data}}', JSON.stringify(tradeDataToAI, null, 2))
                .replace('{{current_disaster_score}}', config?.latest_news_score || 0);
                
            promptText += `\n\n【重要系統設定說明】\n系統目前有三套獨立參數 (所有部門共用同一組欄位名，你可以自由為各部門調整)：\n`;
            promptText += `ID 1 (老幣/BLUECHIP): min_liquidity=${param1?.min_liquidity}, min_vol_5m=${param1?.min_vol_5m}, max_rsi=${param1?.max_rsi}, min_drop_pct=${param1?.min_drop_pct}, min_vol_24h=${param1?.min_vol_24h}\n`;
            promptText += `ID 2 (新幣/MEME盲狙): min_liquidity=${param2?.min_liquidity}, min_vol_5m=${param2?.min_vol_5m}, max_rsi=${param2?.max_rsi}, min_drop_pct=${param2?.min_drop_pct}, min_vol_24h=${param2?.min_vol_24h}\n`;
            promptText += `ID 3 (熱門榜/TRENDING): min_liquidity=${param3?.min_liquidity}, min_vol_5m=${param3?.min_vol_5m}, max_rsi=${param3?.max_rsi}, min_drop_pct=${param3?.min_drop_pct}, min_vol_24h=${param3?.min_vol_24h}\n`;
            promptText += `\n【資金配置說明 (參考用)】\nMeme幣單筆: ${config?.trade_amount_sol} SOL | 老幣波段單筆: ${config?.bluechip_trade_amount_sol} SOL | Top50追擊單筆: ${config?.trending_trade_amount_sol} SOL\n`;
            
            promptText += `\n【輸出要求升級】\n你的 \`recommended_params\` 必須包含 \`bluechip\`, \`meme\`, \`trending\` 三個子物件，例如：\n`;
            promptText += `"recommended_params": { "bluechip": { "min_liquidity": 20000, "max_rsi": 40 }, "meme": { "min_liquidity": 6000 }, "trending": { "min_liquidity": 40000 } }`;

            if (!hasTrades) {
                promptText += `\n\n【特別狀況指示】\n過去 12 小時系統完全沒有觸發任何交易。這可能是因為大盤災難指數過高觸發了防禦機制，或者目前的參數門檻過於嚴格。\n請簡單分析當前的宏觀大盤氣氛與現有參數設置，評估目前的「空倉策略」是否合理。你可以選擇維持現狀，或者稍微微調參數以增加出手機會。`;
            }

            const { data: currentPrompts } = await supabase.from('bot_prompts').select('*');
            if (currentPrompts) {
                let contextStr = "\n\n【當前系統使用的 AI 劇本 (僅提供有包含該策略好壞單的部門供你修改)】\n";
                if (!hasTrades || hasMemeTrade || hasTrendingTrade) {
                    const overseer = currentPrompts.find(p => p.prompt_id === 'reviewer_overseer');
                    if (overseer) contextStr += `\n目標ID: reviewer_overseer (Meme/Trending 監軍)\n內容: ${overseer.content}\n`;
                }
                if (!hasTrades || hasBluechipTrade) {
                    const bluechip = currentPrompts.find(p => p.prompt_id === 'reviewer_bluechip');
                    if (bluechip) contextStr += `\n目標ID: reviewer_bluechip (老幣監軍)\n內容: ${bluechip.content}\n`;
                }
                promptText += contextStr;
            }

            console.log(`🧠 [Evolution] 正在交由 AI Orchestrator 呼叫 Master AI (GEMINI) 撰寫進化/例行報告...`);
            // 🚀 傳入 bypassLimit: true，給足 60 秒思考時間
            let report = await aiOrchestrator.executeTask('EVOLUTION_MASTER', 'GEMINI', promptText, { bypassLimit: true });
            
            if (!report || !report.analysis) {
                throw new Error("AI Orchestrator 返回異常格式");
            }
            console.log(`✅ [Evolution] Master AI 成功產出報告！`);

            let isVetoed = false;
            let boardComment = "✅ 董事會無異議通過";

            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                console.log(`⚖️ [Board of Directors] Master AI 提出修改 ${report.target_prompt_id}，正在交由 Groq 董事會審批...`);
                
                const auditorPrompt = `你是量化基金的「獨立風控董事會」。首席 AI 剛剛針對近期的系統表現，提出了一份升級提案。
【首席 AI 的分析】: ${report.analysis}
【它企圖修改的 Prompt ID】: ${report.target_prompt_id}
【它寫出的新 Prompt 內容】: ${report.new_prompt_content}

【你的任務】審查這個新 Prompt 是否安全。
1. 如果它移除止損邏輯、鼓勵盲目重倉、或出現邏輯矛盾，請果斷回覆 VETO。
2. 如果邏輯合理、防禦性足夠、且對症下藥，請回覆 PASS。
請只回傳 JSON: {"decision": "PASS" 或 "VETO", "reason": "50字內的審查意見"}`;

                try {
                    // 🚀 董事會也算重型任務，給 45 秒
                    const boardDecision = await aiOrchestrator.executeTask('BOARD_OF_DIRECTORS', 'GROQ', auditorPrompt);
                    
                    if (boardDecision.decision === 'VETO') {
                        isVetoed = true;
                        boardComment = `❌ 董事會否決提案: ${boardDecision.reason}`;
                        console.log(`🚨 [Board of Directors] 提案被否決！原因: ${boardDecision.reason}`);
                    } else {
                        boardComment = `✅ 董事會批准: ${boardDecision.reason}`;
                        console.log(`✅ [Board of Directors] 提案獲批！`);
                    }
                } catch (boardErr) {
                    console.warn(`⚠️ [Board of Directors] 董事會審批故障 (${boardErr.message})，為保證運作預設放行。`);
                    boardComment = `✅ 董事會批准 (API 故障，預設放行)`;
                }
            }

            let paramUpdateLog = "無變動";
            if (!isVetoed && report.recommended_params) {
                let logMsg = "";
                
                const parseUpdates = (params) => {
                    const updates = {};
                    if (params.min_liquidity !== undefined) updates.min_liquidity = Math.max(1000, Math.min(Number(params.min_liquidity), 200000));
                    if (params.min_vol_5m !== undefined) updates.min_vol_5m = Math.max(500, Math.min(Number(params.min_vol_5m), 50000));
                    if (params.min_liq_fdv_ratio !== undefined) updates.min_liq_fdv_ratio = Math.max(0.01, Math.min(Number(params.min_liq_fdv_ratio), 1.0));
                    if (params.max_rsi !== undefined) updates.max_rsi = Math.max(10, Math.min(Number(params.max_rsi), 90));
                    if (params.min_drop_pct !== undefined) updates.min_drop_pct = Math.max(1, Math.min(Number(params.min_drop_pct), 50));
                    if (params.min_vol_24h !== undefined) updates.min_vol_24h = Math.max(10000, Math.min(Number(params.min_vol_24h), 5000000));
                    return updates;
                };

                const bcParams = report.recommended_params.bluechip || (report.recommended_params.min_liquidity ? report.recommended_params : null);
                if (bcParams) {
                    const bcUpdates = parseUpdates(bcParams);
                    if (Object.keys(bcUpdates).length > 0) {
                        await supabase.from('ai_strategy_params').update(bcUpdates).eq('id', 1);
                        logMsg += `🏛️ 老幣: ${JSON.stringify(bcUpdates)} `;
                    }
                }

                if (report.recommended_params.meme) {
                    const memeUpdates = parseUpdates(report.recommended_params.meme);
                    if (Object.keys(memeUpdates).length > 0) {
                        await supabase.from('ai_strategy_params').update(memeUpdates).eq('id', 2);
                        logMsg += `| 🐶 Meme: ${JSON.stringify(memeUpdates)} `;
                    }
                }

                if (report.recommended_params.trending) {
                    const trendUpdates = parseUpdates(report.recommended_params.trending);
                    if (Object.keys(trendUpdates).length > 0) {
                        await supabase.from('ai_strategy_params').update(trendUpdates).eq('id', 3);
                        logMsg += `| 🔥 Trending: ${JSON.stringify(trendUpdates)}`;
                    }
                }
                
                if (logMsg) paramUpdateLog = logMsg;
            }

            let promptUpdateLog = "無修正";
            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                if (isVetoed) {
                    promptUpdateLog = boardComment; 
                } else {
                    const { error: pErr } = await supabase.from('bot_prompts').update({ content: report.new_prompt_content, updated_at: new Date() }).eq('prompt_id', report.target_prompt_id);
                    promptUpdateLog = !pErr ? `✅ 已自動更新 ${report.target_prompt_id} (${boardComment})` : `❌ 更新失敗: ${pErr.message}`;
                }
            }

            // 🚀 確保 prompt_changes 永遠是乾淨的 JSONB Object
            const finalPromptChanges = { 
                feedback: report.prompt_feedback || "無", 
                log: promptUpdateLog 
            };

            await supabase.from('daily_audit_reports').insert([{
                analysis_content: report.analysis,
                param_changes: isVetoed ? { status: "VETOED" } : (report.recommended_params || {}),
                prompt_changes: finalPromptChanges
            }]);

            await emailService.sendEvolutionReport(report, boardComment, paramUpdateLog, promptUpdateLog);

            sendAdminAlert(`
🌞 <b>[系統全自動進化/例行檢討完成]</b>
✅ Master AI 深度分析與修正已完成！
📧 <b>詳細報告已發送至你的 Email，請查收！</b>
            `);
            
            healthMonitor.setStatus('AI_Evolution', '🟢 待命中 (9AM/9PM 執行)...');

        } catch (err) {
            console.error(`❌ [Evolution Error] 執行發生異常:`, err.message);

            if (attempt < MAX_ATTEMPTS) {
                console.log(`⏳ [Evolution] 系統將於 30 分鐘後進行第 ${attempt + 1} 次嘗試...`);
                healthMonitor.setStatus('AI_Evolution', `🟡 API 超時或異常，30分鐘後重試...`);
                
                setTimeout(() => {
                    this.runEvolutionWithRetry(attempt + 1);
                }, 30 * 60 * 1000); 

            } else {
                console.log(`💀 [Evolution] 已達到最大嘗試次數 (${MAX_ATTEMPTS})，放棄本次進化。`);
                healthMonitor.setStatus('AI_Evolution', '🔴 進化徹底失敗，等待下個排程');
            }
        }
    },

    start() {
        cron.schedule('0 0 9,21 * * *', () => { 
            this.runEvolutionWithRetry(1); 
        }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        console.log(`🤖 [Evolution] 雙軌審查進化排程已啟動 (通用參數與常規報告版)...`);
    }
};

module.exports = { retrospectiveJob };