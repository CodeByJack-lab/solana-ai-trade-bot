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
            // 1. 獲取過去 12 小時最差的 3 張單 (優先查實盤)
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            let { data: badTrades } = await supabase
                .from('trade_history_live')
                .select('*')
                .gte('created_at', twelveHoursAgo)
                .lt('realized_pnl_sol', 0)
                .order('realized_pnl_pct', { ascending: true })
                .limit(3);

            // 若實盤冇單，就攞 Paper 嚟復盤
            if (!badTrades || badTrades.length === 0) {
                const { data: paperTrades } = await supabase
                    .from('trade_history_paper')
                    .select('*')
                    .gte('created_at', twelveHoursAgo)
                    .lt('realized_pnl_sol', 0)
                    .order('realized_pnl_pct', { ascending: true })
                    .limit(3);
                badTrades = paperTrades;
            }

            if (!badTrades || badTrades.length === 0) {
                console.log(`✅ [Evolution] 過去 12 小時無虧損，維持現狀。`);
                healthMonitor.setStatus('AI_Evolution', '🟢 待命中');
                return;
            }

            // 💡 2. 判斷敗因歸屬，防止誤傷老幣！
            const hasBluechipLoss = badTrades.some(t => (t.strategy_type || '').includes('BLUECHIP'));
            const hasMemeLoss = badTrades.some(t => !(t.strategy_type || '').includes('BLUECHIP'));

            // 3. 獲取 Master Prompt 與當前參數 
            const { data: params } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
            const { data: masterPrompt } = await supabase.from('master_auditor_prompts').select('content').eq('id', 1).single();

            let promptText = masterPrompt.content
                .replace('{{loss_trades_data}}', JSON.stringify(badTrades.map(t => ({
                    symbol: t.token_symbol, pnl: t.realized_pnl_pct, reason: t.ai_factcheck_result, strategy: t.strategy_type
                }))))
                .replace('{{current_min_liq}}', params.min_liquidity)
                .replace('{{current_min_vol}}', params.min_vol_5m);

            // 🚀 4. 動態注入需要檢討的 Prompt (無輸錢的部門，不會被檢討！)
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

            // 5. 呼叫最強大腦 Gemini 3.1 Pro
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${PRO_API_KEY}`, {
                contents: [{ role: "user", parts: [{ text: promptText }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
            }, { timeout: 25000 });

            let rawText = res.data.candidates[0].content.parts[0].text;
            const report = JSON.parse(rawText.match(/\{[\s\S]*\}/)[0]);

            // 6. 【自動執行 A】物理門檻修正 (🚀 核心修正：加入物理安全邊界)
            let paramUpdateLog = "無變動";
            if (report.recommended_params) {
                const updates = {};
                
                if (report.recommended_params.min_liquidity !== undefined) {
                    // 🔒 鎖定流動性在 5,000 到 50,000 之間
                    const rawLiq = Number(report.recommended_params.min_liquidity);
                    updates.min_liquidity = Math.max(5000, Math.min(rawLiq, 50000));
                }
                
                if (report.recommended_params.min_vol_5m !== undefined) {
                    // 🔒 鎖定 5分鐘成交量在 500 到 10,000 之間
                    const rawVol = Number(report.recommended_params.min_vol_5m);
                    updates.min_vol_5m = Math.max(500, Math.min(rawVol, 10000));
                }
                
                if (Object.keys(updates).length > 0) {
                    await supabase.from('ai_strategy_params').update(updates).eq('id', 1);
                    paramUpdateLog = JSON.stringify(updates);
                }
            }

            // 7. 【自動執行 B】AI 劇本修正 
            let promptUpdateLog = "無修正";
            
            // 🛡️ 最終防線：防止誤傷
            if (report.target_prompt_id && report.new_prompt_content) {
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

            // 8. 記錄報告與通知
            await supabase.from('daily_audit_reports').insert([{
                analysis_content: report.analysis,
                param_changes: report.recommended_params,
                prompt_changes: report.prompt_feedback + " | " + promptUpdateLog
            }]);

            sendAdminAlert(`
🌞 <b>[系統全自動進化完成]</b>
📊 <b>敗因分析</b>: ${report.analysis}
⚙️ <b>物理門檻</b>: ${paramUpdateLog}
📝 <b>AI 劇本進化</b>: ${promptUpdateLog}
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