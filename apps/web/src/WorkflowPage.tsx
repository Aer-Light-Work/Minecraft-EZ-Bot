import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  fetchWorkflowNodeTypes,
  fetchWorkflows,
  runWorkflow,
  saveWorkflows,
  type BotStatus,
  type WorkflowBranch,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeDefinition,
  type WorkflowNodeType
} from './api';

type Props = { bots: BotStatus[]; selected?: BotStatus; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> };
type FlowNodeData = { node: WorkflowNode; definition?: WorkflowNodeDefinition };
type WorkflowFlowNode = Node<FlowNodeData, 'workflow'>;

type LegacyNode = Partial<WorkflowNode> & { x?: number; y?: number; data?: { label?: string; params?: Record<string, unknown> } };
type LegacyEdge = Partial<WorkflowEdge> & { when?: WorkflowBranch };

const categoryLabels: Record<string, string> = {
  flow: '流程', navigation: '导航', inventory: '背包', supply: '补给', mining: '挖矿', debug: '调试', other: '其他'
};
const edgeColors: Record<WorkflowBranch, string> = { next: '#4f7f5c', true: '#16a34a', false: '#d97706', error: '#dc2626' };

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'node'; }
function nextNodeId(nodes: WorkflowNode[], type: WorkflowNodeType) {
  const prefix = safeId(type);
  let index = nodes.length + 1;
  while (nodes.some((node) => node.id === `${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}
function defaultParams(definition?: WorkflowNodeDefinition) {
  return Object.fromEntries((definition?.params || []).filter((param) => param.defaultValue !== undefined).map((param) => [param.id, param.defaultValue]));
}
function normalizeImportedWorkflow(value: Partial<WorkflowDefinition>): WorkflowDefinition {
  const nodes = (Array.isArray(value.nodes) ? value.nodes : []).map((raw, index) => {
    const node = raw as LegacyNode;
    return {
      id: String(node.id || `node-${index + 1}`),
      type: String(node.type || 'log') as WorkflowNodeType,
      label: String(node.label || node.data?.label || node.id || `节点 ${index + 1}`),
      position: {
        x: Number(node.position?.x ?? node.x ?? 80 + index * 220),
        y: Number(node.position?.y ?? node.y ?? 120)
      },
      params: { ...(node.params || node.data?.params || {}) },
      retry: { maxAttempts: Number(node.retry?.maxAttempts || 1), delayMs: Number(node.retry?.delayMs || 0) },
      timeoutMs: Number(node.timeoutMs || 30000)
    };
  });
  const edges = (Array.isArray(value.edges) ? value.edges : []).map((raw, index) => {
    const edge = raw as LegacyEdge;
    return {
      id: String(edge.id || `edge-${index + 1}`),
      source: String(edge.source || ''),
      target: String(edge.target || ''),
      sourceHandle: (edge.sourceHandle || edge.when || 'next') as WorkflowBranch,
      targetHandle: String(edge.targetHandle || 'exec')
    };
  });
  return {
    schemaVersion: 2,
    id: String(value.id || `workflow-${Date.now()}`),
    name: String(value.name || '导入的复合技能'),
    description: String(value.description || ''),
    enabled: value.enabled !== false,
    trigger: { type: 'manual', ...(value.trigger || {}) },
    variables: { ...(value.variables || {}) },
    settings: { maxSteps: Number(value.settings?.maxSteps || 256), timeoutMs: Number(value.settings?.timeoutMs || 120000) },
    nodes,
    edges
  };
}

function WorkflowCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const definition = data.definition;
  const outputs = definition?.outputs || [{ id: 'next', type: 'exec', label: '下一步' }];
  const inputs = definition?.inputs || [{ id: 'exec', type: 'exec', label: '执行' }];
  return <div className={`flow-node-card ${selected ? 'selected' : ''}`} style={{ '--node-color': definition?.color || '#64748b' } as React.CSSProperties}>
    {inputs.map((pin, index) => <Handle key={pin.id} id={pin.id} type="target" position={Position.Left} className="flow-handle input" style={{ top: 48 + index * 22 }} title={pin.label} />)}
    <div className="flow-node-category">{categoryLabels[definition?.category || 'other'] || definition?.category || '节点'} · {data.node.type}</div>
    <strong>{data.node.label}</strong>
    <small>{definition?.description || data.node.id}</small>
    <div className="flow-node-outputs">
      {outputs.map((pin) => <span key={pin.id} style={{ color: edgeColors[pin.id as WorkflowBranch] || definition?.color }}>{pin.label}</span>)}
    </div>
    {outputs.map((pin, index) => <Handle key={pin.id} id={pin.id} type="source" position={Position.Right} className={`flow-handle output ${pin.id}`} style={{ top: 48 + index * 22, background: edgeColors[pin.id as WorkflowBranch] || definition?.color }} title={pin.label} />)}
  </div>;
}

const nodeTypes = { workflow: WorkflowCard };

function WorkflowCanvas({
  workflow,
  definitions,
  selectedNodeId,
  onSelectNode,
  onMoveNode,
  onConnectNodes,
  onDeleteNodes,
  onDeleteEdges,
  onAddNode
}: {
  workflow: WorkflowDefinition;
  definitions: Map<string, WorkflowNodeDefinition>;
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
  onMoveNode: (id: string, position: { x: number; y: number }) => void;
  onConnectNodes: (connection: Connection) => void;
  onDeleteNodes: (ids: string[]) => void;
  onDeleteEdges: (ids: string[]) => void;
  onAddNode: (type: WorkflowNodeType, position: { x: number; y: number }) => void;
}) {
  const reactFlow = useReactFlow();
  const nodes = useMemo<WorkflowFlowNode[]>(() => workflow.nodes.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: node.position,
    selected: node.id === selectedNodeId,
    data: { node, definition: definitions.get(node.type) }
  })), [workflow.nodes, definitions, selectedNodeId]);
  const edges = useMemo<Edge[]>(() => workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.sourceHandle,
    animated: edge.sourceHandle === 'error',
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[edge.sourceHandle] },
    style: { stroke: edgeColors[edge.sourceHandle], strokeWidth: 2 },
    labelStyle: { fill: edgeColors[edge.sourceHandle], fontSize: 10, fontWeight: 700 }
  })), [workflow.edges]);

  const onNodesChange = useCallback<OnNodesChange<WorkflowFlowNode>>((changes) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) onMoveNode(change.id, change.position);
      if (change.type === 'select' && change.selected) onSelectNode(change.id);
      if (change.type === 'remove') onDeleteNodes([change.id]);
    }
  }, [onDeleteNodes, onMoveNode, onSelectNode]);
  const onEdgesChange = useCallback<OnEdgesChange>((changes) => {
    const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id);
    if (removed.length) onDeleteEdges(removed);
  }, [onDeleteEdges]);
  function dropNode(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const type = event.dataTransfer.getData('workflow-node') as WorkflowNodeType;
    if (!type) return;
    onAddNode(type, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  return <div className="workflow-canvas" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropNode}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnectNodes}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      deleteKeyCode={['Backspace', 'Delete']}
      snapToGrid
      snapGrid={[20, 20]}
      connectionRadius={40}
    >
      <Background gap={20} size={1} color="#bad5bf" />
      <MiniMap pannable zoomable nodeColor={(node) => definitions.get((node.data as FlowNodeData).node.type)?.color || '#64748b'} />
      <Controls />
    </ReactFlow>
  </div>;
}

export function WorkflowPage({ bots, selected, run }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [nodeDefinitions, setNodeDefinitions] = useState<WorkflowNodeDefinition[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [botId, setBotId] = useState(selected?.id || bots[0]?.id || '');
  const [trace, setTrace] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    Promise.all([fetchWorkflows(), fetchWorkflowNodeTypes()]).then(([items, definitions]) => {
      setWorkflows(items.map(normalizeImportedWorkflow));
      setNodeDefinitions(definitions);
      setSelectedId(items[0]?.id || '');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '工作流加载失败'));
  }, []);
  const workflow = useMemo(() => workflows.find((item) => item.id === selectedId), [workflows, selectedId]);
  const definitions = useMemo(() => new Map(nodeDefinitions.map((definition) => [definition.type, definition])), [nodeDefinitions]);
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId);
  const selectedDefinition = selectedNode ? definitions.get(selectedNode.type) : undefined;
  const groupedDefinitions = useMemo(() => Object.entries(nodeDefinitions.reduce<Record<string, WorkflowNodeDefinition[]>>((groups, definition) => {
    (groups[definition.category] ||= []).push(definition);
    return groups;
  }, {})), [nodeDefinitions]);

  useEffect(() => { if (workflow) setJson(JSON.stringify(workflow, null, 2)); }, [workflow]);
  useEffect(() => { if (workflow) setSelectedNodeId((current) => workflow.nodes.some((node) => node.id === current) ? current : workflow.nodes[0]?.id || ''); }, [workflow?.id, workflow?.nodes]);
  useEffect(() => { if (!botId && (selected?.id || bots[0]?.id)) setBotId(selected?.id || bots[0]?.id || ''); }, [botId, bots, selected?.id]);

  function updateWorkflow(mutator: (next: WorkflowDefinition) => void) {
    if (!workflow) return;
    const next = clone(workflow);
    mutator(next);
    setWorkflows((current) => current.map((item) => item.id === next.id ? next : item));
  }
  function addWorkflow() {
    const id = `workflow-${workflows.length + 1}`;
    const item: WorkflowDefinition = {
      schemaVersion: 2, id, name: '新复合技能', description: '由可视化节点拼装的 Mineflayer 工作流', enabled: true,
      trigger: { type: 'manual' }, variables: {}, settings: { maxSteps: 256, timeoutMs: 120000 },
      nodes: [
        { id: 'start', type: 'start', label: '开始', position: { x: 40, y: 120 }, params: {}, retry: { maxAttempts: 1, delayMs: 0 }, timeoutMs: 30000 },
        { id: 'end', type: 'end', label: '结束', position: { x: 360, y: 120 }, params: {}, retry: { maxAttempts: 1, delayMs: 0 }, timeoutMs: 30000 }
      ],
      edges: [{ id: 'edge-1', source: 'start', sourceHandle: 'next', target: 'end', targetHandle: 'exec' }]
    };
    setWorkflows((current) => [...current, item]);
    setSelectedId(id);
    setSelectedNodeId('start');
  }
  const addNode = useCallback((type: WorkflowNodeType, position?: { x: number; y: number }) => {
    if (!workflow || type === 'start') return;
    const definition = definitions.get(type);
    const node: WorkflowNode = {
      id: nextNodeId(workflow.nodes, type), type, label: definition?.label || type,
      position: position || { x: 160 + workflow.nodes.length * 28, y: 180 + (workflow.nodes.length % 3) * 100 },
      params: defaultParams(definition), retry: { maxAttempts: 1, delayMs: 0 }, timeoutMs: 30000
    };
    updateWorkflow((next) => next.nodes.push(node));
    setSelectedNodeId(node.id);
  }, [definitions, workflow]);
  const moveNode = useCallback((id: string, position: { x: number; y: number }) => updateWorkflow((next) => {
    const node = next.nodes.find((item) => item.id === id);
    if (node) node.position = position;
  }), [workflow]);
  const connectNodes = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const sourceHandle = (connection.sourceHandle || 'next') as WorkflowBranch;
    updateWorkflow((next) => {
      const flowEdges: Edge[] = next.edges.map((edge) => ({ ...edge }));
      const added = addEdge({ ...connection, sourceHandle, targetHandle: connection.targetHandle || 'exec' }, flowEdges);
      next.edges = added.map((edge, index) => ({
        id: edge.id || `edge-${Date.now()}-${index}`,
        source: edge.source,
        target: edge.target,
        sourceHandle: (edge.sourceHandle || 'next') as WorkflowBranch,
        targetHandle: edge.targetHandle || 'exec'
      }));
    });
  }, [workflow]);
  const deleteNodes = useCallback((ids: string[]) => updateWorkflow((next) => {
    const removed = new Set(ids.filter((id) => next.nodes.find((node) => node.id === id)?.type !== 'start'));
    next.nodes = next.nodes.filter((node) => !removed.has(node.id));
    next.edges = next.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  }), [workflow]);
  const deleteEdges = useCallback((ids: string[]) => updateWorkflow((next) => { next.edges = next.edges.filter((edge) => !ids.includes(edge.id)); }), [workflow]);

  async function save() {
    setError('');
    let saved: WorkflowDefinition[] | undefined;
    await run(async () => {
      const response = await saveWorkflows(workflows);
      saved = response.workflows;
      return response;
    }, false);
    if (saved) setWorkflows(saved.map(normalizeImportedWorkflow));
  }
  async function executeCurrent() {
    if (!workflow) {
      setError('没有可运行的工作流，请先加载或新建一个工作流。');
      return;
    }
    if (!botId) {
      setError('没有可用的机器人，请先在机器人管理中添加并启动机器人。');
      return;
    }
    setError('');
    setTrace([]);
    setRunning(true);
    try {
      const response = await run(async () => runWorkflow(botId, workflow.id), true) as Awaited<ReturnType<typeof runWorkflow>> | undefined;
      if (response?.ok === false) setError(response.message || '工作流运行失败');
      setTrace(response?.result?.trace || []);
    } finally {
      setRunning(false);
    }
  }
  function importJson() {
    try {
      const parsed = normalizeImportedWorkflow(JSON.parse(json) as Partial<WorkflowDefinition>);
      setWorkflows((current) => current.some((item) => item.id === parsed.id) ? current.map((item) => item.id === parsed.id ? parsed : item) : [...current, parsed]);
      setSelectedId(parsed.id);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'JSON 无法解析'); }
  }
  function updateParam(id: string, value: unknown) {
    if (!selectedNode) return;
    updateWorkflow((next) => { const node = next.nodes.find((item) => item.id === selectedNode.id); if (node) node.params[id] = value; });
  }

  return <section className="workflow-page">
    <div className="page-heading compact"><div><span className="eyebrow">COMPOSITE SKILLS / TYPED NODE GRAPH</span><h1>复合技能工作流</h1><p>像搭积木一样组合 Home、补给、装备和区域挖矿。端口直接表示 next / true / false / error 分支，保存为可复用 JSON。</p></div><div className="heading-buttons"><button className="secondary" onClick={addWorkflow}>＋ 新建工作流</button><button className="primary" onClick={save}>保存 JSON</button></div></div>
    {error && <p className="form-error">{error}</p>}
    <div className="workflow-toolbar">
      <label>当前工作流<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>运行机器人<select value={botId} onChange={(event) => setBotId(event.target.value)} disabled={!bots.length}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select></label>
      <button type="button" className="secondary" disabled={running} title={!bots.length ? '没有可用机器人' : !workflow ? '没有可运行工作流' : !botId ? '请选择机器人' : undefined} onClick={() => void executeCurrent}>{running ? '⏳ 工作流运行中…' : '▶ 运行当前工作流'}</button>
      {!bots.length && <span className="workflow-run-hint">当前没有机器人运行时，请先添加机器人并启动控制服务。</span>}
      {trace.length > 0 && <span className="workflow-trace-summary">执行轨迹：{trace.join(' → ')}</span>}
    </div>
    {workflow ? <div className="workflow-layout">
      <aside className="workflow-palette"><strong>节点积木</strong><small>拖到画布，端口之间直接连线</small>{groupedDefinitions.map(([category, items]) => <div className="workflow-palette-group" key={category}><b>{categoryLabels[category] || category}</b>{items.filter((item) => item.type !== 'start').map((item) => <button key={item.type} draggable onDragStart={(event) => { event.dataTransfer.setData('workflow-node', item.type); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addNode(item.type)} style={{ '--node-color': item.color } as React.CSSProperties}><span className="palette-dot" />{item.label}<small>{item.description}</small></button>)}</div>)}</aside>
      <ReactFlowProvider><WorkflowCanvas workflow={workflow} definitions={definitions} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onMoveNode={moveNode} onConnectNodes={connectNodes} onDeleteNodes={deleteNodes} onDeleteEdges={deleteEdges} onAddNode={addNode} /></ReactFlowProvider>
      <aside className="workflow-inspector">
        <strong>工作流</strong>
        <label>名称<input value={workflow.name} onChange={(event) => updateWorkflow((next) => { next.name = event.target.value; })} /></label>
        <label>最大步骤<input type="number" min="1" max="5000" value={workflow.settings.maxSteps} onChange={(event) => updateWorkflow((next) => { next.settings.maxSteps = Number(event.target.value); })} /></label>
        <label>总超时 ms<input type="number" min="1000" max="600000" value={workflow.settings.timeoutMs} onChange={(event) => updateWorkflow((next) => { next.settings.timeoutMs = Number(event.target.value); })} /></label>
        <strong>节点属性</strong>
        {selectedNode ? <>
          <span className="workflow-node-badge" style={{ background: selectedDefinition?.color }}>{selectedDefinition?.label || selectedNode.type}</span>
          <label>显示名称<input value={selectedNode.label} onChange={(event) => updateWorkflow((next) => { const node = next.nodes.find((item) => item.id === selectedNode.id); if (node) node.label = event.target.value; })} /></label>
          {(selectedDefinition?.params || []).map((param) => <label key={param.id}>{param.label}{param.type === 'boolean'
            ? <input type="checkbox" checked={Boolean(selectedNode.params[param.id] ?? param.defaultValue)} onChange={(event) => updateParam(param.id, event.target.checked)} />
            : param.type === 'select'
              ? <select value={String(selectedNode.params[param.id] ?? param.defaultValue ?? '')} onChange={(event) => updateParam(param.id, event.target.value)}>{(param.options || []).map((option) => <option key={option} value={option}>{option}</option>)}</select>
              : <input type={param.type === 'number' ? 'number' : 'text'} min={param.min} max={param.max} value={String(selectedNode.params[param.id] ?? param.defaultValue ?? '')} onChange={(event) => updateParam(param.id, param.type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>)}
          <div className="workflow-retry-grid"><label>重试次数<input type="number" min="1" max="10" value={selectedNode.retry.maxAttempts} onChange={(event) => updateWorkflow((next) => { const node = next.nodes.find((item) => item.id === selectedNode.id); if (node) node.retry.maxAttempts = Number(event.target.value); })} /></label><label>间隔 ms<input type="number" min="0" max="60000" value={selectedNode.retry.delayMs} onChange={(event) => updateWorkflow((next) => { const node = next.nodes.find((item) => item.id === selectedNode.id); if (node) node.retry.delayMs = Number(event.target.value); })} /></label></div>
          <label>节点超时 ms<input type="number" min="100" max="120000" value={selectedNode.timeoutMs} onChange={(event) => updateWorkflow((next) => { const node = next.nodes.find((item) => item.id === selectedNode.id); if (node) node.timeoutMs = Number(event.target.value); })} /></label>
          {selectedNode.type !== 'start' && <button className="danger-button" onClick={() => deleteNodes([selectedNode.id])}>删除节点</button>}
        </> : <small>选择一个节点查看参数。</small>}
        <strong>JSON 导入 / 导出</strong>
        <textarea className="workflow-json" value={json} onChange={(event) => setJson(event.target.value)} />
        <button className="secondary" onClick={importJson}>从 JSON 导入当前图</button>
      </aside>
    </div> : <div className="empty-state"><h2>还没有工作流</h2><p>点击“新建工作流”，或从 JSON 导入一个复合技能。</p></div>}
  </section>;
}
