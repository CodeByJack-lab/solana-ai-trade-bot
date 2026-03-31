// src/jobs/retrospectiveJob.js
// 📝 檔案功能用途：總指揮覆盤日會。每日結算 24 小時 PnL 戰報，執行「敗局屍檢 (Losers Autopsy)」，並讓 AI 結合歷史記憶動態更新前線 Prompt。

const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const cron = require('node-cron');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { promptManager } = require('../services/promptManager');
const { sendStrategyAlert } = require('../services/telegramService');

const retrospectiveJob = {
    async runDailyBriefing() {
        console.log('\n👑 [Retrospective AI] 啟動總指揮日會：讀取昨日戰報與歷史記憶，結算 PnL 並重構劇本...');
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
                .in('action', ['SELL', 'SELL_HALF']);
                
            if (tradesErr) throw tradesErr;

            let winCount = 0;
            let totalPnlSol = 0;
            let losers = [];
            
            if (trades && trades.length > 0) {
                trades.forEach(t => {
                    if (t.realized_pnl_pct > 0) winCount++;
                    else if (t.realized_pnl_pct < 0) losers.push(t);
                    totalPnlSol += (t.realized_pnl_sol || 0);
                });
            }
            
            const totalTrades = trades ? trades.length : 0;
            const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : 'N/A';

            // 🚀 敗局屍檢 (Losers Autopsy)
            losers.sort((a, b) => a.realized_pnl_pct - b.realized_pnl_pct);
            const topLosers = losers.slice(0, 3);
            let autopsyReport = "昨日無重大虧損。";
            
            if (topLosers.length > 0) {
                autopsyReport = topLosers.map(l => 
                    `- Target: $${l.token_symbol} (${l.strategy_type})\n  Loss: ${l.realized_pnl_pct.toFixed(1)}%\n  Your Previous Buy Reason: "${l.ai_factcheck_result}"`
                ).join('\n\n');
            }

            // 2. 收集大市情緒
            const { data: config } = await supabase.from('system_config').select('latest_news_score').eq('id', 1).single();
            const newsScore = config?.latest_news_score || 50;

            // 3. 🧠 提取 AI 歷史記憶
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

            // 5. 交由 Master AI 進行 Prompt Engineering
            const prompt = `You are the HEAD OF TRADING (Prompt Engineer). 
Your job is to update the quantitative rules (Prompts) given to your junior AI analysts (Scout) based on yesterday's performance and autopsy of top losing trades.

[Yesterday's Market State & Performance]
Total Trades: ${totalTrades}
Win Rate: ${winRate}%
Net PnL: ${totalPnlSol.toFixed(4)} SOL
Disaster Score (0-100, >60 is bad): ${newsScore}

[Losers Autopsy: Analyze your mistakes!]
${autopsyReport}
(Reflect: Why did you buy these losers? Were your OFI/Liquidity/Volume filters too loose? Identify the DATA FEATURES of these traps.)

[Your Memory: What you changed yesterday]
${lastAiMemory}

[Current Base Prompts]
Trending Scout: "${currentTrendingScout}"
Meme Scout: "${currentMemeScout}"

Task: Adjust the tactical rules (e.g. OFI, AvgTrade limits) in the prompts to prevent repeating yesterday's mistakes. Output a JSON with COMPLETELY REWRITTEN prompts (You MUST keep the exact Output JSON requirement at the end of each prompt):
{
  "new_trending_scout_prompt": "<string>",
  "new_meme_scout_prompt": "<string>",
  "briefing_notes": "<Cantonese summary under 80 words explaining what data features you tightened based on the autopsy>"
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

                if (typeof sendStrategyAlert === 'function') {
                    const pnlTag = totalPnlSol >= 0 ? `🟢 +${totalPnlSol.toFixed(4)}` : `🔴 ${totalPnlSol.toFixed(4)}`;
                    const modeTag = portfolio.mode === 'LIVE' ? '🔴 [實盤]' : '🟢 [模擬]';
                    const reportMsg = `${modeTag} 📊 <b>每日戰報與戰術更新</b>\n\n` +
                                      `📅 <b>過去 24 小時結算</b>\n` +
                                      `🔄 總交易: ${totalTrades} 單\n` +
                                      `🏆 勝率: ${winRate}%\n` +
                                      `💰 淨利潤: ${pnlTag} SOL\n` +
                                      `🌍 災難指數: ${newsScore}/100\n\n` +
                                      `🤖 <b>AI 總指揮戰術調整 (結合敗局分析)</b>\n${aiDecision.briefing_notes}`;
                                      
                    await sendStrategyAlert(reportMsg, true);
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
        // 🚀 強制設定時區為香港時間 (Asia/Hong_Kong)，每日 09:00 執行
        cron.schedule('0 9 * * *', () => { 
            this.runDailyBriefing(); 
        }, {
            scheduled: true,
            timezone: "Asia/Hong_Kong"
        });
        console.log('🕒 [Retrospective AI] 總指揮覆盤日會排程已啟動 (排定於每日 09:00 HKT，發送戰報與重構劇本)');
    }
};

module.exports = { retrospectiveJob };