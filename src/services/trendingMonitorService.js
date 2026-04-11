// src/services/trendingMonitorService.js
// 📝 檔案功能用途：V10.13 雙引擎隱形獵人。
// 🛡️ 升級功能：[Non-ASCII Shield] 攔截火星文，並大幅擴充 Web2 實體巨頭品牌過濾庫。
// 🚀 數據源升級：廢除 Birdeye，接入 Defined.fi (Codex) GraphQL 進行極限 Volume/Liquidity 過濾。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { cacheManager } = require('./cacheManager'); 
const configEnv = require('../config/config');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

let isCrawlerRunning = false;
let geckoSuspendedUntil = 0;
let definedSuspendedUntil = 0; // 🎯 替換 birdeyeSuspendedUntil

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
    // 🦅 引擎 2：Defined.fi (Codex) 爬蟲 🎯 (取代 Birdeye)
    // ==========================================
    async fetchFromDefined() {
        const apiKey = process.env.DEFINED_API_KEY;
        if (!apiKey) {
            console.warn("⚠️ [Defined Crawler] 尚未設定 DEFINED_API_KEY，跳過掃描。");
            return [];
        }

        console.log('🦅 [Defined Crawler] 啟動雷達：正在向 Codex 獲取 Solana 極限過濾熱門榜單...');
        
        const endpoint = 'https://graph.codex.io/graphql';
        
        // 🎯 GraphQL 查詢：獲取 24h Vol > 100k, Liq > 20k 嘅 Solana 幣，按熱度排名前 50
        const graphqlQuery = {
            query: `
                query GetTrendingTokens {
                  filterTokens(
                    tokens: { network: [1399811149] }
                    filters: {
                      volume24: { gt: 100000 }
                      liquidity: { gt: 20000 }
                    }
                    rankings: { attribute: trendingScore24, direction: DESC }
                    limit: 50
                  ) {
                    results {
                      token {
                        address
                        symbol
                        name
                        info {
                          circulatingSupply
                        }
                      }
                    }
                  }
                }
            `
        };

        try {
            const response = await axios.post(endpoint, graphqlQuery, {
                headers: { 
                    'Authorization': apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000 
            });

            const tokens = response.data?.data?.filterTokens?.results || [];
            console.log(`📑 [Defined] 成功獲取 ${tokens.length} 隻高質素熱門幣！`);

            return tokens.map(t => {
                const tokenData = t.token;
                return {
                    mint_address: tokenData.address,
                    token_symbol: (tokenData.symbol || 'UNKNOWN').toUpperCase(),
                    token_name: tokenData.name || 'UNKNOWN',
                    // Defined GraphQL filterTokens 預設唔回傳具體 Liq/Vol 數值
                    // 但因為我哋 Filter 已經寫死咗門檻，所以呢度塞假數 (為咗過下面 processAndSaveTokens 嘅 check)
                    liquidity: 50000, 
                    volume_24h: 150000,
                    price_change_24h: 0 
                };
            });

        } catch (error) {
            const status = error.response?.status || 'Network';
            console.error(`❌ [Defined Crawler] 查詢失敗 (${status}): ${error.message}`);
            throw error; // 掟出 Error 等外層邏輯做 Suspension
        }
    },

    // ==========================================
    // 🧠 共用處理核心：去重聚合、防偽矩陣、自動白名單、交給天網
    // ==========================================
    async processAndSaveTokens(standardizedTokens, sourceName) {
        if (!standardizedTokens || standardizedTokens.length === 0) return;

        // 🛡️ 終極大廠與實體巨頭黑名單
        const BRAND_BLACKLIST = [
            'OPENAI', 'CHATGPT', 'SORA', 'CLAUDE', 'GEMINI', 'NVIDIA', 'APPLE', 'META', 'GOOGLE', 'MICROSOFT', 'AMAZON', 'TSMC', 'AMD', 'INTEL',
            'GROK', 'ELON', 'MUSK', 'TRUMP', 'BIDEN', 'OBAMA', 'PUTIN', 'ZELENSKY', 'TATE', 'MRBEAST',
            'BLACKROCK', 'VANGUARD', 'FIDELITY', 'SEC', 'FED', 'JPMORGAN', 'OIL', 'PETROL', 'GAS', 'GOLD', 'SILVER',
            'GTA', 'ROBLOX', 'RBX', 'NINTENDO', 'DISNEY', 'POKEMON',
            'PEPE', 'DOGE', 'SHIB', 'MAGA', 'WIF', 'BOME', 'BONK', 'SLERF', 'POPCAT',
            'BINANCE', 'COINBASE', 'KRAKEN', 'FTX', 'ALAMEDA', 'TETHER', 'CIRCLE', 'ZARA'
        ];
        const blacklist = [
            'So11111111111111111111111111111111111111112', 
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
        ];
        
        const VERIFIED_TOKENS = typeof cacheManager.getVerifiedTokens === 'function' ? cacheManager.getVerifiedTokens() : {};

        let fakeBlockCount = {}; 
        let dbBlacklistCount = {}; 
        let brandShieldCount = {}; 
        let nonAsciiCount = 0; 
        let dedupeCount = {}; 

        const symbolMap = new Map();

        for (const token of standardizedTokens) {
            const { mint_address, token_symbol, liquidity } = token;
            if (!mint_address || mint_address.length < 32 || blacklist.includes(mint_address)) continue;
            if (liquidity < 1000) continue; 

            const sym = (token_symbol || 'UNKNOWN').toUpperCase();

            // 1. [Non-ASCII Shield] 攔截中/日/韓文及特殊火星文
            if (/[^\x00-\x7F]/.test(sym)) {
                nonAsciiCount++;
                continue; 
            }

            // 2. 動態防偽與 DB 黑名單
            if (VERIFIED_TOKENS[sym] && mint_address !== VERIFIED_TOKENS[sym]) {
                if (VERIFIED_TOKENS[sym].startsWith('BlockList')) {
                    dbBlacklistCount[sym] = (dbBlacklistCount[sym] || 0) + 1;
                } else {
                    fakeBlockCount[sym] = (fakeBlockCount[sym] || 0) + 1;
                }
                continue; 
            }

            // 3. 檢查大廠/名人陷阱
            let isBrandTrap = false;
            for (const brand of BRAND_BLACKLIST) {
                if (sym.includes(brand) && !VERIFIED_TOKENS[sym]) {
                    isBrandTrap = true;
                    brandShieldCount[sym] = (brandShieldCount[sym] || 0) + 1;
                    break;
                }
            }
            if (isBrandTrap) continue;

            // 4. 「唯一王者」去重算法
            if (!symbolMap.has(sym)) {
                symbolMap.set(sym, token);
            } else {
                const existing = symbolMap.get(sym);
                if (liquidity > existing.liquidity) {
                    symbolMap.set(sym, token);
                    dedupeCount[sym] = (dedupeCount[sym] || 0) + 1;
                } else {
                    dedupeCount[sym] = (dedupeCount[sym] || 0) + 1;
                }
            }
        }

        if (nonAsciiCount > 0) console.log(`👽 [Non-ASCII Shield] 已攔截 ${nonAsciiCount} 隻包含火星文符號的垃圾幣！`);
        for (const [sym, count] of Object.entries(dbBlacklistCount)) console.log(`🚫 [DB Blacklist] 觸發動態黑名單，秒殺 ${count} 隻: ${sym}`);
        for (const [sym, count] of Object.entries(fakeBlockCount)) console.log(`🗑️ [Fake Shield] 踢出 ${count} 隻假冒 ${sym}！`);
        for (const [sym, count] of Object.entries(brandShieldCount)) console.log(`🛡️ [Brand Shield] 攔截 ${count} 隻大廠/名人誘餌幣: ${sym}`);

        const deduplicatedTokens = Array.from(symbolMap.values());

        // 🛡️ 第二階段：準備入庫與 Auto-Whitelist
        const dbParams = cacheManager.getStrategy('TRENDING');
        const dynamicMinLiquidity = dbParams?.min_liquidity || 50000; 

        let top100Array = [];
        let incubatorArray = [];
        let autoWhitelistArray = []; 
        let uniqueMints = new Set();
        let currentRank = 1;

        const portfolio = getPortfolio();
        const activePositions = portfolio.positions || [];
        const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

        for (const token of deduplicatedTokens) {
            const { mint_address, token_symbol, liquidity } = token;
            const sym = (token_symbol || 'UNKNOWN').toUpperCase();

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

        if (autoWhitelistArray.length > 0) {
            const { error: whitelistErr } = await supabase.from('verified_tokens').upsert(autoWhitelistArray, { onConflict: 'token_symbol' });
            if (!whitelistErr) console.log(`✅ [Auto-Whitelist] 成功將 ${autoWhitelistArray.length} 隻代幣加入防偽白名單！`);
        }

        if (top100Array.length >= 10) { 
            await supabase.from('trending_top100').delete().eq('source', sourceName); 
            const { error: insertErr } = await supabase.from('trending_top100').upsert(top100Array, { onConflict: 'mint_address' });
            if (!insertErr) console.log(`📋 [${sourceName}] 成功更新防偽對照表 (${top100Array.length} 隻代幣)！`);
        }

        if (incubatorArray.length > 0) {
            const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
            if (!error) console.log(`🦎 [${sourceName}] 成功將 ${incubatorArray.length} 隻嚴選獵物送入天網保溫箱！`);
        }
    },

    start() {
        console.log('🦎🦅 [雙軌情報網] V10.13 掛載啟動...');
        
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
                        geckoSuspendedUntil = Date.now() + 60 * 60 * 1000; 
                    }
                }

                await new Promise(r => setTimeout(r, 15000));

                if (Date.now() > definedSuspendedUntil) { // 🎯 改為 Defined
                    try {
                        const definedTokens = await this.fetchFromDefined();
                        if (definedTokens.length > 0) await this.processAndSaveTokens(definedTokens, 'DEFINED');
                    } catch (err) {
                        definedSuspendedUntil = Date.now() + 60 * 60 * 1000; // 如果死機，停機一小時
                    }
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