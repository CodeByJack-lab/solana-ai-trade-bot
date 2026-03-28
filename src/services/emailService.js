// src/services/emailService.js
const nodemailer = require('nodemailer');
const { supabase } = require('../config/supabase'); 
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 🛠️ 企業級穩健版 Transporter 配置
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.SMTP_USER,
        pass: (process.env.SMTP_PASS || '').replace(/\s+/g, '') // 自動剷走空格
    },
    family: 4,                // 🚀 終極殺手鐧：強制底層 Socket 只用 IPv4，徹底避開 ENETUNREACH！
    connectionTimeout: 15000, // 15秒連線超時
    greetingTimeout: 10000,   // 10秒打招呼超時
    socketTimeout: 30000,     // 30秒傳輸超時
    pool: true                // 開啟連線池提高效率
});

const emailService = {
    async sendEvolutionReport(reportData, boardComment, paramUpdateLog, promptUpdateLog) {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn('⚠️ [Email Service] 未設定 SMTP_USER 或 SMTP_PASS，跳過發送郵件。');
            return false;
        }

        try {
            // 1. 從 Supabase 獲取訂閱名單
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

            const dateStr = new Date().toLocaleString('zh-HK', { 
                timeZone: 'Asia/Hong_Kong',
                hour12: false 
            });
            
            // 2. 構建郵件 HTML
            const htmlContent = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
                <div style="background-color: #2E86C1; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                    <h2 style="color: #ffffff; margin: 0;">🤖 V8.2 Master AI 自我進化報告</h2>
                </div>
                
                <div style="padding: 20px; color: #333;">
                    <p style="font-size: 14px; color: #666;"><strong>🕒 報告生成時間：</strong> ${dateStr}</p>
                    
                    <h3 style="color: #E67E22; border-left: 4px solid #E67E22; padding-left: 10px;">📊 深度敗因與獲利分析</h3>
                    <div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; white-space: pre-wrap; line-height: 1.6; font-size: 14px;">
                        ${reportData.analysis}
                    </div>

                    <h3 style="color: #27AE60; border-left: 4px solid #27AE60; padding-left: 10px;">⚖️ 獨立董事會決議</h3>
                    <p style="font-weight: bold; font-size: 16px; padding: 10px; background-color: #eafaf1; border-radius: 8px;">${boardComment}</p>

                    <h3 style="color: #8E44AD; border-left: 4px solid #8E44AD; padding-left: 10px;">⚙️ 系統參數修正</h3>
                    <div style="background-color: #f4eef8; padding: 15px; border-radius: 8px;">
                        <code style="font-family: 'Courier New', Courier, monospace; color: #8E44AD;">${paramUpdateLog}</code>
                    </div>

                    <h3 style="color: #C0392B; border-left: 4px solid #C0392B; padding-left: 10px;">📝 AI 劇本 (Prompt) 進化紀錄</h3>
                    <div style="background-color: #fdf2f2; padding: 15px; border-radius: 8px; white-space: pre-wrap; font-size: 13px;">
                        ${promptUpdateLog}
                    </div>
                </div>
                
                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 12px;">
                    <p>此郵件由 SOL_Trade V8.2 核心自動發送。系統已進入全自動巡航模式。</p>
                    <p>© 2026 SOL_Trade Quant Team. All Rights Reserved.</p>
                </div>
            </div>
            `;

            // 3. 執行發送
            const info = await transporter.sendMail({
                from: `"Master AI 總機" <${process.env.SMTP_USER}>`,
                to: targetEmails, 
                subject: `🚀 [進化戰報] 系統自我修正紀錄 - ${dateStr}`,
                html: htmlContent
            });
            
            console.log(`✅ [Email Service] 進化報告已送達！(MsgID: ${info.messageId})`);
            return true;

        } catch (error) {
            console.error('❌ [Email Service] 致命錯誤:', error.message);
            if (error.code === 'ETIMEDOUT') console.error('   -> 原因: 與 Google SMTP 連線超時 (Network Timeout)');
            if (error.code === 'EAUTH') console.error('   -> 原因: 認證失敗，請檢查 SMTP_PASS 是否為最新的「應用程式密碼」');
            return false;
        }
    }
};

module.exports = { emailService };
