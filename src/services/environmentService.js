// src/services/environmentService.js
// 📝 檔案功能用途：V9.1 大市氣候中心與死人開關。統一整併宏觀跌幅與新聞標題掃描，計算出全局風險等級 (globalRiskLevel) 並快取至 Redis，供各模組 O(1) 讀取。

const axios = require('axios');
const Parser = require('rss-parser');
const Redis = require('ioredis');
const config = require('../config/config');
const { sendMacroPanicApproval, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

const redis = new Redis(config.cache.redisUrl);
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
    
    // ==========================================
    // 📊 宏觀跌幅探測 (Macro)
    // ==========================================
    async _fetchMacroData() {
        for (let i = 0; i < MACRO_PROVIDERS.length; i++) {
            const provider = MACRO_PROVIDERS[(activeMacroIdx + i) % MACRO_PROVIDERS.length];
            try {
                let btcDrop = 0, solDrop = 0;
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
                } else {
                    const [btcRes, solRes] = await Promise.all([
                        axios.get(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=BTC-USDT`, { timeout: 8000 }),
                        axios.get(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=SOL-USDT`, { timeout: 8000 })
                    ]);
                    btcDrop = this._calcDropKucoin(btcRes.data.data.slice(0, 15));
                    solDrop = this._calcDropKucoin(solRes.data.data.slice(0, 15));
                }
                activeMacroIdx = (activeMacroIdx + i) % MACRO_PROVIDERS.length;
                return { btcDrop, solDrop };
            } catch (err) {}
        }
        return { btcDrop: 0, solDrop: 0 }; // 預設安全
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

    // ==========================================
    // 📰 新聞關鍵字探測 (News Sentiment)
    // ==========================================
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
                    return this._analyzeTitles(titles);
                }
            } catch (err) {}
        }
        return 0; // 預設中性
    }

    _analyzeTitles(titles) {
        const fullText = titles.join(' ').toLowerCase();
        const negativeWords = ['scam', 'hack', 'exploit', 'investigation', 'ban', 'lawsuit', 'regulation', 'crackdown', 'crash', 'drop', 'bear', 'sec'];
        const positiveWords = ['upgrade', 'integration', 'partnership', 'launch', 'success', 'growth', 'bull', 'etf', 'adoption'];
        
        let score = 0;
        negativeWords.forEach(w => { if (fullText.includes(w)) score -= 1; });
        positiveWords.forEach(w => { if (fullText.includes(w)) score += 1; });
        
        // 限制分數範圍在 -5 到 +5 之間
        return Math.max(-5, Math.min(5, score));
    }

    // ==========================================
    // 🌍 環境更新與死人開關 (Core Logic)
    // ==========================================
    async updateEnvironment() {
        console.log(`🌍 [Env Service] 正在採集大市氣候與新聞情緒...`);
        
        const macro = await this._fetchMacroData();
        const newsScore = await this._fetchNewsScore();

        let riskLevel = 'LOW';
        // 判斷邏輯：BTC 跌幅 > -2% 且 SOL 跌幅 > -5% 為安全 (LOW)
        if (macro.btcDrop <= -5.0 || macro.solDrop <= -8.0) {
            riskLevel = 'HIGH';
        } else if (macro.btcDrop <= -2.0 || macro.solDrop <= -5.0) {
            riskLevel = 'MEDIUM';
        }

        const envState = { riskLevel, newsScore, timestamp: Date.now() };
        
        // O(1) 極速快取，TTL 設為 1 小時
        await redis.set('global_env_state', JSON.stringify(envState), 'EX', 3600);
        healthMonitor.setStatus('Macro_Radar', `🟢 氣候: ${riskLevel} (News: ${newsScore})`);

        // 🚨 HIGH 級別崩盤警報與死人開關觸發
        if (riskLevel === 'HIGH') {
            const isPending = await redis.get('macro_panic_pending');
            if (!isPending) {
                console.log(`🚨 [Env Service] 偵測到 HIGH 風險級別！發送大盤熔斷審批！`);
                const reason = `📉 BTC 15m 跌幅: ${macro.btcDrop.toFixed(2)}%\n📉 SOL 15m 跌幅: ${macro.solDrop.toFixed(2)}%\n📰 系統環境評分: ${newsScore} (負分代表惡劣)`;
                await sendMacroPanicApproval(reason);
            }
        }
    }

    async _checkDeadManSwitch() {
        try {
            const pendingStr = await redis.get('macro_panic_pending');
            if (!pendingStr) return;

            const pendingTime = parseInt(pendingStr, 10);
            if (Date.now() - pendingTime >= 900000) { // 15 分鐘 (900,000 ms)
                console.log(`💀 [Macro Failsafe] 15 分鐘未收到指揮官回覆，執行二次大盤評估...`);
                
                const macro = await this._fetchMacroData();
                await redis.del('macro_panic_pending'); 

                // 二次確認：如果 BTC 還是跌超過 5%，啟動系統接管
                if (macro.btcDrop <= -5.0 || macro.solDrop <= -8.0) {
                    sendAdminAlert(`🚨 <b>【死人開關已觸發】</b>\n\n15 分鐘未收到指揮官回覆，且大市依然處於 HIGH 風險狀態。\n\n🤖 <b>系統已接管控制權，正在自動執行全線強平！</b>`);
                    
                    const { getPortfolio } = require('./portfolioService');
                    const { runSellPipeline } = require('./tradeService');
                    const positions = getPortfolio().positions;

                    for (const pos of positions) {
                        const lockKey = `sell_lock:${pos.mint_address}`;
                        const acquired = await redis.set(lockKey, 'LOCKED', 'EX', 45, 'NX');
                        if (acquired) {
                            await runSellPipeline(pos, pos.highest_price_sol || pos.entry_price_sol, `🚨 15分鐘死人開關：大盤未見好轉，自動全平倉防禦`, 1.0)
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
        console.log(`🌍 [Env Service] 大市環境中心與死人開關已就位...`);
        // 初始執行一次
        this.updateEnvironment();
        
        // 每 15 分鐘更新一次全局環境 State
        setInterval(() => this.updateEnvironment(), 15 * 60 * 1000);
        
        // 每 1 分鐘檢查死人開關
        setInterval(() => this._checkDeadManSwitch(), 60000);
    }
}

const environmentService = new EnvironmentService();
module.exports = { environmentService };