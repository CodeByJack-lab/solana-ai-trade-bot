// src/jobs/janitorJob.js
const cron = require('node-cron');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const configEnv = require('../config/config'); 
const { healthMonitor } = require('../services/healthMonitor'); 
const { getPortfolio } = require('../services/portfolioService'); // 🛡️ 引入 Portfolio 檢查模式
const { sendAdminAlert } = require('../services/telegramService'); // 🛡️ 引入 Telegram 警報
const axios = require('axios'); // 🛡️ 用於查價

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

    // 🚀 任務 2：清理保溫箱
    async cleanIncubatorPool() {
        console.log('\n🧹 [Janitor] 任務 2：掃描並清理「高潛力保溫箱」內超過 7 日的過氣代幣...');
        try {
            const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
            const { error, count } = await supabase.from('trending_pool').delete({ count: 'exact' }).lt('updated_at', sevenDaysAgo);
            if (!error && count > 0) console.log(`✅ [Janitor] 成功從保溫箱中淘汰了 ${count} 隻過氣代幣！`);
            else console.log(`✅ [Janitor] 保溫箱內無過期代幣，狀態健康。`);
        } catch (err) { console.error('❌ [Janitor] 清理保溫箱發生錯誤:', err.message); }
    },

    // 💎 任務 3：WSOL 碎石解包機
    async cleanWrappedSol() {
        if (!wallet) return;
        console.log('\n🔨 [Janitor] 任務 3：檢查並解包積壓的 WSOL 碎石...');
        try {
            const WSOL_MINT = 'So11111111111111111111111111111111111111112';
            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(WSOL_MINT) });

            if (parsedTokenAccounts.value.length === 0) return console.log('✅ [Janitor] 錢包內沒有 WSOL 帳戶。');

            for (const accInfo of parsedTokenAccounts.value) {
                const uiAmount = accInfo.account.data.parsed.info.tokenAmount.uiAmount;
                const ataPubkey = accInfo.pubkey;

                if (uiAmount > 0.01) {
                    console.log(`🚨 [Janitor] 發現積壓的 WSOL (${uiAmount} WSOL)，準備砸碎解包為原生 SOL...`);
                    const transaction = new Transaction().add(
                        createCloseAccountInstruction(new PublicKey(ataPubkey), wallet.publicKey, wallet.publicKey)
                    );
                    const latestBlockhash = await connection.getLatestBlockhash();
                    transaction.recentBlockhash = latestBlockhash.blockhash;
                    transaction.feePayer = wallet.publicKey;

                    const signature = await connection.sendTransaction(transaction, [wallet]);
                    await connection.confirmTransaction({ blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, signature });
                    console.log(`✅ [Janitor] WSOL 解包成功！Tx: ${signature}`);
                }
            }
        } catch (err) { console.error('❌ [Janitor] 解包 WSOL 錯誤:', err.message); }
    },

    // 👻 [V9.2 終極修復] 任務 4：幽靈持倉實體對帳 (Ghost Recon)
    async reconcileGhostPositions() {
        const portfolio = getPortfolio();
        if (!wallet || portfolio.mode !== 'LIVE') return;
        
        console.log('\n👻 [Janitor] 任務 4：執行實盤「幽靈持倉」實體對帳 (Ghost Reconciliation)...');

        try {
            // 1. 獲取 DB 內記載嘅所有持倉
            const { data: dbPositions } = await supabase.from('active_positions_live').select('mint_address');
            const dbMints = new Set((dbPositions || []).map(p => p.mint_address));

            // 2. 獲取真實錢包內所有 > 0 嘅 Token 帳戶
            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                programId: TOKEN_PROGRAM_ID
            });

            const WSOL = 'So11111111111111111111111111111111111111112';
            const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
            
            const ghostAssets = [];

            for (const accInfo of parsedTokenAccounts.value) {
                const mint = accInfo.account.data.parsed.info.mint;
                const uiAmount = accInfo.account.data.parsed.info.tokenAmount.uiAmount;
                const decimals = accInfo.account.data.parsed.info.tokenAmount.decimals;

                // 排除 WSOL, USDC, USDT 同埋 DB 已經有紀錄嘅幣
                if (uiAmount > 0 && mint !== WSOL && mint !== USDC && mint !== USDT && !dbMints.has(mint)) {
                    ghostAssets.push({ mint, amount: uiAmount, decimals });
                }
            }

            if (ghostAssets.length === 0) {
                console.log('✅ [Janitor] 帳本對齊，錢包內無發現任何幽靈持倉。');
                return;
            }

            console.log(`🚨 [Janitor] 嚴重警告！發現 ${ghostAssets.length} 隻幽靈持倉！正在執行引渡程序...`);

            // 3. 將幽靈強制引渡回 DB
            for (const ghost of ghostAssets) {
                try {
                    // 嘗試去 DexScreener 攞最新報價同 Symbol
                    let symbol = "UNKNOWN";
                    let currentPriceSol = 0.0000001; // 極端保底價

                    try {
                        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ghost.mint}`, { timeout: 4000 });
                        if (res.data && res.data.pairs && res.data.pairs.length > 0) {
                            const solPair = res.data.pairs.find(p => p.quoteToken?.address === WSOL) || res.data.pairs[0];
                            symbol = solPair.baseToken?.symbol || "UNKNOWN";
                            if (solPair.priceNative) currentPriceSol = parseFloat(solPair.priceNative);
                        }
                    } catch (e) { console.warn(`無法獲取幽靈幣 ${ghost.mint} 報價`); }

                    // 將幽靈幣強行寫入 DB (標記為 GHOST_RECOVERY 策略)
                    await supabase.from('active_positions_live').insert([{
                        mint_address: ghost.mint,
                        token_symbol: symbol,
                        strategy_type: 'GHOST_RECOVERY', // 特殊標記，方便你認出佢
                        entry_price_sol: currentPriceSol, // 將當前價當作買入價
                        highest_price_sol: currentPriceSol,
                        quantity: ghost.amount,
                        ai_reason: '🚨 幽靈對帳：Jito 交易超時但鏈上成功，系統自動引渡回 DB 交由清道夫接管！',
                        token_decimals: ghost.decimals,
                        ai_score: 50
                    }]);

                    console.log(`👻 成功引渡幽靈: $${symbol} (Mint: ${ghost.mint.substring(0,6)}...)`);
                    
                    // 通知指揮官
                    if (typeof sendAdminAlert === 'function') {
                        sendAdminAlert(`🚨 <b>【幽靈剋星觸發】</b>\n\n系統發現一筆被 Jito 遺棄但鏈上成功的交易！\n🪙 <b>代幣:</b> $${symbol}\n📦 <b>數量:</b> ${ghost.amount}\n\n🤖 <b>行動:</b> 已強行將該幣寫入數據庫 (標記: <code>GHOST_RECOVERY</code>)，現在交由風控系統接管，隨時準備市價平倉！`);
                    }

                } catch (insertErr) {
                    console.error(`❌ 無法引渡幽靈幣 ${ghost.mint}:`, insertErr.message);
                }
            }

            // 觸發重新讀取 Portfolio 到 RAM
            const { initPortfolio } = require('../services/portfolioService');
            await initPortfolio();

        } catch (err) {
            console.error('❌ [Janitor] 幽靈對帳發生錯誤:', err.message);
        }
    },

    start() {
        // 每日清晨 4:00 深度清理 (任務 1 & 2)
        cron.schedule('0 4 * * *', async () => {
            await this.cleanEmptyAccounts();
            await this.cleanIncubatorPool();
            console.log(`\n✅ [Janitor] 每日清晨 4:00 巡邏作業全數完成！`);
        });

        // 每 4 小時 WSOL 解包 (任務 3)
        cron.schedule('0 */4 * * *', async () => {
            await this.cleanWrappedSol();
        });

        // 👻 [新增排程] 每 15 分鐘執行一次幽靈對帳 (任務 4)
        cron.schedule('*/15 * * * *', async () => {
            await this.reconcileGhostPositions();
        });

        console.log('🧹 [Janitor] 清道夫排程已啟動 (包含每 15 分鐘幽靈對帳防禦)');
        healthMonitor.setStatus('Janitor_Service', '🟢 待命 (多重排程)');
    }
};

module.exports = { janitorJob };