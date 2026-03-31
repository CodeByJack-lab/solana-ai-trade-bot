// src/services/consensusService.js
// 📝 檔案功能用途：雙核漏斗式決策機。維持 Meme 與 Trending 雙軌並行，將微觀指標 (OFI/均單) 注入 AI 劇本，進行多輪會審決策。

const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator'); 
const { promptManager } = require('./promptManager'); 

/**
 * 🏛️ 雙核任務隊列 (Worker Pool)：控制 AI 併發請求，避免觸發限流
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

// ⚔️ 宣告一個雙核排隊通道
const consensusQueue = new TaskQueue('Consensus_Matrix', 2);

const consensusService = {
    /**
     * ⚔️ 雙軌核心：Meme / Trending 三司會審 (雙核漏斗式決策)
     */
    async runMemeConsensus(mintAddress, marketData, options = { poolType: 'NURSERY' }) {
        return consensusQueue.add(async () => {
            const isTrending = options.poolType === 'TRENDING';
            const hallName = isTrending ? '趨勢藍籌 議事廳' : 'Meme 盲狙 議事廳';
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

            // 🚀 [V9.0 核心] 將 OFI, AvgTrade, Spread_Delta 精確注入給 AI
            const promptData = {
                token_symbol: marketData.symbol,
                token_name: marketData.name,
                liquidity: marketData.liquidity,
                vol_5m: marketData.volume5m, 
                buy_txs: marketData.buys5m,
                sell_txs: marketData.sells5m,
                ofi: (marketData.ofi || 0).toFixed(2),
                avg_trade: (marketData.avgTrade || 0).toFixed(2),
                spread_delta: ((marketData.spreadDelta || 0) * 100).toFixed(2),
                social_links: marketData.socials,
                description: finalDescription, 
                latest_news_score: currentNewsScore
            };

            // 🔄 恢復雙軌機制：根據 poolType 決定使用 meme_ 還是 trending_ 劇本
            const promptPrefix = isTrending ? 'trending' : 'meme'; 
            const plan = aiOrchestrator.getRoutingPlan();

            // ==========================================
            // 🗡️ 第一關：先鋒 (Scout) - 專注 OFI 與洗盤偵測
            // ==========================================
            const pScout = promptManager.getPrompt(`${promptPrefix}_scout`, promptData); 
            console.log(`📡 [${marketData.symbol}] 呼叫先鋒 (${plan.scout})...`);
            const scout = await aiOrchestrator.executeTask('SCOUT', plan.scout, pScout);
            
            await new Promise(r => setTimeout(r, 1000)); 
            
            const cleanScout = (scout.decision || scout.verdict || '').trim().toUpperCase();
            if (cleanScout === 'REJECT' || cleanScout === 'VETO' || cleanScout.includes('VETO')) {
                return { buy: false, reason: `先鋒量化淘汰: ${scout.reason}` };
            }

            // ==========================================
            // 🧠 第二關：軍師 (Strategist) - 專注動能與敘事
            // ==========================================
            const pStrat = promptManager.getPrompt(`${promptPrefix}_strategist`, promptData);
            console.log(`📡 [${marketData.symbol}] 呼叫軍師 (${plan.strategist})...`);
            const strategist = await aiOrchestrator.executeTask('STRATEGIST', plan.strategist, pStrat);
            
            await new Promise(r => setTimeout(r, 1000)); 
            
            const cleanStrat = (strategist.decision || strategist.verdict || '').trim().toUpperCase();
            if (cleanStrat === 'REJECT' || cleanStrat === 'VETO' || cleanStrat.includes('VETO')) {
                return { buy: false, reason: `軍師動能淘汰: ${strategist.reason}` };
            }

            // ==========================================
            // ⚖️ 第三關：判官 (Auditor) - 綜合裁決
            // ==========================================
            const pAuditBase = promptManager.getPrompt(`${promptPrefix}_auditor`, promptData);
            const pAuditWrapped = `${pAuditBase}\n\n【前線量化戰報】\n先鋒意見 (${cleanScout}): ${scout.reason}\n軍師意見 (${cleanStrat}): ${strategist.reason}\n\n請綜合上述 OFI 數據與動能資訊，做最終判決 (PASS 或 VETO)。`;

            console.log(`📡 [${marketData.symbol}] 呼叫判官 (${plan.auditor})...`);
            const auditor = await aiOrchestrator.executeTask('AUDITOR', plan.auditor, pAuditWrapped);
            
            await new Promise(r => setTimeout(r, 1000)); 

            console.log(`⚡ [${marketData.symbol}] 先鋒: ${cleanScout} | 🧠 軍師: ${cleanStrat} | ⚖️ 判官: ${auditor.decision || auditor.verdict}`);

            const cleanAudit = (auditor.decision || auditor.verdict || '').trim().toUpperCase();
            if (cleanAudit === 'REJECT' || cleanAudit === 'VETO' || cleanAudit.includes('VETO')) {
                return { buy: false, reason: `⚖️ 判官風控否決: ${auditor.reason}` };
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