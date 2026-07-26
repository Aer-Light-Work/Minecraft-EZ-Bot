const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkflow, validateWorkflow } = require('../src/config/workflow-config');
const { createDefaultWorkflowNodeRegistry } = require('../src/core/workflow-node-registry');

test('workflow config migrates legacy coordinates and when branches to schema version 2', () => {
  const workflow = normalizeWorkflow({
    id: 'legacy',
    nodes: [{ id: 'start', type: 'start', x: 12, y: 34 }, { id: 'end', type: 'end', x: 56, y: 78 }],
    edges: [{ source: 'start', target: 'end', when: 'next' }]
  });
  assert.equal(workflow.schemaVersion, 2);
  assert.deepEqual(workflow.nodes[0].position, { x: 12, y: 34 });
  assert.equal(workflow.edges[0].sourceHandle, 'next');
  assert.equal(workflow.edges[0].targetHandle, 'exec');
  assert.equal(validateWorkflow(workflow).valid, true);
});

test('workflow validation rejects a graph without a start node', () => {
  const workflow = normalizeWorkflow({ id: 'invalid', nodes: [{ id: 'end', type: 'end' }], edges: [] });
  const validation = validateWorkflow(workflow);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /start node/);
});

test('workflow validation checks typed source handles', () => {
  const workflow = normalizeWorkflow({
    id: 'bad-handle',
    nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }],
    edges: [{ source: 'start', target: 'end', sourceHandle: 'error' }]
  });
  const validation = validateWorkflow(workflow, createDefaultWorkflowNodeRegistry());
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /missing output error/);
});
