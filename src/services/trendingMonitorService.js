// src/services/trendingMonitorService.js
// 📝 檔案功能用途：V10.7 雙引擎隱形獵人 (Gecko + Birdeye 靜默忍者版)。每 30 分鐘獲取全網最熱門榜單。
// 🛡️ 升級功能：放棄 DexScreener 爬蟲防撞機。加入 HTML 報錯過濾，遇 502/Timeout 果斷放棄重試，杜絕 Log 洗版與死亡迴圈。

const { supabase } = require('../config/supabase');
const axios = require('axios');
const { getPortfolio, canBuyTrending } = require('./portfolioService');
const { healthMonitor } = require('./healthMonitor');
const { trendingJob } = require('../jobs/trendingJob');
const { cacheManager } = require('./cacheManager'); 
const configEnv = require('../config/config');
const Redis = require('ioredis');
const { sendAdminAlert } = require('./telegramService');
const redis = new Redis(configEnv.cache.redisUrl);

let isCrawlerRunning = false;

let geckoSuspendedUntil = 0;
let birdeyeSuspendedUntil = 0;

const trendingMonitorService = {
    
    // ==========================================
    // 🦎 引擎 1：Gecko 爬蟲 (主打防偽大藍籌)
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
                        console.log(`⏳ [Gecko Crawler] 擬人化防護：等待 ${(delay/1000).toFixed(1)} 秒後再翻下一頁...`);
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
        if (!apiKey) {
            console.log('⚠️ [Birdeye Crawler] 缺少 BIRDEYE_API_KEY，跳過此情報源。');
            return [];
        }

        console.log('🦅 [Birdeye Crawler] 啟動天眼：準備分 5 批次獲取 Solana 熱門榜單 (嚴格遵守 limit=20 限制)...');
        let allTokens = [];
        const batchCount = 5;
        const limitPerBatch = 20;

        for (let i = 0; i < batchCount; i++) {
            let attempt = 0;
            let pageSuccess = false;
            const offset = i * limitPerBatch;

            // 忍者模式：每頁最多只試 3 次，唔得就直接放棄，唔好嘥時間死纏爛打
            while (!pageSuccess && attempt < 3) {
                try {
                    attempt++;
                    const response = await axios.get('https://public-api.birdeye.so/defi/token_trending', {
                        headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', 'accept': 'application/json' },
                        params: { sort_by: 'rank', sort_type: 'asc', offset: offset, limit: limitPerBatch },
                        timeout: 8000 // 8秒超時，唔好等太耐
                    });

                    const tokens = response.data?.data?.tokens || [];
                    allTokens = allTokens.concat(tokens);
                    pageSuccess = true;
                    console.log(`📑 [Birdeye] 第 ${i + 1} 批次 (${tokens.length} 隻) 抓取成功！`);

                    if (i < batchCount - 1) {
                        await new Promise(r => setTimeout(r, 2000)); // 正常 2 秒間隔
                    }

                } catch (error) {
                    const status = error.response?.status;
                    let isFatal = false;
                    let errorMsg = error.message;

                    // 🛑 終極防 HTML 洗版過濾器
                    if (error.response?.data) {
                        if (typeof error.response.data === 'string' && error.response.data.startsWith('<!DOCTYPE html>')) {
                            errorMsg = `Cloudflare ${status} Bad Gateway (官方伺服器死機)`;
                            isFatal = true; // 官方死機，無謂重試
                        } else {
                            errorMsg = JSON.stringify(error.response.data).substring(0, 100); // 只截取前 100 字元防洗版
                        }
                    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                        errorMsg = '請求超時 (Timeout)';
                        isFatal = true; // Timeout 代表 Server 擠塞，直接放棄
                    }

                    if (status === 400 || status === 401 || status === 403) {
                        console.error(`❌ [Birdeye Crawler] 拒絕連線 (${status}): ${errorMsg}`);
                        throw new Error(`Birdeye API 致命錯誤 (${status})`); // 呢啲錯誤要報警
                    }

                    if (isFatal || status === 502 || status === 503 || status === 504) {
                        console.warn(`⚠️ [Birdeye Crawler] 偵測到官方伺服器不穩定 (${errorMsg})。忍者模式啟動：放棄本輪剩餘抓取。`);
                        return allTokens; // 👈 核心修正：直接帶著目前手頭上攞到嘅代幣提早撤退，唔再浪費時間！
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
    // 🧠 共用處理核心：過濾、入庫、交給天網
    // ==========================================
    async processAndSaveTokens(standardizedTokens, sourceName) {
        if (!standardizedTokens || standardizedTokens.length === 0) return;

        const dbParams = cacheManager.getStrategy('TRENDING');
        const dynamicMinLiquidity = dbParams?.min_liquidity || 50000; 

        let top100Array = [];
        let incubatorArray = [];
        let uniqueMints = new Set();
        let currentRank = 1;

        const portfolio = getPortfolio();
        const activePositions = portfolio.positions || [];
        const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';

        const blacklist = [
            'So11111111111111111111111111111111111111112', 
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
        ];
        const VERIFIED_TOKENS = typeof cacheManager.getVerifiedTokens === 'function' ? cacheManager.getVerifiedTokens() : {};

        for (const token of standardizedTokens) {
            const { mint_address, token_symbol, liquidity } = token;

            if (!mint_address || mint_address.length < 32 || blacklist.includes(mint_address)) continue;
            if (liquidity < 1000) continue; 

            if (VERIFIED_TOKENS[token_symbol] && mint_address !== VERIFIED_TOKENS[token_symbol]) {
                console.log(`🗑️ [Fake Shield] 發現假冒 ${token_symbol} (${mint_address})，直接踢出！`);
                continue; 
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

        if (top100Array.length >= 10) { 
            await supabase.from('trending_top100').delete().eq('source', sourceName); 
            const { error: insertErr } = await supabase.from('trending_top100').upsert(top100Array, { onConflict: 'mint_address' });
            if (insertErr) console.error(`❌ [${sourceName}] 寫入 Top100 失敗:`, insertErr.message);
            else console.log(`📋 [${sourceName}] 成功更新防偽對照表 (${top100Array.length} 隻代幣)！`);
        }

        if (incubatorArray.length > 0) {
            const { error } = await supabase.from('trending_pool').upsert(incubatorArray, { onConflict: 'mint_address' });
            if (!error) {
                console.log(`🦎 [${sourceName}] 成功將 ${incubatorArray.length} 隻獵物送入天網保溫箱！`);
            }
        }
    },

    start() {
        console.log('🦎🦅 [雙軌情報網] Gecko + Birdeye 聯合監控啟動 (每 30 分鐘大換血，錯峰運行防 429)...');
        
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

                // ====================================================
                // 執行引擎 1：GECKO
                // ====================================================
                if (Date.now() > geckoSuspendedUntil) {
                    try {
                        const geckoTokens = await this.fetchTop100FromGecko();
                        await this.processAndSaveTokens(geckoTokens, 'GECKO');
                    } catch (err) {
                        console.error(`🚨 [Gecko 引擎崩潰] ${err.message}`);
                        geckoSuspendedUntil = Date.now() + 60 * 60 * 1000; 
                    }
                } else {
                    console.log('⏸️ [Gecko 引擎] 處於熔斷期 (1H)，暫時跳過本次掃描。');
                }

                console.log('⏳ [雙軌情報網] Gecko 掃描完畢，等待 15 秒後啟動 Birdeye 天眼...');
                await new Promise(r => setTimeout(r, 15000));

                // ====================================================
                // 執行引擎 2：BIRDEYE (忍者模式)
                // ====================================================
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
                } else {
                    console.log('⏸️ [Birdeye 引擎] 處於熔斷期 (1H)，暫時跳過本次掃描。');
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
