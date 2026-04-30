# SOL QUANT HUNTER V10 — DB Migration Plan
## Supabase → Dokploy PostgreSQL + Redis Realtime

> **目標**：將所有 Supabase 依賴替換為自建 Dokploy PostgreSQL（Oracle Always Free）及現有 Redis pub/sub，消除 managed DB 成本，同時維持零數據損失。

---

## 架構對比

| 層面 | 現有 (Supabase) | 目標 (Dokploy) |
|---|---|---|
| PostgreSQL | Supabase managed | Dokploy self-hosted (Oracle ARM) |
| Realtime | `supabase.channel()` postgres_changes | Redis `PUBLISH` / `SUBSCRIBE` |
| SDK | `@supabase/supabase-js` `.from().select()` | `postgres.js` + 自建 `db.js` wrapper |
| Auth | Service Role Key | DB password (local network) |
| Dashboard → DB | Supabase REST API (透過 /api/*) | 無需改動，Dashboard 唔直連 DB |

---

## Supabase Realtime 依賴點（最高風險，必須全部替換）

用以下指令確認所有依賴位置：

```bash
grep -rn "supabase.channel\|postgres_changes\|supabase.removeChannel" src/
```

預期結果：

| 檔案 | channels 數量 | 替換方案 |
|---|---|---|
| `src/services/portfolioService.js` | 3 (INSERT / DELETE / UPDATE) | Redis SUBSCRIBE `position_changes` |
| `src/microservices/macro_sync_center.js` | 8 (bot_prompts, verified_tokens, ml_strategy_params 等) | Redis SUBSCRIBE `config_changes` |
| `src/microservices/priceBot.js` | 2 (paper + live position INSERT/DELETE) | Redis SUBSCRIBE `position_changes` |
| `src/app/page.tsx` (Dashboard) | 1 (bot_status UPDATE) | 已有 20s polling，移除 channel 即可 |

---

## Phase 0 — Preparation（零停機，2-3 小時）

### 0.1 Dokploy 安裝 PostgreSQL

```bash
# 在 Oracle VM 上，透過 Dokploy UI 建立 PostgreSQL service
# 或直接 CLI：
docker run -d \
  --name solquant-postgres \
  -e POSTGRES_DB=solquant \
  -e POSTGRES_USER=solquant \
  -e POSTGRES_PASSWORD=<STRONG_PASSWORD> \
  -p 5432:5432 \
  -v /data/postgres:/var/lib/postgresql/data \
  postgres:17

# 確認啟動
docker exec solquant-postgres psql -U solquant -c "SELECT version();"
```

### 0.2 從 Supabase Export Schema + Data

```bash
# 從 Supabase dashboard 取得 DB connection string
# Settings → Database → Connection string (URI format)
export SUPABASE_DB_URL="postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres"
export DOKPLOY_DB_URL="postgresql://solquant:[password]@[oracle-ip]:5432/solquant"

# Export schema only（結構）
pg_dump $SUPABASE_DB_URL \
  --schema-only \
  --no-owner \
  --no-privileges \
  -f schema.sql

# Export data（全部資料）
pg_dump $SUPABASE_DB_URL \
  --data-only \
  --no-owner \
  -f data.sql

# Restore 到 Dokploy
psql $DOKPLOY_DB_URL < schema.sql
psql $DOKPLOY_DB_URL < data.sql
```

### 0.3 驗證數據完整性

```bash
# 逐表比較 row count
for table in active_positions_live active_positions_paper trade_history_live trade_history_paper system_config ml_strategy_params bot_prompts verified_tokens trade_patterns newborn_incubator; do
  echo "=== $table ==="
  echo "Supabase: $(psql $SUPABASE_DB_URL -t -c "SELECT COUNT(*) FROM $table;")"
  echo "Dokploy:  $(psql $DOKPLOY_DB_URL  -t -c "SELECT COUNT(*) FROM $table;")"
done
```

**預期**：所有表 row count 完全一致才可進行下一階段。

### 0.4 安裝依賴

```bash
# 在 main bot 項目根目錄
npm install postgres
# 移除 supabase (Phase 3 之後)
# npm uninstall @supabase/supabase-js
```

---

## Phase 1 — SDK 替換（PAPER mode，1 日）

### 1.1 建立 `src/config/db.js` Wrapper

> **設計原則**：完全模仿 supabase-js 的 `{ data, error }` 返回格式，令現有 error handling 代碼零改動。

建立檔案 `src/config/db.js`：

```javascript
// src/config/db.js
// Drop-in replacement for supabase-js .from() API
// Returns { data, error } identical to supabase-js

const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

function from(table) {
    let _select = '*';
    let _wheres = [];
    let _inClause = null;
    let _notInClause = null;
    let _limit = null;
    let _single = false;
    let _order = null;

    const buildWhere = () => {
        const parts = [];
        _wheres.forEach(w => {
            if (w.op === '=' || w.op === '!=') {
                parts.push(sql`${sql(w.col)} ${sql.unsafe(w.op)} ${w.val}`);
            }
        });
        if (_inClause) {
            parts.push(sql`${sql(_inClause.col)} = ANY(${_inClause.vals})`);
        }
        if (_notInClause) {
            parts.push(sql`${sql(_notInClause.col)} != ALL(${_notInClause.vals})`);
        }
        return parts;
    };

    const builder = {
        select(cols = '*') { _select = cols; return builder; },
        eq(col, val)       { _wheres.push({ col, op: '=',  val }); return builder; },
        neq(col, val)      { _wheres.push({ col, op: '!=', val }); return builder; },
        in(col, vals)      { _inClause    = { col, vals }; return builder; },
        not: { in(col, vals) { _notInClause = { col, vals }; return builder; } },
        limit(n)           { _limit = n; return builder; },
        order(col, opts)   { _order = { col, asc: !opts?.ascending === false }; return builder; },
        single()           { _single = true; _limit = 1; return builder; },

        async insert(rows) {
            try {
                const arr = Array.isArray(rows) ? rows : [rows];
                for (const row of arr) {
                    await sql`INSERT INTO ${sql(table)} ${sql(row)}`;
                }
                return { data: null, error: null };
            } catch (e) {
                console.error(`[db.js] INSERT ${table} 失敗:`, e.message);
                return { data: null, error: { message: e.message } };
            }
        },

        update(obj) {
            const updateBuilder = {
                eq(col, val)   { _wheres.push({ col, op: '=',  val }); return updateBuilder; },
                neq(col, val)  { _wheres.push({ col, op: '!=', val }); return updateBuilder; },
                in(col, vals)  { _inClause = { col, vals }; return updateBuilder; },
                async then(resolve) {
                    try {
                        const whereParts = buildWhere();
                        if (whereParts.length === 0) throw new Error('UPDATE without WHERE is forbidden');
                        let q = sql`UPDATE ${sql(table)} SET ${sql(obj)} WHERE ${whereParts[0]}`;
                        for (let i = 1; i < whereParts.length; i++) q = sql`${q} AND ${whereParts[i]}`;
                        await q;
                        resolve({ data: null, error: null });
                    } catch (e) {
                        console.error(`[db.js] UPDATE ${table} 失敗:`, e.message);
                        resolve({ data: null, error: { message: e.message } });
                    }
                }
            };
            return updateBuilder;
        },

        delete() {
            const deleteBuilder = {
                eq(col, val)   { _wheres.push({ col, op: '=',  val }); return deleteBuilder; },
                neq(col, val)  { _wheres.push({ col, op: '!=', val }); return deleteBuilder; },
                in(col, vals)  { _inClause = { col, vals }; return deleteBuilder; },
                async then(resolve) {
                    try {
                        const whereParts = buildWhere();
                        if (whereParts.length === 0) throw new Error('DELETE without WHERE is forbidden');
                        let q = sql`DELETE FROM ${sql(table)} WHERE ${whereParts[0]}`;
                        for (let i = 1; i < whereParts.length; i++) q = sql`${q} AND ${whereParts[i]}`;
                        await q;
                        resolve({ data: null, error: null });
                    } catch (e) {
                        console.error(`[db.js] DELETE ${table} 失敗:`, e.message);
                        resolve({ data: null, error: { message: e.message } });
                    }
                }
            };
            return deleteBuilder;
        },

        async then(resolve) {
            try {
                const whereParts = buildWhere();
                let q = sql`SELECT ${sql.unsafe(_select === '*' ? '*' : _select)} FROM ${sql(table)}`;
                if (whereParts.length > 0) {
                    q = sql`${q} WHERE ${whereParts[0]}`;
                    for (let i = 1; i < whereParts.length; i++) q = sql`${q} AND ${whereParts[i]}`;
                }
                if (_order) q = sql`${q} ORDER BY ${sql(_order.col)} ${sql.unsafe(_order.asc ? 'ASC' : 'DESC')}`;
                if (_limit)  q = sql`${q} LIMIT ${_limit}`;
                const rows = await q;
                const data = _single ? (rows[0] || null) : Array.from(rows);
                resolve({ data, error: null });
            } catch (e) {
                console.error(`[db.js] SELECT ${table} 失敗:`, e.message);
                resolve({ data: null, error: { message: e.message } });
            }
        }
    };

    return builder;
}

module.exports = { from, sql };
```

### 1.2 加入環境變數

在所有 services 的 `.env` 加入：

```bash
DATABASE_URL=postgresql://solquant:[password]@[oracle-ip]:5432/solquant
DB_SSL=false  # Oracle 內網唔需要 SSL
```

### 1.3 全局替換 supabase import

用以下指令找出所有需要改動的位置：

```bash
grep -rn "require.*supabase\|from.*supabase" src/ --include="*.js" --include="*.ts"
```

每個檔案的改動模式：

```javascript
// 舊：
const { supabase } = require('../config/supabase');
// 或
const { createClient } = require('@supabase/supabase-js');

// 新：
const db = require('../config/db');
```

所有 `supabase.from(` 改為 `db.from(`：

```javascript
// 舊：
const { data, error } = await supabase.from('system_config').select('*').eq('id', 1).single();

// 新：
const { data, error } = await db.from('system_config').select('*').eq('id', 1).single();
```

**注意**：`{ data, error }` 格式完全一致，現有 error handling 代碼唔使改。

### 1.4 PAPER mode 驗證（24 小時）

```bash
# 啟動 bot，確保 trade_mode = PAPER
pm2 start ecosystem.config.js

# 監察 log，確認無 DB 錯誤
pm2 logs trade_frontline | grep -E "\[db.js\]|INSERT|UPDATE|DELETE"

# 每小時對比兩邊 row count
watch -n 3600 'psql $DOKPLOY_DB_URL -t -c "SELECT COUNT(*) FROM active_positions_paper;"'
```

---

## Phase 2 — Realtime 替換（2-4 小時）

### 2.1 `tradeService.js` — 加入 Redis publish

在 `executeBuy` 成功寫入 DB 之後加：

```javascript
// executeBuy 末端，supabase insert 成功之後
await redis.publish('position_changes', JSON.stringify({
    eventType: 'INSERT',
    table: tableName,
    new: { mint_address: mint, strategy_type: strategyVersion }
}));
```

在 `runSellPipeline` DELETE 倉位之後加：

```javascript
// runSellPipeline 末端，delete 成功之後
await redis.publish('position_changes', JSON.stringify({
    eventType: 'DELETE',
    table: tableName,
    old: { mint_address: mint }
}));
```

在 `system_config` 有 UPDATE 之後（例如 simulated_balance）加：

```javascript
await redis.publish('config_changes', JSON.stringify({
    eventType: 'UPDATE',
    table: 'system_config',
    new: { is_running: true, trade_mode: mode }
}));
```

### 2.2 `portfolioService.js` — 替換 supabase.channel()

移除：

```javascript
// 移除以下整個 channel 設定
supabase.channel('portfolio_cross_sync')
    .on('postgres_changes', { event: 'INSERT', ... }, ...)
    .on('postgres_changes', { event: 'DELETE', ... }, ...)
    .on('postgres_changes', { event: 'UPDATE', ... }, ...)
    .subscribe();
```

加入：

```javascript
const Redis = require('ioredis');
const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL);

redisSub.subscribe('position_changes');
redisSub.on('message', (channel, message) => {
    try {
        const payload = JSON.parse(message);
        if (payload.eventType === 'INSERT') {
            const exists = my_portfolio.positions.some(p => p.mint_address === payload.new.mint_address);
            if (!exists) {
                my_portfolio.positions.push({
                    ...payload.new,
                    quantity: parseFloat(payload.new.quantity || 0),
                    entry_price_sol: parseFloat(payload.new.entry_price_sol || 0),
                    highest_price_sol: parseFloat(payload.new.highest_price_sol || payload.new.entry_price_sol || 0),
                    strategy_type: payload.new.strategy_type || 'UNKNOWN'
                });
            }
        } else if (payload.eventType === 'DELETE') {
            my_portfolio.positions = my_portfolio.positions.filter(
                p => p.mint_address !== payload.old.mint_address
            );
        } else if (payload.eventType === 'UPDATE') {
            const idx = my_portfolio.positions.findIndex(p => p.mint_address === payload.new.mint_address);
            if (idx !== -1) Object.assign(my_portfolio.positions[idx], payload.new);
        }
    } catch(e) {
        console.error('[portfolioService] Redis message parse error:', e.message);
    }
});
```

### 2.3 `macro_sync_center.js` — 替換 8 個 channel

移除：

```javascript
// 移除整個 setupRealtimeListeners() 入面的 supabase.channel('system_hot_swap')
```

加入（在 `setupRealtimeListeners` 裡）：

```javascript
const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL);
redisSub.subscribe('config_changes');
redisSub.on('message', async (channel, message) => {
    try {
        const payload = JSON.parse(message);
        // 以前監聽 bot_prompts, verified_tokens, ml_strategy_params 等 table 變更
        // 依家改為：config_changes 觸發時，重新 sync 所有 cache
        const configTables = ['bot_prompts', 'verified_tokens', 'ml_strategy_params', 
                              'ml_blacklist_rules', 'brand_blacklist', 'ai_strategy_params'];
        if (configTables.includes(payload.table)) {
            await syncCoreConfigsToRedis();
        }
        if (payload.table === 'system_config') {
            schedulePortfolioSync('System Config 變更 (Redis)');
        }
        if (['active_positions_paper', 'active_positions_live'].includes(payload.table) 
            && payload.eventType === 'DELETE') {
            schedulePortfolioSync(`${payload.table} 倉位重置 (Redis)`);
        }
    } catch(e) {}
});
```

**注意**：`syncCoreConfigsToRedis` 同 `schedulePortfolioSync` 邏輯完全不變，只係觸發方式改為 Redis 事件。

### 2.4 `priceBot.js` — 替換 position listener

移除：

```javascript
// 移除 setupRealtimeListeners() 入面的：
supabase.channel('paper_positions_channel')...
supabase.channel('live_positions_channel')...
supabase.channel('config_channel')...
```

加入：

```javascript
function setupRealtimeListeners() {
    // Config 同步：改為定時輪詢（5 秒）
    setInterval(async () => {
        try {
            const { data } = await db.from('system_config')
                .select('is_running, trade_mode').eq('id', 1).single();
            if (data) {
                const modeChanged = globalConfig.trade_mode !== data.trade_mode;
                globalConfig.is_running = data.is_running;
                globalConfig.trade_mode = data.trade_mode || 'PAPER';
                if (modeChanged) await bootstrapSystem();
            }
        } catch(e) {}
    }, 5000);

    // Position 變更：改為 Redis subscribe
    const redisSub = new Redis(process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL);
    redisSub.subscribe('position_changes');
    redisSub.on('message', (channel, message) => {
        try {
            const payload = JSON.parse(message);
            // handlePositionChange 邏輯完全不變
            if (payload.eventType === 'INSERT') {
                const safeMint = sanitizeBase58(payload.new.mint_address);
                if (safeMint) {
                    activeMintsCache.add(safeMint);
                    console.log(`➕ [PriceBot] 新增監控: ${safeMint}`);
                }
            } else if (payload.eventType === 'DELETE') {
                const safeMint = sanitizeBase58(payload.old.mint_address);
                if (safeMint) {
                    activeMintsCache.delete(safeMint);
                    console.log(`➖ [PriceBot] 移除監控: ${safeMint}`);
                }
            }
        } catch(e) {}
    });

    // 斷線保護
    redisSub.on('error', (err) => {
        console.error('[PriceBot] Redis sub error:', err.message);
    });
}
```

### 2.5 `page.tsx` (Dashboard) — 移除 bot_status channel

Dashboard 已經有 20 秒 polling (`fetchDashboardData`)，唔需要 Realtime。

移除：

```typescript
// 移除以下整個 channel
const statusChannel = supabase.channel('bot_status_realtime')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bot_status', filter: 'id=eq.1' }, ...)
    .subscribe();

// 移除 cleanup 裡的
supabase.removeChannel(statusChannel);
```

### 2.6 確認所有 channel 已清除

```bash
# 執行後應該返回 0 行
grep -rn "supabase.channel\|postgres_changes\|supabase.removeChannel" src/
```

---

## Phase 3 — Cutover（停機 5-10 分鐘）

### 3.1 執行前檢查清單

```bash
# 確認 Dokploy Postgres 正常運行
psql $DOKPLOY_DB_URL -c "SELECT 1;"

# 確認 DATABASE_URL env var 已設定
echo $DATABASE_URL

# 確認 grep 返回 0 行（所有 channel 已替換）
grep -rn "supabase.channel" src/ | wc -l

# 確認 PAPER mode 跑了 24 小時無錯誤
pm2 logs trade_frontline --lines 100 | grep -i error
```

### 3.2 停機流程

```bash
# Step 1: 停止 bot（透過 Dashboard 設 is_running = false，或直接 pm2）
pm2 stop all

# Step 2: 最後一次差異同步（只同步最重要的 live tables）
pg_dump $SUPABASE_DB_URL \
  --data-only \
  --table=active_positions_live \
  --table=active_positions_paper \
  --table=system_config \
  -f final_cutover_sync.sql

psql $DOKPLOY_DB_URL < final_cutover_sync.sql

# Step 3: 再次驗證 row count
psql $SUPABASE_DB_URL -t -c "SELECT COUNT(*) FROM active_positions_live;"
psql $DOKPLOY_DB_URL  -t -c "SELECT COUNT(*) FROM active_positions_live;"

# Step 4: 確認兩邊一致後，重啟 bot
pm2 start ecosystem.config.js

# Step 5: 確認第一個 DB 操作成功
pm2 logs trade_frontline --lines 20
```

### 3.3 Rollback 方案

如果 cutover 後發現問題：

```bash
# 將 DATABASE_URL 改回 Supabase
export DATABASE_URL=$SUPABASE_DB_URL
pm2 restart all
```

---

## Phase 4 — 清理（7 日後）

確認系統穩定後：

```bash
# 移除 supabase-js 依賴
npm uninstall @supabase/supabase-js

# 清理環境變數（移除以下，不再需要）
# SUPABASE_URL
# SUPABASE_ANON_KEY
# NEXT_PUBLIC_SUPABASE_URL
# NEXT_PUBLIC_SUPABASE_ANON_KEY
# SUPABASE_SERVICE_ROLE_KEY

# 保留 DATABASE_URL（新 Dokploy）
```

**注意**：Dashboard (Vercel) 嘅 `route.ts` 透過 `/api/*` 呼叫，唔係直連 DB，唔受影響，但需要更新 `SUPABASE_*` env vars 為新的 `DATABASE_URL`。

---

## 風險矩陣

| 風險 | 嚴重度 | 緩解方案 |
|---|---|---|
| Cutover 期間新單寫入 Supabase 但未同步至 Dokploy | 🔴 高 | 停機前設 `is_running=false`，cutover 後再開啟 |
| 漏掉某個 `supabase.channel()` 呼叫 | 🟡 中 | `grep -rn "supabase.channel" src/` 確認 0 行 |
| Dokploy Postgres 宕機 | 🟡 中 | DB 連線錯誤 → `executeBuy` return false → 唔買入，資金安全 |
| Dashboard (Vercel) 連唔到新 DB | 🟢 低 | Dashboard 透過 `/api/*` 中間層，唔直連 DB |
| Redis pub/sub 延遲影響 SL/TP 反應 | 🟢 低 | monitor_guards 係直接 Redis subscribe，延遲 <5ms |

---

## 新增 Redis Channels 參考

| Channel | Publisher | Subscriber | Payload |
|---|---|---|---|
| `position_changes` | `tradeService.js` | `portfolioService.js`, `priceBot.js` | `{eventType, table, new/old}` |
| `config_changes` | `tradeService.js`, `route.ts` | `macro_sync_center.js` | `{eventType, table, new}` |

---

## 關鍵指令速查

```bash
# 確認所有 supabase realtime 依賴已清除
grep -rn "supabase.channel\|postgres_changes" src/

# 確認所有 supabase.from 已替換
grep -rn "supabase.from" src/

# 驗證 DB 連線
node -e "const db=require('./src/config/db'); db.from('system_config').select('id').single().then(r=>console.log(r))"

# 實時監察 Redis publish 事件
redis-cli -u $REDIS_URL SUBSCRIBE position_changes config_changes
```
