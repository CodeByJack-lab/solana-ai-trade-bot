// src/utils/rateLimiter.js
// 🚦 統一 Rate Limiter - 解決 Bug 12: GeckoTerminal rate limit

class RateLimiter {
  constructor({ maxRequests, timeWindowMs, name = 'default' }) {
    this.maxRequests = maxRequests;
    this.timeWindowMs = timeWindowMs;
    this.name = name;
    this.requests = [];
  }

  async acquire() {
    const now = Date.now();
    // 清除過期的請求記錄
    this.requests = this.requests.filter(t => now - t < this.timeWindowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.timeWindowMs - (now - oldestRequest);
      if (waitTime > 0) {
        console.log(`⏳ [RateLimit] ${this.name}: 等待 ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
        return this.acquire(); // 重新檢查
      }
    }

    this.requests.push(now);
    return true;
  }

  reset() {
    this.requests = [];
  }
}

// 預設 Rate Limiters
const rateLimiters = {
  // GeckoTerminal: 10 requests per 10 seconds
  geckoTerminal: new RateLimiter({
    maxRequests: 10,
    timeWindowMs: 10000,
    name: 'GeckoTerminal'
  }),
  // DexScreener: 15 requests per 10 seconds  
  dexScreener: new RateLimiter({
    maxRequests: 15,
    timeWindowMs: 10000,
    name: 'DexScreener'
  }),
  // Jupiter: 20 requests per 10 seconds
  jupiter: new RateLimiter({
    maxRequests: 20,
    timeWindowMs: 10000,
    name: 'Jupiter'
  }),
  // Telegram: 30 messages per 1 second (Telegram的限制更嚴格)
  telegram: new RateLimiter({
    maxRequests: 30,
    timeWindowMs: 1000,
    name: 'Telegram'
  })
};

/**
 * 帶 Rate Limit 的 API 請求包裝函數
 * @param {string} service - 服務名稱 (geckoterminal, dexscreener, jupiter, telegram)
 * @param {Function} fn - 要執行的異步函數
 */
async function withRateLimit(service, fn) {
  const limiter = rateLimiters[service];
  if (!limiter) {
    console.warn(`⚠️ [RateLimit] 未知的服務: ${service}, 跳過 rate limit`);
    return fn();
  }
  
  await limiter.acquire();
  return fn();
}

module.exports = { RateLimiter, rateLimiters, withRateLimit };