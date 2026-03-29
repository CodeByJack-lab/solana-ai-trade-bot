// src/jobs/retrospectiveJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { sendAdminAlert } = require('../services/telegramService'); 
const { healthMonitor } = require('../services/healthMonitor');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const { emailService } = require('../services/emailService'); 
const configEnv = require('../config/env');
const { promptManager } = require('../services/promptManager'); 

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
                    
                    const report = {
                        analysis: `【實質印鈔戰報】\n當前系統表現極佳（Avg PNL: ${avgPnlPct.toFixed(2)}%）。根據防禦協議，Master AI 已停止對核心參數與 Prompt 進行任何實質修改。建議繼續觀察。`,
                        recommended_params: null,
                        target_prompt_id: null,
                        new_prompt_content: null,
                        prompt_feedback: "防禦機制生效，略過修改。"
                    };

                    const boardComment = "🛡️ 系統自動觸發防禦機制，提案修改已凍結";
                    
                    await supabase.from('daily_audit_reports').insert([{
                        analysis_content: report.analysis,
                        param_changes: { status: "PROTECTED", avg_pnl: avgPnlPct },
                        prompt_changes: { feedback: "SAFE_MODE", log: "印鈔中，不作改動" }
                    }]);

                    await emailService.sendEvolutionReport(report, boardComment, "無變動 (利潤達標)", "無修正 (防禦中)");

                    sendAdminAlert(`🌞 <b>[戰報模式]</b>\n${msg}\n📧 <b>戰報已寄出，請查收！</b>`);
                    healthMonitor.setStatus('AI_Evolution', '🟢 印鈔防禦中 (已寄戰報)');
                    return; 
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
            let lastAuditText = "No historical records (First execution).";
            
            if (lastAudit) {
                lastAuditText = `[Your Previous Analysis]: ${lastAudit.analysis_content}\n`;
                if (lastAudit.param_changes && lastAudit.param_changes.status === 'VETOED') {
                    lastAuditText += `\n⚠️ [CRITICAL WARNING: Your last proposal was firmly VETOED by the Independent Risk Board!]\n`;
                    lastAuditText += `[Detailed Rejection Reasons]: ${JSON.stringify(lastAudit.prompt_changes)}\n`;
                    lastAuditText += `(💡 Core Directive: Read the rejection reasons carefully! Do NOT repeat the same logical flaws or dangerous parameters in this proposal!)\n`;
                } else {
                    lastAuditText += `[Your Previous Parameter Tweaks]: ${JSON.stringify(lastAudit.param_changes)}\n`;
                    lastAuditText += `[Your Previous Prompt Tweaks]: ${JSON.stringify(lastAudit.prompt_changes)}\n`;
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

            // 🚀 英文 Key 替換，迎合 Master AI 英文大腦
            const tradeDataToAI = hasTrades ? {
                "worst_3_trades_lessons": badTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type })),
                "best_3_trades_successes": bestTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type }))
            } : {
                "system_status": "No valid trades in the past 12 hours. System is currently holding cash and observing."
            };

            let promptText = masterPrompt.content
                .replace('{{last_audit_record}}', lastAuditText) 
                .replace('{{loss_trades_data}}', JSON.stringify(tradeDataToAI, null, 2))
                .replace('{{current_disaster_score}}', config?.latest_news_score || 0);
                
            promptText += `\n\n[Crucial System Configuration Context]\nThe system operates with 3 independent parameter sets (all share the same column names, adjust independently):\n`;
            promptText += `ID 1 (BLUECHIP): min_liquidity=${param1?.min_liquidity}, min_vol_5m=${param1?.min_vol_5m}, max_rsi=${param1?.max_rsi}, min_drop_pct=${param1?.min_drop_pct}, min_vol_24h=${param1?.min_vol_24h}\n`;
            promptText += `ID 2 (MEME_SNIPE): min_liquidity=${param2?.min_liquidity}, min_vol_5m=${param2?.min_vol_5m}, max_rsi=${param2?.max_rsi}, min_drop_pct=${param2?.min_drop_pct}, min_vol_24h=${param2?.min_vol_24h}\n`;
            promptText += `ID 3 (TRENDING): min_liquidity=${param3?.min_liquidity}, min_vol_5m=${param3?.min_vol_5m}, max_rsi=${param3?.max_rsi}, min_drop_pct=${param3?.min_drop_pct}, min_vol_24h=${param3?.min_vol_24h}\n`;
            promptText += `\n[Capital Allocation (For context only)]\nMeme: ${config?.trade_amount_sol} SOL | Bluechip: ${config?.bluechip_trade_amount_sol} SOL | Trending: ${config?.trending_trade_amount_sol} SOL\n`;
            
            promptText += `\n[Strict Output Formatting Upgrade]\nYour \`recommended_params\` object MUST contain \`bluechip\`, \`meme\`, and \`trending\` sub-objects. Example:\n`;
            promptText += `"recommended_params": { "bluechip": { "min_liquidity": 20000, "max_rsi": 40 }, "meme": { "min_liquidity": 10000 }, "trending": { "min_liquidity": 30000 } }`;

            if (!hasTrades) {
                promptText += `\n\n[Special Situational Directive]\nZero trades occurred in the last 12 hours. This might be due to a high disaster score triggering defensive protocols, or parameters being too strict.\nBriefly analyze current macro sentiment vs. existing parameters. Decide if the "empty position" strategy is sound. You may maintain the status quo or slightly loosen parameters to allow sniper entries.`;
            }

            let contextStr = "\n\n[Current Active AI Prompts (Provided only for departments with related trades in this review)]\n";
            
            if (!hasTrades || hasMemeTrade) {
                const overseer = promptManager.cache.get('reviewer_overseer');
                if (overseer) contextStr += `\nTarget ID: reviewer_overseer (Meme Swing Overseer)\nContent: ${overseer}\n`;
            }
            if (!hasTrades || hasTrendingTrade) {
                const trendingOverseer = promptManager.cache.get('reviewer_trending');
                if (trendingOverseer) contextStr += `\nTarget ID: reviewer_trending (Trending Swing Overseer)\nContent: ${trendingOverseer}\n`;
            }
            promptText += contextStr;

            console.log(`🧠 [Evolution] 正在交由 AI Orchestrator 呼叫 Master AI (GEMINI) 撰寫進化/例行報告...`);
            let report = await aiOrchestrator.executeTask('EVOLUTION_MASTER', 'GEMINI', promptText, { bypassLimit: true });
            
            if (!report || !report.analysis) {
                throw new Error("AI Orchestrator 返回異常格式");
            }
            console.log(`✅ [Evolution] Master AI 成功產出報告！`);

            let isVetoed = false;
            let boardComment = "✅ 董事會無異議通過";

            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                console.log(`⚖️ [Board of Directors] Master AI 提出修改 ${report.target_prompt_id}，正在交由 Groq 董事會審批...`);
                
                // 🚀 [V8.4] 董事會 Prompt 全英文機構級重寫，防止 Groq 降智
                const auditorPrompt = `You are the "Independent Risk Board" of a quantitative hedge fund. The Chief AI has proposed a system upgrade based on recent performance.
[Chief AI's Analysis]: ${report.analysis}
[Target Prompt ID to modify]: ${report.target_prompt_id}
[Proposed New Prompt Content]: ${report.new_prompt_content}

[Your Task] Audit this new prompt for safety and logic.
1. If it removes stop-loss logic, encourages blind all-ins, or introduces logical contradictions/hallucinations, firmly reply VETO.
2. If the logic is sound, maintains defensive protocols, and addresses the root cause of recent issues, reply PASS.
[Output] Strict JSON: {"decision": "PASS" | "VETO", "reason": "<Under 50 words explaining your audit verdict>"}. CRUCIAL: Output the "reason" value strictly in Traditional Chinese (Cantonese tone).`;

                try {
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
        healthMonitor.setStatus('AI_Evolution', '🟢 已就位 (9AM/PM)');
    }
};

module.exports = { retrospectiveJob };
