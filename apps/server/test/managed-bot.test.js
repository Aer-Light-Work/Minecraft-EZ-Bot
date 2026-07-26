const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { ManagedBot } = require('../src/core/managed-bot');

function createConfig() {
  return {
    botsPath: '',
    bots: [],
    defaults: { skills: {} }
  };
}

function createManagedBot() {
  return new ManagedBot(createConfig(), {
    id: 'miner',
    displayName: 'Miner',
    host: 'localhost',
    username: 'Miner',
    auth: 'offline',
    miningRegion: {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
      mode: 'blacklist',
      allow: [],
      deny: []
    },
    resupplyPoints: [{ id: 'supply', name: '补给站', home: 'supply', roles: ['food', 'pickaxe'], containers: [] }]
  });
}

test('hydrates a stable mining Home and exposes all configured Homes', () => {
  const managedBot = createManagedBot();
  assert.equal(managedBot.regionPlan.home, '_mcbot_miner_mine');
  assert.equal(managedBot.regionPlan.anchor, null);
  assert.deepEqual(managedBot.knownHomes().map((home) => home.name), ['_mcbot_miner_mine', 'supply']);
  assert.equal(managedBot.knownHomes()[0].initialized, false);
  assert.equal(managedBot.knownHomes()[1].initialized, false);
});

test('region mining only selects blocks with a real exposed approach', () => {
  const managedBot = createManagedBot();
  const targetPosition = new Vec3(1, 1, 1);
  managedBot.bot = {
    blockAt(position) {
      const name = position.equals(targetPosition.plus(new Vec3(1, 0, 0))) ? 'air' : 'stone';
      return { name, position: position.clone(), boundingBox: name === 'air' ? 'empty' : 'block' };
    }
  };
  assert.equal(managedBot.isRegionCandidate({ name: 'stone', position: targetPosition }), true);

  managedBot.bot = {
    blockAt(position) {
      return { name: 'stone', position: position.clone(), boundingBox: 'block' };
    }
  };
  assert.equal(managedBot.isRegionCandidate({ name: 'stone', position: targetPosition }), false);
});

test('region mining scans two layers from the top and descends one layer at a time', () => {
  const managedBot = createManagedBot();
  const first = managedBot.regionPositionAt(0);
  const area = 3 * 3;
  assert.equal(first.y, 2);
  assert.equal(managedBot.regionPositionAt(area).y, 1);
  assert.equal(managedBot.regionPositionAt(area * 2), null);
  assert.equal(managedBot.isInActiveRegionLayer(new Vec3(1, 2, 1)), true);
  assert.equal(managedBot.isInActiveRegionLayer(new Vec3(1, 0, 1)), false);

  assert.equal(managedBot.advanceRegionLayer(), true);
  assert.equal(managedBot.regionPlan.layerTop, 1);
  assert.equal(managedBot.regionPositionAt(0).y, 1);
  assert.equal(managedBot.regionPositionAt(area).y, 0);
  assert.equal(managedBot.advanceRegionLayer(), true);
  assert.equal(managedBot.regionPlan.layerTop, 0);
  assert.equal(managedBot.advanceRegionLayer(), false);
});

test('recognizes a usable pickaxe that is currently held in hand', () => {
  const managedBot = createManagedBot();
  managedBot.bot = {
    inventory: { items: () => [] },
    heldItem: { name: 'diamond_pickaxe', type: 278, count: 1, maxDurability: 1561, durabilityUsed: 0 }
  };
  assert.equal(managedBot.hasUsablePickaxe(), true);
  assert.equal(managedBot.pickaxeDiagnostics()[0].usable, true);
});

test('recognizes a pickaxe from the hotbar slot and item id when name is absent', () => {
  const managedBot = createManagedBot();
  managedBot.bot = {
    version: '1.21.1',
    inventory: {
      items: () => [],
      slots: [{ type: 840, count: 1, slot: 36 }]
    },
    heldItem: null
  };
  assert.equal(managedBot.itemName(managedBot.bot.inventory.slots[0]), 'diamond_pickaxe');
  assert.equal(managedBot.hasUsablePickaxe(), true);
  assert.equal(managedBot.pickaxeDiagnostics()[0].name, 'diamond_pickaxe');
});

test('only sends no-food alerts when the supply setting enables them', async () => {
  const managedBot = createManagedBot();
  const chatMessages = [];
  managedBot.bot = {
    health: 20,
    food: 10,
    inventory: { items: () => [] },
    chat(message) { chatMessages.push(message); }
  };

  await managedBot.checkResourceAlerts();
  assert.equal(managedBot.activeAlerts.has('no-food'), false);
  assert.deepEqual(chatMessages, []);

  managedBot.updateSkillConfig({ supply: { enabled: true, notifyOnNoFood: true } });
  await managedBot.checkResourceAlerts();
  assert.equal(managedBot.activeAlerts.has('no-food'), true);
  assert.equal(chatMessages.length, 1);

  managedBot.updateSkillConfig({ supply: { enabled: true, notifyOnNoFood: false } });
  await managedBot.checkResourceAlerts();
  assert.equal(managedBot.activeAlerts.has('no-food'), false);
  assert.equal(chatMessages.length, 1);
});

test('uses component damage when deciding whether a modern pickaxe is too damaged', () => {
  const managedBot = createManagedBot();
  managedBot.bot = {
    version: '1.21.1',
    inventory: {
      items: () => [{ type: 840, count: 1, componentMap: new Map([['minecraft:damage', { type: 'minecraft:damage', value: 1545 }]]) }],
      slots: []
    },
    heldItem: null
  };
  assert.equal(managedBot.hasUsablePickaxe(), false);
  assert.equal(managedBot.pickaxeDiagnostics()[0].usable, false);
});
test('targeted mining skips a blocked candidate and selects the next matching block', () => {
  const managedBot = createManagedBot();
  const blocked = new Vec3(1, 1, 1);
  const next = new Vec3(2, 1, 1);
  managedBot.miningTarget = { ids: [1] };
  managedBot.bot = {
    entity: { position: new Vec3(0, 1, 1) },
    findBlocks: () => [blocked, next],
    blockAt(position) {
      return { name: 'stone', position: position.clone(), boundingBox: 'block' };
    }
  };
  managedBot.rememberMiningFailure(blocked, 'line of sight');
  const selection = managedBot.findMiningCandidate();
  assert.equal(selection.foundMatching, true);
  assert.equal(selection.candidates[0].position.equals(next), true);
});

test('normalizes configured Home targets and exposes them as known Homes', () => {
  const managedBot = new ManagedBot(createConfig(), {
    id: 'traveler',
    displayName: 'Traveler',
    host: 'localhost',
    username: 'Traveler',
    auth: 'offline',
    homeTargets: [{ id: 'nether-mine', name: '下界矿区', dimension: 'minecraft:the_nether', x: 12, y: 64, z: -8, arrivalHome: 'nether_gate' }]
  });
  const target = managedBot.homeTargets[0];
  assert.deepEqual(target, { id: 'nether-mine', name: '下界矿区', dimension: 'the_nether', x: 12, y: 64, z: -8, arrivalHome: 'nether_gate', enabled: true, useServerTeleport: true, lastSetAt: null });
  assert.equal(managedBot.knownHomes()[0].type, 'home');
  assert.equal(managedBot.knownHomes()[0].dimension, 'the_nether');
});
