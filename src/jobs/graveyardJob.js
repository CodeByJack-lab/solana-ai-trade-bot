// src/jobs/graveyardJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { connection } = require('../config/solana');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const axios = require('axios'); // 👈 [V8.2 核心改動] 引入 axios 輕量驗屍
const { 
    createBurnInstruction, 
    createCloseAccountInstruction, 
    getAssociatedTokenAddress
} = require('@solana/spl-token');
const configEnv = require('../config/env');

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

let wallet;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    
    if (rawKey) {
        if (rawKey.startsWith('[')) {
            const Uint8ArrayKey = Uint8Array.from(JSON.parse(rawKey));
            wallet = Keypair.fromSecretKey(Uint8ArrayKey);
        } else {
            const decodedKey = bs58.decode(rawKey);
            wallet = Keypair.fromSecretKey(decodedKey);
        }
        console.log(`🔑 [GraveyardJob] 劊子手錢包已掛載。準備接收退租 SOL: ${wallet.publicKey.toString()}`);
    } else {
        console.log(`❌ [GraveyardJob] env 中找不到 SOLANA_PRIVATE_KEY 變數。`);
    }
} catch (e) {
    console.error(`❌ [GraveyardJob] 錢包初始化失敗，無法執行火化:`, e.message);
}

const graveyardJob = {
    async incinerateOldTokens() {
        if (!wallet) {
            console.log('⚠️ [Graveyard] 找不到有效錢包，跳過火化程序。');
            return;
        }
        
        console.log(`\n======================================================`);
        console.log(`🪦 [Graveyard] 劊子手巡邏啟動：正在搜尋符合火化條件的死幣...`);
        console.log(`======================================================`);

        try {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            const { data: deadTokens, error } = await supabase
                .from('graveyard_pool')
                .select('*')
                .lte('created_at', threeDaysAgo);

            if (error) throw error;
            if (!deadTokens || deadTokens.length === 0) {
                console.log('  ✅ 墓地乾淨，暫時沒有需要火化的代幣。');
                console.log(`======================================================\n`);
                return;
            }

            // ==============================================================
            // 🚀 V8.2 升級：掟入 Jupiter V6 坐大巴，一次過批次驗屍！
            // ==============================================================
            const mintsToVerify = deadTokens.map(t => t.mint_address);
            console.log(`  📡 正在交由 Jupiter 批次驗屍 ${mintsToVerify.length} 隻代幣...`);
            
            let pricesMap = {};
            try {
                const ids = mintsToVerify.join(',');
                const res = await axios.get(`https://api.jup.ag/price/v2?ids=${ids}`, { timeout: 5000 });
                if (res.data && res.data.data) {
                    pricesMap = res.data.data;
                }
            } catch (err) {
                console.warn(`  ⚠️ 無法連接 Jupiter，預設全部維持死刑。`);
            }

            let burnedCount = 0;
            let revivedCount = 0;

            for (const token of deadTokens) {
                console.log(`\n  💀 [核實死刑] $${token.token_symbol} (${token.mint_address.substring(0,6)}...)`);

                try {
                    // 直接從 Jupiter 報價讀取結果
                    const dog = pricesMap[token.mint_address];

                    if (dog && dog.price > 0) {
                        console.log(`    ↳ 😇 [奇蹟生還] 仍有報價 ($${dog.price})，撤銷死刑，踢回觀察區！`);
                        await supabase.from('graveyard_pool').delete().eq('id', token.id);
                        revivedCount++;
                        continue;
                    }
                } catch (e) {
                    console.warn(`    ↳ ⚠️ [驗屍異常] Jupiter 無法獲取數據，預設維持死刑判決。`);
                }

                try {
                    const mintPubkey = new PublicKey(token.mint_address);
                    const ataAddress = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);

                    let amountRaw = "0";
                    let ataExists = false;

                    try {
                        const balanceInfo = await connection.getTokenAccountBalance(ataAddress);
                        amountRaw = balanceInfo.value.amount;
                        ataExists = true;
                    } catch (ataErr) {
                        console.log(`    ↳ 🗑️ [無鏈上資產] 找不到 ATA 帳戶，跳過鏈上火化，直接從墓地除名。`);
                    }

                    if (ataExists) {
                        const transaction = new Transaction();

                        if (parseInt(amountRaw) > 0) {
                            transaction.add(
                                createBurnInstruction(ataAddress, mintPubkey, wallet.publicKey, amountRaw)
                            );
                        }

                        transaction.add(
                            createCloseAccountInstruction(ataAddress, wallet.publicKey, wallet.publicKey)
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

                        console.log(`    ↳ 🔥 [火化成功] 代幣已銷毀，成功回收 ~0.002 SOL 租金！`);
                        console.log(`        🔗 Tx: https://solscan.io/tx/${signature}`);
                        burnedCount++;
                    }
                    
                    // 🚀 無論如何，確保在數據庫中刪除，防止死結
                    await supabase.from('graveyard_pool').delete().eq('id', token.id);

                } catch (burnErr) {
                    console.error(`    ↳ ❌ [執行錯誤] 火化失敗 (${token.token_symbol}):`, burnErr.message);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            console.log(`\n✅ [Graveyard] 🪦 本次清理作業完成！`);
            console.log(`  📊 統計：成功火化 ${burnedCount} 隻 | 奇蹟生還 ${revivedCount} 隻`);
            console.log(`======================================================\n`);
            
        } catch (err) {
            console.error('❌ [GraveyardJob] 巡邏發生致命錯誤:', err.message);
            console.log(`======================================================\n`);
        }
    },

    start() {
        cron.schedule('0 3 * * *', () => {
            this.incinerateOldTokens();
        });
        console.log('🕒 [GraveyardJob] 🪦 火化排程已啟動 (每晚凌晨 3 點執行, V8.2 Jupiter驅動)');
    }
};

module.exports = { graveyardJob };