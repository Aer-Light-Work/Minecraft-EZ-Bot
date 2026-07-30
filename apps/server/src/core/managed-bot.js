const EventEmitter = require('node:events');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { activateAuthProxy, deactivateAuthProxy } = require('./auth-proxy');
const autoEat = require('mineflayer-auto-eat').plugin;
const pvp = require('mineflayer-pvp').plugin;
const mineflayerViewer = require('prismarine-viewer').mineflayer;
const minecraftData = require('minecraft-data');
const { Vec3 } = require('vec3');
const { authCachePath, normalizeSkillSettings, normalizeSupplyPoint, normalizeHomeTarget } = require('../config/load-config');
const { TaskScheduler } = require('./task-scheduler');
const { saveBotsConfig } = require('../config/config-store');
const { WorkflowEngine } = require('./workflow-engine');

const MAX_REGION_VOLUME = 32768;
const REGION_FLUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
const REGION_CONTAINER_NAMES = new Set([
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'hopper', 'dispenser', 'dropper',
  'furnace', 'blast_furnace', 'smoker', 'brewing_stand', 'spawner', 'trial_spawner', 'vault', 'crafter', 'decorated_pot', 'chiseled_bookshelf', 'shulker_box'
]);
const REGION_PROTECTED_NAMES = new Set([
  'air', 'cave_air', 'void_air', 'bedrock', 'end_portal', 'end_portal_frame', 'nether_portal',
  'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block',
  'jigsaw', 'barrier', 'light', 'reinforced_deepslate', 'respawn_anchor', 'beacon', 'conduit',
  'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'jukebox', 'note_block',
  'crafting_table', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
  'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed', 'bed'
]);
const REGION_ALIASES = {
  containers: [...REGION_CONTAINER_NAMES],
  fluids: [...REGION_FLUIDS],
  utility: [...REGION_CONTAINER_NAMES, 'crafting_table', 'enchanting_table', 'anvil', 'beacon'],
  beds: [...REGION_PROTECTED_NAMES].filter((name) => name.endsWith('_bed') || name === 'bed')
};
const PLUG_BLOCK_NAMES = ['cobblestone', 'stone', 'deepslate', 'dirt', 'netherrack'];
const SUPPLY_CONTAINER_NAMES = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box']);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSupplyContainerName(name) {
  const normalized = cleanBlockName(name);
  return SUPPLY_CONTAINER_NAMES.has(normalized) || normalized.endsWith('_shulker_box');
}

function cleanBlockName(name) {
  return String(name || '').toLowerCase().replace(/^minecraft:/, '').trim();
}

function cleanDimension(name) {
  return String(name || '').replace(/^minecraft:/, '').trim() || null;
}

function isSafeDimension(name) {
  const value = cleanDimension(name);
  return Boolean(value && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(`minecraft:${value}`));
}

function cleanHomeName(name) {
  return String(name || '').trim().replace(/^\/?(?:sethome|home)\s+/i, '').replace(/\s+/g, '_') || null;
}

function normalizePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100
  };
}

function isRegionContainerName(name) {
  const normalized = cleanBlockName(name);
  return REGION_CONTAINER_NAMES.has(normalized) || normalized.endsWith('_shulker_box');
}

function isRegionProtectedName(name) {
  const normalized = cleanBlockName(name);
  return REGION_PROTECTED_NAMES.has(normalized) || isRegionContainerName(normalized);
}

class ManagedBot extends EventEmitter {
  constructor(config, botConfig, skinCache = null) {
    super();
    this.config = config;
    this.definition = botConfig;
    this.skinCache = skinCache;
    this.bot = null;
    this.state = 'stopped';
    this.lastError = null;
    this.lastReason = null;
    this.reconnectTimer = null;
    this.attackTimer = null;
    this.fishingTimer = null;
    this.miningTimer = null;
    this.supplyTimer = null;
    this.resourceTimer = null;
    this.regionTimer = null;
    this.maintenanceTimer = null;
    this.killAuraEnabled = false;
    this.fishing = false;
    this.mining = false;
    this.supply = false;
    this.miningTarget = null;
    this.regionPlan = this.hydrateRegionPlan(botConfig.miningRegion);
    this.regionMining = false;
    this.regionSeals = [];
    this.homeActivity = null;
    this.sleepEnabled = false;
    this.resupplyEnabled = false;
    this.resupplyBusy = false;
    this.maintenanceBusy = false;
    this.digging = false;
    this.taskScheduler = new TaskScheduler(this.effectiveSkillConfig());
    this.workflowEngine = new WorkflowEngine(config.workflows || []);
    this.resupplyPoints = Array.isArray(botConfig.resupplyPoints) ? botConfig.resupplyPoints.map(normalizeSupplyPoint).filter(Boolean) : [];
    this.homeTargets = Array.isArray(botConfig.homeTargets) ? botConfig.homeTargets.map(normalizeHomeTarget).filter(Boolean) : [];
    this.skillConfig = this.effectiveSkillConfig();
    this.supplyRole = 'auto';
    this.chatLogEnabled = false;
    this.viewerStarted = false;
    this.alertLastSent = new Map();
    this.activeAlerts = new Set();
    this.miningFailedBlocks = new Map();
    this.regionBlockedBlocks = new Map();
  }

  log(message, level = 'info') {
    const entry = { at: new Date().toISOString(), level, botId: this.id, message };
    this.emit('log', entry);
    if (level === 'error') console.error(`[${this.displayName}] ${message}`);
    else console.log(`[${this.displayName}] ${message}`);
  }

  get id() { return this.definition.id; }
  get displayName() { return this.definition.displayName; }

  start() {
    if (this.state === 'connecting' || this.state === 'online' || this.state === 'reconnecting') return;
    this.clearReconnect();
    this.desiredRunning = true;
    this.createBot();
  }

  stop() {
    this.desiredRunning = false;
    this.clearReconnect();
    this.clearRuntimeLoops();
    this.closeViewer();
    const current = this.bot;
    this.bot = null;
    if (current) {
      current.removeAllListeners();
      try { current.quit('Stopped by operator'); } catch (_) {}
    }
    this.setState('stopped');
  }

  createBot() {
    this.setState('connecting');
    this.lastError = null;

    // Activate auth proxy if configured — only affects HTTP(S) auth requests
    // (prismarine-auth for Microsoft, yggdrasil for Mojang). The raw TCP
    // connection to the Minecraft server uses net.connect() and is unaffected.
    const authProxyUrl = this.definition.authProxy;
    if (authProxyUrl) {
      this.log(`[auth-proxy] Activating proxy for auth: ${authProxyUrl}`, 'info');
      activateAuthProxy(authProxyUrl).catch((err) => {
        this.log(`[auth-proxy] Failed to activate proxy: ${err.message}`, 'warn');
      });
    }

    const options = {
      checkTimeoutInterval: this.definition.checkTimeoutInterval,
      viewDistance: this.definition.viewDistance,
      profilesFolder: authCachePath(this.config, this.id),
      ...this.definition
    };
    delete options.id;
    delete options.displayName;
    delete options.enabled;
    delete options.viewer;
    delete options.reconnectDelayMs;
    delete options.authReconnectDelayMs;
    delete options.targetMobs;
    delete options.skinUsername;
    delete options.commandWhitelist;
    delete options.resupplyPoints;
    delete options.miningRegion;
    delete options.authProxy; // not a mineflayer option; only used to patch HTTP(S) agents
    if (options.auth === 'microsoft') {
      options.onMsaCode = (data) => {
        const verification = data.verification_uri || data.verificationUri || 'https://www.microsoft.com/link';
        const code = data.user_code || data.userCode || '(missing code)';
        this.log(`Microsoft sign-in required: open ${verification} and enter code ${code}.`, 'warn');
      };
    }

    let bot;
    try {
      bot = mineflayer.createBot(options);
      bot.loadPlugin(pathfinder);
      bot.loadPlugin(autoEat);
      bot.loadPlugin(pvp);
      this.bot = bot;
      if (bot._client?.on) {
        bot._client.on('error', (error) => {
          if (this.bot !== bot) return;
          const message = String(error?.message || error || 'Minecraft protocol stream error');
          const text = message.toLowerCase();
          if (text.includes('partialreaderror') || text.includes('unexpected buffer end') || text.includes('varint') || text.includes('missing characters in string')) {
            this.handleProtocolError(bot, message);
            return;
          }
          this.lastError = message;
          this.log(`Minecraft protocol stream error: ${message}`, 'error');
        });
      }
    } catch (error) {
      this.lastError = error.message;
      this.log(`Failed to create bot: ${error.message}`, 'error');
      this.scheduleReconnect('create_error');
      return;
    }

    bot.on('login', () => {
      this.log(`${bot.username || this.displayName} logged in.`);
      // Deactivate auth proxy: auth is done, no more HTTP auth requests needed.
      if (authProxyUrl) {
        deactivateAuthProxy();
        this.log('[auth-proxy] Deactivated proxy after successful login.', 'info');
      }
      if (this.skinCache && bot.username) {
        this.skinCache.ensure(this.id, bot.username, true).then((status) => {
          if (status.cached) this.log(`Player skin cached for ${status.username}.`);
        }).catch((error) => this.log(`Player skin cache failed: ${error.message}`, 'warn'));
      }
    });

    bot.on('spawn', () => {
      if (this.bot !== bot) return;
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye']
      };
      bot.autoEat.disable();
      this.setState('online');
      this.startViewer();
      this.startAttackLoop();
      this.startResourceMonitor();
      this.applyConfiguredSkills();
      this.log('Ready for commands.');
    });

    bot.on('chat', (username, message) => this.handleChat(username, message));
    bot.on('health', () => this.checkResourceAlerts());

    bot.on('end', (reason) => {
      if (this.bot !== bot) return;
      this.closeViewer();
      this.clearRuntimeLoops();
      this.bot = null;
      this.lastReason = String(reason || 'connection closed');
      this.log(`Disconnected: ${this.lastReason}`, 'warn');
      if (this.desiredRunning) this.scheduleReconnect('end');
      else this.setState('stopped');
    });

    bot.on('error', (error) => {
      if (this.bot !== bot) return;
      // Deactivate proxy on auth errors (cleanup)
      if (authProxyUrl) deactivateAuthProxy();
      const text = String(error.message || error).toLowerCase();
      if (text.includes('auth') || text.includes('obtain profile data')) {
        this.lastError = error.message;
        this.log(error.message, 'error');
        this.scheduleReconnect('auth_error');
      } else if (text.includes('partialreaderror') || text.includes('unexpected buffer end') || text.includes('varint') || text.includes('missing characters in string')) {
        this.handleProtocolError(bot, error.message);
      } else {
        this.lastError = error.message;
        this.log(error.message, 'error');
        if (error.code === 'ECONNRESET') this.scheduleReconnect('network_error');
      }
    });
  }

  handleProtocolError(bot, error) {
    if (this.bot !== bot || !this.desiredRunning) return;
    const message = String(error?.message || error || 'Minecraft protocol decode error');
    this.lastError = message;
    this.log(`Minecraft protocol state is invalid; reconnecting instead of continuing with stale inventory: ${message}`, 'error');
    this.closeViewer();
    this.clearRuntimeLoops();
    this.bot = null;
    try { bot.end('Protocol decode error'); } catch (_) {
      try { bot._client?.end(); } catch (_) {}
    }
    this.scheduleReconnect('protocol_error');
  }

  scheduleReconnect(type) {
    if (!this.desiredRunning || this.reconnectTimer) return;
    const delay = type === 'auth_error' ? this.definition.authReconnectDelayMs : this.definition.reconnectDelayMs;
    this.setState('reconnecting');
    this.log(`Reconnect scheduled in ${Math.round(delay / 1000)}s (${type}).`, 'warn');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredRunning) return;
      const stale = this.bot;
      if (stale) {
        this.closeViewer();
        this.clearRuntimeLoops();
        this.bot = null;
        stale.removeAllListeners();
        try { stale.quit('Reconnecting'); } catch (_) {}
      }
      this.createBot();
    }, delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  setState(state) {
    this.state = state;
    this.emit('state', this.publicStatus());
  }

  startViewer() {
    const viewer = this.definition.viewer;
    if (!viewer?.enabled || this.viewerStarted || !this.bot?.entity) return;
    try {
      mineflayerViewer(this.bot, {
        port: viewer.port,
        viewDistance: viewer.viewDistance,
        firstPerson: viewer.firstPerson
      });
      this.viewerStarted = true;
      this.log(`${viewer.firstPerson ? 'First' : 'Third'}-person viewer listening on port ${viewer.port}.`);
    } catch (error) {
      this.log(`Viewer failed to start: ${error.message}`, 'error');
    }
  }

  closeViewer() {
    if (this.bot?.viewer?.close) {
      try { this.bot.viewer.close(); } catch (_) {}
    }
    this.viewerStarted = false;
    this.alertLastSent = new Map();
    this.activeAlerts = new Set();
    this.miningFailedBlocks = new Map();
    this.regionBlockedBlocks = new Map();
  }

  effectiveSkillConfig() {
    return normalizeSkillSettings(this.config.defaults?.skills || {}, this.definition.skills || {});
  }

  updateSkillConfig(settings) {
    this.skillConfig = normalizeSkillSettings(this.config.defaults?.skills || {}, settings || {});
    this.taskScheduler.configure(this.skillConfig);
    if (this.bot?.entity) this.applyConfiguredSkills();
    this.emit('state', this.publicStatus());
    return this.skillConfig;
  }

  applyConfiguredSkills() {
    const skills = this.effectiveSkillConfig();
    this.skillConfig = skills;
    this.taskScheduler.configure(skills);
    this.chatLogEnabled = skills['chat-command'].enabled;

    if (!skills.combat.enabled) {
      this.killAuraEnabled = false;
      this.bot?.pvp?.stop?.();
    } else if (skills.combat.autoStart) {
      this.killAuraEnabled = true;
    }

    if (!skills.supply.enabled) {
      this.setSupply('off', false);
    } else if (skills.supply.autoStart) {
      this.setSupply('on', false);
    }

    if (!skills.fishing.enabled && this.fishing) {
      this.fishing = false;
      if (this.fishingTimer) clearTimeout(this.fishingTimer);
      this.fishingTimer = null;
    } else if (skills.fishing.enabled && skills.fishing.autoStart && !this.fishing) {
      this.startFishing(false);
    }

    if (!skills.mining.enabled) {
      this.mining = false;
      this.miningTarget = null;
      if (this.miningTimer) clearTimeout(this.miningTimer);
      this.miningTimer = null;
      if (this.regionMining) this.stopRegionMining();
    } else if (skills.mining.autoStart && this.regionPlan && !this.regionMining && !this.mining) {
      this.startRegionMining(false);
    }

    if (skills.pathfinder.enabled) this.log('Pathfinder skill enabled; navigation is available to other skills.');
  }

  serializedSupplyPoints() {
    return this.resupplyPoints.map((point) => ({
      ...point,
      roles: [...(point.roles || [])],
      containers: (point.containers || []).map((container) => ({ ...container })),
      bed: point.bed ? { ...point.bed } : null
    }));
  }

  configureSupplyPoints(points = []) {
    this.resupplyPoints = Array.isArray(points) ? points.map(normalizeSupplyPoint).filter(Boolean) : [];
    const next = this.config.bots.map((bot) => bot.id === this.id ? { ...bot, resupplyPoints: this.serializedSupplyPoints() } : bot);
    saveBotsConfig(this.config, next);
    this.config.bots = next;
    this.definition = next.find((bot) => bot.id === this.id) || this.definition;
    if (this.supply && (this.sleepEnabled || this.resupplyEnabled)) this.startMaintenanceLoop();
    this.emit('state', this.publicStatus());
    return this.resupplyPoints;
  }

  serializedHomeTargets() {
    return this.homeTargets.map((target) => ({ ...target }));
  }

  configureHomeTargets(targets = []) {
    const normalized = Array.isArray(targets) ? targets.map(normalizeHomeTarget).filter(Boolean) : [];
    const ids = new Set();
    for (const target of normalized) {
      if (ids.has(target.id)) target.id = `${target.id}-${ids.size + 1}`;
      ids.add(target.id);
    }
    this.homeTargets = normalized;
    const next = this.config.bots.map((bot) => bot.id === this.id ? { ...bot, homeTargets: this.serializedHomeTargets() } : bot);
    saveBotsConfig(this.config, next);
    this.config.bots = next;
    this.definition = next.find((bot) => bot.id === this.id) || this.definition;
    this.emit('state', this.publicStatus());
    return this.homeTargets;
  }

  async setHomeTarget(targetId) {
    if (!this.bot?.entity || this.state !== 'online') return { ok: false, message: `${this.displayName} is not online.` };
    const key = String(targetId || '').trim();
    const target = this.homeTargets.find((item) => item.enabled !== false && (item.id === key || item.name === key));
    if (!target) return { ok: false, message: `Unknown or disabled Home target: ${key}` };
    const targetDimension = cleanDimension(target.dimension) || this.currentDimension();
    if (target.dimension && !isSafeDimension(target.dimension)) return { ok: false, message: `Invalid target dimension: ${target.dimension}` };
    const targetPosition = new Vec3(target.x, target.y, target.z);
    this.homeActivity = { home: target.name, type: 'home', state: 'traveling', message: `正在前往 ${target.name}（${targetDimension}）设定 Home` };
    this.emit('state', this.publicStatus());
    try {
      if (this.currentDimension() !== targetDimension) {
        if (target.arrivalHome) {
          const moved = await this.issueServerCommand(`/home ${target.arrivalHome}`, true);
          if (!moved && this.currentDimension() !== targetDimension) throw new Error(`Home ${target.arrivalHome} did not teleport the bot`);
        } else if (target.useServerTeleport !== false) {
          const dimensionId = `minecraft:${targetDimension}`;
          const command = `/execute in ${dimensionId} run tp ${this.bot.username} ${target.x} ${target.y} ${target.z}`;
          const moved = await this.issueServerCommand(command, true);
          if (!moved) throw new Error('cross-dimension teleport did not move the bot; grant teleport permission or configure arrivalHome');
        } else {
          throw new Error(`target is in ${targetDimension}; configure arrivalHome or enable server teleport`);
        }
      }
      if (this.currentDimension() !== targetDimension) throw new Error(`arrived in ${this.currentDimension() || 'unknown'}, expected ${targetDimension}`);
      if (this.bot.entity.position.distanceTo(targetPosition) > 8) {
        await this.moveNearPosition(targetPosition, 2, 'pathfinder');
      }
      if (this.bot.entity.position.distanceTo(targetPosition) > 8) throw new Error('could not reach the configured Home coordinates');
      await this.issueServerCommand(`/sethome ${target.name}`);
      target.lastSetAt = new Date().toISOString();
      const next = this.config.bots.map((bot) => bot.id === this.id ? { ...bot, homeTargets: this.serializedHomeTargets() } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      this.definition = next.find((bot) => bot.id === this.id) || this.definition;
      this.homeActivity = { home: target.name, type: 'home', state: 'ready', message: `已在 ${targetDimension} ${target.x}, ${target.y}, ${target.z} 设定 Home` };
      this.emit('state', this.publicStatus());
      this.log(`Home ${target.name} set at ${target.x},${target.y},${target.z} in ${targetDimension}.`);
      return { ok: true, message: `Home ${target.name} set successfully.`, target: { ...target } };
    } catch (error) {
      this.homeActivity = { home: target.name, type: 'home', state: 'error', message: `设定 Home 失败：${error.message}` };
      this.emit('state', this.publicStatus());
      this.log(`Set Home target ${target.name} failed: ${error.message}`, 'warn');
      return { ok: false, message: error.message };
    }
  }

  startAttackLoop() {
    if (this.attackTimer) return;
    this.attackTimer = setInterval(() => {
      if (this.killAuraEnabled) this.stationaryAttack();
    }, 650);
  }

  clearRuntimeLoops() {
    this.killAuraEnabled = false;
    if (this.attackTimer) clearInterval(this.attackTimer);
    this.attackTimer = null;
    if (this.fishingTimer) clearTimeout(this.fishingTimer);
    this.fishingTimer = null;
    if (this.miningTimer) clearTimeout(this.miningTimer);
    this.miningTimer = null;
    if (this.supplyTimer) clearTimeout(this.supplyTimer);
    this.supplyTimer = null;
    if (this.resourceTimer) clearTimeout(this.resourceTimer);
    this.resourceTimer = null;
    if (this.regionTimer) clearTimeout(this.regionTimer);
    this.regionTimer = null;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.fishing = false;
    this.mining = false;
    this.supply = false;
    this.sleepEnabled = false;
    this.resupplyEnabled = false;
    this.regionMining = false;
    this.digging = false;
    if (this.regionPlan) this.regionPlan.active = false;
    this.miningTarget = null;
    if (this.bot?.autoEat?.disable) this.bot.autoEat.disable();
  }

  handleChat(username, message) {
    if (!this.bot || String(username).toLowerCase() === String(this.bot.username).toLowerCase()) return;
    if (!this.effectiveSkillConfig()['chat-command'].enabled) return;
    if (this.chatLogEnabled) this.log(`[CHAT] <${username}> ${message}`);
    const whitelist = Array.isArray(this.definition.commandWhitelist) ? this.definition.commandWhitelist : this.config.whitelist;
    const allowed = whitelist.some((name) => name.toLowerCase() === String(username).toLowerCase());
    if (!allowed) return;

    const parsed = this.parseChatCommand(message);
    if (!parsed) return;
    this.log(`Accepted chat command from ${username}: ${parsed.command} ${parsed.args.join(' ')}`.trim());
    this.execute(parsed.command, parsed.args, { source: 'chat', sender: username });
  }

  parseChatCommand(message) {
    const tokens = String(message || '').trim().replace(/^!/, '').split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;

    if (this.isTarget(tokens[0])) {
      return { command: tokens[1], args: tokens.slice(2) };
    }

    const knownCommands = new Set(['help', 'come', 'tpa', 'sethome', 'home', 'delhome', 'cmd', 'kill', 'attack', 'status', 'info', 'follow', 'stop', 'fish', 'mine', 'gather', 'supply', 'restock', 'equip', 'area', 'region', 'minearea', 'sleep', 'resupply', 'unseal', 'look', 'workflow', 'flow']);
    if (knownCommands.has(tokens[0].toLowerCase()) && this.isTarget(tokens[tokens.length - 1])) {
      return { command: tokens[0], args: tokens.slice(1, -1) };
    }
    return null;
  }

  isTarget(target) {
    const normalized = String(target || '').toLowerCase();
    const aliases = [this.id, this.displayName, this.bot?.username].filter(Boolean).map((value) => String(value).toLowerCase());
    return normalized === 'all' || aliases.includes(normalized);
  }

  execute(command, args = [], context = { source: 'console', sender: 'CONSOLE' }) {
    const bot = this.bot;
    const normalized = String(command || '').toLowerCase();
    if (normalized === 'help') return { ok: true, message: this.helpText() };
    if (!bot || this.state !== 'online') return { ok: false, message: `${this.displayName} is not online.` };

    if (normalized === 'come' || normalized === 'tpa') {
      const recipient = context.source === 'chat' ? context.sender : args[0];
      if (!recipient) return { ok: false, message: 'Usage: come <PlayerName>' };
      return this.sendChat(`/tpa ${recipient}`);
    }
    if (normalized === 'sethome' || normalized === 'home' || normalized === 'delhome') {
      const home = args.join(' ').trim();
      if (!home) return { ok: false, message: `Usage: ${normalized} <name>` };
      return this.sendChat(`/${normalized} ${home}`);
    }
    if (normalized === 'cmd') {
      if (context.source === 'web' && !this.config.web.allowRawCommands) {
        return { ok: false, message: 'Raw commands are disabled for Web UI. Enable web.allowRawCommands in local config.' };
      }
      const raw = args.join(' ');
      if (!raw) return { ok: false, message: 'Usage: cmd /<minecraft command>' };
      return this.sendChat(raw.startsWith('/') ? raw : `/${raw}`);
    }
    if (normalized === 'kill' || normalized === 'attack') {
      const state = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(state)) return { ok: false, message: 'Usage: kill on|off' };
      this.killAuraEnabled = state === 'on';
      if (!this.killAuraEnabled) bot.pvp.stop();
      return this.respond(`[${bot.username}] Kill Aura: ${state.toUpperCase()}`);
    }
    if (normalized === 'status' || normalized === 'info') {
      if (args[0] === 'on') this.chatLogEnabled = true;
      if (args[0] === 'off') this.chatLogEnabled = false;
      if (args[0] === 'on' || args[0] === 'off') return this.respond(`Chat log ${args[0]}.`);
      const message = this.statusMessage();
      if (context.source === 'chat') this.sendChat(message);
      return { ok: true, message, status: this.publicStatus() };
    }
    if (normalized === 'follow') {
      const targetName = context.source === 'chat' ? context.sender : args[0];
      if (!targetName) return { ok: false, message: 'Usage: follow <PlayerName>' };
      const player = bot.players[targetName];
      if (!player?.entity) return this.respond(`[${bot.username}] I cannot see ${targetName}.`);
      const movements = new Movements(bot, minecraftData(bot.version));
      movements.canDig = false;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
      return this.respond(`[${bot.username}] Following ${targetName}.`);
    }
    if (normalized === 'stop') {
      bot.pathfinder.setGoal(null);
      bot.pvp.stop();
      this.clearRuntimeLoops();
      return this.respond(`[${bot.username}] Stopped all active skills.`);
    }
    if (normalized === 'fish') return this.startFishing();
    if (normalized === 'mine' || normalized === 'gather') return this.startMining(args);
    if (normalized === 'supply' || normalized === 'restock') return this.setSupply(args[0]);
    if (normalized === 'equip') return this.equipRole(args[0] || 'auto');
    if (normalized === 'area' || normalized === 'region' || normalized === 'minearea') return this.executeRegionCommand(args);
    if (normalized === 'sleep') return this.setSleepMode(args[0]);
    if (normalized === 'resupply') return this.executeResupplyCommand(args);
    if (normalized === 'unseal') return this.unsealFluids();
    if (normalized === 'look') return this.lookCommand(args);
    if (normalized === 'workflow' || normalized === 'flow') {
      const workflowId = String(args[0] || '').trim();
      if (!workflowId) return { ok: false, message: 'Usage: workflow run <workflowId>' };
      const id = workflowId.toLowerCase() === 'run' ? String(args[1] || '').trim() : workflowId;
      if (!id) return { ok: false, message: 'Usage: workflow run <workflowId>' };
      this.runWorkflow(id)
        .then((result) => this.log(`Workflow ${id} completed: ${result.trace.join(' -> ')}`))
        .catch((error) => this.log(`Workflow ${id} failed: ${error.message}`, 'warn'));
      return { ok: true, message: `Workflow ${id} started.` };
    }
    return { ok: false, message: `Unknown command: ${normalized}` };
  }

  async runWorkflow(workflowId, input = {}) {
    return this.workflowEngine.run(this, workflowId, input);
  }

  sendChat(message) {
    this.bot.chat(message);
    return { ok: true, message };
  }

  respond(message) {
    this.bot.chat(message);
    return { ok: true, message };
  }

  statusMessage() {
    const status = this.publicStatus();
    const inventory = status.inventory.length ? status.inventory.map((item) => `${item.name} x${item.count}`).join(', ') : 'Empty';
    const nearby = status.nearbyPlayers.length ? ` | Nearby: ${status.nearbyPlayers.join(', ')}` : '';
    return `[${status.username || this.displayName}] HP:${status.health ?? '-'} Food:${status.food ?? '-'} Kill:${this.killAuraEnabled ? 'ON' : 'OFF'} | Inv: ${inventory}${nearby}`;
  }

  startFishing(announce = true) {
    if (this.fishing) return announce ? this.respond("I'm already fishing!") : { ok: true, message: 'Fishing already running.' };
    const bot = this.bot;
    const rod = this.inventoryItems().find((item) => this.itemName(item).includes('fishing_rod'));
    if (!rod) {
      const result = `[${bot.username}] No fishing rod in inventory.`;
      if (announce) return this.respond(result);
      this.log(result, 'warn');
      return { ok: false, message: result };
    }
    const boat = bot.nearestEntity((entity) => entity.name?.toLowerCase().includes('boat') && entity.position.distanceTo(bot.entity.position) < 5);
    this.fishing = true;
    Promise.resolve()
      .then(async () => {
        if (boat && bot.vehicle !== boat) await bot.mount(boat);
        await bot.equip(rod, 'hand');
        if (announce) this.respond('Started fishing...');
        this.fishingLoop();
      })
      .catch((error) => {
        this.fishing = false;
        if (announce) this.respond(`Fishing setup error: ${error.message}`);
        else this.log(`Fishing setup error: ${error.message}`, 'warn');
      });
    return { ok: true, message: 'Fishing started.' };
  }

  async fishingLoop() {
    if (!this.fishing || !this.bot) return;
    try {
      await this.bot.fish();
      if (this.fishing) this.fishingTimer = setTimeout(() => this.fishingLoop(), 500);
    } catch (error) {
      this.log(`Fishing loop: ${error.message}`, 'warn');
      if (this.fishing) this.fishingTimer = setTimeout(() => this.fishingLoop(), 2000);
    }
  }


  resolveMiningTarget(name) {
    const aliases = {
      ores: ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore'],
      stone: ['stone', 'deepslate'],
      logs: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
      wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
      coal: ['coal_ore', 'deepslate_coal_ore'],
      iron: ['iron_ore', 'deepslate_iron_ore'],
      copper: ['copper_ore', 'deepslate_copper_ore'],
      diamond: ['diamond_ore', 'deepslate_diamond_ore']
    };
    const names = aliases[String(name || 'ores').toLowerCase()] || [String(name || 'ores').toLowerCase()];
    const data = minecraftData(this.bot.version);
    const ids = names.map((blockName) => data.blocksByName[blockName]?.id).filter(Boolean);
    return { names, ids };
  }

  miningPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  rememberMiningFailure(position, reason) {
    const key = this.miningPositionKey(position);
    if (!key) return;
    const previous = this.miningFailedBlocks.get(key);
    this.miningFailedBlocks.set(key, { at: Date.now(), reason: String(reason || 'not currently diggable') });
    if (!previous || Date.now() - previous.at > 15000) {
      this.log(`Mining skipped ${key}: ${reason}. Trying another matching block.`, 'warn');
    }
  }

  isMiningBlockSkipped(position) {
    const key = this.miningPositionKey(position);
    if (!key) return false;
    const failure = this.miningFailedBlocks.get(key);
    if (!failure) return false;
    if (Date.now() - failure.at > 20000) {
      this.miningFailedBlocks.delete(key);
      return false;
    }
    return true;
  }

  findMiningCandidate() {
    const bot = this.bot;
    const positions = bot.findBlocks({ matching: this.miningTarget.ids, maxDistance: 32, count: 32 });
    const candidates = positions
      .map((position) => bot.blockAt(position))
      .filter((block) => block && !this.isMiningBlockSkipped(block.position))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    return { candidates, foundMatching: positions.length > 0 };
  }

  startMining(args = []) {
    if (this.regionMining) return this.respond(`[${this.bot.username}] Region mining is active; stop it before starting targeted mining.`);
    if (this.mining) return this.respond(`[${this.bot.username}] Mining is already running.`);
    const target = this.resolveMiningTarget(args[0] || 'ores');
    if (!target.ids.length) return this.respond(`[${this.bot.username}] Unknown block target: ${args[0] || 'ores'}.`);
    const requested = Number.parseInt(args[1] || '0', 10);
    this.miningTarget = { names: target.names, ids: target.ids, remaining: Number.isFinite(requested) && requested > 0 ? Math.min(requested, 128) : null, mined: 0 };
    this.miningFailedBlocks.clear();
    this.mining = true;
    this.log(`Mining started: ${target.names.join(', ')}${this.miningTarget.remaining ? ` ×${this.miningTarget.remaining}` : ' until stopped'}.`);
    this.respond(`[${this.bot.username}] Mining ${target.names[0]}${this.miningTarget.remaining ? ` ×${this.miningTarget.remaining}` : ''}.`);
    this.miningLoop();
    return { ok: true, message: 'Mining started.' };
  }

  async miningLoop() {
    if (!this.mining || !this.bot?.entity || !this.miningTarget) return;
    const bot = this.bot;
    let attemptedBlock = null;
    try {
      if (this.miningTarget.remaining !== null && this.miningTarget.mined >= this.miningTarget.remaining) {
        this.mining = false;
        this.log(`Mining finished: ${this.miningTarget.mined} block(s).`);
        this.respond(`[${bot.username}] Mining finished: ${this.miningTarget.mined} block(s).`);
        return;
      }
      const selection = this.findMiningCandidate();
      if (!selection.foundMatching) {
        this.mining = false;
        this.log('Mining paused: no matching blocks within 32 blocks.', 'warn');
        this.respond(`[${bot.username}] No matching blocks nearby; mining paused.`);
        return;
      }
      if (!selection.candidates.length) {
        if (this.mining) this.miningTimer = setTimeout(() => this.miningLoop(), 300);
        return;
      }
      attemptedBlock = selection.candidates[0];
      await this.moveToBlock(attemptedBlock, 'mining');
      const current = bot.blockAt(attemptedBlock.position);
      if (!current || !bot.canDigBlock(current)) {
        this.rememberMiningFailure(attemptedBlock.position, 'target is not diggable from the current position');
        if (this.mining) this.miningTimer = setTimeout(() => this.miningLoop(), 250);
        return;
      }
      const toolReady = await this.prepareHarvestTool(current, 'Targeted mining');
      if (!toolReady) {
        this.mining = false;
        return;
      }
      this.digging = true;
      await bot.lookAt(current.position.offset(0.5, 0.5, 0.5));
      await bot.dig(current, true, 'raycast');
      this.digging = false;
      this.miningFailedBlocks.delete(this.miningPositionKey(current.position));
      if (!this.mining || !this.miningTarget) return;
      this.miningTarget.mined += 1;
      this.miningTimer = setTimeout(() => this.miningLoop(), 250);
    } catch (error) {
      this.digging = false;
      if (attemptedBlock) {
        this.rememberMiningFailure(attemptedBlock.position, error.message);
        if (this.mining) this.miningTimer = setTimeout(() => this.miningLoop(), 250);
      } else {
        this.log(`Mining cycle failed: ${error.message}`, 'warn');
        if (this.mining) this.miningTimer = setTimeout(() => this.miningLoop(), 1800);
      }
    }
  }

  expandRegionBlockNames(values = []) {
    const data = minecraftData(this.bot.version);
    const names = [];
    for (const value of values) {
      const key = cleanBlockName(value);
      const expanded = REGION_ALIASES[key] || [key];
      for (const name of expanded) {
        if (data.blocksByName[name] || isRegionProtectedName(name) || REGION_FLUIDS.has(name)) {
          names.push(name);
        }
      }
    }
    return [...new Set(names)];
  }

  defaultRegionDeny() {
    return [...new Set([...REGION_PROTECTED_NAMES, ...REGION_FLUIDS, ...REGION_CONTAINER_NAMES, 'shulker_box'])];
  }

  hydrateRegionPlan(input) {
    if (!input?.bounds) return null;
    const bounds = input.bounds;
    const anchor = normalizePosition(input.anchor);
    const values = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].map(Number);
    if (values.some((value) => !Number.isInteger(value))) return null;
    const [minX, minY, minZ, maxX, maxY, maxZ] = values;
    const normalizedBounds = {
      minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX),
      minY: Math.min(minY, maxY), maxY: Math.max(minY, maxY),
      minZ: Math.min(minZ, maxZ), maxZ: Math.max(minZ, maxZ)
    };
    const volume = (normalizedBounds.maxX - normalizedBounds.minX + 1) * (normalizedBounds.maxY - normalizedBounds.minY + 1) * (normalizedBounds.maxZ - normalizedBounds.minZ + 1);
    if (volume > MAX_REGION_VOLUME) return null;
    const mode = input.mode === 'whitelist' ? 'whitelist' : 'blacklist';
    const allow = Array.isArray(input.allow) ? [...new Set(input.allow.map(cleanBlockName).filter(Boolean))] : [];
    const customDeny = Array.isArray(input.deny) ? input.deny.map(cleanBlockName).filter(Boolean) : [];
    const layerTop = Number.isInteger(Number(input.layerTop)) ? Math.max(normalizedBounds.minY, Math.min(normalizedBounds.maxY, Number(input.layerTop))) : normalizedBounds.maxY;
    const layerArea = (normalizedBounds.maxX - normalizedBounds.minX + 1) * (normalizedBounds.maxZ - normalizedBounds.minZ + 1);
    const layerCursor = Number.isInteger(Number(input.layerCursor)) ? Math.max(0, Math.min(layerArea * 2, Number(input.layerCursor))) : 0;
    return {
      bounds: normalizedBounds,
      dimension: cleanDimension(input.dimension),
      home: cleanHomeName(input.home) || this.miningHomeName(),
      anchor,
      volume,
      mode,
      allow,
      customDeny: [...new Set(customDeny)],
      deny: [...new Set([...this.defaultRegionDeny(), ...customDeny])],
      cursor: 0,
      scanned: 0,
      mined: 0,
      layerTop,
      layerCursor,
      active: false,
      pausedReason: null,
      phase: 'idle',
      lastBlock: null,
      pending: null,
      retryCount: 0
    };
  }

  serializedRegionPlan() {
    if (!this.regionPlan) return null;
    return {
      bounds: { ...this.regionPlan.bounds },
      dimension: this.regionPlan.dimension,
      home: this.regionPlan.home,
      anchor: this.regionPlan.anchor ? { ...this.regionPlan.anchor } : null,
      mode: this.regionPlan.mode,
      allow: [...this.regionPlan.allow],
      deny: [...(this.regionPlan.customDeny || [])],
      layerTop: this.regionPlan.layerTop,
      layerCursor: this.regionPlan.layerCursor
    };
  }

  configureRegion(input = {}) {
    if (this.regionMining) return { ok: false, message: 'Stop region mining before changing its configuration.' };
    const bounds = input.bounds || {};
    const parsed = this.regionBoundsFromArgs([
      bounds.minX ?? input.x1, bounds.minY ?? input.y1, bounds.minZ ?? input.z1,
      bounds.maxX ?? input.x2, bounds.maxY ?? input.y2, bounds.maxZ ?? input.z2
    ]);
    if (!parsed || parsed.error) return { ok: false, message: parsed?.error || 'Six integer coordinates are required.' };
    const mode = String(input.mode || 'blacklist').toLowerCase();
    if (!['blacklist', 'whitelist'].includes(mode)) return { ok: false, message: 'Mode must be blacklist or whitelist.' };
    const allow = Array.isArray(input.allow) ? [...new Set(input.allow.map(cleanBlockName).filter(Boolean))] : [];
    const deny = Array.isArray(input.deny) ? [...new Set(input.deny.map(cleanBlockName).filter(Boolean))] : [];
    if (mode === 'whitelist' && !allow.length) return { ok: false, message: 'Whitelist mode needs at least one allowed block.' };
    const currentDimension = this.bot?.entity ? this.currentDimension() : null;
    this.regionBlockedBlocks.clear();
    this.regionPlan = {
      bounds: parsed.bounds,
      dimension: cleanDimension(input.dimension) || currentDimension || this.regionPlan?.dimension || null,
      home: cleanHomeName(input.home) || this.regionPlan?.home || this.miningHomeName(),
      anchor: null,
      volume: parsed.volume,
      mode,
      allow,
      customDeny: deny,
      deny: [...new Set([...this.defaultRegionDeny(), ...deny])],
      cursor: 0,
      scanned: 0,
      mined: 0,
      layerTop: parsed.bounds.maxY,
      layerCursor: 0,
      active: false,
      pausedReason: null,
      phase: 'idle',
      lastBlock: null,
      pending: null,
      retryCount: 0
    };
    this.log(`Region mining configuration saved (${mode}, ${parsed.volume} blocks).`);
    return { ok: true, message: `Mining region saved: ${parsed.volume} blocks in ${mode} mode.` };
  }

  regionBoundsFromArgs(args) {
    const numbers = args.slice(0, 6).map((value) => Number(value));
    if (numbers.length !== 6 || numbers.some((value) => !Number.isInteger(value))) return null;
    const [x1, y1, z1, x2, y2, z2] = numbers;
    const bounds = {
      minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
      minY: Math.min(y1, y2), maxY: Math.max(y1, y2),
      minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2)
    };
    const volume = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);
    if (volume > MAX_REGION_VOLUME) return { error: `Region is too large (${volume} blocks). Maximum is ${MAX_REGION_VOLUME}.` };
    return { bounds, volume };
  }

  executeRegionCommand(args = []) {
    const action = String(args[0] || 'status').toLowerCase();
    if (action === 'set') {
      const parsed = this.regionBoundsFromArgs(args.slice(1));
      if (!parsed || parsed.error) return this.respond(parsed?.error || 'Usage: area set <x1> <y1> <z1> <x2> <y2> <z2>');
      this.regionBlockedBlocks.clear();
      this.regionPlan = {
        bounds: parsed.bounds,
        volume: parsed.volume,
        mode: this.regionPlan?.mode || 'blacklist',
        allow: this.regionPlan?.allow || [],
        customDeny: this.regionPlan?.customDeny || [],
        deny: this.regionPlan?.deny || this.defaultRegionDeny(),
        cursor: 0,
        scanned: 0,
        mined: 0,
        layerTop: parsed.bounds.maxY,
        layerCursor: 0,
        active: false,
        pausedReason: null,
        lastBlock: null,
        pending: null,
        retryCount: 0,
      };
      return this.respond(`[${this.bot.username}] Region set: ${this.regionPlan.bounds.minX},${this.regionPlan.bounds.minY},${this.regionPlan.bounds.minZ} -> ${this.regionPlan.bounds.maxX},${this.regionPlan.bounds.maxY},${this.regionPlan.bounds.maxZ} (${parsed.volume} blocks).`);
    }
    if (!this.regionPlan) return this.respond(`[${this.bot.username}] Set a region first: area set <x1> <y1> <z1> <x2> <y2> <z2>`);
    if (action === 'mode') {
      const mode = String(args[1] || '').toLowerCase();
      if (!['blacklist', 'whitelist'].includes(mode)) return this.respond(`[${this.bot.username}] Usage: area mode blacklist|whitelist`);
      this.regionPlan.mode = mode;
      return this.respond(`[${this.bot.username}] Region mode: ${mode}.`);
    }
    if (action === 'allow' || action === 'whitelist') {
      const names = this.expandRegionBlockNames(args.slice(1));
      if (!names.length) return this.respond(`[${this.bot.username}] Usage: area allow <block...>`);
      this.regionPlan.allow = [...new Set([...this.regionPlan.allow, ...names])];
      return this.respond(`[${this.bot.username}] Region allow list updated: ${this.regionPlan.allow.join(', ')}.`);
    }
    if (action === 'deny' || action === 'blacklist') {
      const names = this.expandRegionBlockNames(args.slice(1));
      if (!names.length) return this.respond(`[${this.bot.username}] Usage: area deny <block...>`);
      this.regionPlan.customDeny = [...new Set([...(this.regionPlan.customDeny || []), ...names])];
      this.regionPlan.deny = [...new Set([...this.defaultRegionDeny(), ...this.regionPlan.customDeny])];
      return this.respond(`[${this.bot.username}] Region deny list updated: ${this.regionPlan.customDeny.join(', ')}.`);
    }
    if (action === 'reset') {
      this.regionPlan.mode = 'blacklist';
      this.regionPlan.allow = [];
      this.regionPlan.customDeny = [];
      this.regionPlan.deny = this.defaultRegionDeny();
      return this.respond(`[${this.bot.username}] Region filters reset to the safe blacklist.`);
    }
    if (action === 'start' || action === 'on') return this.startRegionMining();
    if (action === 'stop' || action === 'off') return this.stopRegionMining();
    if (action === 'status') return this.respond(this.regionStatusMessage());
    return this.respond(`[${this.bot.username}] Usage: area set|mode|allow|deny|start|stop|status ...`);
  }

  regionStatusMessage() {
    if (!this.regionPlan) return `[${this.bot.username}] No mining region configured.`;
    const { bounds, mode, volume, cursor, scanned, mined, active, pausedReason, phase, home, dimension } = this.regionPlan;
    const layer = this.regionLayerBounds();
    const progress = volume ? `${Math.min(100, Math.round((cursor / volume) * 100))}%` : '0%';
    const anchor = this.regionPlan.anchor ? `; Home=${home} @ ${this.regionPlan.anchor.x},${this.regionPlan.anchor.y},${this.regionPlan.anchor.z}` : `; Home=${home} (not initialized)`;
    const layerText = layer ? `; layer=${layer.top}-${layer.bottom} (2-high, top-down)` : '';
    return `[${this.bot.username}] Region ${active ? 'RUNNING' : 'PAUSED'} [${phase || 'idle'}] ${progress}; ${mined} mined, ${scanned}/${volume} scanned; mode=${mode}; dimension=${dimension || 'unknown'}${layerText}${anchor}${pausedReason ? `; ${pausedReason}` : ''}. Bounds ${bounds.minX},${bounds.minY},${bounds.minZ} -> ${bounds.maxX},${bounds.maxY},${bounds.maxZ}.`;
  }

  miningHomeName() {
    const id = String(this.id || 'bot').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 16) || 'bot';
    return `_mcbot_${id}_mine`;
  }

  persistRegionPlan() {
    if (!this.regionPlan) return;
    try {
      const miningRegion = this.serializedRegionPlan();
      const next = this.config.bots.map((bot) => bot.id === this.id ? { ...bot, miningRegion } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      this.definition = next.find((bot) => bot.id === this.id) || this.definition;
    } catch (error) {
      this.log(`Could not persist mining Home: ${error.message}`, 'warn');
    }
  }

  distanceToRegion(position) {
    if (!position || !this.regionPlan?.bounds) return Number.POSITIVE_INFINITY;
    const bounds = this.regionPlan.bounds;
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, position.x));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, position.y));
    const z = Math.max(bounds.minZ, Math.min(bounds.maxZ, position.z));
    return position.distanceTo(new Vec3(x, y, z));
  }

  regionApproachPosition() {
    const position = this.bot.entity.position;
    const bounds = this.regionPlan.bounds;
    return new Vec3(
      Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(position.x))),
      Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(position.y))),
      Math.max(bounds.minZ, Math.min(bounds.maxZ, Math.floor(position.z)))
    );
  }

  pauseRegionMining(reason, announce = true) {
    this.regionMining = false;
    if (this.regionPlan) {
      this.regionPlan.active = false;
      this.regionPlan.phase = 'paused';
      this.regionPlan.pausedReason = reason;
    }
    if (this.regionTimer) clearTimeout(this.regionTimer);
    this.regionTimer = null;
    this.log(`Region mining paused: ${reason}`, 'warn');
    if (announce && this.bot) this.respond(`[${this.bot.username}] Region mining paused: ${reason}.`);
    return { ok: false, message: reason };
  }

  async ensureRegionAnchor() {
    const plan = this.regionPlan;
    const currentDimension = this.currentDimension();
    if (!plan.dimension) {
      plan.dimension = currentDimension;
      this.persistRegionPlan();
    }
    if (plan.dimension !== currentDimension) {
      if (!plan.home || !plan.anchor) {
        throw new Error(`mining region is in ${plan.dimension}, but its mining Home has not been initialized in that dimension`);
      }
      plan.phase = 'teleporting';
      this.homeActivity = { home: plan.home, type: 'mining', state: 'traveling', message: `前往挖矿 Home（${plan.dimension}）` };
      const moved = await this.issueServerCommand(`/home ${plan.home}`, true);
      const arrived = this.currentDimension() === plan.dimension
        && this.bot.entity.position.distanceTo(new Vec3(plan.anchor.x, plan.anchor.y, plan.anchor.z)) <= 8;
      if (!moved && !arrived) throw new Error(`home ${plan.home} did not teleport the bot to the mining dimension`);
      if (!arrived) throw new Error(`home ${plan.home} landed outside the recorded mining anchor`);
      this.homeActivity = { home: plan.home, type: 'mining', state: 'ready', message: '已返回挖矿锚点' };
      return;
    }

    plan.phase = 'navigating';
    if (this.distanceToRegion(this.bot.entity.position) > 3.5) {
      await this.moveNearPosition(this.regionApproachPosition(), 2, 'mining');
    }
    if (this.distanceToRegion(this.bot.entity.position) > 6) {
      throw new Error('pathfinder stopped too far away from the configured mining region');
    }

    plan.home = plan.home || this.miningHomeName();
    if (plan.anchor && plan.dimension === currentDimension) {
      this.homeActivity = { home: plan.home, type: 'mining', state: 'ready', message: '已到达挖矿范围，使用已保存锚点' };
      return;
    }
    plan.anchor = normalizePosition(this.bot.entity.position);
    plan.dimension = currentDimension;
    plan.phase = 'anchoring';
    this.homeActivity = { home: plan.home, type: 'mining', state: 'saving', message: '正在建立初始挖矿传送点' };
    await this.issueServerCommand(`/sethome ${plan.home}`);
    this.persistRegionPlan();
    this.homeActivity = { home: plan.home, type: 'mining', state: 'ready', message: '初始挖矿传送点已记录' };
    this.log(`Mining Home ${plan.home} anchored at ${plan.anchor.x},${plan.anchor.y},${plan.anchor.z} in ${plan.dimension}.`);
  }

  async ensureMiningPickaxe() {
    if (this.hasUsablePickaxe()) return true;
    if (!this.effectiveSkillConfig().supply.enabled) {
      throw new Error('no usable pickaxe is available and the supply skill is disabled');
    }
    this.regionPlan.phase = 'resupplying';
    const result = await this.maybeResupply({ requirePickaxe: true, requireFood: false, requireStorage: false });
    if (!result.ok || !this.hasUsablePickaxe()) throw new Error(`pickaxe resupply failed: ${result.message}`);
    return true;
  }

  async prepareRegionMining() {
    try {
      await this.ensureRegionAnchor();
      if (!this.regionMining) return;
      await this.ensureMiningPickaxe();
      if (!this.regionMining) return;
      this.regionPlan.phase = 'mining';
      this.regionPlan.pausedReason = null;
      this.regionMiningLoop();
    } catch (error) {
      this.pauseRegionMining(error.message);
    }
  }

  startRegionMining(announce = true) {
    if (this.mining) return announce ? this.respond(`[${this.bot.username}] Targeted mining is active; stop it before starting region mining.`) : { ok: false, message: 'Targeted mining is active.' };
    if (this.regionMining) return announce ? this.respond(`[${this.bot.username}] Region mining is already running.`) : { ok: true, message: 'Region mining already running.' };
    if (!this.regionPlan) return announce ? this.respond(`[${this.bot.username}] Set a region first with area set.`) : { ok: false, message: 'No mining region configured.' };
    if (this.regionPlan.mode === 'whitelist' && !this.regionPlan.allow.length) return announce ? this.respond(`[${this.bot.username}] Whitelist mode has no allowed blocks; refusing to start.`) : { ok: false, message: 'Whitelist has no allowed blocks.' };
    this.regionMining = true;
    this.regionPlan.active = true;
    this.regionPlan.phase = 'preparing';
    this.regionPlan.pausedReason = null;
    this.regionPlan.retryCount = 0;
    this.log(`Region mining preparation started (${this.regionPlan.mode}, ${this.regionPlan.volume} blocks).`);
    if (announce) this.respond(`[${this.bot.username}] Preparing region mining: travel to the region, save a mining Home, then verify a pickaxe.`);
    this.prepareRegionMining();
    return { ok: true, message: 'Region mining preparation started.' };
  }

  stopRegionMining() {
    this.regionMining = false;
    if (this.regionPlan) {
      this.regionPlan.active = false;
      this.regionPlan.phase = 'paused';
      this.regionPlan.pausedReason = 'stopped by operator';
    }
    if (this.regionTimer) clearTimeout(this.regionTimer);
    this.regionTimer = null;
    this.bot?.pathfinder?.setGoal(null);
    return this.respond(`[${this.bot.username}] Region mining stopped.`);
  }

  regionLayerBounds() {
    const bounds = this.regionPlan?.bounds;
    if (!bounds) return null;
    const top = Number.isInteger(this.regionPlan.layerTop)
      ? Math.max(bounds.minY, Math.min(bounds.maxY, this.regionPlan.layerTop))
      : bounds.maxY;
    return { top, bottom: Math.max(bounds.minY, top - 1) };
  }

  regionLayerVolume() {
    const layer = this.regionLayerBounds();
    if (!layer) return 0;
    const bounds = this.regionPlan.bounds;
    const width = bounds.maxX - bounds.minX + 1;
    const depth = bounds.maxZ - bounds.minZ + 1;
    return width * depth * (layer.top - layer.bottom + 1);
  }

  regionProgressCursor() {
    const layer = this.regionLayerBounds();
    if (!layer) return 0;
    const bounds = this.regionPlan.bounds;
    const area = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
    const completedLayers = bounds.maxY - layer.top;
    return Math.min(this.regionPlan.volume, completedLayers * area + Math.min(area, this.regionPlan.layerCursor || 0));
  }

  advanceRegionLayer() {
    const layer = this.regionLayerBounds();
    if (!layer || layer.top <= this.regionPlan.bounds.minY) return false;
    this.regionPlan.layerTop = layer.top - 1;
    this.regionPlan.layerCursor = 0;
    this.regionPlan.cursor = this.regionProgressCursor();
    this.regionPlan.pending = null;
    this.regionPlan.retryCount = 0;
    this.regionPlan.phase = 'descending';
    this.log(`Region layer complete at Y ${layer.top}-${layer.bottom}; descending to Y ${this.regionPlan.layerTop}-${Math.max(this.regionPlan.bounds.minY, this.regionPlan.layerTop - 1)}.`);
    return true;
  }

  regionPositionAt(index) {
    const bounds = this.regionPlan.bounds;
    const layer = this.regionLayerBounds();
    const width = bounds.maxX - bounds.minX + 1;
    const depth = bounds.maxZ - bounds.minZ + 1;
    const area = width * depth;
    const layerHeight = layer.top - layer.bottom + 1;
    if (index < 0 || index >= area * layerHeight) return null;
    const layerOffset = Math.floor(index / area);
    const xzIndex = index % area;
    const x = bounds.minX + (xzIndex % width);
    const z = bounds.minZ + Math.floor(xzIndex / width);
    const y = layer.top - layerOffset;
    return new Vec3(x, y, z);
  }

  isInsideRegion(position) {
    const bounds = this.regionPlan?.bounds;
    return Boolean(bounds && position.x >= bounds.minX && position.x <= bounds.maxX && position.y >= bounds.minY && position.y <= bounds.maxY && position.z >= bounds.minZ && position.z <= bounds.maxZ);
  }

  isInActiveRegionLayer(position) {
    const layer = this.regionLayerBounds();
    return Boolean(layer && position && position.y >= layer.bottom && position.y <= layer.top);
  }

  regionBlockKey(position) {
    return this.miningPositionKey(position);
  }

  rememberRegionBlockFailure(position, reason) {
    const key = this.regionBlockKey(position);
    if (!key) return;
    const previous = this.regionBlockedBlocks.get(key);
    this.regionBlockedBlocks.set(key, { at: Date.now(), reason: String(reason || 'not currently diggable') });
    if (!previous || Date.now() - previous.at > 15000) {
      this.log(`Region mining skipped ${key}: ${reason}. Searching the next block.`, 'warn');
    }
  }

  isRegionBlockBlocked(position) {
    const key = this.regionBlockKey(position);
    if (!key) return false;
    const failure = this.regionBlockedBlocks.get(key);
    if (!failure) return false;
    if (Date.now() - failure.at > 20000) {
      this.regionBlockedBlocks.delete(key);
      return false;
    }
    return true;
  }

  isRegionTarget(block) {
    if (!block || !this.isInsideRegion(block.position) || !this.isInActiveRegionLayer(block.position)) return false;
    const name = cleanBlockName(block.name);
    if (!name || REGION_FLUIDS.has(name) || isRegionProtectedName(name)) return false;
    if (this.regionPlan.mode === 'whitelist') return this.regionPlan.allow.includes(name);
    return !this.regionPlan.deny.includes(name);
  }

  isRegionCandidate(block) {
    if (!this.isRegionTarget(block) || this.isRegionBlockBlocked(block.position)) return false;
    const directions = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    return directions.some((direction) => {
      const neighbor = this.bot.blockAt(block.position.plus(direction));
      const name = cleanBlockName(neighbor?.name);
      return Boolean(neighbor && (['air', 'cave_air', 'void_air'].includes(name) || neighbor.boundingBox === 'empty'));
    });
  }

  findRegionCandidate() {
    const bot = this.bot;
    const pendingPosition = this.regionPlan.pending ? new Vec3(this.regionPlan.pending.x, this.regionPlan.pending.y, this.regionPlan.pending.z) : null;
    if (pendingPosition) {
      const pendingBlock = bot.blockAt(pendingPosition);
      if (this.isRegionCandidate(pendingBlock)) return pendingBlock;
      this.regionPlan.pending = null;
      this.regionPlan.retryCount = 0;
    }
    const positions = bot.findBlocks({
      matching: (block) => this.isRegionCandidate(block),
      maxDistance: 48,
      count: 64
    });
    return positions.map((position) => bot.blockAt(position)).filter((block) => this.isRegionCandidate(block)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
  }

  scanRegionCursor() {
    if (this.regionPlan.pending) {
      const pendingPosition = new Vec3(this.regionPlan.pending.x, this.regionPlan.pending.y, this.regionPlan.pending.z);
      const pendingBlock = this.bot.blockAt(pendingPosition);
      if (!pendingBlock) return { unloaded: pendingPosition };
      if (this.isRegionCandidate(pendingBlock)) return { block: pendingBlock };
      this.regionPlan.pending = null;
      this.regionPlan.retryCount = 0;
    }
    while (true) {
      const layerVolume = this.regionLayerVolume();
      while (this.regionPlan.layerCursor < layerVolume) {
        const position = this.regionPositionAt(this.regionPlan.layerCursor);
        const block = this.bot.blockAt(position);
        if (!block) return { unloaded: position };
        this.regionPlan.layerCursor += 1;
        this.regionPlan.cursor = this.regionProgressCursor();
        this.regionPlan.scanned += 1;
        if (this.isRegionCandidate(block)) {
          this.regionPlan.pending = { x: position.x, y: position.y, z: position.z };
          this.regionPlan.retryCount = 0;
          return { block };
        }
      }
      if (!this.advanceRegionLayer()) return { complete: true };
    }
  }

  async moveNearPosition(position, radius = 2, taskName = 'pathfinder') {
    const release = await this.taskScheduler.acquire(taskName);
    try {
      const movements = new Movements(this.bot, minecraftData(this.bot.version));
      movements.canDig = false;
      this.bot.pathfinder.setMovements(movements);
      await this.gotoPathfinderGoal(new goals.GoalNear(position.x, position.y, position.z, radius), 12000);
    } finally {
      release();
    }
  }

  async gotoPathfinderGoal(goal, timeoutMs = 12000) {
    const navigation = Promise.resolve(this.bot.pathfinder.goto(goal));
    navigation.catch(() => {});
    let timer = null;
    try {
      return await Promise.race([
        navigation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('pathfinder timed out while approaching the block')), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.bot.pathfinder.setGoal(null);
    }
  }

  blockApproachPositions(block) {
    const directions = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    return directions.map((direction) => block.position.plus(direction)).filter((position) => {
      const neighbor = this.bot.blockAt(position);
      const name = cleanBlockName(neighbor?.name);
      return neighbor && (['air', 'cave_air', 'void_air'].includes(name) || neighbor.boundingBox === 'empty');
    }).sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position));
  }

  async moveToBlock(block, taskName = 'pathfinder') {
    const release = await this.taskScheduler.acquire(taskName);
    try {
      const movements = new Movements(this.bot, minecraftData(this.bot.version));
      movements.canDig = false;
      this.bot.pathfinder.setMovements(movements);
      const approaches = this.blockApproachPositions(block);
      let lastError = null;
      for (const position of approaches.slice(0, 4)) {
        try {
          await this.gotoPathfinderGoal(new goals.GoalNear(position.x, position.y, position.z, 1), 10000);
          await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
          return;
        } catch (error) {
          lastError = error;
        }
      }
      try {
        await this.gotoPathfinderGoal(new goals.GoalLookAtBlock(block.position, this.bot.world, { reach: 4.5 }), 10000);
        await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        return;
      } catch (error) {
        lastError = error;
      }
      throw lastError || new Error(`no exposed approach position for ${block.name} at ${block.position}`);
    } finally {
      release();
    }
  }

  getPlugItem() {
    return this.inventoryItems().find((item) => PLUG_BLOCK_NAMES.includes(this.itemName(item)));
  }

  async sealFluidsAround(block) {
    const directions = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    const plug = this.getPlugItem();
    for (const direction of directions) {
      const fluidPosition = block.position.plus(direction);
      const fluid = this.bot.blockAt(fluidPosition);
      if (!fluid || !REGION_FLUIDS.has(cleanBlockName(fluid.name))) continue;
      if (this.regionSeals.some((seal) => seal.position.equals(fluidPosition))) continue;
      if (!plug) {
        this.regionPlan.pausedReason = `fluid at ${fluidPosition}; no plug blocks available`;
        return false;
      }
      let placed = false;
      for (const supportDirection of directions) {
        const support = this.bot.blockAt(fluidPosition.minus(supportDirection));
        if (!support || REGION_FLUIDS.has(cleanBlockName(support.name)) || ['air', 'cave_air', 'void_air'].includes(cleanBlockName(support.name))) continue;
        try {
          await this.bot.equip(plug, 'hand');
          await this.bot.placeBlock(support, supportDirection);
          this.regionSeals.push({ position: fluidPosition.clone(), blockName: plug.name, fluidName: fluid.name });
          placed = true;
          break;
        } catch (error) {
          this.log(`Could not seal ${fluid.name} at ${fluidPosition}: ${error.message}`, 'warn');
        }
      }
      if (!placed) {
        this.regionPlan.pausedReason = `could not safely seal fluid at ${fluidPosition}`;
        return false;
      }
    }
    return true;
  }

  async regionMiningLoop() {
    if (!this.regionMining || !this.bot?.entity || !this.regionPlan) return;
    let block = null;
    try {
      block = this.findRegionCandidate();
      if (!block) {
        const scan = this.scanRegionCursor();
        if (scan.complete) {
          this.regionMining = false;
          this.regionPlan.active = false;
          this.regionPlan.phase = 'complete';
          this.regionPlan.pausedReason = null;
          this.log(`Region mining finished: ${this.regionPlan.mined} blocks mined.`);
          this.respond(`[${this.bot.username}] Region mining finished: ${this.regionPlan.mined} blocks mined. Sealed fluids remain plugged for safety; use unseal only when ready.`);
          return;
        }
        if (scan.unloaded) {
          this.regionPlan.phase = 'loading';
          await this.moveNearPosition(scan.unloaded, 2, 'mining');
          this.regionPlan.phase = 'mining';
          if (this.regionMining) this.regionTimer = setTimeout(() => this.regionMiningLoop(), 250);
          return;
        }
        block = scan.block;
      }
      if (!block || !this.regionMining) return;
      await this.moveToBlock(block, 'mining');
      if (!this.regionMining) return;
      const current = this.bot.blockAt(block.position);
      if (this.bot.inventory.emptySlotCount() === 0) {
        if (this.effectiveSkillConfig().supply.enabled) {
          this.regionPlan.phase = 'resupplying';
          await this.maybeResupply({ requireStorage: true, requirePickaxe: false, requireFood: false });
          if (!this.regionMining) return;
          this.regionPlan.phase = 'mining';
        }
        if (this.bot.inventory.emptySlotCount() === 0) {
          this.pauseRegionMining('inventory is full; configure a storage Home or empty the inventory');
          return;
        }
      }
      if (!this.isRegionTarget(current)) {
        this.regionPlan.pending = null;
        this.regionPlan.retryCount = 0;
        this.regionTimer = setTimeout(() => this.regionMiningLoop(), 100);
        return;
      }
      if (!current || !this.bot.canDigBlock(current)) {
        this.rememberRegionBlockFailure(block.position, `target ${current?.name || 'block'} is not diggable from the current position`);
        this.regionPlan.pending = null;
        this.regionPlan.retryCount = 0;
        if (this.regionMining) this.regionTimer = setTimeout(() => this.regionMiningLoop(), 200);
        return;
      }
      if (!(await this.sealFluidsAround(current))) {
        this.pauseRegionMining(this.regionPlan.pausedReason || 'could not safely seal nearby fluid');
        return;
      }
      const toolReady = await this.prepareHarvestTool(current, 'Region mining');
      if (!toolReady) {
        this.pauseRegionMining('no usable harvest tool was found');
        return;
      }
      this.digging = true;
      await this.bot.lookAt(current.position.offset(0.5, 0.5, 0.5));
      await this.bot.dig(current, true, 'raycast');
      this.digging = false;
      this.regionPlan.pending = null;
      this.regionPlan.retryCount = 0;
      this.regionBlockedBlocks.delete(this.regionBlockKey(current.position));
      this.regionPlan.mined += 1;
      this.regionPlan.lastBlock = { name: current.name, position: { x: current.position.x, y: current.position.y, z: current.position.z } };
      if (this.regionMining) this.regionTimer = setTimeout(() => this.regionMiningLoop(), 180);
    } catch (error) {
      this.digging = false;
      if (block) {
        this.rememberRegionBlockFailure(block.position, error.message);
        this.regionPlan.pending = null;
        this.regionPlan.retryCount = 0;
        this.regionPlan.pausedReason = `skipped ${block.name} at ${block.position}: ${error.message}`;
        if (this.regionMining) this.regionTimer = setTimeout(() => this.regionMiningLoop(), 250);
        return;
      }
      this.regionPlan.retryCount = (this.regionPlan.retryCount || 0) + 1;
      this.regionPlan.pausedReason = error.message;
      this.log(`Region mining cycle failed: ${error.message}`, 'warn');
      if (this.regionPlan.retryCount >= 5) {
        this.pauseRegionMining(`repeated mining failure: ${error.message}`);
        return;
      }
      if (this.regionMining) this.regionTimer = setTimeout(() => this.regionMiningLoop(), 2500);
    }
  }

  async unsealFluids() {
    if (this.regionMining) return this.respond(`[${this.bot.username}] Stop region mining before removing fluid seals.`);
    if (!this.regionSeals.length) return this.respond(`[${this.bot.username}] No fluid seals created by this bot.`);
    const seals = [...this.regionSeals];
    let removed = 0;
    for (const seal of seals) {
      const block = this.bot.blockAt(seal.position);
      if (!block || cleanBlockName(block.name) !== cleanBlockName(seal.blockName)) continue;
      try {
        await this.moveToBlock(block, 'mining');
        await this.bot.dig(block, true, 'raycast');
        removed += 1;
      } catch (error) {
        this.log(`Could not remove seal at ${seal.position}: ${error.message}`, 'warn');
      }
    }
    this.regionSeals = this.regionSeals.filter((seal) => this.bot.blockAt(seal.position)?.name === seal.blockName);
    return this.respond(`[${this.bot.username}] Removed ${removed} fluid seal(s). Water/lava may flow again.`);
  }

  lookCommand(args = []) {
    const targetName = args[0] && this.bot.players[args[0]]?.entity ? args[0] : null;
    if (targetName) {
      return this.bot.lookAt(this.bot.players[targetName].entity.position.offset(0, 1, 0)).then(() => ({ ok: true, message: `Looking at ${targetName}.` }));
    }
    const yaw = Number(args[0]);
    const pitch = Number(args[1]);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { ok: false, message: 'Usage: look <yaw degrees> <pitch degrees> or look <player>' };
    return this.bot.look(yaw * Math.PI / 180, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch * Math.PI / 180)), true)
      .then(() => ({ ok: true, message: `Looking at yaw ${yaw}°, pitch ${pitch}°.` }));
  }

  setSleepMode(mode = 'on', announce = true) {
    const normalized = String(mode || 'on').toLowerCase();
    const enabled = !['off', 'stop', 'disable'].includes(normalized);
    this.sleepEnabled = enabled;
    if (enabled) {
      const wasEnabled = this.supply;
      this.supply = true;
      if (this.bot?.autoEat?.enable) this.bot.autoEat.enable();
      if (!wasEnabled) this.supplyLoop();
      this.startMaintenanceLoop();
    } else if (!this.resupplyEnabled && this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    const message = `[${this.bot.username}] Automatic sleep ${enabled ? 'enabled' : 'disabled'} (part of Home supply).`;
    return announce ? this.respond(message) : { ok: true, message };
  }

  persistResupplyPoints() {
    try {
      const next = this.config.bots.map((bot) => bot.id === this.id ? { ...bot, resupplyPoints: this.serializedSupplyPoints() } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      this.definition = next.find((bot) => bot.id === this.id) || this.definition;
    } catch (error) {
      this.log(`Could not persist supply points: ${error.message}`, 'warn');
    }
  }

  executeResupplyCommand(args = []) {
    const action = String(args[0] || 'status').toLowerCase();
    if (action === 'on' || action === 'enable') {
      const wasEnabled = this.supply;
      this.supply = true;
      this.resupplyEnabled = true;
      if (this.bot?.autoEat?.enable) this.bot.autoEat.enable();
      if (!wasEnabled) this.supplyLoop();
      this.startMaintenanceLoop();
      return this.respond(`[${this.bot.username}] Home supply enabled. Only initialized supply points will be used.`);
    }
    if (action === 'off' || action === 'disable') {
      this.resupplyEnabled = false;
      if (!this.sleepEnabled && this.maintenanceTimer) {
        clearTimeout(this.maintenanceTimer);
        this.maintenanceTimer = null;
      }
      return this.respond(`[${this.bot.username}] Home resupply paused; local food/equipment care remains ${this.supply ? 'enabled' : 'disabled'}.`);
    }
    const pointAction = String(args[1] || '').toLowerCase();
    if (action === 'point' && pointAction === 'add') {
      const values = args.slice(2, 5).map(Number);
      if (values.length !== 3 || values.some((value) => !Number.isInteger(value))) return this.respond(`[${this.bot.username}] Usage: resupply point add <x> <y> <z>`);
      const point = normalizeSupplyPoint({ x: values[0], y: values[1], z: values[2], name: `补给点 ${this.resupplyPoints.length + 1}` }, this.resupplyPoints.length);
      if (point) this.resupplyPoints.push(point);
      this.persistResupplyPoints();
      return this.respond(`[${this.bot.username}] Supply point added at ${values.join(', ')}.`);
    }
    if (action === 'point' && pointAction === 'clear') {
      this.resupplyPoints = [];
      this.persistResupplyPoints();
      return this.respond(`[${this.bot.username}] Supply points cleared.`);
    }
    if (action === 'status') return this.respond(`[${this.bot.username}] Home supply ${this.supply ? 'ON' : 'OFF'}; anchored points: ${this.resupplyPoints.filter((point) => this.hasSupplyAnchor(point)).length}.`);
    return this.respond(`[${this.bot.username}] Usage: resupply on|off|status|point add <x> <y> <z>|point clear`);
  }

  startMaintenanceLoop() {
    if (this.maintenanceTimer || this.maintenanceBusy) return;
    this.maintenanceLoop();
  }

  async maintenanceLoop() {
    if (!this.bot || (!this.sleepEnabled && !this.resupplyEnabled)) return;
    this.maintenanceBusy = true;
    try {
      if (this.sleepEnabled) await this.maybeSleep();
      if (this.resupplyEnabled) await this.maybeResupply();
    } catch (error) {
      this.log(`Maintenance check failed: ${error.message}`, 'warn');
    } finally {
      this.maintenanceBusy = false;
      if (this.bot && (this.sleepEnabled || this.resupplyEnabled)) this.maintenanceTimer = setTimeout(() => {
        this.maintenanceTimer = null;
        this.maintenanceLoop();
      }, 15000);
    }
  }

  currentDimension() {
    return String(this.bot?.game?.dimension || '').replace(/^minecraft:/, '');
  }

  supplyPointSupports(point, role) {
    return !role || !Array.isArray(point.roles) || point.roles.length === 0 || point.roles.includes(role);
  }

  matchingSupplyPoints(role = null, options = {}) {
    const dimension = this.currentDimension();
    const requireAnchor = options.requireAnchor === true;
    return this.resupplyPoints.filter((point) => (
      point.enabled !== false
      && this.supplyPointSupports(point, role)
      && (!requireAnchor || this.hasSupplyAnchor(point))
      && (point.home || !point.dimension || point.dimension === dimension)
    ));
  }

  checkpointName() {
    const id = String(this.id || 'bot').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 24) || 'bot';
    return `_mcbot_${id}_checkpoint`;
  }

  hasSupplyAnchor(point) {
    return [point?.x, point?.y, point?.z].every(Number.isFinite);
  }

  isNearSupplyAnchor(point) {
    if (!this.bot?.entity || !this.hasSupplyAnchor(point)) return false;
    if (point.dimension && point.dimension !== this.currentDimension()) return false;
    const radius = Math.max(6, Number(point.scanRadius) || 8) + 3;
    return this.bot.entity.position.distanceTo(new Vec3(point.x, point.y, point.z)) <= radius;
  }

  async waitForTeleport(startPosition, startDimension, timeoutMs = 6500) {
    const deadline = Date.now() + timeoutMs;
    while (this.bot?.entity && Date.now() < deadline) {
      const changedDimension = this.currentDimension() !== startDimension;
      const moved = this.bot.entity.position.distanceTo(startPosition) > 2;
      if (changedDimension || moved) {
        await delay(450);
        return true;
      }
      await delay(200);
    }
    return false;
  }

  async issueServerCommand(command, waitForTeleport = false) {
    if (!this.bot?.entity) return false;
    const startPosition = this.bot.entity.position.clone();
    const startDimension = this.currentDimension();
    this.bot.chat(command.startsWith('/') ? command : `/${command}`);
    if (!waitForTeleport) {
      await delay(300);
      return true;
    }
    return this.waitForTeleport(startPosition, startDimension);
  }

  async withSupplyPoint(point, taskName, action) {
    const release = await this.taskScheduler.acquire(taskName);
    const regionReturn = this.regionMining && this.regionPlan?.home && this.regionPlan?.anchor ? {
      home: this.regionPlan.home,
      anchor: { ...this.regionPlan.anchor },
      dimension: this.regionPlan.dimension
    } : null;
    const shouldCheckpoint = Boolean(!regionReturn && point.home && this.mining);
    const checkpoint = shouldCheckpoint ? this.checkpointName() : null;
    const checkpointAnchor = checkpoint && this.bot?.entity ? {
      position: this.bot.entity.position.clone(),
      dimension: this.currentDimension()
    } : null;
    try {
      if (checkpoint) {
        await this.issueServerCommand(`/sethome ${checkpoint}`);
        this.log(`Temporary mining checkpoint saved as ${checkpoint}.`);
      }
      if (point.home) {
        this.homeActivity = { home: point.home, type: 'supply', state: 'traveling', message: `前往补给点：${point.name}` };
        const moved = await this.issueServerCommand(`/home ${point.home}`, true);
        const arrivedDimension = !point.dimension || this.currentDimension() === point.dimension;
        const hasAnchor = this.hasSupplyAnchor(point);
        const verifiedAnchor = hasAnchor && this.isNearSupplyAnchor(point);
        if (!arrivedDimension) {
          throw new Error(`home ${point.home} did not teleport the bot to the expected dimension`);
        }
        if (hasAnchor && !verifiedAnchor) {
          throw new Error(`home ${point.home} landed outside the configured anchor; refusing to operate at an unsafe location`);
        }
        if (!hasAnchor && !moved) {
          throw new Error(`home ${point.home} did not teleport the bot; check the Home name and server permissions`);
        }
        if (!this.hasSupplyAnchor(point)) {
          point.x = this.bot.entity.position.x;
          point.y = this.bot.entity.position.y;
          point.z = this.bot.entity.position.z;
          point.dimension = this.currentDimension();
          this.persistResupplyPoints();
          this.log(`Supply Home ${point.home} initialized at ${point.x},${point.y},${point.z} in ${point.dimension}.`);
        }
        this.homeActivity = { home: point.home, type: 'supply', state: 'ready', message: `已到达补给点：${point.name}` };
        this.log(`Arrived at configured Home ${point.home} for ${point.name}.`);
      }
      return await action();
    } finally {
      try {
        if (regionReturn && this.bot?.entity) {
          this.homeActivity = { home: regionReturn.home, type: 'mining', state: 'traveling', message: '补给完成，返回挖矿锚点' };
          const returned = await this.issueServerCommand(`/home ${regionReturn.home}`, true);
          const nearMiningAnchor = (returned || this.currentDimension() === regionReturn.dimension)
            && this.currentDimension() === regionReturn.dimension
            && this.bot.entity.position.distanceTo(new Vec3(regionReturn.anchor.x, regionReturn.anchor.y, regionReturn.anchor.z)) <= 8;
          if (!nearMiningAnchor) {
            this.pauseRegionMining(`could not verify return to mining Home ${regionReturn.home}`);
          } else {
            this.homeActivity = { home: regionReturn.home, type: 'mining', state: 'ready', message: '已返回挖矿锚点' };
          }
        } else if (checkpoint && this.bot?.entity) {
          const returned = await this.issueServerCommand(`/home ${checkpoint}`, true);
          const nearCheckpoint = checkpointAnchor && checkpointAnchor.dimension === this.currentDimension()
            && this.bot.entity.position.distanceTo(checkpointAnchor.position) <= 8;
          if (returned || nearCheckpoint) {
            await this.issueServerCommand(`/delhome ${checkpoint}`);
            this.log(`Returned to mining checkpoint and removed ${checkpoint}.`);
          } else {
            this.log(`Could not verify return to temporary checkpoint ${checkpoint}; keeping it for manual recovery.`, 'warn');
          }
        }
      } catch (error) {
        if (regionReturn) this.pauseRegionMining(`could not return to mining Home ${regionReturn.home}: ${error.message}`);
        else if (checkpoint) this.log(`Could not return to temporary checkpoint ${checkpoint}: ${error.message}; keeping it for manual recovery.`, 'warn');
      } finally {
        release();
      }
    }
  }
  supplyContainerRole(point) {
    const canStore = this.supplyPointSupports(point, 'storage');
    const canPickup = this.supplyPointSupports(point, 'food') || this.supplyPointSupports(point, 'pickaxe');
    if (canStore && canPickup) return 'mixed';
    return canStore ? 'storage' : 'pickup';
  }

  supplyContainers(point) {
    const entries = [];
    const seen = new Set();
    const add = (position, role) => {
      if (![position?.x, position?.y, position?.z].every(Number.isFinite)) return;
      const key = `${position.x},${position.y},${position.z}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ x: position.x, y: position.y, z: position.z, role });
    };
    for (const container of point.containers || []) add(container, container.role || this.supplyContainerRole(point));
    if (point.autoDiscover && point.home && this.bot?.findBlocks) {
      try {
        const positions = this.bot.findBlocks({
          matching: (block) => isSupplyContainerName(block?.name),
          maxDistance: Math.max(2, Math.min(32, Number(point.scanRadius) || 8)),
          count: 64
        });
        for (const position of positions) add(position, this.supplyContainerRole(point));
      } catch (error) {
        this.log(`Could not scan containers near Home ${point.home}: ${error.message}`, 'warn');
      }
    }
    if (!entries.length && !point.home && this.hasSupplyAnchor(point)) add(point, this.supplyContainerRole(point));
    if (this.bot?.entity) entries.sort((a, b) => this.bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z)) - this.bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z)));
    return entries;
  }

  findSupplyBed(point) {
    const bot = this.bot;
    if (!bot) return null;
    if (point.bed) {
      const configured = bot.blockAt(new Vec3(point.bed.x, point.bed.y, point.bed.z));
      if (configured && (configured.name === 'bed' || String(configured.name).endsWith('_bed'))) return configured;
    }
    if (point.autoDiscover && point.home && bot.findBlock) {
      return bot.findBlock({
        matching: (block) => block?.name === 'bed' || String(block?.name || '').endsWith('_bed'),
        maxDistance: Math.max(2, Math.min(32, Number(point.scanRadius) || 8))
      });
    }
    return null;
  }

  async maybeSleep() {
    const bot = this.bot;
    if (!bot?.time || bot.isSleeping) return;
    const time = Number(bot.time.timeOfDay);
    if (!(time >= 12541 && time <= 23458)) return;
    const points = this.matchingSupplyPoints('sleep').sort((a, b) => b.priority - a.priority);
    if (!points.length) {
      this.resourceAlert('no-supply-bed', true, '夜晚到了，但没有带“睡觉”角色的 Home 补给点；已停止自动移动。', 120000);
      return;
    }
    for (const point of points) {
      try {
        const slept = await this.withSupplyPoint(point, 'supply', async () => {
          const bed = this.findSupplyBed(point);
          if (!bed || !bot.sleep) return false;
          await this.moveToBlock(bed, 'supply');
          if (!this.sleepEnabled || bot.isSleeping) return true;
          await bot.sleep(bed);
          this.log(`Sleeping at configured supply Home: ${point.name}.`);
          return true;
        });
        if (slept) {
          this.resourceAlert('no-supply-bed', false, '');
          return;
        }
      } catch (error) {
        this.log(`Sleep point ${point.name} failed: ${error.message}`, 'warn');
      }
    }
    this.resourceAlert('no-supply-bed', true, '已到达睡觉补给点，但扫描范围内没有找到可用床。', 120000);
  }

  itemRegistryData(item) {
    const type = Number(item?.type ?? item?.id);
    if (!Number.isInteger(type)) return null;
    try {
      const data = minecraftData(this.bot?.version || this.definition.version);
      return data?.items?.[type] || null;
    } catch (_) {
      return null;
    }
  }

  itemName(item) {
    if (!item) return '';
    const directName = cleanBlockName(item.name);
    if (directName && directName !== 'unknown') return directName;
    const registryName = cleanBlockName(this.itemRegistryData(item)?.name);
    if (registryName) return registryName;
    return cleanBlockName(item.displayName);
  }

  isPickaxeItem(item) {
    if (!item) return false;
    const name = this.itemName(item);
    if (name.includes('pickaxe')) return true;
    const registry = this.itemRegistryData(item);
    return Boolean(registry?.name && String(registry.name).toLowerCase().includes('pickaxe'));
  }

  itemDamage(item) {
    const componentMapDamage = item?.componentMap?.get?.('minecraft:damage');
    const componentListDamage = Array.isArray(item?.components)
      ? item.components.find((component) => component?.type === 'minecraft:damage' || component?.name === 'minecraft:damage')
      : null;
    const nbtDamage = item?.nbt?.value?.Damage ?? item?.nbt?.value?.damage;
    const raw = componentMapDamage?.data ?? componentMapDamage?.value ?? componentMapDamage?.damage
      ?? componentListDamage?.data ?? componentListDamage?.value ?? componentListDamage?.damage
      ?? nbtDamage?.value ?? nbtDamage;
    const damage = Number(raw);
    return Number.isFinite(damage) ? damage : null;
  }

  inventoryItems() {
    if (!this.bot?.inventory) return [];
    const inventory = this.bot.inventory;
    const items = [
      ...(typeof inventory.items === 'function' ? inventory.items() : []),
      ...(Array.isArray(inventory.slots) ? inventory.slots : []),
      this.bot.heldItem
    ].filter(Boolean);
    const seen = new Set();
    return items.filter((item, index) => {
      const slot = Number.isInteger(item.slot) ? item.slot : `unknown-${index}`;
      const key = `${slot}:${item.type ?? this.itemName(item)}:${item.metadata ?? ''}:${item.count ?? 1}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  isToolLow(item) {
    const name = this.itemName(item);
    const isTool = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].some((part) => name.includes(part));
    if (!isTool) return false;
    const maxDurability = Number(item?.maxDurability ?? this.itemRegistryData(item)?.maxDurability);
    const durabilityUsed = Number(item?.durabilityUsed ?? this.itemDamage(item));
    if (!Number.isFinite(maxDurability) || maxDurability <= 0 || !Number.isFinite(durabilityUsed)) return false;
    return maxDurability - durabilityUsed <= 20;
  }

  carriedItems() {
    return this.inventoryItems();
  }

  pickaxeDiagnostics() {
    return this.carriedItems()
      .filter((item) => this.isPickaxeItem(item))
      .map((item) => ({
        name: this.itemName(item) || `type:${item.type ?? 'unknown'}`,
        slot: item.slot ?? 'held',
        count: item.count ?? 1,
        maxDurability: Number.isFinite(Number(item.maxDurability ?? this.itemRegistryData(item)?.maxDurability)) ? Number(item.maxDurability ?? this.itemRegistryData(item)?.maxDurability) : null,
        durabilityUsed: Number.isFinite(Number(item.durabilityUsed ?? this.itemDamage(item))) ? Number(item.durabilityUsed ?? this.itemDamage(item)) : null,
        usable: !this.isToolLow(item)
      }));
  }

  isFoodItem(item) {
    const name = this.itemName(item);
    return ['bread', 'carrot', 'potato', 'beetroot', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'apple', 'melon_slice', 'baked_potato', 'cooked_'].some((part) => name.includes(part));
  }

  hasUsablePickaxe() {
    return this.carriedItems().some((item) => this.isPickaxeItem(item) && !this.isToolLow(item));
  }

  blockNeedsTool(block) {
    return Boolean(block?.harvestTools && Object.keys(block.harvestTools).length);
  }

  usableHarvestTool(block) {
    if (!this.bot || !block) return null;
    const preferred = this.bot.pathfinder?.bestHarvestTool?.(block);
    if (preferred && !this.isToolLow(preferred)) return preferred;
    if (!block.harvestTools) return null;
    return this.carriedItems().find((item) => block.harvestTools[item.type] && !this.isToolLow(item)) || null;
  }

  async prepareHarvestTool(block, taskName) {
    let tool = this.usableHarvestTool(block);
    if (!tool && this.blockNeedsTool(block) && this.effectiveSkillConfig().supply.enabled && (this.mining || this.regionMining)) {
      await this.maybeResupply({ requirePickaxe: true, requireFood: false, requireStorage: false });
      tool = this.usableHarvestTool(block);
    }
    if (!tool && this.blockNeedsTool(block)) {
      const pickaxes = this.pickaxeDiagnostics();
      const observed = this.carriedItems().map((item) => this.itemName(item) || `type:${item.type ?? 'unknown'}`).filter(Boolean);
      const detail = pickaxes.length
        ? `检测到镐子：${pickaxes.map((item) => `${item.name}（${item.usable ? '可用' : '耐久不足'}）`).join('、')}`
        : `未检测到任何 pickaxe（包含手持栏位）；当前物品：${observed.length ? observed.join('、') : '背包数据为空'}`;
      const message = `${taskName} 已暂停：${block.name} 需要可用工具，但${detail}。`;
      this.resourceAlert('missing-required-tool', true, message, 30000);
      return null;
    }
    this.resourceAlert('missing-required-tool', false, '');
    if (tool) await this.bot.equip(tool, 'hand');
    return tool || true;
  }

  isKeepItem(item) {
    const name = this.itemName(item);
    if (name.includes('pickaxe') && this.isToolLow(item)) return false;
    return this.isFoodItem(item) || ['pickaxe', 'axe', 'shovel', 'sword', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots', ...PLUG_BLOCK_NAMES].some((part) => name.includes(part));
  }
  clearResourceAlertPrefix(prefix) {
    for (const key of this.activeAlerts) {
      if (key.startsWith(prefix)) this.activeAlerts.delete(key);
    }
  }

  resourceAlert(key, active, message, cooldownMs = 120000) {
    if (!active) {
      this.activeAlerts.delete(key);
      return false;
    }
    const now = Date.now();
    const last = this.alertLastSent.get(key) || 0;
    const first = !this.activeAlerts.has(key);
    this.activeAlerts.add(key);
    if (!first && now - last < cooldownMs) return false;
    this.alertLastSent.set(key, now);
    this.log(message, 'warn');
    if (this.bot?.chat) this.bot.chat(`[${this.bot.username}] 警告：${message}`);
    return true;
  }

  startResourceMonitor() {
    if (this.resourceTimer) return;
    const tick = async () => {
      this.resourceTimer = null;
      if (!this.bot) return;
      try { await this.checkResourceAlerts(); } catch (error) { this.log(`Resource monitor failed: ${error.message}`, 'warn'); }
      if (this.bot) this.resourceTimer = setTimeout(tick, 10000);
    };
    tick();
  }

  async checkResourceAlerts() {
    const bot = this.bot;
    if (!bot?.inventory) return;
    const items = this.inventoryItems();
    const hasFood = items.some((item) => this.isFoodItem(item));
    const lowHealth = typeof bot.health === 'number' && bot.health <= 8;
    const hungryWithoutFood = typeof bot.food === 'number' && bot.food <= 14 && !hasFood;
    const notifyOnNoFood = this.skillConfig?.supply?.notifyOnNoFood === true;
    const miningNeedsPickaxe = (this.mining || this.regionMining) && !this.hasUsablePickaxe();
    this.resourceAlert('low-health', lowHealth, `生命值过低（${Math.round(bot.health)}/20），已关闭战斗，需要食物或治疗。`);
    if (lowHealth && this.killAuraEnabled) {
      this.killAuraEnabled = false;
      bot.pvp?.stop();
    }
    this.resourceAlert('no-food', notifyOnNoFood && hungryWithoutFood, `饱食度较低（${Math.round(bot.food)}/20），背包里没有找到可食用物品。`);
    const pickaxeDiagnostics = this.pickaxeDiagnostics();
    const pickaxeMessage = miningNeedsPickaxe
      ? `挖矿需要可用镐；审核条件：物品名、物品 ID 或手持栏位能识别为 pickaxe，且剩余耐久必须大于 20。当前检测：${pickaxeDiagnostics.length ? pickaxeDiagnostics.map((item) => `${item.name}（${item.usable ? '可用' : '耐久不足'}）`).join('、') : `未找到（背包数据：${items.length ? items.map((item) => this.itemName(item) || `type:${item.type ?? 'unknown'}`).join('、') : '为空'}）`}。`
      : '';
    this.resourceAlert('no-pickaxe', miningNeedsPickaxe, pickaxeMessage);
    if (!hungryWithoutFood && !miningNeedsPickaxe) this.clearResourceAlertPrefix('resupply-');
    if ((hungryWithoutFood || miningNeedsPickaxe) && this.resupplyEnabled && !this.resupplyBusy) {
      const result = await this.maybeResupply({ requireFood: hungryWithoutFood, requirePickaxe: miningNeedsPickaxe });
      if (!result.ok) this.resourceAlert(`resupply-${result.reason}`, true, `自动补给失败：${result.message}`);
      else this.clearResourceAlertPrefix('resupply-');
    }
  }

  containerItems(container) {
    return typeof container.containerItems === 'function' ? container.containerItems() : (container.slots || []).filter(Boolean);
  }

  async operateSupplyPoint(point, requirements) {
    const bot = this.bot;
    let opened = 0;
    const result = await this.withSupplyPoint(point, 'supply', async () => {
      const containers = this.supplyContainers(point);
      if (!containers.length) throw new Error(`no supported chest, barrel, or shulker box was found within ${point.scanRadius || 8} blocks`);
      for (const containerPosition of containers) {
        if (!bot?.entity) break;
        const block = bot.blockAt(new Vec3(containerPosition.x, containerPosition.y, containerPosition.z));
        if (!block || !isSupplyContainerName(block.name)) continue;
        let container = null;
        try {
          await this.moveToBlock(block, 'supply');
          container = await bot.openContainer(block);
          opened += 1;
          const canStore = requirements.needStorage && this.supplyPointSupports(point, 'storage') && containerPosition.role !== 'pickup';
          if (canStore) {
            for (const item of this.inventoryItems().filter((candidate) => !this.isKeepItem(candidate))) {
              try { await container.deposit(item.type, item.metadata, item.count, item.nbt); } catch (_) {}
            }
          }

          const canPickup = containerPosition.role !== 'storage';
          if (canPickup && requirements.needPickaxe && this.supplyPointSupports(point, 'pickaxe') && !this.hasUsablePickaxe() && bot.inventory.emptySlotCount() > 0) {
            const pickaxe = this.containerItems(container).find((item) => this.itemName(item).includes('pickaxe') && !this.isToolLow(item));
            if (pickaxe) await container.withdraw(pickaxe.type, pickaxe.metadata, 1);
          }
          if (canPickup && requirements.needFood && this.supplyPointSupports(point, 'food') && !this.inventoryItems().some((item) => this.isFoodItem(item)) && bot.inventory.emptySlotCount() > 0) {
            const food = this.containerItems(container).find((item) => this.isFoodItem(item));
            if (food) await container.withdraw(food.type, food.metadata, Math.min(food.count, 32));
          }

          const readyPickaxe = !requirements.needPickaxe || this.hasUsablePickaxe();
          const readyFood = !requirements.needFood || this.inventoryItems().some((item) => this.isFoodItem(item));
          const readyStorage = !requirements.needStorage || bot.inventory.emptySlotCount() > 2;
          if (readyPickaxe && readyFood && readyStorage) return true;
        } catch (error) {
          this.log(`Supply container operation failed at ${containerPosition.x},${containerPosition.y},${containerPosition.z}: ${error.message}`, 'warn');
        } finally {
          if (container) {
            try { await container.close(); } catch (_) {}
          }
        }
      }
      return false;
    });
    return { completed: Boolean(result), opened };
  }

  resupplyRequirements(requirements = {}) {
    const bot = this.bot;
    const hasPickaxe = this.hasUsablePickaxe();
    const hasFood = this.inventoryItems().some((item) => this.isFoodItem(item));
    return {
      hasPickaxe,
      hasFood,
      needPickaxe: requirements.requirePickaxe ?? !hasPickaxe,
      needFood: requirements.requireFood ?? !hasFood,
      needStorage: requirements.requireStorage ?? Boolean(bot?.inventory && bot.inventory.emptySlotCount() <= 2)
    };
  }

  matchingResupplyCandidates(requirements = {}) {
    const bot = this.bot;
    if (!bot?.entity) return [];
    const state = this.resupplyRequirements(requirements);
    return [...this.matchingSupplyPoints(null)].filter((point) => (
      (state.needStorage && this.supplyPointSupports(point, 'storage')) ||
      (state.needPickaxe && this.supplyPointSupports(point, 'pickaxe')) ||
      (state.needFood && this.supplyPointSupports(point, 'food'))
    )).sort((a, b) => {
      const aStorage = state.needStorage && this.supplyPointSupports(a, 'storage') ? 1 : 0;
      const bStorage = state.needStorage && this.supplyPointSupports(b, 'storage') ? 1 : 0;
      const aDistance = this.hasSupplyAnchor(a) ? bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z)) : Number.POSITIVE_INFINITY;
      const bDistance = this.hasSupplyAnchor(b) ? bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z)) : Number.POSITIVE_INFINITY;
      return bStorage - aStorage || b.priority - a.priority || aDistance - bDistance;
    });
  }

  selectSupplyPoint(requirements = {}) {
    return this.matchingResupplyCandidates(requirements)[0] || null;
  }

  resupplyCompletion(state, opened, pointName = '') {
    const bot = this.bot;
    const missing = [];
    if (state.needPickaxe && !this.hasUsablePickaxe()) missing.push('可用镐子');
    if (state.needFood && !this.inventoryItems().some((item) => this.isFoodItem(item))) missing.push('食物');
    if (state.needStorage && bot.inventory.emptySlotCount() <= 2) missing.push('空余背包空间');
    if (missing.length) return { ok: false, reason: 'stock-empty', message: `${pointName || '已配置 Home'} 未能提供：${missing.join('、')}` };
    return { ok: false, reason: opened ? 'incomplete' : 'invalid-point', message: opened ? '补给容器已访问，但维护任务未完成' : '扫描范围内没有可用容器，或 Home 传送失败' };
  }

  async resupplyAtPoint(pointId, requirements = {}) {
    const bot = this.bot;
    if (this.resupplyBusy) return { ok: false, reason: 'busy', message: 'another resupply operation is already running' };
    if (!bot?.entity) return { ok: false, reason: 'offline', message: 'bot world data is unavailable' };
    const state = this.resupplyRequirements(requirements);
    if ((!state.needPickaxe || state.hasPickaxe) && (!state.needFood || state.hasFood) && (!state.needStorage || bot.inventory.emptySlotCount() > 2)) {
      return { ok: true, reason: 'ready', message: 'inventory already has the required supplies' };
    }
    const point = this.matchingResupplyCandidates(requirements).find((candidate) => candidate.id === pointId);
    if (!point) return { ok: false, reason: 'no-point', message: `找不到可满足要求的补给点：${pointId}` };

    this.resupplyBusy = true;
    try {
      const operation = await this.operateSupplyPoint(point, state);
      if (operation.completed) {
        this.log(`Resupply completed at ${point.name}${point.home ? ` (/home ${point.home})` : ''}.`);
        return { ok: true, reason: 'completed', pointId: point.id, message: `resupply completed at ${point.name}` };
      }
      return this.resupplyCompletion(state, operation.opened, point.name);
    } catch (error) {
      return { ok: false, reason: 'point-failed', pointId: point.id, message: `${point.name} 补给失败：${error.message}` };
    } finally {
      this.resupplyBusy = false;
    }
  }

  async maybeResupply(requirements = {}) {
    const bot = this.bot;
    if (this.resupplyBusy) return { ok: false, reason: 'busy', message: 'another resupply operation is already running' };
    if (!bot?.entity) return { ok: false, reason: 'offline', message: 'bot world data is unavailable' };
    const state = this.resupplyRequirements(requirements);
    if ((!state.needPickaxe || state.hasPickaxe) && (!state.needFood || state.hasFood) && (!state.needStorage || bot.inventory.emptySlotCount() > 2)) {
      return { ok: true, reason: 'ready', message: 'inventory already has the required supplies' };
    }

    const points = this.matchingResupplyCandidates(requirements);
    if (!points.length) {
      const roles = [state.needStorage && '矿物存储', state.needPickaxe && '镐子补给', state.needFood && '食物补给'].filter(Boolean).join('、');
      return { ok: false, reason: 'no-point', message: `没有支持${roles}的 Home 补给点；请确认 Home 名称和权限` };
    }

    this.resupplyBusy = true;
    let opened = 0;
    try {
      for (const point of points) {
        try {
          const operation = await this.operateSupplyPoint(point, state);
          opened += operation.opened;
          if (operation.completed) {
            this.log(`Resupply completed at ${point.name}${point.home ? ` (/home ${point.home})` : ''}.`);
            return { ok: true, reason: 'completed', pointId: point.id, message: `resupply completed at ${point.name}` };
          }
        } catch (error) {
          this.log(`Supply point ${point.name} failed: ${error.message}`, 'warn');
        }
      }
      return this.resupplyCompletion(state, opened, '所有已配置 Home');
    } finally {
      this.resupplyBusy = false;
    }
  }

  equipRole(role = 'auto', announce = true) {
    const bot = this.bot;
    if (!bot) return { ok: false, message: `${this.displayName} is not online.` };
    const normalized = String(role || 'auto').toLowerCase();
    const effective = normalized === 'auto' ? (this.mining ? 'pickaxe' : this.killAuraEnabled ? 'weapon' : 'tool') : normalized;
    const patterns = {
      pickaxe: ['pickaxe'], axe: ['axe'], shovel: ['shovel'], weapon: ['sword', 'axe'], food: ['bread', 'carrot', 'potato', 'beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon'], tool: ['pickaxe', 'axe', 'shovel', 'hoe']
    };
    const item = this.inventoryItems().find((candidate) => (patterns[effective] || patterns.tool).some((part) => this.itemName(candidate).includes(part)));
    if (!item) {
      const message = `[${bot.username}] No ${effective} item found in inventory.`;
      if (announce) return this.respond(message);
      this.log(message, 'warn');
      return { ok: false, message };
    }
    this.supplyRole = effective;
    if (this.itemName(bot.heldItem) === this.itemName(item)) {
      return { ok: true, message: `${item.name} is already equipped.` };
    }
    bot.equip(item, 'hand')
      .then(() => {
        this.log(`Equipped ${item.name} for ${effective}.`);
        if (announce) this.respond(`[${bot.username}] Equipped ${item.name}.`);
      })
      .catch((error) => this.log(`Equipment switch failed: ${error.message}`, 'warn'));
    return { ok: true, message: `Equipping ${item.name}.` };
  }

  setSupply(mode = 'on', announce = true) {
    const normalized = String(mode || 'on').toLowerCase();
    if (['off', 'stop', 'disable'].includes(normalized)) {
      this.supply = false;
      this.sleepEnabled = false;
      this.resupplyEnabled = false;
      if (this.supplyTimer) clearTimeout(this.supplyTimer);
      if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
      this.supplyTimer = null;
      this.maintenanceTimer = null;
      if (this.bot?.autoEat?.disable) this.bot.autoEat.disable();
      const message = `[${this.bot?.username || this.displayName}] Home supply, sleep and storage automation disabled.`;
      return announce ? this.respond(message) : { ok: true, message };
    }
    const wasEnabled = this.supply;
    this.supply = true;
    this.sleepEnabled = true;
    this.resupplyEnabled = true;
    if (this.bot?.autoEat?.enable) this.bot.autoEat.enable();
    this.log('Home supply, equipment, storage and nighttime survival enabled.');
    if (!wasEnabled) this.supplyLoop();
    this.startMaintenanceLoop();
    const anchored = this.resupplyPoints.filter((point) => point.enabled !== false && this.hasSupplyAnchor(point)).length;
    const message = `[${this.bot?.username || this.displayName}] Home supply enabled${anchored ? ` (${anchored} anchored station${anchored === 1 ? '' : 's'})` : '; no anchored station yet, first Home visit will record its anchor'}.`;
    return announce ? this.respond(message) : { ok: true, message };
  }

  async supplyLoop() {
    if (!this.supply || !this.bot) return;
    try {
      const bot = this.bot;
      if (bot.autoEat?.eat && typeof bot.food === 'number' && bot.food <= 14 && !bot.autoEat.isEating) await bot.autoEat.eat();
      await this.checkResourceAlerts();
      this.equipRole(this.supplyRole === 'auto' ? 'auto' : this.supplyRole, false);
    } catch (error) {
      this.log(`Supply check failed: ${error.message}`, 'warn');
    } finally {
      if (this.supply) this.supplyTimer = setTimeout(() => this.supplyLoop(), 12000);
    }
  }

  stationaryAttack() {
    const bot = this.bot;
    if (!bot?.entity || this.digging || this.resupplyBusy || bot.isSleeping || this.taskScheduler.isBlocked('combat')) return;
    const entity = bot.nearestEntity((candidate) => this.definition.targetMobs.includes(candidate.name) && candidate.position.distanceTo(bot.entity.position) < 3.5);
    if (!entity) return;
    const sword = this.inventoryItems().find((item) => this.itemName(item).includes('sword'));
    if (sword) bot.equip(sword, 'hand').catch(() => {});
    bot.lookAt(entity.position.offset(0, entity.height * 0.7, 0)).catch(() => {});
    bot.attack(entity);
  }

  activeSkillKeys() {
    const active = [];
    if (this.killAuraEnabled) active.push('combat');
    if (this.fishing) active.push('fishing');
    if (this.mining || this.regionMining) active.push('mining');
    if (this.supply) active.push('supply');
    if (this.chatLogEnabled) active.push('chat-command');
    return active;
  }

  knownHomes() {
    const homes = [];
    if (this.regionPlan?.home) {
      homes.push({
        id: `mining-${this.id}`,
        name: this.regionPlan.home,
        type: 'mining',
        label: '初始挖矿点',
        dimension: this.regionPlan.dimension,
        position: this.regionPlan.anchor ? { ...this.regionPlan.anchor } : null,
        initialized: Boolean(this.regionPlan.anchor),
        active: this.regionMining,
        phase: this.regionPlan.phase || 'idle'
      });
    }
    for (const target of this.homeTargets) {
      homes.push({
        id: `home-target-${target.id}`,
        name: target.name,
        type: 'home',
        label: '定点 Home',
        dimension: target.dimension,
        position: { x: target.x, y: target.y, z: target.z },
        initialized: Boolean(target.lastSetAt),
        active: target.enabled !== false,
        lastSetAt: target.lastSetAt,
        arrivalHome: target.arrivalHome
      });
    }
    for (const point of this.resupplyPoints) {
      if (!point.home) continue;
      homes.push({
        id: point.id,
        name: point.home,
        type: point.roles?.includes('storage') && !point.roles.some((role) => ['food', 'pickaxe', 'sleep'].includes(role)) ? 'storage' : 'supply',
        label: point.name,
        dimension: point.dimension,
        position: this.hasSupplyAnchor(point) ? { x: point.x, y: point.y, z: point.z } : null,
        initialized: this.hasSupplyAnchor(point),
        active: point.enabled !== false,
        roles: [...(point.roles || [])],
        scanRadius: point.scanRadius
      });
    }
    return homes;
  }

  publicStatus() {
    const bot = this.bot;
    const inventory = this.carriedItems();
    const nearbyPlayers = bot?.entities && bot.entity?.position ? Object.values(bot.entities)
      .filter((entity) => entity.type === 'player' && entity.username !== bot.username && entity.position?.distanceTo(bot.entity.position) < 30)
      .map((entity) => entity.username).filter(Boolean) : [];
    return {
      id: this.id,
      displayName: this.displayName,
      state: this.state,
      username: bot?.username || null,
      health: typeof bot?.health === 'number' ? Math.round(bot.health) : null,
      food: typeof bot?.food === 'number' ? Math.round(bot.food) : null,
      position: bot?.entity?.position ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } : null,
      dimension: bot?.game?.dimension || bot?.game?.level?.name || null,
      killAura: this.killAuraEnabled,
      fishing: this.fishing,
      mining: this.mining,
      regionMining: this.regionMining,
      supply: this.supply,
      sleepEnabled: this.sleepEnabled,
      resupplyEnabled: this.resupplyEnabled,
      region: this.regionPlan ? {
        bounds: this.regionPlan.bounds,
        volume: this.regionPlan.volume,
        mode: this.regionPlan.mode,
        allow: this.regionPlan.allow,
        deny: this.regionPlan.deny,
        customDeny: this.regionPlan.customDeny || [],
        dimension: this.regionPlan.dimension,
        home: this.regionPlan.home,
        anchor: this.regionPlan.anchor ? { ...this.regionPlan.anchor } : null,
        phase: this.regionPlan.phase || 'idle',
        cursor: this.regionPlan.cursor,
        scanned: this.regionPlan.scanned,
        mined: this.regionPlan.mined,
        layerTop: this.regionLayerBounds()?.top ?? null,
        layerBottom: this.regionLayerBounds()?.bottom ?? null,
        layerCursor: this.regionPlan.layerCursor,
        active: this.regionPlan.active,
        pausedReason: this.regionPlan.pausedReason,
        lastBlock: this.regionPlan.lastBlock
      } : null,
      resupplyPoints: this.resupplyPoints,
      homeTargets: this.serializedHomeTargets(),
      homes: this.knownHomes(),
      homeActivity: this.homeActivity,
      skills: this.effectiveSkillConfig(),
      activeSkills: this.activeSkillKeys(),
      scheduler: this.taskScheduler.status(),
      skinIdentifier: this.bot?.username || this.definition.skinUsername || this.skinCache?.status(this.id).username || (!String(this.definition.username || '').includes('@') ? this.definition.username : this.definition.id),
      skin: this.skinCache ? {
        avatarUrl: `/api/skins/${encodeURIComponent(this.id)}/avatar`,
        bodyUrl: `/api/skins/${encodeURIComponent(this.id)}/body`,
        ...this.skinCache.status(this.id)
      } : null,
      resourceAlerts: [...this.activeAlerts],
      inventory: inventory.slice(0, 8).map((item) => ({ name: item.name, count: item.count })),
      nearbyPlayers,
      lastError: this.lastError,
      lastReason: this.lastReason,
      viewerPort: this.definition.viewer?.enabled ? this.definition.viewer.port : null
    };
  }

  helpText() {
    return 'workflow run <id> | fish | mine <block> [count] | 网页配置区域和黑/白名单后使用 area on/off/status | unseal | supply on/off | resupply on/off | resupply point add <x> <y> <z> | sleep on/off | equip <auto|pickaxe|axe|weapon> | kill on/off | stop | status | look <player> | look <yaw> <pitch> | home <name> | sethome <name> | delhome <name> | come <player> | follow <player> | cmd /<command>';
  }
}

module.exports = { ManagedBot };
