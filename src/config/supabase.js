// src/config/supabase.js
const { createClient } = require('@supabase/supabase-js');
const configEnv = require('./env'); // 👈 引入中央彈藥庫

// 建立 Supabase 連接
const supabaseUrl = configEnv.db.url;
const supabaseKey = configEnv.db.serviceRoleKey || configEnv.db.anonKey;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ [Config] 錯誤: SUPABASE_URL 或 KEY 未在環境變數中定義");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 🚀 統一匯出標準：加上大括號
module.exports = { supabase };