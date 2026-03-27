// src/services/priceOracleService.js
const axios = require('axios');
const config = require('../config/env');
const { healthMonitor } = require('./healthMonitor');

/**
 * 🫀 系統心臟：Price Oracle Service (價格預言機)
 * [V7.4 降頻防護版] - 減緩 API 請求頻率，防止 429 Too Many Requests
 */
class PriceOracleService {
    constructor() {
        this.cache = new Map(); // 格式: { mint: { priceUsd, priceSol, timestamp... } }
        this.CACHE_TTL = 30000; // 🚀 延長至 30秒生命週期，減少查價壓力

        this.batchQueue = new Set(); 
        this.isBatchProcessing = false;
        
        this.useDexNext = true; 

        // 全局 SOL 價格追蹤
        this.solPriceUsd = 150; 

        this.portfolioMints = new Set(); 

        // 🚀 降頻設定：大幅減緩 API 請求
        setInterval(() => this._updateSolPrice(), 60000); // 每 60 秒更新一次 SOL 價格
        setInterval(() => this._processBatch(), 30000);   // 🚀 慢車：改為每 30 秒執行一次 (原本10秒)
        setInterval(() => this._jupiterTick(), 10000);    // 🚀 快車：改為每 10 秒執行一次 (原本2秒)

        // 啟動時立即獲取一次 SOL 價
        this._updateSolPrice();
    }

    /**
     * 更新全局 SOL 價格
     */
    async _updateSolPrice() {
        try {
            const url = 'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112';
            const res = await axios.get(url, { timeout: 5000 });
            if (res.data?.data?.['So11111111111111111111111111111111111111112']) {
                this.solPriceUsd = parseFloat(res.data.data['So11111111111111111111111111111111111111112'].price);
            }
        } catch (e) {
            // 靜默失敗
        }
    }

    /**
     * 📌 登記 VIP 持倉專線 (供 PortfolioService / MonitorService 調用)
     */
    setPortfolioMints(mintsArray) {
        if (!mintsArray || !Array.isArray(mintsArray)) return;
        
        // 檢查如果有新幣加入，立即塞入快取查價
        mintsArray.forEach(mint => {
            if (!this.portfolioMints.has(mint)) {
                this.batchQueue.add(mint);
            }
        });

        this.portfolioMints = new Set(mintsArray);
    }

    /**
     * 📌 異步獲取單一代幣完整 Profile
     */
    async getProfileAsync(mint) {
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
     * 📌 核心出貨窗口 (供全系統調用)
     */
    async getPrices(mintsArray) {
        const results = {};
        const missing = [];
        const now = Date.now();

        // 步驟 A：先去「倉庫」找緩存
        for (const mint of mintsArray) {
            const cached = this.cache.get(mint);
            if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
                results[mint] = cached;
            } else {
                missing.push(mint);
                this.batchQueue.add(mint); 
            }
        }

        if (missing.length === 0) return results;

        // 步驟 B：倉庫冇貨，等待集裝箱發車補貨 (最多等 12 秒)
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 500)); 
            
            let allFound = true;
            const currentTime = Date.now();
            
            for (const mint of missing) {
                const cached = this.cache.get(mint);
                if (cached && (currentTime - cached.timestamp < this.CACHE_TTL)) {
                    results[mint] = cached;
                } else {
                    allFound = false;
                }
            }
            if (allFound) break; 
        }

        return results;
    }

    /**
     * 🚚 慢車：集裝箱發車引擎 (每 30 秒執行)
     */
    async _processBatch() {
        if (healthMonitor && healthMonitor.setOracleQueueSize) {
            healthMonitor.setOracleQueueSize(this.batchQueue.size);
        }

        if (this.isBatchProcessing || this.batchQueue.size === 0) return;
        this.isBatchProcessing = true;
        
        try {
            const allMints = Array.from(this.batchQueue);
            this.batchQueue.clear(); 

            let data = {};
            const currentEngineName = this.useDexNext ? 'DexScreener' : 'GeckoTerminal';

            for (let i = 0; i < allMints.length; i += 30) {
                const chunk = allMints.slice(i, i + 30);
                
                try {
                    let chunkData;
                    if (this.useDexNext) {
                        chunkData = await this._fetchDexScreener(chunk);
                    } else {
                        chunkData = await this._fetchGeckoTerminal(chunk);
                    }
                    Object.assign(data, chunkData);
                } catch (apiErr) {
                    if (apiErr.response && apiErr.response.status === 404) {
                        continue; 
                    }
                    // 🚀 如果是 429，靜默不洗版
                    if (apiErr.response && apiErr.response.status === 429) {
                        // 靜默處理
                    } else {
                         console.warn(`⚠️ [${currentEngineName}] 批次查價失敗: ${this._translateAxiosError(apiErr)}`);
                    }
                }

                if (i + 30 < allMints.length) {
                    // 🚀 增加請求之間的延遲，保護 API
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            this.useDexNext = !this.useDexNext; 

            const now = Date.now();
            for (const mint of allMints) {
                if (data[mint]) {
                    this.cache.set(mint, { ...data[mint], timestamp: now });
                } else {
                    // 🚀 極度重要：如果查不到新價錢，絕對不能覆寫為 0，必須保留舊有快取！防假跌！
                    const existing = this.cache.get(mint);
                    if (!existing) {
                        // 真的沒有資料才塞預設值，並且確保價格是 0 以便 monitor 識別並略過
                        this.cache.set(mint, { 
                            priceUsd: 0, priceSol: 0, liquidity: 0, volume5m: 0, fdv: 0, 
                            h1: 0, h24: 0, source: 'UNKNOWN', timestamp: now 
                        });
                    } else {
                        // 更新時間戳，讓舊資料繼續續命，避免被 TTL 清除
                        existing.timestamp = now;
                        this.cache.set(mint, existing);
                    }
                }
            }
        } catch (e) {
            console.error(`❌ [Oracle 批次引擎] 發生錯誤: ${e.message}`);
        } finally {
            this.isBatchProcessing = false;
        }
    }

    /**
     * 🏎️ 快遞：持倉專線 (每 10 秒執行一次，不再是 2 秒)
     */
    async _jupiterTick() {
        if (this.portfolioMints.size === 0) return;
        const mints = Array.from(this.portfolioMints);
        
        try {
            const data = await this._fetchJupiter(mints);
            const now = Date.now();
            
            for (const mint of mints) {
                if (data[mint] && data[mint].priceUsd > 0) {
                    const existing = this.cache.get(mint) || { liquidity: 0, volume5m: 0, fdv: 0, h1: 0, h24: 0 };
                    
                    const priceSol = data[mint].priceUsd / this.solPriceUsd;

                    this.cache.set(mint, { 
                        ...existing,
                        priceUsd: data[mint].priceUsd, 
                        priceSol: priceSol,
                        source: 'Jupiter', 
                        timestamp: now 
                    });
                }
            }
        } catch (e) {
            if (e.response && (e.response.status === 404 || e.response.status === 429)) return;
            // 靜默處理其他錯誤，依靠 DexScreener 慢車補底
        }
    }

    _translateAxiosError(err) {
        if (err.response) {
            const status = err.response.status;
            if (status === 429) return `拒絕訪問 (429 限流)`;
            if (status === 404) return `找不到代幣 (404)`;
            if (status >= 500) return `伺服器死機 (${status})`;
            return `錯誤代碼 ${status}`;
        } else if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
            return `請求超時`;
        } else if (err.request) {
            return `網路斷線`;
        } else {
            return `未知錯誤: ${err.message}`;
        }
    }

    // ==========================================
    // 🌐 底層 API 呼叫器 (Providers)
    // ==========================================

    async _fetchJupiter(mints) {
        // Jupiter V2 API
        const url = `https://api.jup.ag/price/v2?ids=${mints.join(',')}`;
        const configOpts = { timeout: 3000 };  // 放寬 timeout
        
        const res = await axios.get(url, configOpts);
        const results = {};
        if (res.data?.data) {
            for (const [mint, info] of Object.entries(res.data.data)) {
                if (info && info.price) {
                    results[mint] = { priceUsd: parseFloat(info.price) };
                }
            }
        }
        return results;
    }

    async _fetchDexScreener(mints) {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`;
        const res = await axios.get(url, { timeout: 6000 }); // 放寬 timeout
        const results = {};
        if (res.data?.pairs) {
            for (const mint of mints) {
                // 防呆：只攞 Solana 鏈，並按流動性排序
                const pairs = res.data.pairs.filter(p => p.chainId === 'solana' && p.baseToken.address === mint);
                if (pairs.length > 0) {
                    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                    const pair = pairs[0];

                    if (pair && pair.priceUsd) {
                        const socials = pair.info?.socials || [];
                        let priceSol = parseFloat(pair.priceNative) || 0;
                        if (priceSol === 0) priceSol = parseFloat(pair.priceUsd) / this.solPriceUsd;

                        results[mint] = {
                            priceUsd: parseFloat(pair.priceUsd) || 0,
                            priceSol: priceSol,
                            liquidity: pair.liquidity?.usd || 0,
                            volume5m: pair.volume?.m5 || 0,
                            fdv: pair.fdv || 0,
                            buys5m: pair.txns?.m5?.buys || 0,
                            sells5m: pair.txns?.m5?.sells || 0,
                            h1: parseFloat(pair.priceChange?.h1) || 0,
                            h24: parseFloat(pair.priceChange?.h24) || 0,
                            symbol: pair.baseToken?.symbol || 'UNKNOWN',
                            name: pair.baseToken?.name || 'UNKNOWN',
                            socials: socials.length > 0 ? `有 (${socials.map(s => s.type).join('/')})` : '無',
                            source: 'DexScreener'
                        };
                    }
                }
            }
        }
        return results;
    }

    async _fetchGeckoTerminal(mints) {
        const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${mints.join(',')}`;
        const headers = { 'accept': 'application/json' };
        
        const res = await axios.get(url, { headers, timeout: 6000 }); // 放寬 timeout
        const results = {};
        if (res.data?.data) {
            for (const t of res.data.data) {
                const addr = t.attributes.address;
                const priceUsd = parseFloat(t.attributes.price_usd) || 0;
                
                results[addr] = {
                    priceUsd: priceUsd,
                    priceSol: priceUsd / this.solPriceUsd, 
                    liquidity: parseFloat(t.attributes.total_reserve_in_usd) || 0,
                    volume5m: (parseFloat(t.attributes.volume_usd?.h1) || 0) / 12, 
                    fdv: parseFloat(t.attributes.fdv_usd) || 0,
                    buys5m: 0, 
                    sells5m: 0, 
                    h1: parseFloat(t.attributes.price_change_percentage?.h1) || 0,
                    h24: parseFloat(t.attributes.price_change_percentage?.h24) || 0,
                    symbol: t.attributes.symbol || 'UNKNOWN',
                    name: t.attributes.name || 'UNKNOWN',
                    socials: '無',
                    source: 'GeckoTerminal'
                };
            }
        }
        return results;
    }
}

const priceOracleService = new PriceOracleService();
module.exports = { priceOracleService };
