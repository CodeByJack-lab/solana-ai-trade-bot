// src/services/securityGuard.js
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const securityGuard = {
    isGarbageToken(name, symbol) {
        const target = `${name} ${symbol}`.toLowerCase();
        
        const badPatterns = [
            /\.com/i, /\.io/i, /\.org/i, /\.xyz/i, /t\.me\//i,         
            /test\s*token/i, /testnet/i, /presale/i, /airdrop/i,         
            /claim/i, /free/i, /scam/i, /fake/i, /honeypot/i
        ];

        for (const pattern of badPatterns) {
            if (pattern.test(target)) {
                return { isGarbage: true, match: pattern.toString() };
            }
        }
        return { isGarbage: false };
    },

    // 🚀 核心升級：新增 poolType 參數 ('NURSERY' 或 'TRENDING')
    async checkAll(mintAddress, poolType = 'NURSERY') {
        try {
            healthMonitor.setStatus('Security_Guard', '🟢 運作中');

            const cleanMint = mintAddress.trim().replace(/[^A-Za-z0-9]/g, '');
            if (cleanMint.length < 32 || cleanMint.length > 44) {
                return { isSafe: false, reason: '🛑 地址格式異常' };
            }

            await new Promise(r => setTimeout(r, 500));

            // 🚀 智能分流：決定讀取邊一套參數
            // ID 2: Meme 盲狙專用 | ID 3: Trending 專用
            const targetParamId = poolType === 'TRENDING' ? 3 : 2;

            // 從資料庫讀取對應的動態參數
            const { data: params, error: dbErr } = await supabase
                .from('ai_strategy_params')
                .select('*')
                .eq('id', targetParamId)
                .single();
            
            if (dbErr) throw new Error(`無法讀取參數 ID ${targetParamId}`);

            const limits = {
                minLiq: params.min_liquidity || (poolType === 'TRENDING' ? 30000 : 5000),
                minVol: params.min_vol_5m || (poolType === 'TRENDING' ? 10000 : 1000),
                minRatio: params.min_liq_fdv_ratio || 0.05
            };

            let marketData = await this.fetchDexData(cleanMint);

            if (!marketData) {
                // 🚀 直接物理攔截無 Dex 數據的垃圾幣
                return { isSafe: false, reason: '🗑️ 物理攔截: DexScreener 無報價 (死水/垃圾幣)' };
            } else {
                const garbageCheck = this.isGarbageToken(marketData.name, marketData.symbol);
                if (garbageCheck.isGarbage) {
                    return { isSafe: false, reason: `🛑 垃圾幣特徵攔截 (${garbageCheck.match})` };
                }

                if (marketData.liquidity < limits.minLiq) {
                    // Trending 幣不設緩刑，唔夠水就即刻死；Meme 幣保留緩刑
                    if (poolType === 'TRENDING') {
                        return { isSafe: false, reason: `📉 流動性未達熱門標準 ($${marketData.liquidity} < $${limits.minLiq})` };
                    }
                    const purgatoryThreshold = limits.minLiq * 0.8;
                    if (marketData.liquidity >= purgatoryThreshold) {
                        return { isSafe: false, isPurgatory: true, reason: `⏳ 流動性緩刑 ($${marketData.liquidity} < $${limits.minLiq})` };
                    }
                    return { isSafe: false, reason: `📉 流動性太窮 ($${marketData.liquidity} < $${limits.minLiq})` };
                }

                if (marketData.vol5m < limits.minVol) {
                    return { isSafe: false, reason: `📉 5分量死水 ($${marketData.vol5m} < $${limits.minVol})` };
                }
                const currentRatio = marketData.fdv > 0 ? (marketData.liquidity / marketData.fdv) : 0;
                if (currentRatio < limits.minRatio) {
                    return { isSafe: false, reason: `📉 泡沫極大 (比例 ${(currentRatio * 100).toFixed(2)}%)` };
                }
            }

            const rugResult = await this.checkRugPull(cleanMint);
            if (!rugResult.isSafe) return rugResult;

            return { 
                isSafe: true, 
                isBlindSnipe: false, // 移除盲狙
                marketData: marketData,
                reason: '✅ 物理與合約防線全數通過'
            };

        } catch (err) {
            console.error(`❌ [Security] Security Guard 系統異常:`, err.message);
            healthMonitor.setStatus('Security_Guard', `🔴 異常: ${err.message}`);
            return { isSafe: false, reason: '🛑 Security Guard 系統異常攔截' };
        }
    },

    async checkRugPull(mintAddress) {
        try {
            const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`;
            const response = await axios.get(url, { 
                timeout: 7000, 
                headers: { 
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                } 
            });

            if (!response.data) throw new Error("RugCheck 無回應");

            const report = response.data;
            const score = report.score || 0;

            if (score > 5000) return { isSafe: false, reason: `🛑 RugCheck 危險分數過高 (${score}分)` };

            const risks = report.risks || [];
            const hasMintRisk = risks.some(r => r.name === "Mint Authority still active" || r.value === "Minting enabled");
            const hasFreezeRisk = risks.some(r => r.name === "Freeze Authority still active");
            const hasLPRisk = risks.some(r => r.name.toLowerCase().includes("liquidity not locked") || r.name.toLowerCase().includes("unlocked"));

            if (hasMintRisk) return { isSafe: false, reason: "🛑 未放棄 Mint 權限" };
            if (hasFreezeRisk) return { isSafe: false, reason: "🛑 未放棄 Freeze 權限" };
            if (hasLPRisk) return { isSafe: false, reason: "🛑 LP 池未鎖定 (高危撤資)" };

            return { isSafe: true };
        } catch (err) {
            return await this.fallbackNativeCheck(mintAddress);
        }
    },

    async fallbackNativeCheck(mintAddress) {
        try {
            const pubKey = new PublicKey(mintAddress);
            const accInfo = await connection.getParsedAccountInfo(pubKey);
            
            if (!accInfo.value) return { isSafe: false, reason: "🛑 找不到代幣帳戶" };
            
            const info = accInfo.value.data?.parsed?.info;
            if (!info) return { isSafe: false, reason: "🛑 無法解析代幣結構" };

            if (info.mintAuthority !== null && info.mintAuthority !== undefined) 
                return { isSafe: false, reason: "🛑 未放棄 Mint 權限" };
            if (info.freezeAuthority !== null && info.freezeAuthority !== undefined) 
                return { isSafe: false, reason: "🛑 未放棄 Freeze 權限" };

            return { isSafe: true };
        } catch (err) {
            return { isSafe: false, reason: `🛑 原生 RPC 連線異常` };
        }
    },

    async fetchDexData(mintAddress) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 4000 });
            const pair = res.data?.pairs?.find(p => p.chainId === 'solana');
            
            if (!pair) return null;

            const socials = pair.info?.socials || [];
            const hasSocials = socials.length > 0 ? `有 (${socials.map(s => s.type).join('/')})` : "無";

            return {
                symbol: pair.baseToken?.symbol || "UNKNOWN",
                name: pair.baseToken?.name || "UNKNOWN",
                liquidity: pair.liquidity?.usd || 0,
                fdv: pair.fdv || 0,
                vol5m: pair.volume?.m5 || 0,
                buys5m: pair.txns?.m5?.buys || 0,
                sells5m: pair.txns?.m5?.sells || 0,
                socials: hasSocials,
                pairCreatedAt: pair.pairCreatedAt || 0
            };
        } catch (err) {
            return null;
        }
    }
};

module.exports = { securityGuard };