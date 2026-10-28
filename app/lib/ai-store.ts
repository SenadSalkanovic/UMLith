import { translate } from './i18n.ts';
import { mkdir, readFile, readdir, writeFile, rename, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseAiRequest, parseAiResult, MAX_AI_BYTES, type AiRequest, type AiJob } from './ai.ts';

const t = translate.bind(null, 'sl');

// Runtime user data must never be traced into the production bundle.
export function aiDirectory() { return resolve(/* turbopackIgnore: true */ process.env.UMLITH_AI_DIR || '.umlith/ai'); }
function jobPath(id: string, suffix: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(t('invalidRequestId'));
  return join(aiDirectory(), `${id}.${suffix}.json`);
}
async function readJson(path: string) { return JSON.parse(await readFile(path, 'utf8')); }

export async function createAiJob(request: AiRequest): Promise<AiJob> {
  const job = { id: randomUUID(), request: parseAiRequest(request) };
  await mkdir(aiDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(jobPath(job.id, 'temporary'), JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  await rename(jobPath(job.id, 'temporary'), jobPath(job.id, 'request'));
  return job;
}
export async function getAiJob(id: string): Promise<AiJob> {
  const job = await readJson(jobPath(id, 'request')) as AiJob;
  job.request = parseAiRequest(job.request);
  try { job.result = parseAiResult(await readJson(jobPath(id, 'result')), job.request.action); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return job;
}
export async function listAiJobs() {
  let files: string[];
  try { files = await readdir(/* turbopackIgnore: true */ aiDirectory()); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const pending = [];
  for (const file of files.filter(f => f.endsWith('.request.json'))) {
    try {
      const job = await getAiJob(file.slice(0, -'.request.json'.length));
      if (!job.result) pending.push({ id: job.id, action: job.request.action, name: job.request.project.name, prompt: job.request.prompt.slice(0, 200) });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return pending;
}
export async function completeAiJob(id: string, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_AI_BYTES) throw new Error(t('resultTooLarge'));
  const job = await getAiJob(id);
  const result = parseAiResult(value, job.request.action);
  const temporary = jobPath(randomUUID(), 'temporary');
  try {
    await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
    // A hard link publishes a complete answer atomically and never replaces another client's answer.
    await link(temporary, jobPath(id, 'result'));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t('alreadyAnswered')); throw e; }
  finally { await rm(temporary, { force: true }); }
  return { ...job, result };
}

export async function cancelAiJob(id: string) {
  await rm(jobPath(id, 'request'), { force: true });
  await rm(jobPath(id, 'result'), { force: true });
}
