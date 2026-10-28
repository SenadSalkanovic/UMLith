import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messages, translate, resolveLocale, errorText } from '../app/lib/i18n.ts';
import { initialProject, parseProject, checkDiagram, node } from '../app/lib/model.ts';
import { toAiPrompt, toPlantUml } from '../app/lib/plantuml.ts';
import { parseAiRequest, buildAiPrompt, applyAiProposal } from '../app/lib/ai.ts';
import { POST, GET } from '../app/api/ai/route.ts';

test('both catalogs cover the same messages and interpolation values', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.sl).sort());
  for (const key of Object.keys(messages.sl)) {
    for (const locale of ['sl', 'en']) assert.ok(messages[locale][key].trim(), `${locale}.${key}`);
    assert.deepEqual(messages.sl[key].match(/\{\w+\}/g), messages.en[key].match(/\{\w+\}/g), key);
  }
  assert.equal(translate('en', 'diagramCounts', { nodes: 2, edges: 1 }), 'Elements: 2 / Connections: 1');
  assert.equal(resolveLocale('en-GB'), 'en');
  assert.equal(resolveLocale(null), 'sl');
  assert.equal(resolveLocale('de'), 'sl');
  assert.equal(errorText(new Error(messages.sl.invalidProject), 'en'), messages.en.invalidProject);
});

test('localized checks and exports preserve all user-authored model content', () => {
  const project = initialProject('en');
  project.name = 'Moj model'; project.goal = 'Moje zahteve';
  const diagram = project.diagrams[2];
  diagram.nodes.push(node('orphan', 'action', 'Moje opravilo', 0, 0));
  const before = structuredClone(project);
  assert.match(checkDiagram(diagram, 'en').join('\n'), /Moje opravilo: unreachable from the start/);
  assert.throws(() => toPlantUml(diagram, 'en'), /unreachable/);
  assert.match(checkDiagram(diagram, 'sl').join('\n'), /ni dosegljiv/);
  assert.deepEqual(project, before);
  assert.deepEqual(parseProject(project, 'en'), project);
  assert.throws(() => parseProject({}, 'en'), /Invalid UMLith project/);
  diagram.nodes.pop();
  const prompt = toAiPrompt(project, 'en');
  assert.match(prompt, /## Goal\nMoje zahteve/);
  assert.match(prompt, /## Task/);
  assert.match(prompt, /# Moj model/);
  assert.match(initialProject('en').diagrams[0].name, /Order architecture/);
});

test('AI language survives request validation and keeps proposal guards', () => {
  const project = initialProject();
  const request = parseAiRequest({ action: 'review', prompt: 'Review this', project, locale: 'en' });
  assert.equal(request.locale, 'en');
  assert.match(buildAiPrompt(request), /Respond in English/);
  assert.match(buildAiPrompt(request), /Findings, Missing items/);
  assert.match(buildAiPrompt({ ...request, locale: 'sl' }), /Respond in Slovenian/);
  assert.throws(() => parseAiRequest({ ...request, locale: 'de' }, 'en'), /Invalid language/);
  const edited = { ...project, name: 'Edited by user' };
  assert.throws(() => applyAiProposal(edited, project, { summary: 'OK', project }, 'en'), /preserve manual edits/);
});

test('HTTP errors honor the selected language without weakening origin checks', async () => {
  const request = (body, locale = 'en', origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/ai', { method: 'POST', headers: { Origin: origin, 'Accept-Language': locale }, body });
  const denied = await POST(request('{}', 'en', 'https://evil.example'));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, messages.en.localOnly);
  assert.equal((await (await POST(request('invalid JSON'))).json()).error, messages.en.invalidJson);
  assert.equal((await (await POST(request('invalid JSON', 'sl'))).json()).error, messages.sl.invalidJson);
  const missing = await GET(new Request('http://localhost:3000/api/ai?id=invalid', { headers: { 'Accept-Language': 'en' } }));
  assert.equal((await missing.json()).error, messages.en.invalidRequestId);
});
