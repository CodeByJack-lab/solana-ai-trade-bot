// src/services/aiService.js
// 📝 檔案功能及用途：持倉巡邏監軍。定時讓 AI 審視活動倉位，雙軌獨立巡邏，注入歷史記憶加強破位平倉判斷。

const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator');
const { promptManager } = require('./promptManager');

/**
 * 🛡️ 平倉監軍專屬雙核隊列 (Reviewer Pool)
 */
class TaskQueue {
    constructor(name, concurrency = 2) { 
        this.name = name;
        this.queue = []; 
        this.concurrency = concurrency;
        this.activeCount = 0; 
    }
    
    async add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try { resolve(await task()); } catch (e) { reject(e); }
            });
            this.process();
        });
    }

    async process() {
        if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
        
        this.activeCount++;
        const task = this.queue.shift();
        
        try {
            await task();
        } finally {
            this.activeCount--;
            this.process();
        }
    }
}

// 🛡️ 宣告雙核監軍 Queue
const reviewerQueue = new TaskQueue('Reviewer_Overseer', 2);

const aiService = {
    /**
     * 👁️ 持倉巡邏 (Overseer) - 雙軌 AI 審查與歷史記憶注入
     */
    async reviewActivePosition(mintAddress, posData) {
        return reviewerQueue.add(async () => {
            const shortMint = posData.token_symbol || mintAddress.substring(0,6);
            const isTrending = posData.strategy_type && posData.strategy_type.includes('TRENDING');
            const roleName = isTrending ? '趨勢監軍' : 'Meme 監軍';
            
            console.log(`\n👁️‍🗨️ [${roleName}] 分配 Worker 巡邏持倉: ${shortMint}`);

            try {
                // 1. 物理級硬止損前置防線
                const { data: config } = await supabase.from('system_config').select('latest_news_score, stop_loss_pct').eq('id', 1).single();
                const currentNewsScore = config?.latest_news_score || 0;
                
                // 動態讀取策略專屬的止損線 (若無則用系統預設)
                const stratId = isTrending ? 3 : 2;
                const { data: stratParams } = await supabase.from('ai_strategy_params').select('stop_loss_pct').eq('id', stratId).single();
                const dbStopLoss = parseFloat(stratParams?.stop_loss_pct || config?.stop_loss_pct || -15); 

                if (posData.pnlPct <= dbStopLoss) {
                    return { decision: 'EXIT', reason: `🚨 觸發物理硬止損 (${dbStopLoss}% 熔斷)：當前虧損 ${posData.pnlPct.toFixed(2)}%` };
                }

                // 2. 雙軌決策：決定劇本種類
                let promptId = isTrending ? 'reviewer_trending' : 'reviewer_overseer';

                // 3. 解包歷史記憶 (Memory Injection)
                let memoryText = "無歷史記憶（這是首次巡邏）。";
                if (posData.previous_ai_thoughts && posData.previous_ai_thoughts.length > 0) {
                    memoryText = posData.previous_ai_thoughts.map((msg, idx) => `[記憶 ${idx + 1}] ${msg}`).join('\n');
                }

                const promptData = {
                    token_symbol: shortMint,
                    pnl_pct: posData.pnlPct ? posData.pnlPct.toFixed(2) : '0.00',
                    ai_reason: posData.ai_reason || '未知',
                    latest_news_score: currentNewsScore,
                    stop_loss_limit: dbStopLoss,  
                    ai_memory: memoryText         
                };

                const promptText = promptManager.getPrompt(promptId, promptData); 

                // 4. 派單畀 AI (強制使用 GROQ 處理高頻微觀審查)
                const result = await aiOrchestrator.executeTask('OVERSEER', 'GROQ', promptText);
                await new Promise(r => setTimeout(r, 1000)); // 強制 1 秒 Cooldown 防限流

                const cleanDecision = (result.decision || result.verdict || '').trim().toUpperCase();
                console.log(`🤖 ${roleName}判決 (${promptId}): ${cleanDecision} | 理由: ${result.reason}`);

                if (cleanDecision.includes('SELL') || cleanDecision.includes('EXIT')) {
                    return { decision: 'EXIT', reason: result.reason };
                }
                return { decision: 'HOLD', reason: result.reason };

            } catch (error) {
                console.error(`❌ [AI Service] 持倉審查失敗:`, error.message);
                return { decision: "HOLD", reason: "AI 服務暫時無回應，暫且持有" };
            }
        });
    }
};

module.exports = aiService;