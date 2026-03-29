// src/jobs/weeklyBacktestJob.js
const cron = require('node-cron');
const { supabase } = require('../config/supabase');
const { aiOrchestrator } = require('../services/aiOrchestrator');
const { sendApprovalRequest, sendAdminAlert } = require('../services/telegramService');
const { healthMonitor } = require('../services/healthMonitor');

async function runGridSearch(trades, categoryName) {
    if (!trades || trades.length < 3) {
        console.log(`ℹ️ [Backtest] ${categoryName} 樣本過少 (${trades?.length || 0} 宗)，跳過運算。`);
        return null;
    }

    const currentTotalPnl = trades.reduce((sum, t) => sum + (t.realized_pnl_pct || 0), 0);
    const simData = trades.map(t => ({
        actual_pnl: t.realized_pnl_pct || 0,
        max_pnl: t.realized_pnl_pct > 0 ? t.realized_pnl_pct : 0
    }));

    console.log(`🧮 [Backtest] 正在對 ${categoryName} (${simData.length} 宗) 進行網格運算...`);

    let bestCombo = null;
    let bestPnl = -999999;
    let comboCount = 0;

    for (let sl = 10; sl <= 30; sl += 1) {
        for (let tp = 50; tp <= 200; tp += 10) {
            for (let pb = 20; pb <= 50; pb += 1) {
                let simTotalPnl = 0;
                for (const trade of simData) {
                    if (trade.max_pnl >= tp) {
                        simTotalPnl += (trade.max_pnl - pb);
                    } else if (trade.actual_pnl < 0) {
                        simTotalPnl += (trade.actual_pnl <= -sl ? -sl : trade.actual_pnl);
                    } else {
                        simTotalPnl += trade.actual_pnl;
                    }
                }

                if (simTotalPnl > bestPnl) {
                    bestPnl = simTotalPnl;
                    bestCombo = { sl: -sl, tp_trigger: tp, pullback: pb };
                }

                comboCount++;
                if (comboCount % 500 === 0) await new Promise(r => setTimeout(r, 5));
            }
        }
    }
    
    if (bestPnl > currentTotalPnl + 5) {
        return { bestCombo, bestPnl, currentTotalPnl, count: trades.length };
    }
    return null; 
}

const weeklyBacktestJob = {
    async runBacktest() {
        console.log(`\n🔬 [Backtest] 啟動每週雙軌高精度網格回測引擎...`);
        healthMonitor.setStatus('Macro_Radar', '🟢 雙軌回測運算中'); 

        try {
            const { data: config } = await supabase.from('system_config').select('trade_mode').eq('id', 1).single();
            const tradeMode = config?.trade_mode || 'PAPER';
            const tableName = `trade_history_${tradeMode.toLowerCase()}`;
            
            console.log(`📡 [Backtest] 當前系統模式為 ${tradeMode}，正在讀取 ${tableName} 數據...`);

            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: allTrades, error } = await supabase
                .from(tableName)
                .select('*')
                .gte('created_at', sevenDaysAgo)
                .in('action', ['SELL', 'SELL_HALF', 'FORCE_WRITE_OFF']);

            if (error) throw error;

            const memeTrades = allTrades.filter(t => t.strategy_type && t.strategy_type.includes('MEME'));
            const trendTrades = allTrades.filter(t => t.strategy_type && t.strategy_type.includes('TRENDING'));

            const memeResult = await runGridSearch(memeTrades, "🐣 NEW meme");
            const trendResult = await runGridSearch(trendTrades, "🔥 TOP 100 meme");

            if (!memeResult && !trendResult) {
                console.log(`ℹ️ [Backtest] 運算完成。目前雙軌參數均處於最佳狀態，無需發送提案。`);
                await sendAdminAlert(`📊 <b>[每週數據回測]</b>\n運算完成。NEW meme 與 TOP 100 meme 策略之表現皆已達最佳化區間，本週無需調整參數！`);
                return;
            }

            let promptContext = "I ran dual-core matrix backtests for our crypto trading bot. Here are the optimized findings:\n\n";
            let proposedChanges = {};
            let tgDisplayParams = "";

            if (memeResult) {
                promptContext += `[MEME Strategy (High Risk)]: Over ${memeResult.count} trades, Current PnL: ${memeResult.currentTotalPnl.toFixed(2)}%. Optimized PnL: ${memeResult.bestPnl.toFixed(2)}% using StopLoss: ${memeResult.bestCombo.sl}%, TakeProfit Trigger: +${memeResult.bestCombo.tp_trigger}%, Pullback: ${memeResult.bestCombo.pullback} pts.\n`;
                proposedChanges.meme_params = {
                    stop_loss_pct: -Math.abs(memeResult.bestCombo.sl),
                    trailing_tp_trigger: memeResult.bestCombo.tp_trigger,
                    trailing_pullback: memeResult.bestCombo.pullback
                };
                tgDisplayParams += `\n🐣 <b>NEW meme 建議參數修改：</b>\n止損 (SL): <code>-${memeResult.bestCombo.sl}%</code> | 追蹤啟動: <code>+${memeResult.bestCombo.tp_trigger}%</code> | 回撤容忍: <code>${memeResult.bestCombo.pullback}點</code>\n`;
            }

            if (trendResult) {
                promptContext += `[TRENDING Strategy (Mid Risk)]: Over ${trendResult.count} trades, Current PnL: ${trendResult.currentTotalPnl.toFixed(2)}%. Optimized PnL: ${trendResult.bestPnl.toFixed(2)}% using StopLoss: ${trendResult.bestCombo.sl}%, TakeProfit Trigger: +${trendResult.bestCombo.tp_trigger}%, Pullback: ${trendResult.bestCombo.pullback} pts.\n`;
                proposedChanges.trending_params = {
                    stop_loss_pct: -Math.abs(trendResult.bestCombo.sl),
                    trailing_tp_trigger: trendResult.bestCombo.tp_trigger,
                    trailing_pullback: trendResult.bestCombo.pullback
                };
                tgDisplayParams += `\n🔥 <b>TOP 100 meme 建議參數修改：</b>\n止損 (SL): <code>-${trendResult.bestCombo.sl}%</code> | 追蹤啟動: <code>+${trendResult.bestCombo.tp_trigger}%</code> | 回撤容忍: <code>${trendResult.bestCombo.pullback}點</code>\n`;
            }

            console.log(`🧠 [Backtest] 召喚首席精算師 (BOARD_OF_DIRECTORS) 翻譯雙軌報告...`);
            
            // 🌟 核心修改：從 bot_prompts 資料表讀取 AI 指令
            const { data: promptData, error: promptErr } = await supabase
                .from('bot_prompts')
                .select('content')
                .eq('prompt_id', 'backtest_analyst')
                .single();

            if (promptErr || !promptData) {
                throw new Error(`無法從 bot_prompts 讀取 backtest_analyst 劇本: ${promptErr?.message}`);
            }

            // 將跑出嚟嘅結果 Inject 入去 Prompt
            const finalAiPrompt = promptData.content.replace('{{promptContext}}', promptContext);

            // 呼叫 BOARD_OF_DIRECTORS 角色
            const aiResult = await aiOrchestrator.executeTask('BOARD_OF_DIRECTORS', 'GEMINI', finalAiPrompt, { bypassLimit: true });

            if (aiResult && aiResult.report) {
                const { data: insertedProposal, error: insertErr } = await supabase.from('ai_proposals').insert([{
                    proposal_type: 'BACKTEST',
                    report_content: aiResult.report,
                    proposed_changes: proposedChanges,
                    status: 'PENDING' 
                }]).select().single();

                if (insertErr) throw new Error(`寫入提案失敗: ${insertErr.message}`);

                const tgMsg = `📊 <b>[每週雙軌回測引擎報告]</b>\n\n${aiResult.report}\n${tgDisplayParams}\n請在下方選擇是否套用此雙軌最佳化參數：`;
                await sendApprovalRequest(tgMsg, insertedProposal.id);
            }

        } catch (err) {
            console.error(`❌ [Backtest Error] 執行發生異常:`, err.message);
        } finally {
            healthMonitor.setStatus('Macro_Radar', '🟢 守衛中'); 
        }
    },

    start() {
        cron.schedule('0 9 * * 1', () => { 
            this.runBacktest(); 
        }, { scheduled: true, timezone: "Asia/Hong_Kong" });
        console.log(`🧮 [Backtest] 雙軌高精度回測排程已啟動 (每週一 09:00 執行)...`);
    }
};

module.exports = { weeklyBacktestJob };