const axios = require('axios');
const Parser = require('rss-parser');
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator'); 

const parser = new Parser();

const newsSentimentService = {
    async getDisasterScore() {
        console.log('📰 [News_AI] 啟動崗位化新聞掃描...');
        try {
            const rssUrl = 'https://cointelegraph.com/rss';
            const response = await axios.get(rssUrl, { timeout: 8000 });
            const feed = await parser.parseString(response.data);
            
            if (!feed.items || feed.items.length === 0) return 50;

            const recentTitles = feed.items.slice(0, 10).map(item => `- ${item.title}`).join('\n');
            
            const prompt = `你是量化基金風控官。請評估以下標題對幣圈的恐慌程度 (0-100)。
            0-30: 平靜/利好。
            31-60: 常規震盪。
            61-100: 黑天鵝/崩盤。
            只回傳純 JSON：{"score": 數字}
            
            標題：\n${recentTitles}`;

            // 🚀 核心：直接使用 SENTIMENT 崗位，Orchestrator 會自動從 SQL 抓取最新配置
            const result = await aiOrchestrator.executeTask('SENTIMENT', 'GROQ', prompt);

            const score = parseInt(result.score, 10) || 50;
            console.log(`🧠 [News_AI] 分析完成: ${score}/100 (Provider: ${result.usedProvider})`);

            // 寫入數據庫供 Dashboard 顯示
            await supabase.from('system_config').update({ latest_news_score: score }).eq('id', 1);

            return score;
        } catch (error) {
            console.error(`❌ [News_AI] 失敗: ${error.message}`);
            return 50; 
        }
    }
};

module.exports = { newsSentimentService };
