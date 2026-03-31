// src/services/macroMonitorService.js
// 📝 檔案功能用途：宏觀大盤防禦雷達。實裝「狀態指針輪替」，CoinGecko 與 KuCoin 無縫切換，精確溯源出錯環境變數。

const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { newsSentimentService } = require('./newsSentimentService'); 
const configEnv = require('../config/env'); 

let pauseCooldownUntil = 0; 

// 🔄 狀態指針系統 (Stateful Pointer)
const PROVIDERS = [
    { name: 'COINGECKO', keyName: 'COINGECKO_API_KEY' },
    { name: 'KUCOIN', keyName: null }
];
let activeProviderIdx = 0;
const providerErrorCounts = { COINGECKO: 0, KUCOIN: 0 };

const macroMonitorService = {
    
    async fetchHighAndDropCoinGecko(coinId) {
        const apiKey = process.env['COINGECKO_API_KEY'];
        if (!apiKey) {
            const err = new Error("未配置 COINGECKO_API_KEY");
            err.usedKeyName = 'COINGECKO_API_KEY';
            throw err;
        }

        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        const config = { headers: { 'User-Agent': 'Mozilla/5.0', 'x-cg-demo-api-key': apiKey.replace(/['"]/g, '').trim() }, timeout: 10000 };

        try {
            const res = await axios.get(url, config);
            const prices = res.data?.prices; 
            if (!prices || prices.length < 15) throw new Error(`CoinGecko 數據不足`);
            
            const recentPrices = prices.slice(-15);
            let highestPrice = 0;
            for (const p of recentPrices) if (p[1] > highestPrice) highestPrice = p[1];
            const currentPrice = prices[prices.length - 1][1];
            const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
            
            return { currentPrice, highestPrice, dropPct };
        } catch (e) {
            const err = new Error(e.message);
            err.usedKeyName = 'COINGECKO_API_KEY';
            throw err;
        }
    },

    async fetchHighAndDropKuCoin(symbol) {
        const formattedSymbol = symbol.includes('-') ? symbol : symbol.replace('USDT', '-USDT');
        const url = `https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${formattedSymbol}`;
        
        try {
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
        } catch (e) {
            const err = new Error(e.message);
            err.usedKeyName = '無 (KuCoin 公開 API)';
            throw err;
        }
    },

    /**
     * 🔄 狀態指針獲取大盤數據
     */
    async getMarketData() {
        for (let i = 0; i < PROVIDERS.length; i++) {
            const idx = (activeProviderIdx + i) % PROVIDERS.length;
            const provider = PROVIDERS[idx];

            try {
                let btcData, solData;
                if (provider.name === 'COINGECKO') {
                    btcData = await this.fetchHighAndDropCoinGecko('bitcoin');
                    await new Promise(r => setTimeout(r, 1500)); 
                    solData = await this.fetchHighAndDropCoinGecko('solana');
                } else {
                    btcData = await this.fetchHighAndDropKuCoin('BTC-USDT');
                    await new Promise(r => setTimeout(r, 1000)); 
                    solData = await this.fetchHighAndDropKuCoin('SOL-USDT');
                }

                activeProviderIdx = idx; // 🎯 鎖定為新主力
                providerErrorCounts[provider.name] = 0;
                return { btcData, solData, sourceName: provider.name };
            } catch (err) {
                providerErrorCounts[provider.name]++;
                const deadKeyName = err.usedKeyName || 'UNKNOWN_VAR';

                console.warn(`⚠️ [Macro] ${provider.name} 獲取失敗 (${providerErrorCounts[provider.name]}/3): ${err.message} (Var: ${deadKeyName})`);
                
                if (providerErrorCounts[provider.name] === 3) {
                    sendAdminAlert(`🚨 <b>宏觀 API 狀態指針輪替</b>\n\n📉 <b>供應商:</b> ${provider.name}\n🔑 <b>陣亡變數:</b> <code>${deadKeyName}</code>\n❌ <b>錯誤:</b> 連續 3 次擷取失敗！\n\n系統已將宏觀掃描主力切換至下一個備援。`);
                    providerErrorCounts[provider.name] = 0;
                }
            }
        }
        throw new Error("所有宏觀 API 皆已癱瘓");
    },

    async checkRecovery() {
        console.log(`⏳ [Macro] 避險期滿，交由 AI 重新審查大盤新聞...`);
        try {
            const newScore = await newsSentimentService.getDisasterScore();
            
            if (newScore >= 50) {
                console.log(`🚨 [Macro] 危機未除 (AI 指數: ${newScore})，延長避險 30 分鐘！`);
                await supabase.from('system_config').update({ latest_news_score: newScore, status_msg: `繼續避險 (AI:${newScore})` }).eq('id', 1);
                pauseCooldownUntil = Date.now() + (30 * 60 * 1000); 
            } else {
                console.log(`✅ [Macro] 危機解除 (AI 指數: ${newScore})，系統恢復正常！`);
                await supabase.from('system_config').update({ is_running: true, status_msg: '正常運作中', latest_news_score: newScore }).eq('id', 1);
                sendAdminAlert(`✅ <b>[大盤解封]</b>\nAI 確認新聞危機已解除 (指數: ${newScore})，系統已恢復交易！`);
                pauseCooldownUntil = 0; 
            }
        } catch (err) {
            console.error(`❌ [Macro] 恢復審查失敗，5 分鐘後重試: ${err.message}`);
            setTimeout(() => this.checkRecovery(), 5 * 60 * 1000); 
        }
    },

    start() {
        console.log(`🌍 [Macro] 大盤防禦雷達已就位 (狀態指針切換模式)...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 守衛中');
        
        setInterval(async () => {
            const now = Date.now();
            if (now < pauseCooldownUntil) {
                if (pauseCooldownUntil !== 0 && now >= (pauseCooldownUntil - 5000)) await this.checkRecovery();
                return;
            }

            try {
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                const { btcData, solData, sourceName } = await this.getMarketData();
                healthMonitor.setStatus('Macro_Radar', `🟢 正常 (${sourceName})`);

                let isPriceTriggered = false;
                let priceAlertMsg = '';

                if (btcData.dropPct <= -2.0) {
                    isPriceTriggered = true; priceAlertMsg = `BTC 1小時回撤 ${btcData.dropPct.toFixed(2)}%`;
                } else if (solData.dropPct <= -3.0) {
                    isPriceTriggered = true; priceAlertMsg = `SOL 1小時回撤 ${solData.dropPct.toFixed(2)}%`;
                }

                if (isPriceTriggered) {
                    console.log(`🚨 [Macro] 物理防線觸發，正在同步 AI 災難情報...`);
                    const newsScore = await newsSentimentService.getDisasterScore();
                    
                    if (newsScore >= 80) {
                        await supabase.from('system_config').update({ is_running: false, latest_news_score: newsScore, status_msg: `大盤暴跌禁售中` }).eq('id', 1);
                        sendAdminAlert(`☢️ <b>[大盤熔斷]</b>\n波動: ${priceAlertMsg}\nAI 指數: ${newsScore}/100\n\n系統已強制暫停買入，進入 30 分鐘觀察期！`);
                        pauseCooldownUntil = Date.now() + (30 * 60 * 1000);
                    } 
                    else if (newsScore >= 60) {
                        await supabase.from('system_config').update({ latest_news_score: newsScore, status_msg: `市場恐慌 (AI:${newsScore})`}).eq('id', 1);
                        sendTelegramAlert(`⚠️ <b>市場預警</b>\n波動: ${priceAlertMsg}\nAI 恐慌指數: ${newsScore}/100\n\n系統維持運作，但 AI 將會提高審核門檻。`);
                        pauseCooldownUntil = Date.now() + (15 * 60 * 1000); 
                    } else {
                        await supabase.from('system_config').update({ latest_news_score: 40 }).eq('id', 1);
                    }
                } else {
                    await supabase.rpc('decrement_disaster_score', { decrement_by: 5 });
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] 發生錯誤: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 數據中斷`);
                if (err.response?.status === 429) pauseCooldownUntil = Date.now() + (5 * 60 * 1000);
            }
        }, 180000); 
    }
};

module.exports = { macroMonitorService };