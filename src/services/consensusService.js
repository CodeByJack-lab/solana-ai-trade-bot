// src/services/consensusService.js
const axios = require('axios');
const { supabase } = require('../config/supabase');
const { healthMonitor } = require('./healthMonitor');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

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
            await new Promise(r => setTimeout(r, 1050)); 
        }
        this.isProcessing = false;
    }
}

const memeQueue = new TaskQueue('Meme');
const bluechipQueue = new TaskQueue('Bluechip');

const API_CONFIG = {
    MISTRAL: { url: 'https://api.mistral.ai/v1/chat/completions', key: process.env.MISTRAL_API_KEY },
    GROQ: { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY }
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function callProvider(provider, modelName, promptText) {
    if (provider === 'GOOGLE') {
        const model = genAI.getGenerativeModel({ model: modelName });
        
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`[${modelName}] Google API 超時無回應`)), 10000);
        });

        try {
            const fetchPromise = model.generateContent({
                contents: [{ role: "user", parts: [{ text: promptText }] }],
                generationConfig: { responseMimeType: "application/json" }
            });

            const result = await Promise.race([fetchPromise, timeoutPromise]);
            clearTimeout(timeoutId);

            let rawText = result.response.text();
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("Google API 沒有返回 JSON");
            return JSON.parse(match[0]);
            
        } catch (error) {
            clearTimeout(timeoutId);
            throw error; 
        }
    } else {
        const res = await axios.post(API_CONFIG[provider].url, {
            model: modelName,
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${API_CONFIG[provider].key}`, 'Content-Type': 'application/json' },
            timeout: 10000 
        });
        return JSON.parse(res.data.choices[0].message.content);
    }
}

async function callWithFallback(role, primary, backup, promptText) {
    try {
        const result = await callProvider(primary.provider, primary.model, promptText);
        healthMonitor.setStatus(`AI_${role}`, `🟢 正常 (${primary.provider})`);
        return { ...result, usedModel: primary.model };
    } catch (err) {
        const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.warn(`⚠️ [AI_${role}] ${primary.provider} 失敗 (${errMsg})，自動切換至備援 ${backup.provider}...`);
        healthMonitor.setStatus(`AI_${role}`, `🟡 切換備援 (${backup.provider})`);
        
        await new Promise(r => setTimeout(r, 1050)); 
        
        try {
            const fallbackResult = await callProvider(backup.provider, backup.model, promptText);
            return { ...fallbackResult, usedModel: backup.model };
        } catch (fallbackErr) {
            healthMonitor.setStatus(`AI_${role}`, `🔴 雙端失效`);
            return { decision: "VETO", reason: "API 雙端失效" };
        }
    }
}

const consensusService = {
    async getPrompt(promptId, data) {
        const { data: promptData } = await supabase.from('bot_prompts').select('content').eq('prompt_id', promptId).single();
        let content = promptData?.content || "";
        for (const [key, value] of Object.entries(data)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        return content;
    },

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

            const [pScout, pStrat, pAudit] = await Promise.all([
                this.getPrompt(`${promptPrefix}_scout`, promptData),
                this.getPrompt(`${promptPrefix}_strategist`, promptData),
                this.getPrompt(`${promptPrefix}_auditor`, { 
                    ...promptData, 
                    rug_score: 'N/A', 
                    top10_pct: 'N/A', 
                    lp_status: 'N/A' 
                })
            ]);

            console.log("📡 正在呼叫先鋒 (Scout)...");
            const scout = await callWithFallback('Scout', {provider:'GROQ', model:'llama-3.1-8b-instant'}, {provider:'MISTRAL', model:'mistral-small-latest'}, pScout);
            
            console.log("📡 正在呼叫軍師 (Strategist)...");
            const strategist = await callWithFallback('Strategist', {provider:'GOOGLE', model:'gemini-3.1-flash-lite-preview'}, {provider:'MISTRAL', model:'mistral-large-latest'}, pStrat);
            
            console.log("📡 正在呼叫判官 (Auditor)...");
            const auditor = await callWithFallback('Auditor', {provider:'GROQ', model:'llama-3.3-70b-versatile'}, {provider:'GOOGLE', model:'gemini-3.1-pro-preview'}, pAudit);

            console.log(`⚡ 先鋒: ${scout.decision} | 🧠 軍師: ${strategist.decision} (${strategist.score || 'N/A'}分) | ⚖️ 判官: ${auditor.decision}`);

            // 🚀 核心字串洗白：防止 " EXECUTE_BUY" 空格或換行報錯
            const cleanScout = (scout.decision || '').trim().toUpperCase();
            const cleanStrat = (strategist.decision || '').trim().toUpperCase();
            const cleanAudit = (auditor.decision || '').trim().toUpperCase();

            if (cleanAudit === 'VETO' || cleanAudit.includes('VETO')) return { buy: false, reason: `⚖️ 判官否決: ${auditor.reason}` };

            if (cleanScout.includes('PASS') && (cleanStrat.includes('PASS') || cleanStrat.includes('EXECUTE_BUY') || cleanStrat === 'BUY')) {
                return { buy: true, score: strategist.score || 80, reason: `⚡ ${scout.reason} | 🧠 ${strategist.reason}` };
            }
            return { buy: false, reason: "未達成共識" };
        });
    },

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
                token_symbol: marketData.symbol, 
                current_price: marketData.currentPrice,
                rsi_history: marketData.rsiHistory,
                tech_indicators: marketData.techIndicators,
                last_observed_time: marketData.lastTime,
                last_ai_comment: marketData.lastComment,
                latest_news_score: currentNewsScore 
            });
            
            const strategist = await callWithFallback('Strategist_Bluechip', {provider:'GOOGLE', model:'gemini-3.1-flash-lite-preview'}, {provider:'MISTRAL', model:'mistral-large-latest'}, pStrat);
            
            console.log(`🧠 老幣軍師: ${strategist.decision} | 理由: ${strategist.reason}`);
            
            // 🚀 核心字串洗白：完美對接 AI 指令，無視多餘空格
            const cleanDecision = (strategist.decision || '').trim().toUpperCase();

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