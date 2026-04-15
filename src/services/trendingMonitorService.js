// src/services/trendingMonitorService.js
// 📝 檔案功能用途：V10.13 雙引擎隱形獵人。
// 🚀 數據源升級：由 Birdeye 轉向 Defined.fi (Codex) SDK，單次極速獲取 150 隻熱門幣。
// 🛠️ 終極修復：修正 nameStr 崩潰 Bug；改為 RAM 集中過濾，保留所有原有防偽/冷卻 Policy，並只寫入 trending_pool。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { cacheManager } = require('./cacheManager'); 
const configEnv = require('../config/config');
const Redis = require('ioredis');
const { Codex } = require('@codex-data/sdk'); 

const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');

// 🎯 初始化 Codex SDK
const sdk = new Codex(process.env.DEFINED_API_KEY);

let isCrawlerRunning = false;
let geckoSuspendedUntil = 0;
let definedSuspendedUntil = 0; 

const trendingMonitorService = {
    // ==========================================
    // 🦎 引擎 1：Gecko 爬蟲 (保持原有分頁邏輯)
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
    // 🦅 引擎 2：Defined.fi (Codex) SDK 爬蟲
    // ==========================================
    async fetchFromDefined() {
        console.log('🦅 [Defined SDK] 啟動天眼：獲取 150 隻高質素 Solana 熱門幣...');
        
        try {
            const response = await sdk.queries.filterTokens({
                filters: {
                    network: [1399811149], 
                    volume24: { gt: 50000 },
                    liquidity: { gt: 10000 }
                },
                rankings: [
                    { attribute: 'trendingScore24', direction: 'DESC' }
                ],
                limit: 150
            });

            const tokens = response?.filterTokens?.results || [];
            console.log(`📑 [Defined SDK] 成功獲取 ${tokens.length} 隻高質素熱門幣！`);

            return tokens.map(t => ({
                mint_address: t.token.address,
                token_symbol: (t.token.symbol || 'UNKNOWN').toUpperCase(),
                token_name: t.token.name || 'UNKNOWN',
                liquidity: t.liquidity || 50000,
                volume_24h: t.volume24 || 150000,
                price_change_24h: t.change24 || 0
            }));

        } catch (error) {
            console.error(`❌ [Defined SDK] 獲取失敗:`, JSON.stringify(error.response?.data || error.message));
            return [];
        }
    },

    // ==========================================
    // 🧠 共用處理核心 (保留所有原有 Policy，集中寫入 trending_pool)
    // ==========================================
    async processAndSaveTokens(standardizedTokens) {
        if (!standardizedTokens || standardizedTokens.length === 0) return;

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

        // 1. RAM 初步篩選與防偽
        for (const token of standardizedTokens) {
            const { mint_address, token_symbol, token_name, liquidity } = token;
            if (!mint_address || mint_address.length < 32 || blacklist.includes(mint_address)) continue;
            if (liquidity < 1000) continue; 

            const sym = (token_symbol || 'UNKNOWN').toUpperCase();
            const name = (token_name || 'UNKNOWN');

            // 🚀 核心修復 1：擊殺 nameStr 未定義報錯，統一使用 token_name
            if (/[^\x00-\x7F]/.test(sym) || /[^\x00-\x7F]/.test(name)) {
                nonAsciiCount++;
                continue; 
            }

            if (VERIFIED_TOKENS[sym] && mint_address !== VERIFIED_TOKENS[sym]) {
                if (VERIFIED_TOKENS[sym].startsWith('BlockList')) {
                    dbBlacklistCount[sym] = (dbBlacklistCount[sym] || 0) + 1;
                } else {
                    fakeBlockCount[sym] = (fakeBlockCount[sym] || 0) + 1;
                }
                continue; 
            }

            let isBrandTrap = false;
            for (const brand of BRAND_BLACKLIST) {
                if (sym.includes(brand) && !VERIFIED_TOKENS[sym]) {
                    isBrandTrap = true;
                    brandShieldCount[sym] = (brandShieldCount[sym] || 0) + 1;
                    break;
                }
            }
            if (isBrandTrap) continue;

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

        const dbParams = cacheManager.getStrategy('TRENDING');
        const dynamicMinLiquidity = dbParams?.min_liquidity || 50000; 

        let incubatorArray = [];
        let autoWhitelistArray = []; 
        let uniqueMints = new Set();
        let currentRank = 1;

        const portfolio = getPortfolio();
        const activePositions = portfolio.positions || [];
        const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

        // 2. 執行冷卻期與白名單 Policy
        for (const token of deduplicatedTokens) {
            const { mint_address, token_symbol, liquidity } = token;
            const sym = (token_symbol || 'UNKNOWN').toUpperCase();

            // 超高流動性自動加入白名單
            if (liquidity > 500000 && !VERIFIED_TOKENS[sym]) {
                autoWhitelistArray.push({ token_symbol: sym, mint_address: mint_address, is_active: true });
                VERIFIED_TOKENS[sym] = mint_address; 
            }

            if (uniqueMints.has(mint_address)) continue;
            uniqueMints.add(mint_address);

            // 限制最多檢查前 150 隻 (因為合併了兩個來源)
            if (currentRank > 150) break; 

            const dbData = { ...token, source: 'MERGED_RAM', updated_at: new Date().toISOString() };

            if (liquidity >= dynamicMinLiquidity) {
                const isBlacklisted = await redis.get(`scam_blacklist:${mint_address}`);
                const isHolding = activePositions.some(p => p.mint_address === mint_address);
                
                if (!isBlacklisted && !isHolding) {
                    // 執行 24 小時冷卻期檢查
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

        // 3. 一次過 Batch Upsert 上 Supabase
        if (autoWhitelistArray.length > 0) {
            const { error: whitelistErr } = await supabase.from('verified_tokens').upsert(autoWhitelistArray, { onConflict: 'token_symbol' });
            if (!whitelistErr) console.log(`✅ [Auto-Whitelist] 成功將 ${autoWhitelistArray.length} 隻代幣加入防偽白名單！`);
        }

        // 🚀 核心修復 2：移除 trending_top100，只寫入 trending_pool
        if (incubatorArray.length > 0) {
            const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
            if (!error) console.log(`🦎 [RAM_MERGED] 淨化完成，成功將 ${incubatorArray.length} 隻嚴選獵物一次過送入天網保溫箱！`);
            else console.error(`❌ [RAM_MERGED] 寫入 trending_pool 失敗:`, error.message);
        } else {
            console.log(`ℹ️ [RAM_MERGED] 本次掃描沒有符合條件的新熱門幣進入保溫箱。`);
        }
    },

    start() {
        console.log('🦎🦅 [雙軌情報網] V10.28 掛載啟動 (RAM 集中淨化版)...');
        
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

                let geckoTokens = [];
                let definedTokens = [];

                if (Date.now() > geckoSuspendedUntil) {
                    try { geckoTokens = await this.fetchTop100FromGecko(); } 
                    catch (err) { geckoSuspendedUntil = Date.now() + 60 * 60 * 1000; }
                }

                // 給予適當冷卻避免 API 限流
                await new Promise(r => setTimeout(r, 10000));

                if (Date.now() > definedSuspendedUntil) {
                    try { definedTokens = await this.fetchFromDefined(); } 
                    catch (err) { definedSuspendedUntil = Date.now() + 60 * 60 * 1000; }
                }

                // 🚀 核心修復 3：將兩邊數據結合，送入 RAM 統一處理
                const combinedTokens = [...geckoTokens, ...definedTokens];
                if (combinedTokens.length > 0) {
                    console.log(`\n🔄 [情報網] 開始合併處理 ${combinedTokens.length} 筆原始數據...`);
                    await this.processAndSaveTokens(combinedTokens);
                }

            } catch (err) {
                console.error(`❌ [情報網] 主排程異常:`, err.message);
            } finally {
                isCrawlerRunning = false;
            }
        };

        setTimeout(() => { runTask(); }, 5000); 
        // 配合你 15 分鐘的要求，我改為 15 * 60 * 1000 (原本係 30 分鐘)
        setInterval(runTask, 15 * 60 * 1000); 
    }
};

module.exports = { trendingMonitorService };