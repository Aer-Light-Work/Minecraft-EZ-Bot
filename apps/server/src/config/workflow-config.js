const WORKFLOW_SCHEMA_VERSION = 2;
const WORKFLOW_BRANCHES = new Set(['next', 'true', 'false', 'error']);
const WORKFLOW_NODE_TYPES = new Set([
  'start', 'ensure_mining_home', 'has_usable_pickaxe', 'find_supply_point', 'resupply_at_point', 'resupply',
  'goto_home', 'start_region_mining', 'stop_region_mining', 'equip', 'wait', 'log', 'end'
]);

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeRetry(retry) {
  if (!retry || typeof retry !== 'object') return { maxAttempts: 1, delayMs: 0 };
  return {
    maxAttempts: Math.max(1, Math.min(10, Math.floor(finiteNumber(retry.maxAttempts, 1)))),
    delayMs: Math.max(0, Math.min(60000, finiteNumber(retry.delayMs, 0)))
  };
}

function normalizeWorkflowNode(node, index = 0) {
  if (!node || typeof node !== 'object') return null;
  const id = String(node.id || `node-${index + 1}`).trim();
  const type = String(node.type || '').trim().toLowerCase();
  if (!id || !WORKFLOW_NODE_TYPES.has(type)) return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const position = node.position && typeof node.position === 'object' ? node.position : {};
  return {
    id,
    type,
    label: String(node.label || data.label || id).trim(),
    position: {
      x: finiteNumber(position.x ?? node.x, index * 220),
      y: finiteNumber(position.y ?? node.y, 80)
    },
    params: node.params && typeof node.params === 'object'
      ? { ...node.params }
      : data.params && typeof data.params === 'object' ? { ...data.params } : {},
    retry: normalizeRetry(node.retry || data.retry),
    timeoutMs: Math.max(100, Math.min(120000, finiteNumber(node.timeoutMs ?? data.timeoutMs, 30000)))
  };
}

function normalizeWorkflowEdge(edge, index, nodeIds) {
  if (!edge || typeof edge !== 'object') return null;
  const source = String(edge.source || edge.from || '').trim();
  const target = String(edge.target || edge.to || '').trim();
  const sourceHandle = String(edge.sourceHandle || edge.when || 'next').trim().toLowerCase();
  if (!nodeIds.has(source) || !nodeIds.has(target) || !WORKFLOW_BRANCHES.has(sourceHandle)) return null;
  return {
    id: String(edge.id || `edge-${index + 1}`).trim(),
    source,
    target,
    sourceHandle,
    targetHandle: String(edge.targetHandle || 'exec').trim() || 'exec'
  };
}

function normalizeWorkflow(workflow, index = 0) {
  if (!workflow || typeof workflow !== 'object') return null;
  const id = String(workflow.id || `workflow-${index + 1}`).trim();
  if (!id) return null;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.map(normalizeWorkflowNode).filter(Boolean) : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(workflow.edges)
    ? workflow.edges.map((edge, edgeIndex) => normalizeWorkflowEdge(edge, edgeIndex, nodeIds)).filter(Boolean)
    : [];
  const variables = workflow.variables && typeof workflow.variables === 'object' ? { ...workflow.variables } : {};
  const settings = workflow.settings && typeof workflow.settings === 'object' ? workflow.settings : {};
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: String(workflow.name || id).trim(),
    description: String(workflow.description || '').trim(),
    enabled: workflow.enabled !== false,
    trigger: workflow.trigger && typeof workflow.trigger === 'object' ? { ...workflow.trigger } : { type: 'manual' },
    variables,
    settings: {
      maxSteps: Math.max(1, Math.min(5000, Math.floor(finiteNumber(settings.maxSteps, 256)))),
      timeoutMs: Math.max(1000, Math.min(600000, finiteNumber(settings.timeoutMs, 120000)))
    },
    nodes,
    edges
  };
}

function validateWorkflow(workflow, registry = null) {
  const errors = [];
  const warnings = [];
  if (!workflow) return { valid: false, errors: ['Workflow is empty.'], warnings };
  const nodeIds = new Set();
  for (const node of workflow.nodes || []) {
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const starts = (workflow.nodes || []).filter((node) => node.type === 'start');
  if (!starts.length) errors.push('Workflow requires a start node.');
  if (starts.length > 1) warnings.push('Workflow has multiple start nodes; only the first one will run.');
  const nodeMap = new Map((workflow.nodes || []).map((node) => [node.id, node]));
  if (registry?.get) {
    for (const node of workflow.nodes || []) {
      if (!registry.get(node.type)) errors.push(`Node ${node.id} uses an unregistered type: ${node.type}.`);
    }
  }
  for (const edge of workflow.edges || []) {
    if (!nodeIds.has(edge.source)) errors.push(`Edge ${edge.id} references missing source ${edge.source}.`);
    if (!nodeIds.has(edge.target)) errors.push(`Edge ${edge.id} references missing target ${edge.target}.`);
    if (registry?.get) {
      const sourceDefinition = registry.get(nodeMap.get(edge.source)?.type);
      const targetDefinition = registry.get(nodeMap.get(edge.target)?.type);
      if (sourceDefinition && !sourceDefinition.outputs.some((pin) => pin.id === edge.sourceHandle)) {
        errors.push(`Edge ${edge.id} uses missing output ${edge.sourceHandle} on ${edge.source}.`);
      }
      if (targetDefinition && !targetDefinition.inputs.some((pin) => pin.id === edge.targetHandle)) {
        errors.push(`Edge ${edge.id} uses missing input ${edge.targetHandle} on ${edge.target}.`);
      }
    }
  }
  const connected = new Set((workflow.edges || []).flatMap((edge) => [edge.source, edge.target]));
  for (const node of workflow.nodes || []) {
    if (node.type !== 'start' && node.type !== 'end' && !connected.has(node.id)) warnings.push(`Node ${node.id} is not connected.`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function normalizeWorkflows(value = []) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.workflows) ? value.workflows : [];
  const seen = new Set();
  return list.map(normalizeWorkflow).filter((workflow) => {
    if (!workflow || seen.has(workflow.id)) return false;
    seen.add(workflow.id);
    return workflow.nodes.length > 0;
  });
}

module.exports = {
  normalizeWorkflow,
  normalizeWorkflows,
  normalizeWorkflowNode,
  validateWorkflow,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_BRANCHES,
  WORKFLOW_SCHEMA_VERSION
};
