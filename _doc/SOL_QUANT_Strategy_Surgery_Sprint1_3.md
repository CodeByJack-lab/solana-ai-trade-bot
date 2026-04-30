# SOL QUANT V10 — 策略手術 Implementation Brief
**Version:** S1.0 | **Date:** 2026-04-30  
**目標：** 從 28.8% 勝率推至 55%+ 並具備 LIVE 部署條件  
**執行者：** Claude Code (Dokploy environment)

---

## 絕對限制（所有 Sprint 都必須遵守）

1. **禁止 Shadow Route**：`is_shadow: false`，不得引用 `active_positions_shadow`
2. **禁止直接注入 finalScore**：所有信號改善必須流經 SecurityGuard `numeric_score`（0–20）、Bayes Factor、或 Kelly multiplier
3. **Kelly 上下限**：`kellyMultiplier` 必須 `clamp(0.1, 3.0)`；`safeKelly = fStar × 0.25`
4. **Sell Lock finally**：所有 `sell_lock:{mint}` 必須在 `finally` 釋放
5. **DexScreener 限速**：`DEX_COOLDOWN_MS = 1000`，不得繞過
6. **JSON 防禦**：所有 LLM 回應解析必須使用 `content.match(/\{[\s\S]*\}/)`
7. **Mistral Mutex**：新增 Mistral call 必須經 `keyRotator.runWithKey('MISTRAL', ...)`

---

## 執行順序

```
Sprint 1 (止血)  →  PAPER 觀察 2 週，勝率 ≥ 38% 先進行 Sprint 2
Sprint 2 (正攻)  →  PAPER 觀察 4 週，勝率 ≥ 48% 先進行 Sprint 3
Sprint 3 (精進)  →  PAPER 觀察 2 週，EV > 0 才考慮 LIVE 試水
```

**每個 Sprint 內的改動必須按序執行，唔可以跳步。**

---

# SPRINT 1：止血（目標勝率 38%+）

Sprint 1 有三個改動：1A、1B、1C。**必須全部完成後才算 Sprint 1 完成。**

---

## 1A：LLM 降格為 Veto-only

### 問題
數據顯示 LLM narrative score 係反指標——分數愈高輸得愈慘。根本原因係 LLM 識別「已 pump 完」的 token 叫做高敘事，但呢個係出場信號唔係入場信號。

### 目標檔案
```
src/microservices/trade_frontline.js
```

### 改動位置
搵到以下現有代碼：
```javascript
const bayesFactor = 0.2 + (1.8 / (1.0 + Math.exp(-0.6 * (llmScore - 3.5))));
const posteriorOdds = priorOdds * bayesFactor;
const finalWinProb = posteriorOdds / (1 + posteriorOdds);
let finalScore = Math.round(finalWinProb * 100);
```

**替換成：**
```javascript
// 🔪 [Strategy Surgery 1A] LLM 降格為 Veto-only
// LLM score < -2：明顯詐騙/負面敘事，直接否決
// LLM score >= -2：中性，唔影響 Bayesian 計算
// 原理：LLM 識別「已 pump 完」，不應作正向信號使用

if (llmScore < -2 && !llmFailed) {
    console.log(`🚫 [LLM Veto] ${symbol} 被敘事否決 (score: ${llmScore})，判定為負面敘事，拒絕入場`);
    return; // 直接退出 processAsymmetricRouting
}

// LLM 唔影響 posteriorOdds，bayesFactor 固定 1.0（中性）
const bayesFactor = 1.0;
const posteriorOdds = priorOdds * bayesFactor;
const finalWinProb = posteriorOdds / (1 + posteriorOdds);
let finalScore = Math.round(finalWinProb * 100);
```

### 同時更新 llmReason 記錄
喺上方改動之後，搵到寫入 `ai_reason` 的地方，確保 veto 原因有被記錄：
```javascript
// llmReason 保持原有邏輯，只是 bayesFactor 唔再係 sigmoid
// 在 Telegram 通知和 trade log 中加入 [Veto-Only Mode] 標記
const llmModeTag = '[LLM:Veto-Only]';
llmReason = `${llmModeTag} ${llmReason}`;
```

### 驗收條件
- [ ] Log 中唔再出現 `bayesFactor = 2.0` 或 `bayesFactor = 1.5`（LLM 加分）
- [ ] `llmScore < -2` 的 token 出現 `[LLM Veto]` log 並唔被買入
- [ ] `llmScore >= -2` 的 token 的 `bayesFactor` 固定係 `1.0`
- [ ] `llmFailed = true` 時唔觸發 veto（fail-open）

---

## 1B：Token Age 硬性門檻

### 問題
NEWBORN 幣有 momentum 窗口，太新（< 3 分鐘，流動性未穩定）或太舊（> 90 分鐘，動能已死）都唔應該入場。TRENDING 幣唔應該係全新幣。

### 目標檔案
```
src/services/securityGuard.js — calculateQuantScore() 函數
```

### 改動位置
喺 `calculateQuantScore()` 入面，`liquidity < activeParams.minLiquidityUsd` 的檢查之後，加入：

```javascript
// 🕐 [Strategy Surgery 1B] Token Age 硬性門檻
// pairCreatedAt 已係 marketData payload 入面（DexScreener 提供）
const pairAgeMins = marketData.pairCreatedAt
    ? (Date.now() - marketData.pairCreatedAt) / 60000
    : null;

if (pairAgeMins !== null) {
    if (type === 'NEWBORN') {
        // 太新：流動性未穩定，rug 風險極高
        if (pairAgeMins < 3) {
            return { 
                numeric_score: 0, isSafe: false, 
                reason: `⏳ NEWBORN 太新 (${pairAgeMins.toFixed(1)}m < 3m)，流動性未穩定`,
                marketData, applied_ml_strategy_id: targetParam?.id || 0 
            };
        }
        // 太舊：NEWBORN momentum 窗口已關閉
        if (pairAgeMins > 90) {
            return { 
                numeric_score: 0, isSafe: false, 
                reason: `⌛ NEWBORN 過時 (${pairAgeMins.toFixed(0)}m > 90m)，momentum 窗口已關閉`,
                marketData, applied_ml_strategy_id: targetParam?.id || 0 
            };
        }
    }

    if (type === 'TRENDING') {
        // TRENDING 唔應該係全新幣（< 60 分鐘）
        if (pairAgeMins < 60) {
            return { 
                numeric_score: 0, isSafe: false, 
                reason: `🔀 TRENDING 太新 (${pairAgeMins.toFixed(0)}m < 60m)，應走 NEWBORN 流程`,
                marketData, applied_ml_strategy_id: targetParam?.id || 0 
            };
        }
    }
}
```

### 注意事項
- `pairCreatedAt` 已係 `_fetchMarketData()` 回傳的 marketData 入面（`pair.pairCreatedAt`）
- 如果 `pairCreatedAt` 係 null（部分 token DexScreener 冇返），跳過此檢查（fail-open）
- 唔改任何其他邏輯

### 驗收條件
- [ ] Log 中出現 `⏳ NEWBORN 太新` 或 `⌛ NEWBORN 過時` 的攔截記錄
- [ ] 超過 90 分鐘的 NEWBORN token 唔被買入
- [ ] `pairCreatedAt = null` 的 token 正常通過（唔被誤殺）

---

## 1C：LP Burn 做入場加速器

### 問題
`sourceAggregator.js` 已將 `lp_burned:{mint}` 寫入 Redis，但 SecurityGuard 完全冇讀佢。LP Burn 係最強的 anti-rug 信號，應該係正向加分。

### 目標檔案
```
src/services/securityGuard.js — calculateQuantScore() 函數
```

### 改動位置
喺計算 `coreScore` 完成、返回結果之前，加入：

```javascript
// 🔥 [Strategy Surgery 1C] LP Burn 正向加分
// lp_burned:{mint} 係由 sourceAggregator 偵測燒池事件後寫入
// LP 已燒毀 = dev 無法撤池 = 最強 anti-rug 信號
try {
    const lpBurned = await redisClient.get(`lp_burned:${mint}`);
    if (lpBurned === 'TRUE') {
        const burnBonus = 4; // 加 4 分，上限仍係 20
        const prevScore = coreScore;
        coreScore = Math.min(20, coreScore + burnBonus);
        reasons.push(`🔥 LP 已燒毀 (+${coreScore - prevScore}分)`);
        console.log(`🔥 [LP Burn Bonus] ${marketData.symbol} LP 已燒毀，加分 +${coreScore - prevScore} → ${coreScore}/20`);
    }
} catch (e) {
    // Redis 失敗唔阻止正常流程
}
```

### 驗收條件
- [ ] 當 `lp_burned:{mint} = TRUE` 時，log 出現 `[LP Burn Bonus]`
- [ ] `coreScore` 唔超過 20（上限保持不變）
- [ ] Redis 失敗唔影響正常 SecurityGuard 流程

---

## Sprint 1 整體驗收 KPI（PAPER 模式跑 2 週）

| 指標 | Sprint 1 前 | Sprint 1 目標 |
|---|---|---|
| 勝率 | 28.8% | ≥ 38% |
| LLM veto 攔截率 | 0% | 每日 5–15 個 token 被 veto |
| NEWBORN 過時攔截 | 0% | 明顯減少 > 90 分鐘持倉 |
| Rugpull 出場次數/週 | ~4 次 | < 2 次 |

**勝率未達 38% 唔進行 Sprint 2，繼續觀察並 review 參數。**

---

# SPRINT 2：Graduation Momentum 策略（目標勝率 48%+）

Sprint 2 係最核心嘅策略改變，分三步：2A、2B、2C。

---

## 2A：sourceAggregator 識別 Graduation 事件

### 問題
`sourceAggregator.js` 監聽緊 `RAYDIUM_V4_PROGRAM_ID`，但只處理 `InitializeMint`。Pump.fun → Raydium 的 Graduation 係獨立事件，需要專門識別並廣播。

### 目標檔案
```
src/services/sourceAggregator.js — ws.on('message') 處理區段
```

### 改動位置
喺現有 `isCreation` 和 `isBurn` 判斷旁邊，加入 `isGraduation` 識別：

```javascript
// 現有邏輯保持不變
const isCreation = logsStr.includes('InitializeMint') || 
                   logsStr.includes('CreatePool') || 
                   logsStr.includes('InitializeInstruction2');
const isBurn = logsStr.includes('Instruction: Burn') || 
               logsStr.includes('1nc1nerator');

// 🎓 [Strategy Surgery 2A] 新增：Graduation 事件識別
// Pump.fun → Raydium 的 migration 特徵：
// - 係 Raydium V4 program 的 transaction
// - 包含 InitializeInstruction2（Raydium pool 初始化）
// - 但唔係單純新幣 mint（排除 InitializeMint）
const isGraduation = logsStr.includes('InitializeInstruction2') && 
                     !logsStr.includes('InitializeMint') &&
                     programIds.includes(RAYDIUM_V4_PROGRAM_ID);

if (isGraduation) {
    const isSeen = await redis.set(`seen_grad:${signature}`, '1', 'EX', 3600, 'NX');
    if (!isSeen) return;

    const txInfo = await connection.getTransaction(signature, { 
        maxSupportedTransactionVersion: 0, 
        commitment: "confirmed" 
    }).catch(() => null);

    if (!txInfo) return;

    const accounts = txInfo?.transaction?.message?.accountKeys || [];
    const potentialMints = accounts
        .map(a => a.pubkey ? a.pubkey.toString() : a.toString())
        .filter(k => k && !this.blacklist.includes(k) && k.length > 32);

    for (const mint of potentialMints) {
        const cleanMint = this.sanitizeAddress(mint);
        if (cleanMint) {
            const graduatedAt = Date.now();
            
            // 寫入 Redis（TTL 2 小時）
            await redis.set(`graduated:${cleanMint}`, graduatedAt.toString(), 'EX', 7200);
            
            // 廣播 graduation 事件
            await redis.publish('graduation_alerts', JSON.stringify({ 
                mint: cleanMint,
                graduatedAt,
                signature
            }));
            
            console.log(`\n🎓 [Graduation] 捕捉到畢業事件！${cleanMint} 從 Pump.fun → Raydium，廣播入場訊號...`);
            break; // 一個 tx 只處理一個 mint
        }
    }
}
```

### 驗收條件
- [ ] Log 中出現 `[Graduation]` 記錄
- [ ] Redis 中出現 `graduated:{mint}` key
- [ ] `graduation_alerts` channel 有廣播訊息

---

## 2B：trade_frontline 訂閱 Graduation Alerts

### 問題
Graduation 廣播出嚟之後，需要 trade_frontline.js 訂閱並即時送入決策漏斗。

### 目標檔案
```
src/microservices/trade_frontline.js
```

### 改動位置
喺現有 `lp_burn_alerts` 訂閱旁邊，加入 `graduation_alerts` 訂閱：

```javascript
// 現有 lp_burn_alerts 訂閱保持不變
redisSubscriber.subscribe('lp_burn_alerts');

// 🎓 [Strategy Surgery 2B] 新增：Graduation alerts 訂閱
redisSubscriber.subscribe('graduation_alerts');
```

喺現有 `redisSubscriber.on('message', ...)` 的 handler 入面，加入 graduation 處理：

```javascript
redisSubscriber.on('message', async (channel, message) => {
    // 現有 lp_burn_alerts 處理保持不變
    if (channel === 'lp_burn_alerts') {
        // ... 現有邏輯 ...
    }

    // 🎓 [Strategy Surgery 2B] Graduation 入場處理
    if (channel === 'graduation_alerts') {
        try {
            const { mint, graduatedAt } = JSON.parse(message);
            const symbol = symbol_cache.get(mint) || 'UNKNOWN';

            console.log(`\n🎓 [Graduation Alert] 接收到 ${symbol} 畢業訊號，即時查價並送入決策漏斗...`);

            // 等 5 秒讓 Raydium pool 穩定
            await new Promise(resolve => setTimeout(resolve, 5000));

            // 查 DexScreener 取得最新數據
            await redisClient.set('DEXSCREENER_LOCK', 'GRADUATION', 'EX', 10);
            const res = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mint}`, 
                { timeout: 4000 }
            );
            const pair = res.data?.pairs?.sort(
                (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
            )[0];

            if (pair && pair.priceUsd && pair.liquidity?.usd >= 10000) {
                const marketData = {
                    p: parseFloat(pair.priceUsd),
                    v: pair.volume?.m5 || 0,
                    b: pair.txns?.m5?.buys || 0,
                    s: pair.txns?.m5?.sells || 0,
                    l: pair.liquidity?.usd || 0,
                    ts: Date.now(),
                    description: pair.info?.description || pair.baseToken?.name || '',
                    symbol: pair.baseToken?.symbol || symbol,
                    name: pair.baseToken?.name || 'UNKNOWN',
                    fdv: pair.fdv || 0,
                    h1: parseFloat(pair.priceChange?.h1) || 0,
                    hasSocials: (pair.info?.socials?.length > 0 || pair.info?.websites?.length > 0),
                    pairCreatedAt: pair.pairCreatedAt || graduatedAt
                };

                latest_market_data.set(mint, marketData);
                symbol_cache.set(mint, pair.baseToken?.symbol || symbol);

                // 以 NEWBORN 類型送入決策漏斗
                await processAsymmetricRouting(mint, 'NEWBORN');
            } else {
                console.log(`💀 [Graduation] ${symbol} 畢業後流動性不足 ($${pair?.liquidity?.usd || 0})，放棄`);
            }
        } catch (err) {
            console.warn(`⚠️ [Graduation Alert] 處理失敗: ${err.message}`);
        }
    }
});
```

### 驗收條件
- [ ] `graduation_alerts` 訂閱成功（啟動 log 確認）
- [ ] 接收到 graduation 廣播後，log 出現 `[Graduation Alert]`
- [ ] 成功查到 pair 後送入 `processAsymmetricRouting`
- [ ] 流動性 < $10,000 的 graduation 被放棄

---

## 2C：Graduation Timing Window + SecurityGuard Bonus

### 問題
Graduation 後唔係任何時間都適合入場。最佳窗口係 graduation 後 3–20 分鐘，在此窗口內入場的 token 應獲得 SecurityGuard 加分。

### 目標檔案
```
src/services/securityGuard.js — calculateQuantScore() 函數
```

### 改動位置
喺 Sprint 1C 的 LP Burn Bonus 之後，加入：

```javascript
// 🎓 [Strategy Surgery 2C] Graduation Timing Window
try {
    const graduatedAtStr = await redisClient.get(`graduated:${mint}`);
    if (graduatedAtStr) {
        const minsSinceGrad = (Date.now() - parseInt(graduatedAtStr)) / 60000;

        // 太早（< 3 分鐘）：Raydium pool 未完全穩定
        if (minsSinceGrad < 3) {
            return {
                numeric_score: 0, isSafe: false,
                reason: `⏳ Graduation 太早 (${minsSinceGrad.toFixed(1)}m)，等待 pool 穩定`,
                marketData, applied_ml_strategy_id: targetParam?.id || 0
            };
        }

        // 最佳窗口（3–20 分鐘）：Graduation momentum 加分
        if (minsSinceGrad <= 20) {
            const gradBonus = Math.round(5 * (1 - minsSinceGrad / 20)); // 3min=+4, 10min=+2, 20min=0
            const actualBonus = Math.max(1, gradBonus);
            const prevScore = coreScore;
            coreScore = Math.min(20, coreScore + actualBonus);
            reasons.push(`🎓 Graduation 窗口 ${minsSinceGrad.toFixed(0)}m (+${coreScore - prevScore}分)`);
            console.log(`🎓 [Grad Bonus] ${marketData.symbol} Graduation ${minsSinceGrad.toFixed(0)} 分鐘前，+${coreScore - prevScore}分`);
        }

        // 窗口關閉（> 20 分鐘）：正常評估，唔加分也唔扣分
    }
} catch (e) {
    // Redis 失敗唔阻止正常流程
}
```

### 驗收條件
- [ ] Graduation 後 < 3 分鐘被攔截：`⏳ Graduation 太早`
- [ ] Graduation 後 3–20 分鐘出現 `[Grad Bonus]` log
- [ ] Graduation 後 > 20 分鐘正常評估（無 bonus 也無 penalty）
- [ ] `coreScore` 唔超過 20

---

## Sprint 2 整體驗收 KPI（PAPER 模式跑 4 週）

| 指標 | Sprint 2 前 | Sprint 2 目標 |
|---|---|---|
| 勝率 | ≥ 38% | ≥ 48% |
| Graduation trade 比例 | 0% | ≥ 30% 嘅 NEWBORN trade |
| Graduation trade 勝率 | N/A | ≥ 55% |
| 平均持倉時間（贏家） | N/A | 15–45 分鐘 |

**勝率未達 48% 唔進行 Sprint 3，review Graduation 識別邏輯是否正確。**

---

# SPRINT 3：ML Brain 重新訓練（目標勝率 55%+）

Sprint 3 分三步：3A（SQL）、3B（trade_frontline）、3C（ml_engine）。

---

## 3A：清理 trade_patterns 並新增欄位

### SQL（在 Supabase 執行）

```sql
-- Step 1：新增時間特徵欄位
ALTER TABLE trade_patterns 
ADD COLUMN IF NOT EXISTS token_age_at_entry_mins FLOAT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS mins_since_graduation    FLOAT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS had_lp_burn              BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS entry_volume_5m_usd      FLOAT DEFAULT 0;

-- Step 2：統一現有 volume 欄位（entry_volume_5m → entry_volume_5m_usd）
UPDATE trade_patterns 
SET entry_volume_5m_usd = entry_volume_5m 
WHERE entry_volume_5m_usd = 0 AND entry_volume_5m > 0;

-- Step 3：清理垃圾訓練數據
-- 刪走冇 entry data 的記錄（唔係 ML 訓練用嘅 Poison Data 記錄）
DELETE FROM trade_patterns
WHERE (entry_liquidity_usd = 0 OR entry_liquidity_usd IS NULL)
  AND (entry_volume_5m_usd = 0 OR entry_volume_5m_usd IS NULL)
  AND realized_pnl_pct != -100.00; -- 保留 Poison Data 記錄（負樣本）

-- Step 4：清理 UNKNOWN climate 記錄（無效訓練數據）
DELETE FROM trade_patterns
WHERE market_climate = 'UNKNOWN'
  AND realized_pnl_pct BETWEEN -5 AND 5; -- 只刪平手記錄，極端值保留

-- Step 5：確認清理結果
SELECT 
    market_climate,
    COUNT(*) as count,
    AVG(realized_pnl_pct) as avg_pnl,
    SUM(CASE WHEN realized_pnl_pct > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate
FROM trade_patterns
GROUP BY market_climate
ORDER BY count DESC;
```

### 驗收條件
- [ ] `token_age_at_entry_mins` 欄位存在
- [ ] `mins_since_graduation` 欄位存在
- [ ] `had_lp_burn` 欄位存在
- [ ] `market_climate = 'UNKNOWN'` 記錄大幅減少
- [ ] 剩餘記錄的 `entry_liquidity_usd > 0`（除 Poison Data）

---

## 3B：trade_frontline 寫入新特徵

### 目標檔案
```
src/services/tradeService.js — supabase.from('trade_patterns').insert()
```

### 改動位置
搵到現有 `trade_patterns` insert 語句，加入新欄位：

```javascript
// 喺 insert 前計算新特徵
const tokenAgeMins = marketData?.pairCreatedAt 
    ? (Date.now() - marketData.pairCreatedAt) / 60000 
    : null;

let minsSinceGrad = null;
try {
    const graduatedAtStr = await redis.get(`graduated:${position.mint_address}`);
    if (graduatedAtStr) {
        // 用買入時間計算（position.created_at），唔係 sell 時間
        const entryTime = position.created_at 
            ? new Date(position.created_at).getTime() 
            : Date.now();
        minsSinceGrad = (entryTime - parseInt(graduatedAtStr)) / 60000;
    }
} catch (e) {}

let hadLpBurn = false;
try {
    const lpBurned = await redis.get(`lp_burned:${position.mint_address}`);
    hadLpBurn = lpBurned === 'TRUE';
} catch (e) {}

// 現有 insert 加入新欄位
await supabase.from('trade_patterns').insert([{
    // ... 現有欄位保持不變 ...
    mint_address: mint,
    is_shadow: false,
    strategy_version: position.strategy_type || 'v10_default',
    entry_ofi: position.entry_ofi || 0,
    entry_liquidity_usd: position.entry_liquidity_usd || 0,
    entry_volume_5m_usd: position.entry_volume_5m_usd || 0, // 統一欄位名
    max_vwap_deviation: position.max_vwap_dev || 0,
    final_cvd_slope: position.final_cvd_slope || 0,
    realized_pnl_pct: realizedPnlPct,
    market_climate: climate,
    entry_price_sol: entryPrice,
    entry_volume_5m: position.entry_volume_5m_usd || 0,
    token_symbol: position.token_symbol || 'UNKNOWN',
    applied_ml_strategy_id: position.applied_ml_strategy_id,
    // 🆕 Sprint 3 新增欄位
    token_age_at_entry_mins: tokenAgeMins,
    mins_since_graduation: minsSinceGrad,
    had_lp_burn: hadLpBurn
}]);
```

### 同時更新 active_positions 買入記錄
喺 `executeBuy()` 或 `active_positions` insert 時，加入需要的特徵以便 sell 時讀取：

```javascript
// 喺 active_positions insert 時加入
{
    // ... 現有欄位 ...
    entry_volume_5m_usd: marketData.v || 0, // 新增：統一欄位名
    // pairCreatedAt 不需要存，sell 時從 Redis 查
}
```

### 驗收條件
- [ ] `trade_patterns` 新記錄的 `token_age_at_entry_mins` 有值（唔係 null）
- [ ] Graduation trade 的 `mins_since_graduation` 有值
- [ ] LP Burn trade 的 `had_lp_burn = true`

---

## 3C：ml_engine 加入新特徵

### 目標檔案
```
ml_engine/main.py
```

### 改動一：FeaturePayload 加入新欄位

搵到 `class FeaturePayload(BaseModel):`，加入新欄位：

```python
class FeaturePayload(BaseModel):
    p: float = Field(..., ge=0.0)
    v: float = Field(..., ge=0.0)
    b: int = Field(..., ge=0)
    s: int = Field(..., ge=0)
    l: float = Field(..., ge=0.0)
    ts: int = Field(..., gt=0)
    # 🆕 Sprint 3 新增特徵（optional，向後兼容）
    token_age_mins: float = Field(default=999.0, ge=0.0)
    mins_since_graduation: float = Field(default=-1.0)  # -1 = 未 graduate
    had_lp_burn: bool = Field(default=False)
```

### 改動二：predict_score 加入新特徵

搵到：
```python
X_live = pd.DataFrame([[ofi, f.l, f.v]], columns=['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd'])
```

替換成：
```python
# 🆕 [Strategy Surgery 3C] 加入時間特徵
# mins_since_graduation: -1 = 未 graduate，0-20 = 最佳窗口，>20 = 窗口關閉
grad_feature = f.mins_since_graduation if f.mins_since_graduation >= 0 else 999.0
lp_burn_feature = 1.0 if f.had_lp_burn else 0.0

X_live = pd.DataFrame([[
    ofi, 
    f.l,                    # entry_liquidity_usd
    f.v,                    # entry_volume_5m_usd
    f.token_age_mins,       # token_age_at_entry_mins
    grad_feature,           # mins_since_graduation (999 = 未 graduate)
    lp_burn_feature         # had_lp_burn (0/1)
]], columns=[
    'entry_ofi', 
    'entry_liquidity_usd', 
    'entry_volume_5m_usd',
    'token_age_mins',
    'mins_since_graduation',
    'had_lp_burn'
])

# 向後兼容：如果模型係舊版（只有3個特徵），fallback 到舊格式
try:
    survival_prob = rf_model.predict_proba(X_live)[0][1]
except ValueError:
    # 舊模型唔識新特徵，用舊格式 fallback
    X_fallback = pd.DataFrame([[ofi, f.l, f.v]], 
                               columns=['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd'])
    survival_prob = rf_model.predict_proba(X_fallback)[0][1]
    print(f"⚠️ [ML] 模型未更新，使用舊版特徵 fallback")
```

### 改動三：train_model_if_valid 加入新特徵

搵到：
```python
def train_model_if_valid(train_df, path):
    if len((train_df['realized_pnl_pct'] > 0).unique()) > 1:
        rf = RandomForestClassifier(...)
        rf.fit(train_df[['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']], ...)
```

替換成：
```python
def train_model_if_valid(train_df, path):
    if len((train_df['realized_pnl_pct'] > 0).unique()) > 1:
        # 🆕 [Strategy Surgery 3C] 新特徵列表
        base_features = ['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']
        new_features = ['token_age_at_entry_mins', 'mins_since_graduation', 'had_lp_burn']
        
        # 檢查新欄位係咪存在（新數據積累後先有）
        available_features = base_features.copy()
        for feat in new_features:
            if feat in train_df.columns:
                col_data = pd.to_numeric(train_df[feat], errors='coerce').fillna(-1)
                if col_data.notna().sum() > len(train_df) * 0.3:  # 30% 以上有值先加
                    train_df[feat] = col_data
                    available_features.append(feat)
        
        print(f"🌲 [ML] 訓練特徵: {available_features}")
        
        rf = RandomForestClassifier(
            n_estimators=int(params.get('rf_n_estimators', 100)),
            max_depth=int(params.get('rf_max_depth', 5)),
            random_state=42, n_jobs=1, class_weight="balanced"
        )
        rf.fit(
            train_df[available_features], 
            (train_df['realized_pnl_pct'] > 0).astype(int),
            sample_weight=train_df['w_time']
        )
        joblib.dump(rf, path)
        
        # 記錄訓練用嘅特徵列表，predict 時需要對應
        import json
        feature_meta_path = path.replace('.pkl', '_features.json')
        with open(feature_meta_path, 'w') as f_meta:
            json.dump(available_features, f_meta)
        
        return True
    return False
```

### 改動四：predict_score 讀取 feature metadata

喺 `predict_score` 的模型載入部分，加入 feature metadata 讀取：

```python
if os.path.exists(target_model_path):
    try:
        rf_model = joblib.load(target_model_path)
        
        # 讀取訓練時用嘅特徵列表
        import json
        feature_meta_path = target_model_path.replace('.pkl', '_features.json')
        if os.path.exists(feature_meta_path):
            with open(feature_meta_path) as f_meta:
                trained_features = json.load(f_meta)
        else:
            trained_features = ['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']
        
        # 準備對應特徵
        grad_feature = f.mins_since_graduation if f.mins_since_graduation >= 0 else 999.0
        lp_burn_feature = 1.0 if f.had_lp_burn else 0.0
        
        all_features = {
            'entry_ofi': ofi,
            'entry_liquidity_usd': f.l,
            'entry_volume_5m_usd': f.v,
            'token_age_at_entry_mins': f.token_age_mins,
            'mins_since_graduation': grad_feature,
            'had_lp_burn': lp_burn_feature
        }
        
        X_live = pd.DataFrame([[all_features[feat] for feat in trained_features]], 
                               columns=trained_features)
        survival_prob = rf_model.predict_proba(X_live)[0][1]
        
    except Exception as e:
        print(f"⚠️ [Predict] 模型推論異常 ({req.type}): {e}")
```

### 驗收條件
- [ ] ML Engine 啟動時無 crash（向後兼容 fallback 正常）
- [ ] 第一次 ML 訓練後，log 顯示 `訓練特徵: ['entry_ofi', ...]`（新特徵逐步加入）
- [ ] `predict` endpoint 正常回應，唔因新特徵報錯
- [ ] 新舊模型 fallback 機制正常

---

## Sprint 3 整體驗收 KPI（PAPER 模式跑 2 週）

| 指標 | Sprint 3 前 | Sprint 3 目標 |
|---|---|---|
| 勝率 | ≥ 48% | ≥ 55% |
| ML Brain 特徵數 | 3 | 6（逐步增加） |
| EV per trade | 負數 | > 0 |
| `trade_patterns` 數據質量 | 含大量 UNKNOWN | 90%+ 有完整 entry data |

---

## LIVE 部署 Gate

**以下條件全部達到才執行 LIVE 模式：**

| Gate | 條件 |
|---|---|
| G1 | PAPER 連續 4 週勝率 ≥ 50% |
| G2 | PAPER EV per trade > +2% |
| G3 | 連續 2 週無 −100% Rugpull 出場 |
| G4 | ML Brain 訓練樣本 ≥ 200 筆乾淨數據 |
| G5 | LIVE 首 2 週以 0.05 SOL/trade 試水 |

**G1–G4 全部達到前，system_config 的 trade_mode 保持 PAPER。**

---

## Claude Code 執行注意事項

1. **先 READ 後 WRITE**：每個改動前，先閱讀完整函數，確認變數名稱一致
2. **Sprint 順序唔可跳**：Sprint 2 依賴 Sprint 1 的 LP Burn Redis key；Sprint 3 依賴 Sprint 2 的 graduation data
3. **每個 Sprint 分開 commit**：方便個別 rollback
4. **新欄位向後兼容**：3B 的 insert 新欄位必須係 optional（null-safe），唔能 break 現有流程
5. **ML Engine fallback**：3C 改動必須保留舊格式 fallback，確保模型重新訓練前系統正常運作

---

*Brief 由 SOL Quant Research Agent 生成 | 基於 170 筆 Paper Trade 分析及完整代碼審閱*  
*策略目標：從 28.8% 勝率推至 55%+，EV 轉正，達成 LIVE 部署條件*