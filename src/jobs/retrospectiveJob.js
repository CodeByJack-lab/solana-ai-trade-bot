// src/jobs/retrospectiveJob.js
// 📝 檔案功能用途：總指揮覆盤日會。每日結算 24 小時 PnL 戰報發送 Telegram，並讓 AI 結合歷史記憶動態更新前線 Prompt。

const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const cron = require('node-cron');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { promptManager } = require('../services/promptManager');
const { sendTelegramAlert } = require('../services/telegramService'); // 👈 補回：Telegram 通知服務

const retrospectiveJob = {
    /**
     * 🧠 總指揮覆盤日會：結算昨日戰報、發送通知，並結合歷史記憶調整 Prompt
     */
    async runDailyBriefing() {
        console.log('\n👑 [Retrospective AI] 啟動總指揮日會：讀取昨日戰報與歷史記憶，結算 PnL 並重構劇本...');
        healthMonitor.setStatus('Retrospective_AI', '🟢 正在結算與重構劇本');

        try {
            const portfolio = getPortfolio();
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            // 1. 收集昨日戰報 (👈 補回：精確計算總利潤 realized_pnl_sol)
            const { data: trades, error: tradesErr } = await supabase
                .from(`trade_history_${tableSuffix}`)
                .select('realized_pnl_pct, realized_pnl_sol')
                .gte('created_at', oneDayAgo)
                .in('action', ['SELL', 'SELL_HALF']);
                
            if (tradesErr) throw tradesErr;

            let winCount = 0;
            let totalPnlSol = 0;
            
            if (trades && trades.length > 0) {
                trades.forEach(t => {
                    if (t.realized_pnl_pct > 0) winCount++;
                    totalPnlSol += (t.realized_pnl_sol || 0);
                });
            }
            
            const totalTrades = trades ? trades.length : 0;
            const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : 'N/A';

            // 2. 收集大市情緒
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            const newsScore = config?.latest_news_score || 50;

            // 3. 🧠 提取 AI 歷史記憶 (防幻覺機制)
            let lastAiMemory = "無昨日修改紀錄。";
            const { data: lastAudit } = await supabase.from('daily_audit_reports')
                .select('analysis_content')
                .ilike('analysis_content', '%總指揮日會戰術更新%')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(); 
            
            if (lastAudit && lastAudit.analysis_content) {
                lastAiMemory = lastAudit.analysis_content;
            }

            // 4. 獲取當前核心劇本
            const { data: currentPrompts } = await supabase.from('bot_prompts').select('*').in('prompt_id', ['trending_scout', 'meme_scout']);
            const currentTrendingScout = currentPrompts?.find(p => p.prompt_id === 'trending_scout')?.content || promptManager.fallbackPrompts['trending_scout'];
            const currentMemeScout = currentPrompts?.find(p => p.prompt_id === 'meme_scout')?.content || promptManager.fallbackPrompts['meme_scout'];

            // 5. 交由 Master AI 進行 Prompt Engineering (注入記憶)
            const prompt = `You are the HEAD OF TRADING (Prompt Engineer). 
Your job is to update the instructions (Prompts) given to your junior AI analysts (Scout) based on market conditions.

[Yesterday's Market State & Performance]
Total Trades: ${totalTrades}
Win Rate: ${winRate}%
Net PnL: ${totalPnlSol.toFixed(4)} SOL
Disaster Score (0-100, >60 is bad): ${newsScore}

[Your Memory: What you changed yesterday]
${lastAiMemory}
(Reflect on this: If win rate dropped or PnL is negative, maybe your previous changes were too loose or too strict.)

[Current Base Prompts]
Trending Scout: "${currentTrendingScout}"
Meme Scout: "${currentMemeScout}"

Task: Adjust the tactical rules in the prompts. Output a JSON with COMPLETELY REWRITTEN prompts (You MUST keep the exact Output JSON requirement at the end of each prompt):
{
  "new_trending_scout_prompt": "<string>",
  "new_meme_scout_prompt": "<string>",
  "briefing_notes": "<Cantonese summary explaining why you made these changes compared to yesterday, under 50 words>"
}`;

            const aiDecision = await aiOrchestrator.executeTask('MASTER_AI', 'GROQ', prompt, { bypassLimit: true });

            if (aiDecision && aiDecision.new_trending_scout_prompt && aiDecision.new_meme_scout_prompt) {
                console.log(`✅ [Retrospective AI] 劇本重構完畢！戰術指示: ${aiDecision.briefing_notes}`);

                await supabase.from('bot_prompts').upsert([
                    { prompt_id: 'trending_scout', content: aiDecision.new_trending_scout_prompt, updated_at: new Date().toISOString() },
                    { prompt_id: 'meme_scout', content: aiDecision.new_meme_scout_prompt, updated_at: new Date().toISOString() }
                ], { onConflict: 'prompt_id' });

                await supabase.from('daily_audit_reports').insert([{
                    analysis_content: `【總指揮日會戰術更新】\n勝率: ${winRate}% | 淨利潤: ${totalPnlSol.toFixed(4)} SOL | 災難指數: ${newsScore}\n戰術: ${aiDecision.briefing_notes}`,
                    prompt_changes: { trending: aiDecision.new_trending_scout_prompt, meme: aiDecision.new_meme_scout_prompt }
                }]);

                // 👈 修改：發送精美的 Telegram 每日戰報至公海 Channel，並自動置頂
                if (typeof sendTelegramAlert === 'function') {
                    const pnlTag = totalPnlSol >= 0 ? `🟢 +${totalPnlSol.toFixed(4)}` : `🔴 ${totalPnlSol.toFixed(4)}`;
                    const modeTag = portfolio.mode === 'LIVE' ? '🔴 [實盤]' : '🟢 [模擬]';
                    const reportMsg = `${modeTag} 📊 <b>每日戰報與戰術更新</b>\n\n` +
                                      `📅 <b>過去 24 小時結算</b>\n` +
                                      `🔄 總交易: ${totalTrades} 單\n` +
                                      `🏆 勝率: ${winRate}%\n` +
                                      `💰 淨利潤: ${pnlTag} SOL\n` +
                                      `🌍 災難指數: ${newsScore}/100\n\n` +
                                      `🤖 <b>AI 總指揮戰術調整</b>\n${aiDecision.briefing_notes}`;
                                      
                    // 傳入 true，觸發自動置頂 (Auto-pin)
                    await sendTelegramAlert(reportMsg, true);
                }

                healthMonitor.setStatus('Retrospective_AI', '🟢 結算完畢，劇本已更新');
            } else {
                throw new Error("AI 回傳 Prompt 格式不符");
            }

        } catch (err) {
            console.error(`❌ [Retrospective AI] 總指揮日會失敗:`, err.message);
            healthMonitor.setStatus('Retrospective_AI', `🔴 執行異常: ${err.message}`);
        }
    },

    start() {
        // 每日早上 8 點開會結算並調整 Prompt
        cron.schedule('0 8 * * *', () => { this.runDailyBriefing(); });
        console.log('🕒 [Retrospective AI] 總指揮覆盤日會排程已啟動 (排定於每日 08:00，發送戰報與重構劇本)');
    }
};

module.exports = { retrospectiveJob };