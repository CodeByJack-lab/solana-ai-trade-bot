// src/jobs/weeklyBacktestJob.js
// 📝 檔案功能用途：雙軌高精度回測引擎。極限壓榨 Node.js 算力，實裝 1355 組兩階段無縫網格。計算完畢後生成 BACKTEST 提案，交由 autoApplyJob 進行 60 分鐘審批倒數。

const { supabase } = require('../config/supabase');
const { keyRotator } = require('../services/keyRotator');
const cron = require('node-cron');
const axios = require('axios');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { sendTelegramAlert } = require('../services/telegramService');

const weeklyBacktestJob = {
    /**
     * 📏 第一階段：粗網格生成器 (撒大網 - 750 組組合)
     */
    generateCoarseGrid(trades, isMeme) {
        const losses = trades.map(t => t.realized_pnl_pct).filter(p => p < 0);
        const peakGains = trades.map(t => {
            if (t.highest_price_sol && t.entry_price_sol) {
                return ((t.highest_price_sol - t.entry_price_sol) / t.entry_price_sol) * 100;
            }
            return 0;
        }).filter(p => p > 0);

        const defaultWorstLoss = isMeme ? -80 : -30;
        const defaultBestLoss = isMeme ? -15 : -5;
        const defaultMaxGain = isMeme ? 200 : 50;
        const defaultMinGain = isMeme ? 30 : 15;

        let worstLoss = losses.length > 0 ? Math.min(...losses) : defaultWorstLoss;
        let bestLoss = losses.length > 0 ? Math.max(...losses) : defaultBestLoss;
        let maxGain = peakGains.length > 0 ? Math.max(...peakGains) : defaultMaxGain;
        let minGain = peakGains.length > 0 ? Math.min(...peakGains) : defaultMinGain;

        if (worstLoss === bestLoss) worstLoss = bestLoss - 10;
        if (maxGain === minGain) maxGain = minGain + 20;

        const minPb = isMeme ? 15 : 5;
        const maxPb = isMeme ? 50 : 20;

        const createSteps = (min, max, steps) => {
            const stepSize = (max - min) / (steps - 1);
            return {
                values: Array.from({length: steps}, (_, i) => parseFloat((min + (stepSize * i)).toFixed(2))),
                stepSize: stepSize 
            };
        };

        const slData = createSteps(worstLoss, bestLoss, 10); 
        const tpData = createSteps(minGain, maxGain, 15);  
        const pbData = createSteps(minPb, maxPb, 5);       

        return {
            stopLoss: slData.values, 
            tpTrigger: tpData.values,   
            pullback: pbData.values,
            meta: { slStep: slData.stepSize, tpStep: tpData.stepSize, pbStep: pbData.stepSize }
        };
    },

    /**
     * 🎯 第二階段：精細網格生成器 (狙擊鏡 - 605 組組合)
     */
    generateFineGrid(bestCoarse, coarseMeta) {
        const createFineSteps = (center, coarseStep, steps) => {
            const min = center - coarseStep;
            const max = center + coarseStep;
            const fineStepSize = (max - min) / (steps - 1);
            return Array.from({length: steps}, (_, i) => parseFloat((min + (fineStepSize * i)).toFixed(2)));
        };

        return {
            stopLoss: createFineSteps(bestCoarse.stop_loss_pct, coarseMeta.slStep, 11).filter(x => x < -1), 
            tpTrigger: createFineSteps(bestCoarse.trailing_tp_trigger, coarseMeta.tpStep, 11).filter(x => x > 5), 
            pullback: createFineSteps(bestCoarse.trailing_pullback, coarseMeta.pbStep, 5).filter(x => x >= 2)
        };
    },

    /**
     * 🧮 歷史重演模擬器
     */
    simulateGridSearch(trades, grid) {
        let bestParams = null;
        let maxNetPnl = -Infinity;
        let bestWinRate = 0;

        for (let slIdx = 0; slIdx < grid.stopLoss.length; slIdx++) {
            const sl = grid.stopLoss[slIdx];
            for (let tpIdx = 0; tpIdx < grid.tpTrigger.length; tpIdx++) {
                const tp = grid.tpTrigger[tpIdx];
                for (let pbIdx = 0; pbIdx < grid.pullback.length; pbIdx++) {
                    const pb = grid.pullback[pbIdx];
                    
                    let simulatedPnl = 0;
                    let wins = 0;
                    let totalValid = 0;

                    for (let i = 0; i < trades.length; i++) {
                        const t = trades[i];
                        if (!t.entry_price_sol || !t.highest_price_sol || !t.quantity) continue;
                        totalValid++;

                        const maxGainPct = ((t.highest_price_sol - t.entry_price_sol) / t.entry_price_sol) * 100;
                        const actualPnlPct = t.realized_pnl_pct || 0;

                        let simTradePnlPct = actualPnlPct;

                        if (maxGainPct >= tp) {
                            simTradePnlPct = tp - pb; 
                        } else if (actualPnlPct <= sl) {
                            simTradePnlPct = sl; 
                        }

                        if (simTradePnlPct > 0) wins++;
                        simulatedPnl += (simTradePnlPct / 100) * t.total_value_sol; 
                    }

                    if (totalValid > 0 && simulatedPnl > maxNetPnl) {
                        maxNetPnl = simulatedPnl;
                        bestWinRate = (wins / totalValid) * 100;
                        bestParams = { 
                            stop_loss_pct: parseFloat(sl.toFixed(2)), 
                            trailing_tp_trigger: parseFloat(tp.toFixed(2)), 
                            trailing_pullback: parseFloat(pb.toFixed(2)), 
                            net_pnl_sol: simulatedPnl, 
                            win_rate: bestWinRate 
                        };
                    }
                }
            }
        }
        return bestParams;
    },

    /**
     * 🚀 執行兩階段高精度雙軌回測主程序
     */
    async runBacktest() {
        console.log('\n🧬 [Evolution Engine] 啟動雙軌【1355組 兩階段高精度回測】與參數結算...');
        healthMonitor.setStatus('Evolution_Engine', '🟢 正在進行回測計算');

        try {
            const portfolio = getPortfolio();
            const tableSuffix = portfolio.mode === 'LIVE' ? 'live' : 'paper';
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

            const { data: trades, error: fetchErr } = await supabase
                .from(`trade_history_${tableSuffix}`)
                .select('*')
                .gte('created_at', sevenDaysAgo)
                .in('action', ['SELL', 'SELL_HALF']);

            if (fetchErr) throw fetchErr;

            if (!trades || trades.length < 5) {
                console.log('📉 [Evolution Engine] 過去 7 天交易樣本不足 (< 5 單)，維持現有參數。');
                healthMonitor.setStatus('Evolution_Engine', '🟡 樣本不足跳過');
                return;
            }

            const memeTrades = trades.filter(t => t.strategy_type && t.strategy_type.includes('MEME'));
            const trendingTrades = trades.filter(t => t.strategy_type && t.strategy_type.includes('TRENDING'));

            console.log(`📊 歷史數據分流: Meme 策略 ${memeTrades.length} 單 | Trending 策略 ${trendingTrades.length} 單`);

            // 1. 階段 1：粗網格搜索
            const memeCoarseGrid = this.generateCoarseGrid(memeTrades, true);
            const trendingCoarseGrid = this.generateCoarseGrid(trendingTrades, false);

            const bestMemeCoarse = memeTrades.length >= 3 ? this.simulateGridSearch(memeTrades, memeCoarseGrid) : null;
            const bestTrendingCoarse = trendingTrades.length >= 3 ? this.simulateGridSearch(trendingTrades, trendingCoarseGrid) : null;

            // 2. 階段 2：精細微調搜索
            let finalBestMeme = bestMemeCoarse;
            if (bestMemeCoarse) {
                const memeFineGrid = this.generateFineGrid(bestMemeCoarse, memeCoarseGrid.meta);
                finalBestMeme = this.simulateGridSearch(memeTrades, memeFineGrid);
                console.log(`🎯 Meme 極限微調完畢: SL ${finalBestMeme.stop_loss_pct}%, TP ${finalBestMeme.trailing_tp_trigger}%, PB ${finalBestMeme.trailing_pullback}%`);
            }

            let finalBestTrending = bestTrendingCoarse;
            if (bestTrendingCoarse) {
                const trendingFineGrid = this.generateFineGrid(bestTrendingCoarse, trendingCoarseGrid.meta);
                finalBestTrending = this.simulateGridSearch(trendingTrades, trendingFineGrid);
                console.log(`🎯 Trending 極限微調完畢: SL ${finalBestTrending.stop_loss_pct}%, TP ${finalBestTrending.trailing_tp_trigger}%, PB ${finalBestTrending.trailing_pullback}%`);
            }

            // 3. 提交 AI 進行「合理性評估」
            const prompt = `You are the EVOLUTION MASTER of a Quant bot.
The Backtest Engine has mathematically determined the optimal parameters for next week using a Two-Stage High-Precision Grid Search. 

[MEME STRATEGY (High Volatility)]
Proposed Params: Stop Loss ${finalBestMeme?.stop_loss_pct || 'N/A'}%, Take Profit Trigger ${finalBestMeme?.trailing_tp_trigger || 'N/A'}%, Pullback ${finalBestMeme?.trailing_pullback || 'N/A'}%
Simulated Win Rate: ${finalBestMeme?.win_rate?.toFixed(1) || 'N/A'}%

[TRENDING STRATEGY (Top 100 Momentum)]
Proposed Params: Stop Loss ${finalBestTrending?.stop_loss_pct || 'N/A'}%, Take Profit Trigger ${finalBestTrending?.trailing_tp_trigger || 'N/A'}%, Pullback ${finalBestTrending?.trailing_pullback || 'N/A'}%
Simulated Win Rate: ${finalBestTrending?.win_rate?.toFixed(1) || 'N/A'}%

Task: Provide a critical evaluation of these proposed parameters. Are they reasonable given current market conditions? What are the potential risks? 
Output JSON: 
{
  "evaluation_report": "<Cantonese explanation under 100 words outlining the reasoning, risks, and market context of these parameters>"
}`;

console.log(`🧠 [Evolution Engine] 參數計算完畢，正在呼叫 AI 資源池撰寫評估報告...`);
            
            // 👇 V9.1 改用 keyRotator 排隊打 API 並加入 Try-Catch 降級
            let aiDecision = null;
            try {
                aiDecision = await keyRotator.enqueueRequest(async (apiKey) => {
                    const isGroq = apiKey.startsWith('gsk_');
                    const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                    const modelName = isGroq ? 'llama-3.3-70b-versatile' : 'mistral-large-latest';

                    const res = await axios.post(apiUrl, {
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" }
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        timeout: 30000
                    });
                    return JSON.parse(res.data.choices[0].message.content);
                });
            } catch (aiErr) {
                console.warn(`⚠️ [Evolution Engine] AI 評估失敗，平滑降級: ${aiErr.message}`);
            }

            const evaluation = aiDecision?.evaluation_report || "AI 評估超時或冷卻中，僅提供數學最佳解。";

            // 4. 寫入 ai_proposals 提案表 (PENDING 狀態)，交由 autoApplyJob 執行 60 分鐘倒數
            const proposedChanges = { 
                meme_params: finalBestMeme, 
                trending_params: finalBestTrending 
            };
            
            const { data: proposalInsert } = await supabase.from('ai_proposals').insert([{
                proposal_type: 'BACKTEST',
                report_content: evaluation,
                proposed_changes: proposedChanges,
                status: 'PENDING'
            }]).select();

            const proposalId = proposalInsert[0].id;
            console.log(`⏳ [Evolution Engine] 提案已生成 (ID: ${proposalId})。已交由 AutoApplyJob 進行 60 分鐘倒數...`);
            
            if (typeof sendTelegramAlert === 'function') {
                const { sendApprovalRequest } = require('../services/telegramService');
                await sendApprovalRequest(`🧬 <b>每週參數優化提案已生成</b>\n\n💡 <b>AI 評估:</b>\n${evaluation}\n\n⏳ 系統將於 60 分鐘後自動 Apply。你可立即批准或否決！`, proposalId);
            }

            healthMonitor.setStatus('Evolution_Engine', '🟢 提案生成，等待審批');

        } catch (err) {
            console.error(`❌ [Evolution Engine] 回測執行失敗:`, err.message);
            healthMonitor.setStatus('Evolution_Engine', `🔴 回測異常: ${err.message}`);
        }
    },

    start() {
        // 🚀 強制設定時區為香港時間 (Asia/Hong_Kong)，逢週日 09:00 執行 ('0 9 * * 0')
        cron.schedule('0 9 * * 0', () => { 
            this.runBacktest(); 
        }, {
            scheduled: true,
            timezone: "Asia/Hong_Kong"
        });
        console.log('🕒 [Evolution Engine] 每週雙軌高精度回測排程已啟動 (排定於週日 09:00 HKT，帶 60mins HITL 防丟失審批)');
    }
};

module.exports = { weeklyBacktestJob };