// src/services/telegramService.js
const axios = require('axios');
const path = require('path');
const configEnv = require('../config/env');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 📈 交易戰報 Bot (Main)
const TRADE_BOT_TOKEN = configEnv.telegram.mainBotToken;
const TRADE_CHAT_ID = configEnv.telegram.channelId;

// ⚙️ 系統管理員 Bot (Admin)
const ADMIN_BOT_TOKEN = configEnv.telegram.adminBotToken;
const ADMIN_CHAT_ID = configEnv.telegram.chatId;

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
        await axios.post(url, { 
            chat_id: chatId, 
            text: finalMessage, 
            parse_mode: 'HTML' 
        });
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

async function sendTelegramAlert(message) {
    await _send(message, TRADE_BOT_TOKEN, TRADE_CHAT_ID);
}

async function sendAdminAlert(message) {
    const token = ADMIN_BOT_TOKEN || TRADE_BOT_TOKEN;
    const chat = ADMIN_CHAT_ID || TRADE_CHAT_ID;
    await _send(message, token, chat);
}

// ==========================================
// 🛡️ 健康看板 1 分鐘延遲防 Spam 系統
// ==========================================
let lastErrorState = "";
let errorStartTime = 0;
let hasAlertedError = false;

function checkSystemHealth() {
    const { healthMonitor } = require('./healthMonitor'); 
    const report = healthMonitor.getHealthReport();
    
    const lines = report.split('\n');
    const currentErrors = lines.filter(l => l.includes('🔴') || l.includes('🟡')).join('\n');
    
    if (currentErrors !== "") {
        // 有錯誤發生
        if (currentErrors !== lastErrorState) {
            // 新的錯誤，開始計時，不立即報警
            lastErrorState = currentErrors;
            errorStartTime = Date.now();
            hasAlertedError = false;
        } else if (!hasAlertedError && (Date.now() - errorStartTime > 60000)) {
            // 🚀 [新增] 相同錯誤持續超過 1 分鐘 -> 發送警報！
            const cleanReport = safeHTML(report);
            const alertMsg = `🚨 <b>【系統故障警告】偵測到持續 1 分鐘以上的異常！</b>\n請即刻檢查伺服器狀態！\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
            sendAdminAlert(alertMsg);
            hasAlertedError = true; // 標記已發送，防止每 20 秒洗版
        }
    } else {
        // 恢復全綠
        if (lastErrorState !== "") {
            if (hasAlertedError) {
                // 🚀 [新增] 如果之前有報警，依家好返，先至 send 恢復通知
                const cleanReport = safeHTML(report);
                const recoveryMsg = `✅ <b>【系統恢復正常】所有模組已穩定超過 1 分鐘！解除警報！</b>\n\n🩺 <b>當前看板狀態：</b>\n${cleanReport}`;
                sendAdminAlert(recoveryMsg);
            }
            // 清空狀態
            lastErrorState = "";
            errorStartTime = 0;
            hasAlertedError = false;
        }
    }
}

// 🚀 [新增] 每 20 秒 Check，滿足 60 秒條件先 Send
setInterval(checkSystemHealth, 20 * 1000);

async function sendParamSnapshot() {
    const { supabase } = require('../config/supabase');
    try {
        const { data: p1 } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
        const { data: p2 } = await supabase.from('ai_strategy_params').select('*').eq('id', 2).single();
        const { data: cfg } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();

        const msg = `\n📋 <b>當前系統參數快照</b>\n━━━━━━━━━━━━━━━━━━\n🏛️ <b>老幣防線 (Bluechip)</b>\n- 最低流動性: $${p1?.min_liquidity || 0}\n- 5分量: $${p1?.min_vol_5m || 0}\n- RSI 門檻: < ${p1?.bluechip_max_rsi || 0}\n\n🔫 <b>新幣盲狙 (Meme)</b>\n- 最低流動性: $${p2?.min_liquidity || 0}\n- 5分量: $${p2?.min_vol_5m || 0}\n- 泡沫比(Liq/FDV): ${((p2?.min_liq_fdv_ratio || 0) * 100).toFixed(1)}%\n\n🌍 <b>宏觀環境</b>\n- AI 災難指數: ${cfg?.latest_news_score || 0}/100\n━━━━━━━━━━━━━━━━━━`;
        sendAdminAlert(msg);
    } catch (err) {
        console.error("❌ 無法獲取參數快照:", err.message);
    }
}

// ==========================================
// 🛡️ V8.9 HITL 審批中樞 (Human-in-the-Loop)
// ==========================================

// 1. 發送帶有「批准/否決」按鈕的報告
async function sendApprovalRequest(reportText, proposalId) {
    const token = ADMIN_BOT_TOKEN || TRADE_BOT_TOKEN;
    const chat = ADMIN_CHAT_ID || TRADE_CHAT_ID;
    if (!token || !chat) return;

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
        await axios.post(url, { 
            chat_id: chat, 
            text: reportText, 
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        console.log(`📨 [Telegram] 審批請求已發送 (Proposal ID: ${proposalId})`);
    } catch (err) {
        console.error(`❌ [Telegram] 審批請求發送失敗:`, err.response?.data?.description || err.message);
    }
}

// 2. 處理 Telegram 傳回來的按鈕點擊 (Callback Query)
async function processTelegramCallback(callbackQuery) {
    const { supabase } = require('../config/supabase');
    const data = callbackQuery.data; 
    const messageId = callbackQuery.message.message_id;
    const chat = callbackQuery.message.chat.id;
    const token = ADMIN_BOT_TOKEN || TRADE_BOT_TOKEN;

    if (!data.startsWith('APPROVE_') && !data.startsWith('REJECT_')) return;

    const action = data.split('_')[0]; 
    const proposalId = data.replace(`${action}_`, '');

    try {
        const { data: proposal, error } = await supabase.from('ai_proposals').select('*').eq('id', proposalId).single();
        
        if (error || !proposal) {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: "⚠️ 找不到該提案。" });
            return;
        }

        if (proposal.status !== 'PENDING') {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: `⚠️ 提案狀態為 ${proposal.status}，無法重複處理。` });
            return;
        }

        if (action === 'REJECT') {
            await supabase.from('ai_proposals').update({ status: 'REJECTED' }).eq('id', proposalId);
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: "🗑️ <b>提案已否決。</b>", parse_mode: 'HTML' });
        } 
        else if (action === 'APPROVE') {
            // 🚀 重點：如果 proposed_changes 係 String，要先 parse 做 JSON
            const changes = typeof proposal.proposed_changes === 'string' ? JSON.parse(proposal.proposed_changes) : proposal.proposed_changes;
            let successMsg = "✅ <b>提案已批准並套用！</b>\n";

            if (proposal.proposal_type === 'MASTER_AI') {
                // 1. 更新 Prompt
                if (changes.target_prompt_id && changes.new_prompt_content) {
                    await supabase.from('bot_prompts').update({ content: changes.new_prompt_content, updated_at: new Date() }).eq('prompt_id', changes.target_prompt_id);
                    successMsg += `\n🧠 劇本 [${changes.target_prompt_id}] 已更新。`;
                }
                
                // 2. 更新入場參數 (全能解析版)
                if (changes.recommended_params) {
                    const parseAllFields = (params) => {
                        const updates = {};
                        if (params.min_liquidity !== undefined) updates.min_liquidity = Number(params.min_liquidity);
                        if (params.min_vol_5m !== undefined) updates.min_vol_5m = Number(params.min_vol_5m);
                        if (params.min_drop_pct !== undefined) updates.min_drop_pct = Number(params.min_drop_pct);
                        if (params.stop_loss_pct !== undefined) updates.stop_loss_pct = Number(params.stop_loss_pct);
                        if (params.min_liq_fdv_ratio !== undefined) updates.min_liq_fdv_ratio = Number(params.min_liq_fdv_ratio);
                        if (params.trailing_pullback !== undefined) updates.trailing_pullback = Number(params.trailing_pullback);
                        if (params.trailing_tp_trigger !== undefined) updates.trailing_tp_trigger = Number(params.trailing_tp_trigger);
                        return updates;
                    };

                    if (changes.recommended_params.meme) {
                        const memeUpdates = parseAllFields(changes.recommended_params.meme);
                        if (Object.keys(memeUpdates).length > 0) {
                            const { error: err2 } = await supabase.from('ai_strategy_params').update(memeUpdates).eq('id', 2);
                            if (err2) console.error("Update Meme Params Error:", err2);
                        }
                    }
                    if (changes.recommended_params.trending) {
                        const trendUpdates = parseAllFields(changes.recommended_params.trending);
                        if (Object.keys(trendUpdates).length > 0) {
                            const { error: err3 } = await supabase.from('ai_strategy_params').update(trendUpdates).eq('id', 3);
                            if (err3) console.error("Update Trending Params Error:", err3);
                        }
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

        // 移除按鈕
        await axios.post(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
            chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } 
        });

    } catch (err) {
        console.error("❌ [Telegram Callback Error]:", err.message);
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: `❌ 處理出錯: ${err.message}` });
    }
}

module.exports = { sendTelegramAlert, sendAdminAlert, sendParamSnapshot, safeHTML, sendApprovalRequest, processTelegramCallback };