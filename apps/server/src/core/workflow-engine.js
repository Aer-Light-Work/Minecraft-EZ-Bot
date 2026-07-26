const { normalizeWorkflows, validateWorkflow } = require('../config/workflow-config');
const { createDefaultWorkflowNodeRegistry, DEFAULT_NODE_TIMEOUT_MS } = require('./workflow-node-registry');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class WorkflowEngine {
  constructor(definitions = [], options = {}) {
    this.registry = options.registry || createDefaultWorkflowNodeRegistry();
    this.definitions = normalizeWorkflows(definitions);
  }

  list() {
    return this.definitions.map((workflow) => ({
      ...workflow,
      variables: { ...workflow.variables },
      settings: { ...workflow.settings },
      nodes: workflow.nodes.map((node) => ({
        ...node,
        position: { ...node.position },
        params: { ...node.params },
        retry: { ...node.retry }
      })),
      edges: workflow.edges.map((edge) => ({ ...edge }))
    }));
  }

  listNodeTypes() {
    return this.registry.list();
  }

  get(id) {
    return this.definitions.find((workflow) => workflow.id === id) || null;
  }

  async run(bot, id, input = {}) {
    const workflow = this.get(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);
    if (workflow.enabled === false) throw new Error(`Workflow ${id} is disabled.`);
    const validation = validateWorkflow(workflow, this.registry);
    if (!validation.valid) throw new Error(`Workflow ${id} is invalid: ${validation.errors.join(' ')}`);

    const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]));
    const outgoing = new Map();
    for (const edge of workflow.edges) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source).push(edge);
    }

    const start = workflow.nodes.find((node) => node.type === 'start');
    let current = start;
    const startedAt = Date.now();
    const deadline = startedAt + workflow.settings.timeoutMs;
    const context = {
      input: { ...input },
      variables: { ...workflow.variables },
      values: {},
      trace: [],
      traceEntries: [],
      workflowId: workflow.id,
      startedAt,
      deadline
    };

    for (let step = 0; current && step < workflow.settings.maxSteps; step += 1) {
      if (Date.now() >= deadline) throw new Error(`Workflow ${id} timed out after ${workflow.settings.timeoutMs}ms.`);
      context.trace.push(current.id);
      const entry = { nodeId: current.id, type: current.type, label: current.label, startedAt: Date.now(), attempts: 0, status: 'running', branch: 'next' };
      context.traceEntries.push(entry);
      let branch = 'next';
      try {
        const outcome = await this.executeNode(bot, current, context, entry);
        context.values[current.id] = outcome.value;
        branch = outcome.branch || 'next';
        entry.branch = branch;
        entry.status = 'completed';
        entry.value = outcome.value;
      } catch (error) {
        context.values[current.id] = { ok: false, message: error.message };
        branch = 'error';
        entry.branch = branch;
        entry.status = 'failed';
        entry.error = error.message;
        const errorEdge = (outgoing.get(current.id) || []).find((edge) => edge.sourceHandle === 'error');
        if (!errorEdge) throw error;
      } finally {
        entry.finishedAt = Date.now();
        entry.durationMs = entry.finishedAt - entry.startedAt;
      }

      const edges = outgoing.get(current.id) || [];
      const edge = edges.find((candidate) => candidate.sourceHandle === branch)
        || (branch !== 'error' ? edges.find((candidate) => candidate.sourceHandle === 'next') : null);
      current = edge ? nodeMap.get(edge.target) : null;
    }

    if (current) throw new Error(`Workflow ${id} exceeded ${workflow.settings.maxSteps} steps; check for a loop without a stop condition.`);
    return {
      ok: true,
      workflowId: id,
      durationMs: Date.now() - startedAt,
      trace: context.trace,
      traceEntries: context.traceEntries,
      values: context.values,
      variables: context.variables,
      warnings: validation.warnings
    };
  }

  async executeNode(bot, node, context, traceEntry = null) {
    const retry = node.retry || { maxAttempts: 1, delayMs: 0 };
    const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1);
    const configuredTimeoutMs = Math.max(100, Number(node.timeoutMs) || DEFAULT_NODE_TIMEOUT_MS);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = context.deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`Workflow ${context.workflowId} timed out before node ${node.id} could finish.`);
      const timeoutMs = Math.min(configuredTimeoutMs, remainingMs);
      if (traceEntry) traceEntry.attempts = attempt;
      try {
        return await withTimeout(
          Promise.resolve(this.registry.execute(bot, node, context)),
          timeoutMs,
          `Workflow node ${node.id}`
        );
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && retry.delayMs > 0) {
          const retryDelayMs = Math.min(retry.delayMs, Math.max(0, context.deadline - Date.now()));
          if (retryDelayMs <= 0) break;
          await delay(retryDelayMs);
        }
      }
    }
    throw lastError || new Error(`Workflow node ${node.id} failed.`);
  }
}

module.exports = { WorkflowEngine };
