// src/services/newsSentimentService.js
const axios = require('axios');
const Parser = require('rss-parser');

const parser = new Parser();

const newsSentimentService = {
    async getDisasterScore() {
        console.log('📰 [News_AI] 收到大盤暴跌信號！啟動 RSS 突發新聞掃描...');
        try {
            // 1. 抓取 CoinTelegraph 最新 RSS 標題 (完全免費，免 API Key)
            const feed = await parser.parseURL('https://cointelegraph.com/rss');
            // 抽最新 8 條標題出嚟
            const recentTitles = feed.items.slice(0, 8).map(item => `- ${item.title}`).join('\n');

            // 2. 準備 Groq 嘅 Prompt
            const groqApiKey = process.env.GROQ_API_KEY; 
            if (!groqApiKey) throw new Error("環境變數缺少 GROQ_API_KEY");

            const prompt = `你是量化基金首席風控官。大盤剛剛暴跌 2% 以上。請閱讀以下過去一小時的最新新聞標題，判斷暴跌原因是：
1. 日常宏觀數據/常規FUD/技術性獲利回吐 (給予 0-40 分)
2. 幣圈局部利空/中型監管消息 (50-70 分)
3. 結構性黑天鵝如知名交易所倒閉、USDT脫鉤、大型戰爭爆發、重大駭客事件 (80-100 分)。
你只能回覆一個 0 到 100 的純數字，不要任何其他文字或解釋。

最新新聞標題：
${recentTitles}`;

            // 3. Call 你現有嘅 Groq API (用極速 Llama 3)
            const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama3-70b-8192",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1 // 越低越冷靜，唔好發夢
            }, {
                headers: { 
                    'Authorization': `Bearer ${groqApiKey}`, 
                    'Content-Type': 'application/json' 
                }
            });

            // 4. 清理並提取分數
            const scoreStr = groqRes.data.choices[0].message.content.trim();
            const score = parseInt(scoreStr.replace(/\D/g, ''), 10) || 50; 

            console.log(`🧠 [News_AI] Groq 災難評分出爐: ${score}/100`);
            return score;

        } catch (error) {
            console.error('❌ [News_AI] 新聞評分失敗，預設返回 50 分以保安全:', error.message);
            return 50; // 萬一斷網，當普通跌市處理
        }
    }
};

module.exports = { newsSentimentService };
