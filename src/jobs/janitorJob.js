// src/jobs/janitorJob.js
const cron = require('node-cron');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const configEnv = require('../config/config'); 
const { healthMonitor } = require('../services/healthMonitor'); // 🛠️ [修復] 補返引入 healthMonitor

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

let wallet;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    if (rawKey) {
        wallet = rawKey.startsWith('[') 
            ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))) 
            : Keypair.fromSecretKey(bs58.decode(rawKey));
    }
} catch (e) {
    console.error("❌ [Janitor] 私鑰解析失敗");
}

const janitorJob = {
    // 🧹 任務 1：清理 0 餘額空殼帳戶 (回收 SOL)
    async cleanEmptyAccounts() {
        if (!wallet) return;
        console.log('\n🧹 [Janitor] 任務 1：掃描閒置超過 7 日的零餘額 ATA 帳戶...');

        try {
            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                programId: TOKEN_PROGRAM_ID
            });

            const emptyAccounts = parsedTokenAccounts.value.filter(
                accInfo => accInfo.account.data.parsed.info.tokenAmount.uiAmount === 0
            );

            if (emptyAccounts.length === 0) {
                console.log('✅ [Janitor] 錢包極度乾淨，沒有零餘額的 ATA 帳戶。');
                return;
            }

            const sevenDaysAgoMs = Date.now() - (7 * 24 * 60 * 60 * 1000);
            const accountsToClose = [];

            const mints = emptyAccounts.map(acc => acc.account.data.parsed.info.mint);
            let allTrades = [];
            
            for (let i = 0; i < mints.length; i += 50) {
                const chunk = mints.slice(i, i + 50);
                const { data } = await supabase
                    .from('trade_history_live')
                    .select('token_mint, created_at')
                    .in('token_mint', chunk);
                if (data) allTrades = allTrades.concat(data);
            }

            const latestTradeMap = {};
            for (const t of allTrades) {
                const tradeTime = new Date(t.created_at).getTime();
                if (!latestTradeMap[t.token_mint] || tradeTime > latestTradeMap[t.token_mint]) {
                    latestTradeMap[t.token_mint] = tradeTime;
                }
            }

            for (const acc of emptyAccounts) {
                const mint = acc.account.data.parsed.info.mint;
                const ataPubkey = acc.pubkey;

                const lastTradeTime = latestTradeMap[mint];
                let shouldClose = false;

                if (!lastTradeTime) {
                    shouldClose = true; 
                } else if (lastTradeTime < sevenDaysAgoMs) {
                    shouldClose = true; 
                }

                if (shouldClose) accountsToClose.push(ataPubkey);
            }

            if (accountsToClose.length === 0) {
                console.log('✅ [Janitor] 找到的 0 餘額帳戶都在 7 日觀察期內，暫不清理以節省未來開戶費。');
                return;
            }

            console.log(`🗑️ [Janitor] 找到 ${accountsToClose.length} 個超過 7 日的死水帳戶，準備批量回收租金...`);

            const chunkSize = 12;
            let recoveredSol = 0;

            for (let i = 0; i < accountsToClose.length; i += chunkSize) {
                const chunk = accountsToClose.slice(i, i + chunkSize);
                const transaction = new Transaction();

                for (const ataPubkey of chunk) {
                    transaction.add(
                        createCloseAccountInstruction(
                            new PublicKey(ataPubkey),
                            wallet.publicKey, 
                            wallet.publicKey  
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
            console.error('❌ [Janitor] 清道夫執行 ATA 回收發生錯誤:', error.message);
        }
    },

    // 🚀 [V8.2 新增] 任務 2：清理保溫箱 (Trending Pool) 超過 7 日無更新的過氣代幣
    async cleanIncubatorPool() {
        console.log('\n🧹 [Janitor] 任務 2：掃描並清理「高潛力保溫箱」內超過 7 日的過氣代幣...');
        try {
            const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
            
            const { error, count } = await supabase
                .from('trending_pool')
                .delete({ count: 'exact' })
                .lt('updated_at', sevenDaysAgo);

            if (error) throw error;

            if (count && count > 0) {
                console.log(`✅ [Janitor] 成功從保溫箱中淘汰了 ${count} 隻過氣代幣！`);
            } else {
                console.log(`✅ [Janitor] 保溫箱內無過期代幣，狀態健康。`);
            }
        } catch (err) {
            console.error('❌ [Janitor] 清理保溫箱發生錯誤:', err.message);
        }
    },

    // 💎 [V9.2 新增] 任務 3：WSOL 碎石解包機 (自動將卡住嘅 WSOL 轉回原生 SOL)
    async cleanWrappedSol() {
        if (!wallet) return;
        console.log('\n🔨 [Janitor] 任務 3：檢查並解包積壓的 WSOL 碎石...');
        try {
            const WSOL_MINT = 'So11111111111111111111111111111111111111112';
            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                mint: new PublicKey(WSOL_MINT)
            });

            if (parsedTokenAccounts.value.length === 0) {
                console.log('✅ [Janitor] 錢包內沒有 WSOL 帳戶。');
                return;
            }

            for (const accInfo of parsedTokenAccounts.value) {
                const uiAmount = accInfo.account.data.parsed.info.tokenAmount.uiAmount;
                const ataPubkey = accInfo.pubkey;

                // 只要積壓超過 0.01 WSOL，就果斷砸碎解包
                if (uiAmount > 0.01) {
                    console.log(`🚨 [Janitor] 發現積壓的 WSOL (${uiAmount} WSOL)，準備砸碎解包為原生 SOL...`);
                    
                    const transaction = new Transaction().add(
                        createCloseAccountInstruction(
                            new PublicKey(ataPubkey), // 要關閉的 WSOL ATA
                            wallet.publicKey,         // 接收原生 SOL (本金+租金) 的地址
                            wallet.publicKey          // 帳戶擁有人
                        )
                    );

                    const latestBlockhash = await connection.getLatestBlockhash();
                    transaction.recentBlockhash = latestBlockhash.blockhash;
                    transaction.feePayer = wallet.publicKey;

                    const signature = await connection.sendTransaction(transaction, [wallet]);
                    await connection.confirmTransaction({
                        blockhash: latestBlockhash.blockhash,
                        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                        signature: signature
                    });
                    console.log(`✅ [Janitor] WSOL 碎石解包成功！已轉回原生 SOL。Tx: ${signature}`);
                } else if (uiAmount === 0) {
                    // 如果係 0 餘額，由任務 1 去處理 (等待 7 日後回收租金)
                } else {
                    console.log(`✅ [Janitor] WSOL 餘額為 ${uiAmount}，未達 0.01 門檻，暫不解包。`);
                }
            }
        } catch (err) {
            console.error('❌ [Janitor] 解包 WSOL 發生錯誤:', err.message);
        }
    },

    start() {
        // 舊有排程：每天凌晨 4:00 執行深度清理 (任務 1 & 2)
        cron.schedule('0 4 * * *', async () => {
            await this.cleanEmptyAccounts();
            await this.cleanIncubatorPool();
            console.log(`\n✅ [Janitor] 每日清晨 4:00 巡邏作業全數完成！`);
        });

        // 💎 V9.2 新排程：每 4 小時獨立執行一次 WSOL 碎石解包 (任務 3)
        cron.schedule('0 */4 * * *', async () => {
            await this.cleanWrappedSol();
        });

        console.log('🧹 [Janitor] 清道夫排程已啟動 (每日 4:00 深度清理 + 每 4 小時 WSOL 解包)');
        healthMonitor.setStatus('Janitor_Service', '🟢 待命 (多重排程)');
    }
};

module.exports = { janitorJob };