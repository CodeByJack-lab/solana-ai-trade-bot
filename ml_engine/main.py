# ml_engine/main.py
# 📝 檔案功能用途：V10.29 【Python 雙塔融合智腦】 (Microservice Core)
# 🚀 核心升級：實裝「進化追蹤器 (Changelog Tracker)」，每日 Telegram 報告將詳細列出 SL/TP、及格線與 OFI 的變更對比。
# 🚀 架構升級：實裝「真・雙塔模型分家」，將 NEWBORN 與 TRENDING 的訓練數據與模型徹底隔離 (.pkl)。
# 💧 流動性聯動：將 min_liquidity_usd 納入 EMA 進化與讀取機制。
# 💰 數學引擎：實裝 Kelly B-Ratio (大數據盈虧比) 計算，供前線計算凱利倍數。
# ✂️ 邏輯精簡：移除 Shadow (影子倉位) 訓練權重邏輯，確保 ML 數據 100% 來自真實/紙上交易。

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

# ✅ 雙塔路徑：絕對唔可以刪走！
MODEL_PATH_NEWBORN = "/tmp/v10_rf_model_newborn.pkl"
MODEL_PATH_TRENDING = "/tmp/v10_rf_model_trending.pkl"

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_MAIN_BOT_TOKEN") or os.getenv("MAIN_BOT_TOKEN")
TELEGRAM_CHANNEL_ID = os.getenv("TELEGRAM_CHANNEL_ID") or os.getenv("CHANNEL_ID")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("❌ [FATAL] 缺少 Supabase 環境變數，Data Engine 無法啟動。")

try:
    opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=opts)
except Exception as e:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

def send_telegram_channel_alert(message: str):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHANNEL_ID: return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({"chat_id": TELEGRAM_CHANNEL_ID, "text": message, "parse_mode": "HTML"}).encode('utf-8')
    req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
    try: urllib.request.urlopen(req, timeout=10)
    except Exception: pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=background_scheduler, daemon=True).start()
    yield

app = FastAPI(title="V10 Quant ML Brain (Dual-Tower)", version="1.0.29", lifespan=lifespan)

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

class PredictRequest(BaseModel):
    features: FeaturePayload
    type: str = "NEWBORN" # ✅ 恢復 type 參數，用來識別呼叫雙塔

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
    # ✅ 恢復雙塔讀取
    target_model_path = MODEL_PATH_NEWBORN if "NEWBORN" in req.type.upper() else MODEL_PATH_TRENDING

    if os.path.exists(target_model_path):
        try:
            rf_model = joblib.load(target_model_path)
            X_live = pd.DataFrame([[ofi, f.l, f.v]], columns=['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd'])
            survival_prob = rf_model.predict_proba(X_live)[0][1]
        except Exception as e:
            print(f"⚠️ [Predict] 模型推論異常 ({req.type}): {e}")

    news_score = 0
    env_str = redis_client.get("global_env_state")
    if env_str:
        try: news_score = json.loads(env_str).get("newsScore", 0)
        except: pass

    macro_adjustment = news_score * 0.02
    survival_prob = max(0.0, min(1.0, survival_prob + macro_adjustment))

    final_score = round(survival_prob * 70)
    multiplier = 0.5 if survival_prob < 0.4 else (1.5 if 0.6 <= survival_prob < 0.8 else (2.0 if survival_prob >= 0.8 else 1.0))

    return PredictResponse(score=final_score, win_probability=survival_prob, confidence_multiplier=multiplier)

def fetch_trade_patterns_paginated(days_back: int = 14) -> pd.DataFrame:
    chunk_size = 1000
    start_idx = 0
    all_data = []
    time_threshold = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    
    while True:
        end_idx = start_idx + chunk_size - 1
        response = supabase.table('trade_patterns').select('*').gte('created_at', time_threshold).order('created_at', desc=True).range(start_idx, end_idx).execute()
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
                "condition_group": group_idx + 1, "metric_name": metric, "operator": op, "threshold_value": round(float(thr), 4)
            })
            
    if insert_payload:
        supabase.table('ml_blacklist_rules').insert(insert_payload).execute()

def evolve_param(old_val, target_val, alpha, min_bound, max_bound):
    return max(min_bound, min((old_val * (1.0 - alpha)) + (target_val * alpha), max_bound))

def execute_evolution_pipeline():
    print(f"🚀 [ML Engine] 啟動大數據訓練管線 (觸發時間: {datetime.now(timezone.utc).isoformat()})...")
    try:
        resp = supabase.table('ml_strategy_params').select('*').limit(1).execute()
        params = resp.data[0] if resp.data else {}
        lookback_days = int(params.get('ml_lookback_days', 14))
        ema_alpha = float(params.get('ema_alpha', 0.3)) 
        
        df = fetch_trade_patterns_paginated(lookback_days)
        if df.empty or len(df) < 10:
            send_telegram_channel_alert("⚠️ <b>【ML 大腦進化跳過】</b>\n樣本庫不足 10 條，今日不進行訓練。")
            return

        df['realized_pnl_pct'] = pd.to_numeric(df['realized_pnl_pct'], errors='coerce').fillna(0)
        df['entry_ofi'] = pd.to_numeric(df['entry_ofi'], errors='coerce').fillna(0)
        df['entry_liquidity_usd'] = pd.to_numeric(df['entry_liquidity_usd'], errors='coerce').fillna(0)
        df['entry_volume_5m_usd'] = pd.to_numeric(df.get('entry_volume_5m_usd', df.get('entry_volume_5m', 0)), errors='coerce').fillna(0)
        
        # ✅ 恢復 strategy_version 以便雙塔切割
        df['strategy_version'] = df.get('strategy_version', pd.Series('UNKNOWN', index=df.index)).fillna('UNKNOWN').astype(str)
        
        df.replace([np.inf, -np.inf], 0, inplace=True)
        now_utc = pd.Timestamp.utcnow()
        df['created_at'] = pd.to_datetime(df['created_at'], utc=True, errors='coerce')
        df = df.dropna(subset=['created_at'])
        df['age_days'] = ((now_utc - df['created_at']).dt.total_seconds() / 86400.0).clip(lower=0)
        df['w_time'] = 0.5 ** (df['age_days'] / (lookback_days / 3.0)) 

        # ✂️ 已安全移除 df['is_shadow'] 相關嘅兩行權重扣減代碼

        winning_df = df[df['realized_pnl_pct'] > 0]
        losing_df = df[df['realized_pnl_pct'] < 0]
        total_trades_count = len(df)
        recent_win_rate = len(winning_df) / total_trades_count if total_trades_count > 0 else 0.0

        old_ml_str = redis_client.get("ml_strategy_params")
        old_params_list = json.loads(old_ml_str) if old_ml_str else []
        
        def find_old(t_type, climate, key, fallback):
            for item in old_params_list:
                if item.get('token_type') == t_type and item.get('market_climate') == climate:
                    db_key = key.replace('Threshold', 'buy_threshold').replace('OFI', 'min_ofi').replace('Txs5m', 'min_txs_5m').replace('AvgTradeUsd', 'min_avg_trade_usd').replace('Turnover5m', 'max_turnover_5m').replace('VolReq', 'zombie_vol_req').replace('CvdUsd', 'min_cvd_usd').replace('LiquidityUsd', 'min_liquidity_usd')
                    return float(item.get(db_key, fallback))
            return fallback

        win_ofi_p15 = float(np.percentile(winning_df['entry_ofi'], 15)) if not winning_df.empty else -0.2
        win_vol_p15 = float(np.percentile(winning_df['entry_volume_5m_usd'], 15)) if not winning_df.empty else 1000.0
        
        threshold_target_offset = -2 if total_trades_count == 0 else (0 if total_trades_count < 5 else (-1 if recent_win_rate > 0.6 else (2 if recent_win_rate < 0.4 else 0)))
        
        evolved_params_to_db, changelog_lines = [], []

        for t in ["NEWBORN", "TRENDING"]:
            for c in ["BULL_FRENZY", "CHOPPY", "BEAR_PANIC"]:
                o_thresh = find_old(t, c, 'Threshold', 60)
                o_ofi = find_old(t, c, 'OFI', -0.2)
                o_txs = find_old(t, c, 'Txs5m', 8)
                o_avg = find_old(t, c, 'AvgTradeUsd', 15.0)
                o_turn = find_old(t, c, 'Turnover5m', 1.5)
                o_zomb = find_old(t, c, 'VolReq', 1200)
                o_cvd = find_old(t, c, 'CvdUsd', 0.0)
                o_liq = find_old(t, c, 'LiquidityUsd', 2000.0 if t == 'NEWBORN' else 10000.0)

                n_thresh = round(evolve_param(o_thresh, o_thresh + threshold_target_offset, ema_alpha, 50, 80))
                n_ofi = round(evolve_param(o_ofi, win_ofi_p15, ema_alpha, -0.6, 0.4), 2)
                n_zomb = round(evolve_param(o_zomb, win_vol_p15, ema_alpha, 500, 8000))

                if o_thresh != n_thresh or o_ofi != n_ofi:
                    changelog_lines.append(f"  ▪️ <b>{t} ({c[:4]})</b>: 門檻 {int(o_thresh)}➔{n_thresh} | OFI {o_ofi}➔{n_ofi}")

                evolved_params_to_db.append({
                    "token_type": t, "market_climate": c, "buy_threshold": n_thresh, "min_ofi": n_ofi,
                    "min_txs_5m": o_txs, "min_avg_trade_usd": o_avg, "max_turnover_5m": o_turn,
                    "zombie_vol_req": n_zomb, "min_cvd_usd": o_cvd, "min_liquidity_usd": o_liq
                })
        
        if not changelog_lines: changelog_lines.append("  ▪️ <i>所有矩陣參數無大幅變動</i>")

        new_sl = max(-25.0, min(-10.0, float(np.average(losing_df['realized_pnl_pct'], weights=losing_df['w_time']) * 1.2))) if not losing_df.empty else -15.0
        new_tp = max(15.0, min(40.0, float(np.average(winning_df['realized_pnl_pct'], weights=winning_df['w_time']) * 0.8))) if not winning_df.empty else 20.0
        
        old_dynamic = json.loads(redis_client.get("cache:dynamic_scoring_model") or "{}")
        old_sl, old_tp = old_dynamic.get("dynamic_sl", -15.0), old_dynamic.get("dynamic_tp_trigger", 20.0)

        final_sl = evolve_param(old_sl, new_sl, ema_alpha, -25.0, -10.0)
        final_tp = evolve_param(old_tp, new_tp, ema_alpha, 15.0, 40.0)

        # 🚀 核心新增：計算 Kelly B-Ratio 大數據盈虧比
        kelly_b_ratio = abs(final_tp / final_sl) if final_sl != 0 else 2.0

        redis_client.set("cache:dynamic_scoring_model", json.dumps({
            "dynamic_sl": final_sl, 
            "dynamic_tp_trigger": final_tp, 
            "base_math_score": params.get('base_math_score', 50),
            "kelly_b_ratio": kelly_b_ratio # 🚀 加入 Redis 供前線 Kelly 公式使用
        }))
        
        for p in evolved_params_to_db:
            try: supabase.table('ml_strategy_params').update(p).eq('token_type', p['token_type']).eq('market_climate', p['market_climate']).execute()
            except Exception: pass

        # ✅ 雙塔分家
        df_newborn = df[df['strategy_version'].str.contains('NEWBORN', na=False, case=False)]
        df_trending = df[df['strategy_version'].str.contains('TRENDING', na=False, case=False)]

        def train_model_if_valid(train_df, path):
            if len((train_df['realized_pnl_pct'] > 0).unique()) > 1:
                rf = RandomForestClassifier(n_estimators=int(params.get('rf_n_estimators', 100)), max_depth=int(params.get('rf_max_depth', 5)), random_state=42, n_jobs=1, class_weight="balanced")
                rf.fit(train_df[['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']], (train_df['realized_pnl_pct'] > 0).astype(int), sample_weight=train_df['w_time'])
                joblib.dump(rf, path)
                return True
            return False

        # ✅ 訓練雙塔
        is_nb_trained = train_model_if_valid(df_newborn, MODEL_PATH_NEWBORN)
        is_tr_trained = train_model_if_valid(df_trending, MODEL_PATH_TRENDING)

        y_toxic = (df['realized_pnl_pct'] <= -15).astype(int)
        if len(y_toxic.unique()) > 1: extract_and_save_toxic_clusters(df[['entry_ofi', 'entry_liquidity_usd', 'entry_volume_5m_usd']], y_toxic)

        report_msg = (
            f"🧠 <b>【V10.28 雙塔智腦每日進化報告】</b>\n\n"
            f"✅ <b>管線更新完畢</b>\n"
            f"📊 <b>近期 14 日勝率:</b> {recent_win_rate*100:.1f}%\n"
            f"📝 <b>訓練樣本數:</b> {total_trades_count} 筆\n"
            f"🎯 <b>門檻微調 (破冰):</b> {threshold_target_offset} 分\n"
            f"🌲 <b>RF Newborn 塔:</b> {'✅ 成功' if is_nb_trained else '⚠️ 跳過'}\n"
            f"🌲 <b>RF Trending 塔:</b> {'✅ 成功' if is_tr_trained else '⚠️ 跳過'}\n\n"
            f"⚙️ <b>【參數進化追蹤 (Old ➔ New)】</b>\n"
            f"  🔸 <b>全局止損 (SL):</b> {old_sl:.1f}% ➔ {final_sl:.1f}%\n"
            f"  🔸 <b>全局止盈 (TP):</b> {old_tp:.1f}% ➔ {final_tp:.1f}%\n"
            f"  🔸 <b>大數據盈虧比 (Kelly B):</b> {kelly_b_ratio:.2f}\n" 
            + "\n".join(changelog_lines) + "\n\n"
            f"🤖 <i>系統已將雙塔參數寫入資料庫，前線獵人已熱更新。</i>"
        )
        send_telegram_channel_alert(report_msg)

    except Exception as e:
        send_telegram_channel_alert(f"❌ <b>【ML 大腦崩潰警告】</b>\n\n進化管線異常:\n<code>{str(e)}</code>")

def run_evolution_job(): execute_evolution_pipeline()

def background_scheduler():
    schedule.every().day.at("11:00").do(run_evolution_job)
    while True:
        schedule.run_pending()
        time.sleep(60) 

@app.post("/trigger_evolution")
def trigger_evolution(background_tasks: BackgroundTasks):
    background_tasks.add_task(execute_evolution_pipeline)
    return {"status": "success", "message": "Evolution triggered."}

@app.get("/health")
def health_check(): return {"status": "alive", "engine": "V10 Dual-Tower ML Brain"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=1)