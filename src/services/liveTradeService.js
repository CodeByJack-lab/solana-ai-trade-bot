// src/services/liveTradeService.js
const { Keypair, VersionedTransaction, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase'); // 🚀 引入 Supabase 以讀取動態設定
const axios = require('axios');
const path = require('path');
const { healthMonitor } = require('./healthMonitor'); 

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// 💸 Jito 官方小費收集地址
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg",
    "DfXygSm4jcyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjv",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7QsBgTysiEwCAQtbNheJ4sBE",
    "3AVi9Tg9Uao68XNwNmtcwEdqvLhATCq0MExeb1Z51vtv"
];

let wallet;
try {
    const rawKey = process.env.SOLANA_PRIVATE_KEY ? process.env.SOLANA_PRIVATE_KEY.trim() : null;
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            const Uint8ArrayKey = Uint8Array.from(JSON.parse(rawKey));
            wallet = Keypair.fromSecretKey(Uint8ArrayKey);
        } else {
            const decodedKey = bs58.decode(rawKey);
            wallet = Keypair.fromSecretKey(decodedKey);
        }
        console.log(`🔑 [Live Engine] 錢包已掛載。地址: ${wallet.publicKey.toString()}`);
        healthMonitor.setStatus('Live_Engine', '🟢 錢包已掛載 (待命)'); 
    } else {
        healthMonitor.setStatus('Live_Engine', '🟡 模擬模式 (無私鑰)'); 
    }
} catch (err) {
    healthMonitor.setStatus('Live_Engine', `🔴 私鑰解析失敗`); 
}

async function getJupiterSwapTransaction(quoteResponse) {
    try {
        if (!wallet) return null;
        const baseUrl = (process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag').replace(/\/$/, '');
        const endpoint = baseUrl.includes('quote-api') ? '/v6/swap' : '/swap/v1/swap';
        
        const config = { headers: {} };
        if (process.env.JUPITER_API_KEY) {
            config.headers['x-api-key'] = process.env.JUPITER_API_KEY.replace(/['"]/g, '').trim();
        }

        const response = await axios.post(`${baseUrl}${endpoint}`, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true, 
            dynamicComputeUnitLimit: true, 
            prioritizationFeeLamports: "auto" 
        }, config);

        return response.data.swapTransaction;
    } catch (err) {
        console.error(`❌ [Jupiter Swap] 構建交易失敗:`, err.response?.data?.error || err.message);
        return null;
    }
}

async function executeLiveSwapUAT(quoteResponse, action) {
    if (!wallet) return { success: false, txid: null };

    console.log(`\n⚡ [Live Execution] 正在向 Jupiter 請求構建 ${action} 交易...`);
    healthMonitor.setStatus('Live_Engine', `🟢 構建 ${action} 交易中...`); 

    const swapTransactionBase64 = await getJupiterSwapTransaction(quoteResponse);
    if (!swapTransactionBase64) {
        healthMonitor.setStatus('Live_Engine', '🔴 構建交易失敗'); 
        return { success: false, txid: null };
    }

    try {
        const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`🔬 [Pre-flight Check] 正在本地模擬交易...`);
        const simulationResult = await connection.simulateTransaction(transaction);
        if (simulationResult.value.err) {
            console.error(`❌ [Pre-flight Failed] 模擬失敗:`, JSON.stringify(simulationResult.value.err));
            healthMonitor.setStatus('Live_Engine', '🔴 模擬交易失敗'); 
            return { success: false, txid: null };
        } 
        
        console.log(`✅ [Pre-flight Success] 模擬通過，準備打包 Jito Bundle...`);
        healthMonitor.setStatus('Live_Engine', '🟢 送出 Jito Bundle 中...'); 

        // 🚀 核心修正：從 Database 讀取動態小費
        let dynamicTip = 100000; // 預設 0.0001 SOL
        try {
            const { data: config } = await supabase.from('system_config').select('jito_tip_lamports').eq('id', 1).single();
            if (config && config.jito_tip_lamports) {
                dynamicTip = Number(config.jito_tip_lamports);
                console.log(`💸 [Jito Tip] 使用動態小費設定: ${dynamicTip} lamports`);
            }
        } catch (dbErr) {
            console.warn(`⚠️ [Jito Tip] 無法讀取 DB 設定，使用保底 100000 lamports`);
        }

        const latestBlockHash = await connection.getLatestBlockhash();
        const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
        
        const tipTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: tipAccount,
                lamports: dynamicTip, // 🚀 改為動態數值
            })
        );
        tipTx.recentBlockhash = latestBlockHash.blockhash;
        tipTx.feePayer = wallet.publicKey;
        tipTx.sign(wallet);

        const serializedSwapTx = bs58.encode(transaction.serialize());
        const serializedTipTx = bs58.encode(tipTx.serialize());

        const jitoUrl = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
        const jitoResponse = await axios.post(jitoUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [ [serializedSwapTx, serializedTipTx] ]
        }, { headers: { 'Content-Type': 'application/json' } });

        const bundleId = jitoResponse.data.result;
        console.log(`✅ [Jito Success] Bundle 已成功送出！Bundle ID: ${bundleId}`);

        const txid = bs58.encode(transaction.signatures[0]);
        console.log(`🔗 追蹤連結: https://solscan.io/tx/${txid}`);

        console.log(`⏳ 等待區塊鏈確認...`);
        await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid
        });
        
        console.log(`🎉 [Live Trade] ${action} 交易已在鏈上確認！`);
        healthMonitor.setStatus('Live_Engine', `🟢 交易確認成功`); 
        setTimeout(() => healthMonitor.setStatus('Live_Engine', '🟢 錢包已掛載 (待命)'), 5000); 
        
        return { success: true, txid: txid }; 

    } catch (err) {
        console.error(`❌ [Live Execution] 發送或確認時發生錯誤:`, err.response?.data || err.message);
        healthMonitor.setStatus('Live_Engine', '🔴 交易確認超時或失敗'); 
        return { success: false, txid: null };
    }
}

module.exports = { executeLiveSwapUAT };