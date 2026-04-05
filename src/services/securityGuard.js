// src/services/securityGuard.js
// 📝 檔案功能用途：V9.2 100分量化安檢中樞。實裝「懶漢判定法」保護 RPC、防 429 智能重試、原生 RPC Top 10 籌碼分佈檢查，以及動態防偽名單。
// 🚀 V9.2.3 升級：新增 0 成本 Metaplex Metadata isMutable 掃描 (防換圖騙局)。
// 🛡️ V9.2.4 升級：實裝終極 OFI 裝甲 (硬截斷 OFI 缺失、女巫對稱刷單與異常換手率)，拒絕 AI 幻覺。
// 🐛 V9.2.5 修正：修復防偽名單讀取路徑，正確對接 cacheManager.getVerifiedTokens()。
// 🗡️ V9.2.6 升級：收緊狗莊刷量攔截閾值 (AvgTrade < $20) 及加入強賣壓惡劣 OFI 強制處決，徹底封殺洗盤。

const axios = require('axios');
const { connection } = require('../config/solana');
const { PublicKey } = require('@solana/web3.js');
const config = require('../config/config');
const { cacheManager } = require('./cacheManager'); 

class SecurityGuard {
    
    /**
     * 🕵️ 4 維度制度化文字快篩
     */
    analyzeTextFeatures(symbol, name, description) {
        const fullText = `${symbol} ${name} ${description}`.toLowerCase();
        let result = { isFatal: false, safetyPenalty: 0, fomoPenalty: 0, requireAuthCheck: false, requireLpCheck: false, reasons: [] };

        // 1. 空投/免費 (Airdrop/Promo) -> 直接封殺
        const airdropPatterns = [/free mint/i, /free claim/i, /airdrop/i, /claim now/i, /connect wallet/i];
        for (const p of airdropPatterns) {
            if (p.test(fullText)) {
                result.isFatal = true;
                result.reasons.push(`空投釣魚騙局 (${p.source})`);
                return result; 
            }
        }

        // 假鎖定聲稱 -> 必須觸發鏈上 LP 驗證
        if (/lp locked/i.test(fullText) || /burned lp/i.test(fullText)) {
            result.requireLpCheck = true;
            result.reasons.push('聲稱鎖定 LP (需鏈上核實)');
        }

        // 2. 供應分配/私募 (Supply/Allocation) -> 扣安全分 30 分
        const allocationPatterns = [/presale/i, /private sale/i, /team token/i, /marketing wallet/i, /seed/i];
        for (const p of allocationPatterns) {
            if (p.test(fullText)) {
                result.safetyPenalty += 30;
                result.reasons.push(`高危分配/私募字眼 (${p.source}, 安全分 -30)`);
                break;
            }
        }

        // 3. 權限控制 (Authority Control) -> 觸發深層權限檢查
        const authorityPatterns = [/mint authority/i, /freeze authority/i, /update authority/i, /we keep control/i];
        for (const p of authorityPatterns) {
            if (p.test(fullText)) {
                result.requireAuthCheck = true;
                result.reasons.push(`觸及權限敏感字 (${p.source}, 需鏈上深查)`);
            }
        }

        // 4. FOMO / 情緒誘騙 (FOMO Marketing) -> 扣動能分 20 分
        const fomoPatterns = [/100x/i, /1000x/i, /to the moon/i, /guaranteed profit/i, /🚀/];
        let hasFomo = false;
        for (const p of fomoPatterns) {
            if (p.test(fullText)) hasFomo = true;
        }
        const emojiMatches = fullText.match(/[\u{1F680}\u{1F525}\u{1F4A5}\u{1F4B0}]/gu);
        if (hasFomo || (emojiMatches && emojiMatches.length >= 5)) {
            result.fomoPenalty += 20;
            result.reasons.push('重度 FOMO 情緒誘騙 (動能分 -20)');
        }

        return result;
    }

    /**
     * 📊 獲取 DexScreener 報價 (具備 429 智能重試防護)
     */
    async _fetchMarketData(mint) {
        let retries = 0;
        const maxRetries = 3;

        while (retries < maxRetries) {
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
                if (res.data && res.data.pairs && res.data.pairs.length > 0) {
                    const pair = res.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                    return {
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        description: pair.info?.description || '',
                        liquidity: pair.liquidity?.usd || 0, 
                        fdv: pair.fdv || 0,
                        volume5m: pair.volume?.m5 || 0,
                        buys5m: pair.txns?.m5?.buys || 0, 
                        sells5m: pair.txns?.m5?.sells || 0,
                        h1: parseFloat(pair.priceChange?.h1) || 0, 
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0)
                    };
                }
                return null; 
            } catch (err) {
                if (err.response?.status === 429) {
                    retries++;
                    console.log(`⏳ [DexScreener] 觸發 429 限制，冷卻 1.1 秒後重試 (${retries}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, 1100)); 
                } else {
                    return null; 
                }
            }
        }
        return null; 
    }

    /**
     * 🛡️ 原生 RPC 權限與 Metadata 審計 (0 成本、防隱形稅、防換圖)
     */
    async _checkContractSafety(mint, requireAuthCheck) {
        try {
            const mintPubkey = new PublicKey(mint);
            const accInfo = await connection.getParsedAccountInfo(mintPubkey);
            const info = accInfo.value?.data?.parsed?.info;
            
            if (!info) return { isSafe: false, isMutable: false };
            
            // 1. 防隱形抽水：檢查 Token-2022 Transfer Fee
            const extensions = info.extensions || [];
            const hasTransferFee = extensions.some(ext => ext.extension === 'transferFeeConfig');
            if (hasTransferFee) {
                console.log(`🚨 [Security Guard] 攔截！發現 Token-2022 交易稅陷阱！`);
                return { isSafe: false, isMutable: false };
            }

            // 2. 檢查基本鑄幣/凍結權限
            if (info.mintAuthority || (requireAuthCheck && info.freezeAuthority)) {
                return { isSafe: false, isMutable: false };
            }

            // 🌟 3. 終極防禦：零成本讀取 Metaplex Metadata 檢查 isMutable
            let isMutable = false;
            try {
                const metaplexProgramId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
                // 找出 Metadata 的 PDA (Program Derived Address)
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from('metadata'), metaplexProgramId.toBuffer(), mintPubkey.toBuffer()],
                    metaplexProgramId
                );
                
                const metadataAcc = await connection.getAccountInfo(metadataPDA);
                
                if (metadataAcc && metadataAcc.data && metadataAcc.data[0] === 4) {
                    // 極速 Buffer 解析 (無視變長字串，精準定位 isMutable Byte)
                    let offset = 1 + 32 + 32; // Key(1) + UpdateAuthority(32) + Mint(32)
                    const nameLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + nameLen;
                    const symbolLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + symbolLen;
                    const uriLen = metadataAcc.data.readUInt32LE(offset); offset += 4 + uriLen;
                    offset += 2; // SellerFeeBasisPoints
                    
                    const hasCreators = metadataAcc.data.readUInt8(offset); offset += 1;
                    if (hasCreators === 1) {
                        const creatorsLen = metadataAcc.data.readUInt32LE(offset); 
                        offset += 4 + (creatorsLen * 34); // Creator Address(32) + Verified(1) + Share(1)
                    }
                    offset += 1; // PrimarySaleHappened
                    
                    // 🎯 拿取 isMutable 旗標 (1 = true, 0 = false)
                    isMutable = metadataAcc.data.readUInt8(offset) === 1;
                }
            } catch (metaErr) {
                console.warn(`⚠️ [Security Guard] 讀取 Metadata 失敗 (忽略): ${metaErr.message}`);
            }

            return { isSafe: true, isMutable: isMutable };
        } catch (err) {
            return { isSafe: false, isMutable: false };
        }
    }

    /**
     * 🦅 原生 RPC 籌碼分佈探測 (取代 Birdeye)
     */
    async _checkTop10Holders(mint) {
        try {
            const mintPubkey = new PublicKey(mint);
            
            const supplyRes = await connection.getTokenSupply(mintPubkey);
            const totalSupply = supplyRes.value?.uiAmount;
            if (!totalSupply || totalSupply === 0) return true; 

            const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
            if (!largestAccounts.value || largestAccounts.value.length === 0) return true;

            let top10Sum = 0;
            const holdersToCheck = largestAccounts.value.slice(1, 11); 
            
            for (const account of holdersToCheck) {
                top10Sum += account.uiAmount || 0;
            }

            const top10Pct = top10Sum / totalSupply;
            
            if (top10Pct > 0.50) {
                console.log(`🚨 [Top 10 Guard] 籌碼過度集中！前 10 大散戶持倉(撇除最大池)佔比 ${(top10Pct*100).toFixed(2)}%: ${mint}`);
                return false; 
            }
            return true;
        } catch (err) {
            console.warn(`⚠️ [Top 10 Guard] 查閱籌碼失敗: ${err.message}`);
            return true; 
        }
    }

    /**
     * 🎯 V9.2 量化 100 分核心引擎 (懶漢判定法：先快篩，後 RPC)
     */
    async calculateQuantScore(mint, type = 'NEWBORN') {
        // 🧠 動態讀取 Database 參數
        const dbParams = cacheManager.getStrategy(type);

        const marketData = await this._fetchMarketData(mint);
        if (!marketData) return { numeric_score: 0, isSafe: false, reason: '無法獲取報價數據 (DexScreener 異常或無池)', marketData: null };

        const upperSymbol = marketData.symbol.toUpperCase();

        // 🛑 [0 成本] 穩定幣攔截
        if (upperSymbol.startsWith('USD')) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 穩定幣攔截: 系統不交易 ${upperSymbol} 系列代幣`, marketData };
        }

        // 🛑 [0 成本] 絕對流動性底線 (讀取 DB)
        if (marketData.liquidity < dbParams.min_liquidity) {
            console.log(`🚨 [Liquidity Guard] 流動性極度枯竭！僅有 $${marketData.liquidity.toFixed(0)}: ${upperSymbol}`);
            return { numeric_score: 0, isSafe: false, reason: `🛑 流動性過低攔截: 僅有 $${marketData.liquidity.toFixed(0)} (底線: $${dbParams.min_liquidity})`, marketData };
        }

        // 🛑 [0 成本] 死水大池與假池過濾 (動態比例)
        const deadPoolVolReq = dbParams.min_vol_5m * 5; 
        if (marketData.liquidity > 100000 && marketData.volume5m < deadPoolVolReq) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 假池/貔貅攔截: $10萬以上流動性但交易量不足 $${deadPoolVolReq}`, marketData };
        }

        // ==========================================
        // 🛡️ [0 成本] 終極 OFI 裝甲與活人真實度檢測
        // ==========================================
        const buys = marketData.buys5m;
        const sells = marketData.sells5m;
        const totalTxs5m = buys + sells;

        // 1. OFI 缺失 / 死水攔截
        if (totalTxs5m < 5) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 OFI 缺失攔截: 5分鐘內真實交易極低 (Buys:${buys}, Sells:${sells})，無法計算有效訂單流，拒絕盲狙`, marketData };
        }

        // 2. 貔貅盤攔截
        if (buys > 10 && sells === 0) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 貔貅攔截: 完全沒有賣單 (Buy:${buys}, Sell:0)`, marketData };
        }

        // 3. 納米刷量機器人攔截 (收緊條件：只要多過 10 單，均價低過 $20 就殺)
        const avgTradeSize = totalTxs5m > 0 ? (marketData.volume5m / totalTxs5m) : 0;
        if (totalTxs5m >= 10 && avgTradeSize < 20) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 刷量攔截: 發現狗莊微型造市，單筆均價極低 ($${avgTradeSize.toFixed(2)})`, marketData };
        }

        // 4. 女巫攻擊 / 完美對稱刷量攔截 (Sybil Shield)
        const buyRatio = buys / totalTxs5m;
        const pseudoOfi = (buys - sells) / totalTxs5m; // 簡易 OFI
        
        // 如果交易大於 30 筆，且買賣單比例落在 45% - 55% 之間，極高機率是腳本左右手互刷
        if (totalTxs5m > 30 && buyRatio > 0.45 && buyRatio < 0.55) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 女巫刷量攔截: 買賣極度對稱 (Buys:${buys}, Sells:${sells}, Ratio:${(buyRatio*100).toFixed(1)}%)，判定為腳本對沖`, marketData };
        }

        // 5. 惡劣 OFI (強大賣壓) 攔截
        if (totalTxs5m > 10 && pseudoOfi < -0.2) {
             return { numeric_score: 0, isSafe: false, reason: `🛑 惡劣 OFI 攔截: 買賣力道嚴重失衡 (OFI: ${pseudoOfi.toFixed(2)})，空軍壓境`, marketData };
        }

        // 6. 換手率異常防禦 (資金空轉刷量)
        if (marketData.liquidity > 0 && (marketData.volume5m / marketData.liquidity) > 3 && Math.abs(pseudoOfi) < 0.05) {
            return { numeric_score: 0, isSafe: false, reason: `🛑 換手異常攔截: 資金空轉
