// src/jobs/autoApplyJob.js
// 📝 檔案功能用途：堅不可摧的自動執行官。每分鐘檢查 Database，若發現 PENDING 的回測提案已經超過 60 分鐘，則自動替其點擊「Approve」。即使 Server 重啟亦不會遺失進度。
// 🛠️ V9.2.6 修正：加入強制 Database 狀態更新與 TG Callback 錯誤隔離，徹底斬斷無限輪迴 Bug。

const { supabase } = require('../config/supabase');
const { processTelegramCallback } = require('../services/telegramService');
const cron = require('node-cron');
const configEnv = require('../config/config');

const autoApplyJob = {
    async checkAndApply() {
        try {
            // 🔍 針對 V9.0 的 BACKTEST 提案進行掃描
            const { data: pendingProposals } = await supabase
                .from('ai_proposals')
                .select('*')
                .eq('status', 'PENDING')
                .eq('proposal_type', 'BACKTEST');

            if (!pendingProposals || pendingProposals.length === 0) return;

            const now = Date.now();

            for (const prop of pendingProposals) {
                const createdAtMs = new Date(prop.created_at).getTime();
                const sixtyMinsMs = 60 * 60 * 1000;

                // ⏳ 檢查是否已超過 60 分鐘冷靜期
                if (now - createdAtMs >= sixtyMinsMs) {
                    console.log(`⏰ [Auto-Apply] 提案 ${prop.id} 已過 60 分鐘人工冷靜期，執行自動套用！`);
                    
                    // 🛡️ 1. 第一時間強制更新 Database 狀態，斬斷無限輪迴！
                    const { error: updateErr } = await supabase
                        .from('ai_proposals')
                        .update({ status: 'APPLIED', updated_at: new Date().toISOString() })
                        .eq('id', prop.id);
                        
                    if (updateErr) {
                        console.error(`❌ [AutoApplyJob] 無法更新提案狀態: ${updateErr.message}`);
                        continue; // 如果 DB 更新失敗，就唔好繼續落去
                    }

                    // 🤖 2. 借用 Telegram 嘅 callback 邏輯，扮成「System_Auto」撳掣
                    const mockCallback = {
                        data: `APPROVE_${prop.id}`,
                        message: {
                            chat: { id: configEnv.telegram.chatId || process.env.TELEGRAM_CHAT_ID },
                            message_id: 0 // 特殊標記，防止 TG API 出錯
                        },
                        from: { first_name: "System_Auto" }
                    };

                    // 🛡️ 3. 將 Callback 包喺 try-catch 裡面，防止 TG API 報錯搞死成個 Job
                    try {
                        await processTelegramCallback(mockCallback);
                    } catch (tgErr) {
                        console.warn(`⚠️ [AutoApplyJob] Telegram Mock 回調執行時產生無害警告 (已隔離): ${tgErr.message}`);
                    }
                    
                    // 4. 記錄稽核報告
                    try {
                        const evaluation = prop.report_content || "無 AI 評估報告";
                        const changes = typeof prop.proposed_changes === 'string' ? JSON.parse(prop.proposed_changes) : prop.proposed_changes;
                        await supabase.from('daily_audit_reports').insert([{ 
                            analysis_content: `【自動應用】\n${evaluation}`, 
                            param_changes: changes 
                        }]);
                        console.log(`✅ [Auto-Apply] 提案 ${prop.id} 已成功自動套用並寫入稽核報告。`);
                    } catch (auditErr) {
                        console.error(`❌ [AutoApplyJob] 寫入稽核報告失敗: ${auditErr.message}`);
                    }
                }
            }
        } catch (err) {
            console.error("❌ [AutoApplyJob] 錯誤:", err.message);
        }
    },

    start() {
        // 每分鐘檢查一次
        cron.schedule('* * * * *', () => this.checkAndApply());
        console.log('🕒 [AutoApplyJob] 60 分鐘實體防丟失自動套用排程已啟動');
    }
};

module.exports = { autoApplyJob };
