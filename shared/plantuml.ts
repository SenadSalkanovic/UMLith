import type { Graph, ProgramNode, ProgramEdge } from './model';
type DesignView = 'overview' | 'classes' | 'database';
export function ownerId(graph: Graph, node: ProgramNode): string | null {
  return node.parentId || graph.edges.find(e => e.kind === 'contains' && e.target === node.id)?.source || null;
}
export function visibleDesignNodes(graph: Graph, view: DesignView, scope: string | null, functionId?: string | null): ProgramNode[] {
  const inScope = (node: ProgramNode) => {
    if (!scope) return true;
    let id = ownerId(graph, node);
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      if (id === scope) return true;
      seen.add(id);
      const parent = graph.nodes.find(n => n.id === id);
      id = parent ? ownerId(graph, parent) : null;
    }
    return false;
  };
  if (functionId) return graph.nodes.filter(n => n.kind === 'step' && visibleDesignNodesInFunction(graph, n, functionId));
  return graph.nodes.filter(n => (inScope(n) || n.id === scope && ['class','interface'].includes(n.kind)) && (
    view === 'overview' ? ['system', 'module'].includes(n.kind) :
    view === 'database' ? ['entity', 'enum'].includes(n.kind) :
    ['class', 'interface', 'enum'].includes(n.kind) || n.kind === 'function' && !['class', 'interface'].includes(graph.nodes.find(p => p.id === ownerId(graph, n))?.kind || '')
  ));
}
function visibleDesignNodesInFunction(graph: Graph, node: ProgramNode, functionId: string): boolean {
  const seen = new Set<string>();
  let parentId = ownerId(graph, node);
  while (parentId && !seen.has(parentId)) {
    if (parentId === functionId) return true;
    seen.add(parentId);
    const parent = graph.nodes.find(n => n.id === parentId);
    parentId = parent ? ownerId(graph, parent) : null;
  }
  return false;
}

// Encode user text before inserting it into PlantUML syntax or Creole markup.
const text = (value: string) => value.replace(/[\r\n\t]/g, ' ').replace(/[\\"\[\]{}<>!@]/g, c => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
const quoted = (value: string) => '"' + text(value) + '"';
const url = (kind: 'node' | 'edge' | 'field', id: string, field?: string) => `umlith://${kind}/${encodeURIComponent(id)}${field === undefined ? '' : '/' + encodeURIComponent(field)}`;
const visibility = (value?: ProgramNode['visibility']) => value === 'public' ? '+' : value === 'private' ? '-' : value === 'protected' ? '#' : value === 'package' ? '~' : '';
export function displayMethod(node: ProgramNode) {
  return node.signature ? `${node.name}(${node.signature.parameters.map(p => `${p.name}${p.optional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ')})${node.signature.returnType ? ': ' + node.signature.returnType : ''}` : node.contract ? `${node.name} ${node.contract}` : `${node.name}()`;
}
function erEnd(value: string | undefined, source: boolean) {
  if (!value) return source ? '|' : '|';
  const many = value === '*' || value.endsWith('..*') || Number(value.split('..').at(-1)) > 1;
  const optional = value === '*' || value.startsWith('0');
  return source ? `${many ? '}' : '|'}${optional ? 'o' : '|'}` : `${optional ? 'o' : '|'}${many ? '{' : '|'}`;
}
export interface DiagramRequest { graph: Graph; view: DesignView; scopeId?: string | null; functionId?: string | null; selectedId?: string | null }
export function graphToPlantUml({graph,view,scopeId = null,functionId,selectedId}: DiagramRequest): string {
  const nodes = visibleDesignNodes(graph, view, scopeId, functionId);
  const aliases = new Map(nodes.map((node,index) => [node.id, `n${index}`]));
  const lines = ['@startuml', '!pragma layout smetana', 'skinparam backgroundColor #0A0A0A', 'skinparam defaultFontColor #FAFAFA', 'skinparam defaultFontName SansSerif', 'skinparam defaultFontSize 14', 'skinparam shadowing false', 'skinparam roundcorner 2', 'skinparam classAttributeIconSize 0', 'skinparam hyperlinkColor #FAFAFA', 'skinparam hyperlinkUnderline 1', 'skinparam ArrowColor #A3A3A3', 'skinparam classBackgroundColor #171717', 'skinparam classBorderColor #A3A3A3', 'skinparam classFontColor #FAFAFA', 'skinparam classAttributeFontColor #FAFAFA', 'skinparam stateBackgroundColor #171717', 'skinparam stateBorderColor #A3A3A3', 'skinparam componentBackgroundColor #171717', 'skinparam componentBorderColor #A3A3A3', 'skinparam packageBackgroundColor #111111', 'skinparam packageBorderColor #A3A3A3'];
  if (!nodes.length) return [...lines, 'title No elements in this view yet', '@enduml'].join('\n');
  for (const node of nodes) {
    const alias = aliases.get(node.id)!;
    const name = node.name + (node.provenance === 'ai' ? ' [AI inferred]' : node.provenance === 'human' ? '' : ` [${node.provenance}]`);
    const selected = node.id === selectedId || graph.nodes.some(member => member.id === selectedId && ownerId(graph, member) === node.id);
    const color = selected ? ' #222222;line:FF3D00' : '';
    if (functionId) {
      if (node.stepType === 'condition') {
        lines.push(`state ${alias} <<choice>>`, `url of ${alias} is [[${url('node',node.id)}]]`, `note top of ${alias} : ${text(name)}`);
      } else lines.push(`state ${quoted(name)} as ${alias} [[${url('node',node.id)}]]${color}`, `${alias} : ${text(node.stepType || 'operation')}`);
      if (!graph.edges.some(edge => ['next','true','false','exception'].includes(edge.kind) && edge.target === node.id)) lines.push(`[*] --> ${alias}`);
      if (node.stepType === 'return' || node.stepType === 'throw') lines.push(`${alias} --> [*]`);
      continue;
    }
    if (view === 'overview') {
      lines.push(`${node.kind === 'system' ? 'node' : node.moduleRole === 'database' ? 'database' : 'component'} ${quoted(name)} as ${alias}${node.moduleRole ? ' <<'+node.moduleRole+'>>' : ''} [[${url('node',node.id)}]]${color}`);
      continue;
    }
    const kind = node.kind === 'entity' ? 'entity' : node.kind === 'interface' ? 'interface' : node.kind === 'enum' ? 'enum' : node.isAbstract ? 'abstract class' : 'class';
    lines.push(`${kind} ${quoted(name)} as ${alias} [[${url('node',node.id)}]]${color} {`);
    if (node.kind === 'function') lines.push(`  {method} ${text(displayMethod(node))} [[[${url('node',node.id)}]]]`);
    for (const field of node.fields) lines.push(`  {field} ${field.isStatic ? '{static} ' : ''}${visibility(field.visibility)} ${text(field.name)}${field.type ? ': ' + text(field.type) : ''}${field.optional ? ' ?' : ''}${field.key ? ' <<'+text(field.key)+'>>' : ''}${field.defaultValue ? ' = '+text(field.defaultValue) : ''} [[[${url('field',node.id,field.name)}]]]`);
    if (node.kind === 'entity') for (const key of [...(node.compositeKeys || []), ...(node.indexes || [])]) lines.push(`  {field} ${key.type} (${key.fields.map(text).join(', ')})`);
    const methods = graph.nodes.filter(member => member.kind === 'function' && ownerId(graph, member) === node.id);
    if (methods.length) lines.push('  --');
    for (const member of methods) lines.push(`  {method} ${member.isStatic ? '{static} ' : ''}${member.isAbstract ? '{abstract} ' : ''}${visibility(member.visibility)} ${text(displayMethod(member))} [[[${url('node',member.id)}]]]`);
    lines.push('}');
  }
  if (view === 'overview') for (const node of nodes) { const parent=ownerId(graph,node); if(parent && aliases.has(parent)) lines.push(`${aliases.get(parent)} -- ${aliases.get(node.id)} : owns`); }
  for (const edge of graph.edges) {
    const source = aliases.get(edge.source), target = aliases.get(edge.target);
    if (!source || !target || edge.kind === 'contains' && view !== 'overview') continue;
    if (functionId && !['next','true','false','exception'].includes(edge.kind)) continue;
    let arrow = functionId ? '-->' : edge.kind === 'inherits' ? '--|>' : edge.kind === 'implements' ? '..|>' : edge.kind === 'composes' ? '*--' : edge.kind === 'aggregates' ? 'o--' : edge.kind === 'relates-to' && edge.sourceEndpoint?.multiplicity && edge.targetEndpoint?.multiplicity ? erEnd(edge.sourceEndpoint.multiplicity,true)+'--'+erEnd(edge.targetEndpoint.multiplicity,false) : edge.kind === 'relates-to' ? '--' : edge.kind === 'depends-on' ? '..>' : edge.kind === 'associates-with' ? (edge.sourceEndpoint?.navigable ? '<' : '')+'--'+(edge.targetEndpoint?.navigable ? '>' : '') : '-->';
    const endpoint = (value: ProgramEdge['sourceEndpoint']) => value ? ' '+quoted([value.multiplicity,value.role].filter(Boolean).join(' ')) : '';
    if (edge.uncertain || edge.provenance === 'ai') arrow = arrow.replace('--', '-[#FACC15,dashed]-').replace('..', '.[#FACC15].');
    const label = [edge.label || edge.kind, ...(edge.uncertain ? ['[uncertain]'] : []), ...(edge.provenance !== 'human' ? ['[' + edge.provenance + ']'] : []), ...(edge.sourceFields ? [edge.sourceFields.join(', ')+' → '+edge.targetFields?.join(', ')] : [])].join(' · ');
    lines.push(functionId ? `${source} ${arrow} ${target} : [[${url('edge',edge.id)} ${text(label)}]]` : `${source}${endpoint(edge.sourceEndpoint)} ${arrow}${endpoint(edge.targetEndpoint)} ${target} [[${url('edge',edge.id)}]] : ${text(label)}`);
  }
  return [...lines,'@enduml'].join('\n');
}
