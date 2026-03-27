// src/services/emailService.js
const dns = require('dns');
// 🚀 關鍵：強制 DNS 優先解析 IPv4 地址，解決 Railway ENETUNREACH IPv6 報錯
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const nodemailer = require('nodemailer');
const { supabase } = require('../config/supabase'); 
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 🛠️ 建立發送器
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465, // 使用 SSL 
    secure: true, // 465 必須為 true
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const emailService = {
    async sendEvolutionReport(reportData, boardComment, paramUpdateLog, promptUpdateLog) {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn('⚠️ [Email Service] 未設定 SMTP_USER 或 SMTP_PASS，跳過發送郵件。');
            return false;
        }

        try {
            // 🚀 從 Supabase 拉取生效中的 Admin Emails
            const { data: admins, error } = await supabase
                .from('admin_subscribers')
                .select('email')
                .eq('is_active', true);

            if (error || !admins || admins.length === 0) {
                console.warn('⚠️ [Email Service] Supabase 找不到任何生效的 Admin Email，跳過發送。');
                return false;
            }

            const targetEmails = admins.map(a => a.email).join(', ');
            console.log(`📧 [Email Service] 準備發送報告給: ${targetEmails}`);

            const dateStr = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
            
            // 🎨 HTML 排版維持原本設計
            const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                <h2 style="color: #2E86C1; border-bottom: 2px solid #2E86C1; padding-bottom: 10px;">🤖 V7.0 Master AI 全自動自我進化報告</h2>
                <p><strong>🕒 報告時間：</strong> ${dateStr}</p>
                
                <h3 style="color: #E67E22;">📊 深度敗因與獲利分析</h3>
                <div style="background-color: #F8F9F9; padding: 15px; border-left: 4px solid #E67E22; white-space: pre-wrap; line-height: 1.6;">
                    ${reportData.analysis}
                </div>

                <h3 style="color: #27AE60;">⚖️ 獨立董事會決議</h3>
                <p style="font-weight: bold; font-size: 16px;">${boardComment}</p>

                <h3 style="color: #8E44AD;">⚙️ 系統參數修正</h3>
                <div style="background-color: #EAFAF1; padding: 15px; border-left: 4px solid #8E44AD;">
                    <code>${paramUpdateLog}</code>
                </div>

                <h3 style="color: #C0392B;">📝 AI 劇本 (Prompt) 進化紀錄</h3>
                <div style="background-color: #FDEDEC; padding: 15px; border-left: 4px solid #C0392B; white-space: pre-wrap;">
                    ${promptUpdateLog}
                </div>
                
                <hr style="margin-top: 30px; border: 0; border-top: 1px solid #eee;">
                <p style="color: #7F8C8D; font-size: 12px; text-align: center;">此郵件由 Solana AI Trade Bot V7.0 自動生成，請勿直接回覆。</p>
            </div>
            `;

            const info = await transporter.sendMail({
                from: `"Master AI 總機" <${process.env.SMTP_USER}>`,
                to: targetEmails, 
                subject: `[進化報告] AI 系統自我修正戰報 - ${dateStr}`,
                html: htmlContent
            });
            
            console.log(`✅ [Email Service] 進化報告已成功群發！(ID: ${info.messageId})`);
            return true;

        } catch (error) {
            console.error('❌ [Email Service] 發送 Email 失敗:', error.message);
            return false;
        }
    }
};

module.exports = { emailService };