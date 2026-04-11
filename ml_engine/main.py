# ml_engine/main.py
# 📝 檔案功能用途：V10 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：實裝 Scikit-Learn 隨機森林 (預測勝率) + 決策樹 (萃取毒藥特徵寫入 DB)。純數與 ML 完美混血！

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

# 🎯 終極修復：加入 ClientOptions 關閉 proxy 檢查，防止 httpx 崩潰
try:
    opts = ClientOptions(postgrest_client_timeout=10, storage_client_timeout=10)
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=opts)
except Exception as e:
    print(f"⚠️ [System] 帶 Options 建立 Supabase Client 失敗，嘗試回退原始連線。錯誤: {e}")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# ------------------------------------------------------------------
# 🎯 FastAPI Lifespan 管理 (取代舊版 on_event)
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動背景排程 (等同於舊版 startup)
    threading.Thread(target=background_scheduler, daemon=True).start()
    yield # 代表 Server 開始接收請求
    # 這裡可以放 shutdown 的清理邏輯 (目前不需)

# 將 lifespan 綁定到 FastAPI
app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.4", lifespan=lifespan)

# ------------------------------------------------------------------
# 2. 即時推論端點 (純數與 ML 融合)
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
    🧠 雙塔漏斗：結合「數學基準分」與「Random Forest 概率」，給出最終勝率
    """
    f = req.features
    if f.l <= 0 or f.v <= 0 or math.isnan(f.p) or math.isinf(f.p):
        return PredictResponse(score=0)
        
    math_score = 50 
    total_tx = f.b + f.s
    ofi = (f.b - f.s) / total_tx if total_tx > 0 else 0
    turnover_ratio = f.v / f.l if f.l > 0 else 0

    # 🧮 塔 1：純數戰術疊加 (基礎錨點)
    baseline_str = redis_client.get("cache:14d_baseline_model")
    if baseline_str:
        try:
            base = json.loads(baseline_str)
            if ofi >= base.get("avg_ofi", 0.1): math_score += 15
            if f.l >= base.get("avg_entry_liq", 5000) * 0.8: math_score += 10
            if 0.2 <= turnover_ratio <= 2.0: math_score += 15
        except:
            pass
    else:
        if ofi > 0.2: math_score += 15
        if f.l > 8000: math_score += 10
        if turnover_ratio > 0.1: math_score += 15

    final_score = min(100, max(0, math_score))

    # 🤖 塔 2：Scikit-Learn 隨機森林概率計算
    if os.path.exists(MODEL_PATH):
        try:
            rf_model = joblib.load(MODEL_PATH)
            # 將特徵轉化為 ML 訓練時的格式 [['entry_ofi', 'entry_liquidity_usd']]
            X_live = pd.DataFrame([[ofi, f.l]], columns=['entry_ofi', 'entry_liquidity_usd'])
            
            # 獲取存活概率 (Class 1)
            survival_prob = rf_model.predict_proba(X_live)[0][1]
            ml_score = int(survival_prob * 100)
            
            # 融合：純數戰術 與 ML戰略 各佔 50%
            final_score = int((math_score + ml_score) / 2)
            
        except Exception as e:
            pass # 若模型載入失敗，平滑降級使用純數 score

    return PredictResponse(score=final_score)

# ------------------------------------------------------------------
# 3. 核心大數據引擎：衰減回測、RF訓練 與 毒藥萃取
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
    if sum(y_toxic) < 5: return # 虧損樣本太少，無法萃取
    
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
            if prob > 0.75 and sum(val) >= 3: # 超過 75% 機率是毒藥
                toxic_rules.append(current_rule)

    recurse(0, [])
    
    # 清空舊規則並寫入新規則
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
    print("🚀 [ML Engine] 啟動 14 日大數據雙塔建模 (純數衰減 + Scikit-Learn)...")
    try:
        df = fetch_trade_patterns_paginated(14)
        if df.empty or len(df) < 10:
            print("⚠️ [ML Engine] 樣本庫不足 (需至少 10 條)，中止訓練。")
            return

        df['realized_pnl_pct'] = pd.to_numeric(df['realized_pnl_pct'], errors='coerce').fillna(0)
        df['entry_ofi'] = pd.to_numeric(df['entry_ofi'], errors='coerce').fillna(0)
        df['entry_liquidity_usd'] = pd.to_numeric(df['entry_liquidity_usd'], errors='coerce').fillna(0)
        
        # 🧮 1. 指數衰減權重 (Exponential Time Decay)
        now_utc = pd.Timestamp.utcnow()
        df['created_at'] = pd.to_datetime(df['created_at'], utc=True, errors='coerce')
        df = df.dropna(subset=['created_at'])
        df['age_days'] = (now_utc - df['created_at']).dt.total_seconds() / 86400.0
        df['age_days'] = df['age_days'].clip(lower=0)
        df['w_time'] = 0.5 ** (df['age_days'] / 5.0) 

        winning_df = df[df['realized_pnl_pct'] > 0]
        losing_df = df[df['realized_pnl_pct'] < 0]

        # 🧮 2. 計算最優動態止損與階梯
        suggested_sl = max(-25.0, min(-10.0, float(np.average(losing_df['realized_pnl_pct'], weights=losing_df['w_time']) * 1.2))) if not losing_df.empty else -15.0
        suggested_tp_trigger = max(15.0, min(40.0, float(np.average(winning_df['realized_pnl_pct'], weights=winning_df['w_time']) * 0.8))) if not winning_df.empty else 20.0

        if not winning_df.empty:
            avg_ofi = np.average(winning_df['entry_ofi'], weights=winning_df['w_time'])
            avg_liq = np.average(winning_df['entry_liquidity_usd'], weights=winning_df['w_time'])
            baseline = { 
                "avg_ofi": float(avg_ofi), "avg_entry_liq": float(avg_liq), 
                "buy_threshold": 70, "dynamic_sl": float(suggested_sl), "dynamic_tp_trigger": float(suggested_tp_trigger) 
            }
        else:
            baseline = { "avg_ofi": 0.2, "avg_entry_liq": 8000.0, "buy_threshold": 75, "dynamic_sl": float(suggested_sl), "dynamic_tp_trigger": float(suggested_tp_trigger) }
        
        redis_client.set("cache:14d_baseline_model", json.dumps(baseline))
        supabase.table('ai_strategy_params').update({ 'stop_loss_pct': round(suggested_sl, 2), 'trailing_tp_trigger': round(suggested_tp_trigger, 2) }).in_('id', [2, 3]).execute()
        
        # 🤖 3. 機器學習：訓練 Random Forest 模型
        X = df[['entry_ofi', 'entry_liquidity_usd']]
        y = (df['realized_pnl_pct'] > 0).astype(int) # 目標：預測是否獲利
        
        # 必須確保樣本中有贏有輸才能訓練
        if len(y.unique()) > 1:
            rf = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42, n_jobs=2)
            rf.fit(X, y, sample_weight=df['w_time'])
            joblib.dump(rf, MODEL_PATH)
            print(f"🌲 [ML Engine] Random Forest 模型訓練完成，已儲存至 RAM ({MODEL_PATH})")
        
        # ☠️ 4. 毒藥特徵萃取 (找出 PnL < -15% 的致命組合)
        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1:
            extract_and_save_toxic_clusters(X, y_toxic)

        print(f"✅ [Baseline Engine] 全管線更新完畢 (SL={suggested_sl:.2f}%, TP={suggested_tp_trigger:.2f}%)")

    except Exception as e:
        print(f"❌ [Baseline Engine] 建模管線發生崩潰: {str(e)}")

# ------------------------------------------------------------------
# 4. 全自動無人值守排程器
# ------------------------------------------------------------------
def background_scheduler():
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
    # 🎯 終極修復：載入 log_config.json 強制將 uvicorn 訊息導向 stdout，防止雲端系統誤判為 error
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=2, log_config="log_config.json")