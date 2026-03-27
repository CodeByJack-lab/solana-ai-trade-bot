// src/services/consensusService.js
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('./aiOrchestrator'); // 👈 引入大腦總機
const { healthMonitor } = require('./healthMonitor');

/**
 * 🏛️ 最高法院任務隊列 (防止瞬間湧入過多審判)
 */
class TaskQueue {
    constructor(name) { 
        this.name = name;
        this.queue = []; 
        this.isProcessing = false; 
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
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            await task();
            await new Promise(r => setTimeout(r, 1000)); // 每個審判間隔 1 秒
        }
        this.isProcessing = false;
    }
}

const memeQueue = new TaskQueue('Meme');
const bluechipQueue = new TaskQueue('Bluechip');

const consensusService = {
    /**
     * ☁️ 從 Supabase 動態拉取 Prompt 並注入數據
     */
    async getPrompt(promptId, data) {
        const { data: promptData } = await supabase.from('bot_prompts').select('content').eq('prompt_id', promptId).single();
        let content = promptData?.content || "";
        for (const [key, value] of Object.entries(data)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        return content;
    },

    /**
     * ⚔️ 核心：Meme / Trending 幣種三司會審 (漏斗式決策)
     */
    async runMemeConsensus(mintAddress, marketData, options = { isReentry: false, poolType: 'NURSERY' }) {
        return memeQueue.add(async () => {
            const hallName = options.poolType === 'TRENDING' ? '熱門動能 議事廳' : 'Meme 議事廳';
            console.log(`\n🏛️ [${hallName}] 開始審核: ${marketData.symbol || mintAddress.substring(0,6)}`);
            
            let currentNewsScore = 0;
            try {
                const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
                currentNewsScore = config?.latest_news_score || 0;
            } catch (e) {
                console.warn(`⚠️ [${hallName}] 無法獲取大盤災難指數，預設為 0`);
            }
            
            const promptData = {
                token_symbol: marketData.symbol,
                token_name: marketData.name,
                liquidity: marketData.liquidity,
                vol_5m: marketData.vol5m,
                buy_txs: marketData.buys5m,
                sell_txs: marketData.sells5m,
                social_links: marketData.socials,
                description: options.isReentry ? "【注意：橫盤30分鐘後接回】" : "無",
                latest_news_score: currentNewsScore
            };

            const promptPrefix = options.poolType === 'TRENDING' ? 'trending' : 'meme';

            // 🔀 1. 向大腦總機索取本次審判的「錯峰陣型」
            const plan = aiOrchestrator.getRoutingPlan();

            // ==========================================
            // 🗡️ 第一關：先鋒 (Scout) 負責感性與敘事
            // ==========================================
            const pScout = await this.getPrompt(`${promptPrefix}_scout`, promptData);
            console.log(`📡 正在呼叫先鋒 (${plan.scout})...`);
            const scout = await aiOrchestrator.executeTask('SCOUT', plan.scout, pScout);
            
            const cleanScout = (scout.decision || scout.verdict || '').trim().toUpperCase();
            
            // 🛑 【漏斗截斷 1】：先鋒話唔得，即刻斬！(修復：加入 VETO 判斷)
            if (cleanScout === 'REJECT' || cleanScout === 'VETO' || cleanScout.includes('VETO')) {
                console.log(`🛑 [提早截斷] 先鋒否決: ${scout.reason}`);
                return { buy: false, reason: `先鋒首輪淘汰: ${scout.reason}` };
            }

            // ==========================================
            // 🧠 第二關：軍師 (Strategist) 負責硬數據與風險
            // ==========================================
            const pStrat = await this.getPrompt(`${promptPrefix}_strategist`, promptData);
            console.log(`📡 正在呼叫軍師 (${plan.strategist})...`);
            const strategist = await aiOrchestrator.executeTask('STRATEGIST', plan.strategist, pStrat);
            
            const cleanStrat = (strategist.decision || strategist.verdict || '').trim().toUpperCase();

            // 🛑 【漏斗截斷 2】：軍師話唔得，即刻斬！(修復：新增軍師截斷)
            if (cleanStrat === 'REJECT' || cleanStrat === 'VETO' || cleanStrat.includes('VETO')) {
                console.log(`🛑 [提早截斷] 軍師否決: ${strategist.reason}`);
                return { buy: false, reason: `軍師數據淘汰: ${strategist.reason}` };
            }

            // ==========================================
            // ⚖️ 第三關：判官 (Auditor) 行使一票否定權
            // ==========================================
            // 📦 戰報強制打包 (修復：確保判官一定睇到先鋒同軍師嘅意見)
            const pAuditBase = await this.getPrompt(`${promptPrefix}_auditor`, promptData);
            const pAuditWrapped = `${pAuditBase}\n\n【前線戰報彙整】\n先鋒意見 (${cleanScout}): ${scout.reason}\n軍師意見 (${cleanStrat}): ${strategist.reason}\n\n請綜合以上資訊，做最終判決 (PASS 或 VETO)。你有絕對一票否定權。`;

            console.log(`📡 正在呼叫判官 (${plan.auditor})...`);
            const auditor = await aiOrchestrator.executeTask('AUDITOR', plan.auditor, pAuditWrapped);

            console.log(`⚡ 先鋒: ${cleanScout} | 🧠 軍師: ${cleanStrat} | ⚖️ 判官: ${auditor.decision || auditor.verdict}`);

            const cleanAudit = (auditor.decision || auditor.verdict || '').trim().toUpperCase();

            // 🛑 【絕對一票否定權】：只要判官唔係話 BUY/PASS，全部當 REJECT
            if (cleanAudit === 'REJECT' || cleanAudit === 'VETO' || cleanAudit.includes('VETO')) {
                return { buy: false, reason: `⚖️ 判官否決: ${auditor.reason}` };
            }

            if (cleanAudit === 'BUY' || cleanAudit === 'PASS' || cleanAudit === 'PASSED' || cleanAudit.includes('EXECUTE_BUY')) {
                // 最終分數由判官決定，如果判官無畀分就用軍師嘅
                const finalScore = auditor.score || strategist.score || 80;
                return { buy: true, score: finalScore, reason: `⚖️ 終審通過: ${auditor.reason}` };
            }

            return { buy: false, reason: "判官未給出明確買入指令" };
        });
    },

    /**
     * 🔭 老幣巡邏共識 (單一軍師機制)
     */
    async runBluechipConsensus(mintAddress, marketData) {
        return bluechipQueue.add(async () => {
            console.log(`\n🏛️ [老幣 議事廳] 開始審核: ${marketData.symbol}`);
            
            let currentNewsScore = 0;
            try {
                const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
                currentNewsScore = config?.latest_news_score || 0;
            } catch (e) {
                console.warn(`⚠️ [老幣 議事廳] 無法獲取大盤災難指數，預設為 0`);
            }

            const pStrat = await this.getPrompt('bluechip_strategist', { 
                ...marketData,
                latest_news_score: currentNewsScore 
            });
            
            // 老幣巡邏直接用無限水喉 GEMINI 負責
            const strategist = await aiOrchestrator.executeTask('STRATEGIST_BLUECHIP', 'GEMINI', pStrat);
            
            console.log(`🧠 老幣軍師: ${strategist.decision || strategist.verdict} | 理由: ${strategist.reason}`);
            
            const cleanDecision = (strategist.decision || strategist.verdict || '').trim().toUpperCase();

            if (cleanDecision.includes('PASS') || cleanDecision.includes('EXECUTE_BUY') || cleanDecision === 'BUY') {
                return { buy: true, reason: `✅ 安全: ${strategist.reason}` };
            } else if (cleanDecision.includes('ONHOLD')) {
                return { buy: false, reason: `⏳ ONHOLD: ${strategist.reason}` }; 
            } else {
                return { buy: false, reason: `🚨 攔截: ${strategist.reason}` };
            }
        });
    }
};

module.exports = { 
    consensusService,
    getPendingMemeCount: () => memeQueue.queue.length
};