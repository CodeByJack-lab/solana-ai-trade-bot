// src/config/supabase.js
// 📝 檔案功能用途：V10 上帝權限資料庫連線中樞。
// 🚀 升級功能：加入 Global Timeout 與自動重試機制，防止高頻 I/O 阻塞 Event Loop。

const { createClient } = require('@supabase/supabase-js');
const configEnv = require('./config'); // 👈 引入中央彈藥庫

const supabaseUrl = configEnv.db.url;
// 🛑 終極防護：Bot 必須強制使用 Service Role Key！刪除 || anonKey 的降級退路。
const supabaseKey = configEnv.db.serviceRoleKey;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ [Config] 致命錯誤: Node.js Bot 必須配置 SUPABASE_SERVICE_ROLE_KEY 才能無視 RLS 寫入數據！請檢查 .env 檔案。");
    process.exit(1); 
}

// 🛡️ V10 加固：設定全局逾時與重試次數
const supabaseOptions = {
    auth: {
        persistSession: false, // Bot 不需要儲存 Session
        autoRefreshToken: false // Bot 使用 Service Key，不會過期
    },
    global: {
        fetch: (url, options) => {
            // 設定 8 秒極限 Timeout，防止阻塞 Node.js Event Loop
            const timeout = 8000; 
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            
            return fetch(url, { ...options, signal: controller.signal })
                .finally(() => clearTimeout(id));
        }
    }
};

// 建立擁有最高特權的 Client
const supabase = createClient(supabaseUrl, supabaseKey, supabaseOptions);

// 🚀 統一匯出標準
module.exports = { supabase };