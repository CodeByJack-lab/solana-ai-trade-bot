// /config/config.js
// 📝 檔案功能用途：V9.1 系統中央總控台。集中管理 100 分量化漏斗門檻、不對稱滑點設定、Time-Stop 規則及所有環境變數。

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });

const getEnv = (key, required = false, defaultVal = null) => {
    const value = process.env[key];
    if (required && !value) {
        console.error(`🚨 [Config Error] 啟動失敗：缺少必要環境變數 ${key}！`);
        process.exit(1); 
    }
    return value || defaultVal;
};

const config = {
    // ==========================================
    // 🧠 V9.1 AI 資源池 (統一 6 把 API Keys)
    // ==========================================
    aiKeys: [
        getEnv('GROQ_API_KEY_1'),
        getEnv('GROQ_API_KEY_2'),
        getEnv('GROQ_API_KEY_3'),
        getEnv('MISTRAL_API_KEY_1'),
        getEnv('MISTRAL_API_KEY_2'),
        getEnv('MISTRAL_API_KEY_3')
    ].filter(Boolean),

    // 🚀 V9.2 新增 Gemini 專屬資源池 (用於高階推理如 Climate Advisor)
    geminiKeys: [
        getEnv('GEMINI_API_KEY_1'), 
        getEnv('GEMINI_API_KEY_2'), 
        getEnv('GEMINI_API_KEY_3')
    ].filter(Boolean),

    // ==========================================
    // 📊 V9.1 100分量化漏斗門檻 (Quant Funnel)
    // ==========================================
    quant: {
        // 分數權重分配
        coreDefenseMaxScore: 60, // 核心防禦 (流動性、市值、真假幣、貔貅檢測)
        momentumMaxScore: 40,    // 動能與結構 (1h/5m 漲幅、買賣壓比、Metadata)
        
        // 評分與分流門檻
        rejectThreshold: 60,     // < 60 分：直接拒絕 (Direct Reject)
        aiReviewMin: 60,         // 60 - 89 分：進入 AI 議事廳微調
        aiReviewMax: 89,
        fastTrackThreshold: 90,  // >= 90 分：極品！繞過 AI，直接市價搶單 (Fast-track)

        // Metadata 檢查 (Social Presence 改為純量化，不呼叫 NLP)
        socialPresenceScore: 5,  // 有連結 = 5分，無連結 = 0分

        // 動能衰退監控 (Momentum Decay Monitor)
        decayBarsToExit: 3       // 連續 3 個 1 分鐘 K 線量縮即觸發離場
    },

    // ==========================================
    // 🤖 V9.1 AI 決策與微調規則
    // ==========================================
    aiRules: {
        minConfidence: 0.7,      // 信心度 < 0.7，完全忽視 AI 分數調整
        adjustLimitLow: 10,      // 60-74 分：AI 最多只能加減 10 分 (±10)
        adjustLimitHigh: 20,     // 75-89 分：AI 最多只能加減 20 分 (±20)
    },

    // ==========================================
    // ⚔️ V9.1 交易執行與風控規則 (Execution)
    // ==========================================
    trade: {
        // 倉位大小管理
        sizeFullPts: 80,         // >= 80 分：100% 倉位投入
        sizeHalfPts: 60,         // 60-79 分：50% 倉位投入
        
        // 30 分鐘時間止損 (Time-Stop)
        timeStopMinutes: 30,
        timeStopProfitTarget: 15, // 30 分鐘內利潤未達 +15%，無條件平倉

        // 不對稱滑點設計 (Asymmetric Slippage) - 單位: bps (1% = 100 bps)
        slippageBuyBps: 250,     // 買入滑點硬鎖死 2.5%
        slippageSellBps: 1500,   // 賣出常規滑點放寬至 15%
        slippagePanicBps: 5000,  // 緊急逃生/崩盤拔線滑點解鎖至 50%

        // 🛡️ V9.1.7 藍籌白名單鐵閘 (僅套用於 TRENDING 策略)
        enableTrendingWhitelist: true, // true = 開啟白名單模式, false = 關閉
        trendingWhitelist: [
            "EKpQGSJtjMFqKZ9KQanUKKcPiUhUhHG23kLfnB2WbfaE", // WIF
            "7GCihgDB8fe6KNjn2BYbvS1DNgT2XJ1hBAnrJ11qpump", // POPCAT
            "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
            // 👇 指揮官，請喺度繼續加你想狙擊嘅 Top 100 幣種 Mint Address (注意要加雙引號同逗號)
        ],
    },

    // ==========================================
    // 🔗 基礎建設與外部 API 配置
    // ==========================================
    solana: {
        walletPrivateKey: getEnv('SOLANA_PRIVATE_KEY', true),
        walletPublicKey: getEnv('MY_WALLET_PUBLIC_KEY', true)
    },
    db: {
        url: getEnv('SUPABASE_URL', true),
        anonKey: getEnv('SUPABASE_ANON_KEY', true),
        serviceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY', true)
    },
    cache: {
        redisUrl: getEnv('REDIS_URL', true),
        redisPublicUrl: getEnv('REDIS_PUBLIC_URL', true)
    },
    rpc: {
        helius1: { apiKey: getEnv('HELIUS_API_KEY'), webhookId: getEnv('HELIUS_WEBHOOK_ID'), url: getEnv('HELIUS_RPC_URL') },
        helius2: { apiKey: getEnv('HELIUS_API_KEY_2'), webhookId: getEnv('HELIUS_WEBHOOK_ID_2'), url: getEnv('HELIUS_RPC_URL_2') },
        alchemy: { apiKey: getEnv('ALCHEMY_API_KEY'), url: getEnv('ALCHEMY_RPC_URL') }
    },
    external: {
        jupiterApiKey: getEnv('JUPITER_API_KEY', true), // 🛡️ 轉為必要變數，確保防封鎖
        jupiterBaseUrl: getEnv('JUPITER_URL', false, 'https://quote-api.jup.ag'), // 🛡️ 補回 Base URL 彈性
        birdeyeApiKey: getEnv('BIRDEYE_API_KEY'),
        coingeckoApiKey: getEnv('COINGECKO_API_KEY')
    },
    telegram: {
        mainBotToken: getEnv('TELEGRAM_BOT_TOKEN', true),
        adminBotToken: getEnv('TELEGRAM_ADMIN_BOT_TOKEN') || getEnv('TELEGRAM_BOT_TOKEN'),
        chatId: getEnv('TELEGRAM_CHAT_ID', true),
        channelId: getEnv('TELEGRAM_CHANNEL_ID') || getEnv('TELEGRAM_CHAT_ID')
    }
};

module.exports = config;