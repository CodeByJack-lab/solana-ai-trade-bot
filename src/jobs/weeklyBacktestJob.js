// src/jobs/weeklyBacktestJob.js
// 📝 檔案功能用途：V9.3 雙軌高精度回測引擎 (三權分立版)。
// 🚀 升級功能：放棄對 Stop Loss 嘅修改權 (交給參謀總長實時決策)，專注優化「追蹤止盈觸發點 (TP Trigger)」與「回撤容忍度 (Pullback)」以捕獲極端肥尾利潤。

const { supabase } = require('../config/supabase');
const { keyRotator } = require('../services/keyRotator');
const { cacheManager } = require('../services/cacheManager'); 
const cron = require('node-cron');
const axios = require('axios');
const { getPortfolio } = require('../services/portfolioService');
const { healthMonitor } = require('../services/healthMonitor');
const { sendApprovalRequest } = require('../services/telegramService'); 

const weeklyBacktestJob = {
    /**
     * 📏 第一階段：粗網格生成器 (撒大網)
     */
    generateCoarseGrid(trades, isMeme) {
        // 取得歷史利潤數據
        const peakGains = trades.map(t => {
            if (t.highest_price_sol && t.entry_price_sol) {
                return ((t.highest_price_sol - t.entry_price_sol) / t.entry_price_sol) * 100;
            }
            return 0;
        }).filter(p => p > 0);

        const defaultMaxGain = isMeme ? 200 : 50;
        const defaultMinGain = isMeme ? 30 : 15;

        let maxGain = peakGains.length > 0 ? Math.max(...peakGains) : defaultMaxGain;
        let minGain = peakGains.length > 0 ? Math.min(...peakGains) : defaultMinGain;

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

        const tpData = createSteps(minGain, maxGain, 20);  // 擴大搜索範圍
        const pbData = createSteps(minPb, maxPb, 10);       

        return {
            tpTrigger: tpData.values,   
            pullback: pbData.values,
            meta: { tpStep: tpData.stepSize, pbStep: pbData.stepSize }
        };
    },

    /**
     * 🎯 第二階段：精細網格生成器 (狙擊鏡)
     */
    generateFineGrid(bestCoarse, coarseMeta) {
        const createFineSteps = (center, coarseStep, steps) => {
            const min = center - coarseStep;
            const max = center + coarseStep;
            const fineStepSize = (max - min) / (steps - 1);
            return Array.from({length: steps}, (_, i) => parseFloat((min + (fineStepSize * i)).toFixed(2)));
        };

        return {
            tpTrigger: createFineSteps(bestCoarse.trailing_tp_trigger, coarseMeta.tpStep, 11).filter(x => x > 5), 
            pullback: createFineSteps(bestCoarse.trailing_pullback, coarseMeta.pbStep, 5).filter(x => x >= 2)
        };
    },

    /**
     * 🧮 歷史重演模擬器 (僅針對 Trailing Stop 最佳化)
     */
    simulateGridSearch(trades, grid) {
        let bestParams = null;
        let maxNetPnl = -Infinity;
        let bestWinRate = 0;

        // 固定 SL 為 -15% 進行模擬 (因為 SL 管轄權已移交給參謀總長)
        const fixedSl = -15.0; 

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
                        simTradePnlPct = tp - pb; // 觸發追蹤並食糊
                    } else if (actualPnlPct <= fixedSl) {
                        simTradePnlPct = fixedSl; // 模擬觸發固定止損
                    }

                    if (simTradePnlPct > 0) wins++;
                    simulatedPnl += (simTradePnlPct / 100) * t.total_value_sol; 
                }

                if (totalValid > 0 && simulatedPnl > maxNetPnl) {
                    maxNetPnl = simulatedPnl;
                    bestWinRate = (wins / totalValid) * 100;
                    bestParams = { 
                        trailing_tp_trigger: parseFloat(tp.toFixed(2)), 
                        trailing_pullback: parseFloat(pb.toFixed(2)), 
                        net_pnl_sol: simulatedPnl, 
                        win_rate: bestWinRate 
                    };
                }
            }
        }
        return bestParams;
    },

    /**
     * 🚀 執行兩階段高精度雙軌回測主程序
     */
    async runBacktest() {
        console.log('\n🧬 [Evolution Engine] 啟動雙軌【兩階段高精度回測】與參數結算 (專注優化 Trailing Stop)...');
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
                console.log(`🎯 Meme 追蹤止盈微調完畢: TP Trigger ${finalBestMeme.trailing_tp_trigger}%, PB ${finalBestMeme.trailing_pullback}%`);
            }

            let finalBestTrending = bestTrendingCoarse;
            if (bestTrendingCoarse) {
                const trendingFineGrid = this.generateFineGrid(bestTrendingCoarse, trendingCoarseGrid.meta);
                finalBestTrending = this.simulateGridSearch(trendingTrades, trendingFineGrid);
                console.log(`🎯 Trending 追蹤止盈微調完畢: TP Trigger ${finalBestTrending.trailing_tp_trigger}%, PB ${finalBestTrending.trailing_pullback}%`);
            }

            // 3. 🧠 動態獲取 AI 劇本與模型輪替
            const contextString = `[MEME STRATEGY]\nProposed: TP Trigger ${finalBestMeme?.trailing_tp_trigger || 'N/A'}%, Pullback ${finalBestMeme?.trailing_pullback || 'N/A'}%\nWin Rate: ${finalBestMeme?.win_rate?.toFixed(1) || 'N/A'}%\n\n[TRENDING STRATEGY]\nProposed: TP Trigger ${finalBestTrending?.trailing_tp_trigger || 'N/A'}%, Pullback ${finalBestTrending?.trailing_pullback || 'N/A'}%\nWin Rate: ${finalBestTrending?.win_rate?.toFixed(1) || 'N/A'}%`;

            const aiConfig = cacheManager.getPromptConfig('backtest_analyst', { promptContext: contextString });
            const prompt = aiConfig.parsedPrompt;
            const models = aiConfig.models;

            console.log(`🧠 [Evolution Engine] 參數計算完畢，正在呼叫 AI 大腦 (${aiConfig.provider}) 撰寫評估報告...`);
            
            let evaluation = "⚠️ AI 評估超時或冷卻中，僅提供數學最佳解。";

            try {
                evaluation = await keyRotator.enqueueRequest(async (apiKey) => {
                    const cleanKey = apiKey.replace(/['"]/g, '').trim();
                    const isGroq = cleanKey.startsWith('gsk_');
                    const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
                    
                    let lastErr = null;

                    for (const currentModel of models) {
                        try {
                            console.log(`🤖 嘗試呼叫模型: ${currentModel}`);
                            const res = await axios.post(apiUrl, {
                                model: currentModel,
                                messages: [{ role: "user", content: prompt }],
                                response_format: { type: "json_object" }
                            }, {
                                headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' },
                                timeout: 15000
                            });
                            
                            const rawText = res.data.choices[0].message.content;
                            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                            if (!jsonMatch) throw new Error("AI 未回傳有效 JSON");
                            
                            return JSON.parse(jsonMatch[0]).report; 
                        } catch (e) {
                            lastErr = e;
                            console.warn(`⚠️ [Evolution Engine] 模型 ${currentModel} 失敗，嘗試後備...`);
                        }
                    }
                    throw lastErr || new Error("所有後備模型均失敗");
                });
            } catch (aiErr) {
                console.warn(`⚠️ [Evolution Engine] AI 評估徹底失敗: ${aiErr.message}`);
            }

            // 4. 寫入 ai_proposals 提案表 (PENDING 狀態)，交由 autoApplyJob 執行審批
            // 🚨 核心修正：將提案送出的參數，刪除 stop_loss_pct，確保不會與實時參謀總長打架！
            const proposedChanges = { 
                meme_params: finalBestMeme ? { trailing_tp_trigger: finalBestMeme.trailing_tp_trigger, trailing_pullback: finalBestMeme.trailing_pullback } : null, 
                trending_params: finalBestTrending ? { trailing_tp_trigger: finalBestTrending.trailing_tp_trigger, trailing_pullback: finalBestTrending.trailing_pullback } : null 
            };
            
            const { data: proposalInsert } = await supabase.from('ai_proposals').insert([{
                proposal_type: 'BACKTEST',
                report_content: evaluation,
                proposed_changes: proposedChanges,
                status: 'PENDING'
            }]).select();

            const proposalId = proposalInsert[0].id;
            console.log(`⏳ [Evolution Engine] 提案已生成 (ID: ${proposalId})。已交由 AutoApplyJob 進行 60 分鐘倒數...`);
            
            if (typeof sendApprovalRequest === 'function') {
                await sendApprovalRequest(`🧬 <b>每週參數優化提案已生成</b>\n\n💡 <b>AI 評估:</b>\n${evaluation}\n\n⏳ 系統將於 60 分鐘後自動 Apply。你可立即批准或否決！`, proposalId);
            }

            healthMonitor.setStatus('Evolution_Engine', '🟢 提案生成，等待審批');

        } catch (err) {
            console.error(`❌ [Evolution Engine] 回測執行失敗:`, err.message);
            healthMonitor.setStatus('Evolution_Engine', `🔴 回測異常: ${err.message}`);
        }
    },

    start() {
        cron.schedule('0 9 * * 0', () => { 
            this.runBacktest(); 
        }, {
            scheduled: true,
            timezone: "Asia/Hong_Kong"
        });
        console.log('🕒 [Evolution Engine] 每週雙軌高精度回測排程已啟動 (專注優化止盈，不干擾實時止損防線)');
    }
};

module.exports = { weeklyBacktestJob };