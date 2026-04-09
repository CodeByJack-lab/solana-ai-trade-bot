// src/services/trendingMonitorService.js
// 📝 檔案功能用途：V10.12 雙引擎隱形獵人 (Gecko + Birdeye 靜默忍者版)。
// 🛡️ 升級功能：聚合 Log 輸出！所有被攔截的同名假幣/黑名單/複製人，會先在背後點算數量，最後只輸出一行簡潔的結算 Log，杜絕洗版。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');
const { trendingJob } = require('../jobs/trendingJob');
const { cacheManager } = require('./cacheManager'); 
const configEnv = require('../config/config');
const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

let isCrawlerRunning = false;

let geckoSuspendedUntil = 0;
let birdeyeSuspendedUntil = 0;

const trendingMonitorService = {
    
    // ==========================================
    // 🦎 引擎 1：Gecko 爬蟲
    // ==========================================
    async fetchTop100FromGecko() {
        console.log('🌐 [Gecko Crawler] 開始分批抓取 8 頁 (約 160 個池)，準備過濾 Solana 真・Top 100...');
        let allPools = [];
        const startTime = Date.now();
        const maxDuration = 5 * 60 * 1000; 

        for (let page = 1; page <= 8; page++) {
            let pageSuccess = false;
            let attempt = 0;

            while (!pageSuccess) {
                if (Date.now() - startTime > maxDuration) {
                    throw new Error('Gecko API 連續 5 分鐘請求失敗或被阻擋 (觸發 5m 熔斷)');
                }

                try {
                    attempt++;
                    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`;
                    const res = await axios.get(url, { headers: { 'accept': 'application/json' }, timeout: 10000 });
                    
                    if (res.data?.data) {
                        allPools = allPools.concat(res.data.data);
                    }
                    pageSuccess = true; 
                    console.log(`📑 [Gecko] 第 ${page} 頁抓取成功！`);

                    if (page < 8) {
                        const delay = Math.floor(Math.random() * 10000) + 5000; 
                        await new Promise(r => setTimeout(r, delay));
                    }
                } catch (error) {
                    const is429 = error.response?.status === 429 || error.message.includes('429');
                    const penaltyDelay = is429 ? Math.floor(Math.random() * 5000) + 10000 : 3000; 
                    console.warn(`⚠️ [Gecko Crawler] 第 ${page} 頁失敗 (嘗試 ${attempt})，冷卻 ${Math.round(penaltyDelay/1000)}s...`);
                    await new Promise(r => setTimeout(r, penaltyDelay));
                }
            }
        }
        
        return allPools.map(pool => {
            const baseTokenId = pool.relationships?.base_token?.data?.id || '';
            const attr = pool.attributes || {};
            return {
                mint_address: baseTokenId.replace('solana_', ''),
                token_symbol: attr.name?.split(' /')[0]?.toUpperCase() || 'UNKNOWN',
                token_name: attr.name || 'UNKNOWN',
                liquidity: parseFloat(attr.reserve_in_usd) || 0,
                volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                price_change_24h: parseFloat(attr.price_change_percentage?.h24) || 0
            };
        });
    },

    // ==========================================
    // 🦅 引擎 2：Birdeye 爬蟲 (靜默忍者版)
    // ==========================================
    async fetchFromBirdeye() {
        const apiKey = process.env.BIRDEYE_API_KEY || configEnv.birdeye?.apiKey;
        if (!apiKey) return [];

        console.log('🦅 [Birdeye Crawler] 啟動天眼：準備分 5 批次獲取 Solana 熱門榜單 (嚴格遵守 limit=20 限制)...');
        let allTokens = [];
        const batchCount = 5;
        const limitPerBatch = 20;

        for (let i = 0; i < batchCount; i++) {
            let attempt = 0;
            let pageSuccess = false;
            const offset = i * limitPerBatch;

            while (!pageSuccess && attempt < 3) {
                try {
                    attempt++;
                    const response = await axios.get('https://public-api.birdeye.so/defi/token_trending', {
                        headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', 'accept': 'application/json' },
                        params: { sort_by: 'rank', sort_type: 'asc', offset: offset, limit: limitPerBatch },
                        timeout: 8000 
                    });

                    const tokens = response.data?.data?.tokens || [];
                    allTokens = allTokens.concat(tokens);
                    pageSuccess = true;
                    console.log(`📑 [Birdeye] 第 ${i + 1} 批次 (${tokens.length} 隻) 抓取成功！`);

                    if (i < batchCount - 1) await new Promise(r => setTimeout(r, 2000)); 

                } catch (error) {
                    const status = error.response?.status;
                    let isFatal = false;
                    let errorMsg = error.message;

                    if (error.response?.data) {
                        if (typeof error.response.data === 'string' && error.response.data.startsWith('<!DOCTYPE html>')) {
                            errorMsg = `Cloudflare ${status} Bad Gateway (官方伺服器死機)`;
                            isFatal = true; 
                        } else {
                            errorMsg = JSON.stringify(error.response.data).substring(0, 100); 
                        }
                    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                        errorMsg = '請求超時 (Timeout)';
                        isFatal = true; 
                    }

                    if (status === 400 || status === 401 || status === 403) {
                        console.error(`❌ [Birdeye Crawler] 拒絕連線 (${status}): ${errorMsg}`);
                        throw new Error(`Birdeye API 致命錯誤 (${status})`); 
                    }

                    if (isFatal || status === 502 || status === 503 || status === 504) {
                        console.warn(`⚠️ [Birdeye Crawler] 偵測到官方伺服器不穩定 (${errorMsg})。忍者模式啟動：放棄本輪剩餘抓取。`);
                        return allTokens; 
                    }
                    
                    const penaltyDelay = status === 429 ? 15000 : 5000;
                    console.warn(`⚠️ [Birdeye Crawler] 第 ${i+1} 批次失敗 (嘗試 ${attempt}/3): ${errorMsg}。冷卻 ${penaltyDelay/1000}s...`);
                    await new Promise(r => setTimeout(r, penaltyDelay));
                }
            }
        }

        return allTokens.map(t => {
            return {
                mint_address: t.address,
                token_symbol: (t.symbol || 'UNKNOWN').toUpperCase(),
                token_name: t.name || 'UNKNOWN',
                liquidity: parseFloat(t.liquidity) || 0,
                volume_24h: parseFloat(t.volume24hUSD) || 0,
                price_change_24h: 0 
            };
        });
    },

    // ==========================================
    // 🧠 共用處理核心：去重聚合、DB動態黑名單、自動白名單、交給天網
    // ==========================================
    async processAndSaveTokens(standardizedTokens, sourceName) {
        if (!standardizedTokens || standardizedTokens.length === 0) return;

        const BRAND_BLACKLIST = ['GROK', 'TRUMP', 'ELON', 'BIDEN', 'PEPE', 'DOGE', 'SHIB', 'MAGA', 'OPENAI', 'NVIDIA', 'APPLE', 'META', 'SPACEX', 'ZARA'];
        const blacklist = [
            'So11111111111111111111111111111111111111112', 
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
        ];
        const VERIFIED_TOKENS = typeof cacheManager.getVerifiedTokens === 'function' ? cacheManager.getVerifiedTokens() : {};

        // 🛡️ 聚合計算器：收集攔截數據
        let fakeBlockCount = {}; 
        let dbBlacklistCount = {}; 
        let brandShieldCount = {}; 
        let dedupeCount = {}; 

        const symbolMap = new Map();

        // 🔍 第一階段：全域過濾與去重 (計算攔截數量，不立即 Print Log)
        for (const token of standardizedTokens) {
            const { mint_address, token_symbol, liquidity } = token;
            if (!mint_address || mint_address.length < 32 || blacklist.includes(mint_address)) continue;
            if (liquidity < 1000) continue; 

            const sym = (token_symbol || 'UNKNOWN').toUpperCase();

            // 1. 動態防偽與 DB 黑名單
            if (VERIFIED_TOKENS[sym] && mint_address !== VERIFIED_TOKENS[sym]) {
                if (VERIFIED_TOKENS[sym].startsWith('BlockList')) {
                    dbBlacklistCount[sym] = (dbBlacklistCount[sym] || 0) + 1;
                } else {
                    fakeBlockCount[sym] = (fakeBlockCount[sym] || 0) + 1;
                }
                continue; 
            }

            // 2. 檢查大廠/名人陷阱
            let isBrandTrap = false;
            for (const brand of BRAND_BLACKLIST) {
                if (sym.includes(brand) && !VERIFIED_TOKENS[sym]) {
                    isBrandTrap = true;
                    brandShieldCount[sym] = (brandShieldCount[sym] || 0) + 1;
                    break;
                }
            }
            if (isBrandTrap) continue;

            // 3. 「唯一王者」去重算法 (The Highlander Rule)
            if (!symbolMap.has(sym)) {
                symbolMap.set(sym, token);
            } else {
                const existing = symbolMap.get(sym);
                if (liquidity > existing.liquidity) {
                    symbolMap.set(sym, token);
                    dedupeCount[sym] = (dedupeCount[sym] || 0) + 1; // 淘汰舊的
                } else {
                    dedupeCount[sym] = (dedupeCount[sym] || 0) + 1; // 淘汰新的
                }
            }
        }

        // 🖨️ 集中輸出聚合 Log (一目了然，不再洗版！)
        for (const [sym, count] of Object.entries(dbBlacklistCount)) {
            console.log(`🚫 [DB Blacklist] 觸發動態黑名單，已批量秒殺 ${count} 隻垃圾幣: ${sym}`);
        }
        for (const [sym, count] of Object.entries(fakeBlockCount)) {
            console.log(`🗑️ [Fake Shield] 發現並踢出 ${count} 隻假冒 ${sym}！`);
        }
        for (const [sym, count] of Object.entries(brandShieldCount)) {
            console.log(`🛡️ [Brand Shield] 攔截 ${count} 隻大廠/名人誘餌幣: ${sym}`);
        }
        
        const totalDedupes = Object.values(dedupeCount).reduce((a, b) => a + b, 0);
        if (totalDedupes > 0) {
            console.log(`⚔️ [Highlander] 觸發唯一王者去重，已淘汰 ${totalDedupes} 隻低仿同名幣。`);
        }

        // 取出存活的精英代幣
        const deduplicatedTokens = Array.from(symbolMap.values());

        // 🛡️ 第二階段：準備入庫與 Auto-Whitelist
        const dbParams = cacheManager.getStrategy('TRENDING');
        const dynamicMinLiquidity = dbParams?.min_liquidity || 50000; 

        let top100Array = [];
        let incubatorArray = [];
        let autoWhitelistArray = []; // 🌟 準備寫入 verified_tokens 的陣列
        let uniqueMints = new Set();
        let currentRank = 1;

        const portfolio = getPortfolio();
        const activePositions = portfolio.positions || [];
        const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

        for (const token of deduplicatedTokens) {
            const { mint_address, token_symbol, liquidity } = token;
            const sym = (token_symbol || 'UNKNOWN').toUpperCase();

            // 🌟 [Auto-Whitelist] 如果流動性極高 (> 50萬U)，自動加入官方白名單！
            if (liquidity > 500000 && !VERIFIED_TOKENS[sym]) {
                autoWhitelistArray.push({ token_symbol: sym, mint_address: mint_address, is_active: true });
                VERIFIED_TOKENS[sym] = mint_address; 
            }

            if (uniqueMints.has(mint_address)) continue;
            uniqueMints.add(mint_address);

            if (top100Array.length >= 100) break; 

            const dbData = { ...token, source: sourceName, updated_at: new Date().toISOString() };
            top100Array.push({ ...dbData, rank: currentRank });

            if (currentRank <= 100 && liquidity >= dynamicMinLiquidity) {
                const isBlacklisted = await redis.get(`scam_blacklist:${mint_address}`);
                const isHolding = activePositions.some(p => p.mint_address === mint_address);
                
                if (!isBlacklisted && !isHolding) {
                    const { data: tradeHistory } = await supabase
                        .from(`trade_history_${tableSuffix}`)
                        .select('created_at, realized_pnl_pct')
                        .eq('token_mint', mint_address)
                        .eq('action', 'SELL')
                        .order('created_at', { ascending: false })
                        .limit(2);

                    let isOnCooldown = false;
                    if (tradeHistory && tradeHistory.length > 0) {
                        const lastTrade = tradeHistory[0];
                        const timeSinceLastTrade = Date.now() - new Date(lastTrade.created_at).getTime();
                        if (lastTrade.realized_pnl_pct < 0 && timeSinceLastTrade < 24 * 60 * 60 * 1000) isOnCooldown = true; 
                    }
                    
                    if (!isOnCooldown) incubatorArray.push(dbData);
                }
            }
            currentRank++;
        }

        // 🌟 寫入 Auto-Whitelist
        if (autoWhitelistArray.length > 0) {
            const { error: whitelistErr } = await supabase.from('verified_tokens').upsert(autoWhitelistArray, { onConflict: 'token_symbol' });
            if (whitelistErr) {
                console.error(`❌ [Auto-Whitelist] 自動白名單寫入失敗:`, whitelistErr.message);
            } else {
                console.log(`✅ [Auto-Whitelist] 成功自動將 ${autoWhitelistArray.length} 隻巨鯨級代幣加入官方防偽白名單！`);
                if (typeof cacheManager.loadVerifiedTokens === 'function') {
                    await cacheManager.loadVerifiedTokens();
                }
            }
        }

        if (top100Array.length >= 10) { 
            await supabase.from('trending_top100').delete().eq('source', sourceName); 
            const { error: insertErr } = await supabase.from('trending_top100').upsert(top100Array, { onConflict: 'mint_address' });
            if (insertErr) console.error(`❌ [${sourceName}] 寫入 Top100 失敗:`, insertErr.message);
            else console.log(`📋 [${sourceName}] 成功更新防偽對照表 (${top100Array.length} 隻代幣，已過濾複製人)！`);
        }

        if (incubatorArray.length > 0) {
            const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
            if (!error) {
                console.log(`🦎 [${sourceName}] 成功將 ${incubatorArray.length} 隻嚴選獵物送入天網保溫箱！`);
            }
        }
    },

    start() {
        console.log('🦎🦅 [雙軌情報網] V10.12 啟動 (已實裝聚合 Log，杜絕洗版)...');
        
        const runTask = async () => {
            if (isCrawlerRunning) return;
            isCrawlerRunning = true;

            try {
                if (!canBuyTrending()) {
                    console.log('⏸️ [情報網] Trending 倉位已滿，跳過本次榜單更新。');
                    isCrawlerRunning = false;
                    return;
                }

                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config || !config.is_running) { isCrawlerRunning = false; return; }

                if (Date.now() > geckoSuspendedUntil) {
                    try {
                        const geckoTokens = await this.fetchTop100FromGecko();
                        await this.processAndSaveTokens(geckoTokens, 'GECKO');
                    } catch (err) {
                        console.error(`🚨 [Gecko 引擎崩潰] ${err.message}`);
                        geckoSuspendedUntil = Date.now() + 60 * 60 * 1000; 
                    }
                }

                await new Promise(r => setTimeout(r, 15000));

                if (Date.now() > birdeyeSuspendedUntil) {
                    try {
                        const birdTokens = await this.fetchFromBirdeye();
                        if (birdTokens.length > 0) {
                            await this.processAndSaveTokens(birdTokens, 'BIRDEYE');
                        }
                    } catch (err) {
                        console.error(`🚨 [Birdeye 引擎崩潰] ${err.message}`);
                        birdeyeSuspendedUntil = Date.now() + 60 * 60 * 1000; 
                    }
                }

                if (trendingJob && typeof trendingJob.triggerImmediateAndResetClock === 'function') {
                    trendingJob.triggerImmediateAndResetClock();
                }

            } catch (err) {
                console.error(`❌ [情報網] 主排程異常:`, err.message);
            } finally {
                isCrawlerRunning = false;
            }
        };

        setTimeout(() => { runTask(); }, 5000); 
        setInterval(runTask, 30 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };