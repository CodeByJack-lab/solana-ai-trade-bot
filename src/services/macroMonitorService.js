// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');

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
        // 🚀 核心修正：將 limit=15 改為 limit=75，對齊 CoinGecko 嘅 75 分鐘時間窗
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
        console.log(`🌍 [Macro] 大盤防禦雷達運作中 (CoinGecko / CryptoCompare 雙源輪替模式)...`);
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
                healthMonitor.setStatus('Macro_Radar', `🟢 正常 (來自 ${sourceName})`);

                let triggered = false;
                let alertMsg = '';

                if (btcData.dropPct <= -2.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>BTC 崩盤預警 (${sourceName})</b>\n近期高位: $${btcData.highestPrice.toFixed(2)}\n最新價格: $${btcData.currentPrice.toFixed(2)}\n回撤幅度: <b>${btcData.dropPct.toFixed(2)}%</b>`;
                } else if (solData.dropPct <= -3.0) {
                    triggered = true;
                    alertMsg = `🚨 <b>SOL 崩盤預警 (${sourceName})</b>\n近期高位: $${solData.highestPrice.toFixed(2)}\n最新價格: $${solData.currentPrice.toFixed(2)}\n回撤幅度: <b>${solData.dropPct.toFixed(2)}%</b>`;
                }

                if (triggered) {
                    await supabase.from('system_config').update({ is_running: false, status_msg: '大盤暴跌自動避險中' }).eq('id', 1);
                    sendTelegramAlert(`${alertMsg}\n\n🛑 <b>系統動作</b>: 已自動關閉新交易總掣\n⏳ <b>狀態</b>: 進入 30 分鐘冷卻期`);
                    pauseCooldownUntil = now + (30 * 60 * 1000); 
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] Error: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 異常: ${err.message}`);
                useCoinGeckoNext = !useCoinGeckoNext;
            }
        }, 120000); 
    }
};

module.exports = { macroMonitorService };