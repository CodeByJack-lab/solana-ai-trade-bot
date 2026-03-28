// src/services/trendingMonitorService.js
const express = require('express');
const { supabase } = require('../config/supabase');
const axios = require('axios');
const { executeBuy } = require('./tradeService');
const { healthMonitor } = require('./healthMonitor');
const { aiOrchestrator } = require('./aiOrchestrator');

// ==========================================
// 🧠 引入 Redis 中央緩存庫
// ==========================================
const configEnv = require('../config/env');
const Redis = require('ioredis');
const redis = new Redis(configEnv.cache.redisUrl);

redis.on('error', (err) => {
    console.error('🔴 [Redis Error] (Trending Monitor):', err.message);
});

let isTrendingMonitorRunning = false;

function startTrendingMonitor() {
    console.log('📈 [Trending Radar] 熱門幣雷達已啟動 (每 1 分鐘巡邏池內代幣)...');
    
    setInterval(async () => {
        if (isTrendingMonitorRunning) return;
        isTrendingMonitorRunning = true;

        try {
            const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
            if (!config || !config.is_running) {
                isTrendingMonitorRunning = false;
                return;
            }

            const currentNewsScore = config.latest_news_score || 0;

            const { data: tokens } = await supabase.from('trending_pool').select('*');
            if (!tokens || tokens.length === 0) {
                isTrendingMonitorRunning = false;
                return;
            }

            const { getPortfolio } = require('./portfolioService');
            const portfolio = getPortfolio();
            const activePositions = portfolio.positions || [];

            for (const token of tokens) {
                const mintAddress = token.mint_address;

                // 1. 檢查是否已經持有
                const isHolding = activePositions.some(p => p.mint_address === mintAddress);
                if (isHolding) {
                    continue; 
                }

                // ==========================================
                // 2. 🛡️ 智能冷卻防線：贏錢追擊，輸錢面壁 (24小時 / 7日)
                // ==========================================
                const { data: tradeHistory } = await supabase
                    .from('trade_history')
                    .select('created_at, realized_pnl_pct')
                    .eq('token_mint', mintAddress)
                    .eq('action', 'SELL') // 確保只睇平倉紀錄
                    .order('created_at', { ascending: false })
                    .limit(2);

                if (tradeHistory && tradeHistory.length > 0) {
                    const lastTrade = tradeHistory[0];
                    const timeSinceLastTrade = Date.now() - new Date(lastTrade.created_at).getTime();
                    const isLoss1 = lastTrade.realized_pnl_pct < 0;

                    if (isLoss1) {
                        let isLoss2 = false;
                        if (tradeHistory.length > 1) {
                            isLoss2 = tradeHistory[1].realized_pnl_pct < 0;
                        }

                        // 連輸兩次，鎖 7 日
                        if (isLoss2 && timeSinceLastTrade < 7 * 24 * 60 * 60 * 1000) {
                            console.log(`🛑 [Trending] ${token.token_symbol} 連續兩次戰敗，進入 7 日深度冷卻。`);
                            continue;
                        } 
                        // 輸一次，鎖 24 小時
                        else if (!isLoss2 && timeSinceLastTrade < 24 * 60 * 60 * 1000) {
                            console.log(`⏳ [Trending] ${token.token_symbol} 上次交易虧損，進入 24 小時冷卻。`);
                            continue;
                        }
                    } else {
                        // 上次係賺錢，無視時間，繼續追擊！
                        console.log(`✅ [Trending] ${token.token_symbol} 上次交易獲利 (${lastTrade.realized_pnl_pct}%)，無視冷卻期，重新評估！`);
                    }
                }

                // ==========================================
                // 3. 準備 DB Prompt 同埋 Redis 閃電記憶
                // ==========================================
                const { data: promptRecord } = await supabase.from('bot_prompts').select('content').eq('prompt_id', 'trending_strategist').single();
                let promptTemplate = promptRecord ? promptRecord.content : `你是 Web3 敘事心理學家與動能分析師...`;

                // 🧠 提取 Redis 記憶
                let aiMemory = [];
                const memoryStr = await redis.get(`ai_memory_trending_buy:${mintAddress}`);
                if (memoryStr) {
                    aiMemory = JSON.parse(memoryStr);
                }
                
                let memoryText = "無歷史觀察記憶（這是首次評估）。";
                if (aiMemory.length > 0) {
                    memoryText = aiMemory.map((msg, idx) => `[記憶 ${idx + 1}] ${msg}`).join('\n');
                }

                let promptText = promptTemplate;
                promptText = promptText.replace(/{{token_name}}/g, token.token_name || 'Unknown');
                promptText = promptText.replace(/{{token_symbol}}/g, token.token_symbol || 'Unknown');
                promptText = promptText.replace(/{{social_links}}/g, 'Twitter/Telegram Data...'); 
                promptText = promptText.replace(/{{description}}/g, 'Trending Top 50 Token...');
                promptText = promptText.replace(/{{latest_news_score}}/g, currentNewsScore);
                promptText = promptText.replace(/{{ai_memory}}/g, memoryText); // 👈 注入記憶畀 AI

                console.log(`\n🧠 [Trending] AI 正在評估熱門幣: ${token.token_symbol}...`);
                const result = await aiOrchestrator.executeTask('TRENDING_STRATEGIST', 'GROQ', promptText);

                const cleanDecision = (result.decision || result.verdict || '').trim().toUpperCase();
                
                // ==========================================
                // 4. 💾 將 AI 評語寫入 Redis 同 DB
                // ==========================================
                if (result && result.reason) {
                    const timeStr = new Date().toLocaleTimeString('zh-HK', { hour12: false });
                    const newComment = `[${timeStr}] ${result.reason}`;
                    
                    aiMemory.push(newComment);
                    if (aiMemory.length > 3) aiMemory.shift();
                    
                    // 寫入 Redis，設定 7 日過期，對抗 DB 每小時清空
                    await redis.set(`ai_memory_trending_buy:${mintAddress}`, JSON.stringify(aiMemory), 'EX', 7 * 24 * 60 * 60);
                    
                    // 同步最新評語去 DB 俾 Dashboard 睇
                    await supabase.from('trending_pool').update({ last_ai_comment: result.reason }).eq('mint_address', mintAddress);
                }

                if (cleanDecision === 'PASS' || cleanDecision.includes('BUY')) {
                    console.log(`✅ [Trending] AI 批准買入 ${token.token_symbol}!`);
                    
                    // 5. 交給 Security Guard 進行最後防線檢查
                    const { securityGuard } = require('./securityGuard');
                    const secResult = await securityGuard.checkAll(mintAddress);

                    if (secResult.isSafe) {
                        console.log(`🛡️ [Security] ${token.token_symbol} 安全通關，準備開倉...`);
                        await executeBuy(mintAddress, token.token_symbol, 'TRENDING_MOMENTUM', result.score || 85, result.reason, config.trending_trade_amount_sol || 0.1);
                        break; 
                    } else {
                        console.log(`❌ [Security] ${token.token_symbol} 被保安攔截: ${secResult.reason}`);
                    }
                } else {
                    console.log(`📉 [Trending] AI 拒絕買入 ${token.token_symbol}: ${result.reason}`);
                }

                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (err) {
            console.error(`❌ [Trending Monitor Error]`, err.message);
        } finally {
            isTrendingMonitorRunning = false;
        }
    }, 60000); 
}

module.exports = { startTrendingMonitor };