// src/jobs/janitorJob.js
const cron = require('node-cron');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const path = require('path');

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

let wallet;
try {
    const rawKey = process.env.SOLANA_PRIVATE_KEY ? process.env.SOLANA_PRIVATE_KEY.trim() : null;
    if (rawKey) {
        wallet = rawKey.startsWith('[') 
            ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))) 
            : Keypair.fromSecretKey(bs58.decode(rawKey));
    }
} catch (e) {
    console.error("❌ [Janitor] 私鑰解析失敗");
}

const janitorJob = {
    async cleanEmptyAccounts() {
        if (!wallet) return;
        console.log('\n🧹 [Janitor] 清道夫啟動：掃描閒置超過 7 日的零餘額 ATA 帳戶...');

        try {
            // 1. 獲取錢包所有 Token Accounts
            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                programId: TOKEN_PROGRAM_ID
            });

            // 2. 篩選出餘額為 0 的帳戶
            const emptyAccounts = parsedTokenAccounts.value.filter(
                accInfo => accInfo.account.data.parsed.info.tokenAmount.uiAmount === 0
            );

            if (emptyAccounts.length === 0) {
                console.log('✅ [Janitor] 錢包極度乾淨，沒有零餘額的 ATA 帳戶。');
                return;
            }

            // 3. 執行 7 日冷卻期審查
            const sevenDaysAgoMs = Date.now() - (7 * 24 * 60 * 60 * 1000);
            const accountsToClose = [];

            for (const acc of emptyAccounts) {
                const mint = acc.account.data.parsed.info.mint;
                const ataPubkey = acc.pubkey;

                // 從資料庫尋找這隻幣的「最後一次實盤交易紀錄」
                const { data: recentTrade } = await supabase
                    .from('trade_history_live')
                    .select('created_at')
                    .eq('token_mint', mint)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                let shouldClose = false;
                if (!recentTrade) {
                    // 如果 Database 無紀錄 (可能係不知名 Airdrop 垃圾，或者極早期手動買賣)，直接判死刑
                    shouldClose = true;
                } else {
                    const lastTradeTime = new Date(recentTrade.created_at).getTime();
                    if (lastTradeTime < sevenDaysAgoMs) {
                        // 最後交易超過 7 日，無起色，關閉！
                        shouldClose = true;
                    }
                }

                if (shouldClose) {
                    accountsToClose.push(ataPubkey);
                }
            }

            if (accountsToClose.length === 0) {
                console.log('✅ [Janitor] 找到的 0 餘額帳戶都在 7 日觀察期內，暫不清理以節省未來開戶費。');
                return;
            }

            console.log(`🗑️ [Janitor] 找到 ${accountsToClose.length} 個超過 7 日的死水帳戶，準備批量回收租金...`);

            // 4. 批量執行 Close Account (打包交易慳 Gas，每張單最多塞 12 個 Close 指令)
            const chunkSize = 12;
            let recoveredSol = 0;

            for (let i = 0; i < accountsToClose.length; i += chunkSize) {
                const chunk = accountsToClose.slice(i, i + chunkSize);
                const transaction = new Transaction();

                for (const ataPubkey of chunk) {
                    transaction.add(
                        createCloseAccountInstruction(
                            new PublicKey(ataPubkey),
                            wallet.publicKey, // 租金退回地址
                            wallet.publicKey  // 權限擁有者
                        )
                    );
                }

                const latestBlockhash = await connection.getLatestBlockhash();
                transaction.recentBlockhash = latestBlockhash.blockhash;
                transaction.feePayer = wallet.publicKey;

                try {
                    const signature = await connection.sendTransaction(transaction, [wallet]);
                    await connection.confirmTransaction({
                        blockhash: latestBlockhash.blockhash,
                        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                        signature: signature
                    });
                    console.log(`✅ [Janitor] 成功回收 ${chunk.length} 個帳戶租金! Tx: ${signature}`);
                    recoveredSol += chunk.length * 0.002039;
                } catch (err) {
                    console.error(`❌ [Janitor] 批量回收失敗:`, err.message);
                }
            }

            if (recoveredSol > 0) {
                console.log(`💰 [Janitor] 本次掃地共為你回收了約 ${recoveredSol.toFixed(4)} SOL！`);
            }

        } catch (error) {
            console.error('❌ [Janitor] 清道夫執行發生錯誤:', error.message);
        }
    },

    start() {
        // 設定 Cron Job：每天凌晨 4 點執行 (避開 3 點 graveyardJob 同 0 點 AI 進化)
        cron.schedule('0 4 * * *', () => {
            this.cleanEmptyAccounts();
        });
        console.log('🧹 [Janitor] 清道夫排程已啟動 (每天凌晨 4:00 巡邏 0 餘額空殼帳戶)');
    }
};

module.exports = { janitorJob };