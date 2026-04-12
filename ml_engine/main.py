# ml_engine/main.py
# 📝 檔案功能用途：V10 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：全動態參數讀取 + EMA 歷史記憶平滑學習機制 (修復開機 CPU 核爆問題)

import os
import json
import time
import math
import threading
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, BackgroundTasks
from contextlib import asynccontextmanager  # 🎯 新增 lifespan 依賴
from pydantic import BaseModel, Field
import pandas as pd
import numpy as np
# 🎯 引入 ClientOptions 解決 httpx proxy 錯誤
from supabase import create_client, Client, ClientOptions
import redis
import joblib

# 🎯 引入輕量級機器學習核心
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

# 🎯 終極修復：加長 Timeout 並保留 Options，防止龐大數據下載時連線崩潰
try:
    opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=opts)
except Exception as e:
    print(f"⚠️ [System] 帶 Options 建立 Supabase Client 失敗，嘗試回退原始連線。錯誤: {e}")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# ------------------------------------------------------------------
# 🎯 FastAPI Lifespan 管理
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=background_scheduler, daemon=True).start()
    yield 

app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.6", lifespan=lifespan)

# ------------------------------------------------------------------
# 2. 即時推論端點 (動態純數與 ML 融合)
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

class PredictResponse(BaseModel):
    score: int

@app.post("/predict", response_model=PredictResponse)
async def predict_score(req: PredictRequest):
    """
    🧠 雙塔漏斗：結合「動態數學基準分」與「Random Forest 概率」，給出最終勝率
    """
    f = req.features
    if f.l <= 0 or f.v <= 0 or math.isnan(f.p) or math.isinf(f.p):
        return PredictResponse(score=0)
        
    total_tx = f.b + f.s
    ofi = (f.b - f.s) / total_tx if total_tx > 0 else 0
    turnover_ratio = f.v / f.l if f.l > 0 else 0

    # 🧮 讀取最新動態參數 (來自 Redis Cache)
    base_math_score = 50
    ofi_bonus = 15
    liq_bonus = 10
    vol_bonus = 15
    avg_ofi_target = 0.1
    avg_liq_target = 5000.0

    model_str = redis_client.get("cache:dynamic_scoring_model")
    if model_str:
        try:
            m = json.loads(model_str)
            base_math_score = m.get("base_math_score", 50)
            ofi_bonus = m.get("ofi_bonus_score", 15)
            liq_bonus = m.get("liq_bonus_score", 10)
            vol_bonus = m.get("volume_bonus_score", 15)
            avg_ofi_target = m.get("avg_ofi", 0.1)
            avg_liq_target = m.get("avg_entry_liq", 5000.0)
        except:
            pass

    # 🧮 塔 1：純數戰術疊加 (全動態)
    math_score = base_math_score
    if ofi >= avg_ofi_target: math_score += ofi_bonus
    if f.l >= avg_liq_target * 0.8: math_score += liq_bonus
    if 0.2 <= turnover_ratio <= 2.0: math_score += vol_bonus

    final_score = min(100, max(0, math_score))

    # 🤖 塔 2：Scikit-Learn 隨機森林概率計算
    if os.path.exists(MODEL_PATH):
        try:
            rf_model = joblib.load(MODEL_PATH)
            X_live = pd.DataFrame([[ofi, f.l]], columns=['entry_ofi', 'entry_liquidity_usd'])
            survival_prob = rf_model.predict_proba(X_live)[0][1]
            ml_score = int(survival_prob * 100)
            final_score = int((math_score + ml_score) / 2)
        except Exception:
            pass 

    return PredictResponse(score=final_score)

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
    print("🚀 [ML Engine] 啟動大數據雙塔建模 (動態參數 + EMA 記憶)...")
    try:
        # 1. 獲取 DB 動態參數
        resp = supabase.table('ai_strategy_params').select('*').in_('id', [2, 3]).execute()
        
        if resp.data and len(resp.data) > 0:
            params = next((p for p in resp.data if p['id'] == 3), resp.data[0])
        else:
            print("⚠️ [ML Engine] 找不到 id=2 或 3 的 ai_strategy_params，使用安全預設值。")
            params = {}

        lookback_days = params.get('ml_lookback_days', 14)
        ema_alpha = float(params.get('ema_alpha', 0.3)) 
        
        df = fetch_trade_patterns_paginated(lookback_days)
        if df.empty or len(df) < 10:
            print("⚠️ [ML Engine] 樣本庫不足 (需至少 10 條)，中止訓練。")
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

        # 3. 讀取昨日記憶，執行 EMA 平滑融合 (保留歷史智慧)
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

        # 4. 打包全套動態參數 + 計算結果寫入 Redis
        dynamic_model = {
            "avg_ofi": final_ofi,
            "avg_entry_liq": final_liq,
            "dynamic_sl": final_sl,
            "dynamic_tp_trigger": final_tp,
            "base_math_score": params.get('base_math_score', 50),
            "ofi_bonus_score": params.get('ofi_bonus_score', 15),
            "liq_bonus_score": params.get('liq_bonus_score', 10),
            "volume_bonus_score": params.get('volume_bonus_score', 15)
        }
        redis_client.set("cache:dynamic_scoring_model", json.dumps(dynamic_model))
        
        # 同步 SL/TP 回 DB
        supabase.table('ai_strategy_params').update({ 'stop_loss_pct': round(final_sl, 2), 'trailing_tp_trigger': round(final_tp, 2) }).in_('id', [2, 3]).execute()
        
        # 5. ML 訓練 (讀取 DB 內的超參數)
        if len((df['realized_pnl_pct'] > 0).unique()) > 1:
            n_est = params.get('rf_n_estimators', 100)
            m_depth = params.get('rf_max_depth', 5)
            rf = RandomForestClassifier(n_estimators=n_est, max_depth=m_depth, random_state=42, n_jobs=2)
            rf.fit(df[['entry_ofi', 'entry_liquidity_usd']], (df['realized_pnl_pct'] > 0).astype(int), sample_weight=df['w_time'])
            joblib.dump(rf, MODEL_PATH)
            print(f"🌲 [ML Engine] Random Forest 模型訓練完成，已儲存至 RAM ({MODEL_PATH})")

        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1:
            extract_and_save_toxic_clusters(df[['entry_ofi', 'entry_liquidity_usd']], y_toxic)

        print(f"✅ [Baseline Engine] 全管線更新完畢 (記憶體已融合, SL={final_sl:.2f}%, TP={final_tp:.2f}%)")

    except Exception as e:
        print(f"❌ [Baseline Engine] 建模管線發生崩潰: {str(e)}")

# ------------------------------------------------------------------
# 4. 全自動無人值守排程器
# ------------------------------------------------------------------
def background_scheduler():
    # 🎯 避開開機 CPU 峰值，延遲 15 秒先開始 Train Model
    print("⏳ [ML Engine] 伺服器啟動中，延遲 15 秒後再開始大數據訓練，避免 CPU 瞬間核爆...")
    time.sleep(15)
    while True:
        execute_evolution_pipeline()
        time.sleep(86400)  # 暫停 24 小時

# ------------------------------------------------------------------
# 5. 管理端點
# ------------------------------------------------------------------
@app.post("/trigger_evolution")
def trigger_evolution(background_tasks: BackgroundTasks):
    background_tasks.add_task(execute_evolution_pipeline)
    return {"status": "success", "message": "ML Evolution pipeline triggered in background."}

@app.get("/health")
def health_check():
    return {"status": "alive", "engine": "V10 Dual-Tower ML Brain", "cores": 5}

if __name__ == "__main__":
    import uvicorn
    # 🎯 終極修復：將 workers=2 改為 workers=1，防止雙核同時開機核爆
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=1, log_config="log_config.json")