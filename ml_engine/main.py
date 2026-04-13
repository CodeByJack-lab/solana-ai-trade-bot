# ml_engine/main.py
# 📝 檔案功能用途：V10.23 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：配合 V10.23 三權分立架構，ML 權重滿分上調至 70 分。
# 🛡️ 數據防護：加入 np.inf 洗刷機制，絕對防止 Random Forest 被 Infinity 搞崩潰。

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

app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.23", lifespan=lifespan)

# ------------------------------------------------------------------
# 2. 即時推論端點
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
    f = req.features
    if f.l <= 0 or f.v <= 0 or math.isnan(f.p) or math.isinf(f.p):
        return PredictResponse(score=0, win_probability=0.0, confidence_multiplier=1.0)
        
    total_tx = f.b + f.s
    ofi = (f.b - f.s) / total_tx if total_tx > 0 else 0

    survival_prob = 0.5 
    if os.path.exists(MODEL_PATH):
        try:
            rf_model = joblib.load(MODEL_PATH)
            X_live = pd.DataFrame([[ofi, f.l]], columns=['entry_ofi', 'entry_liquidity_usd'])
            survival_prob = rf_model.predict_proba(X_live)[0][1]
        except Exception:
            pass 

    news_score = 0
    env_str = redis_client.get("global_env_state")
    if env_str:
        try:
            env_data = json.loads(env_str)
            news_score = env_data.get("newsScore", 0) 
        except:
            pass

    macro_adjustment = news_score * 0.02
    survival_prob += macro_adjustment
    survival_prob = max(0.0, min(1.0, survival_prob)) 

    # 🚀 V10.23 核心升級：將滿分由 65 提升至 70
    final_score = round(survival_prob * 70)

    multiplier = 1.0
    if survival_prob < 0.4:
        multiplier = 0.5   
    elif survival_prob >= 0.6 and survival_prob < 0.8:
        multiplier = 1.5   
    elif survival_prob >= 0.8:
        multiplier = 2.0   

    return PredictResponse(score=final_score, win_probability=survival_prob, confidence_multiplier=multiplier)

# ------------------------------------------------------------------
# 3. 核心大數據引擎：EMA動態記憶進化
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

def evolve_param(old_val, target_val, alpha, min_bound, max_bound):
    blended = (old_val * (1.0 - alpha)) + (target_val * alpha)
    return max(min_bound, min(blended, max_bound))

def execute_evolution_pipeline():
    print(f"🚀 [ML Engine] 啟動大數據訓練管線 (觸發時間: {datetime.now(timezone.utc).isoformat()})...")
    try:
        resp = supabase.table('ml_strategy_params').select('*').limit(1).execute()
        params = resp.data[0] if resp.data else {}

        lookback_days = int(params.get('ml_lookback_days', 14))
        ema_alpha = float(params.get('ema_alpha', 0.3)) 
        
        df = fetch_trade_patterns_paginated(lookback_days)
        if df.empty or len(df) < 10:
            print("⚠️ [ML Engine] 歷史樣本庫不足 (需至少 10 條)，中止訓練。請讓系統空轉收集數據。")
            return

        # 🚨 PREVENT INFINITY BUG: 強制洗刷 DataFrame，消滅所有 Infinity 數據
        df['realized_pnl_pct'] = pd.to_numeric(df['realized_pnl_pct'], errors='coerce').fillna(0)
        df['entry_ofi'] = pd.to_numeric(df['entry_ofi'], errors='coerce').fillna(0)
        df['entry_liquidity_usd'] = pd.to_numeric(df['entry_liquidity_usd'], errors='coerce').fillna(0)
        df['entry_volume_5m_usd'] = pd.to_numeric(df.get('entry_volume_5m_usd', df.get('entry_volume_5m', 0)), errors='coerce').fillna(0)
        
        # 核心淨化：將所有 numpy infinity 替換為 0
        df.replace([np.inf, -np.inf], 0, inplace=True)
        
        now_utc = pd.Timestamp.utcnow()
        df['created_at'] = pd.to_datetime(df['created_at'], utc=True, errors='coerce')
        df = df.dropna(subset=['created_at'])
        df['age_days'] = (now_utc - df['created_at']).dt.total_seconds() / 86400.0
        df['age_days'] = df['age_days'].clip(lower=0)
        df['w_time'] = 0.5 ** (df['age_days'] / (lookback_days / 3.0)) 

        winning_df = df[df['realized_pnl_pct'] > 0]
        losing_df = df[df['realized_pnl_pct'] < 0]

        recent_win_rate = len(winning_df) / len(df) if len(df) > 0 else 0.5

        old_ml_str = redis_client.get("ml_strategy_params")
        old_ml = json.loads(old_ml_str) if old_ml_str else {}
        
        def get_old_param(t_type, climate, key, default_val):
            try:
                return old_ml.get(t_type, {}).get(climate, {}).get(key, default_val)
            except:
                return default_val

        win_ofi_p15 = float(np.percentile(winning_df['entry_ofi'], 15)) if not winning_df.empty else -0.2
        win_vol_p15 = float(np.percentile(winning_df['entry_volume_5m_usd'], 15)) if not winning_df.empty else 1000.0
        
        threshold_target_offset = -3 if recent_win_rate > 0.5 else 3
        
        evolved_params = {
            "strategy_id": int(time.time()), 
            "NEWBORN": {
                "RAGING_BULL": {
                    "buyThreshold": round(evolve_param(get_old_param('NEWBORN','RAGING_BULL','buyThreshold', 55), 55 + threshold_target_offset, ema_alpha, 50, 65)),
                    "minOFI": round(evolve_param(get_old_param('NEWBORN','RAGING_BULL','minOFI', -0.4), win_ofi_p15 - 0.2, ema_alpha, -0.6, -0.2), 2),
                    "minTxs5m": 5, "minAvgTradeUsd": 10.0, "maxTurnover5m": 2.5,
                    "zombieVolReq": round(evolve_param(get_old_param('NEWBORN','RAGING_BULL','zombieVolReq', 800), win_vol_p15 * 0.8, ema_alpha, 500, 1500))
                },
                "CHOPPY": {
                    "buyThreshold": round(evolve_param(get_old_param('NEWBORN','CHOPPY','buyThreshold', 60), 60 + threshold_target_offset, ema_alpha, 55, 70)),
                    "minOFI": round(evolve_param(get_old_param('NEWBORN','CHOPPY','minOFI', -0.2), win_ofi_p15, ema_alpha, -0.4, 0.0), 2),
                    "minTxs5m": 8, "minAvgTradeUsd": 15.0, "maxTurnover5m": 1.5,
                    "zombieVolReq": round(evolve_param(get_old_param('NEWBORN','CHOPPY','zombieVolReq', 1200), win_vol_p15, ema_alpha, 800, 2500))
                },
                "BEAR_PANIC": {
                    "buyThreshold": round(evolve_param(get_old_param('NEWBORN','BEAR_PANIC','buyThreshold', 65), 65 + threshold_target_offset, ema_alpha, 60, 80)),
                    "minOFI": round(evolve_param(get_old_param('NEWBORN','BEAR_PANIC','minOFI', 0.0), win_ofi_p15 + 0.2, ema_alpha, -0.1, 0.3), 2),
                    "minTxs5m": 12, "minAvgTradeUsd": 20.0, "maxTurnover5m": 1.0,
                    "zombieVolReq": round(evolve_param(get_old_param('NEWBORN','BEAR_PANIC','zombieVolReq', 2000), win_vol_p15 * 1.5, ema_alpha, 1500, 4000))
                }
            },
            "TRENDING": {
                "RAGING_BULL": {
                    "buyThreshold": round(evolve_param(get_old_param('TRENDING','RAGING_BULL','buyThreshold', 55), 55 + threshold_target_offset, ema_alpha, 50, 65)),
                    "minOFI": round(evolve_param(get_old_param('TRENDING','RAGING_BULL','minOFI', -0.3), win_ofi_p15 - 0.1, ema_alpha, -0.5, -0.1), 2),
                    "minTxs5m": 8, "minAvgTradeUsd": 15.0, "maxTurnover5m": 2.0,
                    "zombieVolReq": round(evolve_param(get_old_param('TRENDING','RAGING_BULL','zombieVolReq', 1500), win_vol_p15 * 1.2, ema_alpha, 1000, 3000))
                },
                "CHOPPY": {
                    "buyThreshold": round(evolve_param(get_old_param('TRENDING','CHOPPY','buyThreshold', 60), 60 + threshold_target_offset, ema_alpha, 55, 70)),
                    "minOFI": round(evolve_param(get_old_param('TRENDING','CHOPPY','minOFI', -0.1), win_ofi_p15 + 0.1, ema_alpha, -0.3, 0.1), 2),
                    "minTxs5m": 12, "minAvgTradeUsd": 25.0, "maxTurnover5m": 1.2,
                    "zombieVolReq": round(evolve_param(get_old_param('TRENDING','CHOPPY','zombieVolReq', 3000), win_vol_p15 * 2.0, ema_alpha, 2000, 5000))
                },
                "BEAR_PANIC": {
                    "buyThreshold": round(evolve_param(get_old_param('TRENDING','BEAR_PANIC','buyThreshold', 65), 65 + threshold_target_offset, ema_alpha, 60, 80)),
                    "minOFI": round(evolve_param(get_old_param('TRENDING','BEAR_PANIC','minOFI', 0.1), win_ofi_p15 + 0.3, ema_alpha, 0.0, 0.4), 2),
                    "minTxs5m": 15, "minAvgTradeUsd": 40.0, "maxTurnover5m": 0.8,
                    "zombieVolReq": round(evolve_param(get_old_param('TRENDING','BEAR_PANIC','zombieVolReq', 5000), win_vol_p15 * 3.0, ema_alpha, 3000, 8000))
                }
            }
        }
        
        new_sl = max(-25.0, min(-10.0, float(np.average(losing_df['realized_pnl_pct'], weights=losing_df['w_time']) * 1.2))) if not losing_df.empty else -15.0
        new_tp = max(15.0, min(40.0, float(np.average(winning_df['realized_pnl_pct'], weights=winning_df['w_time']) * 0.8))) if not winning_df.empty else 20.0
        
        old_model_str = redis_client.get("cache:dynamic_scoring_model")
        old_dynamic = json.loads(old_model_str) if old_model_str else {}
        
        final_sl = evolve_param(old_dynamic.get("dynamic_sl", -15.0), new_sl, ema_alpha, -25.0, -10.0)
        final_tp = evolve_param(old_dynamic.get("dynamic_tp_trigger", 20.0), new_tp, ema_alpha, 15.0, 40.0)

        dynamic_model = {
            "dynamic_sl": final_sl,
            "dynamic_tp_trigger": final_tp,
            "base_math_score": params.get('base_math_score', 50),
            "ml_strategy_params": evolved_params 
        }
        redis_client.set("cache:dynamic_scoring_model", json.dumps(dynamic_model))
        redis_client.set("ml_strategy_params", json.dumps(evolved_params))
        
        for t_type, climates in evolved_params.items():
            if t_type in ['NEWBORN', 'TRENDING']:
                for cli, p in climates.items():
                    try:
                        supabase.table('ml_strategy_params').update({
                            'buy_threshold': p['buyThreshold'],
                            'min_ofi': p['minOFI'],
                            'min_txs_5m': p['minTxs5m'],
                            'min_avg_trade_usd': p['minAvgTradeUsd'],
                            'max_turnover_5m': p['maxTurnover5m'],
                            'zombie_vol_req': p['zombieVolReq'],
                            'stop_loss_pct': round(final_sl, 2),
                            'trailing_tp_trigger': round(final_tp, 2),
                            'updated_at': datetime.now(timezone.utc).isoformat()
                        }).eq('token_type', t_type).eq('market_climate', cli).execute()
                    except Exception as e:
                        print(f"⚠️ [ML Engine] 更新 DB 失敗 ({t_type}-{cli}): {e}")

        print(f"🧠 [ML Engine] 自動進化完成！近期勝率: {recent_win_rate*100:.1f}%。參數已受 EMA 與安全邊界約束。")
        
        if len((df['realized_pnl_pct'] > 0).unique()) > 1:
            n_est = int(params.get('rf_n_estimators', 100))
            m_depth = int(params.get('rf_max_depth', 5))
            rf = RandomForestClassifier(n_estimators=n_est, max_depth=m_depth, random_state=42, n_jobs=1)
            rf.fit(df[['entry_ofi', 'entry_liquidity_usd']], (df['realized_pnl_pct'] > 0).astype(int), sample_weight=df['w_time'])
            joblib.dump(rf, MODEL_PATH)
            print(f"🌲 [ML Engine] Random Forest 模型訓練完成 ({MODEL_PATH})")

        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1:
            extract_and_save_toxic_clusters(df[['entry_ofi', 'entry_liquidity_usd']], y_toxic)

        print(f"✅ [Baseline Engine] 全管線更新完畢")

    except Exception as e:
        print(f"❌ [Baseline Engine] 建模管線發生崩潰: {str(e)}")

# ------------------------------------------------------------------
# 4. 全自動無人值守排程器
# ------------------------------------------------------------------
def run_evolution_job():
    execute_evolution_pipeline()

def background_scheduler():
    schedule.every().day.at("11:00").do(run_evolution_job)
    print("🕒 [ML Engine] 已設定每日 HKT 19:00 (UTC 11:00) 進行大數據覆盤訓練。開機不作初次訓練。")
    
    while True:
        schedule.run_pending()
        time.sleep(60) 

# ------------------------------------------------------------------
# 5. 管理端點
# ------------------------------------------------------------------
@app.post("/trigger_evolution")
def trigger_evolution(background_tasks: BackgroundTasks):
    background_tasks.add_task(execute_evolution_pipeline)
    return {"status": "success", "message": "ML Evolution pipeline triggered in background."}

@app.get("/health")
def health_check():
    return {"status": "alive", "engine": "V10 Dual-Tower ML Brain", "cores": 1}

if __name__ == "__main__":
    import uvicorn
    import asyncio
    try:
        # 正常啟動伺服器
        uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=1, log_config="log_config.json")
    except (KeyboardInterrupt, SystemExit):
        print("🛑 [ML Engine] 收到系統中斷指令，Python 智腦已安全關機。")
    except asyncio.CancelledError:
        print("🛑 [ML Engine] 背景任務已取消，安全關機。")
    except Exception as e:
        # 🚨 絕對唔可以 pass！必須印出真實 Error，否則 Server 死咗都無人知！
        print(f"❌ [ML Engine] 啟動失敗或崩潰: {e}")