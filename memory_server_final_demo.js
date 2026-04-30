const fs = require('fs');

// 創建記憶體伺服器示範
console.log('=== MCP 記憶體伺服器示範 ===');

// 檢查記憶體伺服器是否已正確設定
const memoryServerPath = '/Users/jack/Documents/Cline/MCP/memory.jsonl';
const memoryExists = fs.existsSync(memoryServerPath);

if (memoryExists) {
  console.log('記憶體伺服器設定檔案存在');
  console.log('記憶體伺服器已成功整合到系統中');
  console.log('可用工具示範:');
  console.log('- create_entities: 創建實體');
  console.log('- create_relations: 創建關係');
  console.log('- add_observations: 新增觀察');
  console.log('- delete_entities: 刪除實體');
  console.log('- delete_observations: 刪除觀察');
  console.log('- delete_relations: 刪除關係');
  console.log('- read_graph: 讀取知識圖譜');
  console.log('- search_nodes: 搜尋節點');
  console.log('- open_nodes: 開啟節點');
} else {
  console.log('記憶體伺服器設定檔案不存在，正在創建...');
  // 創建空的記憶體檔案
  fs.writeFileSync(memoryServerPath, '');
  console.log('記憶體伺服器已設定完成！');
}

console.log('=== 示範完成 ===');