app.post('/webhook/helius', async (req, res) => {
    res.status(200).send('OK');

    try {
        const { data: config } = await supabase.from('system_config').select('*').eq('id', 1).single();
        if (!config || !config.is_running) {
            healthMonitor.setStatus('Meme_Radar', '🟡 系統已暫停');
            return;
        }

        const events = req.body;
        if (!Array.isArray(events)) return;

        stats_totalWebhookSignals += events.length;

        for (const event of events) {
            const instructions = event.instructions || [];
            let mintAddress = null;

            // 🚀 直接從智能合約 Bytecode 提取代幣地址！極速且無懼限流！
            function extractMintFromPumpFun(ix) {
                if (ix.programId === PUMP_FUN_PROGRAM_ID) {
                    const dataObj = ix.data || "";
                    if (typeof dataObj === 'string' && dataObj.length > 0) {
                        try {
                            const decodedBytes = bs58.decode(dataObj);
                            const hexString = Buffer.from(decodedBytes).toString('hex');
                            if (hexString.startsWith('181ec828051c0777')) {
                                if (ix.accounts && ix.accounts.length > 0) {
                                    return ix.accounts[0]; 
                                }
                            }
                        } catch (e) {}
                    }
                }
                if (ix.innerInstructions && Array.isArray(ix.innerInstructions)) {
                    for (const inner of ix.innerInstructions) {
                        const mint = extractMintFromPumpFun(inner);
                        if (mint) return mint;
                    }
                }
                return null;
            }

            for (const ix of instructions) {
                mintAddress = extractMintFromPumpFun(ix);
                if (mintAddress) break;
            }

            if (mintAddress) {
                stats_pumpFunCreates++; 
                await supabase.from('nursery_pool').insert([{ mint_address: mintAddress }]);
                stats_addedToNursery++; 
                console.log(`🌟 [Webhook] 漁網成功捕捉新幣，放入冷宮: ${mintAddress.substring(0,6)}...`);
            }
        }
    } catch (err) {
        console.error('❌ [Webhook Error]', err.message);
    }
});