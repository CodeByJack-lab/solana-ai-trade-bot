// src/services/walletMonitor.js
// 📝 檔案功能用途：V9.1 獨立錢包出入金監控中心。專門接收 Alchemy Webhook 的 Native Transfer，執行金主流水記帳與 Telegram 廣播。

const express = require('express');
const { handleIncomingFund, handleOutgoingFund } = require('./tradeService');
const config = require('../config/config');
const { healthMonitor } = require('./healthMonitor');

const router = express.Router();
const botWallet = config.solana.walletPublicKey;

router.post('/webhook/alchemy', async (req, res) => {
    res.status(200).send('OK'); // 快速回覆 Alchemy，避免 Webhook 逾時斷線
    
    try {
        const events = Array.isArray(req.body) ? req.body : [req.body];
        healthMonitor.setStatus('Wallet_Radar', '🟢 接收到 Alchemy Webhook');

        for (const event of events) {
            // Alchemy Native Transfer 事件通常位於 event.activity 下
            const activities = (event.event && event.event.activity) ? event.event.activity : event.nativeTransfers;
            
            if (!activities || !Array.isArray(activities)) continue;

            for (const act of activities) {
                const fromAcc = act.fromAddress || act.fromUserAccount;
                const toAcc = act.toAddress || act.toUserAccount;
                
                // Alchemy API 通常將 Native Transfer 的 value 直接轉換為 SOL (非 lamports)
                const amountSol = parseFloat(act.value || act.amount || 0);
                const txid = event.signature || act.hash || 'alchemy_tx';

                if (amountSol <= 0) continue;

                // 判斷是否為金主入金
                if (toAcc === botWallet) {
                    await handleIncomingFund(fromAcc, amountSol, txid);
                } 
                // 判斷是否為金主提款 (排除與系統合約如 Jupiter 等的互動，只抓轉出給長地址的交易)
                else if (fromAcc === botWallet && toAcc.length > 32) {
                    await handleOutgoingFund(toAcc, amountSol, txid);
                }
            }
        }
    } catch (err) {
        console.error(`❌ [WalletMonitor] 解析 Alchemy Webhook 發生錯誤: ${err.message}`);
        healthMonitor.setStatus('Wallet_Radar', `🔴 解析錯誤: ${err.message}`);
    }
});

module.exports = { walletMonitorRouter: router };