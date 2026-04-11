// src/jobs/retrospectiveJob.js
// 📝 檔案功能用途：V10 總指揮日會。專注每日覆盤並自動升級【前線買入 Scout】的劇本。
// 🚀 升級功能：適配 Provider 專屬排隊引擎，強制呼叫 GEMINI 進行複雜邏輯運算。

const { supabase } = require('../config/supabase');
const { keyRotator } = require('../services/keyRotator'); 
const axios = require('axios'); 
const cron = require('node-cron');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { cacheManager } = require('../services/cacheManager'); // 🚨 FIX: 轉用 V10 cacheManager
const { sendStrategyAlert } = require('../services/telegramService');

const retrospectiveJob = {
    async runDailyBriefing() {
        console.log('\n👑 [Retrospective AI] 啟動總指揮日會：同步 DB 劇本並進行敗局檢閱...');
        healthMonitor.setStatus('Retrospective_AI', '🟢 正在結算與重構劇本');

        try {
            const portfolio = getPortfolio();
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            const { data: trades, error: tradesErr } = await supabase
                .from(`trade_history_${tableSuffix}`)
                .select('realized_pnl_pct, realized_pnl_sol, token_symbol, strategy_type, ai_factcheck_result')
                .gte('created_at', oneDayAgo)
                .in('action', ['SELL', 'SELL_HALF', 'LIQUIDATED']);
                
            if (tradesErr) throw tradesErr;

            let winCount = 0, totalPnlSol = 0, losers = [];
            if (trades && trades.length > 0) {
                trades.forEach(t => {
                    if (t.realized_pnl_pct > 0) winCount++;
                    else if (t.realized_pnl_pct < 0) losers.push(t);
                    totalPnlSol += (t.realized_pnl_sol || 0);
                });
            }
            
            const totalTrades = trades?.length || 0;
            const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '0.0';

            losers.sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct);
            const autopsyReport = losers.slice(0, 3).map(l => {
                const safeReason = String(l.ai_factcheck_result || 'N/A').replace(/[\r\n"']/g, ' ').substring(0, 100);
                return `-${l.token_symbol}: Loss ${l.realized_pnl_pct.toFixed(1)}% | Reason: ${safeReason}`;
            }).join('; ') || "No losses yesterday.";

            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            const { data: lastAudit } = await supabase.from('daily_audit_reports').select('analysis_content').order('created_at', { ascending: false }).limit(1).maybeSingle();
            
            let safeMemory = lastAudit && lastAudit.analysis_content ? String(lastAudit.analysis_content).replace(/[\r\n"']/g, ' ').substring(0, 200) : "No previous memory.";

            // 讀取當前 Meme 與 Trending Scout
            const { data: promptsData } = await supabase.from('bot_prompts').select('prompt_id, content').in('prompt_id', ['meme_scout', 'trending_scout']);
            let currentMemeScout = "N/A";
            let currentTrendingScout = "N/A";
            if (promptsData) {
                const ms = promptsData.find(p => p.prompt_id === 'meme_scout');
                const ts = promptsData.find(p => p.prompt_id === 'trending_scout');
                if (ms) currentMemeScout = ms.content.replace(/[\r\n]/g, ' ');
                if (ts) currentTrendingScout = ts.content.replace(/[\r\n]/g, ' ');
            }

            // 🚨 FIX: 使用 cacheManager
            const promptConfig = cacheManager.getPromptConfig('master_retrospective', {
                totalTrades, winRate, totalPnlSol: totalPnlSol.toFixed(4), newsScore: config?.latest_news_score || 50, 
                autopsyReport, lastAiMemory: safeMemory, 
                currentMemeScout, currentTrendingScout 
            });
            
            const parsedPrompt = promptConfig?.parsedPrompt;
            const targetProvider = promptConfig?.provider || 'GEMINI';
            
            if (!parsedPrompt) throw new Error("無法生成 parsedPrompt");

            const aiDecision = await keyRotator.enqueueRequest(targetProvider, async (apiKey) => {
                const modelToUse = promptConfig.models[0] || 'gemini-2.5-flash'; 
                let apiUrl, payload, headers;

                if (targetProvider === 'GEMINI' || apiKey.startsWith('AIza')) {
                    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
                    payload = { contents: [{ parts: [{ text: parsedPrompt }] }], generationConfig: { response_mime_type: "application/json" } };
                    headers = { 'Content-Type': 'application/json' };
                } else {
                    const isGroq = apiKey.startsWith('gsk_');
                    apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                    payload = { model: modelToUse, messages: [{ role: "user", content: parsedPrompt }], response_format: { type: "json_object" } };
                    headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
                }

                const res = await axios.post(apiUrl, payload, { headers, timeout: 60000 });
                return JSON.parse(targetProvider === 'GEMINI' || apiKey.startsWith('AIza') ? res.data.candidates[0].content.parts[0].text : res.data.choices[0].message.content);
            });

            if (aiDecision && aiDecision.new_meme_scout_prompt && aiDecision.new_trending_scout_prompt) {
                // 更新兩個 Scout 的劇本
                await supabase.from('bot_prompts').upsert([
                    { prompt_id: 'meme_scout', content: aiDecision.new_meme_scout_prompt, updated_at: new Date().toISOString() },
                    { prompt_id: 'trending_scout', content: aiDecision.new_trending_scout_prompt, updated_at: new Date().toISOString() }
                ], { onConflict: 'prompt_id' });

                await supabase.from('daily_audit_reports').insert([{ 
                    analysis_content: `【總指揮日會】勝率: ${winRate}% | 淨利潤: ${totalPnlSol.toFixed(4)} SOL\n戰術: ${aiDecision.briefing_notes}`, 
                    prompt_changes: { meme_scout: aiDecision.new_meme_scout_prompt, trending_scout: aiDecision.new_trending_scout_prompt } 
                }]);
                
                if (typeof sendStrategyAlert === 'function') {
                    const pnlTag = totalPnlSol >= 0 ? `🟢 +${totalPnlSol.toFixed(4)}` : `🔴 ${totalPnlSol.toFixed(4)}`;
                    const modeTag = portfolio.mode === 'LIVE' ? '🔴 [實盤]' : '🟢 [模擬]';
                    const reportMsg = `${modeTag} 📊 <b>每日戰報與戰術更新</b>\n\n📅 <b>過去 24 小時結算</b>\n🔄 總交易: ${totalTrades} 單\n🏆 勝率: ${winRate}%\n💰 淨利潤: ${pnlTag} SOL\n\n🤖 <b>AI 總指揮戰術調整 (Scouts 升級)</b>\n${aiDecision.briefing_notes}`;
                    sendStrategyAlert(reportMsg, true).catch(e => {});
                }
                healthMonitor.setStatus('Retrospective_AI', '🟢 結算完畢，Scout 劇本已熱更新');
            }
        } catch (err) {
            healthMonitor.setStatus('Retrospective_AI', `🔴 執行異常: ${err.message}`);
        }
    },
    start() {
        cron.schedule('0 9 * * *', () => { this.runDailyBriefing(); }, { scheduled: true, timezone: "Asia/Hong_Kong" });
    }
};
module.exports = { retrospectiveJob };