// src/services/macroMonitorService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { sendTelegramAlert, sendAdminAlert } = require('./telegramService');
const { healthMonitor } = require('./healthMonitor');
const { newsSentimentService } = require('./newsSentimentService'); 
const configEnv = require('../config/env'); 

let pauseCooldownUntil = 0; 
let useCoinGeckoNext = true; 

const macroMonitorService = {
    
    // 🦎 數據源 A: CoinGecko (使用 Demo API Key)
    async fetchHighAndDropCoinGecko(coinId) {
        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
        const config = {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        };

        // 🚀 動態注入 CoinGecko 金鑰
        if (configEnv.external.coingeckoApiKey) {
            const cleanKey = configEnv.external.coingeckoApiKey.replace(/['"]/g, '').trim();
            // 判斷是 Demo Key 還是 Pro Key (Demo Key 通常以 CG- 開頭)
            if (cleanKey.startsWith('CG-')) {
                config.headers['x-cg-pro-api-key'] = cleanKey;
            } else {
                config.headers['x-cg-demo-api-key'] = cleanKey;
            }
        }

        const res = await axios.get(url, config);
        const prices = res.data?.prices; // 格式: [[timestamp, price], ...]
        if (!prices || prices.length < 15) throw new Error(`CoinGecko 數據不足`);
        
        // 取最近 15 個數據點 (約 1-2 小時) 找最高點
        const recentPrices = prices.slice(-15);
        let highestPrice = 0;
        for (const p of recentPrices) {
            if (p[1] > highestPrice) highestPrice = p[1];
        }
        const currentPrice = prices[prices.length - 1][1];
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    // 📈 數據源 B: KuCoin (免 Key 公共接口)
    async fetchHighAndDropKuCoin(symbol) {
        // KuCoin 格式需要橫杠: BTC-USDT
        const formattedSymbol = symbol.includes('-') ? symbol : symbol.replace('USDT', '-USDT');
        const url = `https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${formattedSymbol}`;
        
        const res = await axios.get(url, { timeout: 8000 });
        const klines = res.data?.data; // 格式: [ [time, open, close, high, low, vol, turn], ... ]
        if (!klines || klines.length === 0) throw new Error(`KuCoin 數據異常`);
        
        // KuCoin 返回的是倒序，最新的在 index 0
        const recentKlines = klines.slice(0, 15);
        let highestPrice = 0;
        for (const k of recentKlines) {
            const high = parseFloat(k[3]);
            if (high > highestPrice) highestPrice = high;
        }
        const currentPrice = parseFloat(recentKlines[0][2]); // 最新收盤價
        const dropPct = ((currentPrice - highestPrice) / highestPrice) * 100;
        
        return { currentPrice, highestPrice, dropPct };
    },

    // 🔄 智能分流與備援獲取器
    async getMarketData() {
        let btcData, solData, sourceName;

        try {
            if (useCoinGeckoNext) {
                sourceName = 'CoinGecko';
                btcData = await this.fetchHighAndDropCoinGecko('bitcoin');
                await new Promise(r => setTimeout(r, 1500)); // 緩衝防 429
                solData = await this.fetchHighAndDropCoinGecko('solana');
            } else {
                sourceName = 'KuCoin';
                btcData = await this.fetchHighAndDropKuCoin('BTC-USDT');
                await new Promise(r => setTimeout(r, 1000)); 
                solData = await this.fetchHighAndDropKuCoin('SOL-USDT');
            }
            return { btcData, solData, sourceName };
        } catch (err) {
            // 如果主源失敗或被限流，立刻嘗試另一個
            console.warn(`⚠️ [Macro] ${sourceName} 獲取失敗: ${err.message}，切換備援...`);
            useCoinGeckoNext = !useCoinGeckoNext; 
            
            const fallbackSource = useCoinGeckoNext ? 'CoinGecko' : 'KuCoin';
            if (fallbackSource === 'CoinGecko') {
                return {
                    btcData: await this.fetchHighAndDropCoinGecko('bitcoin'),
                    solData: await this.fetchHighAndDropCoinGecko('solana'),
                    sourceName: 'CoinGecko (備援)'
                };
            } else {
                return {
                    btcData: await this.fetchHighAndDropKuCoin('BTC-USDT'),
                    solData: await this.fetchHighAndDropKuCoin('SOL-USDT'),
                    sourceName: 'KuCoin (備援)'
                };
            }
        }
    },

    // 🧠 AI 恢復審查機制
    async checkRecovery() {
        console.log(`⏳ [Macro] 避險期滿，交由 Master AI 重新審查大盤新聞...`);
        try {
            const newScore = await newsSentimentService.getDisasterScore();
            
            if (newScore >= 50) {
                console.log(`🚨 [Macro] 危機未除 (AI 指數: ${newScore})，延長避險 30 分鐘！`);
                await supabase.from('system_config').update({ 
                    latest_news_score: newScore, 
                    status_msg: `繼續避險 (AI指數:${newScore})` 
                }).eq('id', 1);
                
                pauseCooldownUntil = Date.now() + (30 * 60 * 1000); 
            } else {
                console.log(`✅ [Macro] 危機解除 (AI 指數: ${newScore})，系統恢復正常！`);
                await supabase.from('system_config').update({ 
                    is_running: true, 
                    status_msg: '正常運作中', 
                    latest_news_score: newScore  
                }).eq('id', 1);
                
                sendAdminAlert(`✅ <b>[大盤解封]</b>\nAI 確認新聞危機已解除 (指數: ${newScore})，系統已恢復交易！`);
                pauseCooldownUntil = 0; // 徹底清空冷卻
            }
        } catch (err) {
            console.error(`❌ [Macro] 恢復審查失敗，5 分鐘後重試: ${err.message}`);
            setTimeout(() => this.checkRecovery(), 5 * 60 * 1000); 
        }
    },

    start() {
        console.log(`🌍 [Macro] 大盤防禦雷達已就位 (雙向斷路器模式)...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 守衛中');
        
        setInterval(async () => {
            const now = Date.now();
            if (now < pauseCooldownUntil) {
                // 如果是在冷卻中，且時間剛好超過，執行恢復檢查
                if (pauseCooldownUntil !== 0 && now >= (pauseCooldownUntil - 5000)) {
                   await this.checkRecovery();
                }
                return;
            }

            try {
                // 檢查系統是否開啟
                const { data: config } = await supabase.from('system_config').select('is_running').eq('id', 1).single();
                if (!config?.is_running) return;

                const { btcData, solData, sourceName } = await this.getMarketData();
                
                // 每次成功獲取後切換下次數據源，分散負載
                useCoinGeckoNext = !useCoinGeckoNext;
                healthMonitor.setStatus('Macro_Radar', `🟢 正常 (${sourceName})`);

                let isPriceTriggered = false;
                let priceAlertMsg = '';

                // 物理死線: BTC 跌 2% 或 SOL 跌 3%
                if (btcData.dropPct <= -2.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `BTC 1小時回撤 ${btcData.dropPct.toFixed(2)}%`;
                } else if (solData.dropPct <= -3.0) {
                    isPriceTriggered = true;
                    priceAlertMsg = `SOL 1小時回撤 ${solData.dropPct.toFixed(2)}%`;
                }

                if (isPriceTriggered) {
                    console.log(`🚨 [Macro] 物理防線觸發，正在同步 AI 災難情報...`);
                    const newsScore = await newsSentimentService.getDisasterScore();
                    
                    if (newsScore >= 80) {
                        // 熔斷模式：拔線
                        await supabase.from('system_config').update({ 
                            is_running: false, 
                            latest_news_score: newsScore,
                            status_msg: `大盤暴跌禁售中 (AI指數:${newsScore})` 
                        }).eq('id', 1);
                        sendAdminAlert(`☢️ <b>[大盤熔斷]</b>\n波動: ${priceAlertMsg}\nAI 指數: ${newsScore}/100\n\n系統已強制暫停買入，進入 30 分鐘觀察期！`);
                        pauseCooldownUntil = Date.now() + (30 * 60 * 1000);
                    } 
                    else if (newsScore >= 60) {
                        // 軟權重模式：不拔線，但寫入分數讓 AI 變嚴格
                        await supabase.from('system_config').update({ 
                            latest_news_score: newsScore,
                            status_msg: `市場恐慌 (AI指數:${newsScore})`
                        }).eq('id', 1);
                        sendTelegramAlert(`⚠️ <b>市場預警</b>\n波動: ${priceAlertMsg}\nAI 恐慌指數: ${newsScore}/100\n\n系統維持運作，但 AI 將會提高審核門檻。`);
                        pauseCooldownUntil = Date.now() + (15 * 60 * 1000); 
                    } else {
                        // 物理波動但新聞面平和：微調分數即可
                        await supabase.from('system_config').update({ latest_news_score: 40 }).eq('id', 1);
                    }
                } else {
                    // 市場平和，緩慢下調災難指數 (RPC)
                    await supabase.rpc('decrement_disaster_score', { decrement_by: 5 });
                }
            } catch (err) {
                console.error(`❌ [Macro_Radar] 發生錯誤: ${err.message}`);
                healthMonitor.setStatus('Macro_Radar', `🔴 數據中斷: ${err.message}`);
                // 如果 API 被封，休息 5 分鐘
                if (err.response?.status === 429) pauseCooldownUntil = Date.now() + (5 * 60 * 1000);
            }
        }, 180000); // 3 分鐘巡邏一次
    }
};

module.exports = { macroMonitorService };