// src/config/config.js
// 📝 檔案功能用途：V9.3 系統中央總控台。
// 🚀 升級功能：將 AI 資源池按供應商 (GROQ/MISTRAL/GEMINI) 嚴格分類，確保 KeyRotator 精準派發。

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
    // 🧠 V9.3 AI 資源池 (嚴格分類版)
    // ==========================================
    aiKeys: {
        GROQ: [
            getEnv('GROQ_API_KEY_1'), getEnv('GROQ_API_KEY_2'), getEnv('GROQ_API_KEY_3')
        ].filter(Boolean),
        MISTRAL: [
            getEnv('MISTRAL_API_KEY_1'), getEnv('MISTRAL_API_KEY_2'), getEnv('MISTRAL_API_KEY_3')
        ].filter(Boolean),
        GEMINI: [
            getEnv('GEMINI_API_KEY_1'), getEnv('GEMINI_API_KEY_2'), getEnv('GEMINI_API_KEY_3')
        ].filter(Boolean)
    },

    // ==========================================
    // 📊 量化漏斗門檻 (靜態底線)
    // ==========================================
    quant: {
        coreDefenseMaxScore: 60,
        momentumMaxScore: 40,    
        rejectThreshold: 70,     
        aiReviewMin: 70,         
        aiReviewMax: 89,
        fastTrackThreshold: 90,  
        socialPresenceScore: 5,  
        decayBarsToExit: 3       
    },

    aiRules: {
        minConfidence: 0.7,      
        adjustLimitLow: 10,      
        adjustLimitHigh: 20,     
    },

    trade: {
        sizeFullPts: 80,         
        sizeHalfPts: 70,         
        slippageBuyBps: 250,     
        slippageSellBps: 1500,   
        slippagePanicBps: 5000,  
    },

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
        jupiterApiKey: getEnv('JUPITER_API_KEY', true), 
        jupiterBaseUrl: getEnv('JUPITER_URL', false, 'https://quote-api.jup.ag'), 
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