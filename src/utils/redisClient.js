// src/utils/redisClient.js
// 🔌 統一 Redis 連線管理模組 - 解決 Bug 11: 多個 Redis 連線問題

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || 'redis://localhost:6379';

// 建立單一連線實例
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: false,
  enableReadyCheck: true,
  connectTimeout: 10000,
});

// 監控連線狀態
redisClient.on('connect', () => {
  console.log('🔗 [Redis] 已連線');
});

redisClient.on('error', (err) => {
  console.error('❌ [Redis] 連線錯誤:', err.message);
});

redisClient.on('ready', () => {
  console.log('✅ [Redis] 就緒');
});

module.exports = { redisClient };