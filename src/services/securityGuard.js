// src/services/priceOracleService.js
const axios = require('axios');
const { healthMonitor } = require('./healthMonitor');

/**
 * 🫀 系統心臟：Price Oracle Service (V7.0 異步批次版)
 * 負責統籌全系統的所有價格與流動性查詢，消滅 429 Error
 */
class PriceOracleService {
    constructor() {
        this.cache = new Map();             // 緩存所有代幣的完整 Profile
        this.requestQueue = new Set();      // 普通排隊區 (10秒班車，供新幣與海選使用)
        this.portfolioMints = new Set();    // VIP 專線區 (2秒心跳，供實盤止損使用)
        
        this.isProcessingBatch = false;
        this.isProcessingVip = false;

        // 啟動雙引擎
        this._startBatchProcessing();
        this._startVipMonitoring();
        
        console.log('🫀 [Price Oracle] 雙引擎報價中心已啟動 (10s Batch / 2s VIP)');
    }

    /**
     * 📝 更新 VIP 監控名單 (由 Trade Engine 買賣後呼叫)
     */
    setPortfolioMints(mintsArray) {
        this.portfolioMints = new Set(mintsArray);
    }

    /**
     * 📌 異步獲取單一代幣完整 Profile (供 Security Guard 異步漏斗使用)
     */
    async getProfileAsync(mint) {
        // 呼叫 getPrices 會自動將 mint 加入排隊區，並「卡住」等待班車返回
        const pricesMap = await this.getPrices([mint]);
        const data = pricesMap[mint];
        
        if (!data || !data.priceUsd) return null;

        return {
            symbol: data.symbol || 'UNKNOWN',
            name: data.name || 'UNKNOWN',
            liquidity: data.liquidity || 0,
            fdv: data.fdv || 0,
            volume5m: data.volume5m || 0,
            buys5m: data.buys5m || 0,
            sells5m: data.sells5m || 0,
            socials: data.socials || "無"
        };
    }

    /**
     * 🛒 批次查詢價格 (會自動判斷讀取 Cache 還是加入 10 秒等待隊列)
     */
    async getPrices(mintsArray) {
        if (!mintsArray || mintsArray.length === 0) return {};

        const unresolvedMints = [];
        const result = {};
        const now = Date.now();

        // 1. 先查 Cache (如果 15 秒內更新過，當作新鮮數據直接用)
        for (const mint of mintsArray) {
            const cachedData = this.cache.get(mint);
            if (cachedData && (now - cachedData.lastUpdated) < 15000) {
                result[mint] = cachedData;
            } else {
                this.requestQueue.add(mint); // 塞入大巴排隊
                unresolvedMints.push(mint);
            }
        }

        // 2. 如果有幣未查到，喺度「異步死等」班車返嚟 (最多等 12 秒)
        if (unresolvedMints.length > 0) {
            let attempts = 0;
            while (attempts < 60) { // 60 次 * 200ms = 12 秒
                await new Promise(r => setTimeout(r, 200));
                
                let allResolved = true;
                for (const mint of unresolvedMints) {
                    const checkCache = this.cache.get(mint);
                    if (checkCache && (Date.now() - checkCache.lastUpdated) < 15000) {
                        result[mint] = checkCache;
                    } else {
                        allResolved = false;
                    }
                }
                
                if (allResolved) break; // 班車返嚟啦！全部都有數據！
                attempts++;
            }
        }

        return result;
    }

    /**
     * 🚂 軌道一：10 秒大巴 (處理 Webhook / 海選的巨量請求)
     */
    _startBatchProcessing() {
        setInterval(async () => {
            if (this.isProcessingBatch || this.requestQueue.size === 0) return;
            this.isProcessingBatch = true;

            try {
                // 1. 獲取所有排隊中的地址，並立刻清空月台
                const allMints = Array.from(this.requestQueue);
                this.requestQueue.clear(); 

                // 2. 將地址斬件，每 30 個一卡車 (DexScreener 限制)
                for (let i = 0; i < allMints.length; i += 30) {
                    const chunk = allMints.slice(i, i + 30);
                    await this._fetchDexScreener(chunk);
                    
                    // 如果仲有下一卡車，稍微停 500ms，防止瞬間 429
                    if (i + 30 < allMints.length) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            } catch (error) {
                console.error('❌ [Oracle 10s Batch] 獲取失敗:', error.message);
            } finally {
                this.isProcessingBatch = false;
            }
        }, 10000); 
    }

    /**
     * 🏎️ 軌道二：2 秒高鐵 (專門服侍 VIP 持倉，確保極速止損)
     */
    _startVipMonitoring() {
        setInterval(async () => {
            if (this.isProcessingVip || this.portfolioMints.size === 0) return;
            this.isProcessingVip = true;

            try {
                const mintsToFetch = Array.from(this.portfolioMints).slice(0, 30);
                await this._fetchDexScreener(mintsToFetch);
            } catch (error) {
                // 背景靜默處理，唔洗狂噴 Error
            } finally {
                this.isProcessingVip = false;
            }
        }, 2000);
    }

    /**
     * 📡 底層打雜：向 DexScreener 請求並解析豐富數據 (Rich Profile)
     */
    async _fetchDexScreener(mintsArray) {
        if (mintsArray.length === 0) return;
        
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${mintsArray.join(',')}`;
            const response = await axios.get(url, { timeout: 5000 });
            const pairs = response.data?.pairs || [];

            // 因為一隻幣可能有多個 Pool，我哋要揀流動性最高嗰個
            const pairsByMint = {};
            for (const pair of pairs) {
                if (pair.chainId !== 'solana') continue;
                const mint = pair.baseToken?.address;
                if (!mint) continue;
                
                if (!pairsByMint[mint] || (pair.liquidity?.usd || 0) > (pairsByMint[mint].liquidity?.usd || 0)) {
                    pairsByMint[mint] = pair;
                }
            }

            const now = Date.now();
            for (const mint of mintsArray) {
                const pair = pairsByMint[mint];
                if (pair) {
                    // 🚀 V7.0：完美注入所有 Metadata，等 Security Guard 同 AI 軍師有數據用！
                    const socials = pair.info?.socials || [];
                    this.cache.set(mint, {
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        priceSol: parseFloat(pair.priceNative) || 0,
                        liquidity: pair.liquidity?.usd || 0,
                        fdv: pair.fdv || 0,
                        volume5m: pair.volume?.m5 || 0,
                        buys5m: pair.txns?.m5?.buys || 0,
                        sells5m: pair.txns?.m5?.sells || 0,
                        symbol: pair.baseToken?.symbol || 'UNKNOWN',
                        name: pair.baseToken?.name || 'UNKNOWN',
                        socials: socials.length > 0 ? `有 (${socials.map(s => s.type).join('/')})` : '無',
                        lastUpdated: now
                    });
                } else {
                    // 如果 DexScreener 查無此幣 (404/未發車)，仍要 Update 時間，防止 queue 無限死等
                    const existing = this.cache.get(mint) || {};
                    this.cache.set(mint, {
                        ...existing,
                        priceUsd: 0,
                        priceSol: 0,
                        lastUpdated: now
                    });
                }
            }
            healthMonitor.setStatus('Price_Oracle', `🟢 運作中 (Cache: ${this.cache.size})`);
        } catch (error) {
            console.warn(`⚠️ [Oracle API Error] DexScreener 請求超時或被拒: ${error.message}`);
            healthMonitor.setStatus('Price_Oracle', `🟡 網路波動`);
        }
    }
}

// 導出單例 (Singleton)
const priceOracleService = new PriceOracleService();
module.exports = { priceOracleService };