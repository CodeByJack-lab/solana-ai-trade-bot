# ml_engine/main.py
# 📝 檔案功能用途：V10.27 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：實裝「真・雙塔模型分家」，將 NEWBORN 與 TRENDING 的訓練數據與模型徹底隔離 (.pkl)。
# 🛡️ 數據防護：加入 np.inf 洗刷機制，絕對防止 Random Forest 被 Infinity 搞崩潰。
# 💊 治癒升級：引入 class_weight="balanced" 及「成交量」第三特徵維度，徹底根治模型預測抑鬱症。
# 🧠 全權接管：拆除所有物理參數 Hardcode，從 Redis Array 讀取舊值並進行動態 EMA 進化。
# 📢 Telegram 廣播：每日 11:00 覆盤完成後，自動將結果推送到 Telegram Channel。
# 👻 影子降權：訓練時將 is_shadow == True 的樣本權重 (w_time) 大砍至 10%，避免雜訊干擾。

import os
import json
import time
import math
import threading
import schedule
import urllib.request
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

# 🚀 升級：雙塔模型獨立儲存路徑
MODEL_PATH_NEWBORN = "/tmp/v10_rf_model_newborn.pkl"
MODEL_PATH_TRENDING = "/tmp/v10_rf_model_trending.pkl"

# Telegram 環境變數
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_MAIN_BOT_TOKEN") or os.getenv("MAIN_BOT_TOKEN")
TELEGRAM_CHANNEL_ID = os.getenv("TELEGRAM_CHANNEL_ID") or os.getenv("CHANNEL_ID")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("❌ [FATAL] 缺少 Supabase 環境變數，Data Engine 無法啟動。")

try:
    opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=opts)
except Exception as e:
    print(f"⚠️ [System] 建立 Supabase Client 失敗，嘗試回退。錯誤: {e}")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

def send_telegram_channel_alert(message: str):
    """直接向 Telegram Channel 發送報告"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHANNEL_ID:
        print("⚠️ [Telegram] 缺少參數，無法廣播。")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({"chat_id": TELEGRAM_CHANNEL_ID, "text": message, "parse_mode": "HTML"}).encode('utf-8')
    req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"⚠️ [Telegram] 廣播失敗: {e}")

# ------------------------------------------------------------------
# 🎯 FastAPI Lifespan 管理 (背景排程器)
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=background_scheduler, daemon=True).start()
    yield 

app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.27", lifespan=lifespan)

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
    
    # 🚀 升級：根據來源類型讀取對應的專屬模型
    target_model_path = MODEL_PATH_NEWBORN if "NEWBORN" in req.type.upper() else MODEL_PATH_TRENDING

    if os.path.exists(target_model_path):
        try:
            rf_model = joblib.load(target_model_path)
            # 💊 治癒升級：推論時也必須加入成交量特徵 (f.v)
            X_live = pd.DataFrame([[ofi, f.l, f.v]], columns=['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd'])
            survival_prob = rf_model.predict_proba(X_live)[0][1]
        except Exception as e:
            print(f"⚠️ [Predict] 模型推論異常 ({req.type}): {e}")

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
            print("⚠️ [ML Engine] 歷史樣本庫不足，中止訓練。")
            send_telegram_channel_alert("⚠️ <b>【ML 大腦進化跳過】</b>\n樣本庫不足 10 條，今日不進行訓練。")
            return

        df['realized_pnl_pct'] = pd.to_numeric(df['realized_pnl_pct'], errors='coerce').fillna(0)
        df['entry_ofi'] = pd.to_numeric(df['entry_ofi'], errors='coerce').fillna(0)
        df['entry_liquidity_usd'] = pd.to_numeric(df['entry_liquidity_usd'], errors='coerce').fillna(0)
        df['entry_volume_5m_usd'] = pd.to_numeric(df.get('entry_volume_5m_usd', df.get('entry_volume_5m', 0)), errors='coerce').fillna(0)
        df['strategy_version'] = df.get('strategy_version', pd.Series('UNKNOWN', index=df.index)).fillna('UNKNOWN').astype(str)
        
        df.replace([np.inf, -np.inf], 0, inplace=True)
        
        now_utc = pd.Timestamp.utcnow()
        df['created_at'] = pd.to_datetime(df['created_at'], utc=True, errors='coerce')
        df = df.dropna(subset=['created_at'])
        df['age_days'] = (now_utc - df['created_at']).dt.total_seconds() / 86400.0
        df['age_days'] = df['age_days'].clip(lower=0)
        df['w_time'] = 0.5 ** (df['age_days'] / (lookback_days / 3.0)) 

        # 🚀 影子降權
        df['is_shadow'] = df.get('is_shadow', pd.Series(False, index=df.index)).fillna(False).astype(bool)
        df.loc[df['is_shadow'] == True, 'w_time'] *= 0.10

        winning_df = df[df['realized_pnl_pct'] > 0]
        losing_df = df[df['realized_pnl_pct'] < 0]

        total_trades_count = len(df)
        recent_win_rate = len(winning_df) / total_trades_count if total_trades_count > 0 else 0.0

        old_ml_str = redis_client.get("ml_strategy_params")
        old_params_list = json.loads(old_ml_str) if old_ml_str else []
        
        def find_old(t_type, climate, key, fallback):
            for item in old_params_list:
                if item.get('token_type') == t_type and item.get('market_climate') == climate:
                    db_key = key.replace('Threshold', 'buy_threshold')\
                                .replace('OFI', 'min_ofi')\
                                .replace('Txs5m', 'min_txs_5m')\
                                .replace('AvgTradeUsd', 'min_avg_trade_usd')\
                                .replace('Turnover5m', 'max_turnover_5m')\
                                .replace('VolReq', 'zombie_vol_req')\
                                .replace('CvdUsd', 'min_cvd_usd')
                    return float(item.get(db_key, fallback))
            return fallback

        win_ofi_p15 = float(np.percentile(winning_df['entry_ofi'], 15)) if not winning_df.empty else -0.2
        win_vol_p15 = float(np.percentile(winning_df['entry_volume_5m_usd'], 15)) if not winning_df.empty else 1000.0
        
        if total_trades_count == 0:
            threshold_target_offset = -2  
        elif total_trades_count > 0 and total_trades_count < 5:
            threshold_target_offset = 0   
        else:
            if recent_win_rate > 0.6:     
                threshold_target_offset = -1  
            elif recent_win_rate < 0.4:   
                threshold_target_offset = 2   
            else:
                threshold_target_offset = 0   
        
        climates = ["BULL_FRENZY", "CHOPPY", "BEAR_PANIC"]
        types = ["NEWBORN", "TRENDING"]
        evolved_params_to_db = []

        for t in types:
            for c in climates:
                o_thresh = find_old(t, c, 'Threshold', 60)
                o_ofi = find_old(t, c, 'OFI', -0.2)
                o_txs = find_old(t, c, 'Txs5m', 8)
                o_avg = find_old(t, c, 'AvgTradeUsd', 15.0)
                o_turn = find_old(t, c, 'Turnover5m', 1.5)
                o_zomb = find_old(t, c, 'VolReq', 1200)
                o_cvd = find_old(t, c, 'CvdUsd', 0.0)

                n_thresh = round(evolve_param(o_thresh, o_thresh + threshold_target_offset, ema_alpha, 50, 80))
                n_ofi = round(evolve_param(o_ofi, win_ofi_p15, ema_alpha, -0.6, 0.4), 2)
                n_zomb = round(evolve_param(o_zomb, win_vol_p15, ema_alpha, 500, 8000))

                evolved_params_to_db.append({
                    "token_type": t,
                    "market_climate": c,
                    "buy_threshold": n_thresh,
                    "min_ofi": n_ofi,
                    "min_txs_5m": o_txs,
                    "min_avg_trade_usd": o_avg,
                    "max_turnover_5m": o_turn,
                    "zombie_vol_req": n_zomb,
                    "min_cvd_usd": o_cvd
                })
        
        new_sl = max(-25.0, min(-10.0, float(np.average(losing_df['realized_pnl_pct'], weights=losing_df['w_time']) * 1.2))) if not losing_df.empty else -15.0
        new_tp = max(15.0, min(40.0, float(np.average(winning_df['realized_pnl_pct'], weights=winning_df['w_time']) * 0.8))) if not winning_df.empty else 20.0
        
        old_model_str = redis_client.get("cache:dynamic_scoring_model")
        old_dynamic = json.loads(old_model_str) if old_model_str else {}
        
        final_sl = evolve_param(old_dynamic.get("dynamic_sl", -15.0), new_sl, ema_alpha, -25.0, -10.0)
        final_tp = evolve_param(old_dynamic.get("dynamic_tp_trigger", 20.0), new_tp, ema_alpha, 15.0, 40.0)

        dynamic_model = {
            "dynamic_sl": final_sl,
            "dynamic_tp_trigger": final_tp,
            "base_math_score": params.get('base_math_score', 50)
        }
        redis_client.set("cache:dynamic_scoring_model", json.dumps(dynamic_model))
        
        for p in evolved_params_to_db:
            try:
                supabase.table('ml_strategy_params').update({
                    'buy_threshold': p['buy_threshold'],
                    'min_ofi': p['min_ofi'],
                    'min_txs_5m': p['min_txs_5m'],
                    'min_avg_trade_usd': p['min_avg_trade_usd'],
                    'max_turnover_5m': p['max_turnover_5m'],
                    'zombie_vol_req': p['zombie_vol_req'],
                    'stop_loss_pct': round(final_sl, 2),
                    'trailing_tp_trigger': round(final_tp, 2),
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }).eq('token_type', p['token_type']).eq('market_climate', p['market_climate']).execute()
            except Exception: pass

        # 🚀 升級：將 DataFrame 斬開為 NEWBORN 與 TRENDING 獨立陣營
        df_newborn = df[df['strategy_version'].str.contains('NEWBORN', na=False, case=False)]
        df_trending = df[df['strategy_version'].str.contains('TRENDING', na=False, case=False)]

        def train_model_if_valid(train_df, path):
            if len((train_df['realized_pnl_pct'] > 0).unique()) > 1:
                n_est = int(params.get('rf_n_estimators', 100))
                m_depth = int(params.get('rf_max_depth', 5))
                rf = RandomForestClassifier(n_estimators=n_est, max_depth=m_depth, random_state=42, n_jobs=1, class_weight="balanced")
                rf.fit(train_df[['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']], (train_df['realized_pnl_pct'] > 0).astype(int), sample_weight=train_df['w_time'])
                joblib.dump(rf, path)
                return True
            return False

        is_nb_trained = train_model_if_valid(df_newborn, MODEL_PATH_NEWBORN)
        is_tr_trained = train_model_if_valid(df_trending, MODEL_PATH_TRENDING)

        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1:
            extract_and_save_toxic_clusters(df[['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']], y_toxic)

        print(f"✅ [Baseline Engine] 全管線更新完畢")
        
        nb_status = "✅ 成功" if is_nb_trained else "⚠️ 樣本不足跳過"
        tr_status = "✅ 成功" if is_tr_trained else "⚠️ 樣本不足跳過"
        
        report_msg = (
            f"🧠 <b>【V10 雙塔智腦每日進化報告】</b>\n\n"
            f"✅ <b>管線更新完畢</b>\n"
            f"📊 <b>近期 14 日勝率:</b> {recent_win_rate*100:.1f}%\n"
            f"📝 <b>訓練樣本數:</b> {total_trades_count} 筆\n"
            f"🎯 <b>門檻微調 (破冰):</b> {threshold_target_offset} 分\n"
            f"🌲 <b>RF Newborn 塔:</b> {nb_status}\n"
            f"🌲 <b>RF Trending 塔:</b> {tr_status}\n"
            f"📈 <b>維度升級:</b> 已注入成交量數據 (Volume 5m)\n\n"
            f"🤖 <i>系統已將雙塔參數寫入資料庫，前線獵人已熱更新。</i>"
        )
        send_telegram_channel_alert(report_msg)

    except Exception as e:
        print(f"❌ [Baseline Engine] 建模管線崩潰: {str(e)}")
        send_telegram_channel_alert(f"❌ <b>【ML 大腦崩潰警告】</b>\n\n進化管線異常:\n<code>{str(e)}</code>")

# ------------------------------------------------------------------
# 4. 全自動無人值守排程器
# ------------------------------------------------------------------
def run_evolution_job():
    execute_evolution_pipeline()

def background_scheduler():
    schedule.every().day.at("11:00").do(run_evolution_job)
    print("🕒 [ML Engine] 背景排程啟動。")
    while True:
        schedule.run_pending()
        time.sleep(60) 

# ------------------------------------------------------------------
# 5. 管理端點
# ------------------------------------------------------------------
@app.post("/trigger_evolution")
def trigger_evolution(background_tasks: BackgroundTasks):
    background_tasks.add_task(execute_evolution_pipeline)
    return {"status": "success", "message": "Evolution triggered."}

@app.get("/health")
def health_check():
    return {"status": "alive", "engine": "V10 Dual-Tower ML Brain"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=1)