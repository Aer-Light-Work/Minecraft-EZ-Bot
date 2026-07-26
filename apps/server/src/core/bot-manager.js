const EventEmitter = require('node:events');
const { ManagedBot } = require('./managed-bot');
const { SkinCache } = require('./skin-cache');
const { loadConfig, normalizeBotDefinition, normalizeSkillSettings, validateBotDefinitions } = require('../config/load-config');
const { saveBotsConfig, saveWhitelist, saveWorkflows } = require('../config/config-store');

class BotManager extends EventEmitter {
  constructor(config = loadConfig()) {
    super();
    this.config = config;
    this.bots = new Map();
    this.logs = [];
    this.skinCache = new SkinCache(config);
    for (const definition of config.bots) this.attachRuntime(definition);
  }

  attachRuntime(definition) {
    const runtime = new ManagedBot(this.config, definition, this.skinCache);
    runtime.on('log', (entry) => {
      this.logs.push(entry);
      if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
      this.emit('log', entry);
    });
    runtime.on('state', (status) => this.emit('state', status));
    this.bots.set(definition.id, runtime);
    return runtime;
  }

  get(id) {
    if (this.bots.has(id)) return this.bots.get(id);
    const normalized = String(id || '').toLowerCase();
    return [...this.bots.values()].find((bot) => bot.id.toLowerCase() === normalized);
  }

  list() {
    return [...this.bots.values()].map((bot) => ({
      ...bot.publicStatus(),
      enabled: bot.definition.enabled,
      host: bot.definition.host,
      port: bot.definition.port,
      configuredUsername: bot.definition.username,
      version: bot.definition.version || null,
      auth: bot.definition.auth || null,
      viewer: { ...bot.definition.viewer },
      commandWhitelist: bot.definition.commandWhitelist ? [...bot.definition.commandWhitelist] : null,
      resupplyPoints: bot.definition.resupplyPoints ? bot.definition.resupplyPoints.map((point) => ({ ...point })) : []
    }));
  }

  definitions() {
    return this.config.bots.map((bot) => ({
      id: bot.id,
      displayName: bot.displayName,
      skinUsername: bot.skinUsername || '',
      enabled: bot.enabled,
      host: bot.host,
      port: bot.port,
      username: bot.username,
      auth: bot.auth || 'microsoft',
      version: bot.version || '',
      viewer: { ...bot.viewer },
      commandWhitelist: bot.commandWhitelist ? [...bot.commandWhitelist] : null,
      resupplyPoints: bot.resupplyPoints ? bot.resupplyPoints.map((point) => ({ ...point, containers: point.containers?.map((container) => ({ ...container })) || [], bed: point.bed ? { ...point.bed } : null })) : [],
      homeTargets: bot.homeTargets ? bot.homeTargets.map((target) => ({ ...target })) : [],
      skills: bot.skills ? normalizeSkillSettings(this.config.defaults.skills, bot.skills) : null
    }));
  }

  allocateViewerPort(excludeId = null) {
    const used = new Set(this.config.bots
      .filter((bot) => bot.id !== excludeId && bot.viewer?.enabled)
      .map((bot) => bot.viewer.port));
    for (let port = this.config.web.viewerPortStart; port <= 65535; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new Error('No free viewer port is available in the configured range.');
  }

  prepareDefinition(input, index = this.config.bots.length, excludeId = null) {
    const draft = {
      ...input,
      viewer: { ...(input.viewer || {}) }
    };
    if (draft.viewer.enabled && (draft.viewer.port === undefined || draft.viewer.port === '' || !Number.isInteger(Number(draft.viewer.port)))) {
      draft.viewer.port = this.allocateViewerPort(excludeId);
    } else if (draft.viewer.port !== undefined && draft.viewer.port !== '') {
      draft.viewer.port = Number(draft.viewer.port);
    }
    if (draft.port !== undefined) draft.port = Number(draft.port);
    return normalizeBotDefinition(draft, this.config.defaults, index);
  }

  add(input) {
    try {
      const definition = this.prepareDefinition(input);
      const next = [...this.config.bots, definition];
      validateBotDefinitions(next);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      this.attachRuntime(definition);
      return { ok: true, message: `${definition.displayName} added.`, bot: this.get(definition.id).publicStatus(), definition: this.definition(definition.id) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  update(id, patch) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    if (runtime.state !== 'stopped') return { ok: false, message: 'Stop the bot before editing its configuration.' };
    if (patch.id && String(patch.id) !== runtime.id) return { ok: false, message: 'Bot id cannot be changed. Create a new bot instead.' };

    try {
      const current = runtime.definition;
      const definition = this.prepareDefinition({
        ...current,
        ...patch,
        id: current.id,
        viewer: { ...current.viewer, ...(patch.viewer || {}) }
      }, this.config.bots.indexOf(current), current.id);
      const next = this.config.bots.map((bot) => bot.id === current.id ? definition : bot);
      validateBotDefinitions(next);
      saveBotsConfig(this.config, next);
      runtime.removeAllListeners();
      this.bots.delete(current.id);
      this.config.bots = next;
      this.attachRuntime(definition);
      return { ok: true, message: `${definition.displayName} updated.`, definition: this.definition(definition.id) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  remove(id) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    if (runtime.state !== 'stopped') return { ok: false, message: 'Stop the bot before deleting it.' };
    try {
      const next = this.config.bots.filter((bot) => bot.id !== runtime.id);
      this.config.web.autoStart = this.config.web.autoStart.filter((botId) => botId !== runtime.id);
      saveBotsConfig(this.config, next);
      runtime.removeAllListeners();
      this.bots.delete(runtime.id);
      this.config.bots = next;
      return { ok: true, message: `${runtime.displayName} removed. Authentication cache was kept.` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  definition(id) {
    const runtime = this.get(id);
    if (!runtime) return null;
    return this.definitions().find((definition) => definition.id === runtime.id) || null;
  }

  start(id) {
    const bot = this.get(id);
    if (!bot) return { ok: false, message: `Unknown bot: ${id}` };
    if (!bot.definition.enabled) return { ok: false, message: `${bot.displayName} is disabled in its configuration.` };
    bot.start();
    return { ok: true, message: `${bot.displayName} start requested.` };
  }

  stop(id) {
    const bot = this.get(id);
    if (!bot) return { ok: false, message: `Unknown bot: ${id}` };
    bot.stop();
    return { ok: true, message: `${bot.displayName} stopped.` };
  }

  restart(id) {
    const stopped = this.stop(id);
    if (!stopped.ok) return stopped;
    return this.start(id);
  }

  setViewerPerspective(id, firstPerson) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    if (!runtime.definition.viewer?.enabled) return { ok: false, message: `${runtime.displayName} viewer is disabled.` };
    try {
      const next = this.config.bots.map((bot) => bot.id === runtime.id ? {
        ...bot,
        viewer: { ...bot.viewer, firstPerson: Boolean(firstPerson) }
      } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      runtime.definition = next.find((bot) => bot.id === runtime.id);
      if (runtime.state === 'online') {
        runtime.closeViewer();
        setTimeout(() => runtime.startViewer(), 300);
      }
      const label = firstPerson ? 'first-person' : 'third-person';
      return { ok: true, message: `${runtime.displayName} viewer switched to ${label}.`, firstPerson: Boolean(firstPerson) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  execute(id, command, args = [], source = 'web') {
    const bot = this.get(id);
    if (!bot) return { ok: false, message: `Unknown bot: ${id}` };
    return bot.execute(command, args, { source, sender: source.toUpperCase() });
  }

  executeLine(id, line, source = 'web') {
    const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { ok: false, message: 'Command is empty.' };
    return this.execute(id, tokens.shift(), tokens, source);
  }

  configureRegion(id, input) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    const result = runtime.configureRegion(input);
    if (!result.ok) return result;
    try {
      const miningRegion = runtime.serializedRegionPlan();
      const next = this.config.bots.map((bot) => bot.id === runtime.id ? { ...bot, miningRegion } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      runtime.definition = next.find((bot) => bot.id === runtime.id);
      return { ...result, region: runtime.publicStatus().region };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  skillSettings() {
    return {
      global: normalizeSkillSettings(this.config.defaults?.skills || {}),
      bots: [...this.bots.values()].map((runtime) => ({
        id: runtime.id,
        displayName: runtime.displayName,
        skills: runtime.effectiveSkillConfig(),
        activeSkills: runtime.activeSkillKeys()
      }))
    };
  }

  updateSkills(scope, botId, settings) {
    const normalizedScope = scope === 'global' ? 'global' : 'bot';
    const normalized = normalizeSkillSettings(normalizedScope === 'global' ? this.config.defaults?.skills : this.config.defaults?.skills, settings || {});
    try {
      if (normalizedScope === 'global') {
        this.config.defaults.skills = normalized;
        saveBotsConfig(this.config, this.config.bots);
        for (const runtime of this.bots.values()) {
          if (!runtime.definition.skills) runtime.updateSkillConfig(normalized);
        }
        return { ok: true, message: 'Global skill settings saved.', scope: 'global', skills: normalized };
      }
      const runtime = this.get(botId);
      if (!runtime) return { ok: false, message: `Unknown bot: ${botId}` };
      const next = this.config.bots.map((bot) => bot.id === runtime.id ? { ...bot, skills: normalized } : bot);
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      runtime.definition = next.find((bot) => bot.id === runtime.id);
      runtime.updateSkillConfig(normalized);
      return { ok: true, message: `${runtime.displayName} skill settings saved.`, scope: 'bot', botId: runtime.id, skills: normalized };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  copySkills(sourceBotId, targetBotIds = []) {
    const source = this.get(sourceBotId);
    if (!source) return { ok: false, message: `Unknown source bot: ${sourceBotId}` };
    const targets = (Array.isArray(targetBotIds) && targetBotIds.length ? targetBotIds : [...this.bots.keys()]).filter((id) => id !== source.id);
    const skills = source.effectiveSkillConfig();
    const next = this.config.bots.map((bot) => targets.includes(bot.id) ? { ...bot, skills } : bot);
    try {
      saveBotsConfig(this.config, next);
      this.config.bots = next;
      for (const targetId of targets) {
        const runtime = this.get(targetId);
        if (!runtime) continue;
        runtime.definition = next.find((bot) => bot.id === runtime.id) || runtime.definition;
        runtime.updateSkillConfig(skills);
      }
      return { ok: true, message: `Copied skill settings to ${targets.length} bot(s).`, skills, targetBotIds: targets };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  workflows() {
    return (this.config.workflows || []).map((workflow) => ({
      ...workflow,
      variables: { ...(workflow.variables || {}) },
      settings: { ...(workflow.settings || {}) },
      nodes: workflow.nodes.map((node) => ({
        ...node,
        position: { ...(node.position || {}) },
        params: { ...node.params },
        retry: { ...(node.retry || {}) }
      })),
      edges: workflow.edges.map((edge) => ({ ...edge }))
    }));
  }

  workflowNodeTypes() {
    const runtime = this.bots.values().next().value;
    if (runtime?.workflowEngine) return runtime.workflowEngine.listNodeTypes();
    const { createDefaultWorkflowNodeRegistry } = require('./workflow-node-registry');
    return createDefaultWorkflowNodeRegistry().list();
  }

  updateWorkflows(workflows) {
    const { normalizeWorkflows, validateWorkflow } = require('../config/workflow-config');
    const { createDefaultWorkflowNodeRegistry } = require('./workflow-node-registry');
    const normalized = normalizeWorkflows(workflows);
    if (!normalized.length && Array.isArray(workflows) && workflows.length) return { ok: false, message: 'No valid workflows were provided.' };
    const registry = createDefaultWorkflowNodeRegistry();
    const invalid = normalized.map((workflow) => ({ workflow, validation: validateWorkflow(workflow, registry) })).find((entry) => !entry.validation.valid);
    if (invalid) return { ok: false, message: `Workflow ${invalid.workflow.id} is invalid: ${invalid.validation.errors.join(' ')}` };
    try {
      saveWorkflows(this.config, normalized);
      this.config.workflows = normalized;
      for (const runtime of this.bots.values()) runtime.workflowEngine.definitions = normalized;
      return { ok: true, message: `Saved ${normalized.length} workflow(s).`, workflows: this.workflows() };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  async runWorkflow(id, workflowId, input = {}) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    try {
      const result = await runtime.runWorkflow(workflowId, input);
      return { ok: true, message: `Workflow ${workflowId} completed.`, result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }
  configureHomeTargets(id, targets) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    try {
      const normalized = runtime.configureHomeTargets(targets);
      return { ok: true, message: `${runtime.displayName} Home targets saved.`, targets: normalized };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  setHomeTarget(id, targetId) {
    const runtime = this.get(id);
    if (!runtime) return Promise.resolve({ ok: false, message: `Unknown bot: ${id}` });
    return runtime.setHomeTarget(targetId);
  }

  configureSupply(id, points) {
    const runtime = this.get(id);
    if (!runtime) return { ok: false, message: `Unknown bot: ${id}` };
    try {
      const normalized = runtime.configureSupplyPoints(points);
      return { ok: true, message: `${runtime.displayName} supply points saved.`, points: normalized };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  skinFile(id, kind) {
    const runtime = this.get(id);
    if (!runtime) return null;
    return this.skinCache.file(runtime.id, kind);
  }

  async ensureSkin(id) {
    const runtime = this.get(id);
    if (!runtime) return null;
    const cached = this.skinCache.status(runtime.id);
    const username = runtime.bot?.username || runtime.definition.skinUsername || cached.username || (!String(runtime.definition.username || '').includes('@') ? runtime.definition.username : '');
    if (username) await this.skinCache.ensure(runtime.id, username);
    return this.skinCache.status(runtime.id);
  }

  batch(action, ids = []) {
    const targets = ids.length ? ids : [...this.bots.keys()];
    const results = targets.map((id) => {
      if (action === 'start') return { id, ...this.start(id) };
      if (action === 'stop') return { id, ...this.stop(id) };
      if (action === 'restart') return { id, ...this.restart(id) };
      return { id, ok: false, message: `Unknown batch action: ${action}` };
    });
    const failed = results.filter((result) => !result.ok).length;
    return { ok: failed === 0, message: failed ? `${results.length - failed} succeeded, ${failed} failed.` : `${results.length} bot operation(s) completed.`, results };
  }

  recentLogs(botId = null, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.logs.filter((entry) => !botId || entry.botId === botId).slice(-safeLimit);
  }

  setWhitelist(names, botId = null) {
    if (!Array.isArray(names)) return { ok: false, message: 'Whitelist must be an array of player names.' };
    const seen = new Set();
    const whitelist = [];
    for (const value of names) {
      const name = String(value).trim();
      const key = name.toLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        whitelist.push(name);
      }
    }
    try {
      if (botId) {
        const runtime = this.get(botId);
        if (!runtime) return { ok: false, message: `Unknown bot: ${botId}` };
        if (runtime.state !== 'stopped') return { ok: false, message: 'Stop the bot before changing its whitelist.' };
        const next = this.config.bots.map((bot) => bot.id === runtime.id ? { ...bot, commandWhitelist: whitelist } : bot);
        saveBotsConfig(this.config, next);
        this.config.bots = next;
        runtime.definition = next.find((bot) => bot.id === runtime.id);
        return { ok: true, message: `${runtime.displayName} whitelist saved.`, whitelist };
      }
      saveWhitelist(this.config, whitelist);
      this.config.whitelist = whitelist;
      return { ok: true, message: 'Global whitelist saved.', whitelist };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  startEnabled() {
    for (const bot of this.bots.values()) {
      if (bot.definition.enabled && this.config.web.autoStart.includes(bot.id)) bot.start();
    }
  }

  startAll() {
    return this.batch('start');
  }

  stopAll() {
    return this.batch('stop');
  }
}

module.exports = { BotManager };
