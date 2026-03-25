const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // 確保讀取到環境變量

// 初始化 Supabase 客戶端
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * 根據 Solana 地址尋找對應的用戶名稱 (嚴格區分大小寫)
 * @param {string} address Solana Base58 地址
 */
async function getPersonNameByAddress(address) {
    try {
        // ⚠️ Solana 地址必須原汁原味，不能用 toLowerCase()
        const exactAddress = address.trim();

        const { data, error } = await supabase
            .from('deposit_history')
            .select('person_name')
            .eq('sender_address', exactAddress) // 嚴格比對
            .limit(1)
            .single();

        if (error || !data) return null;
        return data.person_name;
    } catch (err) {
        console.error("❌ [DB] 獲取人名失敗:", err.message);
        return null;
    }
}

/**
 * 記錄新的入帳紀錄到數據庫 (必須有 txid 防重)
 */
async function logNewDeposit(address, name, amount, txid) {
    try {
        const { error } = await supabase
            .from('deposit_history')
            .insert([{
                sender_address: address.trim(),
                person_name: name,
                amount_sol: amount,
                txid: txid,
                created_at: new Date().toISOString()
            }]);

        if (error) {
            // 如果係重複嘅 txid，會觸發 unique constraint error
            console.error("❌ [DB] 寫入 deposit_history 失敗:", error.message);
            return false;
        }
        return true;
    } catch (err) {
        console.error("💀 [DB Critical] Insert 失敗:", err.message);
        return false;
    }
}

/**
 * 記錄新的出金紀錄到數據庫 (必須有 txid 防重)
 */
async function logNewWithdrawal(address, name, amount, txid) {
    try {
        const { error } = await supabase
            .from('withdrawal_history')
            .insert([{
                recipient_address: address.trim(),
                person_name: name,
                amount_sol: amount,
                txid: txid,
                created_at: new Date().toISOString()
            }]);

        if (error) {
            console.error("❌ [DB] 寫入 withdrawal_history 失敗:", error.message);
            return false;
        }
        return true;
    } catch (err) {
        console.error("💀 [DB Critical] Insert Withdrawal 失敗:", err.message);
        return false;
    }
}

/**
 * 從 View 中獲取該用戶的最新佔比與餘額
 * @param {string} personName 用戶名稱
 */
async function getContributionStats(personName) {
    try {
        const { data: stats, error: statsError } = await supabase
            .from('wallet_contribution_summary')
            .select('*')
            .eq('person_name', personName)
            .single();

        if (statsError) {
            console.error("❌ [DB] 讀取 View 失敗:", statsError.message);
            throw statsError;
        }

        return stats;
    } catch (err) {
        console.error("💀 [DB Critical Error]:", err.message);
        return null;
    }
}

module.exports = { 
    getPersonNameByAddress, 
    logNewDeposit, 
    logNewWithdrawal,
    getContributionStats 
};