import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  batchAction,
  botAction,
  createBot,
  configureRegion,
  configureSupply,
  configureHomeTargets,
  setHomeTarget,
  copySkills,
  deleteBot,
  fetchBots,
  fetchConfig,
  fetchLogs,
  fetchWhitelist,
  saveWhitelist,
  sendCommand,
  setViewerPerspective,
  updateBot,
  updateSkills,
  type BotDefinition,
  type BotStatus,
  type SkillOverview,
  type SkillKey,
  type SkillSettings,
  type SupplyPoint,
  type HomeTarget,
  type SupplyRole,
  type LogEntry,
  type WebConfig
} from './api';
import { WorkflowPage } from './WorkflowPage';

type View = 'overview' | 'bots' | 'skills' | 'workflows' | 'detail';
type BotForm = {
  id: string;
  displayName: string;
  skinUsername: string;
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  auth: string;
  version: string;
  viewerEnabled: boolean;
  viewerPort: string;
  viewerDistance: string;
  firstPerson: boolean;
};

const quickCommands = [
  { label: '状态', command: 'status' },
  { label: '停止动作', command: 'stop' },
  { label: '攻击 ON', command: 'kill on' },
  { label: '攻击 OFF', command: 'kill off' },
  { label: '开始钓鱼', command: 'fish' },
  { label: '采集矿石', command: 'mine ores 8' },
  { label: '补给 ON', command: 'supply on' },
  { label: '回主家', command: 'home' }
];

const skills = [
  { icon: '⚔', name: '基础战斗', key: 'combat', description: '自动装备武器、锁定附近敌对生物并进行定点攻击。', capabilities: ['敌对生物筛选', '低血自动停战', '与补给并行'], commands: ['kill on', 'kill off', 'stop'], status: '已启用' },
  { icon: '⌁', name: '自动钓鱼', key: 'fishing', description: '寻找鱼竿并进入持续钓鱼循环，适合挂机收集食物与经验。', capabilities: ['自动抛竿', '自动收杆', '任务锁协调'], commands: ['fish', 'stop'], status: '已启用' },
  { icon: '◎', name: '跟随与导航', key: 'pathfinder', description: '跟随指定玩家、使用服务器 Home，并避开不可行走区域。', capabilities: ['玩家跟随', 'Home 传送', '安全寻路'], commands: ['follow <玩家>', 'come <玩家>', 'home <名称>'], status: '已启用' },
  { icon: '▣', name: '聊天指令', key: 'chat-command', description: '按机器人独立白名单接收游戏内指令，默认拒绝陌生玩家。', capabilities: ['独立白名单', '目标机器人解析', '指令审计'], commands: ['status', 'info on/off'], status: '安全策略' },
  { icon: '⛏', name: '区域清空与资源采集', key: 'mining', description: '清空指定长方体区域，先建立稳定挖矿 Home，再使用可视化黑白名单控制方块，并保护容器、流体与关键设施。', capabilities: ['区域断点扫描', '稳定挖矿锚点', '流体安全封堵', '工具缺失自动补给'], commands: ['网页设置区域', 'area on', 'area off', 'unseal'], status: '已启用' },
  { icon: '◈', name: 'Home 补给、生存与仓储', key: 'supply', description: '用固定 Home 完成食物、镐子、睡觉和矿物存储；首次访问 Home 会自动记录位置并显示在 Home 列表。', capabilities: ['食物与镐子补给', '夜间自动睡觉', '多容器卸货', '稳定挖矿 Home 回程', '缺料游戏内告警'], commands: ['网页配置 Home', 'supply on', 'equip auto'], status: '已启用' },
  { icon: '✦', name: 'OpenAI 工具链（预留）', key: 'openai-tools', description: '为未来的自然语言对话准备工具声明与执行边界，当前不会调用模型。', capabilities: ['工具 Schema', '审批边界', '暂不调用模型'], commands: ['tool schema', 'approval gate'], status: '规划中' }
];

type MiningBlock = { id: string; name: string; category: '矿石' | '地形' | '自然' | '建筑' | '永久保护'; tone: string; protected?: boolean };

const miningBlocks: MiningBlock[] = [
  { id: 'coal_ore', name: '煤矿石', category: '矿石', tone: '#4b4b46' }, { id: 'deepslate_coal_ore', name: '深层煤矿石', category: '矿石', tone: '#353a3b' },
  { id: 'iron_ore', name: '铁矿石', category: '矿石', tone: '#c7a58b' }, { id: 'deepslate_iron_ore', name: '深层铁矿石', category: '矿石', tone: '#8f7568' },
  { id: 'copper_ore', name: '铜矿石', category: '矿石', tone: '#b96f52' }, { id: 'deepslate_copper_ore', name: '深层铜矿石', category: '矿石', tone: '#7c594f' },
  { id: 'gold_ore', name: '金矿石', category: '矿石', tone: '#e5c84b' }, { id: 'deepslate_gold_ore', name: '深层金矿石', category: '矿石', tone: '#9b8848' },
  { id: 'redstone_ore', name: '红石矿石', category: '矿石', tone: '#c43d37' }, { id: 'deepslate_redstone_ore', name: '深层红石矿石', category: '矿石', tone: '#7f3334' },
  { id: 'lapis_ore', name: '青金石矿石', category: '矿石', tone: '#386ac7' }, { id: 'deepslate_lapis_ore', name: '深层青金石矿石', category: '矿石', tone: '#344d83' },
  { id: 'diamond_ore', name: '钻石矿石', category: '矿石', tone: '#52cbd0' }, { id: 'deepslate_diamond_ore', name: '深层钻石矿石', category: '矿石', tone: '#397d81' },
  { id: 'emerald_ore', name: '绿宝石矿石', category: '矿石', tone: '#43b864' }, { id: 'deepslate_emerald_ore', name: '深层绿宝石矿石', category: '矿石', tone: '#39744c' },
  { id: 'nether_gold_ore', name: '下界金矿石', category: '矿石', tone: '#b75f42' }, { id: 'nether_quartz_ore', name: '下界石英矿石', category: '矿石', tone: '#eadbd0' }, { id: 'ancient_debris', name: '远古残骸', category: '矿石', tone: '#65433d' },
  { id: 'stone', name: '石头', category: '地形', tone: '#888b88' }, { id: 'deepslate', name: '深板岩', category: '地形', tone: '#4e5353' }, { id: 'tuff', name: '凝灰岩', category: '地形', tone: '#6f766f' },
  { id: 'granite', name: '花岗岩', category: '地形', tone: '#a56d5a' }, { id: 'diorite', name: '闪长岩', category: '地形', tone: '#c8c8c3' }, { id: 'andesite', name: '安山岩', category: '地形', tone: '#8b8d8c' },
  { id: 'dirt', name: '泥土', category: '地形', tone: '#79543a' }, { id: 'grass_block', name: '草方块', category: '地形', tone: '#63a348' }, { id: 'gravel', name: '沙砾', category: '地形', tone: '#7d7875' },
  { id: 'sand', name: '沙子', category: '地形', tone: '#d8c886' }, { id: 'sandstone', name: '砂岩', category: '地形', tone: '#d4c27e' }, { id: 'netherrack', name: '下界岩', category: '地形', tone: '#7d3838' }, { id: 'end_stone', name: '末地石', category: '地形', tone: '#d8d79b' },
  { id: 'oak_log', name: '橡木原木', category: '自然', tone: '#8a693f' }, { id: 'spruce_log', name: '云杉原木', category: '自然', tone: '#5f432b' }, { id: 'clay', name: '黏土块', category: '自然', tone: '#a3a9b3' }, { id: 'mud', name: '泥巴', category: '自然', tone: '#4d4a47' },
  { id: 'cobblestone', name: '圆石', category: '建筑', tone: '#707370' }, { id: 'stone_bricks', name: '石砖', category: '建筑', tone: '#777b77' }, { id: 'oak_planks', name: '橡木木板', category: '建筑', tone: '#b58a51' },
  { id: 'chest', name: '箱子', category: '永久保护', tone: '#b27a32', protected: true }, { id: 'barrel', name: '木桶', category: '永久保护', tone: '#8d6035', protected: true },
  { id: 'shulker_box', name: '潜影盒', category: '永久保护', tone: '#956f9d', protected: true }, { id: 'bedrock', name: '基岩', category: '永久保护', tone: '#303331', protected: true },
  { id: 'water', name: '水', category: '永久保护', tone: '#3b75d6', protected: true }, { id: 'lava', name: '岩浆', category: '永久保护', tone: '#e66b22', protected: true },
  { id: 'spawner', name: '刷怪笼', category: '永久保护', tone: '#27312c', protected: true }, { id: 'end_portal_frame', name: '末地传送门框架', category: '永久保护', tone: '#536d54', protected: true }
];

const supplyRoleLabels: Record<SupplyRole, string> = { food: '食物补给', pickaxe: '镐子补给', sleep: '夜间睡觉', storage: '矿物存储' };

const emptyForm: BotForm = {
  id: '', displayName: '', skinUsername: '', enabled: true, host: '', port: '25565', username: '', auth: 'microsoft', version: '',
  viewerEnabled: true, viewerPort: '', viewerDistance: '6', firstPerson: false
};

function definitionToForm(bot: BotDefinition): BotForm {
  return {
    id: bot.id, displayName: bot.displayName, skinUsername: bot.skinUsername || '', enabled: bot.enabled, host: bot.host, port: String(bot.port),
    username: bot.username, auth: bot.auth || 'microsoft', version: bot.version || '', viewerEnabled: bot.viewer.enabled,
    viewerPort: bot.viewer.port ? String(bot.viewer.port) : '', viewerDistance: String(bot.viewer.viewDistance || 6), firstPerson: bot.viewer.firstPerson
  };
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function stateLabel(state: BotStatus['state']) {
  return ({ online: '在线', connecting: '连接中', reconnecting: '重连中', error: '异常', stopped: '已停止' })[state];
}

function dimensionLabel(dimension: string | null | undefined) {
  const value = String(dimension || '').toLowerCase();
  if (value.includes('nether')) return '下界 · Nether';
  if (value.includes('end')) return '末地 · The End';
  if (value.includes('overworld')) return '主世界 · Overworld';
  return dimension || '未知维度';
}

function taskLabel(bot: BotStatus) {
  if (bot.regionMining) return '区域挖矿中';
  if (bot.mining) return '挖矿采集中';
  if (bot.supply) return '补给管理中';
  if (bot.killAura) return '战斗模式';
  if (bot.fishing) return '自动钓鱼';
  return bot.state === 'online' ? '空闲待命' : stateLabel(bot.state);
}

function taskIcon(bot: BotStatus) {
  if (bot.regionMining) return '▦';
  if (bot.mining) return '⛏';
  if (bot.supply) return '◈';
  if (bot.killAura) return '⚔';
  if (bot.fishing) return '⌁';
  return '◌';
}

function skinIdentifier(bot: BotStatus) {
  return bot.skinIdentifier || bot.username || bot.id;
}

function skinUrl(bot: BotStatus, kind: 'avatar' | 'body', size: number) {
  const local = kind === 'avatar' ? bot.skin?.avatarUrl : bot.skin?.bodyUrl;
  if (local) return `${local}?v=${encodeURIComponent(bot.skin?.cachedAt || skinIdentifier(bot))}`;
  return `https://mc-heads.net/${kind}/${encodeURIComponent(skinIdentifier(bot))}/${size}`;
}

function BotFace({ bot, size = 'small' }: { bot: BotStatus; size?: 'tiny' | 'small' | 'medium' }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`bot-avatar bot-face ${size} bot-face-fallback`}>{bot.displayName.slice(0, 1).toUpperCase()}</span>;
  return <img className={`bot-avatar bot-face ${size}`} src={skinUrl(bot, 'avatar', size === 'tiny' ? 32 : 64)} alt={`${bot.displayName} 玩家皮肤`} onError={() => setFailed(true)} />;
}

function SkinModel({ bot }: { bot: BotStatus }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="skin-model-fallback"><BotFace bot={bot} size="medium" /><span>未找到皮肤模型</span></div>;
  return <img className="skin-render" src={skinUrl(bot, 'body', 260)} alt={`${bot.displayName} Minecraft 玩家模型`} onError={() => setFailed(true)} />;
}

function App() {
  const [view, setView] = useState<View>('overview');
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [definitions, setDefinitions] = useState<BotDefinition[]>([]);
  const [webConfig, setWebConfig] = useState<WebConfig | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [editorMode, setEditorMode] = useState<'add' | 'edit' | null>(null);
  const [form, setForm] = useState<BotForm>(emptyForm);
  const [previewMode, setPreviewMode] = useState<'status' | 'viewer'>('status');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [skillOverview, setSkillOverview] = useState<SkillOverview | null>(null);
  const [skillModalKey, setSkillModalKey] = useState<string | null>(null);

  const selected = useMemo(() => bots.find((bot) => bot.id === selectedId) || bots[0], [bots, selectedId]);
  const selectedDefinition = useMemo(() => definitions.find((bot) => bot.id === selected?.id), [definitions, selected?.id]);
  const onlineCount = bots.filter((bot) => bot.state === 'online').length;
  const activeCount = bots.filter((bot) => bot.state === 'online' || bot.state === 'connecting' || bot.state === 'reconnecting').length;

  const refreshRuntime = useCallback(async () => {
    try {
      const [nextBots, nextLogs] = await Promise.all([fetchBots(), fetchLogs()]);
      setBots(nextBots);
      setLogs(nextLogs);
      if (!selectedId && nextBots[0]) setSelectedId(nextBots[0].id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法连接控制服务');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const refreshConfig = useCallback(async () => {
    const [config, nextWhitelist] = await Promise.all([fetchConfig(), fetchWhitelist(selectedId || undefined)]);
    setDefinitions(config.bots);
    setWebConfig(config.web);
    setWhitelist(nextWhitelist);
    setSkillOverview(config.skills || null);
  }, [selectedId]);

  useEffect(() => {
    refreshRuntime();
    refreshConfig().catch((error) => setNotice(error instanceof Error ? error.message : '配置加载失败'));
    const timer = window.setInterval(refreshRuntime, 2500);
    return () => window.clearInterval(timer);
  }, [refreshRuntime, refreshConfig]);

  async function run(action: () => Promise<unknown>, refreshDefinitions = false) {
    try {
      const result = await action() as { message?: string; results?: Array<{ ok: boolean }> };
      const failed = result.results?.filter((entry) => !entry.ok).length || 0;
      setNotice(failed ? `操作完成，但有 ${failed} 个机器人失败` : result.message || '操作完成');
      await refreshRuntime();
      if (refreshDefinitions) await refreshConfig();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败';
      setNotice(message);
      return { ok: false, message };
    }
  }

  function selectBot(id: string) {
    setSelectedId(id);
    setView('detail');
  }

  function openAdd() { setForm(emptyForm); setEditorMode('add'); }
  function openEdit() { if (selectedDefinition) { setForm(definitionToForm(selectedDefinition)); setEditorMode('edit'); } }
  function updateForm<K extends keyof BotForm>(key: K, value: BotForm[K]) { setForm((current) => ({ ...current, [key]: value })); }

  async function submitBot(event: FormEvent) {
    event.preventDefault();
    const payload = {
      id: form.id.trim(), displayName: form.displayName.trim() || form.id.trim(), skinUsername: form.skinUsername.trim() || undefined, enabled: form.enabled,
      host: form.host.trim(), port: Number(form.port), username: form.username.trim(), auth: form.auth,
      version: form.version.trim() || undefined,
      viewer: { enabled: form.viewerEnabled, port: form.viewerPort ? Number(form.viewerPort) : undefined, viewDistance: Number(form.viewerDistance) || 6, firstPerson: form.firstPerson }
    };
    await run(() => editorMode === 'edit' && selected ? updateBot(selected.id, payload) : createBot(payload), true);
    setEditorMode(null);
    if (editorMode === 'add') setSelectedId(payload.id);
  }

  async function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!selected || !command.trim()) return;
    const text = command.trim();
    setCommand('');
    await run(() => sendCommand(selected.id, text));
  }

  async function saveSelectedWhitelist(names: string[] = whitelist) {
    if (!selected) return;
    setWhitelist(names);
    await run(() => saveWhitelist(names, selected.id), true);
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  const viewerUrl = selected?.viewerPort ? `http://${window.location.hostname}:${selected.viewerPort}` : '';

  return (
    <main className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">✦</div><div><strong>MC BOT</strong><span>CONTROL CENTER</span></div><button className="sidebar-toggle" title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} onClick={() => setSidebarCollapsed((current) => !current)}>{sidebarCollapsed ? '›' : '‹'}</button></div>
        <div className="workspace-switch"><span className="server-orb" /><div><small>当前工作区</small><strong>自托管服务器</strong></div><span className="chevron">⌄</span></div>
        <nav className="sidebar-nav">
          <p className="nav-caption">工作台</p>
          <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => setView('overview')}><Icon>⌂</Icon>总览<span className="nav-shortcut">01</span></button>
          <button className={view === 'bots' ? 'nav-item active' : 'nav-item'} onClick={() => setView('bots')}><Icon>♟</Icon>机器人管理<span className="nav-count">{bots.length}</span></button>
          <button className={view === 'skills' ? 'nav-item active' : 'nav-item'} onClick={() => setView('skills')}><Icon>✦</Icon>技能中心<span className="nav-shortcut">03</span></button>
          <button className={view === 'workflows' ? 'nav-item active' : 'nav-item'} onClick={() => setView('workflows')}><Icon>⌘</Icon>复合工作流<span className="nav-shortcut">04</span></button>
          <button className={view === 'detail' ? 'nav-item active' : 'nav-item'} onClick={() => setView('detail')} disabled={!selected}><Icon>▣</Icon>详情预览<span className="nav-shortcut">04</span></button>

        </nav>
        <div className="sidebar-bots"><div className="sidebar-bots-title"><span>运行中的机器人</span><button onClick={() => setView('bots')}>全部</button></div>{bots.slice(0, 6).map((bot) => <button className="mini-bot" key={bot.id} onClick={() => selectBot(bot.id)}><span className={`state-dot state-${bot.state}`} /><BotFace bot={bot} size="tiny" /><span className="mini-bot-copy"><strong>{bot.displayName}</strong><small>{taskLabel(bot)}</small></span><b>›</b></button>)}{bots.length > 6 && <button className="sidebar-more" onClick={() => setView('bots')}>＋ {bots.length - 6} 个机器人 →</button>}</div>
        <div className="sidebar-footer"><div className="user-avatar">A</div><div><strong>管理员</strong><small>本地控制台</small></div><span className="more">•••</span></div>
      </aside>

      <section className="content-shell">
        <header className="topbar"><div className="breadcrumbs"><span>MC BOT</span><b>/</b><strong>{view === 'overview' ? '总览' : view === 'bots' ? '机器人管理' : view === 'skills' ? '技能中心' : view === 'workflows' ? '复合工作流' : '详情预览'}</strong></div><div className="topbar-tools"><div className="connection-indicator"><span className="pulse" />{loading ? '连接中…' : '控制服务正常'}</div><button className="icon-button" title="刷新" onClick={refreshRuntime}>↻</button><button className="primary top-action" onClick={openAdd}>＋ 添加机器人</button></div></header>
        {notice && <button className="notice" onClick={() => setNotice('')}><span>✓</span>{notice}<b>×</b></button>}
        <div className="page-content">
          {view === 'overview' && <Overview bots={bots} onlineCount={onlineCount} activeCount={activeCount} selected={selected} selectBot={selectBot} setView={setView} logs={logs} webConfig={webConfig} />}
          {view === 'bots' && <BotManagement bots={bots} selectedIds={selectedIds} toggleSelection={toggleSelection} selectAll={() => setSelectedIds(selectedIds.length === bots.length ? [] : bots.map((bot) => bot.id))} setSelectedIds={setSelectedIds} run={run} openAdd={openAdd} openEdit={openEdit} selected={selected} deleteBot={deleteBot} setSelectedId={setSelectedId} whitelist={whitelist} saveWhitelist={saveSelectedWhitelist} />}
          {view === 'skills' && <SkillsPage bots={bots} selected={selected} skillOverview={skillOverview} onOpenSkill={setSkillModalKey} run={run} />}
          {view === 'workflows' && <WorkflowPage bots={bots} selected={selected} run={run} />}
          {view === 'detail' && selected && <DetailPage bots={bots} onSelectBot={setSelectedId} selected={selected} selectedDefinition={selectedDefinition} logs={logs.filter((log) => log.botId === selected.id)} command={command} setCommand={setCommand} submitCommand={submitCommand} run={run} previewMode={previewMode} setPreviewMode={setPreviewMode} viewerUrl={viewerUrl} openEdit={openEdit} />}
          {view === 'detail' && !selected && <EmptyState openAdd={openAdd} />}
        </div>
      </section>
      {editorMode && <BotEditor editorMode={editorMode} setEditorMode={setEditorMode} form={form} updateForm={updateForm} submitBot={submitBot} />}
      {skillModalKey && <SkillGuideModal skill={skills.find((skill) => skill.key === skillModalKey) || skills[0]} bots={bots} selected={selected} run={run} onClose={() => setSkillModalKey(null)} />}
    </main>
  );
}

function Overview({ bots, onlineCount, activeCount, selected, selectBot, setView, logs, webConfig }: { bots: BotStatus[]; onlineCount: number; activeCount: number; selected?: BotStatus; selectBot: (id: string) => void; setView: (view: View) => void; logs: LogEntry[]; webConfig: WebConfig | null }) {
  const visibleBots = bots.slice(0, 6);
  const recentLogs = logs.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);
  const fallbackActivities = bots.filter((bot) => bot.state === 'online').map((bot) => ({ botId: bot.id, message: `${bot.displayName} · ${taskLabel(bot)}`, at: new Date().toISOString(), level: 'info' } as LogEntry));
  const activityItems = recentLogs.length ? recentLogs : fallbackActivities.slice(0, 5);
  return <><div className="page-heading"><div><span className="eyebrow">服务器控制台 / OVERVIEW</span><h1>早上好，管理员 <span className="heading-spark">✦</span></h1><p>从这里掌握所有 Mineflayer 机器人的运行状态与任务进度。</p></div><div className="heading-meta"><span className="live-dot" />实时同步 <b>·</b> 每 2.5 秒</div></div>    <div className="overview-grid"><MetricCard label="机器人总数" value={bots.length} hint={`${activeCount} 个已启用`} icon="♟" tone="green" /><MetricCard label="在线机器人" value={onlineCount} hint={bots.length ? `${Math.round((onlineCount / bots.length) * 100)}% 在线率` : '等待添加机器人'} icon="⌁" tone="mint" /><MetricCard label="正在执行" value={bots.filter((bot) => bot.killAura || bot.fishing || bot.mining || bot.regionMining || bot.supply || bot.sleepEnabled || bot.resupplyEnabled).length} hint="战斗 / 钓鱼 / 采集任务" icon="⚡" tone="yellow" /><MetricCard label="控制服务" value={webConfig?.port || '—'} hint={`Viewer 起始端口 ${webConfig?.viewerPortStart || '—'}`} icon="◈" tone="blue" /></div>
    <div className="section-heading"><div><span className="eyebrow">RUNTIME BOARD</span><h2>机器人状态</h2></div><button className="text-button" onClick={() => setView('bots')}>管理全部 →</button></div>
    <div className="bot-cards">{bots.length ? <>{visibleBots.map((bot) => <BotOverviewCard key={bot.id} bot={bot} onClick={() => selectBot(bot.id)} />)}{bots.length > 6 && <button className="overview-more card" onClick={() => setView('bots')}>查看全部 {bots.length} 个机器人 →</button>}</> : <EmptyState openAdd={() => setView('bots')} />}</div>
    <div className="overview-bottom"><div className="card activity-card"><div className="card-header"><div><span className="eyebrow">ACTIVITY STREAM</span><h3>最近活动</h3></div><span className="soft-badge">实时</span></div>{activityItems.length ? activityItems.map((log, index) => <div className="activity-row" key={`${log.at}-${log.botId}-${index}`}><span className={`activity-icon ${log.level}`}>{log.level === 'error' ? '!' : '✓'}</span><div><strong>{log.message}</strong><small>{log.botId} · {new Date(log.at).toLocaleTimeString()}</small></div></div>) : <p className="muted">连接机器人后，运行日志会显示在这里。</p>}</div><div className="card insight-card"><div className="insight-art">✦</div><span className="eyebrow">OPERATIONS TIP</span><h3>为每个机器人设置独立白名单</h3><p>将管理权限按机器人拆分，避免一个玩家意外控制所有实例。</p><button className="secondary" onClick={() => selected && selectBot(selected.id)}>查看当前机器人</button></div></div>
  </>;
}

function MetricCard({ label, value, hint, icon, tone }: { label: string; value: string | number; hint: string; icon: string; tone: string }) { return <div className={`metric-card tone-${tone}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>; }
function BotOverviewCard({ bot, onClick }: { bot: BotStatus; onClick: () => void }) { const task = taskLabel(bot); return <button className="bot-overview-card" onClick={onClick}><div className="bot-card-top"><span className={`state-pill ${bot.state}`}><i />{stateLabel(bot.state)}</span><span className="card-arrow">↗</span></div><div className="bot-identity"><BotFace bot={bot} size="medium" /><div><h3>{bot.displayName}</h3><p>{bot.host}:{bot.port}</p></div></div><div className="task-line"><span className="task-icon">{taskIcon(bot)}</span><span>{task}</span><b>{bot.username || bot.configuredUsername}</b></div><div className="health-bars"><span><i style={{ width: `${Math.min(100, (bot.health || 0) / 20 * 100)}%` }} /></span><small>生命 {bot.health ?? '—'}</small><span><i style={{ width: `${Math.min(100, (bot.food || 0) / 20 * 100)}%` }} /></span><small>饱食 {bot.food ?? '—'}</small></div></button>; }

function BotManagement(props: { bots: BotStatus[]; selectedIds: string[]; toggleSelection: (id: string) => void; selectAll: () => void; setSelectedIds: (ids: string[]) => void; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown>; openAdd: () => void; openEdit: () => void; selected?: BotStatus; deleteBot: (id: string) => Promise<unknown>; setSelectedId: (id: string) => void; whitelist: string[]; saveWhitelist: (names: string[]) => Promise<void> }) {
  const { bots, selectedIds, toggleSelection, selectAll, setSelectedIds, run, openAdd, openEdit, selected, deleteBot, setSelectedId, whitelist, saveWhitelist } = props;
  const [whitelistOpen, setWhitelistOpen] = useState(false);
  return <>
    <div className="page-heading compact"><div><span className="eyebrow">CONFIGURATION / BOTS</span><h1>机器人管理</h1><p>创建、配置和批量控制你的 Minecraft bot 集群。</p></div><button className="primary" onClick={openAdd}>＋ 新建机器人</button></div>
    <div className="management-toolbar"><div className="search-box">⌕<input placeholder="搜索机器人名称、地址或账号…" /></div><div className="toolbar-actions"><button className="secondary" disabled={!selectedIds.length} onClick={() => run(() => batchAction('start', selectedIds))}>▶ 批量启动</button><button className="secondary" disabled={!selectedIds.length} onClick={() => run(() => batchAction('stop', selectedIds))}>■ 批量停止</button><button className="icon-button" title="列表视图">☷</button></div></div>
    {selectedIds.length > 0 && <div className="selection-bar"><span>已选择 <b>{selectedIds.length}</b> 个机器人</span><button onClick={() => setSelectedIds([])}>清除选择</button></div>}
    <div className="table-card"><div className="table-head"><label className="check-wrap"><input type="checkbox" checked={bots.length > 0 && selectedIds.length === bots.length} onChange={selectAll} /><span /></label><span>机器人</span><span>连接服务器</span><span>认证账号</span><span>状态 / 任务</span><span>操作</span></div>{bots.map((bot) => <div className={`bot-table-row ${selected?.id === bot.id ? 'selected-row' : ''}`} key={bot.id}><label className="check-wrap"><input type="checkbox" checked={selectedIds.includes(bot.id)} onChange={() => toggleSelection(bot.id)} /><span /></label><button className="table-bot" onClick={() => setSelectedId(bot.id)}><BotFace bot={bot} size="small" /><div><strong>{bot.displayName}</strong><small>ID: {bot.id}</small></div></button><div><strong>{bot.host}</strong><small>端口 {bot.port} · {bot.version || '自动版本'}</small></div><div><strong>{bot.configuredUsername || '未设置'}</strong><small><span className="auth-tag">{bot.auth || 'microsoft'}</span> {bot.viewerPort ? `· Viewer :${bot.viewerPort}` : ''}</small></div><div><span className={`state-pill ${bot.state}`}><i />{stateLabel(bot.state)}</span><small>{taskLabel(bot)}</small></div><div className="row-actions"><button className="icon-button" title="详情" onClick={() => setSelectedId(bot.id)}>↗</button><button className="icon-button" title="启动/停止" onClick={() => run(() => botAction(bot.id, bot.state === 'stopped' ? 'start' : 'stop'))}>{bot.state === 'stopped' ? '▶' : '■'}</button></div></div>)}{!bots.length && <EmptyState openAdd={openAdd} />}</div>
    {selected && <div className="management-footer"><div><span className="eyebrow">SELECTED BOT</span><strong>{selected.displayName}</strong><small>上次选择的机器人 · {stateLabel(selected.state)}</small></div><button className="secondary" onClick={openEdit}>编辑配置</button><button className="secondary" onClick={() => setWhitelistOpen(true)}>编辑白名单</button><button className="danger-button" disabled={selected.state !== 'stopped'} onClick={() => { if (window.confirm(`删除 ${selected.displayName}？认证缓存会保留。`)) run(() => deleteBot(selected.id), true); }}>删除</button></div>}
    {whitelistOpen && selected && <WhitelistModal bot={selected} whitelist={whitelist} saveWhitelist={async (names) => { await saveWhitelist(names); setWhitelistOpen(false); }} onClose={() => setWhitelistOpen(false)} />}
  </>;
}

function WhitelistModal({ bot, whitelist, saveWhitelist, onClose }: { bot: BotStatus; whitelist: string[]; saveWhitelist: (names: string[]) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(whitelist.join('\n'));
  return <div className="editor-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="editor-modal whitelist-modal" role="dialog" aria-modal="true" aria-labelledby="whitelist-title"><div className="drawer-head"><div><span className="eyebrow">ACCESS CONTROL / {bot.displayName}</span><h2 id="whitelist-title">独立白名单</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p className="modal-intro">只有名单内的玩家可以在游戏聊天中向 {bot.displayName} 发出控制指令。每行一个 Minecraft 玩家名。</p><textarea className="whitelist-editor" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={'Steve\nAlex'} /><div className="security-note">建议只添加可信玩家；修改会同步到该机器人，其他 bot 不会共享这份名单。</div><div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="primary" onClick={() => saveWhitelist(draft.split(/\r?\n|,|\s+/).map((name) => name.trim()).filter(Boolean))}>保存白名单</button></div></div></div>;
}

function BotEditor({ editorMode, setEditorMode, form, updateForm, submitBot }: { editorMode: 'add' | 'edit'; setEditorMode: (mode: 'add' | 'edit' | null) => void; form: BotForm; updateForm: <K extends keyof BotForm>(key: K, value: BotForm[K]) => void; submitBot: (event: FormEvent) => Promise<void> }) {
  return <div className="editor-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditorMode(null); }}>
    <form className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="bot-editor-title" onSubmit={submitBot}>
      <div className="drawer-head"><div><span className="eyebrow">BOT PROFILE / {editorMode.toUpperCase()}</span><h2 id="bot-editor-title">{editorMode === 'add' ? '创建一个新机器人' : '编辑机器人配置'}</h2></div><button type="button" className="icon-button" onClick={() => setEditorMode(null)}>×</button></div>
      <div className="editor-section"><h3>基础信息</h3><div className="form-grid"><label>机器人 ID<input value={form.id} disabled={editorMode === 'edit'} onChange={(event) => updateForm('id', event.target.value)} required placeholder="yukikaze" /></label><label>显示名称<input value={form.displayName} onChange={(event) => updateForm('displayName', event.target.value)} placeholder="Yukikaze" /></label><label className="wide">服务器地址<input value={form.host} onChange={(event) => updateForm('host', event.target.value)} required placeholder="mc.example.com" /></label><label>游戏端口<input type="number" min="1" max="65535" value={form.port} onChange={(event) => updateForm('port', event.target.value)} required /></label><label>游戏版本<input value={form.version} onChange={(event) => updateForm('version', event.target.value)} placeholder="自动检测" /></label></div></div>
      <div className="editor-section"><h3>登录与认证</h3><div className="form-grid"><label className="wide">账号 / 用户名<input value={form.username} onChange={(event) => updateForm('username', event.target.value)} required placeholder="Microsoft 邮箱或离线用户名" /><small className="field-hint">Microsoft 登录缓存会按 bot ID 独立保存在 data/auth/ 下。</small></label><label className="wide">皮肤玩家名 / UUID<input value={form.skinUsername} onChange={(event) => updateForm('skinUsername', event.target.value)} placeholder="默认使用实际登录名，离线 bot 可填写正版玩家名" /><small className="field-hint">用于加载头像和第三人称模型，不会用于登录。</small></label><label>认证方式<select value={form.auth} onChange={(event) => updateForm('auth', event.target.value)}><option value="microsoft">Microsoft OAuth</option><option value="offline">离线 / Cracked</option><option value="mojang">Mojang（兼容）</option></select></label><label>第三方验证<select defaultValue="auto"><option value="auto">自动处理（推荐）</option><option value="manual">手动确认</option><option value="none">不启用</option></select></label></div><div className="security-note">▣ 认证状态由 Mineflayer authflow 管理。首次登录请在终端完成设备码验证，不要把 token 提交到 Git。</div></div>
      <div className="editor-section"><h3>Viewer 预览</h3><div className="form-grid"><label>Viewer 端口<input type="number" min="1" max="65535" value={form.viewerPort} onChange={(event) => updateForm('viewerPort', event.target.value)} placeholder="自动分配" disabled={!form.viewerEnabled} /></label><label>视距<input type="number" min="2" max="32" value={form.viewerDistance} onChange={(event) => updateForm('viewerDistance', event.target.value)} disabled={!form.viewerEnabled} /></label><label className="toggle-row"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm('enabled', event.target.checked)} /><span />允许自动启动</label><label className="toggle-row"><input type="checkbox" checked={form.viewerEnabled} onChange={(event) => updateForm('viewerEnabled', event.target.checked)} /><span />启用内嵌 Viewer</label><label className="toggle-row"><input type="checkbox" checked={form.firstPerson} onChange={(event) => updateForm('firstPerson', event.target.checked)} disabled={!form.viewerEnabled} /><span />默认第一人称</label></div></div>
      <div className="drawer-actions"><button type="button" className="secondary" onClick={() => setEditorMode(null)}>取消</button><button className="primary">保存到本地配置</button></div>
    </form>
  </div>;
}
const skillGuides: Record<string, { examples: string[]; notes: string[]; next: string[] }> = {
  combat: { examples: ['Shinano kill on', 'kill off Shinano', 'Shinano stop'], notes: ['机器人名称可以放在指令开头或结尾。', '只有该 bot 的独立白名单玩家会被接受。'], next: ['资源采集 / 挖矿', '自动补给与装备切换'] },
  fishing: { examples: ['Shinano fish', 'fish Shinano', 'Shinano stop'], notes: ['先确认机器人背包里有鱼竿。', '停止钓鱼可以使用 stop，不会影响连接。'], next: ['自动收杆与补充鱼竿', '定点农场巡逻'] },
  pathfinder: { examples: ['follow Shinano', 'come Shinano', 'home base Shinano'], notes: ['follow 和 come 后面填写在线玩家名。', 'home 后面填写已配置的家名称。'], next: ['资源采集路线', '多机器人分工导航'] },
  'chat-command': { examples: ['status Shinano', '!info on Shinano', 'info off Shinano'], notes: ['聊天指令会经过每个 bot 的白名单校验。', '建议使用“机器人名 + 指令”格式，辨识度最高。'], next: ['白名单分组与权限级别', '指令冷却与审计'] },
  mining: { examples: ['网页选择方块并保存区域', 'Shinano area on', 'Shinano area status', 'Shinano area off', 'Shinano unseal'], notes: ['网页会把中文方块名映射为真实 Minecraft ID；容器、床、基岩、传送门和流体始终保护。', '区域挖矿开始时会建立稳定的初始 Home，补给完成后返回该锚点；定向挖矿才使用临时检查点。', '缺少工具、食物、封堵方块或路径不可达时会暂停并在游戏内报告，不会强行继续。'], next: ['矿区分层路线规划', '区块加载器与跨区队列'] },
  supply: { examples: ['网页初始化 /home 补给', '网页初始化 /home 存储', 'Shinano supply on', 'Shinano equip pickaxe'], notes: ['食物、镐子和睡觉可以映射到同一个 Home，矿物存储可以映射到另一个 Home。', '机器人会先通过 /home 到达已配置 Home；首次成功访问会自动记录锚点，然后扫描附近箱子、木桶和潜影盒，并依次尝试多个仍有空间的容器。', '夜间睡觉、挖矿回程、缺粮和缺镐都由同一个 Home 技能处理；没有安全锚点时只告警，不会乱跑。'], next: ['容器库存索引', '补给策略统计'] },
  'openai-tools': { examples: ['暂未启用游戏内喊话'], notes: ['当前只展示工具声明和审批边界，不会调用模型。', '后续启用前会增加逐次确认和可撤销操作。'], next: ['自然语言任务规划', '工具调用审批中心'] }
};

function SkillsPage({ bots, selected, skillOverview, onOpenSkill, run }: { bots: BotStatus[]; selected?: BotStatus; skillOverview: SkillOverview | null; onOpenSkill: (key: string) => void; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> }) {
  return <><div className="page-heading compact"><div><span className="eyebrow">AUTOMATION / SKILLS</span><h1>技能中心</h1><p>每项技能都是独立模块，声明指令、能力边界与未来的 OpenAI 工具链。</p></div><span className="soft-badge large">7 个技能模块</span></div><SkillSettingsPanel bots={bots} selected={selected} overview={skillOverview} run={run} /><div className="skills-notice"><div className="notice-icon">✦</div><div><strong>模块化设计已就绪</strong><p>后续新增技能只需在 <code>apps/server/src/core/skills/</code> 添加独立 JS 文件，再注册到技能目录。</p></div><span className="status-chip">对话功能暂未启用</span></div><div className="skills-grid">{skills.map((skill) => { const enabledCount = bots.filter((bot) => bot.skills?.[skill.key as SkillKey]?.enabled).length; return <article className="skill-card" key={skill.key}><div className="skill-card-top"><span className="skill-icon">{skill.icon}</span><span className="status-chip">{enabledCount ? `${enabledCount} 个机器人启用` : skill.status}</span></div><h3>{skill.name}</h3><p>{skill.description}</p><div className="skill-capabilities">{skill.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div><div className="skill-commands">{skill.commands.map((command) => <code key={command}>{command}</code>)}</div><div className="skill-card-foot"><span>模块文件</span><strong>{skill.key}.js</strong><button className="icon-button" title="查看使用方法" onClick={() => onOpenSkill(skill.key)}>↗</button></div></article>; })}</div></>;
}

const defaultSkillSettings = (): SkillSettings => ({
  combat: { enabled: false, priority: 55, autoStart: false },
  fishing: { enabled: false, priority: 20, autoStart: false },
  pathfinder: { enabled: false, priority: 30, autoStart: false },
  mining: { enabled: false, priority: 45, autoStart: false },
  supply: { enabled: false, priority: 85, autoStart: false },
  'chat-command': { enabled: true, priority: 10, autoStart: false },
  'openai-tools': { enabled: false, priority: 1, autoStart: false }
});

function SkillSettingsPanel({ bots, selected, overview, run }: { bots: BotStatus[]; selected?: BotStatus; overview: SkillOverview | null; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> }) {
  const [scope, setScope] = useState<'global' | 'bot'>('bot');
  const [botId, setBotId] = useState(selected?.id || bots[0]?.id || '');
  const [settings, setSettings] = useState<SkillSettings>(overview?.global || defaultSkillSettings());
  useEffect(() => {
    const next = scope === 'global' ? overview?.global : bots.find((bot) => bot.id === botId)?.skills;
    if (next) setSettings(next);
  }, [scope, botId, overview]);
  const update = <K extends SkillKey>(key: K, field: 'enabled' | 'autoStart' | 'priority', value: boolean | number) => setSettings((current) => ({ ...current, [key]: { ...current[key], [field]: value } }));
  const save = async () => await run(() => updateSkills(scope, settings, scope === 'bot' ? botId : undefined), true);
  const copy = async () => { if (scope !== 'bot' || !botId) return; await run(() => copySkills(botId, bots.filter((bot) => bot.id !== botId).map((bot) => bot.id)), true); };
  return <section className="card skill-settings-panel"><div className="card-header"><div><span className="eyebrow">SKILL POLICY / RUNTIME</span><h3>技能开关与任务优先级</h3><p className="muted">全局设置作为默认值；单机器人设置会覆盖全局。启用只是开放能力，只有勾选“随机器人启动”才会在连接后自动运行，默认不会让机器人移动。</p></div><span className="soft-badge">可复制配置</span></div><div className="skill-policy-toolbar"><div className="mode-switch"><button type="button" className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>全局默认</button><button type="button" className={scope === 'bot' ? 'active' : ''} onClick={() => setScope('bot')}>单机器人</button></div>{scope === 'bot' && <select value={botId} onChange={(event) => setBotId(event.target.value)}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select>}<button type="button" className="primary" onClick={save}>保存技能配置</button>{scope === 'bot' && <button type="button" className="secondary" onClick={copy}>复制给其他机器人</button>}</div><div className="skill-policy-grid">{skills.map((skill) => { const key = skill.key as SkillKey; return <label className="skill-policy-row" key={skill.key}><span className="skill-policy-name"><b>{skill.icon}</b>{skill.name}</span><input type="checkbox" checked={settings[key]?.enabled || false} onChange={(event) => update(key, 'enabled', event.target.checked)} /><span>启用</span><input type="checkbox" checked={settings[key]?.autoStart || false} disabled={!settings[key]?.enabled || !['combat', 'fishing', 'mining', 'supply'].includes(key)} onChange={(event) => update(key, 'autoStart', event.target.checked)} /><span title="只有动作技能支持自动启动">随机器人启动</span><input className="priority-input" type="number" min="1" max="100" value={settings[key]?.priority ?? 1} onChange={(event) => update(key, 'priority', Number(event.target.value))} /><small>优先级</small></label>; })}</div><div className="bot-skill-status"><strong>当前机器人运行状态</strong>{bots.map((bot) => { const enabled = (Object.keys(bot.skills || {}) as SkillKey[]).filter((key) => bot.skills?.[key]?.enabled); return <div key={bot.id} className="bot-skill-status-row"><span>{bot.displayName}</span><div><small>已启用：</small>{enabled.length ? enabled.map((key) => <code key={`enabled-${key}`}>{key}</code>) : <em>无</em>}<small> · 运行中：</small>{bot.activeSkills.length ? bot.activeSkills.map((key) => <code key={`active-${key}`}>{key}</code>) : <em>无</em>}</div><small>{bot.scheduler?.active ? `调度中：${bot.scheduler.active}` : '调度器空闲'}</small></div>; })}</div></section>;
}

function SkillGuideModal({ skill, bots, selected, run, onClose }: { skill: typeof skills[number]; bots: BotStatus[]; selected?: BotStatus; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown>; onClose: () => void }) {
  const guide = skillGuides[skill.key] || { examples: [], notes: [], next: [] };
  return <div className="editor-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="editor-modal skill-guide-modal" role="dialog" aria-modal="true" aria-labelledby="skill-guide-title"><div className="drawer-head"><div><span className="eyebrow">SKILL GUIDE / {skill.key}.js</span><h2 id="skill-guide-title">{skill.name} · 怎么使用</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p className="modal-intro">{skill.description}</p>{skill.key === 'mining' ? <MiningSkillSettings bots={bots} selected={selected} run={run} /> : skill.key === 'supply' ? <SupplySkillSettings bots={bots} selected={selected} run={run} /> : <><section><h3>游戏中怎么喊话</h3><div className="chat-examples">{guide.examples.map((example) => <code className="chat-example" key={example}>{example}</code>)}</div><p className="muted">在 Minecraft 聊天框直接输入即可。建议使用“机器人名 + 指令”，例如 <code>Shinano kill on</code>；指令仍会受该机器人的独立白名单保护。</p></section><section><h3>使用建议</h3><ul className="guide-list">{guide.notes.map((note) => <li key={note}>{note}</li>)}</ul></section><section><h3>下一轮候选技能（本轮不启用）</h3><ul className="guide-list skill-next-list">{guide.next.map((item) => <li key={item}>{item}</li>)}</ul></section></>}<div className="drawer-actions"><button type="button" className="primary" onClick={onClose}>知道了</button></div></div></div>;
}

function MiningSkillSettings({ bots, selected, run }: { bots: BotStatus[]; selected?: BotStatus; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> }) {
  const [botId, setBotId] = useState(selected?.id || bots[0]?.id || '');
  const currentBot = bots.find((bot) => bot.id === botId) || selected;
  const region = currentBot?.region;
  const [mode, setMode] = useState<'blacklist' | 'whitelist'>(region?.mode === 'whitelist' ? 'whitelist' : 'blacklist');
  const [cornerOne, setCornerOne] = useState(region ? [region.bounds.minX, region.bounds.minY, region.bounds.minZ].join(', ') : '0, 0, 0');
  const [cornerTwo, setCornerTwo] = useState(region ? [region.bounds.maxX, region.bounds.maxY, region.bounds.maxZ].join(', ') : '0, 0, 0');
  const [allow, setAllow] = useState<string[]>((region?.allow || []).filter((item) => !['air', 'cave_air', 'void_air'].includes(item)));
  const [deny, setDeny] = useState<string[]>(region?.customDeny || []);
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [customBlock, setCustomBlock] = useState('');
  const [error, setError] = useState('');
  const selectedBlocks = mode === 'whitelist' ? allow : deny;
  const selectedSet = useMemo(() => new Set(selectedBlocks), [selectedBlocks]);
  const visibleBlocks = miningBlocks.filter((block) => (category === '全部' || block.category === category) && (!search.trim() || `${block.name} ${block.id}`.toLowerCase().includes(search.trim().toLowerCase())));

  function selectBot(id: string) {
    const next = bots.find((bot) => bot.id === id);
    setBotId(id);
    setError('');
    if (next?.region) {
      setMode(next.region.mode === 'whitelist' ? 'whitelist' : 'blacklist');
      setCornerOne([next.region.bounds.minX, next.region.bounds.minY, next.region.bounds.minZ].join(', '));
      setCornerTwo([next.region.bounds.maxX, next.region.bounds.maxY, next.region.bounds.maxZ].join(', '));
      setAllow(next.region.allow.filter((item) => !['air', 'cave_air', 'void_air'].includes(item)));
      setDeny(next.region.customDeny || []);
    } else {
      setMode('blacklist');
      setCornerOne('0, 0, 0');
      setCornerTwo('0, 0, 0');
      setAllow([]);
      setDeny([]);
    }
  }

  function toggleBlock(id: string) {
    const setter = mode === 'whitelist' ? setAllow : setDeny;
    setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function addCustomBlocks() {
    const tokens = customBlock.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
    if (!tokens.length) return;
    const resolved = tokens.map((token) => {
      const match = miningBlocks.find((block) => block.id === token.replace(/^minecraft:/, '') || block.name === token);
      return match?.id || token.replace(/^minecraft:/, '').toLowerCase();
    }).filter((id) => !miningBlocks.find((block) => block.id === id)?.protected);
    const setter = mode === 'whitelist' ? setAllow : setDeny;
    setter((current) => [...new Set([...current, ...resolved])]);
    setCustomBlock('');
  }

  function applyPreset(preset: 'ores' | 'terrain' | 'clear') {
    const values = preset === 'clear' ? [] : miningBlocks.filter((block) => !block.protected && (preset === 'ores' ? block.category === '矿石' : ['地形', '自然'].includes(block.category))).map((block) => block.id);
    if (mode === 'whitelist') setAllow(values);
    else setDeny(values);
  }

  function parseCorner(value: string) {
    const values = value.split(/[,，\s]+/).map(Number);
    return values.length === 3 && values.every(Number.isInteger) ? values : null;
  }

  async function save(startMining = false) {
    const first = parseCorner(cornerOne);
    const second = parseCorner(cornerTwo);
    if (!first || !second) {
      setError('两个角点都必须包含 3 个整数，例如：-30, 60, -30。');
      return;
    }
    setError('');
    await run(() => configureRegion(botId, { x1: first[0], y1: first[1], z1: first[2], x2: second[0], y2: second[1], z2: second[2], mode, allow, deny }), true);
    if (startMining) await run(() => sendCommand(botId, 'area on'), true);
  }

  const customSelected = selectedBlocks.filter((id) => !miningBlocks.some((block) => block.id === id));
  return <section className="mining-settings">
    <div className="settings-heading"><div><span className="eyebrow">VISUAL BLOCK POLICY</span><h3>区域清空与方块策略</h3></div><span className="soft-badge">容器、基岩、流体永久保护</span></div>
    <div className="mining-top-grid"><label>目标机器人<select value={botId} onChange={(event) => selectBot(event.target.value)}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select></label><label>角点 1<input value={cornerOne} onChange={(event) => setCornerOne(event.target.value)} placeholder="x, y, z" /></label><label>角点 2<input value={cornerTwo} onChange={(event) => setCornerTwo(event.target.value)} placeholder="x, y, z" /></label></div>
    <div className="mode-switch mining-mode"><button type="button" className={mode === 'blacklist' ? 'active' : ''} onClick={() => setMode('blacklist')}><b>黑名单</b><small>选中的方块不挖，其余安全方块清空</small></button><button type="button" className={mode === 'whitelist' ? 'active' : ''} onClick={() => setMode('whitelist')}><b>白名单</b><small>只挖选中的方块</small></button></div>
    <div className="block-policy-toolbar"><div className="block-categories">{['全部', '矿石', '地形', '自然', '建筑', '永久保护'].map((item) => <button type="button" className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索中文名或方块 ID" /></div>
    <div className="block-preset-row"><span>快速选择</span><button type="button" onClick={() => applyPreset('ores')}>全部矿石</button><button type="button" onClick={() => applyPreset('terrain')}>常见地形与自然方块</button><button type="button" onClick={() => applyPreset('clear')}>清空选择</button></div>
    <div className="block-catalog">{visibleBlocks.map((block) => <button type="button" key={block.id} disabled={block.protected} className={`block-option ${selectedSet.has(block.id) ? 'selected' : ''} ${block.protected ? 'protected' : ''}`} onClick={() => toggleBlock(block.id)}><span className="block-swatch" style={{ background: block.tone }} /><span><strong>{block.name}</strong><small>minecraft:{block.id}</small></span><i>{block.protected ? '锁定保护' : selectedSet.has(block.id) ? (mode === 'whitelist' ? '允许挖' : '禁止挖') : '未选择'}</i></button>)}</div>
    <div className="custom-block-row"><label>补充自定义方块<input value={customBlock} onChange={(event) => setCustomBlock(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomBlocks(); } }} placeholder="输入中文名或 minecraft:block_id" /></label><button type="button" className="secondary" onClick={addCustomBlocks}>加入当前列表</button></div>
    {customSelected.length > 0 && <div className="selected-blocks"><span>自定义映射：</span>{customSelected.map((id) => <button type="button" key={id} onClick={() => toggleBlock(id)}>{id} ×</button>)}</div>}
    <p className="muted">网页保存的中文选择会转换为真实方块 ID。区域挖矿采用清理区模式：从最高 Y 层开始，每轮清理两层，完成后只下探一层继续；补给、睡觉或卸货结束后返回稳定的初始 Home。定向挖矿只会挖指定目标，不会为了接近矿石擅自挖石头。{currentBot?.region?.layerTop !== undefined ? ` 当前工作层：Y ${currentBot.region.layerTop} 至 ${currentBot.region.layerBottom}` : ''}{currentBot?.region?.pausedReason ? ` 当前暂停：${currentBot.region.pausedReason}` : ''}</p>
    {error && <p className="form-error">{error}</p>}
    <div className="drawer-actions mining-actions"><button type="button" className="secondary" disabled={!botId} onClick={() => save(false)}>仅保存设置</button><button type="button" className="primary" disabled={!botId} onClick={() => save(true)}>保存并开始挖矿</button><button type="button" className="secondary" disabled={!botId} onClick={() => run(() => sendCommand(botId, 'area off'), true)}>暂停挖矿</button></div>
  </section>;
}

function SupplySkillSettings({ bots, selected, run }: { bots: BotStatus[]; selected?: BotStatus; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> }) {
  const [botId, setBotId] = useState(selected?.id || bots[0]?.id || '');
  const currentBot = bots.find((bot) => bot.id === botId) || selected;
  const [points, setPoints] = useState<SupplyPoint[]>(currentBot?.resupplyPoints || []);
  const [homeTargets, setHomeTargets] = useState<HomeTarget[]>(currentBot?.homeTargets || []);
  const [targetName, setTargetName] = useState('矿区');
  const [targetDimension, setTargetDimension] = useState('');
  const [targetX, setTargetX] = useState('0');
  const [targetY, setTargetY] = useState('64');
  const [targetZ, setTargetZ] = useState('0');
  const [arrivalHome, setArrivalHome] = useState('');
  const [name, setName] = useState('综合补给站');
  const [home, setHome] = useState('补给');
  const [roles, setRoles] = useState<SupplyRole[]>(['food', 'pickaxe', 'sleep']);
  const [scanRadius, setScanRadius] = useState(8);
  const [error, setError] = useState('');

  function selectBot(id: string) {
    setBotId(id);
    const nextBot = bots.find((bot) => bot.id === id);
    setPoints(nextBot?.resupplyPoints || []);
    setHomeTargets(nextBot?.homeTargets || []);
    setError('');
  }

  function toggleDraftRole(role: SupplyRole) {
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  }

  function addPoint(template?: 'supply' | 'storage') {
    const nextHome = template === 'storage' ? '存储' : template === 'supply' ? '补给' : home.trim();
    const nextName = template === 'storage' ? '矿物仓库' : template === 'supply' ? '综合补给站' : name.trim();
    const nextRoles: SupplyRole[] = template === 'storage' ? ['storage'] : template === 'supply' ? ['food', 'pickaxe', 'sleep'] : roles;
    if (!nextHome || /\s/.test(nextHome)) { setError('Home 名称不能为空且不能包含空格。'); return; }
    if (!nextRoles.length) { setError('至少选择一个补给角色。'); return; }
    setPoints((current) => [...current, { id: `home-${Date.now()}`, name: nextName || nextHome, home: nextHome, roles: nextRoles, dimension: null, x: null, y: null, z: null, bed: null, containers: [], scanRadius, autoDiscover: true, enabled: true, priority: template === 'storage' ? 20 : 10 }]);
    setError('');
  }

  function updatePoint(id: string, patch: Partial<SupplyPoint>) {
    setPoints((current) => current.map((point) => point.id === id ? { ...point, ...patch } : point));
  }

  function togglePointRole(id: string, role: SupplyRole) {
    setPoints((current) => current.map((point) => point.id === id ? { ...point, roles: point.roles.includes(role) ? point.roles.filter((item) => item !== role) : [...point.roles, role] } : point));
  }

  function validate(nextPoints: SupplyPoint[]) {
    for (const point of nextPoints) {
      if (!point.home && ![point.x, point.y, point.z].every((value) => Number.isFinite(value))) return `${point.name} 没有 Home 名称，也没有可用的旧坐标锚点。`;
      if (point.home && /\s/.test(point.home)) return `${point.name} 的 Home 名称不能包含空格。`;
      if (!point.roles.length) return `${point.name} 至少需要一个角色。`;
    }
    return '';
  }

  async function save(nextPoints = points) {
    if (!botId) return;
    const message = validate(nextPoints);
    if (message) { setError(message); return; }
    setError('');
    await run(() => configureSupply(botId, nextPoints), true);
  }

  function addHomeTarget() {
    const x = Number(targetX);
    const y = Number(targetY);
    const z = Number(targetZ);
    const cleanName = targetName.trim().replace(/\s+/g, '_');
    if (!cleanName || ![x, y, z].every(Number.isFinite)) { setError('Home 目标需要名称和有效的 X/Y/Z 坐标。'); return; }
    setHomeTargets((current) => [...current, { id: `target-${Date.now()}`, name: cleanName, dimension: targetDimension.replace(/^minecraft:/, '').trim() || null, x, y, z, arrivalHome: arrivalHome.trim() || null, enabled: true, useServerTeleport: true, lastSetAt: null }]);
    setError('');
  }

  function updateHomeTarget(id: string, patch: Partial<HomeTarget>) {
    setHomeTargets((current) => current.map((target) => target.id === id ? { ...target, ...patch } : target));
  }

  async function saveHomeTargets(nextTargets = homeTargets) {
    if (!botId) return;
    if (nextTargets.some((target) => !target.name || ![target.x, target.y, target.z].every(Number.isFinite))) { setError('Home 目标的名称和坐标不能为空。'); return; }
    setError('');
    await run(() => configureHomeTargets(botId, nextTargets), true);
  }

  async function setTargetHome(target: HomeTarget) {
    await run(() => setHomeTarget(botId, target.id), true);
  }

  async function initializeHome(point: SupplyPoint) {
    const bot = bots.find((item) => item.id === botId);
    if (!point.home) { setError('请先填写 Home 名称。'); return; }
    if (!bot?.position || bot.state !== 'online') { setError('机器人必须在线并已加载世界坐标，才能在当前位置初始化 Home。'); return; }
    const updated = points.map((item) => item.id === point.id ? { ...item, x: bot.position!.x, y: bot.position!.y, z: bot.position!.z, dimension: String(bot.dimension || '').replace(/^minecraft:/, '') || null } : item);
    setPoints(updated);
    setError('');
    await run(() => sendCommand(botId, `sethome ${point.home}`));
    await save(updated);
  }

  return <section className="supply-settings">
    <div className="settings-heading"><div><span className="eyebrow">ROLE-BASED HOME STATIONS</span><h3>Home 补给与仓储映射</h3></div><span className="soft-badge">只扫描已登记 Home 附近</span></div>
    <div className="supply-explainer"><strong>推荐结构</strong><span><code>/home 补给</code>：食物 + 镐子 + 床</span><span><code>/home 存储</code>：多个箱子 / 木桶 / 潜影盒</span><small>区域挖矿使用稳定的初始挖矿 Home 回程；机器人首次访问补给 Home 会自动记录锚点。</small></div>
    <label>目标机器人<select value={botId} onChange={(event) => selectBot(event.target.value)}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select></label>
    {currentBot?.homes?.length ? <div className="known-home-list"><strong>机器人已知 Home</strong><div>{currentBot.homes.map((knownHome) => <span className={`known-home-chip ${knownHome.initialized ? 'ready' : 'pending'}`} key={knownHome.id}><b>{knownHome.name}</b><small>{knownHome.label} · {knownHome.initialized ? `${knownHome.position?.x}, ${knownHome.position?.y}, ${knownHome.position?.z}` : '待初始化'}</small></span>)}</div>{currentBot.homeActivity && <small className="home-activity">{currentBot.homeActivity.message}</small>}</div> : <div className="known-home-list pending"><strong>机器人已知 Home</strong><span>保存 Home 映射或开始区域挖矿后，这里会显示所有 Home 及其锚点。</span></div>}
    <div className="home-target-builder"><div className="settings-heading"><div><span className="eyebrow">HOME TARGET SKILL</span><h3>自动前往指定地点设定 Home</h3></div><span className="soft-badge">同维度寻路 / 跨维度传送</span></div><p className="muted">填入目标坐标后，机器人会自行前往并执行 <code>/sethome 名称</code>。跨维度优先使用“抵达 Home”；没有抵达 Home 时会尝试服务器传送命令，因此需要对应权限。</p><div className="form-grid"><label>Home 名称<input value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="矿区" /></label><label>维度<input value={targetDimension} onChange={(event) => setTargetDimension(event.target.value)} placeholder="overworld / the_nether / the_end" /></label><label>X<input type="number" value={targetX} onChange={(event) => setTargetX(event.target.value)} /></label><label>Y<input type="number" value={targetY} onChange={(event) => setTargetY(event.target.value)} /></label><label>Z<input type="number" value={targetZ} onChange={(event) => setTargetZ(event.target.value)} /></label><label>跨维度抵达 Home（可选）<input value={arrivalHome} onChange={(event) => setArrivalHome(event.target.value)} placeholder="例如 nether_gate" /></label></div><div className="drawer-actions"><button type="button" className="secondary" onClick={addHomeTarget}>＋ 添加 Home 目标</button><button type="button" className="primary" onClick={() => saveHomeTargets()}>保存 Home 技能目标</button></div>{homeTargets.length ? <div className="home-target-list">{homeTargets.map((target) => <article className="home-target-card" key={target.id}><div><strong>{target.name}</strong><small>{target.dimension || '当前维度'} · {target.x}, {target.y}, {target.z}{target.arrivalHome ? ` · 通过 ${target.arrivalHome}` : ''}</small></div><label className="toggle-row compact-toggle"><input type="checkbox" checked={target.enabled} onChange={(event) => updateHomeTarget(target.id, { enabled: event.target.checked })} /><span />启用</label><button type="button" className="secondary" disabled={currentBot?.state !== 'online' || !target.enabled} onClick={() => setTargetHome(target)}>前往并设 Home</button><button type="button" className="icon-button" onClick={() => setHomeTargets((current) => current.filter((item) => item.id !== target.id))}>×</button><small>{target.lastSetAt ? `上次设定：${new Date(target.lastSetAt).toLocaleString()}` : '尚未执行'}</small></article>)}</div> : null}</div>
    <div className="station-builder"><div className="form-grid"><label>站点名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="综合补给站" /></label><label>服务器 Home 名称<input value={home} onChange={(event) => setHome(event.target.value)} placeholder="补给" /></label><label>自动扫描半径<input type="number" min="2" max="32" value={scanRadius} onChange={(event) => setScanRadius(Math.max(2, Math.min(32, Number(event.target.value) || 8)))} /></label></div><div className="station-role-picker">{(Object.keys(supplyRoleLabels) as SupplyRole[]).map((role) => <button type="button" className={roles.includes(role) ? 'active' : ''} key={role} onClick={() => toggleDraftRole(role)}>{supplyRoleLabels[role]}</button>)}</div><div className="drawer-actions"><button type="button" className="secondary" onClick={() => addPoint('supply')}>＋ 综合补给模板</button><button type="button" className="secondary" onClick={() => addPoint('storage')}>＋ 矿物仓库模板</button><button type="button" className="primary" onClick={() => addPoint()}>加入站点列表</button></div></div>
    {error && <p className="form-error">{error}</p>}
    <div className="home-station-list">{points.length ? points.map((point) => <article className="home-station-card" key={point.id}><div className="home-station-head"><div><input value={point.name} onChange={(event) => updatePoint(point.id, { name: event.target.value })} aria-label="站点名称" /><span>{point.home ? `/home ${point.home}` : '旧坐标补给点'}</span></div><label className="toggle-row compact-toggle"><input type="checkbox" checked={point.enabled} onChange={(event) => updatePoint(point.id, { enabled: event.target.checked })} /><span />启用</label><button type="button" className="icon-button" onClick={() => setPoints((current) => current.filter((item) => item.id !== point.id))}>×</button></div><div className="home-station-fields"><label>Home 名称<input value={point.home || ''} onChange={(event) => updatePoint(point.id, { home: event.target.value || null })} placeholder="补给" /></label><label>扫描半径<input type="number" min="2" max="32" value={point.scanRadius || 8} onChange={(event) => updatePoint(point.id, { scanRadius: Math.max(2, Math.min(32, Number(event.target.value) || 8)) })} /></label><label>优先级<input type="number" min="0" max="100" value={point.priority || 0} onChange={(event) => updatePoint(point.id, { priority: Number(event.target.value) || 0 })} /></label></div><div className="station-role-picker compact">{(Object.keys(supplyRoleLabels) as SupplyRole[]).map((role) => <button type="button" className={point.roles.includes(role) ? 'active' : ''} key={role} onClick={() => togglePointRole(point.id, role)}>{supplyRoleLabels[role]}</button>)}</div><div className="station-anchor"><span>{[point.x, point.y, point.z].every((value) => Number.isFinite(value)) ? `安全锚点 ${point.x}, ${point.y}, ${point.z} · ${point.dimension || '任意维度'}` : '尚未记录安全锚点，请让机器人站在 Home 中初始化'}</span><label><input type="checkbox" checked={point.autoDiscover !== false} onChange={(event) => updatePoint(point.id, { autoDiscover: event.target.checked })} /> 自动发现附近容器与床</label></div><div className="home-station-actions"><button type="button" className="secondary" disabled={currentBot?.state !== 'online' || !point.home} onClick={() => initializeHome(point)}>在当前位置 /sethome 并记录锚点</button><button type="button" className="secondary" disabled={currentBot?.state !== 'online' || !point.home} onClick={() => run(() => sendCommand(botId, `home ${point.home}`))}>测试前往</button></div></article>) : <p className="muted">还没有 Home 站点。先添加“综合补给模板”和“矿物仓库模板”；区域挖矿的初始 Home 会在机器人开始挖矿时自动建立。</p>}</div>
    <div className="drawer-actions supply-save-actions"><button type="button" className="primary" onClick={() => save()}>保存全部 Home 映射</button></div>
  </section>;
}

function FirstPersonControls({ botId, run }: { botId: string; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown> }) {
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const apply = () => run(() => sendCommand(botId, `look ${yaw} ${pitch}`));
  return <div className="first-person-controls"><span>第一人称视角</span><label>水平 <input type="range" min="-180" max="180" value={yaw} onChange={(event) => setYaw(Number(event.target.value))} /><b>{yaw}°</b></label><label>俯仰 <input type="range" min="-90" max="90" value={pitch} onChange={(event) => setPitch(Number(event.target.value))} /><b>{pitch}°</b></label><button className="secondary" onClick={apply}>应用视角</button><small>Viewer 会跟随机器人的真实 yaw / pitch；浏览器鼠标不会直接接管机器人视角。</small></div>;
}
function DetailPage({ bots, onSelectBot, selected, selectedDefinition, logs, command, setCommand, submitCommand, run, previewMode, setPreviewMode, viewerUrl, openEdit }: { bots: BotStatus[]; onSelectBot: (id: string) => void; selected: BotStatus; selectedDefinition?: BotDefinition; logs: LogEntry[]; command: string; setCommand: (value: string) => void; submitCommand: (event: FormEvent) => Promise<void>; run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<unknown>; previewMode: 'status' | 'viewer'; setPreviewMode: (mode: 'status' | 'viewer') => void; viewerUrl: string; openEdit: () => void }) {
  const inventory = selected.inventory || [];
  const [viewerRevision, setViewerRevision] = useState(0);
  const switchPerspective = async (firstPerson: boolean) => {
    if (!selectedDefinition?.viewer?.enabled || !viewerUrl) return;
    await run(() => setViewerPerspective(selected.id, firstPerson), true);
    window.setTimeout(() => setViewerRevision((current) => current + 1), 500);
  };
  const task = selected.regionMining ? '正在区域挖矿' : selected.mining ? '正在挖矿采集' : selected.supply ? '正在补给管理' : selected.killAura ? '正在战斗' : selected.fishing ? '正在钓鱼' : '待命中';
  const coordinate = selected.position ? `坐标 X ${selected.position.x} · Y ${selected.position.y} · Z ${selected.position.z}` : '等待世界数据';
  return <>
    <div className="page-heading compact detail-heading">
      <div><span className="eyebrow">BOT DETAIL / LIVE MONITOR</span><h1>{selected.displayName} <span className={`state-pill inline ${selected.state}`}><i />{stateLabel(selected.state)}</span></h1><p>{selected.host}:{selected.port} · {selected.username || selected.configuredUsername} · {selected.auth || 'microsoft'}</p></div>
      <div className="heading-buttons"><label className="bot-switcher"><span>当前机器人</span><select value={selected.id} onChange={(event) => onSelectBot(event.target.value)}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select></label><button className="secondary" onClick={openEdit}>编辑配置</button><button className={selected.state === 'stopped' ? 'primary' : 'danger-button'} onClick={() => run(() => botAction(selected.id, selected.state === 'stopped' ? 'start' : 'stop'))}>{selected.state === 'stopped' ? '▶ 启动' : '■ 停止'}</button></div>
    </div>
    <div className="detail-layout detail-layout-full">
      <div className="detail-main">
        <div className="card preview-card">
          <div className="card-header"><div><span className="eyebrow">LIVE PREVIEW</span><h2>实时预览</h2></div><div className="preview-controls"><div className="segmented"><button className={previewMode === 'status' ? 'active' : ''} onClick={() => setPreviewMode('status')}>状态面板</button><button className={previewMode === 'viewer' ? 'active' : ''} onClick={() => setPreviewMode('viewer')} disabled={!viewerUrl}>3D Viewer</button></div>{previewMode === 'viewer' && <div className="perspective-toggle"><button className={!selectedDefinition?.viewer.firstPerson ? 'active' : ''} disabled={!viewerUrl} onClick={() => switchPerspective(false)}>第三人称</button><button className={selectedDefinition?.viewer.firstPerson ? 'active' : ''} disabled={!viewerUrl} onClick={() => switchPerspective(true)}>第一人称</button></div>}{previewMode === 'viewer' && selectedDefinition?.viewer.firstPerson && viewerUrl && <FirstPersonControls botId={selected.id} run={run} />}</div></div>
          {previewMode === 'viewer' && viewerUrl ? <iframe key={`${selected.id}-${viewerRevision}`} className="viewer-frame" title={`${selected.displayName} viewer`} src={viewerUrl} /> : <div className="status-preview"><div className="scene-grid"><div className="scene-sun">☀</div><SkinModel bot={selected} /><div className="scene-label"><strong>{task}</strong><span className="scene-dimension">{dimensionLabel(selected.dimension)}</span><span>{coordinate}</span></div></div></div>}
          <div className="vitals-row"><Vital label="生命值" value={selected.health ?? 0} max={20} color="red" /><Vital label="饱食度" value={selected.food ?? 0} max={20} color="gold" /><div className="position-box"><small>附近玩家</small><strong>{selected.nearbyPlayers.length ? selected.nearbyPlayers.join('、') : '暂无'}</strong></div></div>
        </div>

        <div className="command-card card"><div className="card-header"><div><span className="eyebrow">COMMAND DECK</span><h3>命令栏</h3></div><span className="soft-badge">游戏内白名单同步</span></div><div className="command-toolbar"><div className="quick-actions">{quickCommands.map((item) => <button className="secondary" key={item.command} onClick={() => run(() => sendCommand(selected.id, item.command))}>{item.label}</button>)}</div><form className="command-form" onSubmit={submitCommand}><span>›</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入命令，例如 follow PlayerName" /><button className="primary">发送</button></form></div></div>

        <div className="detail-section-row"><div className="card side-card"><span className="eyebrow">CONNECTION</span><h3>连接状态</h3><div className="connection-row"><span className={`state-dot state-${selected.state}`} /><strong>{stateLabel(selected.state)}</strong><small>{selected.lastReason || '连接稳定'}</small></div><div className="side-list"><div><span>认证账号</span><strong>{selected.configuredUsername}</strong></div><div><span>认证方式</span><strong>{selected.auth || 'microsoft'}</strong></div><div><span>游戏版本</span><strong>{selected.version || selectedDefinition?.version || '自动'}</strong></div><div><span>Viewer</span><strong>{selected.viewerPort ? `端口 ${selected.viewerPort}` : '未启用'}</strong></div></div></div><div className="card side-card"><span className="eyebrow">RECENT LOGS</span><h3>运行日志</h3><div className="mini-logs">{logs.length ? logs.slice(-8).reverse().map((log, index) => <div key={`${log.at}-${index}`}><span className={`log-dot ${log.level}`} /><p>{log.message}<small>{new Date(log.at).toLocaleTimeString()}</small></p></div>) : <p className="muted">暂无日志</p>}</div></div></div>

        <div className="card inventory-card"><div className="card-header"><div><span className="eyebrow">INVENTORY</span><h3>背包物品</h3></div><span className="soft-badge">{inventory.length} 类</span></div>{inventory.length ? <div className="inventory-grid">{inventory.map((item) => <div className="inventory-item" key={item.name}><span className="item-pixel">▦</span><div><strong>{item.name.replaceAll('_', ' ')}</strong><small>数量 ×{item.count}</small></div></div>)}</div> : <p className="muted">机器人上线后会显示背包内容。</p>}</div>
      </div>
    </div>
  </>;
}
function Vital({ label, value, max, color }: { label: string; value: number; max: number; color: string }) { return <div className="vital"><div><span>{label}</span><strong>{value}<small>/{max}</small></strong></div><span className="vital-track"><i className={color} style={{ width: `${Math.min(100, Math.max(0, value / max * 100))}%` }} /></span></div>; }
function EmptyState({ openAdd }: { openAdd: () => void }) { return <div className="empty-state"><div className="empty-art">♟</div><h2>还没有机器人</h2><p>创建第一个机器人，开始管理你的 Minecraft 自动化工作台。</p><button className="primary" onClick={openAdd}>＋ 添加第一个机器人</button></div>; }

export default App;
