// 放入 index.js 頂部或獨立執行
console.log('--- 🕰️ 時區檢查程序 ---');
console.log('系統本地時間 (Local):', new Date().toString());
console.log('ISO 標準時間 (UTC): ', new Date().toISOString());
console.log('系統預設時區 (TZ):  ', process.env.TZ || '未設定 (預設通常為 UTC)');
console.log('-----------------------');