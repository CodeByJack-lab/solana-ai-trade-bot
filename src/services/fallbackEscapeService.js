// src/services/fallbackEscapeService.js
// 📝 檔案功能用途：V9.2 終極黑客級逃生艙 (Escape Pod)。當 Jupiter 聚合器癱瘓或流動性被抽乾時，直接呼叫 PumpPortal 或放寬 99.9% 滑點進行底層硬砸盤。

const axios = require('axios');
const { VersionedTransaction, Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { connection, broadcastWithPromiseAny } = require('../config/solana');
const configEnv = require('../config/config');

let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg",
    "DfXygSm4jcyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjv", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7QsBgTysiEwCAQtbNheJ4sBE", "3AVi9Tg9Uao68XNwNmtcwEdqvLhATCq0MExeb1Z51vtv"
];

const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles'
];

class FallbackEscapeService {
    constructor() {
        this.wallet = null;
        try {
            const rawKey = configEnv.solana.walletPrivateKey ? configEnv.solana.walletPrivateKey.trim() : null;
            if (rawKey) {
                this.wallet = rawKey.startsWith('[') ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey))) : Keypair.fromSecretKey(bs58.decode(rawKey));
            }
        } catch (e) { console.error("❌ [EscapePod] 私鑰解析失敗"); }
    }

    /**
     * 🚀 啟動逃生艙
     */
    async executeEscape(pos, sellQuantity) {
        if (!this.wallet) return null;
        const mint = pos.mint_address;
        const dexLabel = (pos.buy_dex_label || '').toLowerCase();
        
        console.log(`\n🛸 [Escape Pod] 啟動黑客級逃生艙！目標: ${pos.token_symbol} | AMM: ${dexLabel}`);

        let txBufferBase64 = null;

        // 1. 判斷底層 AMM 並生成 Raw Transaction
        if (dexLabel.includes('pump')) {
            txBufferBase64 = await this._buildPumpFunTx(mint, sellQuantity);
        } else {
            txBufferBase64 = await this._buildKamikazeJupiterTx(mint, sellQuantity);
        }

        if (!txBufferBase64) {
            console.log(`❌ [Escape Pod] 無法生成底層砸盤指令，逃生艙發射失敗。`);
            return null;
        }

        // 2. 簽名並以 DEFCON 1 級別小費發射 (0.003 SOL 暴力插隊)
        try {
            const swapTxBuf = Buffer.from(txBufferBase64, 'base64');
            const tx = VersionedTransaction.deserialize(swapTxBuf);
            tx.sign([this.wallet]);

            console.log(`💸 [Escape Pod] 砸盤指令已簽名，動用 0.003 SOL 終極小費進行 Jito 暴力插隊！`);
            const txid = await this._blastWithJito(tx, 3000000); // 3,000,000 lamports = 0.003 SOL
            
            if (txid) {
                console.log(`🎉 [Escape Pod] 逃生艙成功抵達公鏈！TX: ${txid}`);
                // 逃生艙難以準確計算殘餘價值，回傳極小值作為象徵性成功
                return { success: true, txid: txid, sellValueSol: 0.0001, finalPriceSol: 0.0000001 };
            }
            return null;
        } catch (e) {
            console.error(`❌ [Escape Pod] 發射過程崩潰:`, e.message);
            return null;
        }
    }

    /**
     * 💊 Pump.fun 專屬：呼叫 PumpPortal 構建底層 Swap 指令 (99% 滑點)
     */
    async _buildPumpFunTx(mint, quantity) {
        console.log(`💊 [Escape Pod] 正在透過 PumpPortal 構建底層指令 (99% 極限滑點)...`);
        try {
            const response = await axios.post("https://pumpportal.fun/api/trade-local/data", {
                publicKey: this.wallet.publicKey.toString(),
                action: "sell",
                mint: mint,
                denominatedInSol: "false",
                amount: quantity,
                slippage: 99, 
                priorityFee: 0.0001, // 基礎手續費
                pool: "pump"
            }, { responseType: 'arraybuffer', timeout: 5000 });
            
            return Buffer.from(response.data).toString('base64');
        } catch (e) {
            console.error(`⚠️ [Escape Pod] PumpPortal 生成失敗:`, e.message);
            return null;
        }
    }

    /**
     * ☢️ 神風特攻隊：呼叫 Jupiter 強制開 99.99% 滑點
     */
    async _buildKamikazeJupiterTx(mint, quantity) {
        console.log(`☢️ [Escape Pod] 正在構建 Jupiter 99.99% 神風特攻指令...`);
        try {
            const decimalsResult = await connection.getTokenSupply(new PublicKey(mint));
            const decimals = decimalsResult.value?.decimals || 6;
            const amountRaw = Math.floor(quantity * Math.pow(10, decimals)).toString();

            // 9999 BPS = 99.99% 滑點
            const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountRaw}&slippageBps=9999&onlyDirectRoutes=true`;
            const quoteRes = await axios.get(quoteUrl, { timeout: 4000 });

            if (!quoteRes.data) return null;

            const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
                quoteResponse: quoteRes.data,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: "auto"
            }, { timeout: 4000 });

            return swapRes.data.swapTransaction;
        } catch (e) {
            console.error(`⚠️ [Escape Pod] 神風指令生成失敗:`, e.message);
            return null;
        }
    }

    /**
     * 🚀 專屬 Jito 發射器 (無重試，一次性暴力發射)
     */
    async _blastWithJito(transaction, tipLamports) {
        try {
            const serializedSwapTx = transaction.serialize();
            const base58SwapTx = bs58.encode(serializedSwapTx);
            const txid = bs58.encode(transaction.signatures[0]);

            const latestBlockHash = await connection.getLatestBlockhash();
            const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
            
            const tipTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: tipAccount,
                    lamports: tipLamports, 
                })
            );
            tipTx.recentBlockhash = latestBlockHash.blockhash;
            tipTx.feePayer = this.wallet.publicKey;
            tipTx.sign(this.wallet);

            const serializedTipTx = bs58.encode(tipTx.serialize());
            const bundlePayload = {
                jsonrpc: "2.0", id: 1, method: "sendBundle",
                params: [ [base58SwapTx, serializedTipTx] ]
            };

            const sendPromises = JITO_ENDPOINTS.map(url => 
                axios.post(url, bundlePayload, { headers: { 'Content-Type': 'application/json' }, timeout: 3000 }).catch(() => null) 
            );
            await Promise.all(sendPromises);

            // 等待 8 秒確認
            const startTime = Date.now();
            while (Date.now() - startTime < 8000) {
                const { value: status } = await connection.getSignatureStatus(txid, { searchTransactionHistory: true });
                if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
                    if (!status.err) return txid;
                }
                await new Promise(r => setTimeout(r, 1500)); 
            }
            
            // 若 Jito 失敗，啟動絕命 Promise.any 廣播
            console.warn(`⚠️ [Escape Pod] Jito 未確認，啟動 Promise.any 絕命廣播...`);
            return await broadcastWithPromiseAny(serializedSwapTx);
            
        } catch (err) {
            return null;
        }
    }
}

const fallbackEscapeService = new FallbackEscapeService();
module.exports = { fallbackEscapeService };