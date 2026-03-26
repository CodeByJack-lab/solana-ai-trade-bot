// src/jobs/graveyardJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { connection } = require('../config/solana');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { 
    createBurnInstruction, 
    createCloseAccountInstruction, 
    getAssociatedTokenAddress
} = require('@solana/spl-token');
const axios = require('axios');
const path = require('path');

let bs58 = require('bs58');
if (bs58.default) {
    bs58 = bs58.default;
}

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

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
        console.log(`🔑 [GraveyardJob] 劊子手錢包已掛載。準備接收退租 SOL: ${wallet.publicKey.toString()}`);
    } else {
        console.log(`❌ [GraveyardJob] .env 中找不到 SOLANA_PRIVATE_KEY 變數。`);
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
        console.log('\n🔥 [Graveyard] 劊子手巡邏中：正在搜尋符合火化條件的死幣...');

        try {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            const { data: deadTokens, error } = await supabase
                .from('graveyard_pool')
                .select('*')
                .lte('created_at', threeDaysAgo);

            if (error) throw error;
            if (!deadTokens || deadTokens.length === 0) {
                console.log('✅ [Graveyard] 暫時沒有需要火化的代幣。');
                return;
            }

            for (const token of deadTokens) {
                console.log(`💀 [Graveyard] 正在核實 ${token.token_symbol} (${token.mint_address}) 的死刑...`);

                try {
                    const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token.mint_address}`);
                    const pair = dexRes.data?.pairs?.find(p => p.chainId === 'solana');
                    const liquidity = pair?.liquidity?.usd || 0;

                    if (liquidity > 500) {
                        console.log(`😇 [Graveyard] ${token.token_symbol} 流動性已恢復 ($${liquidity})，撤銷死刑，踢回觀察區！`);
                        await supabase.from('graveyard_pool').delete().eq('id', token.id);
                        continue;
                    }
                } catch (e) {
                    console.warn(`⚠️ [Graveyard] 無法連接 DexScreener 驗屍，預設維持死刑判決。`);
                }

                try {
                    const mintPubkey = new PublicKey(token.mint_address);
                    const ataAddress = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);

                    let amountRaw = "0";
                    let ataExists = false;

                    // 🚀 Phase 3 核心修復：防止因無帳戶導致卡死迴圈
                    try {
                        const balanceInfo = await connection.getTokenAccountBalance(ataAddress);
                        amountRaw = balanceInfo.value.amount;
                        ataExists = true;
                    } catch (ataErr) {
                        console.warn(`⚠️ [Graveyard] 找不到 ATA 帳戶 (${token.token_symbol})，跳過鏈上火化，直接從墓地除名。`);
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

                        console.log(`🔥 [Graveyard] 火化成功！${token.token_symbol} 已消滅，0.002 SOL 租金已回流。Tx: ${signature}`);
                    }
                    
                    // 🚀 無論如何，確保在數據庫中刪除，防止死結
                    await supabase.from('graveyard_pool').delete().eq('id', token.id);

                } catch (burnErr) {
                    console.error(`❌ [Graveyard] 執行火化時發生無法預期的錯誤 (${token.token_symbol}):`, burnErr.message);
                }
            }
        } catch (err) {
            console.error('❌ [GraveyardJob] 巡邏發生致命錯誤:', err.message);
        }
    },

    start() {
        cron.schedule('0 3 * * *', () => {
            this.incinerateOldTokens();
        });
        console.log('🕒 [GraveyardJob] 火化排程已啟動 (每晚凌晨 3 點執行)');
    }
};

module.exports = { graveyardJob };