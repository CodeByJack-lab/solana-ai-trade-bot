// src/jobs/macroJob.js
// 📝 檔案功能用途：宏觀大市排程器。定期獲取恐懼貪婪指數，結合 BTC 物理跌幅備援機制，若市場崩盤則自動觸發系統避險拔線。

const axios = require('axios');
const cron = require('node-cron');
const { supabase } = require('../config/supabase'); 

const macroJob = {
  /**
   * 🌍 探測宏觀指數：呼叫 Alternative.me，若失敗則啟動 BTC 物理跌幅推算備援。
   */
  async fetchAndUpdateIndex() {
    console.log('🌍 [MacroJob] 正在探測全球加密貨幣恐懼與貪婪指數...');
    let disasterScore = 50; 
    let fgSentiment = "Neutral";
    let isSuccess = false;

    try {
      // 🛡️ 主力預言機 (Primary): Alternative.me (無需 API Key)
      const response = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });

      if (response.data && response.data.data && response.data.data.length > 0) {
        const indexData = response.data.data[0];
        const fgValue = parseInt(indexData.value, 10);
        fgSentiment = indexData.value_classification;
        disasterScore = 100 - fgValue; // 🔄 反轉數值：越恐懼，災難指數越高
        isSuccess = true;
      }
    } catch (error) {
      console.warn('⚠️ [MacroJob] Alternative.me API 失敗，啟動 BTC 物理備援推算...');
    }

    // 🛡️ 斷路備援 (Fallback): BTC 物理跌幅推算 (Hardcoded Backup)
    if (!isSuccess) {
        try {
            // 利用 CoinGecko 取得 BTC 24小時跌幅，判斷大市情緒
            const btcRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', { timeout: 5000 });
            const btcChange = btcRes.data?.bitcoin?.usd_24h_change || 0;
            
            if (btcChange <= -5.0) {
                disasterScore = 80;
                fgSentiment = "Extreme Fear (BTC 物理推算)";
            } else if (btcChange >= 5.0) {
                disasterScore = 20;
                fgSentiment = "Greed (BTC 物理推算)";
            } else {
                disasterScore = 50;
                fgSentiment = "Neutral (BTC 物理推算)";
            }
        } catch (btcErr) {
            console.error('❌ [MacroJob] 所有宏觀探測源失效，維持分數 50');
            return;
        }
    }

    // 💾 狀態同步：寫入 Supabase 更新系統狀態與 UI 面板
    try {
        const { error } = await supabase
          .from('system_config')
          .update({
            latest_news_score: disasterScore,
            status_msg: `大盤氣氛: ${fgSentiment} (災難指數: ${disasterScore})` 
          })
          .eq('id', 1);

        if (error) {
          console.error('❌ [MacroJob] 更新 Supabase 失敗:', error.message);
        } else {
          console.log(`✅ [MacroJob] 宏觀大市更新成功: 災難指數 ${disasterScore} (${fgSentiment})`);
        }
    } catch (dbErr) {
        console.error('❌ [MacroJob] DB 連線失敗:', dbErr.message);
    }
  },

  /**
   * 🕒 啟動定時任務：每 6 小時自動執行大市掃描，確保不過度消耗額度。
   */
  start() {
    this.fetchAndUpdateIndex();
    cron.schedule('0 */6 * * *', () => {
      this.fetchAndUpdateIndex();
    });
    console.log('🕒 [MacroJob] 宏觀風控探測器已啟動 (帶 BTC 物理斷路器備援)');
  }
};

module.exports = { macroJob };