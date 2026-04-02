// src/services/environmentService.js
// 📝 檔案功能用途：V9.2 大市氣候台與自動開關。綜合多維度數據判定氣候，並呼叫獨立的 aiAdvisorService 進行大腦決策。

const axios = require('axios');
const Parser = require('rss-parser');
const Redis = require('ioredis');
const config = require('../config/config');
const { sendMacroPanicApproval, sendAdminAlert } = require('./telegramService');
const { aiAdvisorService } = require('./aiAdvisorService'); // 🛡️ V9.2 引入獨立參謀大腦
const { healthMonitor } = require('./healthMonitor');
const { supabase } = require('../config/supabase');

const redis = new Redis(config.cache.redisUrl || process.env.REDIS_URL);
const parser = new Parser();

// 狀態指針系統
const MACRO_PROVIDERS = [{ name: 'COINGECKO', keyName: 'COINGECKO_API_KEY' }, { name: 'KUCOIN', keyName: null }];
const NEWS_PROVIDERS = [
    { name: 'CRYPTOPANIC', type: 'API' }, 
    { name: 'COINTELEGRAPH', type: 'RSS', url: 'https://cointelegraph.com/rss' },
    { name: 'DECRYPT', type: 'RSS', url: 'https://decrypt.co/feed' }
];

let activeMacroIdx = 0;
let activeNewsIdx = 0;

class EnvironmentService {
    
    async _fetchMacroData() {
        for (let i = 0; i < MACRO_PROVIDERS.length; i++) {
            const provider = MACRO_PROVIDERS[(activeMacroIdx + i) % MACRO_PROVIDERS.length];
            try {
                let btcDrop = 0, solDrop = 0, solVolSurge = 1.0, isAboveMA = false;
                
                if (provider.name === 'COINGECKO') {
                    const apiKey = process.env[provider.keyName];
                    if (!apiKey) throw new Error("Missing CoinGecko Key");
                    const cfg = { headers: { 'x-cg-demo-api-key': apiKey }, timeout: 8000 };
                    
                    const [btcRes, solRes] = await Promise.all([
                        axios.get(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1`, cfg),
                        axios.get(`https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1`, cfg)
                    ]);
                    
                    btcDrop = this._calcDrop(btcRes.data.prices.slice(-15));
                    solDrop = this._calcDrop(solRes.data.prices.slice(-15));
                    
                    const prices = solRes.data.prices;
                    const vols = solRes.data.total_volumes;
                    
                    const ma15 = prices.slice(-15).reduce((sum, p) => sum + p[1], 0) / 15;
                    const currentPrice = prices[prices.length - 1][1];
                    isAboveMA = currentPrice > ma15;
                    
                    const avgVol = vols.reduce((sum, v) => sum + v[1], 0) / vols.length;
                    const recentVol = vols.slice(-3).reduce((sum, v) => sum + v[1], 0) / 3;
                    solVolSurge = avgVol > 0 ? (recentVol / avgVol) : 1.0;

                } else {
                    const [btcRes, solRes] = await Promise.all([
                        axios.get(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=BTC-USDT`, { timeout: 8000 }),
                        axios.get(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=SOL-USDT`, { timeout: 8000 })
                    ]);
                    
                    btcDrop = this._calcDropKucoin(btcRes.data.data.slice(0, 15));
                    solDrop = this._calcDropKucoin(solRes.data.data.slice(0, 15));
                    
                    const klines = solRes.data.data.slice(0, 15);
                    const ma15 = klines.reduce((sum, k) => sum + parseFloat(k[2]), 0) / 15;
                    const currentPrice = parseFloat(klines[0][2]); 
                    isAboveMA = currentPrice > ma15;
                    
                    const recentVol = parseFloat(klines[0][5]) + parseFloat(klines[1][5]);
                    const avgVol = klines.reduce((sum, k) => sum + parseFloat(k[5]), 0) / 15;
                    solVolSurge = avgVol > 0 ? ((recentVol / 2) / avgVol) : 1.0;
                }
                
                activeMacroIdx = (activeMacroIdx + i) % MACRO_PROVIDERS.length;
                return { btcDrop, solDrop, solVolSurge, isAboveMA };
            } catch (err) {}
        }
        return { btcDrop: 0, solDrop: 0, solVolSurge: 1.0, isAboveMA: false }; 
    }

    _calcDrop(prices) {
        if (!prices || prices.length < 2) return 0;
        let highest = 0;
        prices.forEach(p => { if (p[1] > highest) highest = p[1]; });
        return ((prices[prices.length - 1][1] - highest) / highest) * 100;
    }

    _calcDropKucoin(klines) {
        if (!klines || klines.length < 2) return 0;
        let highest = 0;
        klines.forEach(k => { const high = parseFloat(k[3]); if (high > highest) highest = high; });
        return ((parseFloat(klines[0][2]) - highest) / highest) * 100;
    }

    async _fetchJitoCongestion() {
        try {
            const res = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { timeout: 2000 });
            if (res.data && res.data.length > 0) {
                return res.data[0].landed_tips_50th_percentile || 150000;
            }
        } catch (err) {}
        return 150000;
    }

    async _fetchNewsScore() {
        for (let i = 0; i < NEWS_PROVIDERS.length; i++) {
            const provider = NEWS_PROVIDERS[(activeNewsIdx + i) % NEWS_PROVIDERS.length];
            try {
                let titles = [];
                if (provider.name === 'CRYPTOPANIC') {
                    const apiKey = process.env.CRYPTOPANIC_API_KEY;
                    if (!apiKey) throw new Error("Missing CryptoPanic Key");
                    const res = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&kind=news`, { timeout: 8000 });
                    if (res.data?.results) titles = res.data.results.slice(0, 20).map(item => item.title);
                } else {
                    const res = await axios.get(provider.url, { timeout: 8000 });
                    const feed = await parser.parseString(res.data);
                    if (feed?.items) titles = feed.items.slice(0, 20).map(item => item.title);
                }

                if (titles.length > 0) {
                    activeNewsIdx = (activeNewsIdx + i) % NEWS_PROVIDERS.length;
                    // 🚀 升級：加入 await 呼叫 Groq AI 進行情緒分析
                    return await this._analyzeTitles(titles);
                }
            } catch (err) {
                console.warn(`⚠️ [Env Service] 獲取 ${provider.name} 新聞失敗:`, err.message);
            }
        }
        return 0; 
    }

    // 🧠 V9.2 升級：Groq Llama-3 智能情緒分析
    async _analyzeTitles(titles) {
        try {
            const groqApiKey = process.env.GROQ_API_KEY;
            if (!groqApiKey) {
                throw new Error("Missing GROQ_API_KEY");
            }

            const prompt = `You are a top-tier Web3 market sentiment analyst. Analyze these 20 recent crypto news titles. Determine the overall macroeconomic sentiment score from -5 (extreme fear/panic) to 5 (extreme greed/euphoria). 0 is neutral. 
            Ignore routine individual token news. Focus on macro events (e.g., SEC actions, ETF inflows, major hacks, macro economy).
            Output ONLY pure JSON.
            
            Titles:
            ${titles.map((t, i) => `${i+1}. ${t}`).join('\n')}
            
            Output exact JSON format: {"score": <integer>}`;

            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: "json_object" },
                temperature: 0.1
            }, {
                headers: {
                    'Authorization': `Bearer ${groqApiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 8000
            });

            const parsed = JSON.parse(res.data.choices[0].message.content);
            let score = parseInt(parsed.score);
            if (isNaN(score)) score = 0;
            
            return Math.max(-5, Math.min(5, score));
            
        } catch (error) {
            console.warn(`⚠️ [Env Service] Groq AI 分析失敗 (${error.message})，降級使用關鍵字計分...`);
            return this._fallbackAnalyze(titles);
        }
    }

    // 🛡️ 備用降級方案 (舊版關鍵字計分)
    _fallbackAnalyze(titles) {
        const fullText = titles.join(' ').toLowerCase();
        const negativeWords = ['scam', 'hack', 'exploit', 'investigation', 'ban', 'lawsuit', 'regulation', 'crackdown', 'crash', 'drop', 'bear', 'sec', 'sell-off'];
        const positiveWords = ['upgrade', 'integration', 'partnership', 'launch', 'success', 'growth', 'bull', 'etf', 'adoption', 'surge', 'all-time high'];
        
        let score = 0;
        negativeWords.forEach(w => { if (fullText.includes(w)) score -= 1; });
        positiveWords.forEach(w => { if (fullText.includes(w)) score += 1; });
        
        return Math.max(-5, Math.min(5, score));
    }

    async updateEnvironment() {
        console.log(`🌍 [Env Service] 天文台正在採集大市氣候...`);
        
        const macro = await this._fetchMacroData();
        const newsScore = await this._fetchNewsScore();
        const jitoP50 = await this._fetchJitoCongestion();

        let currentClimate = 'CHOPPY'; 
        
        if (macro.btcDrop <= -5.0 || macro.solDrop <= -8.0 || (newsScore <= -3 && macro.solDrop <= -5.0)) {
            currentClimate = 'BEAR_PANIC';
        } 
        else if (macro.isAboveMA && macro.solVolSurge > 1.5 && jitoP50 >= 300000 && newsScore >= 0) {
            currentClimate = 'RAGING_BULL';
        }
        else if (newsScore >= 3 && macro.solDrop > -2.0) {
            currentClimate = 'RAGING_BULL';
        }

        const envState = { climate: currentClimate, newsScore, jitoP50, volSurge: macro.solVolSurge, timestamp: Date.now() };
        
        await redis.set('global_env_state', JSON.stringify(envState), 'EX', 3600);
        healthMonitor.setStatus('Macro_Radar', `🟢 氣候: ${currentClimate} (News: ${newsScore})`);

        // 🚀 V9.2 新增：同步將氣候與新聞分數寫入大本營，供 Dashboard 顯示！
        try {
            await supabase.from('system_config').update({
                macro_climate: currentClimate,
                latest_news_score: newsScore
            }).eq('id', 1);
        } catch(e) { console.warn(`⚠️ 同步氣候至 DB 失敗`); }

        const prevClimate = await redis.get('prev_climate_state');
        if (prevClimate !== currentClimate) {
            console.log(`\n🌩️ [天文台] 偵測到大市氣候由 ${prevClimate || 'UNKNOWN'} 轉變為 ${currentClimate}，已交由 AI 參謀總部研判！`);
            await redis.set('prev_climate_state', currentClimate);
            
            try {
                await aiAdvisorService.evaluateClimateChange(currentClimate, envState);
            } catch (err) {
                console.warn(`⚠️ 呼叫 AI 大腦失敗: ${err.message}`);
            }
        }

        if (currentClimate === 'BEAR_PANIC') {
            const isPending = await redis.get('macro_panic_pending');
            if (!isPending) {
                console.log(`🚨 [Env Service] 偵測到 BEAR_PANIC 恐慌狀態！發送大盤熔斷審批！`);
                const reason = `📉 BTC 跌幅: ${macro.btcDrop.toFixed(2)}%\n📉 SOL 跌幅: ${macro.solDrop.toFixed(2)}%\n📰 新聞情緒: ${newsScore}\n🌊 交易量: ${(macro.solVolSurge*100).toFixed(0)}% (相較平均)`;
                await sendMacroPanicApproval(reason);
            }
        }
    }

    async _checkDeadManSwitch() {
        try {
            const pendingStr = await redis.get('macro_panic_pending');
            if (!pendingStr) return;

            const pendingTime = parseInt(pendingStr, 10);
            if (Date.now() - pendingTime >= 900000) { 
                console.log(`💀 [Macro Failsafe] 15 分鐘未收到指揮官回覆，執行二次大盤評估...`);
                
                const macro = await this._fetchMacroData();
                await redis.del('macro_panic_pending'); 

                if (macro.btcDrop <= -5.0 || macro.solDrop <= -8.0) {
                    sendAdminAlert(`🚨 <b>【自動開關已觸發】</b>\n\n15 分鐘未收到指揮官回覆，且大市依然處於 BEAR_PANIC 恐慌狀態。\n\n🤖 <b>系統已接管控制權，正在自動執行全線強平！</b>`);
                    
                    const { getPortfolio } = require('./portfolioService');
                    const { runSellPipeline } = require('./tradeService');
                    const positions = getPortfolio().positions;

                    for (const pos of positions) {
                        const lockKey = `sell_lock:${pos.mint_address}`;
                        const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                        if (acquired) {
                            await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, `🚨 15分鐘自動開關：大盤未見好轉，自動全平倉防禦`, 1.0)
                                .finally(() => redis.del(lockKey));
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                } else {
                    sendAdminAlert(`✅ <b>【危機自然解除】</b>\n\n15 分鐘過去，大市跌幅已收斂。\n🤖 系統自動取消強平機制，維持正常運作。`);
                }
            }
        } catch (err) {}
    }

    start() {
        console.log(`🌍 [Env Service] 天文台與TimeStop已就位...`);
        this.updateEnvironment();
        setInterval(() => this.updateEnvironment(), 15 * 60 * 1000);
        setInterval(() => this._checkDeadManSwitch(), 60000);
    }
}

const environmentService = new EnvironmentService();
module.exports = { environmentService };