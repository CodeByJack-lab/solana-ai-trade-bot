// src/jobs/macroJob.js
const axios = require('axios');
const cron = require('node-cron');
const { supabase } = require('../config/supabase'); 

const macroJob = {
  
  /**
   * 獲取並更新恐懼與貪婪指數 (Fear & Greed Index)，並轉換為 AI 災難指數
   */
  async fetchAndUpdateIndex() {
    console.log('🌍 [MacroJob] 正在探測全球加密貨幣恐懼與貪婪指數...');
    try {
      // Call Alternative.me 免費 API (無需 API Key)
      const response = await axios.get('https://api.alternative.me/fng/?limit=1', {
        timeout: 5000 
      });

      if (response.data && response.data.data && response.data.data.length > 0) {
        const indexData = response.data.data[0];
        const fgValue = parseInt(indexData.value, 10);
        const fgSentiment = indexData.value_classification;

        // 🧠 核心轉換邏輯：
        // 貪婪指數 (0=極度恐懼, 100=極度貪婪) -> AI 災難指數 (0=和平, 100=崩盤)
        // 將數值反轉，越恐懼代表災難指數越高！
        const disasterScore = 100 - fgValue;

        // 將數據寫入 Supabase 的 system_config (id = 1) 嘅正確 Column
        const { error } = await supabase
          .from('system_config')
          .update({
            latest_news_score: disasterScore, // 👈 寫入正確的 Column
            status_msg: `大盤氣氛: ${fgSentiment} (災難指數: ${disasterScore})` // 順便 Update 狀態
          })
          .eq('id', 1);

        if (error) {
          console.error('❌ [MacroJob] 更新 Supabase 失敗:', error.message);
        } else {
          console.log(`✅ [MacroJob] 宏觀大市更新成功: F&G ${fgValue} -> 轉換為災難指數: ${disasterScore} (${fgSentiment})`);
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
    
    console.log('🕒 [MacroJob] 宏觀風控探測器已啟動 (每 6 小時自動轉換並更新災難指數)');
  }
};

module.exports = { macroJob };