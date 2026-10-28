import { translate, errorText, resolveLocale } from '../../lib/i18n.ts';
import { parseAiRequest, type AiProvider } from '../../lib/ai.ts';
import { limitedText, runAi } from '../../lib/ai-provider.ts';
import { join } from 'node:path';
import { createAiJob, getAiJob, cancelAiJob } from '../../lib/ai-store.ts';

const t = translate.bind(null, 'sl');

function checkOrigin(request: Request) {
  const internal = new URL(request.url);
  const url = new URL(`${internal.protocol}//${request.headers.get('host') || internal.host}`);
  const origin = request.headers.get('origin');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new Error(t('localOnly'));
  if (request.method !== 'GET' && origin !== url.origin) throw new Error(t('missingOrigin'));
}

export async function POST(request: Request) {
  const locale = resolveLocale(request.headers.get('accept-language'));
  try { checkOrigin(request); }
  catch (e) { return Response.json({ error: errorText(e, locale) }, { status: 403 }); }
  let input, task;
  try {
    input = JSON.parse(await limitedText(request));
    if (!['codex', 'claude', 'local', 'mcp'].includes(input.provider) || (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 200))) throw new Error(t('invalidProvider'));
    task = parseAiRequest(input, locale);
  } catch (e) { return Response.json({ error: e instanceof SyntaxError ? translate(locale, 'invalidJson') : errorText(e, locale) }, { status: 400 }); }
  try {
    const provider = input.provider as AiProvider;
    if (provider === 'mcp') return Response.json(await createAiJob(task));
    return Response.json({ request: task, result: await runAi(provider, task, input.model?.trim() || '', request.signal) });
  } catch (e) { return Response.json({ error: errorText(e, locale) }, { status: 502 }); }
}

export async function GET(request: Request) {
  const locale = resolveLocale(request.headers.get('accept-language'));
  try { checkOrigin(request); }
  catch (e) { return Response.json({ error: errorText(e, locale) }, { status: 403 }); }
  try {
    if (new URL(request.url).searchParams.has('setup')) return Response.json({ script: join(process.cwd(), 'scripts/umlith-mcp.mjs') });
    return Response.json(await getAiJob(new URL(request.url).searchParams.get('id') || ''), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (e) { return Response.json({ error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? translate(locale, 'mcpMissing') : errorText(e, locale) }, { status: 404 }); }
}

export async function DELETE(request: Request) {
  const locale = resolveLocale(request.headers.get('accept-language'));
  try { checkOrigin(request); }
  catch (e) { return Response.json({ error: errorText(e, locale) }, { status: 403 }); }
  try { await cancelAiJob(new URL(request.url).searchParams.get('id') || ''); return Response.json({ cancelled: true }); }
  catch (e) { return Response.json({ error: errorText(e, locale) }, { status: 400 }); }
}
