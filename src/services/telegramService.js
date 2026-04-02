// src/services/telegramService.js
// 📝 檔案功能用途：V9.2 Telegram 路由與通訊中心。純粹的「郵差」角色，負責防 429 訊息隊列 (Message Queue) 及解析 Webhook 按鈕回調並執行熱更新。

const axios = require('axios');
const config = require('../config/config');
const Redis = require('ioredis');

const MAIN_BOT_TOKEN = config.telegram.mainBotToken;
const ADMIN_BOT_TOKEN = config.telegram.adminBotToken;
const CHANNEL_ID = config.telegram.channelId;
const CHAT_ID = config.telegram.chatId;

const redis = new Redis(config.cache.redisUrl || process.env.REDIS_URL);

function safeHTML(text) {
    if (!text) return "";
    return text.toString().replace(/</g, '＜').replace(/>/g, '＞');
}

// ==========================================
// 🛡️ V9.2 防 429 訊息隊列 (Message Queue)
// ==========================================
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const { token, endpoint, payload, resolve, reject } = messageQueue.shift();
        try {
            const url = `https://api.telegram.org/bot${token}/${endpoint}`;
            const res = await axios.post(url, payload, { timeout: 10000 });
            if (resolve) resolve(res.data?.result);
        } catch (error) {
            console.error(`❌ [Telegram] 發送失敗: ${error.response?.data?.description || error.message}`);
            if (reject) reject(error);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    isProcessingQueue = false;
}

function enqueueMessage(token, endpoint, payload) {
    if (!token) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        messageQueue.push({ token, endpoint, payload, resolve, reject });
        processQueue();
    });
}

async function _send(message, token, targetChatId, pin = false, replyMarkup = null) {
    if (!token || !targetChatId) return null;

    let finalMessage = message;
    if (finalMessage.length > 4000) {
        finalMessage = finalMessage.substring(0, 4000) + "\n\n... ✂️ (報告過長，已由系統自動截斷)";
    }

    const payload = { chat_id: targetChatId, text: finalMessage, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const messageId = await enqueueMessage(token, 'sendMessage', payload).then(res => res?.message_id).catch(() => null);

    if (pin && messageId) {
        enqueueMessage(token, 'pinChatMessage', {
            chat_id: targetChatId, message_id: messageId, disable_notification: true
        }).catch(() => {}); 
    }
    
    return messageId;
}

async function sendTelegramAlert(message, pin = false) { await _send(message, MAIN_BOT_TOKEN, CHANNEL_ID, pin); }
async function sendAdminAlert(message, pin = false) { await _send(message, MAIN_BOT_TOKEN, CHAT_ID, pin); }
async function sendStrategyAlert(message, pin = false) { await _send(message, ADMIN_BOT_TOKEN, CHAT_ID, pin); }

// ==========================================
// 🚨 大市宏觀風控警報
// ==========================================
async function sendMacroPanicApproval(reason) {
    const { getPortfolio } = require('./portfolioService');
    const portfolio = getPortfolio();

    let snapshotText = "";
    let totalInvested = 0;
    
    if (portfolio && portfolio.positions && portfolio.positions.length > 0) {
        snapshotText += "\n\n📊 <b>【當前倉位快照】</b>\n";
        portfolio.positions.forEach(pos => {
            const invested = pos.quantity * pos.entry_price_sol;
            totalInvested += invested;
            snapshotText += `▪️ $${pos.token_symbol}: 投入 ${invested.toFixed(2)} SOL (${pos.strategy_type})\n`;
        });
        snapshotText += `\n💰 <b>總曝險資金:</b> ${totalInvested.toFixed(2)} SOL`;
    } else {
        snapshotText += "\n\n📊 <b>【當前倉位快照】</b>\n✅ 目前空倉，無曝險資金。";
    }

    // 🚀 文本修正：15 分鐘改為 3 分鐘
    const message = `🚨 <b>【大市宏觀熔斷警報】</b>\n\n⚠️ <b>觸發理由:</b>\n${reason}${snapshotText}\n\n🤖 <b>系統建議:</b> 大盤極度不穩，建議啟動全線市價強平防禦機制！請指揮官裁決：\n(⚠️ 註：若 3 分鐘內未作回應且大市未好轉，系統將自動接管並全平倉)`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ 批准全線強平 (市價逃生)", callback_data: `APPROVE_MACRO_SELL` }],
            [{ text: "❌ 忽視警告 (維持現狀)", callback_data: `REJECT_MACRO_SELL` }]
        ]
    };

    await _send(message, MAIN_BOT_TOKEN, CHAT_ID, true, keyboard);
    await redis.set('macro_panic_pending', Date.now().toString(), 'EX', 3600); 
}

async function sendApprovalRequest(reportText, proposalId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ 批准套用", callback_data: `APPROVE_${proposalId}` }, { text: "❌ 否決提案", callback_data: `REJECT_${proposalId}` }]
        ]
    };
    await _send(reportText, ADMIN_BOT_TOKEN, CHAT_ID, false, keyboard);
}

// ==========================================
// 🎮 Webhook 回調處理中心
// ==========================================
async function processTelegramCallback(callbackQuery) {
    const { supabase } = require('../config/supabase');
    const { cacheManager } = require('./cacheManager'); 
    const data = callbackQuery.data; 
    const messageId = callbackQuery.message.message_id;
    const chatId = callbackQuery.message.chat.id;
    const userName = callbackQuery.from?.first_name || "Boss";

    if (data === 'APPROVE_MACRO_SELL' || data === 'REJECT_MACRO_SELL') {
        const isProcessed = await redis.set(`tg_btn_lock:${messageId}`, '1', 'EX', 86400, 'NX');
        if (!isProcessed) return;

        await redis.del('macro_panic_pending');

        if (data === 'REJECT_MACRO_SELL') {
            await enqueueMessage(MAIN_BOT_TOKEN, 'editMessageText', {
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                text: callbackQuery.message.text + `\n\n🛡️ <b>結果:</b> 指揮官 ${userName} 已否決強平，維持現狀。`,
                reply_markup: { inline_keyboard: [] }
            });
            return;
        }

        if (data === 'APPROVE_MACRO_SELL') {
            await enqueueMessage(MAIN_BOT_TOKEN, 'editMessageText', {
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                text: callbackQuery.message.text + `\n\n🔥 <b>結果:</b> 指揮官 ${userName} 已批准！全線市價強平執行中...`,
                reply_markup: { inline_keyboard: [] }
            });

            const { getPortfolio } = require('./portfolioService');
            const { runSellPipeline } = require('./tradeService');
            const positions = getPortfolio().positions;

            for (const pos of positions) {
                const lockKey = `sell_lock:${pos.mint_address}`;
                const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                if (acquired) {
                    await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, "🚨 大市崩盤：指揮官核准全線強平", 1.0)
                        .finally(() => redis.del(lockKey));
                    await new Promise(r => setTimeout(r, 1000)); 
                }
            }
            return;
        }
    }

    let responseText = '';
    let isAIProposal = false;

    if (data === 'REJECT_ALL_PROP') {
        responseText = `❌ 已忽略 AI 提案。`;
        isAIProposal = true;
    } 
    else if (data.startsWith('APPROVE_ALL_')) {
        const climate = data.replace('APPROVE_ALL_', '');
        const isBear = climate === 'BEAR_PANIC';
        const isBull = climate === 'RAGING_BULL';
        
        const valTp1 = isBear ? 20.0 : (isBull ? 80.0 : 50.0);
        const valSl = isBear ? -10.0 : (isBull ? -20.0 : -15.0);
        const valTip = isBear ? 0.5 : (isBull ? 5.0 : 2.0);

        await supabase.from('ai_strategy_params').update({ tp_level_1_pct: valTp1, stop_loss_pct: valSl, max_buy_tip_pct: valTip }).in('id', [2, 3]);
        cacheManager.updateLocally('MEME', { tp_level_1_pct: valTp1, stop_loss_pct: valSl, max_buy_tip_pct: valTip });
        cacheManager.updateLocally('TRENDING', { tp_level_1_pct: valTp1, stop_loss_pct: valSl, max_buy_tip_pct: valTip });
        
        await supabase.from('system_config').update({ status_msg: `切換至 ${climate} 模式` }).eq('id', 1);
        responseText = `✅ 已批准全套 ${climate} 戰略！`;
        isAIProposal = true;
    }
    else if (data.startsWith('APPROVE_TP1_')) {
        const val = parseFloat(data.replace('APPROVE_TP1_', ''));
        await supabase.from('ai_strategy_params').update({ tp_level_1_pct: val }).in('id', [2, 3]);
        cacheManager.updateLocally('MEME', { tp_level_1_pct: val });
        cacheManager.updateLocally('TRENDING', { tp_level_1_pct: val });
        responseText = `✅ 已更新第一階止盈為 ${val}%`;
        isAIProposal = true;
    }
    else if (data.startsWith('APPROVE_SL_')) {
        const val = parseFloat(data.replace('APPROVE_SL_', ''));
        await supabase.from('ai_strategy_params').update({ stop_loss_pct: val }).in('id', [2, 3]);
        cacheManager.updateLocally('MEME', { stop_loss_pct: val });
        cacheManager.updateLocally('TRENDING', { stop_loss_pct: val });
        responseText = `✅ 已更新硬止損為 ${val}%`;
        isAIProposal = true;
    }
    else if (data.startsWith('APPROVE_TIP_')) {
        const val = parseFloat(data.replace('APPROVE_TIP_', ''));
        await supabase.from('ai_strategy_params').update({ max_buy_tip_pct: val }).in('id', [2, 3]);
        cacheManager.updateLocally('MEME', { max_buy_tip_pct: val });
        cacheManager.updateLocally('TRENDING', { max_buy_tip_pct: val });
        responseText = `✅ 已更新買入小費上限為 ${val}%`;
        isAIProposal = true;
    }

    if (isAIProposal) {
        await enqueueMessage(MAIN_BOT_TOKEN, 'editMessageText', {
            chat_id: chatId, message_id: messageId,
            text: `${callbackQuery.message.text}\n\n<b>[執行結果]</b>\n${responseText}\n(操作者: ${userName})`,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
        });
        await enqueueMessage(MAIN_BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: callbackQuery.id });
        return;
    }

    if (data.startsWith('APPROVE_') || data.startsWith('REJECT_')) {
        const isProcessed = await redis.set(`tg_btn_lock:${messageId}`, '1', 'EX', 86400, 'NX');
        if (!isProcessed) return;
        const isApprove = data.startsWith('APPROVE_');
        await enqueueMessage(ADMIN_BOT_TOKEN, 'editMessageText', {
            chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
            text: callbackQuery.message.text + `\n\n🛡️ <b>結果:</b> 指揮官 ${userName} 已${isApprove ? '批准' : '否決'}提案。`,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

module.exports = { sendTelegramAlert, sendAdminAlert, sendStrategyAlert, safeHTML, sendMacroPanicApproval, sendApprovalRequest, processTelegramCallback, enqueueMessage, MAIN_BOT_TOKEN, CHAT_ID };