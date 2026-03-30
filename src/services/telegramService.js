// src/services/telegramService.js
const axios = require('axios');
const path = require('path');
const configEnv = require('../config/env');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const TRADE_BOT_TOKEN = configEnv.telegram.mainBotToken;
const TRADE_CHAT_ID = configEnv.telegram.channelId;
const ADMIN_BOT_TOKEN = configEnv.telegram.adminBotToken;
const ADMIN_CHAT_ID = configEnv.telegram.chatId;
const PERSONAL_CHAT_ID = configEnv.telegram.personalChatId || process.env.PERSONAL_CHAT_ID || ADMIN_CHAT_ID;

function safeHTML(text) {
    if (!text) return "";
    return text.toString().replace(/</g, '＜').replace(/>/g, '＞');
}

async function _send(message, token, chatId) {
    if (!token || !chatId) return;

    let finalMessage = message;
    if (finalMessage.length > 4000) {
        finalMessage = finalMessage.substring(0, 4000) + "\n\n... ✂️ (報告過長，已由系統自動截斷)";
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: finalMessage, parse_mode: 'HTML' });
    } catch (err) {
        const errMsg = err.response?.data?.description || err.message || "";
        if (errMsg.includes('parse entities') || errMsg.includes('HTML')) {
            try {
                const plainText = finalMessage.replace(/<[^>]+>/g, '');
                await axios.post(url, { chat_id: chatId, text: plainText });
            } catch (fallbackErr) {
                console.error("❌ [Telegram] 備援純文字發送也失敗:", fallbackErr.response?.data?.description || fallbackErr.message);
            }
        } else {
            console.error(`❌ [Telegram] 發送失敗 (${chatId}):`, errMsg);
        }
    }
}

async function sendTelegramAlert(message) { await _send(message, TRADE_BOT_TOKEN, TRADE_CHAT_ID); }
async function sendAdminAlert(message) { await _send(message, TRADE_BOT_TOKEN, PERSONAL_CHAT_ID); }

let lastErrorState = "";
let errorStartTime = 0;
let hasAlertedError = false;

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
            sendAdminAlert(alertMsg);
            hasAlertedError = true; 
        }
    } else {
        if (lastErrorState !== "") {
            if (hasAlertedError) {
                const cleanReport = safeHTML(report);
                const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已穩定超過 1 分鐘！解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
                sendAdminAlert(recoveryMsg);
            }
            lastErrorState = "";
            errorStartTime = 0;
            hasAlertedError = false;
        }
    }
}

setInterval(checkSystemHealth, 20 * 1000);

async function sendParamSnapshot() {
    const { supabase } = require('../config/supabase');
    try {
        const { data: p1 } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
        const { data: p2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
        const { data: cfg } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();

        const msg = `\n📋 <b>當前系統參數快照</b>\n━━━━━━━━━━━━━━━━━━\n🏛️ <b>老幣防線 (Bluechip)</b>\n- 最低流動性: $${p1?.min_liquidity || 0}\n- 5分量: $${p1?.min_vol_5m || 0}\n- RSI 門檻: < ${p1?.bluechip_max_rsi || 0}\n\n🔫 <b>新幣盲狙 (Meme)</b>\n- 最低流動性: $${p2?.min_liquidity || 0}\n- 5分量: $${p2?.min_vol_5m || 0}\n- 泡沫比: ${((p2?.min_liq_fdv_ratio || 0) * 100).toFixed(1)}%\n\n🌍 <b>宏觀環境</b>\n- AI 災難指數: ${cfg?.latest_news_score || 0}/100\n━━━━━━━━━━━━━━━━━━`;
        sendAdminAlert(msg);
    } catch (err) {
        console.error("❌ 無法獲取參數快照:", err.message);
    }
}

async function sendApprovalRequest(reportText, proposalId) {
    const token = ADMIN_BOT_TOKEN;
    const chat = ADMIN_CHAT_ID;
    const { supabase } = require('../config/supabase'); 
    
    if (!token || !chat) return;

    let finalReportText = reportText;

    try {
        const { data: proposal } = await supabase.from('ai_proposals').select('proposed_changes').eq('id', proposalId).single();
        if (proposal && proposal.proposed_changes) {
            const changes = typeof proposal.proposed_changes === 'string' ? JSON.parse(proposal.proposed_changes) : proposal.proposed_changes;
            let details = "\n━━━━━━━━━━━━━━━━━━\n🔍 <b>【具體變更預覽】</b>\n";
            let hasDetails = false;

            if (changes.target_prompt_id && changes.new_prompt_content) {
                details += `📝 <b>劇本更新:</b> [<code>${changes.target_prompt_id}</code>]\n`;
                const snippet = changes.new_prompt_content.replace(/</g, '＜').replace(/>/g, '＞').substring(0, 150);
                details += `<i>"...${snippet}..."</i>\n\n`;
                hasDetails = true;
            }

            if (changes.recommended_params) {
                if (changes.recommended_params.meme && Object.keys(changes.recommended_params.meme).length > 0) {
                    details += `🐶 <b>MEME 參數即將變更:</b>\n`;
                    for (const [key, value] of Object.entries(changes.recommended_params.meme)) details += `  ▪️ <code>${key}</code> ➡️ <b>${value}</b>\n`;
                    hasDetails = true;
                }
                if (changes.recommended_params.trending && Object.keys(changes.recommended_params.trending).length > 0) {
                    details += `🔥 <b>TRENDING 參數即將變更:</b>\n`;
                    for (const [key, value] of Object.entries(changes.recommended_params.trending)) details += `  ▪️ <code>${key}</code> ➡️ <b>${value}</b>\n`;
                    hasDetails = true;
                }
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

async function processTelegramCallback(callbackQuery) {
    const { supabase } = require('../config/supabase');
    const data = callbackQuery.data; 
    const messageId = callbackQuery.message.message_id;
    const chat = callbackQuery.message.chat.id;
    const token = ADMIN_BOT_TOKEN; 
    const isAutoSystem = callbackQuery.from?.first_name === "System_Auto"; // 🚀 識別是否為自動執法

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
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: "🗑️ <b>提案已否決。</b>", parse_mode: 'HTML' });
        } 
        else if (action === 'APPROVE') {
            const changes = typeof proposal.proposed_changes === 'string' ? JSON.parse(proposal.proposed_changes) : proposal.proposed_changes;
            // 🚀 根據觸發者改變開場白
            let successMsg = isAutoSystem 
                ? "⚡ <b>【系統自動執行】15 分鐘無異議，提案已自動套用！</b>\n"
                : "✅ <b>提案已批准並套用！</b>\n";

            if (proposal.proposal_type === 'MASTER_AI') {
                if (changes.target_prompt_id && changes.new_prompt_content) {
                    await supabase.from('bot_prompts').update({ content: changes.new_prompt_content, updated_at: new Date() }).eq('prompt_id', changes.target_prompt_id);
                    successMsg += `\n🧠 劇本 [${changes.target_prompt_id}] 已更新。`;
                }
                
                if (changes.recommended_params) {
                    const parseAllFields = (params) => {
                        const updates = {};
                        if (params.min_liquidity !== undefined) updates.min_liquidity = Number(params.min_liquidity);
                        if (params.min_vol_5m !== undefined) updates.min_vol_5m = Number(params.min_vol_5m);
                        if (params.stop_loss_pct !== undefined) updates.stop_loss_pct = Number(params.stop_loss_pct);
                        if (params.trailing_pullback !== undefined) updates.trailing_pullback = Number(params.trailing_pullback);
                        if (params.trailing_tp_trigger !== undefined) updates.trailing_tp_trigger = Number(params.trailing_tp_trigger);
                        return updates;
                    };

                    if (changes.recommended_params.meme) {
                        const memeUpdates = parseAllFields(changes.recommended_params.meme);
                        if (Object.keys(memeUpdates).length > 0) await supabase.from('ai_strategy_params').update(memeUpdates).eq('id', 2);
                    }
                    if (changes.recommended_params.trending) {
                        const trendUpdates = parseAllFields(changes.recommended_params.trending);
                        if (Object.keys(trendUpdates).length > 0) await supabase.from('ai_strategy_params').update(trendUpdates).eq('id', 3);
                    }
                    successMsg += `\n⚙️ 入場及風險參數已同步更新。`;
                }
            }

            if (proposal.proposal_type === 'BACKTEST') {
                if (changes.meme_params) await supabase.from('ai_strategy_params').update(changes.meme_params).eq('id', 2);
                if (changes.trending_params) await supabase.from('ai_strategy_params').update(changes.trending_params).eq('id', 3);
                successMsg += `\n🛡️ 每週回測最佳化參數已套用。`;
            }

            await supabase.from('ai_proposals').update({ status: 'APPROVED' }).eq('id', proposalId);
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: successMsg, parse_mode: 'HTML' });
        }

        // 移除 TG 按鈕 (如果係真 Message 先除)
        if (messageId && messageId !== 0) {
            await axios.post(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
                chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } 
            }).catch(e => {}); // Ignore error if message is old
        }

    } catch (err) {
        console.error("❌ [Telegram Callback Error]:", err.message);
    }
}

module.exports = { sendTelegramAlert, sendAdminAlert, sendParamSnapshot, safeHTML, sendApprovalRequest, processTelegramCallback };