// src/microservices/macro_sync_center.js
// 📝 檔案功能用途：V10.51 【後勤樞紐】微服務 (Meme 專化 & 原汁原味 Base64 防腐版)
// 🚀 核心升級：實裝 Supabase Realtime 全域記憶體校準 (RAM Sync)，徹底消滅幽靈倉位。
// 🎯 氣候改造：引入 Boredom Pump (無聊炒作效應)，以 SOL 相對強弱與 Jito Tip 主導大市評分。
// 🛡️ 防禦升級：全線 API URL 採用 Base64 動態解碼，徹底解決 Chat 介面轉換 Markdown 導致的 Invalid URL 死機問題。

require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 50;
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const redis = new Redis(process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379');
const parser = new Parser();

const MACRO_PROVIDERS = [{ name: 'COINGECKO', keyName: 'COINGECKO_API_KEY' }, { name: 'KUCOIN', keyName: null }];

// 🛡️ URL Base64 防腐處理
const NEWS_PROVIDERS = [
    { name: 'COINTELEGRAPH', type: 'RSS', url: Buffer.from('aHR0cHM6Ly9jb2ludGVsZWdyYXBoLmNvbS9yc3M=', 'base64').toString('utf-8') },
    { name: 'DECRYPT', type: 'RSS', url: Buffer.from('aHR0cHM6Ly9kZWNyeXB0LmNvL2ZlZWQ=', 'base64').toString('utf-8') },
    { name: 'COINDESK', type: 'RSS', url: Buffer.from('aHR0cHM6Ly93d3cuY29pbmRlc2suY29tL2FyYy9vdXRib3VuZGZlZWRzL3Jzcy8=', 'base64').toString('utf-8') }
];

let activeMacroIdx = 0;
let activeNewsIdx = 0;

// 🚀 記憶體同步引擎
let portfolioSyncTimeout = null;
function schedulePortfolioSync(source) {
    if (portfolioSyncTimeout) clearTimeout(portfolioSyncTimeout);
    portfolioSyncTimeout = setTimeout(async () => {
        console.log(`🔄 [System Sync] 偵測到 ${source}，正在強制校準樞紐 RAM 倉位...`);
        try {
            await initPortfolio();
            console.log(`✅ [System Sync] 樞紐 RAM 倉位已與大本營 Database 完美清空/對齊！`);
        } catch (e) {
            console.error(`❌ [System Sync] 重新校準失敗:`, e.message);
        }
    }, 2000);
}

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
           .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_config', filter: 'id=eq.1' }, () => schedulePortfolioSync('System Config 變更'))
           .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'active_positions_paper' }, () => schedulePortfolioSync('Paper 倉位重置'))
           .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'active_positions_live' }, () => schedulePortfolioSync('Live 倉位重置'))
           .subscribe();
}

class EnvironmentCenter {
    
    async _fetchMarketMetrics() {
        for (let i = 0; i < MACRO_PROVIDERS.length; i++) {
            const provider = MACRO_PROVIDERS[(activeMacroIdx + i) % MACRO_PROVIDERS.length];
            try {
                let btc_change = 0, btc_vol = 0, sol_change = 0, sol_vol = 0;
                
                if (provider.name === 'COINGECKO') {
                    const rawKey = process.env[provider.keyName];
                    const apiKey = rawKey ? rawKey.replace(/['"]/g, '').trim() : null;
                    const cfg = { headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {}, timeout: 8000 };
                    
          // 🛡️ URL Base64 防腐處理 (已添加 include_1hr_change=true)
          const cgUrl = Buffer.from('aHR0cHM6Ly9hcGkuY29pbmdlY2tvLmNvbS9hcGkvdjMvc2ltcGxlL3ByaWNlP2lkcz1iaXRjb2luLHNvbGFuYSZ2c19jdXJyZW5jaWVzPXVzZCZpbmNsdWRlXzI0aHJfdm9sPXRydWUmaW5jbHVkZV8yNGhyX2NoYW5nZT10cnVlJmluY2x1ZGUfMWhyX2NoYW5nZT10cnVl', 'base64').toString('utf-8');
          const res = await axios.get(cgUrl, cfg);

          btc_change = res.data.bitcoin.usd_24h_change || 0;
          btc_vol = res.data.bitcoin.usd_24h_vol || 0;
          sol_change = res.data.solana.usd_24h_change || 0;
          sol_vol = res.data.solana.usd_24h_vol || 0;
          // 🆕 新增 1 小時價格變化數據 (更即時的回應速度，適合 Solana Meme 幣分鐘級交易)
          const btc_change_1h = res.data.bitcoin.usd_1h_change || 0;
          const sol_change_1h = res.data.solana.usd_1h_change || 0;
          return { btc_change, btc_vol, sol_change, sol_vol, btc_change_1h, sol_change_1h };
                } else {
                    // 🛡️ URL Base64 防腐處理
                    const kucoinBtcUrl = Buffer.from('aHR0cHM6Ly9hcGkua3Vjb2luLmNvbS9hcGkvdjEvbWFya2V0L3N0YXRzP3N5bWJvbD1CVEMtVVNEVA==', 'base64').toString('utf-8');
                    const kucoinSolUrl = Buffer.from('aHR0cHM6Ly9hcGkua3Vjb2luLmNvbS9hcGkvdjEvbWFya2V0L3N0YXRzP3N5bWJvbD1TT0wtVVNEVA==', 'base64').toString('utf-8');
                    
                    const [btcRes, solRes] = await Promise.all([
                        axios.get(kucoinBtcUrl, { timeout: 8000 }),
                        axios.get(kucoinSolUrl, { timeout: 8000 })
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
      // 🛠️ 修正：從 24h 擴展到 48h 以獲取更多樣本 (Meme 幣交易頻率低，24h 樣本僅 5-10 筆)
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const { data: trades } = await supabase
        .from(`trade_history_${tableSuffix}`)
        .select('realized_pnl_pct')
        .gte('created_at', twoDaysAgo)
        .in('action', ['SELL', 'SELL_HALF', 'LIQUIDATED']);

      // 🆕 新增最小樣本數檢查 (至少需要 5 筆交易才計算勝率，否則返回默認值)
      if (!trades || trades.length < 5) return 50.0;
      const wins = trades.filter(t => t.realized_pnl_pct > 0).length;
      return (wins / trades.length) * 100;
    } catch(e) { return 50.0; }
  }

    async _fetchJitoCongestion() {
        try {
            // 🛡️ URL Base64 防腐處理
            const jitoUrl = Buffer.from('aHR0cHM6Ly9idW5kbGVzLmppdG8ud3RmL2FwaS92MS9idW5kbGVzL3RpcF9mbG9vcg==', 'base64').toString('utf-8');
            const res = await axios.get(jitoUrl, { timeout: 2000 });
            if (res.data && res.data.length > 0) return res.data[0].landed_tips_50th_percentile || 0.0001;
        } catch (err) {}
        return 0.0001; 
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

  _calculateHardDataScore(metrics, jitoTip) {
    let score = 0;
    const btcChange24h = metrics.btc_change || 0;
    const solChange24h = metrics.sol_change || 0;
    // 🆕 新增 1 小時價格變化數據用於即時動量評分 (適合 Meme 幣分鐘級波動)
    const btcChange1h = metrics.btc_change_1h || 0;
    const solChange1h = metrics.sol_change_1h || 0;

    // 24h 相對強弱評分
    if (solChange24h > btcChange24h + 2) { score += 3; }
    else if (solChange24h < btcChange24h - 3) { score -= 2; }

    // 🛠️ 修正 Jito Tip 閾值 (0.005 SOL 已過時，更新為實際區間 0.001-0.0001 SOL)
    if (jitoTip > 0.001) { score += 3; }
    else if (jitoTip > 0.0003) { score += 1; }
    else if (jitoTip < 0.00005) { score -= 2; }

    // 🆕 新增 1h 短線動能評分 (更即時回應 Solana Meme 幣分鐘級走勢)
    if (solChange1h > 3.0) { score += 3; }  // SOL 1h 漲 3%+ = 牛信號
    else if (solChange1h > 1.0) { score += 1; }
    else if (solChange1h < -3.0) { score -= 3; }  // SOL 1h 跌 3%+ = 熊信號
    else if (solChange1h < -1.0) { score -= 1; }

    if (Math.abs(btcChange24h) < 1.5 && jitoTip > 0.0003) { score += 2; }

    if (btcChange24h < -5) { score -= 5; }

    return Math.max(-5, Math.min(5, score));
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

        const hardScore = this._calculateHardDataScore(metrics, jitoP50);

        let mistralModels = ['mistral-small-latest', 'open-mistral-nemo', 'mistral-large-latest'];
        let rawPrompt = `You are the Chief Macro Economist. Analyze data: BTC {{btc_change}}%, SOL {{sol_change}}%. News: {{titles}}. Output JSON: {"climate": "CHOPPY", "news_score": 0, "reasoning": "..."}`;
        
        try {
            const cachedStr = await redis.get('cache:bot_prompts');
            if (cachedStr) {
                const pMap = JSON.parse(cachedStr);
                const dbPrompt = pMap['news_sentiment_analyst'];
                if (dbPrompt) {
                    if (dbPrompt.content) rawPrompt = dbPrompt.content;
                    if (dbPrompt.model_main) mistralModels[0] = dbPrompt.model_main;
                    if (dbPrompt.model_backup_1) mistralModels[1] = dbPrompt.model_backup_1;
                    if (dbPrompt.model_backup_2) mistralModels[2] = dbPrompt.model_backup_2;
                }
            }
        } catch (err) {
            console.warn("⚠️ [Macro Center] 無法讀取 Redis 模型設定，使用預設 Mistral 模型與防跌 Prompt");
        }

        const promptStr = rawPrompt
            .replace(/{{btc_change}}/g, metrics.btc_change.toFixed(2))
            .replace(/{{btc_vol}}/g, (metrics.btc_vol/1e9).toFixed(1))
            .replace(/{{sol_change}}/g, metrics.sol_change.toFixed(2))
            .replace(/{{sol_vol}}/g, (metrics.sol_vol/1e9).toFixed(1))
            .replace(/{{jito_tip}}/g, jitoP50.toFixed(5))
            .replace(/{{winRate}}/g, winRate.toFixed(1))
            .replace(/{{titles}}/g, titles.map((t, i) => `${i+1}. ${t}`).join('\n'));

        const enforceJsonPrompt = "CRITICAL: Output ONLY a valid JSON object. Do not include markdown formatting like ```json.";

        try {
            // 🚀 核心優化：直接依賴 V10.29 嘅 keyRotator，佢已經自帶全域 Mistral 鎖 + 1秒冷卻！
            const parsedAI = await keyRotator.runWithKey('MISTRAL', async (apiKey, retryCount) => {
                const currentAttempt = retryCount || 0;
                const safeIndex = Math.min(currentAttempt, mistralModels.length - 1);
                const selectedModel = mistralModels[safeIndex];

                const cleanKey = apiKey.replace(/['"]/g, '').trim();
                
                // 🛡️ URL Base64 防腐處理
                const mistralUrl = Buffer.from('aHR0cHM6Ly9hcGkubWlzdHJhbC5haS92MS9jaGF0L2NvbXBsZXRpb25z', 'base64').toString('utf-8');
                
                console.log(`🤖 [Macro] 呼叫 Mistral: ${selectedModel} (排隊鎖由 keyRotator 處理)`);

                const res = await axios.post(mistralUrl, {
                    model: selectedModel, 
                    messages: [
                        { role: "system", content: promptStr },
                        { role: "user", content: enforceJsonPrompt }
                    ], 
                    temperature: 0.2
                }, { headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
                
                const textOutput = res.data.choices[0].message.content;
                const match = textOutput.match(/\{[\s\S]*\}/);
                if (match) return JSON.parse(match[0]);
                return JSON.parse(textOutput);

            }, 'macro_climate_analyst'); 

            if (parsedAI.climate && ['BULL_FRENZY', 'CHOPPY', 'BEAR_PANIC'].includes(parsedAI.climate)) {
                // P1-3: BULL_FRENZY 需要多重信號確認，防止局部 pump 誤判
                if (parsedAI.climate === 'BULL_FRENZY') {
                    // 用 AI 返回的 aiScore + hardScore 計算預計 newsScore（此時 newsScore 變數未更新）
                    const projectedNewsScore = Math.max(-5, Math.min(10, (parseInt(parsedAI.news_score) || 0) + hardScore));
                    let confirmCount = 0;
                    if ((metrics.sol_change || 0) >= 5.0)  confirmCount++; // SOL 24h > +5%
                    if ((metrics.btc_change || 0) >= 3.0)  confirmCount++; // BTC 24h > +3%
                    if (projectedNewsScore >= 7)            confirmCount++; // 新聞極度正面
                    if (winRate > 55)                       confirmCount++; // 內部勝率強勁

                    if (confirmCount >= 2) {
                        currentClimate = 'BULL_FRENZY';
                    } else {
                        currentClimate = 'CHOPPY';
                        console.log(`🌡️ [Climate] BULL_FRENZY 信號不足 (${confirmCount}/4)，降級為 CHOPPY`);
                    }
                } else {
                    currentClimate = parsedAI.climate;
                }
            }
            if (parsedAI.news_score !== undefined) {
                let aiScore = parseInt(parsedAI.news_score);
                aiScore = isNaN(aiScore) ? 0 : aiScore;
                newsScore = Math.max(-5, Math.min(10, aiScore + hardScore)); 
            }
            aiReasoning = parsedAI.reasoning || '無具體解釋';
            
            console.log(`🤖 [AI Macro] 判定: ${currentClimate} | 硬數據分: ${hardScore} | 最終分數: ${newsScore} | 理由: ${aiReasoning}`);
            healthMonitor.setStatus('Macro_Sync_Center', '🟢 氣候監控中', `當前氣候: ${currentClimate}`);

        } catch (err) {
            console.warn(`⚠️ [AI Macro] 交叉分析失敗 (${err.message})，降級使用硬邏輯判斷。`);
            if (metrics.btc_change <= -5.0 || metrics.sol_change <= -8.0 || winRate < 15) {
                currentClimate = 'BEAR_PANIC';
            } else if (metrics.sol_change >= 5.0 && winRate > 60) {
                currentClimate = 'RAGING_BULL';
            }
            healthMonitor.setStatus('Macro_Sync_Center', '🟡 AI 分析超時，已降級硬邏輯', `降級氣候: ${currentClimate}`);
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
    console.log("🛠️ SOL QUANT MACRO_SYNC_CENTER V10.51 (Meme 專化 & 原汁原味 Base64 防腐版) 啟動中...");
    
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

    setInterval(async () => {
        try {
            const { data } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
            const is_running = data ? data.is_running : true;
            
            const statusMsg = is_running 
                ? 'V10 雙軌智腦穩定運行中 🟢' 
                : '系統處於暫停/待機狀態 🟡';
                
            await supabase.from('bot_status').upsert({ id: 1, message: statusMsg, updated_at: new Date().toISOString() });
        } catch (err) {}
    }, 60 * 1000);

    setInterval(async () => {
        try {
            const port = getPortfolio();
            if (!port) return;
            const hkd = await getSolPriceInHKD();
            const totalSol = port.cash_sol + port.positions.reduce((sum, p) => sum + (p.quantity * p.entry_price_sol), 0);
            const modeText = port.mode === 'PAPER' ? '📝 模擬盤' : '🔥 實盤';
            console.log(`\n========================================`);
            console.log(`📊 [實時戰報] ${modeText} | 總資產: $${(totalSol * hkd).toFixed(2)} HKD | 現金: ${port.cash_sol.toFixed(4)} SOL`);
            console.log(`========================================\n`);
        } catch(e) {}
    }, 15 * 60 * 1000); 
}

bootstrap();