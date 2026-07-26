const DEFAULT_NODE_TIMEOUT_MS = 30000;

function result(value, branch = 'next') {
  return { value, branch };
}

class WorkflowNodeRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (!definition || typeof definition !== 'object') throw new Error('Workflow node definition must be an object.');
    const type = String(definition.type || '').trim().toLowerCase();
    if (!type) throw new Error('Workflow node definition requires a type.');
    if (typeof definition.execute !== 'function') throw new Error(`Workflow node ${type} requires an execute function.`);
    this.definitions.set(type, {
      category: 'other',
      label: type,
      description: '',
      color: '#64748b',
      inputs: [{ id: 'exec', type: 'exec', label: '执行' }],
      outputs: [{ id: 'next', type: 'exec', label: '下一步' }],
      params: [],
      ...definition,
      type
    });
    return this;
  }

  get(type) {
    return this.definitions.get(String(type || '').trim().toLowerCase()) || null;
  }

  has(type) {
    return this.definitions.has(String(type || '').trim().toLowerCase());
  }

  list() {
    return [...this.definitions.values()].map(({ execute, ...definition }) => ({
      ...definition,
      inputs: definition.inputs.map((pin) => ({ ...pin })),
      outputs: definition.outputs.map((pin) => ({ ...pin })),
      params: definition.params.map((param) => ({ ...param }))
    }));
  }

  async execute(bot, node, context) {
    const definition = this.get(node.type);
    if (!definition) throw new Error(`Unsupported workflow node type: ${node.type}`);
    const outcome = await definition.execute({ bot, node, params: node.params || {}, context });
    if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'branch') && Object.hasOwn(outcome, 'value')) return outcome;
    if (typeof outcome === 'boolean') return result(outcome, outcome ? 'true' : 'false');
    return result(outcome);
  }
}

function supplyRequirements(params = {}) {
  return {
    requirePickaxe: params.requirePickaxe !== false,
    requireFood: params.requireFood === true,
    requireStorage: params.requireStorage === true
  };
}

function createDefaultWorkflowNodeRegistry() {
  return new WorkflowNodeRegistry([
    {
      type: 'start', category: 'flow', label: '开始', description: '工作流入口。', color: '#16a34a', inputs: [],
      outputs: [{ id: 'next', type: 'exec', label: '开始' }], execute: async () => result({ started: true })
    },
    {
      type: 'ensure_mining_home', category: 'navigation', label: '设置挖矿 Home', description: '记录或验证区域挖矿锚点。', color: '#0284c7',
      outputs: [{ id: 'next', type: 'exec', label: '完成' }, { id: 'error', type: 'exec', label: '失败' }],
      execute: async ({ bot }) => { await bot.ensureRegionAnchor(); return result({ ok: true, home: bot.regionPlan?.home || null }); }
    },
    {
      type: 'has_usable_pickaxe', category: 'inventory', label: '有可用镐？', description: '检查背包、快捷栏和手持栏位中的镐子及耐久。', color: '#d97706',
      outputs: [{ id: 'true', type: 'exec', label: '有镐' }, { id: 'false', type: 'exec', label: '无镐' }, { id: 'error', type: 'exec', label: '失败' }],
      execute: async ({ bot }) => { const available = Boolean(bot.hasUsablePickaxe()); return result(available, available ? 'true' : 'false'); }
    },
    {
      type: 'find_supply_point', category: 'supply', label: '查找补给点', description: '选择能满足工具、食物或存储要求的补给点，并保存到运行变量。', color: '#7c3aed',
      outputs: [{ id: 'true', type: 'exec', label: '已找到' }, { id: 'false', type: 'exec', label: '未找到' }, { id: 'error', type: 'exec', label: '失败' }],
      params: [
        { id: 'requirePickaxe', type: 'boolean', label: '需要镐子', defaultValue: true },
        { id: 'requireFood', type: 'boolean', label: '需要食物', defaultValue: false },
        { id: 'requireStorage', type: 'boolean', label: '需要存储', defaultValue: false },
        { id: 'variable', type: 'string', label: '变量名', defaultValue: 'supplyPointId' }
      ],
      execute: async ({ bot, params, context }) => {
        const requirements = supplyRequirements(params);
        const point = typeof bot.selectSupplyPoint === 'function' ? bot.selectSupplyPoint(requirements) : null;
        const variable = String(params.variable || 'supplyPointId');
        if (point) context.variables[variable] = point.id;
        return result(point ? { id: point.id, name: point.name, home: point.home || null } : null, point ? 'true' : 'false');
      }
    },
    {
      type: 'resupply_at_point', category: 'supply', label: '传送并补给', description: '前往已选择的补给点，取出所需物资并返回。', color: '#7c3aed',
      outputs: [{ id: 'next', type: 'exec', label: '完成' }, { id: 'error', type: 'exec', label: '失败' }],
      params: [
        { id: 'pointId', type: 'string', label: '固定补给点 ID', defaultValue: '' },
        { id: 'pointVariable', type: 'string', label: '补给点变量', defaultValue: 'supplyPointId' },
        { id: 'requirePickaxe', type: 'boolean', label: '需要镐子', defaultValue: true },
        { id: 'requireFood', type: 'boolean', label: '需要食物', defaultValue: false },
        { id: 'requireStorage', type: 'boolean', label: '需要存储', defaultValue: false }
      ],
      execute: async ({ bot, params, context }) => {
        const pointId = String(params.pointId || context.variables[String(params.pointVariable || 'supplyPointId')] || '').trim();
        const requirements = supplyRequirements(params);
        const response = pointId && typeof bot.resupplyAtPoint === 'function'
          ? await bot.resupplyAtPoint(pointId, requirements)
          : await bot.maybeResupply(requirements);
        if (!response?.ok) throw new Error(response?.message || 'resupply failed');
        return result(response);
      }
    },
    {
      type: 'resupply', category: 'supply', label: '自动补给', description: '自动选择补给点并完成补给，适合作为兼容或兜底节点。', color: '#7c3aed',
      outputs: [{ id: 'next', type: 'exec', label: '完成' }, { id: 'error', type: 'exec', label: '失败' }],
      params: [
        { id: 'requirePickaxe', type: 'boolean', label: '需要镐子', defaultValue: true },
        { id: 'requireFood', type: 'boolean', label: '需要食物', defaultValue: false },
        { id: 'requireStorage', type: 'boolean', label: '需要存储', defaultValue: false }
      ],
      execute: async ({ bot, params }) => {
        const response = await bot.maybeResupply(supplyRequirements(params));
        if (!response?.ok) throw new Error(response?.message || 'resupply failed');
        return result(response);
      }
    },
    {
      type: 'goto_home', category: 'navigation', label: '传送到 Home', description: '使用服务器 /home 命令前往指定 Home。', color: '#0284c7',
      outputs: [{ id: 'next', type: 'exec', label: '完成' }, { id: 'error', type: 'exec', label: '失败' }],
      params: [{ id: 'home', type: 'string', label: 'Home 名称', required: true, defaultValue: '' }],
      execute: async ({ bot, params }) => {
        const home = String(params.home || '').trim();
        if (!home) throw new Error('goto_home requires params.home');
        const response = bot.execute('home', [home], { source: 'workflow', sender: 'workflow' });
        if (!response?.ok) throw new Error(response?.message || `could not go to Home ${home}`);
        return result(response);
      }
    },
    {
      type: 'equip', category: 'inventory', label: '装备物品', description: '按角色装备工具或武器。', color: '#d97706',
      outputs: [{ id: 'next', type: 'exec', label: '完成' }, { id: 'error', type: 'exec', label: '失败' }],
      params: [{ id: 'role', type: 'select', label: '角色', options: ['auto', 'pickaxe', 'axe', 'weapon'], defaultValue: 'pickaxe' }],
      execute: async ({ bot, params }) => {
        const response = bot.equipRole(params.role || 'auto', false);
        if (!response?.ok) throw new Error(response?.message || 'equip failed');
        return result(response);
      }
    },
    {
      type: 'start_region_mining', category: 'mining', label: '开始区域挖矿', description: '启动区域挖矿后台任务。', color: '#dc2626',
      outputs: [{ id: 'next', type: 'exec', label: '已启动' }, { id: 'error', type: 'exec', label: '失败' }],
      execute: async ({ bot }) => { const response = bot.startRegionMining(false); if (response?.ok === false) throw new Error(response.message); return result(response); }
    },
    {
      type: 'stop_region_mining', category: 'mining', label: '停止区域挖矿', description: '停止当前区域挖矿任务。', color: '#dc2626',
      execute: async ({ bot }) => result(bot.stopRegionMining())
    },
    {
      type: 'wait', category: 'flow', label: '等待', description: '等待指定毫秒数后继续。', color: '#16a34a',
      params: [{ id: 'milliseconds', type: 'number', label: '毫秒', min: 0, max: 60000, defaultValue: 1000 }],
      execute: async ({ params }) => {
        const milliseconds = Math.max(0, Math.min(60000, Number(params.milliseconds) || 0));
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        return result({ milliseconds });
      }
    },
    {
      type: 'log', category: 'debug', label: '记录日志', description: '向 Bot 日志写入一条消息。', color: '#475569',
      params: [{ id: 'message', type: 'string', label: '消息', defaultValue: 'workflow step' }],
      execute: async ({ bot, node, params }) => { const message = String(params.message || node.label || 'workflow step'); bot.log(message); return result({ message }); }
    },
    {
      type: 'end', category: 'flow', label: '结束', description: '正常结束工作流。', color: '#16a34a', outputs: [],
      execute: async () => result({ done: true })
    }
  ]);
}

module.exports = { WorkflowNodeRegistry, createDefaultWorkflowNodeRegistry, DEFAULT_NODE_TIMEOUT_MS };
