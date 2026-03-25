// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { newsSentimentService } = require('./newsSentimentService'); 

let pauseCooldownUntil = 0; 
let useCoinGeckoNext = true; 

const macroMonitorService = {
    
    async fetchHighAndDropCoinGecko(coinId) {
        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        const config = {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        };

        // 🚀 注入 CoinGecko API Key (Demo Plan 防限流)
        if (process.env.COINGECKO_API_KEY) {
            config.headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
        }

        const res = await axios.get(url, config);
        const prices = res.data?.prices;
        if (!prices || prices.length < 15) throw new Error(`CoinGecko 數據不足`);
        
        const recentPrices = prices.slice(-15);
        let highestPrice = 0;
        for (const p of recentPrices) {
            if (p[1] > highestPrice) highestPrice = p[1];
        }
        const currentPrice = prices[prices.length - 1][1];
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        return { currentPrice, highestPrice, dropPct };
    },

    async fetchHighAndDropKuCoin(symbol) {
        const formattedSymbol = symbol.replace('USDT', '-USDT');
        const url = `https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${formattedSymbol}`;
        const res = await axios.get(url, { timeout: 8000 });
        const klines = res.data?.data; 
        if (!klines || klines.length === 0) throw new Error(`KuCoin 數據異常`);
        
        const recentKlines = klines.slice(0, 15);
        let highestPrice = 0;
        for (const k of recentKlines) {
            const high = parseFloat(k[3]);
            if (high > highestPrice) highestPrice = high;
        }
        const currentPrice = parseFloat(recentKlines[0][2]);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        return { currentPrice, highestPrice, dropPct };
    },

    async getMarketData() {
        let btcData, solData, sourceName;

        try {
            if (useCoinGeckoNext) {
                sourceName = 'CoinGecko';
                btcData = await this.fetchHighAndDropCoinGecko('bitcoin');
                await new Promise(r => setTimeout(r, 2000)); 
                solData = await this.fetchHighAndDropCoinGecko('solana');
            } else {
                sourceName = 'KuCoin';
                btcData = await this.fetchHighAndDropKuCoin('BTCUSDT');
                await new Promise(r => setTimeout(r, 2000)); 
                solData = await this.fetchHighAndDropKuCoin('SOLUSDT');
            }
            return { btcData, solData, sourceName };
        } catch (err) {
            if (err.response?.status === 429) {
                console.warn(`⚠️ [Macro] ${sourceName} 觸發限流，即刻切換數據源備援...`);
                useCoinGeckoNext = !useCoinGeckoNext; 
                if (sourceName === 'CoinGecko') {
                    return {
                        btcData: await this.fetchHighAndDropKuCoin('BTCUSDT'),
                        solData: await this.fetchHighAndDropKuCoin('SOLUSDT'),
                        sourceName: 'KuCoin (備援)'
                    };
                }
            }
            throw err;
        }
    },

    // 🚀 新增：由 AI 定時重審新聞的「智能解封」機制
    async checkRecovery() {
        console.log(`⏳ [Macro] 30 分鐘避險期滿，交由 AI 重新審查大盤新聞...`);
        try {
            const newScore = await newsSentimentService.getDisasterScore();
            
            if (newScore >= 50) {
                // 如果仲係恐慌，就繼續鎖住，再等 30 分鐘！
                console.log(`🚨 [Macro] 危機未除 (AI 指數: ${newScore})，延長避險 30 分鐘！`);
                await supabase.from('system_config').update({ 
                    latest_news_score: newScore, 
                    status_msg: `繼續避險 (指數:${newScore})` 
                }).eq('id', 1);
                
                pauseCooldownUntil = Date.now() + (30 * 60 * 1000); 
                setTimeout(() => this.checkRecovery(), 30 * 60 * 1000); // 30 分鐘後再審

            } else {
                // 分數跌落 50 以下，安全解封！
                console.log(`✅ [Macro] 危機解除 (AI 指數: ${newScore})，系統恢復運作！`);
                await supabase.from('system_config').update({ 
                    is_running: true, 
                    status_msg: '正常運作中', 
                    latest_news_score: newScore  // AI 真實低分數寫入，自然放鬆防線
                }).eq('id', 1);
                
                sendAdminAlert(`✅ <b>[自動恢復]</b> AI 確認新聞危機已解除 (指數: ${newScore})，系統已重新著機！`);
            }
        } catch (err) {
            console.error(`❌ [Macro] 恢復審查失敗，5 分鐘後重試: ${err.message}`);
            setTimeout(() => this.checkRecovery(), 5 * 60 * 1000); // 防呆機制，API死咗就 5 分鐘後再試
        }
    },

    start() {
        console.log(`🌍 [Macro] 大盤防禦雷達已就位...`);
        
        setInterval(async () => {
            const now = Date.now();
            if (now < pauseCooldownUntil) return;

            try {
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                const { btcData, solData, sourceName } = await this.getMarketData();
                
                useCoinGeckoNext = !useCoinGeckoNext;
                healthMonitor.setStatus('Macro_Radar', `🟢 正常 (${sourceName})`);

                let isPriceTriggered = false;
                let priceAlertMsg = '';

                if (btcData.dropPct <= -2.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `BTC 回撤 ${btcData.dropPct.toFixed(2)}%`;
                } else if (solData.dropPct <= -3.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `SOL 回撤 ${solData.dropPct.toFixed(2)}%`;
                }

                if (isPriceTriggered) {
                    console.log(`🚨 [Macro] 價格異常，呼叫 AI 審查新聞...`);
                    const newsScore = await newsSentimentService.getDisasterScore();
                    await supabase.from('system_config').update({ latest_news_score: newsScore }).eq('id', 1);

                    if (newsScore >= 50) {
                        await supabase.from('system_config').update({ is_running: false, status_msg: `避險中 (指數:${newsScore})` }).eq('id', 1);
                        sendTelegramAlert(`🚨 <b>大盤崩盤確認</b>\n跌幅: ${priceAlertMsg}\nAI 災難分: ${newsScore}\n\n系統將暫停 30 分鐘，之後由 AI 重新審查。`);
                        
                        pauseCooldownUntil = Date.now() + (30 * 60 * 1000); 
                        
                        // 🚀 核心修正：30 分鐘後不再「無腦歸零」，而係 Call checkRecovery() 叫 AI 做嘢
                        setTimeout(() => this.checkRecovery(), 30 * 60 * 1000);
                    }
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] 發生錯誤: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 數據中斷: ${err.message}`);
                if (err.response?.status === 429) pauseCooldownUntil = Date.now() + (5 * 60 * 1000);
            }
        }, 180000); 
    }
};

module.exports = { macroMonitorService };