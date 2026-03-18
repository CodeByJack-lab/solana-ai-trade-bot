const securityGuard = {
  /**
   * 🛡️ 基礎防線：極速本地校驗 (Local Validation)
   * 放棄重複的 API Call，將重型防 Rug 檢查統一交由 aiService (RugCheck) 處理，
   * 以提升 1-2 秒的拔槍速度。
   */
  async checkTokenSafety(mintAddress) {
    if (!mintAddress || typeof mintAddress !== 'string') {
        return { isSafe: false, reason: '🛑 無效的代幣地址' };
    }

    // 基本長度檢查 (Solana 地址通常為 32-44 字符)
    const cleanMint = mintAddress.trim();
    if (cleanMint.length < 32 || cleanMint.length > 44) {
        return { isSafe: false, reason: '🛑 代幣地址長度異常' };
    }

    // 基礎格式檢查 (只能包含 Base58 字符)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    if (!base58Regex.test(cleanMint)) {
        return { isSafe: false, reason: '🛑 代幣地址包含非法字符' };
    }

    // 所有 API 級別的 Mint/Freeze/LP/Socials 檢查，已統一整合至 aiService.js
    return { isSafe: true, reason: '✅ 基礎格式驗證通過' };
  }
};

module.exports = { securityGuard };