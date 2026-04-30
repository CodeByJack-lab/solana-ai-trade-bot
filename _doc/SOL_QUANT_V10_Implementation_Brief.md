# SOL QUANT HUNTER V10 — Implementation Brief
**Version:** R1.0 | **Date:** 2026-04-29  
**Prepared by:** SOL Quant Research Agent  
**Target executor:** Claude Code (Dokploy environment)

---

## 背景摘要

根據 170 筆 Paper Trade 歷史分析：
- 現時勝率：**28.8%**，EV per trade：**−10.3%**
- 最大問題：Rugpull 無防護、BULL_FRENZY 閾值反效果、Monitor 守護進程可靜默死亡
- 目標：P0 修復後勝率達 **36–42%**；P1 完整後達 **48–56%**

---

## 絕對限制（任何修改都不得違反）

在動任何一行代碼前，必須遵守以下規則：

1. **禁止 Shadow Route**：任何地方一律 `is_shadow: false`，不得引用 `active_positions_shadow`
2. **禁止直接注入 finalScore**：所有信號改善必須流經 SecurityGuard `numeric_score`（0–20）、Bayes Factor 函數、或 Kelly multiplier。不得直接加減 finalScore
3. **Kelly 上下限**：`kellyMultiplier` 必須 `clamp(0.1, 3.0)`；`safeKelly = fStar × 0.25` 為最大值
4. **Mistral Mutex**：所有新增 Mistral API 呼叫必須經過 `keyRotator.runWithKey('MISTRAL', ...)`
5. **Sell Lock finally**：所有獲取 `sell_lock:{mint}` 的 sell 操作必須在 `finally` 區塊釋放鎖
6. **DexScreener 限速**：`DEX_COOLDOWN_MS = 1000`，不得繞過
7. **JSON 防禦**：所有 LLM 回應解析必須使用 regex `content.match(/\{[\s\S]*\}/)`
8. **預設值下限**（不得跌穿）：

   | 變數 | 預設值 | 允許範圍 |
   |---|---|---|
   | buyThreshold | 70 | 60–85 |
   | dynamicSL | −15.0% | −10% to −25% |
   | dynamicTP | 20.0% | 15% to 40% |
   | kellyFraction | 0.25 | 0.10–0.35 |
   | priorProb fallback | 0.50 | 0.1–0.9 |

---

## 修復項目

修復項目共分兩批：**P0（必須先完成）** 和 **P1（P0 完成後進行）**。

---

# P0 修復（優先順序最高，必須最先執行）

---

## P0-1：BEEKEEPER Bug — Monitor 守護進程

### 問題
BEEKEEPER 持倉 1,048 分鐘（17.5 小時）才以 −100% 出場。`monitor_guards.js` 的監控 loop 靜默死亡，DEFCON check 完全未觸發。這是最緊急的資金安全漏洞。

### 目標檔案
```
monitor_guards.js（Dokploy mainbot repo）
```

### 需要新增的函數：`startPositionWatchdog()`

在 `monitor_guards.js` 的主啟動函數末端，新增一個獨立的 watchdog setInterval，邏輯如下：

```javascript
// 新增於 monitor_guards.js 底部，在主啟動函數內呼叫
function startPositionWatchdog() {
  const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分鐘執行一次
  const STALE_THRESHOLD_MS   = 15 * 60 * 1000; // 超過 15 分鐘無 price update = 失聯

  setInterval(async () => {
    try {
      const tradeMode = globalConfig?.trade_mode || 'PAPER';
      const tableName = tradeMode === 'LIVE' ? 'active_positions_live' : 'active_positions_paper';

      const { data: positions, error } = await supabase
        .from(tableName)
        .select('id, mint_address, token_symbol, entry_price_sol, created_at');

      if (error || !positions || positions.length === 0) return;

      const now = Date.now();

      for (const pos of positions) {
        const mint = pos.mint_address;

        // 從 Redis 取得最後一次 price update 的時間戳
        const lastPriceRaw = await redis.get(`last_price_ts:${mint}`);
        const lastPriceTs  = lastPriceRaw ? parseInt(lastPriceRaw) : null;

        // 計算持倉年齡（分鐘）
        const ageMs  = now - new Date(pos.created_at).getTime();
        const ageMins = Math.floor(ageMs / 60000);

        // 條件：持倉超過 5 分鐘 + 超過 15 分鐘冇收到 price update
        const isStale = lastPriceTs
          ? (now - lastPriceTs) > STALE_THRESHOLD_MS
          : ageMins > 15;

        if (isStale) {
          console.error(
            `🚨 [WATCHDOG] ${pos.token_symbol || mint} 已失聯 ` +
            `${lastPriceTs ? Math.floor((now - lastPriceTs) / 60000) : ageMins} 分鐘！` +
            ` 強制執行 EMERGENCY_SELL。`
          );

          // 以持倉入場價的 1% 作為 emergency price（象徵性，觸發出場邏輯）
          // 實際 sell 邏輯沿用現有 executeSell()，傳入 DEFCON reason
          await triggerEmergencySell(mint, pos.entry_price_sol * 0.01, 'WATCHDOG_STALE_PRICE');
        }
      }
    } catch (err) {
      console.error(`❌ [WATCHDOG] 執行錯誤: ${err.message}`);
    }
  }, WATCHDOG_INTERVAL_MS);

  console.log('🐕 [WATCHDOG] 持倉守護進程已啟動（每 10 分鐘巡邏）');
}
```

### `triggerEmergencySell()` 新增函數

```javascript
// 緊急出場函數，沿用現有 sell 架構
async function triggerEmergencySell(mint, emergencyPrice, reason) {
  const lockKey = `sell_lock:${mint}`;
  const lock = await redis.set(lockKey, '1', 'EX', 30, 'NX');
  if (!lock) {
    console.warn(`⚠️ [WATCHDOG] ${mint} sell_lock 已被佔用，跳過。`);
    return;
  }
  try {
    // 以 reason 作為 sell trigger，price 用 emergencyPrice
    // 呼叫現有的 executeSell 或 performSell 函數（視乎 monitor_guards.js 現有命名）
    // 請 Claude Code 自行對應現有函數名稱
    await executeSell(mint, emergencyPrice, reason, -99.9);
  } catch (err) {
    console.error(`❌ [WATCHDOG] Emergency sell 失敗 ${mint}: ${err.message}`);
  } finally {
    await redis.del(lockKey); // 必須在 finally 釋放鎖
  }
}
```

### Redis Key 新增
在 `priceBot.js` 的 broadcast 區段（`redis.publish` 之後），為每個成功拿到報價的 mint 更新時間戳：

```javascript
// 在 redis.publish('price_updates', ...) 成功後加入：
const tsPipeline = redis.pipeline();
finalKeys.forEach(mint => {
  tsPipeline.set(`last_price_ts:${mint}`, Date.now().toString(), 'EX', 3600);
});
await tsPipeline.exec();
```

### 驗收條件
- [ ] Watchdog log 在啟動時出現：`🐕 [WATCHDOG] 持倉守護進程已啟動`
- [ ] 在 PAPER 模式下，手動將一個 `active_positions_paper` 的 `created_at` 設為 20 分鐘前，並停止 priceBot，等待 10 分鐘，確認 watchdog 觸發 emergency sell log
- [ ] `sell_lock` 在 finally 區塊釋放，確認冇 lock 洩漏

---

## P0-2：BULL_FRENZY 閾值反轉

### 問題
數據顯示 BULL_FRENZY 勝率只有 4.3%（22/23 筆虧損），但現有系統在此 climate 反而降低 buyThreshold、提高 Kelly。邏輯完全反轉。

### 目標檔案
```
Supabase 表：ml_strategy_params
（可通過 Supabase dashboard 或 SQL 直接修改，不需改代碼）
```

### 需要執行的 SQL

```sql
-- 更新 TRENDING × BULL_FRENZY 的策略參數
UPDATE ml_strategy_params
SET
  buy_threshold     = 78,    -- 從現有值提高到 78（原預設 70）
  dynamic_sl        = -12.0, -- 收緊 SL：-12%（原 -15%）
  kelly_fraction    = 0.15,  -- 降低 Kelly：0.15（原 0.25）
  time_limit_mins   = 45     -- 縮短時間：45 分鐘（原 60 分鐘）
WHERE
  token_type    = 'TRENDING'
  AND climate   = 'BULL_FRENZY';

-- 確認更新
SELECT token_type, climate, buy_threshold, dynamic_sl, kelly_fraction, time_limit_mins
FROM ml_strategy_params
WHERE climate = 'BULL_FRENZY';
```

### 代碼防護（trade_frontline.js）

在讀取 `ml_strategy_params` 之後、執行買入之前，加入以下 guard：

```javascript
// 在 trade_frontline.js 的策略參數讀取區段加入
// 找到讀取 ml_strategy_params 的位置，在其後加入：

if (marketClimate === 'BULL_FRENZY') {
  // BULL_FRENZY 資料驗證：防止錯誤參數導致過度激進
  strategyParams.buy_threshold   = Math.max(strategyParams.buy_threshold ?? 70, 75);
  strategyParams.kelly_fraction  = Math.min(strategyParams.kelly_fraction ?? 0.25, 0.20);
  console.log(`🛡️ [BULL_FRENZY Guard] 已強制套用保守參數：threshold=${strategyParams.buy_threshold}, kelly=${strategyParams.kelly_fraction}`);
}
```

### 驗收條件
- [ ] SQL 更新後，`SELECT` 確認 BULL_FRENZY 行的 `buy_threshold = 78`
- [ ] 在 PAPER 模式跑 24 小時，確認 BULL_FRENZY 期間的 log 出現 `[BULL_FRENZY Guard]`
- [ ] 無新增 BULL_FRENZY 持倉在 finalScore < 78 的情況下被買入

---

## P0-3：LP Burn Pre-Filter（SecurityGuard）

### 問題
25 筆 Rugpull/pool-gone 出場，估計超過 4 SOL 損失。LP 未 burn 係最直接的 rug 信號，需在 SecurityGuard 階段攔截。

### 目標檔案
```
trade_frontline.js（Dokploy mainbot repo）
SecurityGuard 函數內（計算 numeric_score 的地方）
```

### 新增函數：`checkLpBurnStatus()`

```javascript
/**
 * 檢查 LP Burn 狀態
 * 回傳 { burned: boolean, burnPct: number, penaltyPts: number }
 * 資料來源：DexScreener pair 資料（已在 SecurityGuard 中取得）
 *
 * 注意：此函數從現有 DexScreener payload 提取資料，
 *       不發出額外 API 請求（遵守 DEX_COOLDOWN_MS 限制）
 */
function checkLpBurnStatus(dexPairData) {
  try {
    // DexScreener 的 liquidity.base / liquidity.usd 可推算 LP 健康度
    // 若 pair 存在且 liquidity > 0，視為有基本 LP
    const liquidity = parseFloat(dexPairData?.liquidity?.usd || 0);
    const pairAge   = dexPairData?.pairCreatedAt
      ? (Date.now() - dexPairData.pairCreatedAt) / 1000 / 60  // 分鐘
      : 9999;

    // 若 pair 年齡 < 5 分鐘且流動性 < $5,000：高危新幣，扣 8 分
    if (pairAge < 5 && liquidity < 5000) {
      return { riskLevel: 'HIGH', penaltyPts: 8, reason: '超新幣 + 低流動性' };
    }

    // 若流動性 < $1,000：流動性枯竭，扣 10 分（接近 rug 狀態）
    if (liquidity < 1000) {
      return { riskLevel: 'CRITICAL', penaltyPts: 10, reason: '流動性極低' };
    }

    // 若流動性 < $5,000：警戒，扣 4 分
    if (liquidity < 5000) {
      return { riskLevel: 'MEDIUM', penaltyPts: 4, reason: '流動性偏低' };
    }

    // 正常
    return { riskLevel: 'OK', penaltyPts: 0, reason: '' };
  } catch (err) {
    console.warn(`⚠️ [LP Check] 解析失敗: ${err.message}`);
    return { riskLevel: 'UNKNOWN', penaltyPts: 2, reason: '無法驗證' };
  }
}
```

### 整合到 SecurityGuard numeric_score

在 SecurityGuard 計算 `numeric_score` 的函數內，加入：

```javascript
// 在現有 numeric_score 計算區段末尾加入（注意：總分上限仍為 20）

const lpCheck = checkLpBurnStatus(dexPairData);
if (lpCheck.penaltyPts > 0) {
  numericScore = Math.max(0, numericScore - lpCheck.penaltyPts);
  console.log(`🔥 [LP Filter] ${tokenSymbol} LP 風險 ${lpCheck.riskLevel}：扣 ${lpCheck.penaltyPts} 分 (${lpCheck.reason})`);
}

// 硬性攔截：CRITICAL 風險直接拒絕，不進入後續流程
if (lpCheck.riskLevel === 'CRITICAL') {
  console.log(`🚫 [LP Filter] ${tokenSymbol} 流動性極低，直接拒絕入場。`);
  return { passed: false, reason: 'LP_CRITICAL', numeric_score: numericScore };
}
```

### 驗收條件
- [ ] Log 中出現 `[LP Filter]` 字樣
- [ ] 流動性 < $1,000 的 token 被 `LP_CRITICAL` 攔截，不出現在 `active_positions_paper`
- [ ] `numeric_score` 不超過 20（上限保持不變）
- [ ] 沒有額外的 DexScreener API 請求（確認 rate limit 未被突破）

---

# P1 修復（P0 全部完成並驗收後，才執行）

---

## P1-1：MAE-Calibrated 動態 Time-Stop

### 問題
現有 60 分鐘 time-stop 在 −8.4% 平均 PnL 下出場（35% 勝率），等於帶著虧損白坐 60 分鐘。應改為按 PnL 動態判斷動能是否已死。

### 目標檔案
```
monitor_guards.js — checkTimeStop() 函數（或現有 time-stop 邏輯所在位置）
```

### 修改現有 time-stop 邏輯

找到現有 time-stop 判斷（通常係 `age >= timeLimit && pnlPct < requiredPnlPct`），在其前面插入早期退出判斷：

```javascript
// 在現有 time-stop 判斷之前加入以下早期退出邏輯：

// === MAE-Calibrated 早期動能衰退偵測 ===
const ageMins = Math.floor((Date.now() - entryTime) / 60000);

// 第 1 道：持倉超過 15 分鐘，PnL < -5% → 動能已死，立即出場
if (ageMins >= 15 && ageMins < 60 && pnlPct < -5.0) {
  console.log(`✂️ [MAE Stop] ${tokenSymbol} 持倉 ${ageMins}m，PnL ${pnlPct.toFixed(1)}% < -5%，動能衰退，提早出場`);
  return { shouldSell: true, reason: `MAE_EARLY_EXIT_15M`, trigger: 'MAE_TIMESTOP' };
}

// 第 2 道：持倉超過 30 分鐘，PnL < -2% → 橫行無動能，出場
if (ageMins >= 30 && ageMins < 60 && pnlPct < -2.0) {
  console.log(`✂️ [MAE Stop] ${tokenSymbol} 持倉 ${ageMins}m，PnL ${pnlPct.toFixed(1)}% < -2%，橫行確認，提早出場`);
  return { shouldSell: true, reason: `MAE_EARLY_EXIT_30M`, trigger: 'MAE_TIMESTOP' };
}

// 第 3 道：原有 60 分鐘 time-stop（保持不變，作為最後保底）
// ... 現有邏輯繼續 ...
```

### 驗收條件
- [ ] Log 中出現 `[MAE Stop]` 字樣
- [ ] PAPER 模式下，確認有持倉在 30 分鐘前出場（而非固定 60 分鐘）
- [ ] 現有 60 分鐘 time-stop 仍然存在作為保底
- [ ] 不影響盈利中的持倉（PnL > 0 的持倉不受 MAE Stop 影響）

---

## P1-2：Trailing Stop 替代固定 TP

### 問題
只有 2 次 TP 出場（170 筆中），平均贏幅被封頂在 19.5%。EVA（+60%）就係靠 CVD 信號出場，唔係固定 TP。需要加入 trailing stop 讓贏家跑更遠。

### 目標檔案
```
monitor_guards.js — checkTakeProfit() 或 TP milestone 判斷區段
active_positions_paper / active_positions_live 表（可能需要新增欄位）
```

### Supabase 新增欄位

```sql
-- 為兩個 active positions 表新增 trailing stop 追蹤欄位
ALTER TABLE active_positions_paper
  ADD COLUMN IF NOT EXISTS highest_pnl_pct   FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trailing_stop_pct FLOAT DEFAULT NULL;

ALTER TABLE active_positions_live
  ADD COLUMN IF NOT EXISTS highest_pnl_pct   FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trailing_stop_pct FLOAT DEFAULT NULL;
```

### 新增 Trailing Stop 邏輯

```javascript
// 在 monitor_guards.js 的 TP 判斷區段加入

async function checkTrailingStop(position, currentPnlPct) {
  const { mint_address, highest_pnl_pct = 0, trailing_stop_pct } = position;

  // 更新歷史最高 PnL
  if (currentPnlPct > highest_pnl_pct) {
    const tableName = globalConfig.trade_mode === 'LIVE'
      ? 'active_positions_live'
      : 'active_positions_paper';

    await supabase
      .from(tableName)
      .update({ highest_pnl_pct: currentPnlPct })
      .eq('mint_address', mint_address);
  }

  const peakPnl = Math.max(highest_pnl_pct, currentPnlPct);

  // Trailing Stop 只在 PnL 達到 +15% 後啟動
  if (peakPnl < 15.0) return { shouldSell: false };

  // 從峰值回落 8% → 觸發 trailing stop
  const trailingThreshold = peakPnl - 8.0;
  if (currentPnlPct < trailingThreshold) {
    console.log(
      `🏃 [Trailing Stop] ${position.token_symbol} 峰值 ${peakPnl.toFixed(1)}%，` +
      `現時 ${currentPnlPct.toFixed(1)}%，觸發 trailing stop`
    );
    return {
      shouldSell: true,
      reason: `TRAILING_STOP (peak: ${peakPnl.toFixed(1)}%, now: ${currentPnlPct.toFixed(1)}%)`,
      trigger: 'TRAILING_STOP'
    };
  }

  return { shouldSell: false };
}
```

### 整合到主監控迴圈

在現有 TP milestone 判斷後、time-stop 判斷前，加入：

```javascript
// 在 TP milestone 後加入（優先於 time-stop）
const trailingResult = await checkTrailingStop(position, pnlPct);
if (trailingResult.shouldSell) {
  return trailingResult;
}
```

### 驗收條件
- [ ] `active_positions_paper` 表有 `highest_pnl_pct` 欄位
- [ ] 持倉 PnL 達 +15% 後，`highest_pnl_pct` 開始被記錄
- [ ] 從 peak 回落 8% 時，log 出現 `[Trailing Stop]`
- [ ] PnL < 15% 的持倉不受 trailing stop 影響
- [ ] Trailing stop 在 Sell Priority 中排在 DEFCON/VWAP 之後，TP milestone 之前

---

## P1-3：BULL_FRENZY Climate 偵測精確度優化

### 問題
現有 `global_env_state` 的 BULL_FRENZY 判定太敏感，將正常的局部 pump 誤判為全市場 frenzy，導致過多 token 在危險 regime 下被買入。

### 目標檔案
```
trade_frontline.js 或 climate 判斷模組（視乎現有代碼結構）
Redis key：global_env_state
```

### 建議改動

找到寫入 `global_env_state = 'BULL_FRENZY'` 的地方，加入以下確認條件：

```javascript
// 現有 BULL_FRENZY 判定條件之後，加入多重確認：

function confirmBullFrenzy(existingSignals) {
  // 至少需要 2 個獨立信號同時確認，才判定為 BULL_FRENZY
  let confirmCount = 0;

  if (existingSignals.solPriceChange5m > 3.0)    confirmCount++; // SOL 5 分鐘漲幅 > 3%
  if (existingSignals.totalDexVolume > 1.5e9)     confirmCount++; // 全鏈 DEX 交易量 > 15億
  if (existingSignals.fearGreedIndex > 75)         confirmCount++; // 市場貪婪指數 > 75
  if (existingSignals.newTokensLaunched5m > 50)    confirmCount++; // 5分鐘新幣數 > 50

  // 只有 >= 2 個信號確認，才升級為 BULL_FRENZY
  if (confirmCount >= 2) {
    return 'BULL_FRENZY';
  }

  // 否則降級為 CHOPPY
  console.log(`🌡️ [Climate] BULL_FRENZY 信號不足（${confirmCount}/4），降級為 CHOPPY`);
  return 'CHOPPY';
}
```

**注意：** 如果現有 climate 系統冇以上所有信號，Claude Code 應根據現有可用數據挑選最相關的 2–3 個信號，邏輯保持「多重確認」原則即可。

### 驗收條件
- [ ] Log 出現 `[Climate]` 確認或降級訊息
- [ ] BULL_FRENZY 宣告頻率應比修改前降低（可對比 Redis key 的更新次數）

---

# 執行順序與注意事項

## 執行順序（必須按序）

```
P0-1 (Watchdog)  →  P0-2 (BULL_FRENZY SQL)  →  P0-3 (LP Filter)
       ↓
   PAPER 模式觀察 48 小時
       ↓
P1-1 (MAE Stop)  →  P1-2 (Trailing Stop)  →  P1-3 (Climate)
       ↓
   PAPER 模式觀察 7 天
       ↓
   如勝率達 40%+ → 考慮 LIVE 模式
```

## Claude Code 注意事項

1. **先 READ，後 WRITE**：每個修改前，先閱讀現有函數的完整代碼，確認函數名稱和參數格式，再動手修改
2. **變數名稱對應**：本 brief 使用的變數名（如 `pnlPct`、`executeSell`）可能與現有代碼不同，需自行對應
3. **Sell Priority 順序不得改變**：現有 sell trigger 優先順序（DEFCON > VWAP > CVD > TP > Time-stop）必須保持，新加的 MAE Stop 放在 TP 之後、regular Time-stop 之前
4. **不得改動 priceBot.js 的 broadcast 邏輯**，除了 P0-1 指定的 `last_price_ts` Redis 寫入
5. **每個 P0 項目完成後單獨 commit**，方便 rollback

## 驗收 KPI（整體）

| 指標 | 修改前 | P0 目標 | P1 目標 |
|---|---|---|---|
| 勝率 | 28.8% | 36–42% | 48–56% |
| 持倉失聯事件 | 曾發生（BEEKEEPER） | 0 | 0 |
| BULL_FRENZY 勝率 | 4.3% | > 20% | > 30% |
| Rugpull 出場次數/月 | ~8 次 | < 3 次 | < 1 次 |
| 平均持倉時間（輸家） | 60 min | < 35 min | < 25 min |

---

*Brief 由 SOL Quant Research Agent R1.0 生成 | 根據 170 筆 Paper Trade 數據分析*
