// src/microservices/macro_sync_center.js
// 📝 檔案功能用途：V10 【後勤樞紐】微服務 (Microservice Core)
// 🚀 核心升級：4D 氣候台 (硬數據 + 新聞 AI 融合)、3分鐘死亡開關、Zod ML 強類型代碼編譯、API 榨汁機升級。
// 🦎 擴充掛載：整合 trendingMonitorService、trendingJob 以及所有 V9 背景排程。

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
            console.log(`🧠 [Rule Compiler] 已編譯 ${validConditions.length} 條規則寫入 Redis。`);
        }

        const { data: brands } = await supabase.from('brand_blacklist').select('brand_name').eq('is_active', true);
        if (brands) {
            const brandArray = brands.map(b => b.brand_name.toUpperCase());
            await redis.set('cache:brand_blacklist', JSON.stringify(brandArray));
            console.log(`🛡️ [Hot Cache] 已同步 ${brandArray.length} 個動態品牌黑名單至 Redis。`);
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
           .subscribe();
}

// ------------------------------------------------------------------
// 3. 4D 大市氣候台與 3分鐘死亡開關 (硬數據 + 新聞 AI 融合版)
// ------------------------------------------------------------------
class EnvironmentCenter {
    
    // 🎯 升級 1：API 榨汁機，一次過獲取 24h 變化與交易量
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
                    // KuCoin Fallback
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

    // 🎯 升級 2：獲取系統 24 小時內部勝率
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
        } catch(e) {
            return 50.0;
        }
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
                if (feed?.items) titles = feed.items.slice(0, 15).map(item => item.title); // 取 Top 15 突發

                if (titles.length > 0) {
                    activeNewsIdx = (activeNewsIdx + i + 1) % NEWS_PROVIDERS.length;
                    return titles;
                }
            } catch (err) {}
        }
        return ["No breaking news available."]; 
    }

    // 🎯 升級 3：硬數據 + 新聞 = 終極 AI 融合推論
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

        try {
            const promptStr = `You are the Chief Macro Economist for a Solana High-Frequency Trading bot.

[Hard Data]
- BTC 24h Change: ${metrics.btc_change.toFixed(2)}% (Vol: $${(metrics.btc_vol/1e9).toFixed(1)}B)
- SOL 24h Change: ${metrics.sol_change.toFixed(2)}% (Vol: $${(metrics.sol_vol/1e9).toFixed(1)}B)
- Network Congestion (Jito Tip): ${jitoP50} lamports
- Bot Internal Win Rate (24h): ${winRate.toFixed(1)}%

[Latest Breaking News]
${titles.map((t, i) => `${i+1}. ${t}`).join('\n')}

[Task]
Based on the data AND news context, is this a healthy correction, a normal chop, a raging bull, or a black swan?
Decide the Climate: [BULL_FRENZY, CHOPPY, BEAR_PANIC]
Determine the News Sentiment Score: -5 (Extreme Fear) to 5 (Extreme Greed).
Output exact JSON format: {"climate": "CHOPPY", "news_score": 0, "reasoning": "<short cantonese explanation>"}`;

            const parsedAI = await keyRotator.enqueueRequest('MISTRAL', async (apiKey) => {
                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: 'mistral-small-latest', 
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

        } catch (err) {
            console.warn(`⚠️ [AI Macro] 交叉分析失敗 (${err.message})，降級使用硬邏輯判斷。`);
            if (metrics.btc_change <= -5.0 || metrics.sol_change <= -8.0 || winRate < 15) {
                currentClimate = 'BEAR_PANIC';
            } else if (metrics.sol_change >= 5.0 && winRate > 60) {
                currentClimate = 'RAGING_BULL';
            }
        }

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
// 4. 60 分鐘超時安全降級 (Auto Apply Safe Mode Fallback)
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

                await supabase.from('daily_audit_reports').insert([{ 
                    analysis_content: `【自動安全降級套用】\n60分鐘未審批，系統已自動套用 ML 數學參數（已強制 Clip 限幅），並拒絕了 LLM 的 Prompt 修改。`, 
                    param_changes: safeParameters 
                }]);
                
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
    console.log('🕒 [Cron] 60 分鐘實體防丟失自動套用排程已啟動 (Safe Mode Guardrails Active)。');

    // 🎯 啟動所有掛載的排程與爬蟲
    trendingMonitorService.start();
    trendingJob.start(); 
    janitorJob.start();
    graveyardJob.start();
    retrospectiveJob.start();

    // 🎯 實時戰報打印 
    setInterval(async () => {
        try {
            const port = getPortfolio();
            if (!port) return;
            const hkd = await getSolPriceInHKD();
            const totalSol = port.cash_sol + port.positions.reduce((sum, p) => sum + (p.quantity * p.entry_price_sol), 0);
            
            const modeText = port.mode === 'PAPER' ? '📝 模擬盤' : '🔥 實盤';
            console.log(`\n========================================`);
            console.log(`📊 [實時戰報] ${modeText} | 總資產: $${(totalSol * hkd).toFixed(2)} HKD | 現金: ${port.cash_sol.toFixed(4)} SOL`);
            console.log(`持倉數: ${port.positions.length} 隻`);
            console.log(`========================================\n`);
        } catch(e) {}
    }, 15 * 60 * 1000); 
}

bootstrap();