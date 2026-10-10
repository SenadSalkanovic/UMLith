import {EventEmitter} from 'node:events';
import chokidar,{type FSWatcher} from 'chokidar';
import {basename,relative} from 'node:path';
import type {Analysis} from '../shared/model';
import {graphDelta,emptyGraph,GRAPH_SCHEMA_VERSION,AnalysisSchema,GraphUpdateSchema} from '../shared/model';
import {AnalysisWorker} from './worker';
import {ProjectStore} from './store';
import {captureFiles,hashes,isPathExcluded} from './files';

export interface SyncServiceOptions {
 watch?: boolean;
 debounceMs?: number;
 stabilityThreshold?: number;
 pollInterval?: number;
 reconcileIntervalMs?: number;
}

export function isGeneratedOrTemporaryFile(filePath: string): boolean {
 if (!filePath) return false;
 const name = basename(filePath);
 return (
  /\.(?:tmp|temp|bak|swp|swo|swx)(?:\.|$)/i.test(name) ||
  name.endsWith('~') ||
  name.startsWith('.#') ||
  (name.startsWith('#') && name.endsWith('#')) ||
  name.includes('___jb_tmp___') ||
  name.includes('___jb_old___') ||
  name === '.DS_Store' ||
  name === 'Thumbs.db'
 );
}

export function isRelevantAnalysisInput(filePath: string): boolean {
 if (!filePath) return false;
 const norm = filePath.replace(/\\/g, '/');
 const name = basename(norm);

 if (isPathExcluded(norm) || isGeneratedOrTemporaryFile(norm)) {
  return false;
 }

 // 1. TypeScript source & declaration files (.ts, .tsx, .mts, .cts, .d.ts, .d.mts, .d.cts)
 if (/\.(?:[cm]?ts|tsx)$/i.test(name)) {
  return true;
 }

 // 2. Prisma schemas (.prisma)
 if (/\.prisma$/i.test(name)) {
  return true;
 }

 // 3. TypeScript project configurations (tsconfig*.json)
 if (/tsconfig[^/]*\.json$/i.test(name)) {
  return true;
 }

 // 4. Dependency manifests (package.json)
 if (name === 'package.json') {
  return true;
 }

 // 5. Dependency lockfiles
 if (/^(?:package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(name) || /lock/i.test(name)) {
  return true;
 }

 // 6. Resolution / JSON configuration inputs
 if (/\.json$/i.test(name)) {
  return true;
 }

 return false;
}

export function areHashesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
 const aKeys = Object.keys(a);
 const bKeys = Object.keys(b);
 if (aKeys.length !== bKeys.length) return false;
 for (const k of aKeys) {
  if (a[k] !== b[k]) return false;
 }
 return true;
}

type Session = {
 worker: AnalysisWorker;
 watcher?: FSWatcher;
 generation: number;
 running?: Promise<void>;
 debounce?: ReturnType<typeof setTimeout>;
 timer?: ReturnType<typeof setInterval>;
 closed: boolean;
};

export class SyncService extends EventEmitter {
 private sessions = new Map<string, Session>();
 constructor(public store: ProjectStore, private options: SyncServiceOptions = {}) {
  super();
 }

 async start(id: string): Promise<void> {
  if (this.sessions.has(id)) return this.request(id);
  const project = await this.store.get(id);
  const session: Session = { worker: new AnalysisWorker(), generation: 0, closed: false };
  this.sessions.set(id, session);

  if (this.options.watch !== false) {
   const watcher = chokidar.watch(project.root, {
    ignoreInitial: true,
    awaitWriteFinish: {
     stabilityThreshold: this.options.stabilityThreshold ?? 150,
     pollInterval: this.options.pollInterval ?? 50,
    },
    atomic: true,
    ignored: (targetPath: string) => {
     if (targetPath === project.root) return false;
     const rel = relative(project.root, targetPath).replace(/\\/g, '/');
     if (!rel || rel === '.') return false;
     if (isPathExcluded(rel) || isGeneratedOrTemporaryFile(rel)) return true;
     return false;
    },
   });
   session.watcher = watcher;

   const schedule = (event?: string, filePath?: string) => {
    if (session.closed) return;
    const rel = filePath ? relative(project.root, filePath).replace(/\\/g, '/') : undefined;
    this.emit('change', id, { event, path: rel });
    clearTimeout(session.debounce);
    const debounceMs = this.options.debounceMs ?? 300;
    session.debounce = setTimeout(() => {
     if (session.closed) return;
     this.emit('reconcile-scheduled', id, { event, path: rel });
     void this.request(id).catch(error =>
      this.emit('notification', id, { type: 'error', message: error.message })
     );
    }, debounceMs);
   };

   watcher.on('all', (event, filePath) => {
    if (session.closed) return;
    const rel = relative(project.root, filePath).replace(/\\/g, '/');
    if (isPathExcluded(rel) || isGeneratedOrTemporaryFile(rel)) return;
    const isDir = event === 'addDir' || event === 'unlinkDir';
    if (!isDir && !isRelevantAnalysisInput(rel)) return;
    schedule(event, filePath);
   });

   watcher.on('error', (err) => {
    this.emit('watcher-error', id, err);
    void this.reconcile(id).catch(error =>
     this.emit('notification', id, { type: 'error', message: error.message })
    );
   });

   const reconcileInterval = this.options.reconcileIntervalMs ?? 60000;
   session.timer = setInterval(
    () => void this.reconcile(id).catch(error =>
     this.emit('notification', id, { type: 'error', message: error.message })
    ),
    reconcileInterval
   );
   session.timer.unref();

   await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
     if (!resolved) {
      resolved = true;
      resolve();
     }
    };
    watcher.once('ready', done);
    watcher.once('error', done);
    const timeout = setTimeout(done, 2000);
    timeout.unref();
   });
  }

  return this.request(id);
 }

 async reconcile(id: string): Promise<void> {
  const p = await this.store.get(id);
  const current = hashes(await captureFiles(p.root));
  const previous = p.analysis ? hashes(p.analysis.files) : {};
  if (!areHashesEqual(current, previous) || p.analysis?.status === 'stale') {
   await this.request(id);
  }
 }

 request(id: string): Promise<void> {
  const session = this.sessions.get(id);
  if (!session) return this.start(id);
  session.generation++;
  this.emit('request', id);
  if (!session.running) {
   session.running = this.run(id, session).finally(() => {
    session.running = undefined;
   });
  }
  return session.running;
 }

 private async run(id: string, session: Session) {
  let finished = 0;
  while (!session.closed && finished !== session.generation) {
   const generation = session.generation;
   const p = await this.store.get(id);
   const before = p.analysis;
   this.emit('notification', id, { type: 'status', status: 'updating', sequence: before?.sequence || 0 });
   try {
    const result = AnalysisSchema.parse(await session.worker.analyze(p.root));
    if (generation !== session.generation) {
     continue;
    }
    if (session.closed) return;
    result.sequence = (before?.sequence || 0) + 1;
    const update = GraphUpdateSchema.parse({
     type: 'analysis',
     schemaVersion: GRAPH_SCHEMA_VERSION,
     baseRevision: before?.revision || null,
     baseSequence: before?.sequence || 0,
     sequence: result.sequence,
     revision: result.revision,
     analyzedAt: result.analyzedAt,
     durationMs: result.durationMs,
     status: result.status,
     quality: result.quality,
     staleEvidence: result.staleEvidence,
     delta: graphDelta(before?.graph || emptyGraph(), result.graph),
    });
    await this.store.updateAnalysis(id, result);
    this.emit('notification', id, update);
   } catch (error) {
    if (generation !== session.generation) continue;
    const staleEvidence = { scope: 'all' as const, paths: [], reason: (error as Error).message };
    const stale: Analysis = before
     ? {
       ...before,
       status: 'stale',
       staleEvidence,
       quality: {
        ...before.quality,
        diagnostics: [
         ...before.quality.diagnostics.filter(d => d.code !== 'analysis-failure'),
         { severity: 'error', code: 'analysis-failure', message: (error as Error).message },
        ],
       },
      }
     : {
       revision: '',
       sequence: 0,
       analyzedAt: new Date().toISOString(),
       status: 'stale',
       staleEvidence,
       graph: emptyGraph(),
       files: {},
       durationMs: 0,
       quality: {
        eligibleFiles: 0,
        analyzedFiles: 0,
        unresolvedReferences: 0,
        unsupportedConstructs: 0,
        inferredItems: 0,
        prismaValidation: 'unavailable',
        diagnostics: [{ severity: 'error', code: 'analysis-failure', message: (error as Error).message }],
       },
      };
    if (!session.closed) {
     await this.store.updateAnalysis(id, stale);
     this.emit('notification', id, {
      type: 'status',
      status: 'stale',
      sequence: stale.sequence,
      revision: stale.revision,
      quality: stale.quality,
      staleEvidence,
      message: (error as Error).message,
     });
    }
   }
   finished = generation;
  }
 }

 isWatching(id: string): boolean {
  const session = this.sessions.get(id);
  return Boolean(session && !session.closed && session.watcher);
 }

 hasSession(id: string): boolean {
  return this.sessions.has(id);
 }

 getWatcher(id: string): FSWatcher | undefined {
  return this.sessions.get(id)?.watcher;
 }

 async stop(id: string): Promise<void> {
  const session = this.sessions.get(id);
  if (!session) return;
  session.closed = true;
  clearTimeout(session.debounce);
  clearInterval(session.timer);
  if (session.watcher) {
   await session.watcher.close();
   session.watcher = undefined;
  }
  await session.worker.close();
  this.sessions.delete(id);
 }

 async close(id?: string): Promise<void> {
  if (id !== undefined) {
   return this.stop(id);
  }
  for (const session of this.sessions.values()) {
   session.closed = true;
   clearTimeout(session.debounce);
   clearInterval(session.timer);
   await session.watcher?.close();
   await session.worker.close();
  }
  this.sessions.clear();
 }
}
