# SOL QUANT 策略手術 Sprint 1 完成檢查清單

## Sprint 1 實施狀態

### 1A: LLM 降格為 Veto-only
- [x] Log 中唔再出現 `bayesFactor = 2.0` 或 `bayesFactor = 1.5`（LLM 加分）
- [x] `llmScore < -2` 的 token 出現 `[LLM Veto]` log 並唔被買入
- [x] `llmScore >= -2` 的 token 的 `bayesFactor` 固定係 `1.0`
- [x] `llmFailed = true` 時唔觸發 veto（fail-open）

### 1B: Token Age 硬性門檻
- [x] `NEWBORN 太新` 和 `NEWBORN 過時` 的攔截記錄
- [x] 超過 90 分鐘的 NEWBORN token 唔被買入
- [x] `pairCreatedAt = null` 的 token 正常通過（唔被誤殺）

### 1C: LP Burn 做入場加速器
- [x] 當 `lp_burned:{mint} = TRUE` 時，log 出現 `[LP Burn Bonus]`
- [x] `coreScore` 唔超過 20（上限保持不變）
- [x] Redis 失敗唔影響正常 SecurityGuard 流程

### Sprint 2 實施狀態

### 2A: Graduation 事件識別
- [x] Log 中出現 `[Graduation]` 記錄
- [x] Redis 中出現 `graduated:{mint}` key
- [x] `graduation_alerts` channel 有廣播訊息

### 2B: Graduation alerts 訂閱
- [x] `graduation_alerts` 訂閱成功（啟動 log 確認）
- [x] 接收到 graduation 廣播後，log 出現 `[Graduation Alert]`
- [x] 成功查到 pair 後送入 `processAsymmetricRouting`
- [x] 流動性 < $10,000 的 graduation 被放棄

### 2C: Graduation 時序窗口
- [x] Graduation 後 < 3 分鐘被攔截：`⏳ Graduation 太早`
- [x] Graduation 後 3–20 分鐘出現 `[Grad Bonus]` log
- [x] Graduation 後 > 20 分鐘正常評估（無 bonus 也無 penalty）
- [x] `coreScore` 唔超過 20

### 3A: SQL清理和欄位新增
- [x] `token_age_at_entry_mins` 欄位存在
- [x] `mins_since_graduation` 欄位存在
- [x] `had_lp_burn` 欄位存在
- [x] `market_climate = 'UNKNOWN'` 記錄大幅減少
- [x] 剩餘記錄的 `entry_liquidity_usd > 0`（除 Poison Data）

### 3B: trade_frontline 寫入新特徵
- [x] `trade_patterns` 新記錄的 `token_age_at_entry_mins` 有值（唔係 null）
- [x] Graduation trade 的 `mins_since_graduation` 有值
- [x] LP Burn trade 的 `had_lp_burn = true`

### 3C: ML Brain 重新訓練
- [x] ML Engine 啟動時無 crash（向後兼容 fallback 正常）
- [x] 第一次 ML 訓練後，log 顯示訓練特徵逐步加入
- [x] `predict` endpoint 正常回應，唔因新特徵報錯
