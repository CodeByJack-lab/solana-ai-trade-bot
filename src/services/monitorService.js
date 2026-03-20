// backend/services/monitorService.js
const express = require('express');
const { supabase } = require('../config/supabase'); 
const axios = require('axios'); 
const { getPortfolio, getMemeCount, getPositionLimits } = require('./portfolioService'); 
const { healthMonitor } = require('./healthMonitor');
const { securityGuard } = require('./securityGuard');
const { consensusService, getPendingMemeCount } = require('./consensusService'); // 💡 引入 pending count
const { reviewActivePosition, analyzeReentry } = require('./aiService');
const { executeBuy, executeSell, executeSellRaydium, forceWriteOff } = require('./tradeService');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TARGET_PROGRAMS = ['6EF8rrecthR5Dkzon8Nwu78hrvfCKubJ14M5uBEwF6P', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8']; 
let isProcessingBatch = false; 

function startDatabaseNurseryMonitor() {
    console.log(`🐟 [Nursery Radar] 滴水式雷達已啟動 (每 10 秒撈 1 魚)...`);
    healthMonitor.setStatus('Meme_Radar', '🟢 監聽與撈魚中');
    
    setInterval(async () => {
        if (isProcessingBatch) return; 
        
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) return;

        // 🛑 第零道防線：將實體持倉 + AI 腦海中嘅訂單 加埋一齊計
        const { maxMeme } = getPositionLimits();
        if ((getMemeCount() + getPendingMemeCount()) >= maxMeme) {
            healthMonitor.setStatus('Meme_Radar', '🟡 倉位或隊列已滿，暫停撈魚');
            return; 
        }

        healthMonitor.setStatus('Meme_Radar', '🟢 撈魚中...');
        isProcessingBatch = true;
        try {
            const thresholdTime = new Date(Date.now() - (config.min_age_mins || 5) * 60 * 1000).toISOString();
            const deadTime = new Date(Date.now() - (config.max_age_mins || 60) * 60 * 1000).toISOString();

            await supabase.from('nursery_pool').delete().lte('created_at', deadTime);

            const { data: matureTokens } = await supabase
                .from('nursery_pool')
                .select('mint_address')
                .lte('created_at', thresholdTime)
                .order('created_at', { ascending: true })
                .limit(1);

            if (!matureTokens || matureTokens.length === 0) {
                isProcessingBatch = false;
                return; 
            }

            const mint = matureTokens[0].mint_address;
            await supabase.from('nursery_pool').delete().eq('mint_address', mint); 
            
            console.log(`🎣 [Nursery] 撈出成熟代幣 ${mint.substring(0,6)}... 交由保安亭處理`);

            const safety = await securityGuard.checkAll(mint);
            if (!safety.isSafe) {
                console.log(`🛡️ [Security] 攔截: ${safety.reason}`);
                isProcessingBatch = false;
                return;
            }

            const aiDecision = await consensusService.runMemeConsensus(mint, safety.marketData, { isReentry: false });
            if (aiDecision?.buy) {
                await executeBuy(mint, safety.marketData.symbol, 'MEME_HUNTER', aiDecision.score, aiDecision.reason, config.trade_amount_sol);
            }

        } catch (err) {
            console.error(`❌ [Nursery Error] 撈魚出錯:`, err.message);
        } finally {
            isProcessingBatch = false;
        }
    }, 10000); 
}

app.post('/webhook/helius', async (req, res) => {
    res.sendStatus(200); 
    try {
        const { count } = await supabase.from('nursery_pool').select('*', { count: 'exact', head: true });
        if (count >= 50) return; 

        let incomingMints = new Set();
        if (Array.isArray(req.body)) {
            req.body.forEach(ev => {
                if (ev.instructions?.some(ix => TARGET_PROGRAMS.includes(ix.programId)) && ev.tokenTransfers) {
                    ev.tokenTransfers.forEach(tf => { if (tf.mint) incomingMints.add(tf.mint); });
                }
            });
        }

        if (incomingMints.size > 0) {
            const inserts = Array.from(incomingMints).map(mint => ({ mint_address: mint }));
            await supabase.from('nursery_pool').upsert(inserts, { onConflict: 'mint_address' });
        }
    } catch (err) {}
});

function startWatchlistMonitor() {
    console.log(`📋 [Watchlist Radar] 橫盤接回雷達啟動...`);
    setInterval(async () => {
        try {
            const { data: watchlist } = await supabase.from('reentry_watchlist').select('*');
            if (!watchlist || watchlist.length === 0) return;

            // 🛑 第零道防線：將實體持倉 + AI 腦海中嘅訂單 加埋一齊計
            const { maxMeme } = getPositionLimits();
            if ((getMemeCount() + getPendingMemeCount()) >= maxMeme) return; 

            for (const token of watchlist) {
                const startTime = new Date(token.consolidation_start_time).getTime();
                if ((Date.now() - startTime) / 60000 >= 30) {
                    const aiReview = await analyzeReentry(token.mint_address, token.token_symbol, token.baseline_price_sol);
                    if (aiReview?.decision === 'BUY') {
                        console.log(`🔄 [Re-entry] 初審合格，將 ${token.token_symbol} 重新排入三白劍俠隊列...`);
                        const marketData = await securityGuard.fetchDexData(token.mint_address); 
                        if (marketData) {
                            const finalDecision = await consensusService.runMemeConsensus(token.mint_address, marketData, { isReentry: true });
                            if (finalDecision?.buy) {
                                const { data: config } = await supabase.from('system_config').select('trade_amount_sol').eq('id', 1).single();
                                await executeBuy(token.mint_address, token.token_symbol, 'MEME_REENTRY', finalDecision.score, finalDecision.reason, config.trade_amount_sol);
                            }
                        }
                    }
                    await supabase.from('reentry_watchlist').delete().eq('mint_address', token.mint_address);
                }
            }
        } catch (err) {}
    }, 10 * 60 * 1000); 
}

function startPositionMonitor() {
    // ... 保留不變 ...
}

function startMarketMonitor() {
    app.listen(process.env.PORT || 3000, '0.0.0.0', async () => {
        startDatabaseNurseryMonitor(); 
        startWatchlistMonitor(); 
        startPositionMonitor();
    });
}

module.exports = { startMarketMonitor };