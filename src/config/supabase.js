// src/config/supabase.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 建立 Supabase 連接
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ [Config] 錯誤: SUPABASE_URL 或 KEY 未在環境變數中定義");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 🚀 統一匯出標準：加上大括號
module.exports = { supabase };