'use client';

import { I18nProvider, useI18n } from './i18n';
import { translate, errorText } from './lib/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Handle, Position, Background, Controls, BaseEdge, EdgeLabelRenderer, getSmoothStepPath, applyNodeChanges, applyEdgeChanges, useReactFlow, type NodeProps, type EdgeProps, type Connection, type NodeChange } from '@xyflow/react';
import CommentFrame from './comment-frame';
import AiAssistant from './ai-assistant';
import { applyAiProposal } from './lib/ai';
import { kinds, modes, palette, relations, initialProject, parseProject, checkDiagram, node, type DiagramNode, type DiagramEdge, type ElementData, type LinkData, type Project, type Mode, type Kind, type Relation } from './lib/model';
import { toPlantUml } from './lib/plantuml';

const STORAGE_KEY = 'umlith-workspace-v1';
const THEME_KEY = 'umlith-theme';
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    graph: <><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v9H14M10 6h7.5v9"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>, code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>,
    undo: <path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12"/>, redo: <path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>,
    check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>, trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
    file: <><path d="M14 2H5v20h14V7zM14 2v5h5"/></>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    class: <><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18"/></>,
    entity: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
    action: <rect x="3" y="6" width="18" height="12" rx="4"/>, decision: <path d="m12 2 10 10-10 10L2 12z"/>,
    start: <circle cx="12" cy="12" r="7"/>, end: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/></>,
    fork: <path d="M4 12h16M12 4v8M6 12v8m12-8v8"/>, join: <path d="M4 12h16M12 12v8M6 4v8m12-8v8"/>,
    component: <><rect x="5" y="3" width="16" height="18" rx="1"/><path d="M2 7h6v3H2zM2 14h6v3H2z"/></>,
    note: <><path d="M14 3H4v18h16V9zM14 3v6h6M8 13h8M8 17h5"/></>, interface: <><circle cx="12" cy="8" r="5"/><path d="M12 13v8M6 21h12"/></>, enum: <><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 7h10M7 12h7M7 17h10"/></>,
    frame: <><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/><path d="M3 9h18M7 6h7"/></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.graph}</svg>;
}

function UmlNode(props: NodeProps<DiagramNode>) {
  const { t } = useI18n();
  const { data, selected } = props;
  if (data.kind === 'frame') return <CommentFrame {...props} />;
  const small = ['start', 'end', 'fork', 'join'].includes(data.kind);
  return <div className={`uml-node kind-${data.kind} ${selected ? 'is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} aria-label={t('inputConnection')} />
    {small ? <span className="sr-only">{data.label}</span> : data.kind === 'decision' ? <strong>{data.label}</strong> : <>
      <div className="node-heading"><Icon name={data.kind} size={16}/><span>{data.label || t('unnamed')}</span></div>
      {(data.group || data.stereotype || data.kind === 'interface') && <div className="node-stereotype">{data.stereotype || data.group || t('kindInterface')}</div>}
      {data.body && <pre className="node-members">{data.body}</pre>}
      {data.description && <div className="node-description">{data.description}</div>}
    </>}
    <Handle type="source" position={Position.Right} aria-label={t('outputConnection')} />
  </div>;
}
function UmlEdge(props: EdgeProps<DiagramEdge>) {
  const { id, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const [path, x, y] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 });
  const relation = data?.relation || '-->';
  const diamond = relation === '*--' || relation === 'o--';
  return <>
    <BaseEdge id={id} path={path} className={`${selected ? 'selected-edge' : ''} ${relation.startsWith('..') ? 'dashed-edge' : ''}`} markerStart={diamond ? `url(#${relation === '*--' ? 'composition' : 'aggregation'})` : undefined} markerEnd={relation.includes('|>') ? 'url(#inheritance)' : relation.endsWith('>') ? 'url(#arrow)' : undefined}/>
    <EdgeLabelRenderer>
      {data?.label && <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}>{data.label}</div>}
      {data?.sourceCardinality && <div className="edge-cardinality" style={{ transform: `translate(${sourceX + 14}px,${sourceY - 22}px)` }}>{data.sourceCardinality}</div>}
      {data?.targetCardinality && <div className="edge-cardinality" style={{ transform: `translate(${targetX - 38}px,${targetY - 22}px)` }}>{data.targetCardinality}</div>}
    </EdgeLabelRenderer>
  </>;
}
const nodeTypes = { uml: UmlNode };
const edgeTypes = { uml: UmlEdge };
function saveFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Workspace() {
  const { locale, setLocale, t } = useI18n();
  const [initialLocale] = useState(locale);
  const [project, setProject] = useState<Project>(() => initialProject(locale));
  const [mode, setMode] = useState<Mode>('architecture');
  const [panel, setPanel] = useState<'properties' | 'code' | 'checks'>('properties');
  const [selection, setSelection] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 });
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const dragBefore = useRef<Project | null>(null);
  const resizeBefore = useRef<Project | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const flow = useReactFlow<DiagramNode, DiagramEdge>();
  const diagram = project.diagrams.find(d => d.id === mode)!;
  const selectedNode = selection?.kind === 'node' ? diagram.nodes.find(n => n.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? diagram.edges.find(e => e.id === selection.id) : undefined;
  const issues = checkDiagram(diagram, locale);
  let source = '', sourceError = '';
  try { source = toPlantUml(diagram, locale); } catch (e) { sourceError = errorText(e, locale); }

  useEffect(() => {
    queueMicrotask(() => {
      let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      try { const saved = localStorage.getItem(THEME_KEY); if (saved === 'dark' || saved === 'light') theme = saved; } catch { /* The theme still works without storage. */ }
      document.documentElement.dataset.theme = theme;
      setDark(theme === 'dark');
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('diagram');
      if (tab && Object.hasOwn(modes, tab)) setMode(tab as Mode);
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setProject(parseProject(JSON.parse(saved)));
      } catch {
        setStorageBlocked(true);
        setError(translate(initialLocale, 'storageUnavailable'));
      }
      setReady(true);
    });
  }, [initialLocale]);
  useEffect(() => {
    if (!ready || storageBlocked) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parseProject(project))); }
      catch { setStorageBlocked(true); setError(t('storageFailed')); }
    }, 300);
    return () => clearTimeout(timer);
  }, [project, ready, storageBlocked, t]);
  useEffect(() => {
    if (!ready) return;
    const saveBeforeLeave = () => {
      if (!storageBlocked) try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parseProject(project))); } catch { /* The visible save warning covers storage failures. */ }
    };
    window.addEventListener('pagehide', saveBeforeLeave);
    return () => window.removeEventListener('pagehide', saveBeforeLeave);
  }, [project, ready, storageBlocked]);

  useEffect(() => {
    if (!ready) return;
    const canvas = document.querySelector('.canvas');
    if (!canvas) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => flow.fitView({ padding: 0.15, maxZoom: 1 }));
    });
    observer.observe(canvas);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, flow]);

  const remember = useCallback((before: Project) => {
    past.current = [...past.current.slice(-49), before]; future.current = []; setHistoryCounts({ past: past.current.length, future: future.current.length });
  }, []);
  function change(next: Project) { remember(project); setProject(next); setMessage(''); }
  function updateDiagram(update: Partial<typeof diagram>) { change({ ...project, diagrams: project.diagrams.map(d => d.id === mode ? { ...d, ...update } : d) }); }
  function editNode(data: Partial<ElementData>) { if (selectedNode) updateDiagram({ nodes: diagram.nodes.map(n => n.id === selectedNode.id ? { ...n, data: { ...n.data, ...data } } : n) }); }
  function editEdge(data: Partial<LinkData>) { if (selectedEdge) updateDiagram({ edges: diagram.edges.map(e => e.id === selectedEdge.id ? { ...e, data: { ...e.data!, ...data } } : e) }); }
  function resizeFrame(dimension: 'width' | 'height', value: number) {
    if (selectedNode?.data.kind !== 'frame') return;
    if (value === selectedNode[dimension]) return;
    if (!Number.isFinite(value) || value < (dimension === 'width' ? 280 : 160) || value > 10000) {
      setError(t('frameSizeRange'));
      return;
    }
    updateDiagram({ nodes: diagram.nodes.map(n => n.id === selectedNode.id ? { ...n, [dimension]: value } : n) });
  }
  function handleNodesChange(changes: NodeChange<DiagramNode>[]) {
    if (changes.some(c => c.type === 'dimensions' && c.resizing === true) && !resizeBefore.current) resizeBefore.current = project;
    if (changes.some(c => c.type === 'dimensions' && c.resizing === false) && resizeBefore.current) {
      remember(resizeBefore.current);
      resizeBefore.current = null;
    }
    setProject(p => ({
      ...p,
      diagrams: p.diagrams.map(d => d.id === mode ? {
        ...d,
        nodes: applyNodeChanges(changes.filter(c => c.type !== 'select' && c.type !== 'remove'), d.nodes),
      } : d),
    }));
  }
  function undo(redo = false) {
    const from = redo ? future : past; const to = redo ? past : future;
    const next = from.current.pop(); if (!next) return;
    to.current.push(project); setProject(next); setSelection(null); setHistoryCounts({ past: past.current.length, future: future.current.length });
  }
  function switchMode(id: Mode) {
    setMode(id); setSelection(null); setMessage('');
    const url = new URL(window.location.href); url.searchParams.set('diagram', id); window.history.replaceState({}, '', url);
    setTimeout(() => flow.fitView({ padding: 0.15 }), 100);
  }
  function addNode(kind: Kind) {
    if (diagram.nodes.length >= 500) { setError(t('nodeLimit')); return; }
    const bounds = document.querySelector('.canvas')!.getBoundingClientRect();
    const position = flow.screenToFlowPosition({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const id = crypto.randomUUID();
    const created = node(id, kind, t(kinds[kind]), position.x - (kind === 'frame' ? 300 : 110), position.y - (kind === 'frame' ? 180 : 40), ['class', 'entity', 'interface'].includes(kind) ? '+ id: String' : '');
    if (kind === 'frame') {
      const enclosed = selectedNode && selectedNode.data.kind !== 'frame'
        ? [selectedNode]
        : diagram.nodes.filter(n => n.data.kind !== 'frame');
      if (enclosed.length) {
        const bounds = flow.getNodesBounds(enclosed);
        created.position = { x: bounds.x - 40, y: bounds.y - 120 };
        created.width = Math.min(10000, Math.max(600, bounds.width + 80));
        created.height = Math.min(10000, Math.max(360, bounds.height + 160));
      }
    }
    updateDiagram({ nodes: [...diagram.nodes, created] }); setSelection({ kind: 'node', id }); setPanel('properties');
  }
  function connect(c: Connection) {
    if (!c.source || !c.target || diagram.edges.length >= 2000) return;
    if (diagram.nodes.some(n => (n.id === c.source || n.id === c.target) && n.data.kind === 'frame')) return;
    if (diagram.edges.some(e => e.source === c.source && e.target === c.target)) return;
    updateDiagram({ edges: [...diagram.edges, { ...c, id: crypto.randomUUID(), type: 'uml', data: { relation: mode === 'architecture' ? '..>' : mode === 'er' ? '--' : '-->', label: '', sourceCardinality: '', targetCardinality: '' } }] });
  }
  function removeSelected() {
    if (!selection) return;
    updateDiagram({ nodes: diagram.nodes.filter(n => !(selection.kind === 'node' && n.id === selection.id)), edges: diagram.edges.filter(e => !(selection.kind === 'edge' && e.id === selection.id) && !(selection.kind === 'node' && (e.source === selection.id || e.target === selection.id))) });
    setSelection(null); setMessage('');
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage(t('copied')); }
    catch { setError(t('copyFailed')); }
  }
  async function importProject(file?: File) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error(t('fileTooLarge'));
      const imported = parseProject(JSON.parse(await file.text()));
      change(imported); setSelection(null); setStorageBlocked(false); setError(''); setMessage(t('projectOpened'));
      setTimeout(() => flow.fitView({ padding: 0.15 }), 100);
    } catch (e) { setError(e instanceof SyntaxError ? t('invalidProjectJson') : errorText(e, locale)); }
    if (fileInput.current) fileInput.current.value = '';
  }
  function aiPrompt() {
    setAiOpen(true);
  }
  function toggleTheme() {
    const theme = dark ? 'light' : 'dark';
    setDark(!dark);
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* Keep the selected theme for this page. */ }
  }

  if (!ready) return <main className="workspace" aria-busy="true"/>;

  return <main className="workspace">
    <header className="topbar">
      <Link className="wordmark" href="/" aria-label={t('home')}><span className="brand-mark"><Icon name="graph" size={23}/></span>UMLith</Link>
      <span className="project-divider"/>
      <input className="project-name" aria-label={t('projectName')} value={project.name} onChange={e => change({ ...project, name: e.target.value })}/>
      <span className={`save-state ${storageBlocked ? 'error-text' : ''}`}>{storageBlocked ? t('exportToSave') : t('savedLocally')}</span>
      <div className="topbar-actions">
        <button className="quiet-button theme-toggle" aria-pressed={dark} aria-label={t('darkMode')} title={t(dark ? 'lightMode' : 'darkMode')} onClick={toggleTheme}><Icon name={dark ? 'sun' : 'moon'}/><span>{t(dark ? 'lightMode' : 'darkMode')}</span></button>
        <select className="language-select" aria-label={t('language')} value={locale} onChange={e => setLocale(e.target.value as typeof locale)}><option value="sl">SL</option><option value="en">EN</option></select>
        <button className="quiet-button" aria-label={t('newProject')} title={t('newProject')} onClick={() => {
          change({ version: 1, name: t('newProject'), goal: '', diagrams: project.diagrams.map(d => ({ id: d.id, name: t(modes[d.id]), nodes: [], edges: [] })) });
          setSelection(null); setPanel('properties');
        }}><Icon name="plus"/><span>{t('new')}</span></button>
        <button className="quiet-button" aria-label={t('openProject')} title={t('openProject')} onClick={() => fileInput.current?.click()}><Icon name="file"/><span>{t('open')}</span></button>
        <button className="quiet-button" aria-label={t('saveJson')} title={t('saveJson')} onClick={() => saveFile(`${project.name || t('projectFile')}.json`, JSON.stringify(parseProject(project), null, 2), 'application/json')}><Icon name="download"/><span>{t('saveJson')}</span></button>
        <button className="primary-button" aria-label={t('aiArchitecture')} title={t('aiArchitecture')} onClick={aiPrompt}><Icon name="code"/><span>{t('aiArchitecture')}</span></button>
      </div>
      <input hidden tabIndex={-1} type="file" accept=".json,application/json" ref={fileInput} onChange={e => importProject(e.target.files?.[0])}/>
    </header>

    <div className="workspace-nav">
      <nav className="diagram-tabs" aria-label={t('diagramType')}>{(Object.keys(modes) as Mode[]).map(id => <button key={id} aria-current={mode === id ? 'page' : undefined} onClick={() => switchMode(id)}><Icon name={id === 'architecture' ? 'component' : id === 'er' ? 'entity' : 'fork'}/>{t(modes[id])}<span className="tab-count">{project.diagrams.find(d => d.id === id)!.nodes.length}</span></button>)}</nav>
    </div>

    <div className="workbench">
      <aside className="library" aria-label={t('elementLibrary')}>
        <div className="panel-heading"><h2>{t('elements')}</h2><span>{palette[mode].length}</span></div>
        <div className="palette">{palette[mode].map(kind => <button key={kind} className="palette-item" onClick={() => addNode(kind)}><span className="palette-symbol"><Icon name={kind} size={24}/></span><span>{t(kinds[kind])}</span><Icon name="plus" size={14}/></button>)}</div>

      </aside>

      <section className="canvas-column" aria-label={t('diagramEditor')}>
        <div className="canvas-toolbar">
          <div className="diagram-title"><span className="diagram-number">{mode === 'architecture' ? '01' : mode === 'er' ? '02' : '03'}</span><input aria-label={t('diagramName')} value={diagram.name} onChange={e => updateDiagram({ name: e.target.value })}/></div>
          <div className="history-actions"><button className="icon-button" title={t('undo')} aria-label={t('undo')} disabled={!historyCounts.past} onClick={() => undo()}><Icon name="undo"/></button><button className="icon-button" title={t('redo')} aria-label={t('redo')} disabled={!historyCounts.future} onClick={() => undo(true)}><Icon name="redo"/></button><button className="icon-button" title={t('deleteSelected')} aria-label={t('deleteSelected')} disabled={!selection} onClick={removeSelected}><Icon name="trash"/></button></div>
        </div>
        <div className="canvas">
          <ReactFlow<DiagramNode, DiagramEdge>
            colorMode={dark ? 'dark' : 'light'}
            key={mode} nodes={diagram.nodes.map(n => ({ ...n, selected: selection?.kind === 'node' && n.id === selection.id }))} edges={diagram.edges.map(e => ({ ...e, selected: selection?.kind === 'edge' && e.id === selection.id }))}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes} onConnect={connect} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={2} deleteKeyCode={null}
            onNodesChange={handleNodesChange} elevateNodesOnSelect={false}
            onEdgesChange={changes => setProject(p => ({ ...p, diagrams: p.diagrams.map(d => d.id === mode ? { ...d, edges: applyEdgeChanges(changes.filter(c => c.type !== 'select' && c.type !== 'remove'), d.edges) } : d) }))}
            onNodeDragStart={() => { dragBefore.current = project; }} onNodeDragStop={() => { if (dragBefore.current) remember(dragBefore.current); dragBefore.current = null; }}
            onNodeClick={(_, n) => { setSelection({ kind: 'node', id: n.id }); setPanel('properties'); }}
            onEdgeClick={(_, e) => { setSelection({ kind: 'edge', id: e.id }); setPanel('properties'); }}
            onPaneClick={() => setSelection(null)} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': t('zoomIn'), 'controls.zoomOut.ariaLabel': t('zoomOut'), 'controls.fitView.ariaLabel': t('fitView'), 'node.a11yDescription.default': t('flowDescription'), 'node.a11yDescription.keyboardDisabled': t('flowDescription'), 'edge.a11yDescription.default': t('flowEdgeDescription'), 'controls.ariaLabel': t('canvasControls'), 'handle.ariaLabel': t('connection'), 'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t('flowMoved', { direction: t(direction === 'left' ? 'left' : direction === 'right' ? 'right' : direction === 'up' ? 'up' : 'down'), x, y }) }} aria-label={`${t(modes[mode])}: ${diagram.name}`}>
            <Background gap={24} size={1}/><Controls showInteractive={false}/>
            <svg className="edge-definitions" aria-hidden="true"><defs>
              <marker id="arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto"><path d="m2 2 8 4-8 4"/></marker>
              <marker id="inheritance" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="m2 1 9 5-9 5z"/></marker>
              <marker id="composition" viewBox="0 0 16 12" refX="1" refY="6" markerWidth="13" markerHeight="13" orient="auto"><path d="m1 6 6-4 6 4-6 4z"/></marker>
              <marker id="aggregation" viewBox="0 0 16 12" refX="1" refY="6" markerWidth="13" markerHeight="13" orient="auto"><path d="m1 6 6-4 6 4-6 4z"/></marker>
            </defs></svg>
          </ReactFlow>
          {!diagram.nodes.length && <div className="empty-canvas"><Icon name="graph" size={40}/><button className="primary-button" onClick={() => addNode(palette[mode][0])}><Icon name="plus"/>{t('addElement')}</button></div>}
        </div>
        <footer className="canvas-footer"><span>{t('diagramCounts', { nodes: diagram.nodes.length, edges: diagram.edges.length })}</span><button className="text-button" onClick={() => { setPanel('checks'); }}><Icon name={issues.length ? 'graph' : 'check'} size={14}/>{issues.length ? t('warningCount', { count: issues.length }) : t('structureChecked')}</button></footer>
      </section>

      <aside className="inspector" aria-label={t('propertiesExport')}>
        <nav className="inspector-tabs" aria-label={t('sidePanel')}>{(['properties', 'code', 'checks'] as const).map(tab => <button key={tab} aria-current={panel === tab ? 'page' : undefined} onClick={() => setPanel(tab)}>{tab === 'properties' ? t('properties') : tab === 'code' ? t('plantUml') : t('checks')}</button>)}</nav>
        <div className="inspector-content">
          {panel === 'properties' && (selectedNode ? <>
            <div className="inspector-title"><Icon name={selectedNode.data.kind}/><h2>{t(kinds[selectedNode.data.kind])}</h2><button className="icon-button" aria-label={t('clearSelection')} onClick={() => setSelection(null)}><Icon name="close" size={15}/></button></div>
            <label>{selectedNode.data.kind === 'frame' ? t('sectionTitle') : t('name')}<input value={selectedNode.data.label} onChange={e => editNode({ label: e.target.value })}/></label>
            {selectedNode.data.kind === 'frame' ? <>
              <label>{t('comment')}<textarea rows={6} value={selectedNode.data.body} onChange={e => editNode({ body: e.target.value })} placeholder={t('sectionPlaceholder')}/></label>
              <div className="cardinality-fields">
                {(['width', 'height'] as const).map(dimension => <label key={dimension}>
                  {dimension === 'width' ? t('width') : t('height')}
                  <input key={`${selectedNode.id}-${selectedNode[dimension]}`} type="number" min={dimension === 'width' ? 280 : 160} max={10000} step={20} defaultValue={selectedNode[dimension]} onBlur={e => {
                    const value = e.currentTarget.valueAsNumber;
                    resizeFrame(dimension, value);
                    e.currentTarget.value = String(selectedNode[dimension]);
                  }}/>
                </label>)}
              </div>
              <p className="field-help">{t('frameHelp')}</p>
            </> : <>
            {!['start', 'end', 'fork', 'join', 'decision'].includes(selectedNode.data.kind) && <>
              <label>{t('layerPackage')}<input value={selectedNode.data.group} onChange={e => editNode({ group: e.target.value })} placeholder={t('servicePlaceholder')}/></label>
              <label>{t('stereotype')}<input value={selectedNode.data.stereotype} onChange={e => editNode({ stereotype: e.target.value })} placeholder={t('controllerPlaceholder')}/></label>
              <label>{['note', 'action'].includes(selectedNode.data.kind) ? t('text') : t('members')}<textarea className="members-input" rows={8} value={selectedNode.data.body} onChange={e => editNode({ body: e.target.value })} spellCheck={false}/></label>
              {selectedNode.data.kind !== 'action' && <p className="field-help">{t('membersHelp')}</p>}
            </>}
            <label>{t('descriptionRules')}<textarea rows={4} value={selectedNode.data.description} onChange={e => editNode({ description: e.target.value })} placeholder={t('elementRulesPlaceholder')}/></label>
            <label>{t('connectTo')}<select value="" onChange={e => { if (e.target.value) connect({ source: selectedNode.id, target: e.target.value, sourceHandle: null, targetHandle: null }); }}><option value="">{t('selectTarget')}</option>{diagram.nodes.filter(n => n.data.kind !== 'frame' && n.id !== selectedNode.id && !diagram.edges.some(e => e.source === selectedNode.id && e.target === n.id)).map(n => <option key={n.id} value={n.id}>{n.data.label}</option>)}</select></label>
            </>}
          </> : selectedEdge ? <>
            <div className="inspector-title"><Icon name="arrow"/><h2>{t('connection')}</h2></div>
            <p className="connection-names">{diagram.nodes.find(n => n.id === selectedEdge.source)?.data.label}<Icon name="arrow"/>{diagram.nodes.find(n => n.id === selectedEdge.target)?.data.label}</p>
            <label>{t('label')}<input value={selectedEdge.data?.label || ''} onChange={e => editEdge({ label: e.target.value })}/></label>
            {mode !== 'activity' && <><label>{t('relationType')}<select value={selectedEdge.data?.relation} onChange={e => editEdge({ relation: e.target.value as Relation })}>{Object.entries(relations).map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}</select></label><div className="cardinality-fields"><label>{t('source')}<input value={selectedEdge.data?.sourceCardinality || ''} placeholder="1" onChange={e => editEdge({ sourceCardinality: e.target.value })}/></label><label>{t('target')}<input value={selectedEdge.data?.targetCardinality || ''} placeholder="0..*" onChange={e => editEdge({ targetCardinality: e.target.value })}/></label></div><p className="field-help">{t('cardinalityHelp')}</p></>}
          </> : <>

            <label>{t('projectGoal')}<textarea rows={8} value={project.goal} onChange={e => change({ ...project, goal: e.target.value })} placeholder={t('goalPlaceholder')}/></label>

          </>)}
          {panel === 'code' && <>
            <div className="inspector-title"><Icon name="code"/><h2>{t('plantUml')}</h2></div>
            {sourceError ? <p className="inline-error">{sourceError}</p> : <><textarea className="source-code" aria-label={t('plantUmlCode')} value={source} readOnly spellCheck={false}/><div className="export-actions"><button className="secondary-button" onClick={() => copy(source)}><Icon name="copy"/>{t('copy')}</button><button className="primary-button" onClick={() => saveFile(`${mode}.puml`, source, 'text/plain')}><Icon name="download"/>.puml</button></div></>}
          </>}
          {panel === 'checks' && <>
            <div className="inspector-title"><Icon name="check"/><h2>{t('structureChecks')}</h2></div>
            <p className="inspector-intro">{t('checksHelp')}</p>
            {issues.length ? <ul className="issue-list">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul> : <p className="check-success"><Icon name="check"/>{t('checksPassed')}</p>}
            <p className="field-help">{t('aiChecksHelp')}</p><button className="secondary-button" onClick={aiPrompt}><Icon name="code"/>{t('openAi')}</button>
          </>}
        </div>
      </aside>
    </div>
    {(error || message) && <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}><span>{errorText(error || message, locale)}</span><button className="icon-button" aria-label={t('closeNotice')} onClick={() => { setError(''); setMessage(''); }}><Icon name="close"/></button></div>}
    <AiAssistant open={aiOpen} project={project} onClose={() => setAiOpen(false)} onDownload={prompt => saveFile('architecture-prompt.md', prompt, 'text/markdown')} onApply={(base, result) => {
      change(applyAiProposal(project, base, result, locale)); setSelection(null); setError('');
      setMessage(t('proposalApplied'));
      setTimeout(() => flow.fitView({ padding: 0.15 }), 100);
    }}/>
  </main>;
}
export default function Editor() { return <I18nProvider><ReactFlowProvider><Workspace/></ReactFlowProvider></I18nProvider>; }
