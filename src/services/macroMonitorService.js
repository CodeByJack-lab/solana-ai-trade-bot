// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { newsSentimentService } = require('./newsSentimentService'); 

let pauseCooldownUntil = 0; 
let useCoinGeckoNext = true; 

const macroMonitorService = {
    
    // ==========================================
    // 🌐 數據源 A：CoinGecko
    // ==========================================
    async fetchHighAndDropCoinGecko(coinId) {
        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        const res = await axios.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, // 🚀 加個 Agent 減少被當成純 Bot
            timeout: 10000 
        });
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

    // ==========================================
    // 🚀 數據源 B：KuCoin (通常比 CG 穩定)
    // ==========================================
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
        // 🚀 核心升級：唔再用 Promise.all，改用逐個叫，中間停 2 秒避開併發封鎖
        let btcData, solData, sourceName;

        try {
            if (useCoinGeckoNext) {
                sourceName = 'CoinGecko';
                btcData = await this.fetchHighAndDropCoinGecko('bitcoin');
                await new Promise(r => setTimeout(r, 2000)); // ⏳ 停 2 秒
                solData = await this.fetchHighAndDropCoinGecko('solana');
            } else {
                sourceName = 'KuCoin';
                btcData = await this.fetchHighAndDropKuCoin('BTCUSDT');
                await new Promise(r => setTimeout(r, 2000)); // ⏳ 停 2 秒
                solData = await this.fetchHighAndDropKuCoin('SOLUSDT');
            }
            return { btcData, solData, sourceName };
        } catch (err) {
            // 🚨 如果目前的數據源爆 429，即刻嘗試用另一個 Source 救火
            if (err.response?.status === 429) {
                console.warn(`⚠️ [Macro] ${sourceName} 觸發限流，即刻切換數據源備援...`);
                useCoinGeckoNext = !useCoinGeckoNext; 
                // 嘗試另一個 Source
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

    start() {
        console.log(`🌍 [Macro] 大盤防禦雷達已就位...`);
        
        setInterval(async () => {
            const now = Date.now();
            if (now < pauseCooldownUntil) return;

            try {
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                // 🚀 執行防彈版獲取
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
                        sendTelegramAlert(`🚨 <b>大盤崩盤確認</b>\n跌幅: ${priceAlertMsg}\nAI 災難分: ${newsScore}`);
                        pauseCooldownUntil = now + (30 * 60 * 1000); 
                        setTimeout(async () => {
                            await supabase.from('system_config').update({ is_running: true, status_msg: '避險期結束，系統自動恢復' }).eq('id', 1);
                            sendAdminAlert("✅ <b>[自動恢復]</b> 30分鐘避險期已滿，系統已重新著機。");
                        }, 30 * 60 * 1000);
                    }
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] 發生錯誤: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 數據中斷: ${err.message}`);
                // 萬一真係全線爆 429，就休息長一點時間
                if (err.response?.status === 429) pauseCooldownUntil = Date.now() + (5 * 60 * 1000);
            }
        }, 180000); 
    }
};

module.exports = { macroMonitorService };