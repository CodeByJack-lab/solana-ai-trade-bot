// backend/services/securityGuard.js
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { connection } = require('../config/solana');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const securityGuard = {
    async checkAll(mintAddress) {
        try {
            healthMonitor.setStatus('Security_Guard', '🟢 運作中');

            const cleanMint = mintAddress.trim().replace(/[^A-Za-z0-9]/g, '');
            if (cleanMint.length < 32 || cleanMint.length > 44) {
                return { isSafe: false, reason: '🛑 地址格式異常' };
            }

            await new Promise(r => setTimeout(r, 500));

            const rugResult = await this.checkRugPull(cleanMint);
            if (!rugResult.isSafe) return rugResult;

            const { data: params, error: dbErr } = await supabase.from('ai_strategy_params').select('*').eq('id', 1).single();
            if (dbErr) throw new Error("無法讀取動態參數");

            const limits = {
                minLiq: params.min_liquidity || 10000,
                minVol: params.min_vol_5m || 1000,
                minRatio: params.min_liq_fdv_ratio || 0.05
            };

            const marketData = await this.fetchDexData(cleanMint);

            if (!marketData) {
                const existsOnBirdeye = await this.checkBirdeyeExists(cleanMint);
                if (existsOnBirdeye) {
                    console.log(`🎯 [Security] 觸發 0 秒盲狙模式！跳過算術題交由 AI 處理。`);
                    return { 
                        isSafe: true, 
                        isBlindSnipe: true,
                        marketData: {
                            liquidity: "未知 (0秒盲狙，無池數據)", // 💡 坦白告訴 AI 這是高危
                            fdv: "未知",
                            vol5m: "未知",
                            buys5m: "未知",
                            sells5m: "未知",
                            socials: "未知 (極高風險)",
                            symbol: "BLIND_SNIPE",
                            name: "UNKNOWN"
                        }
                    };
                }
                return { isSafe: false, reason: '🛑 查無報價 (Dex/Birdeye 皆無)' };
            }

            if (marketData.liquidity < limits.minLiq) {
                return { isSafe: false, reason: `📉 流動性太窮 ($${marketData.liquidity})` };
            }
            if (marketData.vol5m < limits.minVol) {
                return { isSafe: false, reason: `📉 5分量死水 ($${marketData.vol5m})` };
            }
            
            const currentRatio = marketData.fdv > 0 ? (marketData.liquidity / marketData.fdv) : 0;
            if (currentRatio < limits.minRatio) {
                return { isSafe: false, reason: `📉 泡沫極大 (比例 ${(currentRatio * 100).toFixed(2)}%)` };
            }

            return { 
                isSafe: true, 
                isBlindSnipe: false,
                marketData: marketData,
                reason: '✅ 物理防線通過'
            };

        } catch (err) {
            console.error(`❌ [Security] 保安系統異常:`, err.message);
            healthMonitor.setStatus('Security_Guard', `🔴 異常: ${err.message}`);
            return { isSafe: false, reason: '🛑 保安系統異常攔截' };
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
            if (hasLPRisk) return { isSafe: false, reason: "🛑 LP 池未銷毀或未鎖定 (高危撤資)" };

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
                socials: hasSocials
            };
        } catch (err) {
            return null;
        }
    },

    async checkBirdeyeExists(mintAddress) {
        if (!BIRDEYE_API_KEY) return false;
        try {
            const res = await axios.get(`https://public-api.birdeye.so/defi/price?address=${mintAddress}`, {
                headers: { 'X-API-KEY': BIRDEYE_API_KEY.replace(/['"]/g, '').trim(), 'x-chain': 'solana' },
                timeout: 3000
            });
            return !!res.data?.data?.value; 
        } catch (e) {
            return false;
        }
    }
};

module.exports = { securityGuard };