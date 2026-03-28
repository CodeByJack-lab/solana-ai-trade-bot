// src/jobs/graveyardJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { connection } = require('../config/solana');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const axios = require('axios'); 
const { createBurnInstruction, createCloseAccountInstruction, getAssociatedTokenAddress } = require('@solana/spl-token');
const configEnv = require('../config/env');

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

let wallet;
try {
    const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
    if (rawKey) {
        wallet = rawKey.startsWith('[') ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))) : Keypair.fromSecretKey(bs58.decode(rawKey));
        console.log(`🔑 [GraveyardJob] 劊子手錢包已掛載。`);
    }
} catch (e) {
    console.error(`❌ [GraveyardJob] 錢包初始化失敗:`, e.message);
}

// 🧠 斷路器：紀錄每隻 API 嘅冷卻到期時間 (Timestamp)
const apiCooldowns = {
    geckoTerminal: 0,
    jupiterV3: 0,
    jupiterV6: 0
};

function isApiAvailable(apiName) {
    return Date.now() > apiCooldowns[apiName];
}

function markApiFailed(apiName) {
    console.warn(`🚨 [Graveyard Fallback] ${apiName} 發生故障，觸發斷路器 (60秒冷卻)！`);
    apiCooldowns[apiName] = Date.now() + 60000;
}

const graveyardJob = {
    async incinerateOldTokens() {
        if (!wallet) return;
        console.log(`\n======================================================`);
        console.log(`🪦 [Graveyard] 劊子手巡邏啟動：搜尋死幣...`);

        try {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            const { data: deadTokens, error } = await supabase.from('graveyard_pool').select('*').lte('created_at', threeDaysAgo);

            if (error) throw error;
            if (!deadTokens || deadTokens.length === 0) {
                console.log('  ✅ 墓地乾淨，暫無死幣。');
                return;
            }

            const mintsToVerify = deadTokens.map(t => t.mint_address);
            console.log(`  📡 正在交由 瀑布備援系統 批次驗屍 ${mintsToVerify.length} 隻代幣...`);
            
            const ids = mintsToVerify.join(',');
            let pricesMap = {};
            let fetchSuccess = false;

            // 🛡️ 路線 1: GeckoTerminal
            if (!fetchSuccess && isApiAvailable('geckoTerminal')) {
                try {
                    const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${ids}`, { timeout: 5000 });
                    const pricesObj = res.data?.data?.attributes?.token_prices;
                    if (pricesObj) {
                        for (const [mint, priceStr] of Object.entries(pricesObj)) {
                            if (priceStr) pricesMap[mint] = { price: parseFloat(priceStr) };
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('geckoTerminal'); }
            }

            // 🛡️ 路線 2: Jupiter V3
            if (!fetchSuccess && isApiAvailable('jupiterV3') && configEnv.external.jupiterApiKey) {
                try {
                    const jupConfig = { timeout: 5000, headers: { 'x-api-key': configEnv.external.jupiterApiKey.replace(/['"]/g, '').trim() } };
                    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${ids}`, jupConfig);
                    if (res.data) {
                        for (const [mint, info] of Object.entries(res.data)) {
                            if (info.usdPrice) pricesMap[mint] = { price: parseFloat(info.usdPrice) };
                        }
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV3'); }
            }

            // 🛡️ 路線 3: Jupiter V6
            if (!fetchSuccess && isApiAvailable('jupiterV6')) {
                try {
                    const res = await axios.get(`https://price.jup.ag/v6/price?ids=${ids}`, { timeout: 5000 });
                    if (res.data?.data) {
                        pricesMap = res.data.data;
                        fetchSuccess = true;
                    }
                } catch (e) { markApiFailed('jupiterV6'); }
            }

            if (!fetchSuccess) {
                console.warn(`  ⚠️ 無法連接任何報價 API，預設全維持死刑。`);
            }

            let burnedCount = 0;
            let revivedCount = 0;

            for (const token of deadTokens) {
                console.log(`\n  💀 [核實死刑] $${token.token_symbol}`);
                try {
                    const dog = pricesMap[token.mint_address];
                    if (dog && dog.price > 0) {
                        console.log(`    ↳ 😇 [奇蹟生還] 仍有報價 ($${dog.price})，撤銷死刑！`);
                        await supabase.from('graveyard_pool').delete().eq('id', token.id);
                        revivedCount++;
                        continue;
                    }
                } catch (e) {}

                try {
                    const mintPubkey = new PublicKey(token.mint_address);
                    const ataAddress = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
                    let amountRaw = "0"; let ataExists = false;

                    try {
                        const balanceInfo = await connection.getTokenAccountBalance(ataAddress);
                        amountRaw = balanceInfo.value.amount;
                        ataExists = true;
                    } catch (ataErr) {}

                    if (ataExists) {
                        const transaction = new Transaction();
                        if (parseInt(amountRaw) > 0) transaction.add(createBurnInstruction(ataAddress, mintPubkey, wallet.publicKey, amountRaw));
                        transaction.add(createCloseAccountInstruction(ataAddress, wallet.publicKey, wallet.publicKey));

                        const latestBlockhash = await connection.getLatestBlockhash();
                        transaction.recentBlockhash = latestBlockhash.blockhash;
                        transaction.feePayer = wallet.publicKey;

                        const signature = await connection.sendTransaction(transaction, [wallet]);
                        await connection.confirmTransaction({ blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, signature: signature });
                        
                        console.log(`    ↳ 🔥 [火化成功] 成功回收 ~0.002 SOL！ Tx: ${signature}`);
                        burnedCount++;
                    }
                    await supabase.from('graveyard_pool').delete().eq('id', token.id);
                } catch (burnErr) {
                    console.error(`    ↳ ❌ [執行錯誤] 火化失敗:`, burnErr.message);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            console.log(`\n✅ [Graveyard] 🪦 本次清理作業完成！火化 ${burnedCount} 隻 | 生還 ${revivedCount} 隻\n`);
        } catch (err) { console.error('❌ [GraveyardJob] 巡邏致命錯誤:', err.message); }
    },
    start() {
        cron.schedule('0 3 * * *', () => { this.incinerateOldTokens(); });
        console.log('🕒 [GraveyardJob] 🪦 火化排程已啟動 (每晚凌晨 3 點執行)');
    }
};

module.exports = { graveyardJob };