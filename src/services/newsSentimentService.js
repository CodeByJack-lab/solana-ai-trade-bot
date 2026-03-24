// src/services/newsSentimentService.js
const axios = require('axios');
const Parser = require('rss-parser');

const parser = new Parser();

const newsSentimentService = {
    async getDisasterScore() {
        console.log('📰 [News_AI] 收到大盤暴跌信號！啟動 RSS 突發新聞掃描...');
        try {
            // 🚀 修正 1：手動用 axios 獲取 RSS，並加上瀏覽器 Header，防止被 CoinTelegraph 攔截
            const rssUrl = 'https://cointelegraph.com/rss';
            const response = await axios.get(rssUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
                },
                timeout: 8000
            });

            // 將獲取到的 XML 字串傳給 parser
            const feed = await parser.parseString(response.data);
            
            if (!feed.items || feed.items.length === 0) {
                console.log('⚠️ [News_AI] RSS 抓取成功但內容為空，跳過評分。');
                return 50;
            }

            // 抽最新 8 條標題
            const recentTitles = feed.items.slice(0, 8).map(item => `- ${item.title}`).join('\n');
            console.log(`📑 [News_AI] 成功抓取 ${feed.items.length} 條新聞，準備分析...`);

            // 🚀 修正 2：準備 Groq API 呼叫 (增加防呆)
            const groqApiKey = process.env.GROQ_API_KEY; 
            if (!groqApiKey) throw new Error("環境變數缺少 GROQ_API_KEY");

            const prompt = `你是量化基金首席風控官。大盤剛剛暴跌 2% 以上。請閱讀以下過去一小時的最新新聞標題，判斷暴跌原因是：
1. 日常宏觀數據/常規FUD/技術性獲利回吐 (給予 0-40 分)
2. 幣圈局部利空/中型監管消息 (50-70 分)
3. 結構性黑天鵝如知名交易所倒閉、USDT脫鉤、大型戰爭爆發、重大駭客事件 (80-100 分)。
你只能回覆一個 0 到 100 的純數字，不要任何其他文字或解釋。

最新新聞標題：
${recentTitles}`;

            const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama3-70b-8192",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1
            }, {
                headers: { 
                    'Authorization': `Bearer ${groqApiKey.replace(/['"]/g, '').trim()}`, 
                    'Content-Type': 'application/json' 
                },
                timeout: 10000
            });

            // 5. 提取分數
            const scoreStr = groqRes.data.choices[0].message.content.trim();
            const score = parseInt(scoreStr.replace(/\D/g, ''), 10) || 50; 

            console.log(`🧠 [News_AI] Groq 災難評分出爐: ${score}/100`);
            return score;

        } catch (error) {
            // 🚀 修正 3：更詳細的報錯，幫你分清楚係 RSS 定係 Groq 出事
            if (error.response) {
                console.error(`❌ [News_AI] API 報錯 (Status ${error.response.status}):`, error.response.data);
            } else {
                console.error('❌ [News_AI] 系統錯誤:', error.message);
            }
            return 50; 
        }
    }
};

module.exports = { newsSentimentService };
