# ml_engine/main.py
# 📝 檔案功能用途：V10.18 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：HKT 19:00 定時訓練排程、整合大市分數 (Macro Score) 修正勝率、取消開機核爆訓練、限制單核運行、雙向寫入 Supabase。

import os
import json
import time
import math
import threading
import schedule
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, BackgroundTasks
from contextlib import asynccontextmanager
from pydantic import BaseModel, Field
import pandas as pd
import numpy as np
from supabase import create_client, Client, ClientOptions
import redis
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.tree import DecisionTreeClassifier

# ------------------------------------------------------------------
# 1. 初始化與全域變數
# ------------------------------------------------------------------
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
REDIS_URL = os.getenv("REDIS_PUBLIC_URL") or os.getenv("REDIS_URL") or "redis://localhost:6379"
MODEL_PATH = "/tmp/v10_rf_model.pkl"

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("❌ [FATAL] 缺少 Supabase 環境變數，Data Engine 無法啟動。")

try:
    opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=opts)
except Exception as e:
    print(f"⚠️ [System] 帶 Options 建立 Supabase Client 失敗，嘗試回退原始連線。錯誤: {e}")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# ------------------------------------------------------------------
# 🎯 FastAPI Lifespan 管理 (背景排程器)
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=background_scheduler, daemon=True).start()
    yield 

app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.18", lifespan=lifespan)

# ------------------------------------------------------------------
# 2. 即時推論端點 (勝率 + 大市加權 + 動態注碼乘數)
# ------------------------------------------------------------------
class FeaturePayload(BaseModel):
    p: float = Field(..., ge=0.0)
    v: float = Field(..., ge=0.0)
    b: int = Field(..., ge=0)
    s: int = Field(..., ge=0)
    l: float = Field(..., ge=0.0)
    ts: int = Field(..., gt=0)

class PredictRequest(BaseModel):
    features: FeaturePayload
    type: str = "NEWBORN" 

class PredictResponse(BaseModel):
    score: int
    win_probability: float
    confidence_multiplier: float 

@app.post("/predict", response_model=PredictResponse)
async def predict_score(req: PredictRequest):
    """
    🧠 雙塔漏斗：結合「Random Forest 概率」與「大市氣候分數」，給出最終勝率與注碼乘數
    """
    f = req.features
    if f.l <= 0 or f.v <= 0 or math.isnan(f.p) or math.isinf(f.p):
        return PredictResponse(score=0, win_probability=0.0, confidence_multiplier=1.0)
        
    total_tx = f.b + f.s
    ofi = (f.b - f.s) / total_tx if total_tx > 0 else 0

    # 🤖 塔 1：Scikit-Learn 隨機森林概率計算
    survival_prob = 0.5 # 預設 50% 勝率
    if os.path.exists(MODEL_PATH):
        try:
            rf_model = joblib.load(MODEL_PATH)
            X_live = pd.DataFrame([[ofi, f.l]], columns=['entry_ofi', 'entry_liquidity_usd'])
            survival_prob = rf_model.predict_proba(X_live)[0][1]
        except Exception:
            pass 

    # 🌍 塔 2：大市氣候融合 (Macro Climate Integration)
    # 讀取 Redis 上的 4D 大市分數 (由硬數據與新聞 AI 產生)
    news_score = 0
    env_str = redis_client.get("global_env_state")
    if env_str:
        try:
            env_data = json.loads(env_str)
            news_score = env_data.get("newsScore", 0) # 範圍約 -5 到 +5
        except:
            pass

    # 每 1 分大市分數，影響勝率 2% (上限影響 ±10%)
    macro_adjustment = news_score * 0.02
    survival_prob += macro_adjustment
    survival_prob = max(0.0, min(1.0, survival_prob)) # 限制在 0.0 - 1.0 之間

    # 🎯 整合總分 (滿分 60 分，交給 Node.js 前線)
    final_score = int(survival_prob * 60)

    # 💰 計算動態注碼乘數 (Kelly Criterion 簡化版)
    multiplier = 1.0
    if survival_prob < 0.4:
        multiplier = 0.5   # 勝率低，縮注 50%
    elif survival_prob >= 0.6 and survival_prob < 0.8:
        multiplier = 1.5   # 勝率高，加注 150%
    elif survival_prob >= 0.8:
        multiplier = 2.0   # 絕殺盤，重倉 200%

    return PredictResponse(score=final_score, win_probability=survival_prob, confidence_multiplier=multiplier)

# ------------------------------------------------------------------
# 3. 核心大數據引擎：EMA動態記憶、RF訓練 與 毒藥萃取
# ------------------------------------------------------------------
def fetch_trade_patterns_paginated(days_back: int = 14) -> pd.DataFrame:
    chunk_size = 1000
    start_idx = 0
    all_data = []
    time_threshold = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    
    while True:
        end_idx = start_idx + chunk_size - 1
        response = supabase.table('trade_patterns').select('*') \
            .gte('created_at', time_threshold).order('created_at', desc=True) \
            .range(start_idx, end_idx).execute()
        data = response.data
        if not data: break
        all_data.extend(data)
        if len(data) < chunk_size: break
        start_idx += chunk_size
        
    return pd.DataFrame(all_data)

def extract_and_save_toxic_clusters(X: pd.DataFrame, y_toxic: pd.Series):
    """🧠 決策樹毒藥萃取：找出導致嚴重虧損的特徵組合，寫入 Supabase"""
    if sum(y_toxic) < 5: return 
    
    dt = DecisionTreeClassifier(max_depth=3, min_samples_leaf=3, random_state=42)
    dt.fit(X, y_toxic)
    
    tree = dt.tree_
    features = X.columns
    toxic_rules = []
    
    def recurse(node, current_rule):
        if tree.children_left[node] != tree.children_right[node]:
            name = features[tree.feature[node]]
            thr = tree.threshold[node]
            recurse(tree.children_left[node], current_rule + [(name, "<=", thr)])
            recurse(tree.children_right[node], current_rule + [(name, ">", thr)])
        else:
            val = tree.value[node][0]
            prob = val[1] / sum(val)
            if prob > 0.75 and sum(val) >= 3:
                toxic_rules.append(current_rule)

    recurse(0, [])
    supabase.table('ml_blacklist_rules').delete().neq('id', -1).execute()
    
    insert_payload = []
    for group_idx, rule_path in enumerate(toxic_rules):
        for metric, op, thr in rule_path:
            insert_payload.append({
                "condition_group": group_idx + 1,
                "metric_name": metric,
                "operator": op,
                "threshold_value": round(float(thr), 4)
            })
            
    if insert_payload:
        supabase.table('ml_blacklist_rules').insert(insert_payload).execute()
        print(f"☠️ [ML Engine] 成功萃取並寫入 {len(toxic_rules)} 條必死毒藥組合至 DB！")

def execute_evolution_pipeline():
    print(f"🚀 [ML Engine] 啟動大數據訓練管線 (觸發時間: {datetime.now(timezone.utc).isoformat()})...")
    try:
        # 1. 獲取 DB 超參數
        resp = supabase.table('ai_strategy_params').select('*').in_('id', [2, 3]).execute()
        params = next((p for p in resp.data if p['id'] == 3), resp.data[0]) if resp.data else {}

        lookback_days = params.get('ml_lookback_days', 14)
        ema_alpha = float(params.get('ema_alpha', 0.3)) 
        
        df = fetch_trade_patterns_paginated(lookback_days)
        if df.empty or len(df) < 10:
            print("⚠️ [ML Engine] 歷史樣本庫不足 (需至少 10 條)，中止訓練。請讓系統空轉收集數據。")
            return

        df['realized_pnl_pct'] = pd.to_numeric(df['realized_pnl_pct'], errors='coerce').fillna(0)
        df['entry_ofi'] = pd.to_numeric(df['entry_ofi'], errors='coerce').fillna(0)
        df['entry_liquidity_usd'] = pd.to_numeric(df['entry_liquidity_usd'], errors='coerce').fillna(0)
        
        now_utc = pd.Timestamp.utcnow()
        df['created_at'] = pd.to_datetime(df['created_at'], utc=True, errors='coerce')
        df = df.dropna(subset=['created_at'])
        df['age_days'] = (now_utc - df['created_at']).dt.total_seconds() / 86400.0
        df['age_days'] = df['age_days'].clip(lower=0)
        df['w_time'] = 0.5 ** (df['age_days'] / (lookback_days / 3.0)) 

        winning_df = df[df['realized_pnl_pct'] > 0]
        losing_df = df[df['realized_pnl_pct'] < 0]

        # 2. 計算今日新數據基準
        new_sl = max(-25.0, min(-10.0, float(np.average(losing_df['realized_pnl_pct'], weights=losing_df['w_time']) * 1.2))) if not losing_df.empty else -15.0
        new_tp = max(15.0, min(40.0, float(np.average(winning_df['realized_pnl_pct'], weights=winning_df['w_time']) * 0.8))) if not winning_df.empty else 20.0
        new_ofi = float(np.average(winning_df['entry_ofi'], weights=winning_df['w_time'])) if not winning_df.empty else 0.2
        new_liq = float(np.average(winning_df['entry_liquidity_usd'], weights=winning_df['w_time'])) if not winning_df.empty else 5000.0

        # 3. 讀取昨日記憶，執行 EMA 平滑融合
        old_model_str = redis_client.get("cache:dynamic_scoring_model")
        if old_model_str:
            try:
                old = json.loads(old_model_str)
                final_sl = (old.get("dynamic_sl", -15.0) * (1 - ema_alpha)) + (new_sl * ema_alpha)
                final_tp = (old.get("dynamic_tp_trigger", 20.0) * (1 - ema_alpha)) + (new_tp * ema_alpha)
                final_ofi = (old.get("avg_ofi", 0.2) * (1 - ema_alpha)) + (new_ofi * ema_alpha)
                final_liq = (old.get("avg_entry_liq", 5000.0) * (1 - ema_alpha)) + (new_liq * ema_alpha)
            except:
                final_sl, final_tp, final_ofi, final_liq = new_sl, new_tp, new_ofi, new_liq
        else:
            final_sl, final_tp, final_ofi, final_liq = new_sl, new_tp, new_ofi, new_liq

        # 4. ML 參數動態決策 (寫入 Redis 及 Supabase)
        optimal_liq = max(2000.0, final_liq * 0.5) 
        ml_strategy_params = {
            "buy_threshold": 70,
            "strategy_id": int(time.time()), 
            "NEWBORN": {
                "RAGING_BULL": {"minOFI": -0.6, "minTxs5m": 3, "minAvgTradeUsd": 5, "maxTurnover5m": 2.0, "deadPoolVolReq": 500, "optimalMinLiquidityUsd": optimal_liq},
                "CHOPPY":      {"minOFI": -0.2, "minTxs5m": 5, "minAvgTradeUsd": 10, "maxTurnover5m": 1.0, "deadPoolVolReq": 500, "optimalMinLiquidityUsd": optimal_liq},
                "BEAR_PANIC":  {"minOFI": 0.0,  "minTxs5m": 10, "minAvgTradeUsd": 20, "maxTurnover5m": 0.5, "deadPoolVolReq": 500, "optimalMinLiquidityUsd": optimal_liq}
            },
            "TRENDING": {
                "RAGING_BULL": {"minOFI": -0.7, "minTxs5m": 5, "minAvgTradeUsd": 10, "maxTurnover5m": 2.0, "zombieVolReq": 200, "optimalMinLiquidityUsd": optimal_liq * 2},
                "CHOPPY":      {"minOFI": -0.4, "minTxs5m": 8, "minAvgTradeUsd": 25, "maxTurnover5m": 1.0, "zombieVolReq": 800, "optimalMinLiquidityUsd": optimal_liq * 2},
                "BEAR_PANIC":  {"minOFI": -0.2, "minTxs5m": 15, "minAvgTradeUsd": 50, "maxTurnover5m": 0.5, "zombieVolReq": 1500, "optimalMinLiquidityUsd": optimal_liq * 2}
            }
        }
        
        # 4.1 寫入 Redis (Node.js 即時用)
        redis_client.set("ml_strategy_params", json.dumps(ml_strategy_params))
        
        # 4.2 寫入 Supabase (永久保存)
        for t_type, climates in ml_strategy_params.items():
            if t_type in ['NEWBORN', 'TRENDING']:
                for cli, p in climates.items():
                    try:
                        supabase.table('ml_strategy_params').update({
                            'buy_threshold': ml_strategy_params["buy_threshold"],
                            'min_ofi': p['minOFI'],
                            'min_txs_5m': p['minTxs5m'],
                            'min_avg_trade_usd': p['minAvgTradeUsd'],
                            'max_turnover_5m': p['maxTurnover5m'],
                            'zombie_vol_req': p.get('zombieVolReq', 500),
                            'updated_at': datetime.now(timezone.utc).isoformat()
                        }).eq('token_type', t_type).eq('market_climate', cli).execute()
                    except Exception as e:
                        print(f"⚠️ [ML Engine] 更新 Supabase ml_strategy_params 失敗 ({t_type}-{cli}): {e}")

        print("🧠 [ML Engine] 已將最新戰術參數同步至 Redis 與 Supabase！")

        # 同步舊版 SL/TP 回 DB (供 Watchdog 參考)
        supabase.table('ai_strategy_params').update({ 'stop_loss_pct': round(final_sl, 2), 'trailing_tp_trigger': round(final_tp, 2) }).in_('id', [2, 3]).execute()
        
        # 5. ML 訓練 (🚀 限制 n_jobs=1，防止 CPU 核爆)
        if len((df['realized_pnl_pct'] > 0).unique()) > 1:
            n_est = params.get('rf_n_estimators', 100)
            m_depth = params.get('rf_max_depth', 5)
            # n_jobs=1: 只用單核進行運算，減輕系統負荷
            rf = RandomForestClassifier(n_estimators=n_est, max_depth=m_depth, random_state=42, n_jobs=1)
            rf.fit(df[['entry_ofi', 'entry_liquidity_usd']], (df['realized_pnl_pct'] > 0).astype(int), sample_weight=df['w_time'])
            joblib.dump(rf, MODEL_PATH)
            print(f"🌲 [ML Engine] Random Forest 模型訓練完成，已儲存至 RAM ({MODEL_PATH})")

        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1:
            extract_and_save_toxic_clusters(df[['entry_ofi', 'entry_liquidity_usd']], y_toxic)

        print(f"✅ [Baseline Engine] 全管線更新完畢 (SL={final_sl:.2f}%, TP={final_tp:.2f}%)")

    except Exception as e:
        print(f"❌ [Baseline Engine] 建模管線發生崩潰: {str(e)}")

# ------------------------------------------------------------------
# 4. 全自動無人值守排程器 (HKT 19:00 / UTC 11:00 執行)
# ------------------------------------------------------------------
def run_evolution_job():
    """包裝函數，用於 schedule 調用"""
    execute_evolution_pipeline()

def background_scheduler():
    # 🚀 移除開機自動訓練，徹底解決開機 CPU 峰值問題
    # 🕒 設定每日 UTC 11:00 (即 HKT 晚上 7 點) 執行
    schedule.every().day.at("11:00").do(run_evolution_job)
    print("🕒 [ML Engine] 已設定每日 HKT 19:00 (UTC 11:00) 進行大數據覆盤訓練。開機不作初次訓練。")
    
    while True:
        schedule.run_pending()
        time.sleep(60) # 每分鐘檢查一次排程

# ------------------------------------------------------------------
# 5. 管理端點
# ------------------------------------------------------------------
@app.post("/trigger_evolution")
def trigger_evolution(background_tasks: BackgroundTasks):
    background_tasks.add_task(execute_evolution_pipeline)
    return {"status": "success", "message": "ML Evolution pipeline triggered in background."}

@app.get("/health")
def health_check():
    return {"status": "alive", "engine": "V10 Dual-Tower ML Brain", "cores": 1} # 標示為單核安全版

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=1, log_config="log_config.json")