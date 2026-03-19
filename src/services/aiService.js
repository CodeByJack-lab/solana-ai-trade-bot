const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const path = require('path');

// 🛡️ 確保讀取環境變數
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

// ==========================================
// 🧠 Gemini 「影分身」批次換彈管理系統
// ==========================================
class GeminiKeyManager {
    constructor() {
        // 從 GEMINI_API_KEYS 讀取多條 Key (用逗號隔開)
        const keysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
        this.apiKeys = keysString.split(',').map(k => k.trim()).filter(k => k !== "");
        this.currentKeyIndex = 0;
        this.usageCounter = 0;
        this.MAX_PER_BATCH = 10; // 十發換彈

        if (this.apiKeys.length === 0) {
            console.error("❌ [AI Engine] .env 中找不到任何 GEMINI_API_KEYS！");
        } else {
            console.log(`🧠 [AI Engine] 影分身系統啟動：共載入 ${this.apiKeys.length} 條 API Key`);
        }
    }

    /**
     * 🔄 獲取當前批次可用的 GoogleGenerativeAI 實例
     */
    getAIInstance() {
        if (this.apiKeys.length === 0) return null;

        // 打滿 10 發換彈
        if (this.usageCounter >= this.MAX_PER_BATCH) {
            this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
            this.usageCounter = 0;
            console.log(`\n🔄 [AI Engine] 批次滿額！切換至第 ${this.currentKeyIndex + 1} 條 API Key 繼續作戰`);
        }

        const activeKey = this.apiKeys[this.currentKeyIndex];
        this.usageCounter++;
        
        console.log(`📡 [AI Request] 使用 Key ${this.currentKeyIndex + 1}/${this.apiKeys.length} (批次進度: ${this.usageCounter}/10)`);
        return new GoogleGenerativeAI(activeKey);
    }

    /**
     * 🚨 遇到 429 頻率限制時強行切換 Key
     */
    forceSwitch() {
        console.warn("🚨 [AI Engine] 偵測到頻率限制，強行跳轉下一尊影分身...");
        this.usageCounter = this.MAX_PER_BATCH; 
    }
}

const keyManager = new GeminiKeyManager();

// ==========================================
// 🚀 市場數據與連線配置
// ==========================================
const HELIUS_RPC_URL = process.env.SOLANA_RPC_URL;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY; 

// 🚀 初始化官方原生 RPC 連線 (更穩定的區塊鏈讀取)
const { connection } = require('../config/solana');

// ==========================================
// 🤖 終極三級瀑布流 (3-Tier Waterfall Fallback)
// ==========================================
const AI_MODELS = [
    "gemini-3.1-flash-lite-preview", // 👑 Tier 1: 主力先鋒
    "gemma-3-27b-it",                // 🛡️ Tier 2: 重裝救兵 
    "gemma-3-12b-it"                 // 🚑 Tier 3: 終極保底 
];

// 🛡️ 監軍專用模型 (指定使用最強邏輯模型)
const REVIEWER_MODEL = "gemma-3-27b-it"; 

let currentTier = 0;               
let consecutiveFailures = 0;       
let lastResetDay = new Date().getDate(); 

function checkDailyReset() {
    const currentDay = new Date().getDate();
    if (currentDay !== lastResetDay) {
        currentTier = 0;           
        consecutiveFailures = 0;
        lastResetDay = currentDay;
        console.log(`🌅 [AI Analyst] 新一日！重置系統，恢復使用主力模型: ${AI_MODELS[0]}`);
    }
}

// ==========================================
// 🛡️ 雙重合約查家宅引擎 (區分「延遲」與「惡意」)
// ==========================================
async function fallbackNativeCheck(mintAddress) {
    try {
        const pubKey = new PublicKey(mintAddress);
        const accInfo = await connection.getParsedAccountInfo(pubKey);
        
        if (!accInfo.value) {
            return { safe: false, isMalicious: false, reason: "找不到代幣帳戶 (RPC 延遲或代幣未發行)" };
        }
        
        const info = accInfo.value.data?.parsed?.info;
        if (!info) return { safe: false, isMalicious: false, reason: "無法解析代幣結構" };

        if (info.mintAuthority !== null && info.mintAuthority !== undefined) 
            return { safe: false, isMalicious: true, reason: "危險：未放棄 Mint 權限 (原生 RPC)" };
        if (info.freezeAuthority !== null && info.freezeAuthority !== undefined) 
            return { safe: false, isMalicious: true, reason: "危險：未放棄 Freeze 權限 (原生 RPC)" };

        console.log(`✅ [Security] 原生 RPC 驗證通過，合約安全。`);
        return { safe: true };
    } catch (err) {
        return { safe: false, isMalicious: false, reason: `原生 RPC 連線異常: ${err.message}` };
    }
}

async function checkRugPull(mintAddress) {
    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`;
        const response = await axios.get(url, { timeout: 5000, headers: { 'Accept': 'application/json' } });

        if (!response.data) throw new Error("RugCheck 無回應");

        const report = response.data;
        const score = report.score || 0;

        if (score > 5000) {
            return { safe: false, isMalicious: true, reason: `RugCheck 危險分數過高 (${score}分)` };
        }

        const risks = report.risks || [];
        const hasMintRisk = risks.some(r => r.name === "Mint Authority still active" || r.value === "Minting enabled");
        const hasFreezeRisk = risks.some(r => r.name === "Freeze Authority still active");
        
        // 🚀 新增防禦：檢查 LP 是否未鎖定/未銷毀 (Liquidity Rug 剋星)
        const hasLPRisk = risks.some(r => r.name.toLowerCase().includes("liquidity not locked") || r.name.toLowerCase().includes("unlocked"));

        if (hasMintRisk) return { safe: false, isMalicious: true, reason: "危險：未放棄 Mint 權限 (RugCheck)" };
        if (hasFreezeRisk) return { safe: false, isMalicious: true, reason: "危險：未放棄 Freeze 權限 (RugCheck)" };
        if (hasLPRisk) return { safe: false, isMalicious: true, reason: "🛑 致命危險：流動性池 (LP) 未銷毀或未鎖定，極易被撤資！" };

        console.log(`✅ [Security] RugCheck 驗證通過 (未發現 Mint/Freeze/LP 撤資風險)。`);
        return { safe: true };
    } catch (err) {
        console.log(`⚠️ [Security] RugCheck API 暫時無法連線，啟動原生 RPC 備用檢查...`);
        return await fallbackNativeCheck(mintAddress);
    }
}

// ==========================================
// 🦅 存在性證實引擎 (已拔除 Jupiter Quote，完全零成本)
// ==========================================
async function checkTokenExists(mintAddress) {
    // 1. 優先使用 Birdeye API (速度最快，如果 .env 有設定的話)
    if (BIRDEYE_API_KEY) {
        try {
            const birdRes = await axios.get(`https://public-api.birdeye.so/defi/price?address=${mintAddress}`, {
                headers: { 
                    'X-API-KEY': BIRDEYE_API_KEY.replace(/['"]/g, '').trim(), 
                    'x-chain': 'solana' 
                },
                timeout: 3000
            });
            if (birdRes.data?.data?.value) return true; 
        } catch (e) {
            console.log(`⚠️ [Birdeye] 查價失敗或受限，轉用 DexScreener...`);
        }
    }
    
    // 2. 備用方案：DexScreener API (完全免費)
    try {
        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 3000 });
        if (dexRes.data && dexRes.data.pairs && dexRes.data.pairs.length > 0) {
            return true;
        }
    } catch (e) {
        console.log(`⚠️ [DexScreener] Token ${mintAddress} 查無此幣。`);
    }

    return false;
}

// ==========================================
// ⏳ DexScreener 指數退避重試引擎 (提取深層數據)
// ==========================================
async function fetchDexScreenerWithRetry(mintAddress, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 3000 });
            const pair = res.data?.pairs?.find(p => p.chainId === 'solana');
            if (pair) return pair;
        } catch (err) {}
        
        if (i < maxRetries - 1) {
            const waitTime = Math.pow(2, i + 1) * 1000;
            if (maxRetries > 1) console.log(`⏳ [DexScreener] 索引延遲，等待 ${waitTime / 1000} 秒後重試獲取深度數據...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    return null;
}

// ==========================================
// 🧠 核心大腦分析 (多維度風控進化版 + 0秒盲狙 + 5%防線)
// ==========================================
async function analyzeToken(mintAddress, metaData) {
    try {
        const cleanMint = mintAddress.trim().replace(/[^A-Za-z0-9]/g, ''); 
        console.log(`\n🛡️ [Security] 正在對 ${cleanMint} 進行合約與基本面審核...`);
        
        // 🛑 第一步：硬核合約檢查 (防爆 API 消耗)
        let securityCheck = await checkRugPull(cleanMint);
        
        if (!securityCheck.safe) {
            if (securityCheck.isMalicious) {
                console.log(`🚫 [Hard-Reject] 偵測到惡意合約特徵，不呼叫 AI: ${securityCheck.reason}`);
                return { decision: "SKIP", reason: securityCheck.reason };
            } else {
                const isReal = await checkTokenExists(cleanMint);
                if (isReal) {
                    console.log(`💡 [Security] 索引延遲但 Birdeye/DexScreener 證實代幣可交易，啟動放行機制！`);
                    securityCheck.safe = true;
                } else {
                    console.log(`🚫 [Security] 查核不合格被攔截: ${securityCheck.reason}`);
                    return { decision: "SKIP", reason: securityCheck.reason };
                }
            }
        } else {
            console.log(`✅ [Security] 合約初步安全。移交大腦深度分析...`);
        }

        // 📊 第二步：市場數據獲取與 0秒盲狙備援
        let liquidity = 0, fdv = 0, vol5m = 0, buys5m = 0, sells5m = 0;
        let hasSocials = "無";
        let isBlindSnipe = false;
        
        const pair = await fetchDexScreenerWithRetry(cleanMint);
        
        if (pair) {
            liquidity = pair.liquidity?.usd || 0;
            fdv = pair.fdv || 0;
            vol5m = pair.volume?.m5 || 0;
            buys5m = pair.txns?.m5?.buys || 0;
            sells5m = pair.txns?.m5?.sells || 0;
            
            const socials = pair.info?.socials || [];
            if (socials.length > 0) {
                const types = socials.map(s => s.type).join('/');
                hasSocials = `有 (${types})`;
            }
        } else {
            console.log(`⚠️ [Market Data] DexScreener 未索引，嘗試備援驗證...`);
            const existsOnChain = await checkTokenExists(cleanMint);
            if (!existsOnChain) {
                return { decision: "SKIP", score: 0, reason: "全網查無此幣交易對，放棄狙擊" };
            }
            console.log(`🎯 [Market Data] 觸發 0 秒盲狙模式！`);
            isBlindSnipe = true;
            liquidity = 15000; // 賦予基礎分數過硬過濾，交由 AI 決定
            fdv = 15000;
            hasSocials = "未知 (0秒新盤)";
        }

        let blindSnipeContext = isBlindSnipe ? `\n【特殊狀態】這是一個 0 秒新盤盲狙，DexScreener 尚未抓取數據但備用API已有報價。請放寬對流動性和社交媒體的要求，以「搶頭礦」的邏輯評估。` : '';

        // 🧠 第三步：強化的 AI 提示詞 (大戶思維 + 5% 安全線)
        const prompt = `
            你是一位華爾街級別的 Solana 迷因幣 (Meme Coin) 量化狙擊專家。
            請根據以下實時數據，判斷是否值得執行買入操作。我們追求的是「爆發力」與「流動性安全」。
            
            【目標代幣資訊】
            - 代幣地址: ${cleanMint}
            - 策略模式: ${metaData.strategy_type === 'HUNTER' ? '新盤爆量狙擊' : '趨勢跟單'}${blindSnipeContext}
            
            【市場深度數據】
            - 當前流動性 (Liquidity): $${liquidity} USD
            - 完全稀釋估值 (FDV): $${fdv} USD
            - 過去5分鐘交易量: $${vol5m} USD
            - 過去5分鐘買單數: ${buys5m} 筆
            - 過去5分鐘賣單數: ${sells5m} 筆
            - 官方社交媒體 (Twitter/TG): ${hasSocials}
            
            【嚴格狙擊法則 - 觸犯任何一條必須回覆 SKIP】
            1. 致命防線：如果 流動性 < $8,000 USD，100% 拒絕 (極易遭遇滑點殺或莊家撤資)。
            2. 虛高泡沫：如果 流動性 / FDV 的比例小於 5% (例如市值 100萬但流動性得 5萬)，這代表盤面極度脆弱，易被大戶砸穿，拒絕。
            3. 三無資金盤：如果「官方社交媒體」為「無」，且流動性小於 $30,000，高機率是免洗詐騙盤，拒絕。
            4. 死水盤：如果 5分鐘交易量 < $1,000 USD 且非盲狙模式，無人氣，拒絕。
            
            【通過條件】
            - 如果數據健康，流動性大於 $10,000，且流動性/市值比例大於 5%，並且具備一定交易熱度或有社交媒體支撐 (或為 0秒盲狙)，請果斷回覆 BUY。
            
            你必須僅以 JSON 格式回覆，絕對不能有任何 Markdown 標記或額外文字。格式如下：
            {
              "decision": "BUY" | "SKIP",
              "score": 0到10的整數評分,
              "reason": "繁體中文，必須包含具體的數據分析，例如：流動性達1.5萬且具備Twitter，FDV比例>5%很健康"
            }
        `;

        checkDailyReset(); 
        
        // 🛡️ 呼叫影分身 API
        const genAI = keyManager.getAIInstance();
        if (!genAI) throw new Error("無可用 API Key");

        let result = null;
        let successfulModel = "";

        try {
            const activeModelName = AI_MODELS[currentTier];
            const activeModel = genAI.getGenerativeModel({ model: activeModelName });
            
            result = await activeModel.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" } 
            });
            
            consecutiveFailures = 0; 
            successfulModel = activeModelName;
        } catch (err) {
            consecutiveFailures++;
            console.log(`⚠️ [AI Analyst] 模型 ${AI_MODELS[currentTier]} 呼叫失敗 (${consecutiveFailures}/3): ${err.message}`);
            
            if (err.message.includes('429')) keyManager.forceSwitch(); // 🚨 遇到 429 強制換彈
            
            if (consecutiveFailures >= 3) {
                if (currentTier < AI_MODELS.length - 1) {
                    currentTier++;
                    consecutiveFailures = 0;
                    console.log(`🚨 [AI Analyst] 連續 3 次失敗！系統永久降檔至: ${AI_MODELS[currentTier]}`);
                }
            }
            
            const rescueTier = (consecutiveFailures >= 3) ? currentTier : Math.min(currentTier + 1, AI_MODELS.length - 1);
            console.log(`🔄 [AI Analyst] 啟動即時救援，交由 ${AI_MODELS[rescueTier]} 處理本次訊號...`);
            
            const rescueModel = genAI.getGenerativeModel({ model: AI_MODELS[rescueTier] });
            result = await rescueModel.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
            successfulModel = AI_MODELS[rescueTier];
        }

        let rawText = result.response.text();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/); 
        if (!jsonMatch) throw new Error("AI 回傳格式不正確");
        
        const decision = JSON.parse(jsonMatch[0]);

        console.log(`🧠 [AI Decision (${successfulModel})] ${decision.decision} (評分: ${decision.score}/10) | 原因: ${decision.reason}`);
        return decision;

    } catch (err) {
        console.error("❌ [AI Analyst] 審核流程中斷:", err.message);
        if (err.message.includes('429')) keyManager.forceSwitch(); // 🚨 最終防線換彈
        return { decision: "SKIP", score: 0, reason: "所有模型皆異常或解析失敗" };
    }
}

// ==========================================
// 🛡️ 監軍部門 (Reviewer) - 智能持倉複核
// ==========================================
async function reviewActivePosition(mintAddress, positionData) {
    try {
        const pair = await fetchDexScreenerWithRetry(mintAddress, 1);
        if (!pair) return { decision: "HOLD", reason: "數據獲取失敗，暫時觀望" };

        const currentLiquidity = pair.liquidity?.usd || 0;
        const currentFDV = pair.fdv || 0;
        const vol5m = pair.volume?.m5 || 0;
        const buys5m = pair.txns?.m5?.buys || 0;
        const sells5m = pair.txns?.m5?.sells || 0;
        
        const holdTimeMins = positionData.created_at 
            ? Math.floor((Date.now() - new Date(positionData.created_at).getTime()) / 60000)
            : 10;
        
        const liqFdvRatio = currentFDV > 0 ? ((currentLiquidity / currentFDV) * 100).toFixed(2) : 0;

        const prompt = `
            你是一位頂級的 Web3 量化戰地指揮官。我們目前持有一隻 Solana 迷因幣，請根據以下【交易情報】判斷應該「繼續持有 (HOLD)」還是「立即撤退 (EXIT)」。

            【戰況情報】
            - 代幣名稱: ${positionData.name || positionData.token_symbol || 'UNKNOWN'}
            - 持倉時間: ${holdTimeMins} 分鐘
            - 入場價格: ${positionData.entry_price_sol} SOL
            - 歷史最高: ${positionData.highest_price_sol} SOL
            - 當前利潤: ${positionData.pnlPct.toFixed(2)}%

            【當前盤面數據】
            - 資金池流強流動性: $${currentLiquidity}
            - 總市值 (FDV): $${currentFDV}
            - 流動性/FDV 比例: ${liqFdvRatio}%
            - 過去 5 分鐘交易量: $${vol5m}
            - 過去 5 分鐘買單/賣單數: ${buys5m} 買 / ${sells5m} 賣

            【當初買入原因 (初心)】
            "${positionData.ai_reason || 'AI 偵測到爆發潛力'}"

            【指揮官決策條件】
            1. 致命死水：若持倉超 30 分鐘，且 5 分鐘交易量低於 $500 或買單數接近 0，立即 EXIT。
            2. 泡沫破裂：若流動性/FDV 比例跌破 5%，代表池水乾涸極易砸盤，立即 EXIT。
            3. 恐慌拋售：若目前處於虧損，且 5 分鐘內賣單數量是買單的 2.5 倍以上，不要心存僥倖，立即 EXIT。
            4. 趨勢保護：若目前有豐厚利潤，且買賣比例健康（買單 >= 賣單），即使有輕微回調也視為洗盤，選擇 HOLD。
            5. 初心破壞：對比【當初買入原因】，若當初依賴的優勢（如高流動性、高熱度）已消失，立即 EXIT。

            請僅回覆 JSON 格式，不要加任何 markdown 標記：
            {
              "decision": "HOLD" | "EXIT",
              "reason": "繁體中文理由，結合數據與條件，簡短指出致命點或看好點（限30字內）"
            }
        `;

        const genAI = keyManager.getAIInstance();
        if (!genAI) throw new Error("無可用 API Key");

        let result = null;
        let successfulModel = REVIEWER_MODEL;
        
        try {
            // 首選：強大推理的 Gemma 模型
            const model = genAI.getGenerativeModel({ model: REVIEWER_MODEL });
            result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1 } 
            });
        } catch (modelErr) {
            if (modelErr.message.includes('429')) keyManager.forceSwitch();
            // 🚑 降級回歸主力先鋒
            console.log(`⚠️ 監軍模型 ${REVIEWER_MODEL} 不可用 (${modelErr.message})，降級使用 ${AI_MODELS[0]} 複核...`);
            successfulModel = AI_MODELS[0];
            const fallbackModel = genAI.getGenerativeModel({ model: successfulModel });
            result = await fallbackModel.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
        }

        // 🛡️ Regex 萃取防護罩 (專治模型多嘴)
        let rawText = result.response.text();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI 回傳格式不正確");
        
        const decision = JSON.parse(jsonMatch[0]);
        console.log(`🧠 [Reviewer Decision (${successfulModel})] ${decision.decision} | 原因: ${decision.reason}`);
        return decision;

    } catch (err) {
        console.error(`❌ [Reviewer AI] 複核失敗:`, err.message);
        if (err.message.includes('429')) keyManager.forceSwitch();
        return { decision: "HOLD", reason: "AI 監軍通訊異常，為防誤判，暫時按兵不動" };
    }
}

// ==========================================
// 🌍 大盤宏觀風控分析
// ==========================================
async function analyzeMacroTrend(btcChangePct, currentPrice, timeWindowMins) {
    try {
        console.log(`\n🧠 [AI Macro] 正在分析大盤劇烈波動...`);
        
        const prompt = `
            你是一位頂級加密貨幣量化避險專家。
            目前比特幣 (BTC) 在過去 ${timeWindowMins} 分鐘內發生了 ${btcChangePct.toFixed(2)}% 的劇烈波動。
            當前 BTC 價格為 $${currentPrice}。
            
            我們正在 Solana 鏈上運行高風險的 Meme 幣自動狙擊策略。
            規則：
            - 如果 BTC 是急速暴跌 (小於 -2%)，這通常會引發恐慌拋售，流動性枯竭，必須暫停新交易 (pause: true)。
            - 如果 BTC 是急速暴漲 (大於 +2%)，可能導致資金從 Meme 幣撤出 (吸血行情)，若你認為風險極高，也請暫停 (pause: true)。
            - 如果你認為這只是健康的回調或洗盤，可以不暫停 (pause: false)。
            
            你必須僅以 JSON 格式回覆，不准有其他文字：
            {
              "pause": true | false,
              "reason": "簡短的宏觀市場分析與避險理由 (繁體中文)"
            }
        `;

        const genAI = keyManager.getAIInstance();
        if (!genAI) throw new Error("無可用 API Key");

        const model = genAI.getGenerativeModel({ model: AI_MODELS[currentTier] });
        
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        
        let rawText = result.response.text();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI 宏觀分析回傳格式不正確");
        
        const decision = JSON.parse(jsonMatch[0]);
        console.log(`🧠 [AI Macro Decision] 暫停接單: ${decision.pause} | 原因: ${decision.reason}`);
        
        return decision;
    } catch (err) {
        console.error("❌ [AI Macro] 大盤分析異常:", err.message);
        if (err.message.includes('429')) keyManager.forceSwitch();
        return { pause: true, reason: "AI 宏觀分析斷線，基於安全理由強制暫停" }; 
    }
}

// ==========================================
// 📈 新增：高位回落預測 (預測是否繼續下跌)
// ==========================================
async function predictTrend(mintAddress, posData, drawdownPct) {
    try {
        const prompt = `
            【高位回落預警】
            代幣: ${posData.token_symbol}
            目前已從最高位回落: ${drawdownPct.toFixed(2)}%
            當前利潤: ${posData.pnlPct.toFixed(2)}%
            
            請判斷這只是「健康的技術性回調 (WASH)」，還是「行情見頂即將暴跌 (DUMP)」。
            如果判斷為 DUMP，我們將立即賣出鎖定利潤。
            回覆 JSON：{"decision": "WASH/DUMP", "reason": "理由"}
        `;

        const genAI = keyManager.getAIInstance();
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-lite" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        return { decision: "WASH", reason: "預測失敗，預設視為洗盤" };
    }
}

// ==========================================
// 🔄 新增：橫盤接回分析 (獨立 API Key)
// ==========================================
// 獨立的 GenAI 實例，不佔用狙擊主力的 RPM
const reentryGenAI = new GoogleGenerativeAI(process.env.REENTRY_GEMINI_API_KEY || process.env.GEMINI_API_KEY);

async function analyzeReentry(mintAddress, symbol, baselinePrice) {
    try {
        console.log(`\n🔍 [Re-entry AI] 正在使用獨立 API 評估 ${symbol} 橫盤接回價值...`);
        const pair = await fetchDexScreenerWithRetry(mintAddress, 1);
        if (!pair) return { decision: "SKIP", reason: "數據獲取失敗" };

        const liquidity = pair.liquidity?.usd || 0;
        const fdv = pair.fdv || 1;
        const vol1h = pair.volume?.h1 || 0;

        const prompt = `
            【老幣接回評估 (橫盤吸籌)】
            代幣: ${symbol} (${mintAddress})
            目前橫盤價格: ${baselinePrice} SOL
            流動性: $${liquidity}
            市值 (FDV): $${fdv}
            過去1小時交易量: $${vol1h}
            
            該幣已在當前價格上下 20% 區間內完成約 30 分鐘的底部震盪洗盤。
            這通常代表底部已經築牢，或者莊家已經離場變死水。
            
            判斷標準：
            1. 流動性是否依然健康 (> $10,000)？
            2. 1小時交易量是否大於 $2,000 (代表還有資金關注)？
            如果符合條件，請回覆 BUY 準備接回；否則回覆 SKIP 刪除觀察。
            
            回覆 JSON：{"decision": "BUY/SKIP", "reason": "理由"}
        `;

        const model = reentryGenAI.getGenerativeModel({ model: "gemini-1.5-flash-lite" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error(`❌ [Re-entry AI] 分析失敗:`, err.message);
        return { decision: "SKIP", reason: "API異常" };
    }
}

// 🎯 正確導出所有需要的函數！
module.exports = { 
    analyzeToken, 
    analyzeMacroTrend, 
    reviewActivePosition, 
    predictTrend, 
    analyzeReentry 
};