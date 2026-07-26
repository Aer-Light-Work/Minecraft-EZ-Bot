const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowEngine } = require('../src/core/workflow-engine');

const definition = {
  id: 'safe-mine',
  name: 'Safe mine',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'home', type: 'ensure_mining_home' },
    { id: 'pickaxe', type: 'has_usable_pickaxe' },
    { id: 'supply', type: 'resupply', params: { requirePickaxe: true } },
    { id: 'equip', type: 'equip', params: { role: 'pickaxe' } },
    { id: 'mine', type: 'start_region_mining' },
    { id: 'failed', type: 'end' },
    { id: 'end', type: 'end' }
  ],
  edges: [
    { source: 'start', target: 'home' },
    { source: 'home', target: 'pickaxe' },
    { source: 'pickaxe', target: 'equip', when: 'true' },
    { source: 'pickaxe', target: 'supply', when: 'false' },
    { source: 'supply', target: 'equip' },
    { source: 'supply', target: 'failed', when: 'error' },
    { source: 'equip', target: 'mine' },
    { source: 'mine', target: 'end' }
  ]
};

test('workflow branches through resupply when no usable pickaxe is carried', async () => {
  const calls = [];
  let hasPickaxe = false;
  const bot = {
    regionPlan: { home: '_mine' },
    ensureRegionAnchor: async () => calls.push('home'),
    hasUsablePickaxe: () => hasPickaxe,
    maybeResupply: async () => { calls.push('supply'); hasPickaxe = true; return { ok: true, message: 'ready' }; },
    equipRole: () => { calls.push('equip'); return { ok: true }; },
    startRegionMining: () => { calls.push('mine'); return { ok: true }; },
    log: () => {}
  };
  const result = await new WorkflowEngine([definition]).run(bot, 'safe-mine');
  assert.deepEqual(calls, ['home', 'supply', 'equip', 'mine']);
  assert.deepEqual(result.trace, ['start', 'home', 'pickaxe', 'supply', 'equip', 'mine', 'end']);
});

test('workflow uses error edge when resupply fails', async () => {
  const bot = {
    regionPlan: { home: '_mine' },
    ensureRegionAnchor: async () => {},
    hasUsablePickaxe: () => false,
    maybeResupply: async () => ({ ok: false, message: 'empty stock' }),
    equipRole: () => ({ ok: true }),
    startRegionMining: () => ({ ok: true }),
    log: () => {}
  };
  const result = await new WorkflowEngine([definition]).run(bot, 'safe-mine');
  assert.equal(result.trace.at(-1), 'failed');
  assert.equal(result.values.supply.message, 'empty stock');
});

const typedDefinition = {
  schemaVersion: 2,
  id: 'typed-supply',
  name: 'Typed supply flow',
  settings: { maxSteps: 32, timeoutMs: 10000 },
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'pickaxe', type: 'has_usable_pickaxe' },
    { id: 'find', type: 'find_supply_point', params: { requirePickaxe: true, variable: 'supplyPointId' } },
    { id: 'supply', type: 'resupply_at_point', params: { pointVariable: 'supplyPointId', requirePickaxe: true } },
    { id: 'equip', type: 'equip', params: { role: 'pickaxe' }, retry: { maxAttempts: 2, delayMs: 0 } },
    { id: 'end', type: 'end' },
    { id: 'failed', type: 'end' }
  ],
  edges: [
    { source: 'start', sourceHandle: 'next', target: 'pickaxe' },
    { source: 'pickaxe', sourceHandle: 'false', target: 'find' },
    { source: 'pickaxe', sourceHandle: 'true', target: 'equip' },
    { source: 'find', sourceHandle: 'true', target: 'supply' },
    { source: 'find', sourceHandle: 'false', target: 'failed' },
    { source: 'supply', sourceHandle: 'next', target: 'equip' },
    { source: 'supply', sourceHandle: 'error', target: 'failed' },
    { source: 'equip', sourceHandle: 'next', target: 'end' },
    { source: 'equip', sourceHandle: 'error', target: 'failed' }
  ]
};

test('typed workflow stores a selected supply point in variables and retries a failed node', async () => {
  const calls = [];
  let equipAttempts = 0;
  const bot = {
    hasUsablePickaxe: () => false,
    selectSupplyPoint: () => ({ id: 'pickaxe-home', name: 'Pickaxe Home', home: 'tools' }),
    resupplyAtPoint: async (pointId) => { calls.push(`supply:${pointId}`); return { ok: true, message: 'ready' }; },
    maybeResupply: async () => ({ ok: false, message: 'fallback should not run' }),
    equipRole: () => {
      equipAttempts += 1;
      if (equipAttempts === 1) return { ok: false, message: 'inventory is still syncing' };
      calls.push('equip');
      return { ok: true };
    },
    log: () => {}
  };
  const result = await new WorkflowEngine([typedDefinition]).run(bot, 'typed-supply');
  assert.deepEqual(result.trace, ['start', 'pickaxe', 'find', 'supply', 'equip', 'end']);
  assert.equal(result.variables.supplyPointId, 'pickaxe-home');
  assert.deepEqual(calls, ['supply:pickaxe-home', 'equip']);
  assert.equal(result.traceEntries.find((entry) => entry.nodeId === 'equip').attempts, 2);
});
