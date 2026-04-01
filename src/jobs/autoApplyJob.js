// src/jobs/autoApplyJob.js
// 📝 檔案功能用途：堅不可摧的自動執行官。每分鐘檢查 Database，若發現 PENDING 的回測提案已經超過 60 分鐘，則自動替其點擊「Approve」。即使 Server 重啟亦不會遺失進度。

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
                    
                    // 🤖 借用 Telegram 嘅 callback 邏輯，扮成「System_Auto」撳掣
                    const mockCallback = {
                        data: `APPROVE_${prop.id}`,
                        message: {
                            chat: { id: configEnv.telegram.chatId || process.env.TELEGRAM_CHAT_ID },
                            message_id: 0 // 特殊標記，防止 TG API 出錯
                        },
                        from: { first_name: "System_Auto" }
                    };

                    await processTelegramCallback(mockCallback);
                    
                    // 記錄稽核報告
                    const evaluation = prop.report_content || "無 AI 評估報告";
                    const changes = typeof prop.proposed_changes === 'string' ? JSON.parse(prop.proposed_changes) : prop.proposed_changes;
                    await supabase.from('daily_audit_reports').insert([{ 
                        analysis_content: `【自動應用】\n${evaluation}`, 
                        param_changes: changes 
                    }]);
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