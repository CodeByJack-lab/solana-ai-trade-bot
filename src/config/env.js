// src/config/env.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

/**
 * 🛠️ 輔助函數：確保關鍵變數存在
 * @param {string} key 變數名稱
 * @param {boolean} required 是否強制需要
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
        walletWebhookId: getEnv('HELIUS_WALLET_WEBHOOK_ID'),
    },

    // 2. 數據庫 (Supabase)
    db: {
        url: getEnv('SUPABASE_URL'),
        anonKey: getEnv('SUPABASE_ANON_KEY'),
        serviceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    },

    // 3. AI 大腦 (多 Key 陣列模式)
    ai: {
        geminiKeys: [
            getEnv('GEMINI_API_KEY_1', true),
            getEnv('GEMINI_API_KEY_2', false), // 第二、三條設為非強制，方便擴充
            getEnv('GEMINI_API_KEY_3', false)
        ].filter(Boolean),
        groqKey: getEnv('GROQ_API_KEY'),
        mistralKey: getEnv('MISTRAL_API_KEY'),
    },

    // 4. 警報與通知 (Telegram)
    telegram: {
        mainBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
        adminBotToken: getEnv('TELEGRAM_ADMIN_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN,
        chatId: getEnv('TELEGRAM_CHAT_ID'),
        channelId: getEnv('TELEGRAM_CHANNEL_ID'),
    },

    // 5. 外部數據與報價 (Oracle 基建)
    external: {
        exchangeRateApi: getEnv('EXCHANGE_RATE_API_URL', false) || 'https://api.exchangerate-api.com/v4/latest/USD',
        jupiterApiKey: getEnv('JUPITER_API_KEY', false),
        jupiterBaseUrl: getEnv('JUPITER_BASE_URL', false) || 'https://price.jup.ag/v6',
        birdeyeApiKey: getEnv('BIRDEYE_API_KEY', false), // 之後會逐步棄用
        coingeckoApiKey: getEnv('COINGECKO_API_KEY', false),
    },

    // 6. RPC 負載平衡與 Webhooks
    rpc: {
        // Helius 1 (Raydium 專線)
        helius1: {
            apiKey: getEnv('HELIUS_API_KEY'),
            webhookId: getEnv('HELIUS_WEBHOOK_ID'),
            url: getEnv('HELIUS_RPC_URL'),
        },
        // Helius 2 (Pump.fun 專線)
        helius2: {
            apiKey: getEnv('HELIUS_API_KEY_2', false),
            webhookId: getEnv('HELIUS_WEBHOOK_ID_2', false),
            url: getEnv('HELIUS_RPC_URL_2', false),
        },
        // Alchemy (會計與備援)
        alchemy: {
            authToken: getEnv('ALCHEMY_AUTH_TOKEN'),
            webhookId: getEnv('ALCHEMY_WEBHOOK_ID'),
            url: getEnv('ALCHEMY_RPC_URL'),
        }
    },

    // 7. Email SMTP 設定
    email: {
        smtpUser: getEnv('SMTP_USER', false),
        smtpPass: getEnv('SMTP_PASS', false)
    }
};

console.log("✅ [System] 中央彈藥庫載入成功，所有系統組件已就位。");

module.exports = config;