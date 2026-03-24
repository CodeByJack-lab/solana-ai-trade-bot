// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { newsSentimentService } = require('./newsSentimentService'); // 🚀 1. 新增：引入情報局

let pauseCooldownUntil = 0; 
let useCoinGeckoNext = true; 

const macroMonitorService = {
    
    // ==========================================
    // 🌐 數據源 A：CoinGecko (時間窗約 75 分鐘)
    // ==========================================
    async fetchHighAndDropCoinGecko(coinId) {
        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        const res = await axios.get(url, { timeout: 10000 });
        const prices = res.data?.prices;
        
        if (!prices || !Array.isArray(prices) || prices.length < 15) {
            throw new Error(`CoinGecko 數據不足 (${coinId})`);
        }
        
        const recentPrices = prices.slice(-15);
        let highestPrice = 0;
        for (const p of recentPrices) {
            const price = parseFloat(p[1]);
            if (price > highestPrice) highestPrice = price;
        }
        
        const currentPrice = parseFloat(prices[prices.length - 1][1]);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        return { currentPrice, highestPrice, dropPct };
    },

    // ==========================================
    // 🌐 數據源 B：CryptoCompare
    // ==========================================
    async fetchHighAndDropCryptoCompare(symbol) {
        const fsym = symbol.replace('USDT', '');
        const url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${fsym}&tsym=USD&limit=75`;
        const res = await axios.get(url, { timeout: 8000 });
        
        if (res.data?.Response === 'Error') throw new Error(`CryptoCompare 報錯: ${res.data.Message}`);
        
        const klines = res.data?.Data?.Data; 
        if (!klines || !Array.isArray(klines) || klines.length === 0) {
            throw new Error(`CryptoCompare 數據格式異常 (${symbol})`);
        }
        
        let highestPrice = 0;
        for (const k of klines) {
            const high = parseFloat(k.high); 
            if (high > highestPrice) highestPrice = high;
        }
        
        const currentPrice = parseFloat(klines[klines.length - 1].close);
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        return { currentPrice, highestPrice, dropPct };
    },

    // ==========================================
    // 🚀 主程序
    // ==========================================
    start() {
        console.log(`🌍 [Macro] 大盤防禦雷達運作中 (結合 AI 新聞情報局)...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 監聽中');

        setInterval(async () => {
            const now = Date.now();
            
            if (now < pauseCooldownUntil) {
                healthMonitor.setStatus('Macro_Radar', '🟡 冷卻避險中');
                return; 
            }

            try {
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                let btcData, solData, sourceName;

                if (useCoinGeckoNext) {
                    sourceName = 'CoinGecko';
                    [btcData, solData] = await Promise.all([
                        this.fetchHighAndDropCoinGecko('bitcoin'),
                        this.fetchHighAndDropCoinGecko('solana')
                    ]);
                } else {
                    sourceName = 'CryptoCompare';
                    [btcData, solData] = await Promise.all([
                        this.fetchHighAndDropCryptoCompare('BTCUSDT'),
                        this.fetchHighAndDropCryptoCompare('SOLUSDT')
                    ]);
                }

                useCoinGeckoNext = !useCoinGeckoNext;
                healthMonitor.setStatus('Macro_Radar', `🟢 正常 (${sourceName})`);

                let isPriceTriggered = false;
                let priceAlertMsg = '';

                // 觸發條件 (純粹價格跌幅)
                if (btcData.dropPct <= -2.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `BTC 回撤 <b>${btcData.dropPct.toFixed(2)}%</b> (高位 $${btcData.highestPrice.toFixed(0)})`;
                } else if (solData.dropPct <= -3.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `SOL 回撤 <b>${solData.dropPct.toFixed(2)}%</b> (高位 $${solData.highestPrice.toFixed(0)})`;
                }

                // 🚀 2. 新增：當價格觸發警報，即刻 Call 情報局睇新聞做 Double Check！
                if (isPriceTriggered) {
                    console.log(`🚨 [Macro] 偵測到大盤急跌，立即啟動 AI 新聞查證...`);
                    const newsScore = await newsSentimentService.getDisasterScore();
                    
                    // 將最新分數寫入 DB，等大腦可以睇到
                    await supabase.from('system_config').update({ latest_news_score: newsScore }).eq('id', 1);

                    // 決策邏輯：如果真係黑天鵝 (Score >= 50)，即刻拉大掣！
                    if (newsScore >= 50) {
                        await supabase.from('system_config').update({ is_running: false, status_msg: `黑天鵝避險 (災難指數:${newsScore})` }).eq('id', 1);
                        sendTelegramAlert(`🚨 <b>大盤崩盤預警 + AI 災難確認</b>\n\n📉 <b>觸發:</b> ${priceAlertMsg}\n📰 <b>新聞災難指數:</b> <b>${newsScore}/100</b> (黑天鵝級別)\n\n🛑 <b>系統動作</b>: 已自動關閉新交易總掣\n⏳ <b>狀態</b>: 進入 30 分鐘冷卻期`);
                        pauseCooldownUntil = now + (30 * 60 * 1000); 
                    } else {
                        console.log(`ℹ️ [Macro] AI 判斷為常規洗盤 (指數 ${newsScore})，不觸發熔斷。`);
                    }
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] Error: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
                useCoinGeckoNext = !useCoinGeckoNext;
            }
        }, 180000); 
    }
};

module.exports = { macroMonitorService };