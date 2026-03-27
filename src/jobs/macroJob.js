// src/jobs/macroJob.js
const axios = require('axios');
const cron = require('node-cron');
const { supabase } = require('../config/supabase'); // 👈 確保指引正確

const macroJob = {
  
  /**
   * 獲取並更新恐懼與貪婪指數 (Fear & Greed Index)
   */
  async fetchAndUpdateIndex() {
    console.log('🌍 [MacroJob] 正在探測全球加密貨幣恐懼與貪婪指數...');
    try {
      // Call Alternative.me 免費 API (無需 API Key)
      const response = await axios.get('https://api.alternative.me/fng/?limit=1', {
        timeout: 5000 // 5秒 Timeout
      });

      if (response.data && response.data.data && response.data.data.length > 0) {
        const indexData = response.data.data[0];
        const fgValue = parseInt(indexData.value, 10);
        const fgSentiment = indexData.value_classification;

        // 將數據寫入 Supabase 的 system_config (id = 1)
        const { error } = await supabase
          .from('system_config')
          .update({
            fear_greed_index: fgValue,
            market_sentiment: fgSentiment
          })
          .eq('id', 1);

        if (error) {
          console.error('❌ [MacroJob] 更新 Supabase 失敗:', error.message);
        } else {
          console.log(`✅ [MacroJob] 宏觀大市更新成功: 數值 ${fgValue} (${fgSentiment})`);
        }
      } else {
        console.warn('⚠️ [MacroJob] API 回傳數據格式異常');
      }
    } catch (error) {
      console.error('❌ [MacroJob] 獲取恐懼與貪婪指數失敗:', error.message);
    }
  },

  /**
   * 啟動定時任務
   */
  start() {
    // 1. Bot 啟動時，即刻強制行一次攞最新數據
    this.fetchAndUpdateIndex();

    // 2. 設定 Cron Job：每 6 小時執行一次
    cron.schedule('0 */6 * * *', () => {
      this.fetchAndUpdateIndex();
    });
    
    console.log('🕒 [MacroJob] 宏觀風控探測器已啟動 (每 6 小時自動更新)');
  }
};

module.exports = { macroJob };