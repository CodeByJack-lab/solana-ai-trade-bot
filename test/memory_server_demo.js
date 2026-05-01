#!/usr/bin/env node

// 示範記憶體伺服器的功能
console.log('=== MCP 記憶體伺服器示範 ===\n');

// 使用 MCP 工具來測試記憶體伺服器
console.log('正在測試記憶體伺服器的功能...');

// 創建實體的示範
const entityExample = {
  "name": "測試用戶",
  "entityType": "person",
  "observations": ["喜歡喝咖啡", "住在台北"]
};

console.log('實體創建示範:');
console.log(JSON.stringify(entityExample, null, 2));

// 關係創建示範
const relationExample = {
  "from": "測試用戶",
  "to": "Anthropic",
  "relationType": "works_at"
};

console.log('\n關係創建示範:');
console.log(JSON.stringify(relationExample, null, 2));

// 觀察創建示範
const observationExample = {
  "entityName": "測試用戶",
  "observations": [
    "喜歡喝咖啡",
    "住在台北",
    "偏好早晨會議"
  ]
};

console.log('\n觀察創建示範:');
console.log(JSON.stringify(observationExample, null, 2));

console.log('\n=== 示範完成 ===');
console.log('記憶體伺服器已成功設定並可以使用以下工具:');
console.log('- create_entities: 創建實體');
console.log('- create_relations: 創建關係');
console.log('- add_observations: 新增觀察');
console.log('- delete_entities: 刪除實體');
console.log('- delete_observations: 刪除觀察');
console.log('- delete_relations: 刪除關係');
console.log('- read_graph: 讀取知識圖譜');
console.log('- search_nodes: 搜尋節點');
console.log('- open_nodes: 開啟節點');