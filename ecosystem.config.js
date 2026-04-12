// ecosystem.config.js
// 📝 檔案功能用途：V10 艦隊 PM2 進程編排與算力分配 (Railway 部署防爆版)
// 🚀 核心升級：大幅收緊 RAM 上限防止全機 OOM 崩潰，並確保進程資源分配更合理。

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
        max_memory_restart: "256M", // 📉 由 512M 降至 256M (極低耗能，夠晒用)
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
        max_memory_restart: "512M", // 📉 由 1000M 降至 512M (純 API 請求，防內存洩漏)
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
        max_memory_restart: "512M", // 📉 由 1500M 降至 512M (O(1) 數學引擎非常慳 RAM)
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
        interpreter: "python",
        instances: 1, 
        exec_mode: "fork",
        max_memory_restart: "1500M", // 📉 由 3000M 降至 1500M (逼使 PM2 喺大塞車前介入)
        autorestart: true,
        watch: false,
        error_file: "/dev/stdout",
        out_file: "/dev/stdout",
        merge_logs: true,
        env: {
          NODE_ENV: "production"
        }
      }
    ]
  };