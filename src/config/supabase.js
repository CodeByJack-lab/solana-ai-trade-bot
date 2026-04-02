// src/config/supabase.js
const { createClient } = require('@supabase/supabase-js');
const configEnv = require('./config'); // 👈 引入中央彈藥庫

// 建立 Supabase 連接
const supabaseUrl = configEnv.db.url;
// 🛑 終極防護：Bot 必須強制使用 Service Role Key！刪除 || anonKey 的降級退路。
const supabaseKey = configEnv.db.serviceRoleKey;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ [Config] 致命錯誤: Node.js Bot 必須配置 SUPABASE_SERVICE_ROLE_KEY 才能無視 RLS 寫入數據！請檢查 .env 檔案。");
    process.exit(1); // 缺少上帝金鑰，直接停機，廢事行到一半先報 403 錯誤
}

// 建立擁有最高特權的 Client
const supabase = createClient(supabaseUrl, supabaseKey);

// 🚀 統一匯出標準
module.exports = { supabase };