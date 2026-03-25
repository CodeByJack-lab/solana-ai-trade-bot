// backfill-test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const historicalRecords = [
    {
        sender_address: "BfM9wz58j4m2p4kY5eX9qE8L1Y3v6rT7G9mP4wR2nQ5A",
        person_name: "JACK",
        amount_sol: 0.1,
        txid: "4yv5rcHP1yjc3SET9LhGi6E8PJUNbTHYEwTH3K2UT6FAdiSxSeGpHH2NH22APeh2g8nTxkwbcaABzsjLhuvMjbQY"
    },
    {
        sender_address: "BfM9wz58j4m2p4kY5eX9qE8L1Y3v6rT7G9mP4wR2nQ5A",
        person_name: "JACK",
        amount_sol: 0.2,
        txid: "4c4EdZyMz9Wx5KSL7hpReHPyHUzV5ynueb4hdfmQJHf8jXYAR4otAwU6hvjFx1DJgwv1BJcP7qpg5JCZpgjdTZ47"
    },
    {
        sender_address: "F9nN9XpY6qS8mH4wR2nQ5ABfM9wz58j4m2p4kY5eX", // 請自行確認 FUNG 的地址
        person_name: "FUNG",
        amount_sol: 0.2,
        txid: "4uCAP39QDbAAG24UL37fcwKneRPcXVYJvpoKgKt4kJeoCZKonr5HXYsVVfpHP49eaZJsRQ2BsqTm5LyQCNKYAvAr"
    },
    {
        sender_address: "K6nQ5ABfM9wz58j4m2p4kY5eXF9nN9XpY6qS8mH4w", // 請自行確認 KENNY 的地址
        person_name: "KENNY",
        amount_sol: 0.1,
        txid: "4qNX1ahR9aGf777aZmeJzknMp3FvqVmDvfRS5orCfQpNDicgqbqpHZbfjn6aoT15e82wipuadbGuFVkGaecH1CSu"
    }
];

async function runBackfill() {
    console.log("🚀 [Backfill] 開始歷史數據補錄流程 (修復 Constraint 版本)...\n");

    for (const record of historicalRecords) {
        console.log(`⏳ 正在處理: ${record.person_name} | 金額: ${record.amount_sol} SOL`);

        // 1. 寫入入金紀錄表
        const { error: insertError } = await supabase
            .from('deposit_history')
            .upsert([{
                sender_address: record.sender_address,
                person_name: record.person_name,
                amount_sol: record.amount_sol,
                txid: record.txid,
                created_at: new Date().toISOString()
            }], { onConflict: 'txid,sender_address' }); // 🚀 修復位

        if (insertError) {
            console.error(`❌ [DB] 寫入失敗:`, insertError.message);
            continue;
        }

        // 2. 獲取最新佔比
        const { data: stats, error: viewError } = await supabase
            .from('wallet_contribution_summary')
            .select('*')
            .eq('person_name', record.person_name)
            .single();

        if (viewError) {
            console.warn(`⚠️ [View] 暫時攞唔到 ${record.person_name} 嘅佔比數據`);
        } else {
            console.log(`✅ [Success] ${record.person_name} 最新佔比: ${stats.percentage}%`);
        }

        // 3. 發送 Telegram
        const message = `💰 <b>【補錄成功】資金到帳</b>\n` +
                        `----------------------------\n` +
                        `👤 <b>金主</b>: ${record.person_name}\n` +
                        `💵 <b>金額</b>: <code>${record.amount_sol}</code> SOL\n` +
                        `📊 <b>佔比</b>: <code>${stats ? stats.percentage : '計算中'}%</code>\n` +
                        `🏛️ <b>個人總資產</b>: <code>${stats ? stats.current_balance : '...'}</code> SOL\n` +
                        `----------------------------\n` +
                        `📅 <i>紀錄時間: ${new Date().toLocaleString('zh-HK')}</i>`;

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
        } catch (e) {}

        await new Promise(r => setTimeout(r, 1500));
    }

    console.log("\n🎉 所有紀錄處理完畢！請檢查 Dashboard。");
}

runBackfill();