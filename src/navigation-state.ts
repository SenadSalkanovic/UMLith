import { ownerId } from '../shared/plantuml';
import type { Graph, ProgramNode } from '../shared/model';
export type Workspace = 'design' | 'build';
export type DesignView = 'overview' | 'classes' | 'database';
export type DetailTab = 'description' | 'flowchart' | 'rules';
export interface Destination {
  graphContext: 'intended' | 'implemented';
  workspace: Workspace; designView: DesignView; activeScope: string | null;
  selectedId: string | null; selectedType: 'node' | 'edge' | null;
  detailTab: DetailTab; flowchartId: string | null; selectedField: string | null;
}
export const defaultDestination: Destination = {
  graphContext: 'intended', workspace: 'design', designView: 'classes', activeScope: null,
  selectedId: null, selectedType: null, detailTab: 'description', flowchartId: null, selectedField: null,
};
export { ownerId, visibleDesignNodes } from '../shared/plantuml';
export function readDestination(search: string, projectId: string, graph: Graph): Destination {
  const params = new URLSearchParams(search);
  if (params.get('project') && params.get('project') !== projectId) return { ...defaultDestination };
  const node = graph.nodes.find(n => n.id === params.get('selection'));
  const edge = graph.edges.find(e => e.id === params.get('selection'));
  const view = params.get('view');
  const detail = params.get('detail');
  return {
    graphContext: params.get('workspace') === 'build' && params.get('context') === 'implemented' ? 'implemented' : 'intended',
    workspace: params.get('workspace') === 'build' ? 'build' : 'design',
    designView: view === 'overview' || view === 'database' ? view : 'classes',
    activeScope: graph.nodes.some(n => n.id === params.get('scope') && ['system', 'module', 'class', 'interface', 'function', 'step'].includes(n.kind)) ? params.get('scope') : null,
    selectedId: node?.id || edge?.id || null, selectedType: node ? 'node' : edge ? 'edge' : null,
    detailTab: detail === 'rules' || detail === 'flowchart' ? detail : 'description',
    selectedField: node?.fields.some(field => field.name === params.get('field')) ? params.get('field') : null,
    flowchartId: graph.nodes.some(n => n.kind === 'function' && n.id === params.get('flow')) ? params.get('flow') : null,
  };
}
export function destinationUrl(url: URL, projectId: string, state: Destination): URL {
  const next = new URL(url);
  for (const [key, value] of Object.entries({ project: projectId, workspace: state.workspace, context: state.graphContext, view: state.designView, scope: state.activeScope, selection: state.selectedId, type: state.selectedType, detail: state.detailTab, flow: state.flowchartId, field: state.selectedField })) {
    if (value) next.searchParams.set(key, value); else next.searchParams.delete(key);
  }
  return next;
}
export function selectionDestination(graph: Graph, id: string) {
  const node = graph.nodes.find(n => n.id === id);
  if (!node) return { selectedId: null, selectedType: null } as const;
  if (node.kind === 'step') {
    let parentId = ownerId(graph, node);
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const owner = graph.nodes.find(n => n.id === parentId);
      if (!owner) break;
      if (owner.kind === 'function') return { selectedId: id, selectedType: 'node' as const, activeScope: owner.id, designView: 'classes' as const, flowchartId: owner.id, selectedField: null };
      parentId = ownerId(graph, owner);
    }
  }
  const parent = graph.nodes.find(n => n.id === ownerId(graph, node));
  const isMember = node.kind === 'function' && parent && ['class', 'interface'].includes(parent.kind);
  return {
    selectedId: id, selectedType: 'node' as const,
    activeScope: isMember ? ownerId(graph, parent!) : ownerId(graph, node),
    designView: (node.kind === 'entity' ? 'database' : node.kind === 'system' || node.kind === 'module' ? 'overview' : 'classes') as DesignView,
    flowchartId: null, selectedField: null,
  };
}
