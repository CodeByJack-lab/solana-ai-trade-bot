// src/jobs/autoApplyJob.js
const { supabase } = require('../config/supabase');
const { processTelegramCallback } = require('../services/telegramService');
const cron = require('node-cron');
const configEnv = require('../config/env');

const autoApplyJob = {
    async checkAndApply() {
        try {
            const { data: pendingProposals } = await supabase
                .from('ai_proposals')
                .select('*')
                .eq('status', 'PENDING')
                .eq('proposal_type', 'MASTER_AI');

            if (!pendingProposals || pendingProposals.length === 0) return;

            const now = Date.now();

            for (const prop of pendingProposals) {
                const changes = typeof prop.proposed_changes === 'string' ? JSON.parse(prop.proposed_changes) : prop.proposed_changes;
                
                // 檢查是否含有自動執行時間且已過期
                if (changes.auto_apply_at && now >= changes.auto_apply_at) {
                    console.log(`⏰ [Auto-Apply] 提案 ${prop.id} 已過 15 分鐘冷靜期，執行自動套用！`);
                    
                    // 借用 Telegram 嘅 callback 邏輯，扮成「System_Auto」撳掣
                    const mockCallback = {
                        data: `APPROVE_${prop.id}`,
                        message: {
                            chat: { id: configEnv.telegram.chatId || process.env.TELEGRAM_CHAT_ID },
                            message_id: 0 // 特殊標記，防止 TG API 出錯
                        },
                        from: { first_name: "System_Auto" }
                    };

                    await processTelegramCallback(mockCallback);
                }
            }
        } catch (err) {
            console.error("❌ [AutoApplyJob] 錯誤:", err.message);
        }
    },

    start() {
        cron.schedule('* * * * *', () => this.checkAndApply());
        console.log('🕒 [AutoApplyJob] 15 分鐘自動套用排程已啟動');
    }
};

module.exports = { autoApplyJob };