import { translate, type Locale } from './i18n.ts';
import { checkDiagram, type Diagram, type DiagramNode, type Project } from './model.ts';

const literal = (s: string) => s.replace(/\\/g, '<U+005C>').replace(/"/g, '<U+0022>').replace(/[\r\n]+/g, '\\n').replace(/!/g, '<U+0021>');
const quoted = (s: string) => `"${literal(s)}"`;
const member = (s: string) => s.replace(/[{}!@]/g, c => `<U+${c.charCodeAt(0).toString(16).padStart(4, '0')}>`);

export function toPlantUml(d: Diagram, locale: Locale = 'sl'): string {
  const frames = d.nodes.filter(n => n.data.kind === 'frame');
  d = { ...d, nodes: d.nodes.filter(n => n.data.kind !== 'frame') };
  const aliases = new Map(d.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ['@startuml', `title ${literal(d.name)}`, 'skinparam shadowing false'];
  for (const frame of frames) {
    lines.push(`' ${translate(locale, 'comment')}: ${literal(frame.data.label)}`);
    for (const line of [frame.data.body, frame.data.description].filter(Boolean).join('\n').split(/\r?\n/)) lines.push(`' ${member(line)}`);
  }
  if (d.id === 'activity') {
    const issues = checkDiagram(d, locale);
    if (issues.length) throw new Error(issues.join('\n'));
    const declared = new Set<string>();
    const emitted = new Set<string>();
    const queue = [d.nodes.find(n => n.data.kind === 'start')!];
    const byId = new Map(d.nodes.map(n => [n.id, n]));
    const ref = (n: DiagramNode): string => {
      const alias = aliases.get(n.id)!;
      if (n.data.kind === 'start' || n.data.kind === 'end') return '(*)';
      if (n.data.kind === 'fork' || n.data.kind === 'join') return `===${alias}===`;
      if (declared.has(n.id)) return alias;
      declared.add(n.id);
      return `${quoted(n.data.label)} as ${alias}`;
    };
    function emit(source: string, e: Diagram['edges'][number]) {
      if (emitted.has(e.id)) return;
      emitted.add(e.id);
      const target = byId.get(e.target)!;
      const label = e.data?.label ? `[${literal(e.data.label).replace(/[\[\]]/g, '')}]` : '';
      if (target.data.kind === 'decision' && !declared.has(target.id)) {
        declared.add(target.id);
        lines.push(`${source} -->${label} if ${quoted(target.data.label)} as ${aliases.get(target.id)} then`);
        const branches = d.edges.filter(link => link.source === target.id);
        emit('', branches[0]);
        lines.push('else');
        emit('', branches[1]);
        lines.push('endif');
      } else {
        lines.push(`${source} -->${label} ${ref(target)}`);
        queue.push(target);
      }
    }
    const visited = new Set<string>();
    while (queue.length) {
      const n = queue.shift()!;
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      for (const e of d.edges.filter(link => link.source === n.id)) emit(ref(n), e);
    }
    // shortcut: legacy activities carry body and descriptions as source comments; use attached notes when activity note placement is added.
    for (const n of d.nodes) for (const text of [n.data.body, n.data.description].filter(Boolean)) for (const line of text.split(/\r?\n/)) lines.push(`' ${literal(n.data.label)}: ${member(line)}`);
  } else {
    lines.push('allowmixing', 'skinparam classAttributeIconSize 0', 'skinparam linetype ortho', 'hide empty members');
    const groups = [...new Set(d.nodes.map(n => n.data.group))];
    for (const group of groups) {
      if (group) lines.push(`package ${quoted(group)} {`);
      for (const n of d.nodes.filter(n => n.data.group === group)) {
        const { kind, label, body, stereotype } = n.data;
        const alias = aliases.get(n.id)!;
        if (kind === 'note') {
          lines.push(`note ${quoted([label, body].filter(Boolean).join('\n'))} as ${alias}`);
          continue;
        }
        const tag = stereotype ? ` <<${literal(stereotype).replace(/[<>]/g, '')}>>` : '';
        lines.push(`${kind} ${quoted(label)} as ${alias}${tag}${body ? ' {' : ''}`);
        if (body) lines.push(...body.split('\n').map(s => `  ${member(s)}`), '}');
      }
      if (group) lines.push('}');
    }
    for (const e of d.edges) {
      const data = e.data!;
      lines.push(`${aliases.get(e.source)}${data.sourceCardinality ? ` ${quoted(data.sourceCardinality)}` : ''} ${data.relation}${data.targetCardinality ? ` ${quoted(data.targetCardinality)}` : ''} ${aliases.get(e.target)}${data.label ? ` : ${literal(data.label)}` : ''}`);
    }
    for (const n of d.nodes) if (n.data.description) lines.push(`note right of ${aliases.get(n.id)} : ${literal(n.data.description)}`);
  }
  return [...lines, '@enduml'].join('\n');
}

export function toAiPrompt(project: Project, locale: Locale = 'sl'): string {
  const diagrams = project.diagrams.filter(d => d.nodes.length).map(d => {
    const content = d.nodes.some(n => n.data.kind !== 'frame')
      ? `\`\`\`plantuml\n${toPlantUml(d, locale)}\n\`\`\``
      : d.nodes.map(n => `### ${n.data.label}\n${n.data.body}\n${n.data.description}`).join('\n\n');
    return `## ${d.name}\n\n${content}`;
  }).join('\n\n');
  return `# ${project.name}\n\n## ${translate(locale, 'promptGoal')}\n${project.goal || translate(locale, 'promptMissingGoal')}\n\n${diagrams}\n\n## ${translate(locale, 'promptTask')}\n${translate(locale, 'promptInstructions')}\n`;
}
