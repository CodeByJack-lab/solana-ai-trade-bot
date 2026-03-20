// src/services/priceService.js
const axios = require('axios');

async function getSolPriceInHKD() {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const url = `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`;
        
        const response = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 5000
        });
        
        const validPair = response.data.pairs?.find(
            p => p.quoteToken.symbol === 'USDC' || p.quoteToken.symbol === 'USDT'
        );
        
        if (validPair && validPair.priceUsd) {
            return parseFloat(validPair.priceUsd) * 7.8; 
        }
        return 1150; 
    } catch (err) {
        return 1150; 
    }
}

module.exports = { getSolPriceInHKD };