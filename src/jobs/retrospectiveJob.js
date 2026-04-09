// src/jobs/retrospectiveJob.js
// 📝 檔案功能用途：V9.5 終極進化版總指揮日會。專注每日覆盤並自動升級【唯一買入把關 AI - quant_consensus】的劇本。

const { supabase } = require('../config/supabase');
const { keyRotator } = require('../services/keyRotator'); 
const axios = require('axios'); 
const cron = require('node-cron');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { promptManager } = require('../services/promptManager'); 
const { sendStrategyAlert } = require('../services/telegramService');

const retrospectiveJob = {
    async runDailyBriefing() {
        console.log('\n👑 [Retrospective AI] 啟動總指揮日會：同步 DB 劇本並進行敗局檢閱...');
        healthMonitor.setStatus('Retrospective_AI', '🟢 正在結算與重構劇本');

        try {
            const portfolio = getPortfolio();
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            // 1. 收集昨日戰報
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

            // 🚀 敗局屍檢
            losers.sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct);
            const autopsyReport = losers.slice(0, 3).map(l => {
                const safeReason = String(l.ai_factcheck_result || 'N/A').replace(/[\r\n"']/g, ' ').substring(0, 100);
                return `-${l.token_symbol}: Loss ${l.realized_pnl_pct.toFixed(1)}% | Reason: ${safeReason}`;
            }).join('; ') || "No losses yesterday.";

            // 2. 獲取大市數據與歷史記憶
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            
            const { data: lastAudit } = await supabase.from('daily_audit_reports')
                .select('analysis_content')
                .order('created_at', { ascending: false }).limit(1).maybeSingle();
            
            let safeMemory = "No previous memory.";
            if (lastAudit && lastAudit.analysis_content) {
                safeMemory = String(lastAudit.analysis_content).replace(/[\r\n"']/g, ' ').substring(0, 200);
            }

            // 3. 獲取現有 quant_consensus 劇本內容
            const { data: currentPrompts } = await supabase.from('bot_prompts').select('prompt_id, content').eq('prompt_id', 'quant_consensus').single();
            const safeQuantConsensus = currentPrompts?.content.replace(/[\r\n]/g, ' ') || "N/A";

            // 4. 組合 Master 劇本
            const promptConfig = promptManager.getPromptConfig('master_retrospective', {
                totalTrades: totalTrades,
                winRate: winRate,
                totalPnlSol: totalPnlSol.toFixed(4),
                newsScore: config?.latest_news_score || 50,
                autopsyReport: autopsyReport,
                lastAiMemory: safeMemory,
                currentQuantConsensus: safeQuantConsensus 
            });
            
            const provider = promptConfig?.provider || 'GEMINI';
            const models = promptConfig?.models || ['gemini-2.5-flash'];
            const parsedPrompt = promptConfig?.parsedPrompt;

            if (!parsedPrompt) {
                throw new Error("無法生成 parsedPrompt，請檢查 bot_prompts 表中是否有 master_retrospective");
            }

            // 5. 透過資源池發送至 AI
            const aiDecision = await keyRotator.enqueueRequest(async (apiKey) => {
                const isGemini = apiKey.startsWith('AIza') || provider === 'GEMINI';
                const modelToUse = models[0] || 'gemini-2.5-flash'; 

                let apiUrl, payload, headers;

                if (isGemini) {
                    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
                    payload = {
                        contents: [{ parts: [{ text: parsedPrompt }] }],
                        generationConfig: { response_mime_type: "application/json" } 
                    };
                    headers = { 'Content-Type': 'application/json' };
                } else {
                    const isGroq = apiKey.startsWith('gsk_');
                    apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                    payload = {
                        model: modelToUse,
                        messages: [{ role: "user", content: parsedPrompt }],
                        response_format: { type: "json_object" }
                    };
                    headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
                }

                try {
                    const res = await axios.post(apiUrl, payload, { headers, timeout: 60000 });
                    const responseText = isGemini 
                        ? res.data.candidates[0].content.parts[0].text 
                        : res.data.choices[0].message.content;
                        
                    return JSON.parse(responseText);
                } catch (apiErr) {
                    const statusCode = apiErr.response?.status;
                    const errorDetails = apiErr.response?.data ? JSON.stringify(apiErr.response.data) : apiErr.message;
                    console.error(`❌ [AI API Error] HTTP ${statusCode}: ${errorDetails}`);
                    throw new Error(`API 請求失敗 (${statusCode})`);
                }
            });

            // 6. 將 AI 產生的高階劇本寫回 quant_consensus
            if (aiDecision && aiDecision.new_quant_consensus_prompt) {
                console.log(`✅ [Retrospective AI] 劇本進化成功！戰術總結: ${aiDecision.briefing_notes}`);
                
                await supabase.from('bot_prompts').upsert([
                    { prompt_id: 'quant_consensus', content: aiDecision.new_quant_consensus_prompt, updated_at: new Date().toISOString() }
                ], { onConflict: 'prompt_id' });

                await supabase.from('daily_audit_reports').insert([{
                    analysis_content: `【總指揮日會戰術更新】\n勝率: ${winRate}% | 淨利潤: ${totalPnlSol.toFixed(4)} SOL\n戰術: ${aiDecision.briefing_notes}`,
                    prompt_changes: { quant_consensus: aiDecision.new_quant_consensus_prompt }
                }]);

                if (typeof sendStrategyAlert === 'function') {
                    const pnlTag = totalPnlSol >= 0 ? `🟢 +${totalPnlSol.toFixed(4)}` : `🔴 ${totalPnlSol.toFixed(4)}`;
                    const modeTag = portfolio.mode === 'LIVE' ? '🔴 [實盤]' : '🟢 [模擬]';
                    const reportMsg = `${modeTag} 📊 <b>每日戰報與戰術更新</b>\n\n` +
                                      `📅 <b>過去 24 小時結算</b>\n` +
                                      `🔄 總交易: ${totalTrades} 單\n` +
                                      `🏆 勝率: ${winRate}%\n` +
                                      `💰 淨利潤: ${pnlTag} SOL\n\n` +
                                      `🤖 <b>AI 總指揮戰術調整 (Quant Consensus 升級)</b>\n${aiDecision.briefing_notes}`;
                                      
                    sendStrategyAlert(reportMsg, true).catch(e => console.log('Telegram send error ignored.'));
                }
                healthMonitor.setStatus('Retrospective_AI', '🟢 結算完畢，劇本已熱更新');
            } else {
                throw new Error("AI 回傳的 JSON 格式不正確或缺少欄位");
            }
        } catch (err) {
            console.error(`❌ [Retrospective AI] 系統異常:`, err.message);
            healthMonitor.setStatus('Retrospective_AI', `🔴 執行異常: ${err.message}`);
        }
    },

    start() {
        cron.schedule('0 9 * * *', () => { this.runDailyBriefing(); }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        console.log('🕒 [Retrospective AI] 總指揮覆盤排程啟動 (每日 09:00 HKT，專注優化 quant_consensus 大腦)');
    }
};

// 🚨 極度重要：千萬不要漏掉這一行！
module.exports = { retrospectiveJob };