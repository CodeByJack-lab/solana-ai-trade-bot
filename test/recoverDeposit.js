// recoverDeposit.js
// 📝 腳本用途：手動補回漏接的入金紀錄

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// 初始化 Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ 找不到 Supabase 環境變數，請確認 .env 檔案是否存在');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runRecovery() {
    console.log('啟動手動入金補回程序...');

    // ⚠️ 指揮官，請喺度填返真實嘅資料！
    // 去 Phantom / Solscan 抄返個完整 Address 同 TXID 出嚟
    const MISSING_RECORD = {
        sender_address: "BfM9wz58j4m2p4kY5eX9qE8L1Y3v6rT7G9mP4wR2nQ5A", 
        person_name: "JACK", // 👈 睇你圖入面有 FUNG, KENNY, JACK，你自己改返啱佢
        amount_sol: 0.1,      // 👈 補回的金額
        txid: "請貼上這筆 0.1 SOL 轉帳的完整 TXID (Signature)"
    };

    if (MISSING_RECORD.sender_address.includes('請貼上')) {
        console.log('2XdrgnYJmJu4UtkheVUTZ5sDvCLaMZQXRFX5XSp4Qcq29iuR911UXtPWafPKRxZYasfctQhALNw2maEdvVFw4QfL');
        return;
    }

    try {
        const { data, error } = await supabase
            .from('deposit_history')
            .insert([{
                sender_address: MISSING_RECORD.sender_address,
                person_name: MISSING_RECORD.person_name,
                amount_sol: MISSING_RECORD.amount_sol,
                txid: MISSING_RECORD.txid
                // created_at 會自動用而家時間 (now())，唔使理佢
            }]);

        if (error) {
            console.error("❌ 寫入失敗:", error.message);
        } else {
            console.log(`✅ 成功補回 ${MISSING_RECORD.amount_sol} SOL 入金紀錄！`);
            console.log(`👤 金主: ${MISSING_RECORD.person_name}`);
            console.log(`🔗 系統將自動重新計算資金池佔比。請去 Dashboard F5 睇下！`);
        }
    } catch (err) {
        console.error("💀 執行時發生錯誤:", err.message);
    }
}

runRecovery();