// src/services/priceOracleService.js
const axios = require('axios');
const config = require('../config/env');
const { healthMonitor } = require('./healthMonitor'); // 👈 引入 Health Monitor

/**
 * 🫀 系統心臟：Price Oracle Service (價格預言機)
 * 扮演「專業採購經理」角色，統籌全系統報價，保護 API 額度。
 */
class PriceOracleService {
    constructor() {
        // 4. 「緩存隔離」保護層 (Caching Layer)
        this.cache = new Map(); // 格式: { mint: { priceUsd, liquidity, volume5m, fdv, source, timestamp, h1, h24... } }
        this.CACHE_TTL = 15000; // 15秒生命週期

        // 1. 「集裝箱」式打包機制 (Micro-Batching)
        this.batchQueue = new Set(); // 待查清單 (自動去重)
        this.isBatchProcessing = false;
        
        // 2. 「雙核引擎」交叉分流 (Load Balancing)
        this.useDexNext = true; // true = DexScreener, false = GeckoTerminal

        // 3. 「心跳級」極速報價 (2s Jupiter Tick)
        this.portfolioMints = new Set(); // 記錄當前持倉，享受 VIP 專線

        // 啟動定時發車機制
        setInterval(() => this._processBatch(), 10000);  // 慢車：每 10 秒發送集裝箱
        setInterval(() => this._jupiterTick(), 2000);    // 快遞：每 2 秒更新持倉價格
    }

    /**
     * 📌 登記 VIP 持倉專線 (供 PortfolioService 調用)
     */
    setPortfolioMints(mintsArray) {
        this.portfolioMints = new Set(mintsArray);
    }

    /**
     * 📌 異步獲取單一代幣完整 Profile (供 Security Guard 異步漏斗使用)
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
                this.batchQueue.add(mint); // 加入集裝箱等待發車
            }
        }

        // 如果全部都有緩存，0 消耗直接返回！
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
     * 🚚 慢車：集裝箱發車引擎 (每 10 秒執行，搭載「高鐵車隊」分拆技術)
     */
    async _processBatch() {
        // 📊 實時將排隊人數推送給 Health Monitor
        healthMonitor.setOracleQueueSize(this.batchQueue.size);

        if (this.isBatchProcessing || this.batchQueue.size === 0) return;
        this.isBatchProcessing = true;
        
        try {
            // 🚀 V7.0 升級：全數清空月台，分拆成每卡 30 隻幣的車隊
            const allMints = Array.from(this.batchQueue);
            this.batchQueue.clear(); 

            let data = {};
            const currentEngineName = this.useDexNext ? 'DexScreener' : 'GeckoTerminal';

            // 循環發送車卡
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
                    // 🚀 【核心修改：靜默處理 404】
                    if (apiErr.response && apiErr.response.status === 404) {
                        // 既然找不到，就保持靜默，等下次發車再試
                        continue; 
                    }
                    // 其他錯誤先拋出
                    throw new Error(`${currentEngineName} ${this._translateAxiosError(apiErr)}`);
                }

                // 如果仲有下一卡車，停 500ms 防止觸發瞬間 API 限制
                if (i + 30 < allMints.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            // 切換開關，下次用另一個引擎
            this.useDexNext = !this.useDexNext; 

            // 更新倉庫 (緩存)
            const now = Date.now();
            for (const mint of allMints) {
                if (data[mint]) {
                    this.cache.set(mint, { ...data[mint], timestamp: now });
                } else {
                    // 如果雙核都查唔到，塞個空殼入去，防止 15 秒內被無限重查
                    this.cache.set(mint, { 
                        priceUsd: 0, priceSol: 0, liquidity: 0, volume5m: 0, fdv: 0, 
                        h1: 0, h24: 0, source: 'UNKNOWN', timestamp: now 
                    });
                }
            }
        } catch (e) {
            console.error(`❌ [Oracle 批次引擎] 發生錯誤: ${e.message}`);
        } finally {
            this.isBatchProcessing = false;
        }
    }

    /**
     * 🏎️ 快遞：心跳級持倉專線 (每 2 秒執行)
     */
    async _jupiterTick() {
        if (this.portfolioMints.size === 0) return;
        const mints = Array.from(this.portfolioMints);
        
        try {
            const data = await this._fetchJupiter(mints);
            const now = Date.now();
            
            for (const mint of mints) {
                if (data[mint]) {
                    const existing = this.cache.get(mint) || { liquidity: 0, volume5m: 0, fdv: 0, h1: 0, h24: 0 };
                    this.cache.set(mint, { 
                        ...existing,
                        priceUsd: data[mint].priceUsd, 
                        source: 'Jupiter', 
                        timestamp: now 
                    });
                }
            }
        } catch (e) {
            // 🚀 【核心修改：靜默處理 404】
            // 如果是 404，代表 Jupiter 仲未 Index 到呢隻新幣，唔好噴 Log 嚇自己
            if (e.response && e.response.status === 404) return;
        
            // 如果是 429，提示一聲就好，唔好當成大錯
            if (e.response && e.response.status === 429) {
                console.warn("⚠️ [Oracle VIP專線] Jupiter 觸發 429 限流，建議放慢監控頻率");
                return;
            }
        
            console.warn(`⚠️ [Oracle VIP專線] Jupiter 報價異常: ${this._translateAxiosError(e)}`);
        }
    }

    // ==========================================
    // 🧠 Error 翻譯機 (將死板的 Axios 錯誤轉換成人類語言)
    // ==========================================
    _translateAxiosError(err) {
        if (err.response) {
            const status = err.response.status;
            if (status === 429) return `拒絕訪問 (429 限流 / IP 被封鎖)`;
            if (status === 404) return `找不到代幣資料 (404 Not Found)`;
            if (status >= 500) return `伺服器死機 (${status} Server Error)`;
            return `回傳錯誤代碼 ${status}`;
        } else if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
            return `請求超時 (Timeout > 等待上限)`;
        } else if (err.request) {
            return `無法連線至伺服器 (網路斷線)`;
        } else {
            return `未知錯誤: ${err.message}`;
        }
    }

    // ==========================================
    // 🌐 底層 API 呼叫器 (Providers)
    // ==========================================

    async _fetchJupiter(mints) {
        const url = `${config.external.jupiterBaseUrl}/price/v2?ids=${mints.join(',')}`;
        const configOpts = { timeout: 1500 }; 
        
        if (config.external.jupiterApiKey) {
            configOpts.headers = { 'x-api-key': config.external.jupiterApiKey };
        }
        
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
        const res = await axios.get(url, { timeout: 4000 });
        const results = {};
        if (res.data?.pairs) {
            for (const mint of mints) {
                const pair = res.data.pairs.find(p => p.chainId === 'solana' && p.baseToken.address === mint);
                if (pair && pair.priceUsd) {
                    const socials = pair.info?.socials || [];
                    results[mint] = {
                        priceUsd: parseFloat(pair.priceUsd) || 0,
                        priceSol: parseFloat(pair.priceNative) || 0,
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
        return results;
    }

    async _fetchGeckoTerminal(mints) {
        const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${mints.join(',')}`;
        const headers = { 'accept': 'application/json' };
        
        if (config.external.coingeckoApiKey) {
            headers['x-cg-demo-api-key'] = config.external.coingeckoApiKey;
        }
        
        const res = await axios.get(url, { headers, timeout: 5000 });
        const results = {};
        if (res.data?.data) {
            for (const t of res.data.data) {
                const addr = t.attributes.address;
                results[addr] = {
                    priceUsd: parseFloat(t.attributes.price_usd) || 0,
                    priceSol: 0, 
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