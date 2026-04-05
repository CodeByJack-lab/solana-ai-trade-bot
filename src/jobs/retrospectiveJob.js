// src/jobs/retrospectiveJob.js
// 📝 檔案功能用途：V9.3 終極進化版總指揮日會。劇本已全數移至 Supabase 實現熱更新，完美適配 Gemini 2.5 Flash 超大上下文視窗防 400 爆機，並內建原生 JSON 輸出。

const { supabase } = require('../config/supabase');
const { keyRotator } = require('../services/keyRotator'); 
const axios = require('axios'); 
const cron = require('node-cron');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { promptManager } = require('../services/promptManager'); // 👈 引入全域劇本管理器
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

            // 🚀 敗局屍檢 (截斷防護：每單最多 150 字，最多攞 3 單，徹底杜絕 400 Context Overflow)
            losers.sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct);
            const autopsyReport = losers.slice(0, 3).map(l => {
                const safeReason = String(l.ai_factcheck_result || 'N/A').substring(0, 150).replace(/[\r\n]+/g, ' ');
                return `-$${l.token_symbol}: Loss ${l.realized_pnl_pct.toFixed(1)}% | Prior Reason: ${safeReason}`;
            }).join('\n') || "昨日無虧損。";

            // 2. 獲取大市數據與歷史記憶
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            const { data: lastAudit } = await supabase.from('daily_audit_reports')
                .select('analysis_content').ilike('analysis_content', '%總指揮日會戰術更新%')
                .order('created_at', { ascending: false }).limit(1).maybeSingle();

            // 3. 獲取現有劇本內容 (準備餵給 Master AI 進行重構)
            const { data: currentPrompts } = await supabase.from('bot_prompts').select('prompt_id, content').in('prompt_id', ['trending_scout', 'meme_scout']);
            
            // 4. 🎯 核心：調用 promptManager 組合 Master 劇本 (替換 {{variable}})
            const { provider, models, parsedPrompt } = promptManager.getPromptConfig('master_retrospective', {
                totalTrades: totalTrades,
                winRate: winRate,
                totalPnlSol: totalPnlSol.toFixed(4),
                newsScore: config?.latest_news_score || 50,
                autopsyReport: autopsyReport,
                lastAiMemory: lastAudit?.analysis_content || "無昨日修改紀錄。",
                currentTrendingScout: currentPrompts?.find(p => p.prompt_id === 'trending_scout')?.content || "N/A",
                currentMemeScout: currentPrompts?.find(p => p.prompt_id === 'meme_scout')?.content || "N/A"
            });

            // 5. 透過資源池發送至 AI (完美支援 Gemini Native JSON 輸出)
            const aiDecision = await keyRotator.enqueueRequest(async (apiKey) => {
                const isGemini = apiKey.startsWith('AIza') || provider === 'GEMINI';
                const modelToUse = models[0] || 'gemini-2.5-flash'; // 預設使用你設定的 Gemini 2.5 Flash

                let apiUrl, payload, headers;

                if (isGemini) {
                    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
                    payload = {
                        contents: [{ parts: [{ text: parsedPrompt }] }],
                        generationConfig: { response_mime_type: "application/json" } // 🛡️ Gemini 專屬：強制完美 JSON
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

                // ⏱️ 將 Timeout 延長至 60 秒，畀充足時間大模型去思考同重構劇本
                const res = await axios.post(apiUrl, payload, { headers, timeout: 60000 });
                
                return isGemini 
                    ? JSON.parse(res.data.candidates[0].content.parts[0].text) 
                    : JSON.parse(res.data.choices[0].message.content);
            });

            // 6. 寫入 DB 並發送 Telegram
            if (aiDecision && aiDecision.new_trending_scout_prompt && aiDecision.new_meme_scout_prompt) {
                console.log(`✅ [Retrospective AI] 劇本進化成功！戰術總結: ${aiDecision.briefing_notes}`);
                
                // 熱更新前線劇本
                await supabase.from('bot_prompts').upsert([
                    { prompt_id: 'trending_scout', content: aiDecision.new_trending_scout_prompt, updated_at: new Date().toISOString() },
                    { prompt_id: 'meme_scout', content: aiDecision.new_meme_scout_prompt, updated_at: new Date().toISOString() }
                ], { onConflict: 'prompt_id' });

                // 寫入稽核紀錄
                await supabase.from('daily_audit_reports').insert([{
                    analysis_content: `【總指揮日會戰術更新】\n勝率: ${winRate}% | 淨利潤: ${totalPnlSol.toFixed(4)} SOL\n戰術: ${aiDecision.briefing_notes}`,
                    prompt_changes: { trending: aiDecision.new_trending_scout_prompt, meme: aiDecision.new_meme_scout_prompt }
                }]);

                if (typeof sendStrategyAlert === 'function') {
                    const pnlTag = totalPnlSol >= 0 ? `🟢 +${totalPnlSol.toFixed(4)}` : `🔴 ${totalPnlSol.toFixed(4)}`;
                    const modeTag = portfolio.mode === 'LIVE' ? '🔴 [實盤]' : '🟢 [模擬]';
                    const reportMsg = `${modeTag} 📊 <b>每日戰報與戰術更新</b>\n\n` +
                                      `📅 <b>過去 24 小時結算</b>\n` +
                                      `🔄 總交易: ${totalTrades} 單\n` +
                                      `🏆 勝率: ${winRate}%\n` +
                                      `💰 淨利潤: ${pnlTag} SOL\n\n` +
                                      `🤖 <b>AI 總指揮戰術調整</b>\n${aiDecision.briefing_notes}`;
                                      
                    await sendStrategyAlert(reportMsg, true);
                }
                healthMonitor.setStatus('Retrospective_AI', '🟢 結算完畢，劇本已熱更新');
            } else {
                throw new Error("AI 回傳的 JSON 缺少必要的 Prompt 欄位");
            }
        } catch (err) {
            console.error(`❌ [Retrospective AI] 失敗:`, err.message);
            healthMonitor.setStatus('Retrospective_AI', `🔴 執行異常: ${err.message}`);
        }
    },

    start() {
        // 每日早上 9 點準時進行大腦重構
        cron.schedule('0 9 * * *', () => { this.runDailyBriefing(); }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        console.log('🕒 [Retrospective AI] 總指揮覆盤排程啟動 (每日 09:00 HKT，已接駁 DB 全域大腦)');
    }
};

module.exports = { retrospectiveJob };
