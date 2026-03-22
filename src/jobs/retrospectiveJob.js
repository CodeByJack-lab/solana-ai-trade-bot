// src/jobs/retrospectiveJob.js
const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendAdminAlert } = require('../services/telegramService'); 
const { healthMonitor } = require('../services/healthMonitor');
require('dotenv').config();

const PRO_API_KEY = process.env.GEMINI_API_KEY;

const retrospectiveJob = {
    async runAnalysis() {
        console.log(`\n🌞 [Evolution] 啟動 12AM/PM (HKT) 全自動自我進化程序...`);
        healthMonitor.setStatus('AI_Evolution', '🟢 分析與修正中...');

        try {
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            
            // 1. 獲取過去 12 小時「所有」單 (優先查實盤)
            let { data: allTrades } = await supabase
                .from('trade_history_live')
                .select('*')
                .gte('created_at', twelveHoursAgo);

            // 若實盤冇單，就攞 Paper 嚟復盤
            if (!allTrades || allTrades.length === 0) {
                const { data: paperTrades } = await supabase
                    .from('trade_history_paper')
                    .select('*')
                    .gte('created_at', twelveHoursAgo);
                allTrades = paperTrades;
            }

            if (!allTrades || allTrades.length === 0) {
                console.log(`✅ [Evolution] 過去 12 小時無交易，維持現狀。`);
                healthMonitor.setStatus('AI_Evolution', '🟢 待命中');
                return;
            }

            // 💡 2. 【核心升級】實質盈利防線 (Net PNL Gatekeeper)
            // 計算過去 12 小時平均盈虧
            const avgPnlPct = allTrades.reduce((sum, t) => sum + (t.realized_pnl_pct || 0), 0) / allTrades.length;
            const HURDLE_RATE = 2.0; // 扣除 Jito/滑點後的實質盈利及格線 (例如 2%)

            if (avgPnlPct >= HURDLE_RATE) {
                const msg = `過去 12 小時平均利潤達 +${avgPnlPct.toFixed(2)}% (已跨越 ${HURDLE_RATE}% 及格線)。\n🛡️ 系統處於「實質印鈔狀態」，為保護神仙幣基因，禁止 AI 擅改參數！`;
                console.log(`✅ [Evolution] ${msg}`);
                healthMonitor.setStatus('AI_Evolution', '🟢 利潤達標，休眠中');
                sendAdminAlert(`🌞 <b>[進化防禦機制觸發]</b>\n${msg}`);
                return; // 贏緊錢，直接收工，唔好叫 AI 出嚟搞事！
            } else {
                console.log(`⚠️ [Evolution] 過去 12 小時平均利潤為 ${avgPnlPct.toFixed(2)}% (未達 ${HURDLE_RATE}% 及格線)。啟動大腦檢討...`);
            }

            // 3. 既然未達標，就抽最差嗰 3 張單出嚟掟畀 AI
            const badTrades = allTrades
                .filter(t => t.realized_pnl_pct < 0)
                .sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct) // 由最傷排起
                .slice(0, 3);

            if (badTrades.length === 0) {
                console.log(`✅ [Evolution] 過去 12 小時無虧損單，維持現狀。`);
                healthMonitor.setStatus('AI_Evolution', '🟢 待命中');
                return;
            }

            // 4. 判斷敗因歸屬，防止誤傷老幣！
            const hasBluechipLoss = badTrades.some(t => (t.strategy_type || '').includes('BLUECHIP'));
            const hasMemeLoss = badTrades.some(t => !(t.strategy_type || '').includes('BLUECHIP'));

            // 5. 獲取 Master Prompt 與當前參數 
            const { data: params } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
            const { data: masterPrompt } = await supabase.from('master_auditor_prompts').select('content').eq('id', 1).single();

            let promptText = masterPrompt.content
                .replace('{{loss_trades_data}}', JSON.stringify(badTrades.map(t => ({
                    symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type
                }))))
                .replace('{{current_min_liq}}', params.min_liquidity || 10000)
                .replace('{{current_min_vol}}', params.min_vol_5m || 1000)
                .replace('{{current_bluechip_rsi}}', params.bluechip_max_rsi || 40)
                .replace('{{current_bluechip_drop}}', params.bluechip_min_drop_pct || 2);

            // 6. 動態注入需要檢討的 Prompt 
            const { data: currentPrompts } = await supabase.from('bot_prompts').select('*');
            if (currentPrompts) {
                let contextStr = "\n\n【當前系統使用的 AI 劇本 (僅提供有虧損的部門供你修改)】\n";
                if (hasMemeLoss) {
                    const overseer = currentPrompts.find(p => p.prompt_id === 'reviewer_overseer');
                    if (overseer) contextStr += `\n目標ID: reviewer_overseer (Meme 幣監軍)\n內容: ${overseer.content}\n`;
                }
                if (hasBluechipLoss) {
                    const bluechip = currentPrompts.find(p => p.prompt_id === 'reviewer_bluechip');
                    if (bluechip) contextStr += `\n目標ID: reviewer_bluechip (老幣監軍)\n內容: ${bluechip.content}\n`;
                }
                promptText += contextStr;
            }

            // 7. 呼叫最強大腦 Gemini 3.1 Pro
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${PRO_API_KEY}`, {
                contents: [{ role: "user", parts: [{ text: promptText }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
            }, { timeout: 25000 });

            let rawText = res.data.candidates[0].content.parts[0].text;
            const report = JSON.parse(rawText.match(/\{[\s\S]*\}/)[0]);

            // 8. 【自動執行 A】物理門檻修正 (包含 Meme 與 老幣)
            let paramUpdateLog = "無變動";
            if (report.recommended_params) {
                const updates = {};
                
                if (report.recommended_params.min_liquidity !== undefined && report.recommended_params.min_liquidity !== null) {
                    updates.min_liquidity = Math.max(5000, Math.min(Number(report.recommended_params.min_liquidity), 50000));
                }
                if (report.recommended_params.min_vol_5m !== undefined && report.recommended_params.min_vol_5m !== null) {
                    updates.min_vol_5m = Math.max(500, Math.min(Number(report.recommended_params.min_vol_5m), 10000));
                }
                if (report.recommended_params.bluechip_max_rsi !== undefined && report.recommended_params.bluechip_max_rsi !== null) {
                    updates.bluechip_max_rsi = Math.max(20, Math.min(Number(report.recommended_params.bluechip_max_rsi), 50));
                }
                if (report.recommended_params.bluechip_min_drop_pct !== undefined && report.recommended_params.bluechip_min_drop_pct !== null) {
                    updates.bluechip_min_drop_pct = Math.max(1, Math.min(Number(report.recommended_params.bluechip_min_drop_pct), 10));
                }
                
                if (Object.keys(updates).length > 0) {
                    await supabase.from('ai_strategy_params').update(updates).eq('id', 1);
                    paramUpdateLog = JSON.stringify(updates);
                }
            }

            // 9. 【自動執行 B】AI 劇本修正 
            let promptUpdateLog = "無修正";
            
            if (report.target_prompt_id && report.new_prompt_content && report.target_prompt_id !== "null") {
                const isIllegalUpdate = (report.target_prompt_id === 'reviewer_bluechip' && !hasBluechipLoss);
                
                if (isIllegalUpdate) {
                    promptUpdateLog = `❌ 攔截非法修改：老幣無虧損，拒絕 Master AI 修改 reviewer_bluechip！`;
                } else {
                    const { error: pErr } = await supabase
                        .from('bot_prompts')
                        .update({ 
                            content: report.new_prompt_content,
                            updated_at: new Date()
                        })
                        .eq('prompt_id', report.target_prompt_id);
                    
                    if (!pErr) {
                        promptUpdateLog = `✅ 已自動更新 ${report.target_prompt_id}`;
                    } else {
                        promptUpdateLog = `❌ 更新失敗: ${pErr.message}`;
                    }
                }
            }

            // 10. 記錄報告與通知
            await supabase.from('daily_audit_reports').insert([{
                analysis_content: report.analysis,
                param_changes: report.recommended_params,
                prompt_changes: report.prompt_feedback + " | " + promptUpdateLog
            }]);

            sendAdminAlert(`
🌞 <b>[系統全自動進化完成]</b>
📊 <b>敗因分析</b>: ${report.analysis}
⚙️ <b>門檻修正</b>: ${paramUpdateLog}
📝 <b>AI劇本進化</b>: ${promptUpdateLog}
💡 <b>修正邏輯</b>: ${report.prompt_feedback}
            `);
            
            healthMonitor.setStatus('AI_Evolution', '🟢 完成進化');

        } catch (err) {
            console.error(`❌ [Evolution Error]`, err.message);
            healthMonitor.setStatus('AI_Evolution', `🔴 異常: ${err.message}`);
        }
    },

    start() {
        cron.schedule('0 0,12 * * *', () => { 
            this.runAnalysis(); 
        }, {
            scheduled: true,
            timezone: "Asia/Hong_Kong"
        });
        
        console.log(`🤖 [Evolution] 全自動修正排程已啟動 (每日 12AM & 12PM HKT)...`);
    }
};

module.exports = { retrospectiveJob };
