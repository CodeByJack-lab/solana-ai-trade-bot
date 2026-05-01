const fs = require('fs');
const path = require('path');

// 確保MCP目錄存在
const mcpDir = '/Users/jack/Documents/Cline/MCP';
if (!fs.existsSync(mcpDir)) {
  fs.mkdirSync(mcpDir, { recursive: true });
}

// 創建記憶體檔案
const memoryFilePath = path.join(mcpDir, 'memory.jsonl');
if (!fs.existsSync(memoryFilePath)) {
  fs.writeFileSync(memoryFilePath, '');
}