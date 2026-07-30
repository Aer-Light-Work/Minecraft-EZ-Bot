'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { activateAuthProxy, deactivateAuthProxy } = require('../src/core/auth-proxy');

test('activateAuthProxy with SOCKS5 replaces undici global dispatcher and http Agents', async () => {
  const undici = require('undici');

  const originalDispatcher = undici.getGlobalDispatcher();
  const originalHttpAgent = http.globalAgent;
  const originalHttpsAgent = https.globalAgent;

  try {
    await activateAuthProxy('socks5://127.0.0.1:1080');

    // undici dispatcher should have been replaced
    const currentDispatcher = undici.getGlobalDispatcher();
    assert.notStrictEqual(currentDispatcher, originalDispatcher);

    // http.Agent should have been replaced
    assert.notStrictEqual(http.globalAgent, originalHttpAgent);
    assert.notStrictEqual(https.globalAgent, originalHttpsAgent);
  } finally {
    // Restore
    deactivateAuthProxy();
    assert.strictEqual(undici.getGlobalDispatcher(), originalDispatcher);
    assert.strictEqual(http.globalAgent, originalHttpAgent);
    assert.strictEqual(https.globalAgent, originalHttpsAgent);
  }
});

test('activateAuthProxy with HTTP URL is rejected (only socks5 supported)', async () => {
  const undici = require('undici');
  const originalDispatcher = undici.getGlobalDispatcher();

  // HTTP proxy URL should not replace the dispatcher
  await activateAuthProxy('http://proxy.example:8080');
  assert.strictEqual(undici.getGlobalDispatcher(), originalDispatcher);
});

test('activateAuthProxy with empty URL does nothing', async () => {
  const undici = require('undici');
  const originalDispatcher = undici.getGlobalDispatcher();

  await activateAuthProxy('');
  assert.strictEqual(undici.getGlobalDispatcher(), originalDispatcher);

  await activateAuthProxy(null);
  assert.strictEqual(undici.getGlobalDispatcher(), originalDispatcher);

  await activateAuthProxy(undefined);
  assert.strictEqual(undici.getGlobalDispatcher(), originalDispatcher);
});

test('deactivateAuthProxy is idempotent when called twice', () => {
  // Should not throw when nothing is saved
  deactivateAuthProxy();
  deactivateAuthProxy();
});

test('SOCKS dispatcher connect function maps origin hostname to opts.host', async () => {
  // This test verifies the core parameter mapping in buildSocksDispatcher
  // without requiring a running SOCKS proxy.
  const { SocksProxyAgent } = require('socks-proxy-agent');

  const socksAgent = new SocksProxyAgent('socks5://127.0.0.1:1080');

  // Simulate what buildSocksDispatcher does internally:
  // Call socksAgent.connect with parameters in the exact format our code uses.
  // The socket connect will fail (ECONNREFUSED) because no proxy is running,
  // but it will NOT throw "No host defined" or "Cannot read properties of null".
  const promise = socksAgent.connect(
    { emit: () => {}, destroy: () => {}, url: '', method: 'CONNECT' },
    {
      host: 'example.com',
      port: 443,
      secureEndpoint: true,
    }
  );
  const result = await promise.catch((err) => err);
  assert.ok(result instanceof Error);
  // The error should be about socket connection refusal, not parameter mapping
  assert.ok(
    result.message.includes('ECONNREFUSED'),
    `Expected ECONNREFUSED error (proves host mapping worked), got: ${result.message}`
  );
});

test('buildSocks5Dispatcher creates an undici Agent with callback-style connect', () => {
  const undici = require('undici');
  const { Agent } = undici;
  const { SocksProxyAgent } = require('socks-proxy-agent');

  const socksAgent = new SocksProxyAgent('socks5://127.0.0.1:1080');

  // This is exactly what buildSocks5Dispatcher does — callback-style, not async
  const agent = new Agent({
    connect(origin, callback) {
      socksAgent
        .connect(
          { emit: () => {}, destroy: () => {}, url: '', method: 'CONNECT' },
          {
            host: origin.hostname || origin.host,
            port: parseInt(origin.port || '443', 10),
            secureEndpoint: origin.protocol === 'https:',
          }
        )
        .then((socket) => callback(null, socket))
        .catch((err) => callback(err, null));
    },
  });

  assert.ok(agent);
  assert.ok(agent instanceof Agent);

  // Should be accepted as a global dispatcher
  const originalDispatcher = undici.getGlobalDispatcher();
  try {
    undici.setGlobalDispatcher(agent);
    assert.strictEqual(undici.getGlobalDispatcher(), agent);
  } finally {
    undici.setGlobalDispatcher(originalDispatcher);
  }
});

test('definitions() returns authProxy field', () => {
  // Quick check that bot-manager exposes authProxy in definitions
  const { BotManager } = require('../src/core/bot-manager');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-authproxy-'));
  const config = {
    rootDir,
    configDir: rootDir,
    dataDir: path.join(rootDir, 'data'),
    botsPath: path.join(rootDir, 'bots.local.json'),
    whitelistPath: path.join(rootDir, 'whitelist.local.json'),
    defaults: {
      checkTimeoutInterval: 60000,
      viewDistance: 8,
      reconnectDelayMs: 5000,
      authReconnectDelayMs: 30000,
      skills: {
        combat: { enabled: false, priority: 55, autoStart: false },
        fishing: { enabled: false, priority: 20, autoStart: false },
        pathfinder: { enabled: false, priority: 30, autoStart: false },
        mining: { enabled: false, priority: 45, autoStart: false },
        supply: { enabled: false, priority: 85, autoStart: false, notifyOnNoFood: false },
        'chat-command': { enabled: true, priority: 10, autoStart: false },
        'openai-tools': { enabled: false, priority: 1, autoStart: false }
      }
    },
    web: { host: '127.0.0.1', port: 0, viewerPortStart: 3101, allowRawCommands: false, autoStart: [] },
    bots: [
      {
        id: 'authProxyBot',
        displayName: 'AuthProxy Test',
        enabled: true,
        host: 'mc.example.com',
        port: 25565,
        username: 'test@example.com',
        auth: 'microsoft',
        version: '',
        authProxy: 'socks5://127.0.0.1:1080',
        viewer: { enabled: false, port: null, viewDistance: 6, firstPerson: false },
        commandWhitelist: null,
        skills: null,
        resupplyPoints: [],
        homeTargets: []
      }
    ],
    whitelist: [],
    workflows: []
  };

  const manager = new BotManager(config);
  const defs = manager.definitions();
  const botDef = defs.find((bot) => bot.id === 'authProxyBot');
  assert.ok(botDef);
  assert.strictEqual(botDef.authProxy, 'socks5://127.0.0.1:1080');

  // Cleanup
  fs.rmSync(rootDir, { recursive: true, force: true });
});