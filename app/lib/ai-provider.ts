import { translate } from './i18n.ts';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiResultSchema, buildAiPrompt, MAX_AI_BYTES, parseAiResult, type AiProvider, type AiRequest } from './ai.ts';

const t = translate.bind(null, 'sl');

export async function limitedText(response: Response | Request): Promise<string> {
  if (!response.body) throw new Error(t('emptyResponse'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AI_BYTES) throw new Error(t('aiSizeLimit'));
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

function parseJson(text: string) {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1')); }
  catch { throw new Error(t('modelInvalidJson')); }
}

export function localAiUrl() {
  const url = new URL(process.env.UMLITH_LOCAL_URL || 'http://127.0.0.1:11434/v1/chat/completions');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error(t('localUrlInvalid'));
  return url;
}

export async function runAi(provider: Exclude<AiProvider, 'mcp'>, request: AiRequest, model: string, signal: AbortSignal) {
  const t = translate.bind(null, request.locale || 'sl');
  signal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const prompt = buildAiPrompt(request);
  if (provider === 'local') {
    if (!model.trim()) throw new Error(t('loadedModelRequired'));
    const response = await fetch(localAiUrl(), {
      method: 'POST', signal, redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(t('localHttpError', { status: response.status })); }
    const envelope = parseJson(await limitedText(response));
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(t('localNoText'));
    return parseAiResult(parseJson(content), request.action, request.locale || 'sl');
  }

  const directory = await mkdtemp(join(tmpdir(), 'umlith-ai-'));
  try {
    const schema = aiResultSchema(request.action);
    const schemaPath = join(directory, 'schema.json');
    const outputPath = join(directory, 'result.json');
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const args = provider === 'codex'
      ? ['exec', '--ignore-user-config', '--disable', 'shell_tool', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath, ...(model ? ['--model', model] : []), '-']
      : ['--print', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema), ...(model ? ['--model', model] : [])];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(provider, args, { cwd: directory, signal, killSignal: 'SIGKILL', maxBuffer: MAX_AI_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          let detail = stderr.trim().slice(-1500);
          if (!detail && provider === 'claude') try { const result = JSON.parse(stdout).result; if (typeof result === 'string') detail = result.slice(-1500); } catch { /* Some CLI failures have no JSON envelope. */ }
          reject(new Error(signal.aborted ? t('aiTimeout') : `${provider}: ${error.code === 'ENOENT' ? t('cliMissing') : detail || t('cliNoAnswer', { code: String(error.code) })}`));
        }
        else resolve(stdout);
      });
      child.stdin?.on('error', () => { /* Process exit is handled by the execFile callback. */ });
      child.stdin?.end(prompt);
    });
    if (provider === 'codex') return parseAiResult(parseJson(await readFile(outputPath, 'utf8')), request.action, request.locale || 'sl');
    const envelope = parseJson(stdout);
    if (envelope.is_error) throw new Error(t('claudeFailed'));
    return parseAiResult(envelope.structured_output ?? parseJson(envelope.result || ''), request.action, request.locale || 'sl');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
