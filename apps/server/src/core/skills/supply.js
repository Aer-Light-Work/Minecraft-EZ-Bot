/** Home supply combines local inventory care, fixed Home resupply, storage and nighttime sleep. */
module.exports = {
  id: 'supply',
  name: 'Home 补给、生存与仓储',
  description: '自动进食和换装，并且只在已初始化的 Home 安全锚点附近补充食物与镐子、卸载矿物和夜间睡觉；无食物提醒可单独配置。',
  commands: ['supply on', 'supply off', 'resupply status', 'sleep on', 'sleep off', 'equip auto|pickaxe|axe|weapon'],
  openaiTools: [{ name: 'manage_home_supply', description: 'Control inventory care, fixed-Home resupply, storage and nighttime sleep.', parameters: { enabled: 'boolean', sleep: 'boolean', role: 'string' } }],
  handler: 'managed-bot.setSupply'
};
