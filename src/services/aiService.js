// src/services/aiService.js
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
     * 👁️ 持倉巡邏 (Overseer) - 物理死線與雙核 AI 審查
     */
    async reviewActivePosition(mintAddress, posData) {
        return reviewerQueue.add(async () => {
            const shortMint = posData.token_symbol || mintAddress.substring(0,6);
            console.log(`\n👁️‍🗨️ [Overseer] 分配 Worker 巡邏持倉: ${shortMint}`);

            try {
                // 1. 物理級硬止損前置防線
                const { data: config } = await supabase.from('system_config').select('latest_news_score, stop_loss_pct').eq('id', 1).single();
                const currentNewsScore = config?.latest_news_score || 0;
                const dbStopLoss = parseFloat(config?.stop_loss_pct || -20); 

                if (posData.pnlPct <= dbStopLoss) {
                    return { decision: 'EXIT', reason: `🚨 觸發物理硬止損 (${dbStopLoss}% 熔斷)：當前虧損 ${posData.pnlPct.toFixed(2)}%` };
                }

                // 2. 決定劇本種類
                let promptId = posData.strategy_type && posData.strategy_type.includes('TRENDING') ? 'reviewer_trending' : 'reviewer_overseer';

                // 3. 解包歷史記憶
                let memoryText = "無歷史記憶（這是首次巡邏）。";
                if (posData.previous_ai_thoughts && posData.previous_ai_thoughts.length > 0) {
                    memoryText = posData.previous_ai_thoughts.map((msg, idx) => `[歷史記憶 ${idx + 1}] ${msg}`).join('\n');
                }

                const promptData = {
                    token_symbol: shortMint,
                    pnl_pct: posData.pnlPct ? posData.pnlPct.toFixed(2) : '0.00',
                    ai_reason: posData.ai_reason || '未知',
                    latest_news_score: currentNewsScore,
                    stop_loss_limit: dbStopLoss,  
                    ai_memory: memoryText         
                };

                const promptText = promptManager.getPrompt(promptId, promptData); // ⚡ 直讀 RAM

                // 4. 派單畀 AI (配備強制 Cooldown)
                const result = await aiOrchestrator.executeTask('OVERSEER', 'GEMINI', promptText);
                await new Promise(r => setTimeout(r, 1000)); // 🛑 強制 1 秒 Cooldown

                const cleanDecision = (result.decision || result.verdict || '').trim().toUpperCase();
                console.log(`🤖 監軍判決 (${promptId}): ${cleanDecision} | 理由: ${result.reason}`);

                if (cleanDecision.includes('SELL') || cleanDecision.includes('EXIT')) {
                    return { decision: 'EXIT', reason: result.reason };
                }
                return { decision: 'HOLD', reason: result.reason };

            } catch (error) {
                console.error(`❌ [AI Service] 持倉審查失敗:`, error.message);
                const { data: configRetry } = await supabase.from('system_config').select('stop_loss_pct').eq('id', 1).single();
                const emergencyLimit = parseFloat(configRetry?.stop_loss_pct || -20);

                if (posData.pnlPct <= emergencyLimit) {
                    return { decision: "EXIT", reason: `🛠️ AI 離線自癒：PNL (${posData.pnlPct.toFixed(2)}%) 已觸發資料庫止損死線 (${emergencyLimit}%)，強制撤退` };
                }
                return { decision: "HOLD", reason: "AI 服務暫時無回應，PNL 尚在安全區，暫且持有" };
            }
        });
    }
};

module.exports = aiService;