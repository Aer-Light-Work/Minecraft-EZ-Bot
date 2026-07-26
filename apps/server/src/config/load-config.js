const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const WORKFLOWS_PATH = process.env.MCBOT_WORKFLOWS_CONFIG || path.join(CONFIG_DIR, 'workflows.local.json');

const { normalizeWorkflows } = require('./workflow-config');

const SKILL_KEYS = ['combat', 'fishing', 'pathfinder', 'mining', 'supply', 'chat-command', 'openai-tools'];
const DEFAULT_SKILL_PRIORITIES = {
  combat: 55,
  fishing: 20,
  pathfinder: 30,
  mining: 45,
  supply: 85,
  'chat-command': 10,
  'openai-tools': 1
};

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function firstDefined(sources, field) {
  for (const source of sources) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) return source[field];
  }
  return undefined;
}

function normalizeSkillSettings(base = {}, override = {}) {
  const result = {};
  for (const key of SKILL_KEYS) {
    const inherited = base?.[key] || {};
    const requested = override?.[key] || {};
    const sources = key === 'supply'
      ? [requested, override?.survival, inherited, base?.survival]
      : [requested, inherited];
    const enabled = firstDefined(sources, 'enabled');
    const priority = firstDefined(sources, 'priority');
    const autoStart = firstDefined(sources, 'autoStart');
    const settings = {
      enabled: enabled === undefined ? key === 'chat-command' : enabled === true,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : DEFAULT_SKILL_PRIORITIES[key],
      autoStart: autoStart === true
    };
    if (key === 'supply') settings.notifyOnNoFood = firstDefined(sources, 'notifyOnNoFood') === true;
    result[key] = settings;
  }
  return result;
}

function coordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCoordinateObject(value) {
  if (!value || typeof value !== 'object') return null;
  const x = coordinate(value.x);
  const y = coordinate(value.y);
  const z = coordinate(value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

const SUPPLY_ROLES = ['food', 'pickaxe', 'sleep', 'storage'];

function normalizeHomeTarget(target, index = 0) {
  if (!target || typeof target !== 'object') return null;
  const position = normalizeCoordinateObject(target);
  const name = String(target.name || target.home || '').trim().replace(/^\/?(?:sethome|home)\s+/i, '').replace(/\s+/g, '_');
  if (!name || !position) return null;
  const dimension = target.dimension ? String(target.dimension).replace(/^minecraft:/, '').trim() : null;
  const arrivalHome = String(target.arrivalHome || target.viaHome || '').trim().replace(/^\/?home\s+/i, '').replace(/\s+/g, '_') || null;
  return {
    id: String(target.id || `home-target-${index + 1}`).trim() || `home-target-${index + 1}`,
    name,
    dimension,
    x: position.x,
    y: position.y,
    z: position.z,
    arrivalHome,
    enabled: target.enabled !== false,
    useServerTeleport: target.useServerTeleport !== false,
    lastSetAt: target.lastSetAt ? String(target.lastSetAt) : null
  };
}

function normalizeSupplyPoint(point, index = 0) {
  if (!point || typeof point !== 'object') return null;
  const rawContainers = Array.isArray(point.containers) ? point.containers : [];
  const containers = rawContainers.map((container) => {
    const position = normalizeCoordinateObject(container);
    if (!position) return null;
    const role = ['storage', 'pickup', 'mixed'].includes(String(container.role || '').toLowerCase()) ? String(container.role).toLowerCase() : 'mixed';
    return { ...position, role };
  }).filter(Boolean);
  const legacyPosition = normalizeCoordinateObject(point);
  if (!containers.length && legacyPosition) containers.push({ ...legacyPosition, role: 'mixed' });
  const anchor = legacyPosition || containers[0] || null;
  const home = String(point.home || point.homeName || '').trim().replace(/^\/?home\s+/i, '') || null;
  if (!anchor && !home) return null;

  const requestedRoles = Array.isArray(point.roles) ? point.roles : [];
  const roles = [...new Set(requestedRoles.map((role) => String(role).toLowerCase()).filter((role) => SUPPLY_ROLES.includes(role)))];
  if (!roles.length) {
    if (point.bed) roles.push('sleep');
    if (containers.some((container) => container.role !== 'pickup')) roles.push('storage');
    if (containers.some((container) => container.role !== 'storage')) roles.push('food', 'pickaxe');
    if (!roles.length) roles.push('food', 'pickaxe', 'sleep', 'storage');
  }

  return {
    id: String(point.id || `point-${index + 1}`).trim() || `point-${index + 1}`,
    name: String(point.name || `补给点 ${index + 1}`).trim() || `补给点 ${index + 1}`,
    home,
    roles: [...new Set(roles)],
    dimension: point.dimension ? String(point.dimension).replace(/^minecraft:/, '').trim() : null,
    x: anchor?.x ?? null,
    y: anchor?.y ?? null,
    z: anchor?.z ?? null,
    bed: normalizeCoordinateObject(point.bed),
    containers,
    scanRadius: Math.max(2, Math.min(32, Number.isFinite(Number(point.scanRadius)) ? Math.round(Number(point.scanRadius)) : 8)),
    autoDiscover: point.autoDiscover === undefined ? Boolean(home) : point.autoDiscover !== false,
    enabled: point.enabled !== false,
    priority: Number.isFinite(Number(point.priority)) ? Number(point.priority) : 0
  };
}

function normalizeBotDefinition(bot, defaults = {}, index = 0) {
  if (!bot || !bot.id || !bot.host || !bot.username) {
    throw new Error(`Bot at index ${index} needs id, host, and username.`);
  }

  const definition = {
    ...defaults,
    ...bot,
    id: String(bot.id).trim(),
    displayName: String(bot.displayName || bot.id).trim(),
    skinUsername: String(bot.skinUsername || '').trim() || null,
    enabled: bot.enabled !== false,
    port: Number(bot.port || 25565),
    viewer: {
      enabled: false,
      viewDistance: 6,
      firstPerson: false,
      ...(bot.viewer || {})
    },
    commandWhitelist: Array.isArray(bot.commandWhitelist) ? [...new Set(bot.commandWhitelist.map((name) => String(name).trim()).filter(Boolean))] : null,
    resupplyPoints: Array.isArray(bot.resupplyPoints) ? bot.resupplyPoints.map(normalizeSupplyPoint).filter(Boolean) : [],
    homeTargets: Array.isArray(bot.homeTargets) ? bot.homeTargets.map(normalizeHomeTarget).filter(Boolean) : [],
    skills: bot.skills && typeof bot.skills === 'object' ? normalizeSkillSettings(defaults.skills, bot.skills) : null
  };

  if (!definition.id) throw new Error(`Bot at index ${index} needs a non-empty id.`);
  if (!Number.isInteger(definition.port) || definition.port < 1 || definition.port > 65535) {
    throw new Error(`Bot ${definition.id} needs a valid Minecraft server port.`);
  }
  if (definition.viewer.enabled && (!Number.isInteger(definition.viewer.port) || definition.viewer.port < 1 || definition.viewer.port > 65535)) {
    throw new Error(`Bot ${definition.id} needs a valid viewer port.`);
  }
  return definition;
}

function validateBotDefinitions(bots) {
  const ids = new Set();
  const viewerPorts = new Set();
  for (const bot of bots) {
    const idKey = bot.id.toLowerCase();
    if (ids.has(idKey)) throw new Error(`Duplicate bot id: ${bot.id}`);
    ids.add(idKey);
    if (bot.viewer.enabled) {
      if (viewerPorts.has(bot.viewer.port)) throw new Error(`Duplicate viewer port: ${bot.viewer.port}`);
      viewerPorts.add(bot.viewer.port);
    }
  }
  return bots;
}

function loadConfig() {
  const botsPath = process.env.MCBOT_BOTS_CONFIG || path.join(CONFIG_DIR, 'bots.local.json');
  const whitelistPath = process.env.MCBOT_WHITELIST_CONFIG || path.join(CONFIG_DIR, 'whitelist.local.json');
  const workflowsPath = process.env.MCBOT_WORKFLOWS_CONFIG || WORKFLOWS_PATH;
  const raw = readJson(botsPath, readJson(path.join(CONFIG_DIR, 'bots.example.json'), { bots: [] }));
  const whitelist = readJson(whitelistPath, readJson(path.join(CONFIG_DIR, 'whitelist.example.json'), []));
  const workflowsRaw = readJson(workflowsPath, readJson(path.join(CONFIG_DIR, 'workflows.example.json'), { workflows: [] }));
  const workflows = normalizeWorkflows(workflowsRaw);

  if (!Array.isArray(raw.bots)) throw new Error('Config must contain a bots array.');
  if (!Array.isArray(whitelist)) throw new Error('Whitelist config must be a JSON array.');

  const defaults = {
    checkTimeoutInterval: 60000,
    viewDistance: 'tiny',
    reconnectDelayMs: 30000,
    authReconnectDelayMs: 60000,
    targetMobs: ['zombified_piglin', 'wither_skeleton', 'zombie', 'skeleton', 'spider', 'creeper'],
    ...(raw.defaults || {})
  };
  defaults.skills = normalizeSkillSettings(defaults.skills);

  const bots = validateBotDefinitions(raw.bots.map((bot, index) => normalizeBotDefinition(bot, defaults, index)));
  const ids = new Set(bots.map((bot) => bot.id));
  const web = {
    host: '127.0.0.1',
    port: 3000,
    viewerPortStart: 3101,
    autoStart: [],
    allowRawCommands: false,
    ...(raw.web || {})
  };
  if (!Number.isInteger(web.port) || web.port < 1 || web.port > 65535) throw new Error('web.port must be a valid port.');
  if (!Number.isInteger(web.viewerPortStart) || web.viewerPortStart < 1 || web.viewerPortStart > 65535) throw new Error('web.viewerPortStart must be a valid port.');
  if (!Array.isArray(web.autoStart)) throw new Error('web.autoStart must be an array of bot ids.');
  const missingAutoStart = web.autoStart.filter((id) => !ids.has(id));
  if (missingAutoStart.length) throw new Error(`Unknown bot ids in web.autoStart: ${missingAutoStart.join(', ')}`);

  return {
    rootDir: ROOT_DIR,
    configDir: CONFIG_DIR,
    dataDir: DATA_DIR,
    botsPath,
    whitelistPath,
    defaults,
    web,
    bots,
    whitelist: whitelist.map(String),
    workflowsPath,
    workflows
  };
}

function authCachePath(config, botId) {
  const target = path.join(config.dataDir, 'auth', botId);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

module.exports = {
  loadConfig,
  authCachePath,
  normalizeBotDefinition,
  normalizeSkillSettings,
  normalizeSupplyPoint,
  normalizeHomeTarget,
  validateBotDefinitions,
  readJson,
  normalizeWorkflows,
  ROOT_DIR,
  SKILL_KEYS
};
