// src/microservices/macro_sync_center.js
// 📝 檔案功能用途：V10 【後勤樞紐】微服務 (Microservice Core)
// 🚀 核心升級：徹底拔除 Hardcode Prompt，全面依賴 Supabase 動態變數注入 (Zero-Prompt Codebase)。
// 🛡️ 容錯升級：實裝 MISTRAL 三重 Model 陣列切換邏輯 (Graceful Fallback)。
// 🦎 擴充掛載：整合 trendingMonitorService、trendingJob 以及所有 V9 背景排程，並加入 Dashboard 心跳機制。
// 📢 Telegram 升級：AI 診斷氣候/分數發生變化時，即時推送 Comment 與理據至 SQL QUANT ALert。

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');
const axios = require('axios');
const Parser = require('rss-parser');
const cron = require('node-cron');
const { z } = require('zod');

// 載入 V9 底層依賴
const { keyRotator } = require('../services/keyRotator');
const { sendMacroPanicApproval, sendAdminAlert } = require('../services/telegramService');
const { trendingMonitorService } = require('../services/trendingMonitorService'); 
const { initPortfolio, getPortfolio } = require('../services/portfolioService'); 
const { getSolPriceInHKD } = require('../services/priceService'); 

// 🚀 引入維運中樞
const { healthMonitor } = require('../services/healthMonitor');

// 🎯 引入 V9 孤兒排程
const { janitorJob } = require('../jobs/janitorJob');
const { graveyardJob } = require('../jobs/graveyardJob');
const { retrospectiveJob } = require('../jobs/retrospectiveJob');
const { trendingJob } = require('../jobs/trendingJob'); 

// ------------------------------------------------------------------
// 1. 初始化與全域變數
// ------------------------------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const redis = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || 'redis://localhost:6379');
const parser = new Parser();

const MACRO_PROVIDERS = [{ name: 'COINGECKO', keyName: 'COINGECKO_API_KEY' }, { name: 'KUCOIN', keyName: null }];
const NEWS_PROVIDERS = [
    { name: 'COINTELEGRAPH', type: 'RSS', url: 'https://cointelegraph.com/rss' },
    { name: 'DECRYPT', type: 'RSS', url: 'https://decrypt.co/feed' },
    { name: 'COINDESK', type: 'RSS', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }
];

let activeMacroIdx = 0;
let activeNewsIdx = 0;

// ------------------------------------------------------------------
// 2. 全域熱緩存同步橋樑 (Hot Cache Bridge) & 動態規則編譯
// ------------------------------------------------------------------
async function syncCoreConfigsToRedis() {
    try {
        console.log('🔄 [Hot Cache] 正在將 Supabase 配置同步至 Redis 記憶體...');
        
        const { data: prompts } = await supabase.from('bot_prompts').select('*');
        if (prompts) {
            const promptMap = {};
            prompts.forEach(p => promptMap[p.prompt_id] = p);
            await redis.set('cache:bot_prompts', JSON.stringify(promptMap));
        }

        const { data: tokens } = await supabase.from('verified_tokens').select('token_symbol, mint_address').eq('is_active', true);
        if (tokens) {
            const tokenDict = {};
            tokens.forEach(t => tokenDict[t.token_symbol] = t.mint_address);
            await redis.set('cache:verified_tokens', JSON.stringify(tokenDict));
        }

        const { data: params } = await supabase.from('ai_strategy_params').select('*');
        if (params) {
            await redis.set('cache:ai_strategy_params', JSON.stringify(params));
        }

        const { data: mlRules } = await supabase.from('ml_blacklist_rules').select('*').eq('is_active', true);
        if (mlRules) {
            const RuleSchema = z.object({
                metric_name: z.string(),
                operator: z.enum(['>', '<', '=', '>=', '<=']),
                threshold_value: z.number()
            });

            const FIELD_MAP = {
                'price': 'p', 'volume_5m': 'v', 'volume': 'v',
                'buys': 'b', 'sells': 's', 'liquidity': 'l', 'liquidity_usd': 'l'
            };

            const validConditions = [];
            for (const row of mlRules) {
                const parsed = RuleSchema.safeParse({
                    metric_name: row.metric_name, operator: row.operator, threshold_value: parseFloat(row.threshold_value)
                });
                
                if (parsed.success) {
                    const { metric_name, operator, threshold_value } = parsed.data;
                    const mappedMetric = FIELD_MAP[metric_name] || metric_name; 
                    validConditions.push(`(data.${mappedMetric} !== undefined && data.${mappedMetric} ${operator} ${threshold_value})`);
                }
            }
            
            const funcBody = validConditions.length > 0 ? `return ${validConditions.join(' || ')};` : `return false;`;
            await redis.set('cache:ml_compiled_rule_string', funcBody);
        }

        const { data: brands } = await supabase.from('brand_blacklist').select('brand_name').eq('is_active', true);
        if (brands) {
            const brandArray = brands.map(b => b.brand_name.toUpperCase());
            await redis.set('cache:brand_blacklist', JSON.stringify(brandArray));
        }
        
        const { data: mlParams } = await supabase.from('ml_strategy_params').select('*');
        if (mlParams) {
            await redis.set('ml_strategy_params', JSON.stringify(mlParams));
        }

        console.log('✅ [Hot Cache] 神經網絡與黑名單緩存同步完成！');
    } catch (e) {
        console.error('❌ [Hot Cache] 同步失敗:', e.message);
    }
}

function setupRealtimeListeners() {
    const channel = supabase.channel('system_hot_swap');
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'bot_prompts' }, syncCoreConfigsToRedis)
           .on('postgres_changes', { event: '*', schema: 'public', table: 'verified_tokens' }, syncCoreConfigsToRedis)
           .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_strategy_params' }, syncCoreConfigsToRedis)
           .on('postgres_changes', { event: '*', schema: 'public', table: 'ml_blacklist_rules' }, syncCoreConfigsToRedis)
           .on('postgres_changes', { event: '*', schema: 'public', table: 'brand_blacklist' }, syncCoreConfigsToRedis)
           .on('postgres_changes', { event: '*', schema: 'public', table: 'ml_strategy_params' }, syncCoreConfigsToRedis)
           .subscribe();
}

// ------------------------------------------------------------------
// 3. 4D 大市氣候台與 3分鐘死亡開關
// ------------------------------------------------------------------
class EnvironmentCenter {
    constructor() {
        this.last_climate = null;
        this.last_news_score = null;
    }

    async _fetchMarketMetrics() {
        for (let i = 0; i < MACRO_PROVIDERS.length; i++) {
            const provider = MACRO_PROVIDERS[(activeMacroIdx + i) % MACRO_PROVIDERS.length];
            try {
                let btc_change = 0, btc_vol = 0, sol_change = 0, sol_vol = 0;
                
                if (provider.name === 'COINGECKO') {
                    const rawKey = process.env[provider.keyName];
                    const apiKey = rawKey ? rawKey.replace(/['"]/g, '').trim() : null;
                    const cfg = { headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {}, timeout: 8000 };
                    
                    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, cfg);
                    
                    btc_change = res.data.bitcoin.usd_24h_change || 0;
                    btc_vol = res.data.bitcoin.usd_24h_vol || 0;
                    sol_change = res.data.solana.usd_24h_change || 0;
                    sol_vol = res.data.solana.usd_24h_vol || 0;
                } else {
                    const [btcRes, solRes] = await Promise.all([
                        axios.get(`https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT`, { timeout: 8000 }),
                        axios.get(`https://api.kucoin.com/api/v1/market/stats?symbol=SOL-USDT`, { timeout: 8000 })
                    ]);
                    btc_change = parseFloat(btcRes.data.data.changeRate) * 100 || 0;
                    btc_vol = parseFloat(btcRes.data.data.volValue) || 0;
                    sol_change = parseFloat(solRes.data.data.changeRate) * 100 || 0;
                    sol_vol = parseFloat(solRes.data.data.volValue) || 0;
                }
                
                activeMacroIdx = (activeMacroIdx + i) % MACRO_PROVIDERS.length;
                return { btc_change, btc_vol, sol_change, sol_vol };
            } catch (err) {}
        }
        return { btc_change: 0, btc_vol: 0, sol_change: 0, sol_vol: 0 }; 
    }

    async _fetchInternalWinRate() {
        try {
            const portfolio = getPortfolio();
            if (!portfolio) return 50.0;
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            const { data: trades } = await supabase
                .from(`trade_history_${tableSuffix}`)
                .select('realized_pnl_pct')
                .gte('created_at', oneDayAgo)
                .in('action', ['SELL', 'SELL_HALF', 'LIQUIDATED']);
            
            if (!trades || trades.length === 0) return 50.0;
            const wins = trades.filter(t => t.realized_pnl_pct > 0).length;
            return (wins / trades.length) * 100;
        } catch(e) { return 50.0; }
    }

    async _fetchJitoCongestion() {
        try {
            const res = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { timeout: 2000 });
            if (res.data && res.data.length > 0) return res.data[0].landed_tips_50th_percentile || 150000;
        } catch (err) {}
        return 150000;
    }

    async _fetchNewsTitles() {
        for (let i = 0; i < NEWS_PROVIDERS.length; i++) {
            const provider = NEWS_PROVIDERS[(activeNewsIdx + i) % NEWS_PROVIDERS.length];
            try {
                let titles = [];
                const res = await axios.get(provider.url, { timeout: 10000 });
                const feed = await parser.parseString(res.data);
                if (feed?.items) titles = feed.items.slice(0, 15).map(item => item.title);

                if (titles.length > 0) {
                    activeNewsIdx = (activeNewsIdx + i + 1) % NEWS_PROVIDERS.length;
                    return titles;
                }
            } catch (err) {}
        }
        return ["No breaking news available."]; 
    }

    async updateEnvironment() {
        console.log(`🌍 [Macro Center] 天文台正在採集 4D 大市氣候 (硬數據 + 新聞)...`);
        
        const [metrics, winRate, jitoP50, titles] = await Promise.all([
            this._fetchMarketMetrics(),
            this._fetchInternalWinRate(),
            this._fetchJitoCongestion(),
            this._fetchNewsTitles()
        ]);

        let currentClimate = 'CHOPPY';
        let newsScore = 0;
        let aiReasoning = "純數降級模式 (無 AI 回應)";

        let mistralModels = ['mistral-small-latest', 'ministral-8b-latest', 'open-mistral-nemo'];
        let rawPromptTemplate = `You are the Chief Macro Economist. Analyze data: BTC {{btc_change}}%, SOL {{sol_change}}%. News: {{titles}}. Output exact JSON format: {"climate": "CHOPPY", "news_score": 0, "reasoning": "..."}`;
        
        try {
            const cachedStr = await redis.get('cache:bot_prompts');
            if (cachedStr) {
                const pMap = JSON.parse(cachedStr);
                const dbPrompt = pMap['news_sentiment_analyst'];
                if (dbPrompt) {
                    if (dbPrompt.content) rawPromptTemplate = dbPrompt.content; 
                    if (dbPrompt.model_main) mistralModels[0] = dbPrompt.model_main;
                    if (dbPrompt.model_backup_1) mistralModels[1] = dbPrompt.model_backup_1;
                    if (dbPrompt.model_backup_2) mistralModels[2] = dbPrompt.model_backup_2;
                }
            }
        } catch (err) {
            console.warn("⚠️ [Macro Center] 無法讀取 Redis 模型設定，使用預設 Mistral 模型與防跌 Prompt");
        }

        const promptStr = rawPromptTemplate
            .replace(/{{btc_change}}/g, metrics.btc_change.toFixed(2))
            .replace(/{{btc_vol}}/g, (metrics.btc_vol/1e9).toFixed(1))
            .replace(/{{sol_change}}/g, metrics.sol_change.toFixed(2))
            .replace(/{{sol_vol}}/g, (metrics.sol_vol/1e9).toFixed(1))
            .replace(/{{jito_tip}}/g, jitoP50)
            .replace(/{{winRate}}/g, winRate.toFixed(1))
            .replace(/{{titles}}/g, titles.map((t, i) => `${i+1}. ${t}`).join('\n'));

        try {
            const parsedAI = await keyRotator.enqueueRequest('MISTRAL', async (apiKey, retryCount) => {
                const currentAttempt = retryCount || 0;
                const safeIndex = Math.min(currentAttempt, mistralModels.length - 1);
                const selectedModel = mistralModels[safeIndex];

                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: selectedModel, 
                    messages: [{ role: "user", content: promptStr }], 
                    response_format: { type: "json_object" }
                }, { headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
                
                return JSON.parse(res.data.choices[0].message.content);
            }, 'macro_climate_analyst'); 

            if (parsedAI.climate && ['BULL_FRENZY', 'CHOPPY', 'BEAR_PANIC'].includes(parsedAI.climate)) {
                currentClimate = parsedAI.climate;
            }
            if (parsedAI.news_score !== undefined) {
                newsScore = parseInt(parsedAI.news_score);
                newsScore = Math.max(-5, Math.min(5, isNaN(newsScore) ? 0 : newsScore));
            }
            aiReasoning = parsedAI.reasoning || '無具體解釋';
            
            console.log(`🤖 [AI Macro] 判定: ${currentClimate} | 情感: ${newsScore} | 理由: ${aiReasoning}`);
            healthMonitor.setStatus('Macro_Sync_Center', '🟢 氣候監控中', `當前氣候: ${currentClimate}`);

        } catch (err) {
            console.warn(`⚠️ [AI Macro] 交叉分析失敗 (${err.message})，降級使用硬邏輯判斷。`);
            if (metrics.btc_change <= -5.0 || metrics.sol_change <= -8.0 || winRate < 15) {
                currentClimate = 'BEAR_PANIC';
            } else if (metrics.sol_change >= 5.0 && winRate > 60) {
                currentClimate = 'BULL_FRENZY'; // 確保硬邏輯降級都用正確名字
            }
            healthMonitor.setStatus('Macro_Sync_Center', '🟡 AI 分析超時，已降級硬邏輯', `降級氣候: ${currentClimate}`);
        }

        // 🚀 Telegram 推送：當氣候或情感分數有改變時，廣播去 SQL QUANT ALert
        const isClimateChanged = this.last_climate !== currentClimate;
        const isScoreChanged = this.last_news_score !== newsScore;

        if ((isClimateChanged || isScoreChanged) && this.last_climate !== null) {
            const climateEmoji = currentClimate === 'BULL_FRENZY' ? '🚀' : (currentClimate === 'BEAR_PANIC' ? '🩸' : '⚖️');
            const alertMsg = `🌍 <b>【AI 大市氣候變更通報】</b>\n\n` +
                             `🔄 <b>狀態切換:</b> ${this.last_climate || 'N/A'} ➡️ <b>${currentClimate}</b> ${climateEmoji}\n` +
                             `🌡️ <b>情感分數:</b> ${this.last_news_score || 'N/A'} ➡️ <b>${newsScore}</b>/5\n\n` +
                             `🧠 <b>AI 診斷理據:</b>\n<i>${aiReasoning}</i>\n\n` +
                             `📉 <b>硬數據參考:</b>\n` +
                             `• BTC 24h: ${metrics.btc_change.toFixed(2)}%\n` +
                             `• SOL 24h: ${metrics.sol_change.toFixed(2)}%\n` +
                             `• 內部勝率: ${winRate.toFixed(1)}%`;
            
            if (typeof sendAdminAlert === 'function') {
                sendAdminAlert(alertMsg).catch(e => console.error('Telegram 發送失敗', e));
            }
        }

        this.last_climate = currentClimate;
        this.last_news_score = newsScore;

        const envState = { climate: currentClimate, newsScore, jitoP50, timestamp: Date.now() };
        await redis.set('global_env_state', JSON.stringify(envState), 'EX', 3600);

        try { await supabase.from('system_config').update({ macro_climate: currentClimate, latest_news_score: newsScore }).eq('id', 1); } catch(e) {}

        if (currentClimate === 'BEAR_PANIC') {
            const isPending = await redis.get('macro_panic_pending');
            if (!isPending) {
                console.log(`🚨 [Macro Center] 偵測到 BEAR_PANIC 恐慌狀態！發送大盤熔斷審批！`);
                await redis.set('macro_panic_pending', Date.now().toString(), 'EX', 600); 
                if (typeof sendMacroPanicApproval === 'function') {
                    await sendMacroPanicApproval(`📉 BTC 24h: ${metrics.btc_change.toFixed(2)}%\n📉 SOL 24h: ${metrics.sol_change.toFixed(2)}%\n🏆 內部勝率: ${winRate.toFixed(1)}%\n🧠 AI 診斷: ${aiReasoning}`);
                }
            }
        }
    }

    async _checkDeadManSwitch() {
        try {
            const pendingStr = await redis.get('macro_panic_pending');
            if (!pendingStr) return;

            const pendingTime = parseInt(pendingStr, 10);
            if (Date.now() - pendingTime >= 180000) { 
                console.log(`💀 [Macro Failsafe] 3 分鐘未收到指揮官回覆，執行二次大盤評估...`);
                
                const metrics = await this._fetchMarketMetrics();
                await redis.del('macro_panic_pending'); 

                if (metrics.btc_change <= -3.0 || metrics.sol_change <= -5.0) {
                    if (typeof sendAdminAlert === 'function') sendAdminAlert(`🚨 <b>【自動開關已觸發】</b>\n\n3 分鐘未收到指揮官回覆，大市依然處於崩盤趨勢。\n🤖 <b>系統已接管控制權，向全軍發送全線強平指令！</b>`);
                    
                    await redis.publish('emergency_action', JSON.stringify({ 
                        action: 'LIQUIDATE_ALL', 
                        reason: '🚨 3分鐘自動開關：大盤未見好轉，自動全平倉防禦' 
                    }));
                    console.log(`📡 [Command] 全線強平 (LIQUIDATE_ALL) 指令已透過 Redis 發射！`);
                    
                } else {
                    if (typeof sendAdminAlert === 'function') sendAdminAlert(`✅ <b>【危機自然解除】</b>\n\n3 分鐘過去，大市跌幅已收斂。\n🤖 系統自動取消強平機制，維持正常運作。`);
                }
            }
        } catch (err) {
            console.error("❌ [Macro Failsafe] 死亡開關執行失敗:", err.message);
        }
    }
}

const envCenter = new EnvironmentCenter();

// ------------------------------------------------------------------
// 4. 60 分鐘超時安全降級
// ------------------------------------------------------------------
async function checkAndApply60MinFallback() {
    try {
        const { data: pendingProposals } = await supabase
            .from('ai_proposals')
            .select('*')
            .eq('status', 'PENDING');

        if (!pendingProposals || pendingProposals.length === 0) return;

        const now = Date.now();
        for (const prop of pendingProposals) {
            const createdAtMs = new Date(prop.created_at).getTime();
            
            if (now - createdAtMs >= 60 * 60 * 1000) {
                console.log(`⏰ [Auto-Fallback] ML 提案 ${prop.id} 已超時 60 分鐘。執行安全降級套用...`);
                
                const changes = typeof prop.proposed_changes === 'string' ? JSON.parse(prop.proposed_changes) : prop.proposed_changes;
                const safeParameters = changes.parameters || {};

                if (safeParameters.stop_loss_pct !== undefined) {
                    safeParameters.stop_loss_pct = Math.max(-30.0, Math.min(-5.0, Number(safeParameters.stop_loss_pct)));
                }
                if (safeParameters.max_buy_tip_pct !== undefined) {
                    safeParameters.max_buy_tip_pct = Math.max(0.001, Math.min(0.05, Number(safeParameters.max_buy_tip_pct)));
                }

                if (Object.keys(safeParameters).length > 0) {
                    await supabase.from('ai_strategy_params').update(safeParameters).in('id', [2, 3]);
                }

                await supabase.from('ai_proposals').update({ 
                    status: 'APPLIED_SAFE_MODE', 
                    updated_at: new Date().toISOString() 
                }).eq('id', prop.id);

                await syncCoreConfigsToRedis();
            }
        }
    } catch (err) {
        console.error("❌ [Auto-Fallback] 掃描失敗:", err.message);
    }
}

// ------------------------------------------------------------------
// 5. 啟動程序
// ------------------------------------------------------------------
async function bootstrap() {
    console.log("🛠️ SOL QUANT MACRO_SYNC_CENTER V10 (後勤樞紐) 啟動中...");
    
    await initPortfolio();
    
    syncCoreConfigsToRedis().then(() => {
        setupRealtimeListeners();
    });

    envCenter.updateEnvironment();
    setInterval(() => envCenter.updateEnvironment(), 15 * 60 * 1000);
    setInterval(() => envCenter._checkDeadManSwitch(), 60000);

    cron.schedule('* * * * *', () => checkAndApply60MinFallback());

    trendingMonitorService.start();
    trendingJob.start(); 
    janitorJob.start();
    graveyardJob.start();
    retrospectiveJob.start();

    await healthMonitor.setStatus('Macro_Sync_Center', '🟢 氣候監控中');
}

bootstrap();