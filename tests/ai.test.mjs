import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { initialProject, node } from '../app/lib/model.ts';
import { applyAiProposal, buildAiPrompt, parseAiRequest, parseAiResult, MAX_AI_BYTES } from '../app/lib/ai.ts';
import { createAiJob, getAiJob, listAiJobs, completeAiJob, cancelAiJob } from '../app/lib/ai-store.ts';
import { limitedText, localAiUrl, runAi } from '../app/lib/ai-provider.ts';
import { POST, GET, DELETE } from '../app/api/ai/route.ts';

const task = (action = 'generate') => ({ action, prompt: 'Aplikacija za naročila', project: initialProject() });
async function temporary(t, variable) {
  const directory = await mkdtemp(join(tmpdir(), 'umlith-test-'));
  const before = process.env[variable]; process.env[variable] = directory;
  t.after(async () => { if (before === undefined) delete process.env[variable]; else process.env[variable] = before; await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('AI proposals validate graph references and cannot overwrite intervening edits', () => {
  const base = initialProject(), proposed = initialProject(); proposed.name = 'AI predlog';
  const result = parseAiResult({ summary: 'Predlog', project: proposed }, 'generate');
  const applied = applyAiProposal(base, base, result);
  assert.equal(applied.name, 'AI predlog'); assert.equal(base.name, 'Process Order');
  const edited = structuredClone(base); edited.diagrams[0].nodes[0].data.label = 'Moje delo';
  assert.throws(() => applyAiProposal(edited, base, result), /spremenil/);
  const measured = structuredClone(base); measured.diagrams[0].nodes[0].measured = { width: 100, height: 100 };
  assert.equal(applyAiProposal(measured, base, result).name, 'AI predlog');
  proposed.diagrams[0].edges[0].target = 'missing';
  assert.throws(() => parseAiResult({ summary: 'Napačno', project: proposed }, 'generate'), /povezava/);
});

test('review accepts incomplete activities and never returns an applicable project', () => {
  const request = task('review'); request.project.diagrams[2].nodes.push(node('orphan', 'action', 'Pozabljen korak', 0, 0));
  assert.match(buildAiPrompt(parseAiRequest(request)), /Pozabljen korak/);
  assert.match(buildAiPrompt(request), /dosegljiv/);
  const result = parseAiResult({ summary: 'Manjka povezava.', project: initialProject() }, 'review');
  assert.deepEqual(result, { summary: 'Manjka povezava.' });
  assert.throws(() => applyAiProposal(request.project, request.project, result), /ne spreminja/);
  for (const bad of [null, {}, { summary: '' }, { summary: 'x'.repeat(20001) }]) assert.throws(() => parseAiResult(bad, 'review'));
  for (const prompt of ['', ' ', 'x'.repeat(20001)]) assert.throws(() => parseAiRequest({ ...request, prompt }));
  assert.throws(() => parseAiRequest({ ...request, action: 'execute' }));
});

test('MCP requests survive reads, reject competing answers and can be cancelled', async t => {
  await temporary(t, 'UMLITH_AI_DIR');
  const job = await createAiJob(task());
  assert.equal((await listAiJobs())[0].id, job.id);
  assert.deepEqual((await getAiJob(job.id)).request, task());
  const results = await Promise.allSettled([completeAiJob(job.id, { summary: 'A', project: initialProject() }), completeAiJob(job.id, { summary: 'B', project: initialProject() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await listAiJobs()).length, 0);
  await cancelAiJob(job.id);
  await assert.rejects(() => getAiJob(job.id));
  await assert.rejects(() => getAiJob('../../etc/passwd'), /ID/);
});

test('real MCP stdio transport returns a review to the stored app request', async t => {
  const directory = await temporary(t, 'UMLITH_AI_DIR');
  const job = await createAiJob(task('review'));
  const calls = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'umlith_get_request', arguments: { id: job.id } } },
    { id: 4, method: 'tools/call', params: { name: 'umlith_submit_result', arguments: { id: job.id, result: { summary: 'Preveri transakcije.' } } } },
    { id: 5, method: 'tools/call', params: { name: 'umlith_get_request', arguments: { id: '../escape' } } },
  ];
  const stdout = await new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, ['--experimental-strip-types', resolve('scripts/umlith-mcp.mjs')], { cwd: tmpdir(), env: { ...process.env, UMLITH_AI_DIR: directory }, maxBuffer: MAX_AI_BYTES }, (e, stdout) => e ? reject(e) : resolvePromise(stdout));
    child.stdin.end(calls.map(c => JSON.stringify({ jsonrpc: '2.0', ...c })).join('\n') + '\n');
  });
  const replies = stdout.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(replies.length, 5);
  assert.equal(replies[0].result.serverInfo.name, 'umlith');
  assert.equal(replies[1].result.tools.length, 3);
  assert.match(replies[2].result.content[0].text, /Response JSON schema/);
  assert.equal(replies[4].result.isError, true);
  assert.equal((await getAiJob(job.id)).result.summary, 'Preveri transakcije.');
});

test('HTTP boundary protects local AI and allows MCP submit, read and cancel', async t => {
  await temporary(t, 'UMLITH_AI_DIR');
  const request = (body, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/ai', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await POST(request({ ...task(), provider: 'mcp' }, 'https://evil.example'))).status, 403);
  assert.equal((await POST(request({ ...task(), provider: 'shell' }))).status, 400);
  assert.equal((await POST(request({ ...task(), provider: 'mcp', model: {} }))).status, 400);
  const response = await POST(request({ ...task(), provider: 'mcp' }));
  assert.equal(response.status, 200);
  const job = await response.json();
  await completeAiJob(job.id, { summary: 'Arhitektura', project: initialProject() });
  const read = await GET(new Request(`http://localhost:3000/api/ai?id=${job.id}`));
  assert.equal((await read.json()).result.project.version, 1);
  assert.equal((await DELETE(new Request(`http://localhost:3000/api/ai?id=${job.id}`, { method: 'DELETE', headers: { Origin: 'http://localhost:3000' } }))).status, 200);
  assert.equal((await GET(new Request(`http://localhost:3000/api/ai?id=${job.id}`))).status, 404);
  const aliased = new Request('http://localhost:3000/api/ai', { method: 'POST', headers: { Origin: 'http://127.0.0.1:3000', Host: '127.0.0.1:3000' }, body: JSON.stringify({ ...task(), provider: 'mcp' }) });
  assert.equal((await POST(aliased)).status, 200);
});

test('local model receives project context and malformed responses fail visibly', async t => {
  let content = JSON.stringify({ summary: 'Manjka preverjanje zaloge.' }), status = 200;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.match(JSON.parse(body).messages[0].content, /OrderController/);
    assert.equal(JSON.parse(body).model, 'test-model');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const before = process.env.UMLITH_LOCAL_URL;
  process.env.UMLITH_LOCAL_URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  t.after(() => { server.closeAllConnections(); server.close(); if (before === undefined) delete process.env.UMLITH_LOCAL_URL; else process.env.UMLITH_LOCAL_URL = before; });
  assert.match((await runAi('local', task('review'), 'test-model', new AbortController().signal)).summary, /zaloge/);
  content = 'not JSON'; await assert.rejects(() => runAi('local', task('review'), 'test-model', new AbortController().signal), /JSON/);
  status = 404; await assert.rejects(() => runAi('local', task('review'), 'test-model', new AbortController().signal), /HTTP 404/);
  for (const url of ['http://example.com/api', 'file:///tmp/test', 'http://user:password@localhost:1234/api']) { process.env.UMLITH_LOCAL_URL = url; assert.throws(() => localAiUrl(), /lokalni/); }
  await assert.rejects(() => limitedText(new Response('x'.repeat(MAX_AI_BYTES + 1))), /prevelik/);
});

test('CLI adapters use isolated cwd and stdin, decode structured outputs and report aborts', async t => {
  const directory = await temporary(t, 'UMLITH_TEST_BIN');
  const oldPath = process.env.PATH; process.env.PATH = `${directory}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  const fake = `#!${process.execPath}\nconst fs = require('node:fs'); const assert = require('node:assert/strict'); let input = ''; process.stdin.on('data', s => input += s); process.stdin.on('end', () => { assert.match(input, /OrderController/); assert.notEqual(process.cwd(), ${JSON.stringify(process.cwd())}); const args = process.argv.slice(2); if (args.includes('--output-last-message')) { assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ summary: 'Codex review' })); } else { assert.equal(args[args.indexOf('--tools') + 1], ''); console.log(JSON.stringify({ structured_output: { summary: 'Claude review' } })); } });`;
  for (const binary of ['codex', 'claude']) await writeFile(join(directory, binary), fake, { mode: 0o700 });
  for (const provider of ['codex', 'claude']) assert.match((await runAi(provider, task('review'), '', new AbortController().signal)).summary, /review/);
  await writeFile(join(directory, 'codex'), `#!${process.execPath}\nsetTimeout(() => {}, 20000);`, { mode: 0o700 });
  await assert.rejects(() => runAi('codex', task('review'), '', AbortSignal.timeout(100)), /preklicano/);
  await writeFile(join(directory, 'claude'), `#!${process.execPath}\nprocess.stderr.write('Please login'); process.exit(1);`, { mode: 0o700 });
  await assert.rejects(() => runAi('claude', task('review'), '', new AbortController().signal), /Please login/);
});
