// src/services/telegramService.js
// 📝 檔案功能用途：Telegram 路由與通訊中心。實裝「3路分流」，將公海戰報、系統監控、戰略審批精確派發到不同 Chat 與 Bot。
const axios = require('axios');
const path = require('path');
const configEnv = require('../config/env');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const MAIN_BOT_TOKEN = configEnv.telegram.mainBotToken;
const ADMIN_BOT_TOKEN = configEnv.telegram.adminBotToken;
const CHANNEL_ID = configEnv.telegram.channelId;
const CHAT_ID = configEnv.telegram.chatId;

function safeHTML(text) {
    if (!text) return "";
    return text.toString().replace(/</g, '＜').replace(/>/g, '＞');
}

// 🚀 新增 pin 參數
async function _send(message, token, targetChatId, pin = false) {
    if (!token || !targetChatId) return null;

    let finalMessage = message;
    if (finalMessage.length > 4000) {
        finalMessage = finalMessage.substring(0, 4000) + "\n\n... ✂️ (報告過長，已由系統自動截斷)";
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const res = await axios.post(url, { chat_id: targetChatId, text: finalMessage, parse_mode: 'HTML' });
        
        // 📌 自動置頂邏輯
        if (pin && res.data && res.data.result && res.data.result.message_id) {
            const pinUrl = `https://api.telegram.org/bot${token}/pinChatMessage`;
            await axios.post(pinUrl, {
                chat_id: targetChatId,
                message_id: res.data.result.message_id,
                disable_notification: true // 置頂時不發出額外通知聲
            }).catch(pinErr => console.warn(`⚠️ [Telegram] 置頂失敗 (請檢查 Bot 權限):`, pinErr.message));
        }
        
        return res.data?.result?.message_id;
    } catch (err) {
        const errMsg = err.response?.data?.description || err.message || "";
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            try {
                const plainText = finalMessage.replace(/<[^>]+>/g, '');
                const fallbackRes = await axios.post(url, { chat_id: targetChatId, text: plainText });
                
                if (pin && fallbackRes.data?.result?.message_id) {
                    await axios.post(`https://api.telegram.org/bot${token}/pinChatMessage`, { chat_id: targetChatId, message_id: fallbackRes.data.result.message_id, disable_notification: true }).catch(e => {});
                }
                return fallbackRes.data?.result?.message_id;
            } catch (fallbackErr) {
                console.error("❌ [Telegram] 備援純文字發送也失敗:", fallbackErr.response?.data?.description || fallbackErr.message);
            }
        } else {
            console.error(`❌ [Telegram] 發送失敗 (${targetChatId}):`, errMsg);
        }
    }
    return null;
}

// ==========================================
// 📡 3 路分流 API (支援置頂參數)
// ==========================================

// 🛣️ 路線 1：公海 Channel -> 買賣戰報、每日結算 (支援傳入 true 進行置頂)
async function sendTelegramAlert(message, pin = false) { 
    await _send(message, MAIN_BOT_TOKEN, CHANNEL_ID, pin); 
}

// 🛣️ 路線 2：Chat 2 系統監控 -> 大盤熔斷、429 API 報錯、看板
async function sendAdminAlert(message, pin = false) { 
    await _send(message, MAIN_BOT_TOKEN, CHAT_ID, pin); 
}

// 🛣️ 路線 3：Chat 1 戰略指揮 -> 回測審批
async function sendStrategyAlert(message, pin = false) { 
    await _send(message, ADMIN_BOT_TOKEN, CHAT_ID, pin); 
}

// ==========================================

let lastErrorState = "";
let errorStartTime = 0;
let hasAlertedError = false;

// 🩺 系統健康看板 (走路線 2: 系統監控)
function checkSystemHealth() {
    const { healthMonitor } = require('./healthMonitor'); 
    const report = healthMonitor.getHealthReport();
    
    const lines = report.split('\n');
    const currentErrors = lines.filter(l => l.includes('🔴') || l.includes('🟡')).join('\n');
    
    if (currentErrors !== "") {
        if (currentErrors !== lastErrorState) {
            lastErrorState = currentErrors;
            errorStartTime = Date.now();
            hasAlertedError = false;
        } else if (!hasAlertedError && (Date.now() - errorStartTime > 60000)) {
            const cleanReport = safeHTML(report);
            const alertMsg = `🚨 <b>【系統故障警告】偵測到持續 1 分鐘以上的異常！</b>\n請即刻檢查伺服器狀態！\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
            sendAdminAlert(alertMsg); // Chat 2
            hasAlertedError = true; 
        }
    } else {
        if (lastErrorState !== "") {
            if (hasAlertedError) {
                const cleanReport = safeHTML(report);
                const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已穩定超過 1 分鐘！解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
                sendAdminAlert(recoveryMsg); // Chat 2
            }
            lastErrorState = "";
            errorStartTime = 0;
            hasAlertedError = false;
        }
    }
}

setInterval(checkSystemHealth, 20 * 1000);

async function sendParamSnapshot() {
    // 省略：如果仍需使用，可保留，亦走 sendAdminAlert
}

// 審批發送器 (走路線 3: 戰略指揮)
async function sendApprovalRequest(reportText, proposalId) {
    const token = ADMIN_BOT_TOKEN;
    const chat = CHAT_ID;
    const { supabase } = require('../config/supabase'); 
    
    if (!token || !chat) return;

    let finalReportText = reportText;

    try {
        const { data: proposal } = await supabase.from('ai_proposals').select('proposed_changes').eq('id', proposalId).single();
        if (proposal && proposal.proposed_changes) {
            const changes = typeof proposal.proposed_changes === 'string' ? JSON.parse(proposal.proposed_changes) : proposal.proposed_changes;
            let details = "\n━━━━━━━━━━━━━━━━━━\n🔍 <b>【具體變更預覽】</b>\n";
            let hasDetails = false;

            if (changes.meme_params && Object.keys(changes.meme_params).length > 0) {
                details += `🐶 <b>MEME 參數即將變更:</b>\n`;
                for (const [key, value] of Object.entries(changes.meme_params)) details += `  ▪️ <code>${key}</code> ➡️ <b>${value}</b>\n`;
                hasDetails = true;
            }
            if (changes.trending_params && Object.keys(changes.trending_params).length > 0) {
                details += `🔥 <b>TRENDING 參數即將變更:</b>\n`;
                for (const [key, value] of Object.entries(changes.trending_params)) details += `  ▪️ <code>${key}</code> ➡️ <b>${value}</b>\n`;
                hasDetails = true;
            }
            
            if (hasDetails) finalReportText += details;
        }
    } catch (err) {}

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ 批准並套用 (Apply)", callback_data: `APPROVE_${proposalId}` },
                { text: "❌ 否決提案 (Reject)", callback_data: `REJECT_${proposalId}` }
            ]
        ]
    };

    try {
        await axios.post(url, { chat_id: chat, text: finalReportText, parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err) {}
}

// 接收 Callback (走路線 3: 戰略指揮)
async function processTelegramCallback(callbackQuery) {
    const { supabase } = require('../config/supabase');
    const data = callbackQuery.data; 
    const messageId = callbackQuery.message.message_id;
    const token = ADMIN_BOT_TOKEN; 
    const chat = CHAT_ID; // 鎖死回覆去 Chat 1
    const isAutoSystem = callbackQuery.from?.first_name === "System_Auto"; 

    if (!data.startsWith('APPROVE_') && !data.startsWith('REJECT_')) return;

    const action = data.split('_')[0]; 
    const proposalId = data.replace(`${action}_`, '');

    try {
        const { data: proposal, error } = await supabase.from('ai_proposals').select('*').eq('id', proposalId).single();
        
        if (error || !proposal) {
            if (!isAutoSystem) await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: "⚠️ 找不到該提案。" });
            return;
        }

        if (proposal.status !== 'PENDING') {
            if (!isAutoSystem) await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: `⚠️ 提案狀態為 ${proposal.status}，無法重複處理。` });
            return;
        }

        if (action === 'REJECT') {
            await supabase.from('ai_proposals').update({ status: 'REJECTED' }).eq('id', proposalId);
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: "🗑️ <b>回測提案已否決。</b>", parse_mode: 'HTML' });
        } 
        else if (action === 'APPROVE') {
            const changes = typeof proposal.proposed_changes === 'string' ? JSON.parse(proposal.proposed_changes) : proposal.proposed_changes;
            let successMsg = isAutoSystem 
                ? "⚡ <b>【系統自動執行】60 分鐘無異議，提案已自動套用！</b>\n"
                : "✅ <b>提案已批准並套用！</b>\n";

            if (proposal.proposal_type === 'BACKTEST') {
                if (changes.meme_params) await supabase.from('ai_strategy_params').update(changes.meme_params).eq('id', 2);
                if (changes.trending_params) await supabase.from('ai_strategy_params').update(changes.trending_params).eq('id', 3);
                successMsg += `\n🛡️ 每週兩階段高精度回測參數已成功寫入 Database。`;
            }

            await supabase.from('ai_proposals').update({ status: 'APPROVED' }).eq('id', proposalId);
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: successMsg, parse_mode: 'HTML' });
        }

        if (messageId && messageId !== 0) {
            await axios.post(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
                chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } 
            }).catch(e => {}); 
        }

    } catch (err) {
        console.error("❌ [Telegram Callback Error]:", err.message);
    }
}

module.exports = { sendTelegramAlert, sendAdminAlert, sendStrategyAlert, sendParamSnapshot, safeHTML, sendApprovalRequest, processTelegramCallback };