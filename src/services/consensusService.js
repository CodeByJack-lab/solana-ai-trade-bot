// src/services/consensusService.js
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator'); 
const { promptManager } = require('./promptManager'); // 👈 引入 RAM 閃電劇本庫

/**
 * 🏛️ 雙核任務隊列 (Worker Pool)
 * 允許同時處理 N 個任務，並自帶處理完畢後的防護機制
 */
class TaskQueue {
    constructor(name, concurrency = 2) { 
        this.name = name;
        this.queue = []; 
        this.concurrency = concurrency; // 👈 核心：雙核驅動
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
        // 如果 2 個核都做緊嘢，或者無任務，就停低等
        if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
        
        this.activeCount++;
        const task = this.queue.shift();
        
        try {
            await task();
        } finally {
            this.activeCount--;
            this.process(); // 叫醒下一個任務
        }
    }
}

// ⚔️ 宣告一個雙核嘅三劍俠排隊通道
const consensusQueue = new TaskQueue('Consensus_Meme_Trending', 2);

const consensusService = {
    /**
     * ⚔️ 核心：Meme / Trending 幣種三司會審 (雙核漏斗式決策)
     */
    async runMemeConsensus(mintAddress, marketData, options = { poolType: 'NURSERY' }) {
        return consensusQueue.add(async () => {
            const hallName = options.poolType === 'TRENDING' ? '熱門動能 議事廳' : 'Meme 議事廳';
            const shortMint = mintAddress.substring(0,6);
            console.log(`\n🏛️ [${hallName}] 分配 Worker 處理: ${marketData.symbol || shortMint}`);
            
            let currentNewsScore = 0;
            try {
                const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
                currentNewsScore = config?.latest_news_score || 0;
            } catch (e) {
                console.warn(`⚠️ [${hallName}] 無法獲取災難指數，預設為 0`);
            }
            
            let finalDescription = options.lastComment ? `【歷史評語】${options.lastComment}` : "無";

            const promptData = {
                token_symbol: marketData.symbol,
                token_name: marketData.name,
                liquidity: marketData.liquidity,
                vol_5m: marketData.volume5m, 
                buy_txs: marketData.buys5m,
                sell_txs: marketData.sells5m,
                social_links: marketData.socials,
                description: finalDescription, 
                latest_news_score: currentNewsScore
            };

            const promptPrefix = options.poolType === 'TRENDING' ? 'trending' : 'meme';
            const plan = aiOrchestrator.getRoutingPlan();

            // ==========================================
            // 🗡️ 第一關：先鋒 (Scout)
            // ==========================================
            const pScout = promptManager.getPrompt(`${promptPrefix}_scout`, promptData); // ⚡ 直讀 RAM
            console.log(`📡 [${marketData.symbol}] 呼叫先鋒 (${plan.scout})...`);
            const scout = await aiOrchestrator.executeTask('SCOUT', plan.scout, pScout);
            
            await new Promise(r => setTimeout(r, 1000)); // 🛑 強制 1 秒 Cooldown
            
            const cleanScout = (scout.decision || scout.verdict || '').trim().toUpperCase();
            if (cleanScout === 'REJECT' || cleanScout === 'VETO' || cleanScout.includes('VETO')) {
                return { buy: false, reason: `先鋒淘汰: ${scout.reason}` };
            }

            // ==========================================
            // 🧠 第二關：軍師 (Strategist)
            // ==========================================
            const pStrat = promptManager.getPrompt(`${promptPrefix}_strategist`, promptData);
            console.log(`📡 [${marketData.symbol}] 呼叫軍師 (${plan.strategist})...`);
            const strategist = await aiOrchestrator.executeTask('STRATEGIST', plan.strategist, pStrat);
            
            await new Promise(r => setTimeout(r, 1000)); // 🛑 強制 1 秒 Cooldown
            
            const cleanStrat = (strategist.decision || strategist.verdict || '').trim().toUpperCase();
            if (cleanStrat === 'REJECT' || cleanStrat === 'VETO' || cleanStrat.includes('VETO')) {
                return { buy: false, reason: `軍師淘汰: ${strategist.reason}` };
            }

            // ==========================================
            // ⚖️ 第三關：判官 (Auditor)
            // ==========================================
            const pAuditBase = promptManager.getPrompt(`${promptPrefix}_auditor`, promptData);
            const pAuditWrapped = `${pAuditBase}\n\n【前線戰報彙整】\n先鋒意見 (${cleanScout}): ${scout.reason}\n軍師意見 (${cleanStrat}): ${strategist.reason}\n\n請綜合以上資訊，做最終判決 (PASS 或 VETO)。`;

            console.log(`📡 [${marketData.symbol}] 呼叫判官 (${plan.auditor})...`);
            const auditor = await aiOrchestrator.executeTask('AUDITOR', plan.auditor, pAuditWrapped);
            
            await new Promise(r => setTimeout(r, 1000)); // 🛑 強制 1 秒 Cooldown

            console.log(`⚡ [${marketData.symbol}] 先鋒: ${cleanScout} | 🧠 軍師: ${cleanStrat} | ⚖️ 判官: ${auditor.decision || auditor.verdict}`);

            const cleanAudit = (auditor.decision || auditor.verdict || '').trim().toUpperCase();
            if (cleanAudit === 'REJECT' || cleanAudit === 'VETO' || cleanAudit.includes('VETO')) {
                return { buy: false, reason: `⚖️ 判官否決: ${auditor.reason}` };
            }

            if (cleanAudit === 'BUY' || cleanAudit === 'PASS' || cleanAudit === 'PASSED' || cleanAudit.includes('EXECUTE_BUY')) {
                const finalScore = auditor.score || strategist.score || 80;
                return { buy: true, score: finalScore, reason: `⚖️ 終審通過: ${auditor.reason}` };
            }

            return { buy: false, reason: "判官未給出明確買入指令" };
        });
    }
};

module.exports = { 
    consensusService,
    getPendingMemeCount: () => consensusQueue.queue.length
};