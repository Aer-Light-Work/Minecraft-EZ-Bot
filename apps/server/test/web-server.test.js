const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotManager } = require('../src/core/bot-manager');
const { createWebServer } = require('../src/web/server');

function createConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-api-'));
  return {
    rootDir,
    configDir: rootDir,
    dataDir: path.join(rootDir, 'data'),
    botsPath: path.join(rootDir, 'bots.local.json'),
    whitelistPath: path.join(rootDir, 'whitelist.local.json'),
    workflowsPath: path.join(rootDir, 'workflows.local.json'),
    workflows: [],
    defaults: { checkTimeoutInterval: 60000, viewDistance: 'tiny', reconnectDelayMs: 30000, authReconnectDelayMs: 60000, targetMobs: [] },
    web: { host: '127.0.0.1', port: 0, viewerPortStart: 4200, autoStart: [], allowRawCommands: false },
    bots: [],
    whitelist: []
  };
}

async function api(base, pathname, options) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

test('web API manages bot definitions and whitelist without starting Minecraft', async (t) => {
  const config = createConfig();
  const manager = new BotManager(config);
  const server = createWebServer(manager);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(config.rootDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await api(base, '/api/bots', {
    method: 'POST',
    body: JSON.stringify({ id: 'web-bot', host: 'localhost', username: 'WebBot', auth: 'offline', viewer: { enabled: true } })
  });
  assert.equal(created.status, 201);
  assert.equal(manager.definition('web-bot').viewer.port, 4200);

  const perspective = await api(base, '/api/bots/web-bot/perspective', {
    method: 'POST',
    body: JSON.stringify({ firstPerson: true })
  });
  assert.equal(perspective.status, 200);
  assert.equal(manager.definition('web-bot').viewer.firstPerson, true);

  const whitelist = await api(base, '/api/whitelist', {
    method: 'PUT',
    body: JSON.stringify({ whitelist: ['Operator'] })
  });
  assert.equal(whitelist.status, 200);
  assert.deepEqual(manager.config.whitelist, ['Operator']);

  const listed = await api(base, '/api/config');
  assert.equal(listed.body.bots.length, 1);

  const workflowNodes = await api(base, '/api/workflow-nodes');
  assert.equal(workflowNodes.status, 200);
  assert.equal(workflowNodes.body.nodes.some((node) => node.type === 'find_supply_point'), true);

  const workflowSaved = await api(base, '/api/workflows', {
    method: 'PUT',
    body: JSON.stringify({ workflows: [{ id: 'test-flow', name: 'Test flow', nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [{ source: 'start', target: 'end' }] }] })
  });
  assert.equal(workflowSaved.status, 200);
  assert.equal(manager.workflows()[0].id, 'test-flow');
  assert.equal(fs.existsSync(config.workflowsPath), true);

  const removed = await api(base, '/api/bots/web-bot', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(manager.list().length, 0);
});
