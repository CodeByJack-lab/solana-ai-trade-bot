# 檔案總覽 — solana-ai-trade-bot

以下係針對你工程內主要檔案嘅簡短說明（以 Cantonese 表述），方便快速理解每個檔案做緊咩、輸入輸出同重要注意事項。

---

## 根目錄

- `package.json`
  - 作用：定義專案依賴、metadata 同埋執行腳本。
  - 重點：使用 CommonJS（"type": "commonjs"），主要依賴包含 `@google/generative-ai`、`@solana/web3.js`、`@supabase/supabase-js`、`axios` 等。

- `package-lock.json`
  - 作用：鎖定安裝版本，確保在不同機器安裝 node_modules 時相同版本。

- `.env`
  - 作用：儲存環境變數（RPC URL、私鑰、Supabase、API keys、Telegram token 等）。
  - 注意：內含敏感資料（例如 `SOLANA_PRIVATE_KEY`、`GEMINI_API_KEY`、`TELEGRAM_BOT_TOKEN`），唔好提交到公開 repo。

- `.gitignore`
  - 作用：排除不需入版控嘅檔案（node_modules、.env 等）。

- `check.js`
  - 作用：小工具，用來查詢 Google Generative AI 可用嘅「真正 model id」，幫你把 API Key 支援嘅 model 列出嚟，提示要把 ID 放入 `aiService.js`。
  - 使用方式：直接 node 執行即可，它會呼叫 Google API 列出 models。

---

## `src` 主要啟動與設定

- `src/index.js`
  - 作用：主啟動程式，初始化 portfolio cache（`initPortfolio`），啟動 market monitor（`startMarketMonitor`），並且執行主循環來定期檢查或等待 webhook。
  - 輸入：從 Supabase 與 `portfolioService` 讀取初始化資料；會使用 `priceService` 取得 SOL/HKD 價格。
  - 輸出：啟動 express 監聽（透過 monitor service）、及定時檢查持倉與風控行為。

- `src/setup.js`
  - 作用：初次設定腳本，用 `syncWalletHealth`（walletService）獲取錢包港幣估值，並把結果寫入 Supabase 的 `system_config` 作為 `reference_capital`。
  - 使用時機：第一次啟動或需要重新校準基準本金時執行。

---

## `src/config`（連線 / client 設定）

- `src/config/solana.js`
  - 作用：建立並匯出 Solana `Connection`（使用 `.env` 的 `SOLANA_RPC_URL`），供全專案查鏈用。

- `src/config/supabase.js`
  - 作用：建立並匯出 Supabase client（使用 `.env` 的 `SUPABASE_URL` 與 `SUPABASE_ANON_KEY`），供 database 操作使用。

---

## `src/services`（核心業務邏輯）

> 每個 service 通常會做單一職責：Portfolio 管理、監控 webhook、報價、風控、交易執行、錢包查詢、AI 判斷等。

- `src/services/aiService.js`
  - 作用：把第三方安全檢查（RugCheck / RPC）同 AI 模型結合，用以對新幣做審核並回傳決策（如 `BUY` 或 `SKIP`）。
  - 重要流程：
    - 先用 `checkRugPull`（或 fallback native RPC）做合約安全檢查。
    - 若安全，構造 prompt 傳給 Google Generative AI（Gemini/Gemma）取得決策 JSON。
    - 支援模型降級/備援策略，並有每日重置機制。
  - 輸出：一個 decision JSON（{ decision, score, reason }）。

- `src/services/monitorService.js`
  - 作用：啟動一個 Express server 接收來自 Helius 的 webhook（或其他來源），當有事件時：
    - 過濾黑白名單、檢查倉位上限、呼叫 `aiService.analyzeToken`，並在 AI 回覆 BUY 時呼叫 `tradeService.executeBuy`。
  - 也會提供 `startMarketMonitor()` 以監聽指定 Port。

- `src/services/portfolioService.js`
  - 作用：維護本地記憶體 cache（`my_portfolio`），提供初始化 `initPortfolio()`、讀取 `getPortfolio()`、以及 `updateCache()`（買/賣時更新）。
  - 資料來源：Supabase（或根據 mode 為 LIVE 時查鏈取得真實 SOL balance）。

- `src/services/priceService.js`
  - 作用：提供多重報價引擎與工具函數：
    - `getSolPriceInHKD()`：用 DexScreener 取得 SOL USD 再換成 HKD（有 fallback 價）
    - `getPriceFromDex` / `getPriceFromBirdeye` / `getPriorityFeeFromHelius`
    - `checkPositions()`：主動掃描現有持倉、更新最高價、判斷是否觸發止盈/止損，並在滿足條件時呼叫 `tradeService.executeSell`。

- `src/services/riskService.js`
  - 作用：執行系統風險檢查（例如 20% 熔斷線），讀 Supabase 的 `system_config` 來決定 `reference_capital`，並在觸發熔斷時自動把 `is_running` 關閉。
  - 輸入：當前 HKD 淨值；輸出：是否觸發熔斷（boolean）與建議每注金額。

- `src/services/tradeService.js`
  - 作用：負責模擬或執行買入與賣出流程：
    - `executeBuy(mintAddress, ...)`：計算等值 200 HKD 嘅 SOLAmount、模擬買價、寫入 Supabase 的持倉與 trade_history（paper/live 依 mode），並更新本地 cache。
    - `executeSell(mintAddress, ...)`：在賣出前會呼叫 Jupiter quote 取得最終成交參考價，計算 PnL，更新 DB 與本地 cache。
  - 注意：當前 implement 為模擬（有 mock txid 與隨機價格），實戰需接 Swap API 或 SDK。

- `src/services/walletService.js`
  - 作用：提供與錢包相關的查詢（目前只有 `fetchLiveSolBalance()`），在必要時向 Solana 查詢真實 SOL 餘額。
  - 供 `setup.js`、`portfolioService` 等呼叫以同步錢包健康狀態。

---

## `src/utils`

- `src/utils/currency.js`
  - 作用：對外提供 `getUSDHKDRate()`，透過 `EXCHANGE_RATE_API_URL` 取得 USD -> HKD 匯率，有失敗 fallback 值（7.82）。

---

## 如何把以上資訊用喺日常開發

- 若要理解系統執行流程：
  1. `src/index.js` 啟動，載入 `portfolioService.initPortfolio()`。
  2. `monitorService` 啟動 Express 接 Webhook（Helius），接到訊號後 -> `aiService` -> `tradeService`。
  3. `priceService` 會定時或在檢查持倉時被呼叫以決策止盈/止損。
  4. `riskService` 負責整體底線（熔斷），`setup.js` 可用作首次基準校準。

- 安全建議：
  - 立即把 `.env` 移出版本控制並旋轉（regenerate）任何公開過嘅 API Key / 私鑰。
  - `SOLANA_PRIVATE_KEY` 絕對唔好放在公共 repo。

---

如果你想，我可以：
- 幫你把呢份 Markdown 存入 `docs/`，或整合到專案 `README.md`；
- 針對每個 Service 自動產生更詳細嘅 API/contract（輸入/輸出 shape）；
- 或者把 `tradeService` 的模擬下單改成真實呼叫 Jupiter / Swap SDK（需你授權與 API key）。

要我即刻把呢份 Markdown 寫入專案？（我已經建立 `FILES_OVERVIEW.md`）
