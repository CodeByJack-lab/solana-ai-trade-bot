// src/config/env.js
// 📝 檔案功能用途：系統中央彈藥庫。集中管理所有 API 金鑰、RPC 節點端點、數據庫連線及環境變數，是整個系統啟動與運作的配置核心。

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

/**
 * 🛠️ 確保關鍵變數存在：檢查環境變數，若缺少強制變數則終止系統。
 */
const getEnv = (key, required = true) => {
    const value = process.env[key];
    if (required && !value) {
        console.error(`🚨 [Config Error] 啟動失敗：缺少必要環境變數 ${key}！`);
        process.exit(1); 
    }
    return value;
};

const config = {
    // 1. Solana 錢包與網絡
    solana: {
        walletPrivateKey: getEnv('SOLANA_PRIVATE_KEY'),
        walletPublicKey: getEnv('MY_WALLET_PUBLIC_KEY'),
        walletWebhookId: getEnv('HELIUS_WALLET_WEBHOOK_ID', false),
    },

    // 2. 數據庫 (Supabase)
    db: {
        url: getEnv('SUPABASE_URL'),
        anonKey: getEnv('SUPABASE_ANON_KEY'),
        serviceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    },

    // 3. 高速緩存與大腦記憶 (Redis)
    cache: {
        redisUrl: getEnv('REDIS_URL'),
    },

    // 4. 🧠 V9.0 混合 AI 矩陣：Gemini 專職宏觀，Groq/Mistral 專職微觀高頻
    ai: {
        geminiKeys: [getEnv('GEMINI_API_KEY_1', true)].filter(Boolean),
        groqKeys: [getEnv('GROQ_API_KEY_1', true), getEnv('GROQ_API_KEY_2', false), getEnv('GROQ_API_KEY_3', false)].filter(Boolean),
        mistralKeys: [getEnv('MISTRAL_API_KEY_1', false), getEnv('MISTRAL_API_KEY_2', false), getEnv('MISTRAL_API_KEY_3', false)].filter(Boolean),
    },

    // 5. 警報與通知 (Telegram)
    telegram: {
        mainBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
        adminBotToken: getEnv('TELEGRAM_ADMIN_BOT_TOKEN', false) || getEnv('TELEGRAM_BOT_TOKEN'),
        chatId: getEnv('TELEGRAM_CHAT_ID'),
        channelId: getEnv('TELEGRAM_CHANNEL_ID', false) || getEnv('TELEGRAM_CHAT_ID'),
    },

    // 6. 外部數據與報價 (Oracle 基建 + 新聞備援)
    external: {
        exchangeRateApi: getEnv('EXCHANGE_RATE_API_URL', false) || 'https://api.exchangerate-api.com/v4/latest/USD',
        jupiterApiKey: getEnv('JUPITER_API_KEY', false),
        jupiterBaseUrl: getEnv('JUPITER_BASE_URL', false) || 'https://api.jup.ag',
        birdeyeApiKey: getEnv('BIRDEYE_API_KEY', false), 
        coingeckoApiKey: getEnv('COINGECKO_API_KEY', false),
        cryptopanicApiKey: getEnv('CRYPTOPANIC_API_KEY', false),
    },

    // 7. 🚀 RPC 負載平衡與 Webhooks (多車道水喉)
    rpc: {
        helius1: { apiKey: getEnv('HELIUS_API_KEY', false), webhookId: getEnv('HELIUS_WEBHOOK_ID', false), url: getEnv('HELIUS_RPC_URL', false) },
        helius2: { apiKey: getEnv('HELIUS_API_KEY_2', false), webhookId: getEnv('HELIUS_WEBHOOK_ID_2', false), url: getEnv('HELIUS_RPC_URL_2', false) },
        alchemy: { authToken: getEnv('ALCHEMY_AUTH_TOKEN', false), apiKey: getEnv('ALCHEMY_API_KEY', false), url: getEnv('ALCHEMY_RPC_URL', false), webhookUrl: getEnv('ALCHEMY_WEBHOOK_URL', false), webhookId: getEnv('ALCHEMY_WEBHOOK_ID', false) }
    },

    // 8. 系統服務
    ngrokUrl: getEnv('NGROK_URL', false),
    email: { smtpUser: getEnv('SMTP_USER', false), smtpPass: getEnv('SMTP_PASS', false) }
};

console.log("✅ [System] V9.0 彈藥庫載入成功 (混合 AI 陣列就位)。");
module.exports = config;