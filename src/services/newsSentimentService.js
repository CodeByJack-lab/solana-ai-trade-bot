// src/services/newsSentimentService.js
// 📝 檔案功能用途：宏觀新聞掃描器。實裝「狀態指針輪替」與「三振出局溯源」，CryptoPanic 與 RSS (CoinTelegraph/Decrypt) 無縫切換。

const axios = require('axios');
const Parser = require('rss-parser');
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator'); 
const configEnv = require('../config/env');
const { sendAdminAlert } = require('./telegramService');

const parser = new Parser();

// 🔄 狀態指針系統 (Stateful Pointer)
const PROVIDERS = [
    { name: 'CRYPTOPANIC', keyName: 'CRYPTOPANIC_API_KEY', type: 'API' },
    { name: 'COINTELEGRAPH', keyName: null, type: 'RSS', url: 'https://cointelegraph.com/rss' },
    { name: 'DECRYPT', keyName: null, type: 'RSS', url: 'https://decrypt.co/feed' }
];

let activeProviderIdx = 0;
const providerErrorCounts = { CRYPTOPANIC: 0, COINTELEGRAPH: 0, DECRYPT: 0 };

const newsSentimentService = {
    /**
     * 📰 獲取新聞文本 (狀態指針輪替)
     */
    async _fetchNewsText() {
        for (let i = 0; i < PROVIDERS.length; i++) {
            const idx = (activeProviderIdx + i) % PROVIDERS.length;
            const provider = PROVIDERS[idx];

            try {
                let recentTitles = "";
                
                if (provider.name === 'CRYPTOPANIC') {
                    const apiKey = process.env[provider.keyName];
                    if (!apiKey) {
                        const err = new Error("未配置變數");
                        err.usedKeyName = provider.keyName;
                        throw err;
                    }
                    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey.replace(/['"]/g, '').trim()}&kind=news`;
                    const res = await axios.get(url, { timeout: 8000 });
                    if (res.data && res.data.results) {
                        recentTitles = res.data.results.slice(0, 10).map(item => `- ${item.title}`).join('\n');
                    } else throw new Error("回傳格式無效");
                } else {
                    const res = await axios.get(provider.url, { timeout: 8000 });
                    const feed = await parser.parseString(res.data);
                    if (feed && feed.items && feed.items.length > 0) {
                        recentTitles = feed.items.slice(0, 10).map(item => `- ${item.title}`).join('\n');
                    } else throw new Error("RSS 解析無效");
                }

                if (recentTitles) {
                    activeProviderIdx = idx; // 🎯 鎖定為新主力
                    providerErrorCounts[provider.name] = 0;
                    return { recentTitles, usedSource: provider.name };
                }
            } catch (err) {
                providerErrorCounts[provider.name]++;
                const deadKeyName = err.usedKeyName || (provider.type === 'RSS' ? '無 (RSS 來源)' : 'UNKNOWN_VAR');

                console.warn(`⚠️ [News_AI] ${provider.name} 獲取失敗 (${providerErrorCounts[provider.name]}/3): ${err.message} (Var: ${deadKeyName})`);

                if (providerErrorCounts[provider.name] === 3) {
                    sendAdminAlert(`🚨 <b>新聞 API 狀態指針輪替</b>\n\n📰 <b>供應商:</b> ${provider.name}\n🔑 <b>陣亡變數:</b> <code>${deadKeyName}</code>\n❌ <b>錯誤:</b> 連續 3 次擷取失敗！\n\n系統已將新聞獲取主力切換至下一個備援。`);
                    providerErrorCounts[provider.name] = 0;
                }
            }
        }
        return { recentTitles: "", usedSource: "FAILED" };
    },

    async getDisasterScore() {
        console.log('📰 [News_AI] 啟動崗位化新聞掃描 (狀態指針輪替)...');
        try {
            const { recentTitles, usedSource } = await this._fetchNewsText();
            
            if (!recentTitles) {
                console.error(`❌ [News_AI] 所有新聞來源均失效，回傳中立分數 50`);
                return 50;
            }

            const prompt = `You are the Macro Risk Officer of a quantitative hedge fund. Evaluate the panic level (0-100) of the crypto market based on the following news headlines.
            0-30: Calm / Bullish.
            31-60: Normal volatility.
            61-100: Black Swan / Crash.
            Output pure JSON only: {"score": <number>}
            Headlines:\n${recentTitles}`;

            const result = await aiOrchestrator.executeTask('SENTIMENT', 'GEMINI', prompt);
            const score = parseInt(result.score, 10) || 50;

            console.log(`🧠 [News_AI] 分析完成: ${score}/100 (來源: ${usedSource} | Provider: ${result.usedProvider})`);
            await supabase.from('system_config').update({ latest_news_score: score }).eq('id', 1);
            return score;
        } catch (error) {
            console.error(`❌ [News_AI] 失敗: ${error.message}`);
            return 50; 
        }
    }
};

module.exports = { newsSentimentService };