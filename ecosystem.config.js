// ecosystem.config.js
// 📝 檔案功能用途：V10 艦隊 PM2 進程編排與算力分配 (Railway 部署專用)
// 🚀 核心分配：3 核 Node.js 前線防禦 + 5 核 Python ML 智腦，嚴格劃分 RAM 上限防 OOM。

module.exports = {
    apps: [
      // ------------------------------------------------------------------
      // 1. 【後勤樞紐】大市氣候台與超時降級 (低耗能)
      // ------------------------------------------------------------------
      {
        name: "v10-macro-center",
        script: "./src/microservices/macro_sync_center.js",
        instances: 1,
        exec_mode: "fork",
        max_memory_restart: "512M", // ✅ 輕量級進程 (無小數點)
        autorestart: true,
        watch: false,
        env: {
          NODE_ENV: "production"
        }
      },
      
      // ------------------------------------------------------------------
      // 2. 【前線大腦】物理漏斗與雙腦路由 (高頻 I/O)
      // ------------------------------------------------------------------
      {
        name: "v10-trade-frontline",
        script: "./src/microservices/trade_frontline.js",
        instances: 1,
        exec_mode: "fork",
        max_memory_restart: "1000M", // ✅ 1G 改為 1000M (絕對安全)
        autorestart: true,
        watch: false,
        env: {
          NODE_ENV: "production",
          PORT: 8080
        }
      },
  
      // ------------------------------------------------------------------
      // 3. 【護盤鐵衛】O(1) 陣列運算與逃生艙 (高運算)
      // ------------------------------------------------------------------
      {
        name: "v10-monitor-guards",
        script: "./src/microservices/monitor_guards.js",
        instances: 1,
        exec_mode: "fork",
        max_memory_restart: "1500M", // 🎯 致命元兇修復：1.5G 改為 1500M
        autorestart: true,
        watch: false,
        env: {
          NODE_ENV: "production"
        }
      },
  
      // ------------------------------------------------------------------
      // 4. 【ML 智腦核心】Python FastAPI (重裝甲推論)
      // ------------------------------------------------------------------
      {
        name: "v10-ml-brain",
        script: "main.py", 
        cwd: "./ml_engine", 
        interpreter: "python3",
        instances: 1, 
        exec_mode: "fork",
        max_memory_restart: "3000M", // ✅ 3G 改為 3000M
        autorestart: true,
        watch: false,
        env: {
          NODE_ENV: "production"
        }
      }
    ]
  };