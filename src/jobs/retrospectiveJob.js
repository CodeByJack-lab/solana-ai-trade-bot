// src/jobs/retrospectiveJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { sendAdminAlert, sendApprovalRequest } = require('../services/telegramService'); 
const { healthMonitor } = require('../services/healthMonitor');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const { promptManager } = require('../services/promptManager'); 

const retrospectiveJob = {
    async runEvolutionWithRetry(attempt = 1) {
        const MAX_ATTEMPTS = 3; 

        console.log(`\n🌞 [Evolution] 啟動每日 00:00 (HKT) Master AI 邏輯與參數進化程序 (第 ${attempt} 次嘗試)...`);
        healthMonitor.setStatus('AI_Evolution', `🟢 深度分析中 (嘗試 ${attempt}/${MAX_ATTEMPTS})...`);

        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            let { data: allTrades } = await supabase.from('trade_history_live').select('*').gte('created_at', twentyFourHoursAgo);
            if (!allTrades || allTrades.length === 0) {
                const { data: paperTrades } = await supabase.from('trade_history_paper').select('*').gte('created_at', twentyFourHoursAgo);
                allTrades = paperTrades || [];
            }

            let hasTrades = false;
            let badTrades = [];
            let bestTrades = [];

            if (allTrades.length > 0) {
                // 🛡️ [保留神級邏輯] 實質印鈔狀態防禦！
                const avgPnlPct = allTrades.reduce((sum, t) => sum + (t.realized_pnl_pct || 0), 0) / allTrades.length;
                const HURDLE_RATE = 5.0; 

                if (avgPnlPct >= HURDLE_RATE) {
                    const msg = `過去 24 小時平均利潤達 +${avgPnlPct.toFixed(2)}% (跨越 ${HURDLE_RATE}% 及格線)。\n🛡️ 系統處於「實質印鈔狀態」，Master AI 自動休眠，不作任何修改提案！`;
                    console.log(`✅ [Evolution] ${msg}`);
                    
                    // 照樣入庫留底，但狀態直接 APPROVED (無改動)
                    await supabase.from('ai_proposals').insert([{
                        proposal_type: 'MASTER_AI',
                        report_content: `【實質印鈔戰報】\n當前系統表現極佳（Avg PNL: ${avgPnlPct.toFixed(2)}%）。根據防禦協議，Master AI 已停止對核心參數進行修改，以保護當前高勝率矩陣。`,
                        proposed_changes: {},
                        status: 'APPROVED'
                    }]);

                    await sendAdminAlert(`🌞 <b>[戰報模式]</b>\n${msg}`);
                    healthMonitor.setStatus('AI_Evolution', '🟢 印鈔防禦中 (00:00 執行)');
                    return; 
                }

                badTrades = allTrades.filter(t => t.realized_pnl_pct < 0).sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct).slice(0, 3);
                bestTrades = allTrades.filter(t => t.realized_pnl_pct > 0).sort((a, b) => b.realized_pnl_pct - a.realized_pnl_pct).slice(0, 3);
                if (badTrades.length > 0 || bestTrades.length > 0) hasTrades = true;
            }

            const { data: lastProposals } = await supabase.from('ai_proposals').select('*').eq('proposal_type', 'MASTER_AI').order('created_at', { ascending: false }).limit(2);
            let lastAuditText = "No historical records.";
            if (lastProposals && lastProposals.length > 0) {
                const last = lastProposals[0];
                lastAuditText = `[Your Previous Analysis]: ${last.report_content}\n[Status]: ${last.status}\n`;
                if (last.status === 'REJECTED') lastAuditText += `⚠️ WARNING: Your last proposal was REJECTED by the human admin. Rethink your logic!\n`;
            }

            const tradeDataToAI = hasTrades ? {
                "worst_3_trades": badTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type })),
                "best_3_trades": bestTrades.map(t => ({ symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type }))
            } : { "system_status": "No valid trades in the past 24 hours." };

            const { data: masterPrompt } = await supabase.from('master_auditor_prompts').select('content').eq('id', 1).single();

            let promptText = masterPrompt.content
                .replace('{{last_audit_record}}', lastAuditText) 
                .replace('{{loss_trades_data}}', JSON.stringify(tradeDataToAI, null, 2));

            const { data: param2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
            const { data: param3 } = await supabase.from('ai_strategy_params').select('*').eq('id', 3).single();
            promptText += `\n\n[Current Params] MEME(ID:2)=${JSON.stringify(param2)} | TRENDING(ID:3)=${JSON.stringify(param3)}\n`;
            promptText += "\n[Current Active AI Prompts for Reference]\n";
            for (const [id, content] of promptManager.cache.entries()) {
                promptText += `Target ID: ${id}\nContent: ${content}\n\n`;
            }

            console.log(`🧠 [Evolution] 正在交由 AI Orchestrator 撰寫提案...`);
            let report = await aiOrchestrator.executeTask('EVOLUTION_MASTER', 'GEMINI', promptText, { bypassLimit: true });
            
            if (!report || !report.analysis) throw new Error("AI Orchestrator 返回異常格式");
            console.log(`✅ [Evolution] Master AI 成功產出提案！準備申請人類批文...`);

            let proposedChanges = {};
            let hasActionableChange = false;

            if ((report.target_prompt_id && report.target_prompt_id !== "null") || report.recommended_params) {
                proposedChanges = {
                    target_prompt_id: report.target_prompt_id !== "null" ? report.target_prompt_id : null,
                    new_prompt_content: report.new_prompt_content,
                    recommended_params: report.recommended_params
                };
                hasActionableChange = true;
            }

            const { data: insertedProposal, error: insertErr } = await supabase.from('ai_proposals').insert([{
                proposal_type: 'MASTER_AI',
                report_content: report.analysis,
                proposed_changes: proposedChanges,
                status: hasActionableChange ? 'PENDING' : 'APPROVED' 
            }]).select().single();

            if (insertErr) throw new Error(`寫入 ai_proposals 失敗: ${insertErr.message}`);

            const dateStr = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
            let tgReport = `🧠 <b>[Master AI 每日覆盤與提案]</b>\n📅 <i>${dateStr}</i>\n\n📊 <b>深度分析：</b>\n${report.analysis}\n\n`;

            if (hasActionableChange) {
                tgReport += `🎯 <b>建議修改項目：</b>\n`;
                if (proposedChanges.target_prompt_id) tgReport += `📝 劇本: [<code>${proposedChanges.target_prompt_id}</code>]\n`;
                if (proposedChanges.recommended_params) tgReport += `⚙️ 參數: 檢測到入場參數微調建議\n`;
                tgReport += `\n請在下方選擇是否套用此 AI 提案：`;
                
                await sendApprovalRequest(tgReport, insertedProposal.id);
            } else {
                tgReport += `✅ <b>AI 認為目前邏輯與參數完美，無修改建議。</b>`;
                await sendAdminAlert(tgReport);
            }

            healthMonitor.setStatus('AI_Evolution', '🟢 待命中 (00:00 執行)');

        } catch (err) {
            console.error(`❌ [Evolution Error] 執行發生異常:`, err.message);
            if (attempt < MAX_ATTEMPTS) {
                console.log(`⏳ [Evolution] 系統將於 30 分鐘後重試...`);
                healthMonitor.setStatus('AI_Evolution', `🟡 異常，30分鐘後重試...`);
                setTimeout(() => { this.runEvolutionWithRetry(attempt + 1); }, 30 * 60 * 1000); 
            } else {
                healthMonitor.setStatus('AI_Evolution', '🔴 徹底失敗，等待下個排程');
            }
        }
    },

    start() {
        // 🚀 改為每日 HKT 早上 09:00 執行 (美國夜晚，大市平靜期)
        cron.schedule('0 0 9 * * *', () => { 
            this.runEvolutionWithRetry(1); 
        }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        
        console.log(`🤖 [Evolution] Master AI 每日覆盤排程已啟動 (每日 09:00 執行)...`);
        healthMonitor.setStatus('AI_Evolution', '🟢 已就位 (09:00)');
    }
};

module.exports = { retrospectiveJob };