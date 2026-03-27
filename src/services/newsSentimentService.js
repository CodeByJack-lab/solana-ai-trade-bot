// src/services/newsSentimentService.js
const axios = require('axios');
const Parser = require('rss-parser');
const configEnv = require('../config/env'); // 👈 引入彈藥庫

const parser = new Parser();

const newsSentimentService = {
    async getDisasterScore() {
        console.log('📰 [News_AI] 收到大盤暴跌信號！啟動 RSS 突發新聞掃描...');
        try {
            const rssUrl = 'https://cointelegraph.com/rss';
            const response = await axios.get(rssUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
                },
                timeout: 8000
            });

            const feed = await parser.parseString(response.data);
            
            if (!feed.items || feed.items.length === 0) {
                console.log('⚠️ [News_AI] RSS 抓取成功但內容為空，跳過評分。');
                return 50;
            }

            const recentTitles = feed.items.slice(0, 8).map(item => `- ${item.title}`).join('\n');
            console.log(`📑 [News_AI] 成功抓取 ${feed.items.length} 條新聞，準備分析...`);

            const groqApiKey = configEnv.ai.groqKey; 
            if (!groqApiKey) throw new Error("環境變數缺少 GROQ_API_KEY");

            const prompt = `你是量化基金首席風控官。請閱讀以下過去一小時的最新幣圈新聞標題，評估目前的『市場恐慌指數』。
            評分標準：
            0-30 分: 市場平靜、情緒恢復、有明顯利好消息（解除防禦）。
            31-60 分: 日常宏觀數據發佈、常規FUD、市場觀望、輕微回調（常規防禦）。
            61-100 分: 結構性黑天鵝如知名交易所倒閉、穩定幣脫鉤、大型戰爭爆發、重大駭客事件（最高防禦）。
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

            const scoreStr = groqRes.data.choices[0].message.content.trim();
            const score = parseInt(scoreStr.replace(/\D/g, ''), 10) || 50; 

            console.log(`🧠 [News_AI] Groq 災難評分出爐: ${score}/100`);
            return score;

        } catch (error) {
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