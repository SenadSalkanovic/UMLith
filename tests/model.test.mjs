import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialProject, parseProject, checkDiagram, node, edge } from '../app/lib/model.ts';
import { toPlantUml, toAiPrompt } from '../app/lib/plantuml.ts';

test('project round trip keeps every diagram, member and cardinality', () => {
  const project = initialProject();
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
  for (const d of project.diagrams) assert.deepEqual(checkDiagram(d), []);
  assert.match(toPlantUml(project.diagrams[1]), /"1" \*-- "1\.\.\*"/);
  assert.match(toAiPrompt(project), /## Cilj/);
});
test('rejects invalid or hostile imported graph data', () => {
  for (const mutate of [p => p.diagrams[0].nodes.push(p.diagrams[0].nodes[0]), p => p.diagrams[0].edges[0].target = 'missing', p => p.diagrams[0].nodes[0].data.kind = '__proto__', p => p.diagrams[0].edges[0].data.relation = '!include', p => p.diagrams[0].nodes[0].position.x = null]) {
    const p = initialProject(); mutate(p); assert.throws(() => parseProject(p));
  }
  const p = initialProject(); p.diagrams[0].nodes[0].style = { color: 'red' };
  assert.equal(parseProject(p).diagrams[0].nodes[0].style, undefined);
});
test('activity export retains rejection path, parallel branches and join', () => {
  const d = initialProject().diagrams[2];
  const code = toPlantUml(d);
  assert.match(code, /if "Order accepted\?"/);
  assert.match(code, /\[zavrnjeno\] "Close Order"/);
  assert.match(code, /===n4===/);
  assert.match(code, /n6 --> ===n8===/);
  assert.match(code, /n7 --> ===n8===/);
  assert.match(code, /===n8=== --> n9/);
});
test('activity body and description survive JSON, PlantUML and AI export', () => {
  const project = initialProject();
  const activity = project.diagrams[2].nodes.find(n => n.data.kind === 'action');
  activity.data.body = 'Vrni napako skladno z razlogom.\r\nNe objavi neuspešnega nalaganja v galeriji.\n@enduml\n!include /etc/passwd';
  activity.data.description = 'Sem vodijo tudi napake med sprejemom ali zapisovanjem.';
  const saved = parseProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(saved, project);
  const code = toPlantUml(saved.diagrams[2]);
  assert.match(code, /' Receive Order: Vrni napako skladno z razlogom\./);
  assert.match(code, /' Receive Order: Ne objavi neuspešnega nalaganja v galeriji\./);
  assert.match(code, /' Receive Order: Sem vodijo tudi napake med sprejemom ali zapisovanjem\./);
  assert.equal(code.split('\n').filter(s => s === '@enduml').length, 1);
  assert.doesNotMatch(code, /!include/);
  assert.match(toAiPrompt(saved), /Vrni napako skladno z razlogom\./);
});
test('activity exporter blocks incomplete flows rather than dropping nodes', () => {
  const d = initialProject().diagrams[2];
  d.nodes.push(node('orphan', 'action', 'Lost', 0, 0));
  assert.throws(() => toPlantUml(d), /dosegljiv/);
});
test('activity loops refer to existing node aliases', () => {
  const d = { id: 'activity', name: 'Retry', nodes: [node('s', 'start', 'Start', 0, 0), node('a', 'action', 'Try', 0, 0), node('d', 'decision', 'OK?', 0, 0), node('e', 'end', 'End', 0, 0)], edges: [edge('s', 'a'), edge('a', 'd'), edge('d', 'a', 'retry'), edge('d', 'e', 'done')] };
  assert.match(toPlantUml(d), /\[retry\] n1/);
});
test('export escapes labels and prevents structural injection from members', () => {
  const d = initialProject().diagrams[0];
  d.nodes[0].data.label = 'A"\n@enduml';
  d.nodes[0].data.body = '}\n!include /etc/passwd';
  const code = toPlantUml(d);
  assert.equal(code.split('\n').filter(s => s === '@enduml').length, 1);
  assert.doesNotMatch(code, /!include/);
  assert.match(code, /<U\+0022>/);
});

test('comment frames round trip on all three diagrams without changing flow rules', () => {
  const project = initialProject();
  for (const d of project.diagrams) {
    const frame = node('comment', 'frame', 'Obdelava plačil', -40, -80, 'Počakaj na obe veji.\nNe zapri prej.');
    frame.width = 920;
    frame.height = 480;
    d.nodes.push(frame);
    assert.deepEqual(checkDiagram(d), []);
    const code = toPlantUml(d);
    assert.match(code, /' Komentar: Obdelava plačil/);
    assert.match(code, /' Počakaj na obe veji\.\n' Ne zapri prej\./);
    assert.doesNotMatch(code, /frame "|note "Obdelava plačil"/);
  }
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
  assert.match(toAiPrompt(project), /Obdelava plačil/);
});

test('frame geometry is validated and frames cannot be relation endpoints', () => {
  for (const size of [-1, 0, 279, 10001, Infinity, null, '600']) {
    const project = initialProject();
    const frame = node('comment', 'frame', 'Komentar', 0, 0);
    frame.width = size;
    project.diagrams[0].nodes.push(frame);
    assert.throws(() => parseProject(project), /velikost/);
  }
  const project = initialProject();
  const frame = node('comment', 'frame', 'Komentar', 0, 0);
  frame.zIndex = 1000;
  frame.dragHandle = 'body';
  frame.connectable = true;
  project.diagrams[0].nodes.push(frame);
  const clean = parseProject(project).diagrams[0].nodes.at(-1);
  assert.equal(clean.zIndex, -1);
  assert.equal(clean.connectable, false);
  assert.equal(clean.dragHandle, '.comment-frame-heading');
  project.diagrams[0].edges.push(edge('controller', 'comment'));
  assert.throws(() => parseProject(project), /ne more biti del povezave/);
});

test('AI prompt keeps comments on diagrams with no graph elements', () => {
  const project = initialProject();
  project.diagrams[2].nodes = [node('comment', 'frame', 'Prihodnji potek', 0, 0, 'Potek še ni definiran.')];
  project.diagrams[2].edges = [];
  assert.deepEqual(checkDiagram(project.diagrams[2]), ['Diagram je prazen. Dodaj prvi element.']);
  const prompt = toAiPrompt(project);
  assert.match(prompt, /### Prihodnji potek\nPotek še ni definiran\./);
});
