import {EventEmitter} from 'node:events';
import chokidar,{type FSWatcher} from 'chokidar';
import {basename,relative} from 'node:path';
import type {Analysis,GraphUpdate,BindingReviewRecord,Diagnostic,DivergenceReport} from '../shared/model';
import {graphDelta,emptyGraph,GRAPH_SCHEMA_VERSION,AnalysisSchema,GraphUpdateSchema,createGraphUpdate} from '../shared/model';
import {AnalysisWorker} from './worker';
import {ProjectStore} from './store';
import {captureFiles,hashes,isPathExcluded} from './files';
import {reconcileGraphIdentities,reconcileSourceBindings,computeDivergenceReport} from './review';

export interface SyncServiceOptions {
 watch?: boolean;
 debounceMs?: number;
 stabilityThreshold?: number;
 pollInterval?: number;
 reconcileIntervalMs?: number;
 worker?: AnalysisWorker;
 createWorker?: () => AnalysisWorker;
}

export function isGeneratedOrTemporaryFile(filePath: string): boolean {
 if (!filePath) return false;
 const name = basename(filePath);
 return (
  /\.(?:tmp|temp|bak|swp|swo|swx|crswap|part)(?:\.|$)/i.test(name) ||
  name.endsWith('~') ||
  name.startsWith('.#') ||
  (name.startsWith('#') && name.endsWith('#')) ||
  name.includes('___jb_tmp___') ||
  name.includes('___jb_old___') ||
  name === '4913' ||
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

 // 7. Prisma configuration files (.prismarc, prisma.config.[cm]?[jt]s)
 if (/^\.prismarc(?:\.json)?$/i.test(name) || /^prisma\.config\.[cm]?[jt]s$/i.test(name)) {
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

export function getRelevantInputHashes(fileHashes: Record<string, string>): Record<string, string> {
 const filtered: Record<string, string> = {};
 for (const [path, h] of Object.entries(fileHashes)) {
  if (isRelevantAnalysisInput(path)) {
   filtered[path] = h;
  }
 }
 return filtered;
}

type PendingRequest = {
 generation: number;
 resolve: () => void;
 reject: (err: any) => void;
};

type Session = {
 root: string;
 worker: AnalysisWorker;
 watcher?: FSWatcher;
 generation: number;
 committedGeneration: number;
 committedRevision: string;
 committedSequence: number;
 inFlight: Set<number>;
 pendingRequests: PendingRequest[];
 debounce?: ReturnType<typeof setTimeout>;
 timer?: ReturnType<typeof setInterval>;
 stabilizationTimer?: ReturnType<typeof setTimeout>;
 startTimeout?: ReturnType<typeof setTimeout>;
 closed: boolean;
 bindingReviews?: BindingReviewRecord[];
 divergenceReport?: DivergenceReport;
 eventDeliveryDisabled?: boolean;
};

export class SyncService extends EventEmitter {
 private sessions = new Map<string, Session>();
 constructor(public store: ProjectStore, private options: SyncServiceOptions = {}) {
  super();
 }

 getBindingReviews(id: string): BindingReviewRecord[] {
  return this.sessions.get(id)?.bindingReviews ?? [];
 }

 getDivergenceReport(id: string): DivergenceReport | undefined {
  return this.sessions.get(id)?.divergenceReport;
 }

 getDebounceMs(): number {
  return this.options.debounceMs ?? 300;
 }

 getReconcileIntervalMs(): number {
  return this.options.reconcileIntervalMs ?? 60000;
 }

 hasPendingDebounce(id: string): boolean {
  return Boolean(this.sessions.get(id)?.debounce !== undefined);
 }

 hasReconcileTimer(id: string): boolean {
  return Boolean(this.sessions.get(id)?.timer !== undefined);
 }

 disableEventDelivery(id: string): void {
  const session = this.sessions.get(id);
  if (session) session.eventDeliveryDisabled = true;
 }

 enableEventDelivery(id: string): void {
  const session = this.sessions.get(id);
  if (session) session.eventDeliveryDisabled = false;
 }

 isEventDeliveryDisabled(id: string): boolean {
  return Boolean(this.sessions.get(id)?.eventDeliveryDisabled);
 }

 isUpdating(id: string): boolean {
  const session = this.sessions.get(id);
  if (!session || session.closed) return false;
  return session.inFlight.size > 0 || session.debounce !== undefined;
 }

 schedule(id: string, event?: string, filePath?: string): void {
  const session = this.sessions.get(id);
  if (!session || session.closed) return;
  const rel = filePath ? relative(session.root, filePath).replace(/\\/g, '/') : undefined;
  this.emit('change', id, { event, path: rel });
  if (session.debounce) {
   clearTimeout(session.debounce);
   session.debounce = undefined;
  }
  const debounceMs = this.getDebounceMs();
  session.debounce = setTimeout(() => {
   session.debounce = undefined;
   if (session.closed) return;
   this.emit('reconcile-scheduled', id, { event, path: rel });
   void this.request(id).catch(error =>
    this.emit('notification', id, { type: 'error', projectId: id, message: error.message })
   );
  }, debounceMs);
 }

 handleFileEvent(id: string, event: string, filePath: string): boolean {
  const session = this.sessions.get(id);
  if (!session || session.closed || session.eventDeliveryDisabled) return false;
  const rel = relative(session.root, filePath).replace(/\\/g, '/');
  if (isPathExcluded(rel) || isGeneratedOrTemporaryFile(rel)) return false;
  const isDir = event === 'addDir' || event === 'unlinkDir';
  if (!isDir && !isRelevantAnalysisInput(rel)) return false;
  this.schedule(id, event, filePath);
  return true;
 }

 private setupWatcher(id: string, session: Session, root: string): FSWatcher {
  const watcher = chokidar.watch(root, {
   ignoreInitial: true,
   awaitWriteFinish: {
    stabilityThreshold: this.options.stabilityThreshold ?? 150,
    pollInterval: this.options.pollInterval ?? 50,
   },
   atomic: true,
   ignored: (targetPath: string) => {
    if (targetPath === root) return false;
    const rel = relative(root, targetPath).replace(/\\/g, '/');
    if (!rel || rel === '.') return false;
    if (isPathExcluded(rel) || isGeneratedOrTemporaryFile(rel)) return true;
    return false;
   },
  });

  watcher.on('all', (event, filePath) => {
   if (session.closed || session.eventDeliveryDisabled) return;
   this.handleFileEvent(id, event, filePath);
  });

  watcher.on('error', (err) => {
   void this.handleWatcherError(id, err);
  });

  return watcher;
 }

 async handleWatcherError(id: string, err: any, options?: { restartWatcher?: boolean }): Promise<void> {
  const session = this.sessions.get(id);
  if (!session || session.closed) return;
  this.emit('watcher-error', id, err);
  this.emit('recovery', id, { phase: 'start', error: err });

  if (!session.closed && this.options.watch !== false) {
   const watcher = session.watcher as any;
   const isClosed = !watcher || watcher.closed || watcher.isClosed;
   if (isClosed || options?.restartWatcher) {
    if (watcher && !isClosed) {
     try {
      await watcher.close();
     } catch {
      // Ignore close error on damaged watcher
     }
    }
    try {
     const newWatcher = this.setupWatcher(id, session, session.root);
     session.watcher = newWatcher;
     await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
       if (!resolved) {
        resolved = true;
        resolve();
       }
      };
      newWatcher.once('ready', done);
      newWatcher.once('error', done);
      setTimeout(done, 1500).unref();
     });
     this.emit('recovery', id, { phase: 'watcher-restarted' });
    } catch {
     // Ignore watcher restart errors if filesystem is persistently unavailable
    }
   }
  }

  try {
   await this.reconcile(id);
   this.emit('recovery', id, { phase: 'complete' });
  } catch (error: any) {
   this.emit('recovery', id, { phase: 'error', error });
   this.emit('notification', id, { type: 'error', projectId: id, message: error.message });
  }
 }

 async rescan(id: string, options?: { force?: boolean }): Promise<boolean> {
  if (!this.sessions.has(id)) {
   await this.start(id);
   return true;
  }
  return this.reconcile(id, { force: options?.force ?? true });
 }

 async resume(id?: string): Promise<void> {
  if (id !== undefined) {
   if (!this.sessions.has(id)) {
    await this.start(id);
    return;
   }
   const session = this.sessions.get(id);
   if (!session || session.closed) return;
   this.emit('resume', id);
   const reconcileInterval = this.getReconcileIntervalMs();
   if (session.timer) {
    clearInterval(session.timer);
    session.timer = undefined;
   }
   const shouldScheduleTimer =
    (this.options.watch !== false || this.options.reconcileIntervalMs !== undefined) && reconcileInterval > 0;
   if (shouldScheduleTimer) {
    session.timer = setInterval(
     () => void this.reconcile(id).catch(error =>
      this.emit('notification', id, { type: 'error', projectId: id, message: error.message })
     ),
     reconcileInterval
    );
    session.timer.unref();
   }
   await this.reconcile(id);
   return;
  }
  const sessionIds = Array.from(this.sessions.keys());
  for (const sessionId of sessionIds) {
   await this.resume(sessionId);
  }
 }

 async start(id: string): Promise<void> {
  if (this.sessions.has(id)) return this.request(id);
  const project = await this.store.get(id);
  const worker = this.options.createWorker
   ? this.options.createWorker()
   : (this.options.worker ?? new AnalysisWorker());

  const session: Session = {
   root: project.root,
   worker,
   generation: 0,
   committedGeneration: 0,
   committedRevision: project.analysis?.revision || '',
   committedSequence: project.analysis?.sequence || 0,
   inFlight: new Set<number>(),
   pendingRequests: [],
   closed: false,
  };
  this.sessions.set(id, session);

  if (this.options.watch !== false) {
   const watcher = this.setupWatcher(id, session, project.root);
   session.watcher = watcher;

   await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
     if (!resolved) {
      resolved = true;
      if (session.startTimeout) {
       clearTimeout(session.startTimeout);
       session.startTimeout = undefined;
      }
      resolve();
     }
    };
    watcher.once('ready', done);
    watcher.once('error', done);
    session.startTimeout = setTimeout(done, 2000);
    session.startTimeout.unref();
   });
  }

  const reconcileInterval = this.options.reconcileIntervalMs ?? 60000;
  const shouldScheduleTimer =
   (this.options.watch !== false || this.options.reconcileIntervalMs !== undefined) && reconcileInterval > 0;
  if (shouldScheduleTimer) {
   session.timer = setInterval(
    () => void this.reconcile(id).catch(error =>
     this.emit('notification', id, { type: 'error', projectId: id, message: error.message })
    ),
    reconcileInterval
   );
   session.timer.unref();
  }

  return this.request(id);
 }

 async reconcile(id: string, options?: { force?: boolean }): Promise<boolean> {
  const session = this.sessions.get(id);
  if (!session || session.closed) return false;
  if (session.debounce) {
   clearTimeout(session.debounce);
   session.debounce = undefined;
  }
  const p = await this.store.get(id);
  const captured = await captureFiles(p.root);
  const current = getRelevantInputHashes(hashes(captured));
  const previous = p.analysis ? getRelevantInputHashes(hashes(p.analysis.files)) : {};
  const hashesMatch = areHashesEqual(current, previous);
  const isStale = p.analysis?.status === 'stale';
  const shouldRequest = options?.force || !hashesMatch || isStale;

  this.emit('reconcile-start', id, { current, previous, changed: !hashesMatch, force: Boolean(options?.force) });

  if (shouldRequest) {
   await this.request(id);
   this.emit('reconciled', id, { changed: true, hashes: current });
   return true;
  } else {
   this.emit('reconciled', id, { changed: false, hashes: current });
   return false;
  }
 }

 request(id: string): Promise<void> {
  const session = this.sessions.get(id);
  if (!session) return this.start(id);
  if (session.closed) return Promise.resolve();
  session.generation++;
  const gen = session.generation;
  this.emit('request', id, { generation: gen });
  const promise = new Promise<void>((resolve, reject) => {
   session.pendingRequests.push({ generation: gen, resolve, reject });
  });
  void this.executeRequest(id, session, gen);
  return promise;
 }

 private async executeRequest(id: string, session: Session, generation: number): Promise<void> {
  session.inFlight.add(generation);
  try {
   if (session.closed || generation < session.generation) {
    this.emit('discarded', id, {
     generation,
     reason: session.closed ? 'session-closed' : 'superseded-before-start',
    });
    return;
   }

   const p = await this.store.get(id);
   const before = p.analysis;
   const updatingStatus = {
    type: 'status' as const,
    projectId: id,
    status: 'updating' as const,
    sequence: before?.sequence || 0,
    revision: before?.revision || null,
   };
   this.emit('status', id, updatingStatus);
   this.emit('notification', id, updatingStatus);

   let result: Analysis;
   try {
    result = AnalysisSchema.parse(await session.worker.analyze(p.root, { generation }));
   } catch (error) {
    if (session.closed || generation < session.generation || generation <= session.committedGeneration) {
     this.emit('discarded', id, {
      generation,
      reason: session.closed ? 'session-closed' : 'superseded-on-error',
     });
     return;
    }
    const err = error as any;
    const errorMsg = (error as Error).message || String(error);
    const errPaths: string[] = Array.isArray(err.paths)
     ? err.paths.filter((p: any) => typeof p === 'string' && p.trim())
     : typeof err.path === 'string' && err.path.trim()
       ? [err.path.trim()]
       : [];
    const staleEvidence = {
     scope: errPaths.length > 0 ? ('paths' as const) : ('all' as const),
     paths: errPaths,
     reason: errorMsg,
    };
    const errDiagnostics: Diagnostic[] = Array.isArray(err.diagnostics) ? err.diagnostics : [];
    const failureDiag: Diagnostic = {
     severity: 'error',
     code: 'analysis-failure',
     message: errorMsg,
     ...(errPaths.length === 1 ? { path: errPaths[0] } : (typeof err.path === 'string' ? { path: err.path } : {})),
     ...(typeof err.line === 'number' ? { line: err.line } : {}),
    };
    const mergedDiagnostics = [
     ...(before ? before.quality.diagnostics.filter(d => d.code !== 'analysis-failure') : []),
     failureDiag,
     ...errDiagnostics.filter(d => d.code !== 'analysis-failure'),
    ];
    const stale: Analysis = before
     ? {
       ...before,
       status: 'stale',
       staleEvidence,
       quality: {
        ...before.quality,
        diagnostics: mergedDiagnostics,
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
        diagnostics: [failureDiag, ...errDiagnostics],
       },
      };

    await this.emitBeforePersist(id, { generation, revision: stale.revision, result: stale, isStale: true });
    if (session.closed || generation < session.generation || generation <= session.committedGeneration) {
     this.emit('discarded', id, {
      generation,
      reason: session.closed ? 'session-closed' : 'superseded-at-stale-persist',
     });
     return;
    }

    await this.store.updateAnalysis(id, stale);

    if (session.closed || generation < session.committedGeneration) {
     this.emit('discarded', id, {
      generation,
      reason: session.closed ? 'session-closed' : 'superseded-at-stale-publish',
     });
     return;
    }

    session.committedGeneration = generation;
    session.committedRevision = stale.revision;
    session.committedSequence = stale.sequence;

    const staleStatusEvent = {
     type: 'status' as const,
     projectId: id,
     status: 'stale' as const,
     sequence: stale.sequence,
     revision: stale.revision,
     quality: stale.quality,
     diagnostics: stale.quality.diagnostics,
     staleEvidence,
     message: errorMsg,
    };
    this.emit('status', id, staleStatusEvent);
    this.emit('notification', id, staleStatusEvent);

    const staleDivergence = computeDivergenceReport(p, stale);
    session.divergenceReport = staleDivergence;
    this.emit('divergence', id, staleDivergence);
    this.emit('notification', id, {
     type: 'divergence',
     projectId: id,
     report: staleDivergence,
    });
    return;
   }

   // Worker succeeded: check supersession before persistence
   if (session.closed || generation < session.generation || generation <= session.committedGeneration) {
    this.emit('discarded', id, {
     generation,
     revision: result.revision,
     reason: session.closed ? 'session-closed' : 'superseded-before-persist',
    });
    return;
   }

   const latestP = await this.store.get(id);
   const currentBefore = latestP.analysis;
   result.sequence = (currentBefore?.sequence || 0) + 1;

   // Reconcile graph node IDs to preserve stable identities for unambiguous matches
   const reconciled = reconcileGraphIdentities(currentBefore?.graph, result.graph, latestP.specification);
   result.graph = reconciled.graph;

   // Produce explicit binding review records for human specification nodes
   const bindingReviews = reconcileSourceBindings(latestP.specification, result, currentBefore);
   session.bindingReviews = bindingReviews;

   // Compute continuous divergence report between intended architecture and implemented code
   const divergenceReport = computeDivergenceReport(latestP, result);
   session.divergenceReport = divergenceReport;

   const update = createGraphUpdate(currentBefore, result, id);

   await this.emitBeforePersist(id, { generation, revision: result.revision, result });
   if (session.closed || generation < session.generation || generation <= session.committedGeneration) {
    this.emit('discarded', id, {
     generation,
     revision: result.revision,
     reason: session.closed ? 'session-closed' : 'superseded-at-persist',
    });
    return;
   }

   await this.store.updateAnalysis(id, result);

   if (session.closed || generation < session.committedGeneration) {
    this.emit('discarded', id, {
     generation,
     revision: result.revision,
     reason: session.closed ? 'session-closed' : 'superseded-at-publish',
    });
    return;
   }

   session.committedGeneration = generation;
   session.committedRevision = result.revision;
   session.committedSequence = result.sequence;

   this.emit('status', id, {
    type: 'status' as const,
    projectId: id,
    status: result.status,
    sequence: result.sequence,
    revision: result.revision,
    quality: result.quality,
    diagnostics: result.quality.diagnostics,
    staleEvidence: result.staleEvidence,
   });
   this.emit('notification', id, update);

   if (bindingReviews.length > 0) {
    this.emit('binding-review', id, bindingReviews);
    this.emit('notification', id, {
     type: 'binding-review',
     projectId: id,
     records: bindingReviews,
    });
   }

   this.emit('divergence', id, divergenceReport);
   this.emit('notification', id, {
    type: 'divergence',
    projectId: id,
    report: divergenceReport,
   });

   const isIncompleteRevision = result.quality.diagnostics.some(d => d.code === 'incomplete-revision');
   if (isIncompleteRevision && !session.closed && !session.debounce) {
    if (session.stabilizationTimer) clearTimeout(session.stabilizationTimer);
    const delay = this.options.stabilityThreshold ?? 150;
    session.stabilizationTimer = setTimeout(() => {
     session.stabilizationTimer = undefined;
     if (!session.closed) {
      void this.reconcile(id).catch(() => {});
     }
    }, delay);
    session.stabilizationTimer.unref?.();
   }
  } finally {
   session.inFlight.delete(generation);
   this.settlePendingRequests(session);
  }
 }

 private async emitBeforePersist(id: string, payload: { generation: number; revision: string; result: Analysis; isStale?: boolean }): Promise<void> {
  const listeners = this.rawListeners('before-persist');
  for (const listener of listeners) {
   const res = (listener as Function)(id, payload);
   if (res && typeof (res as Promise<any>).then === 'function') {
    await res;
   }
  }
 }

 private settlePendingRequests(session: Session): void {
  if (session.closed) {
   for (const req of session.pendingRequests) {
    req.resolve();
   }
   session.pendingRequests = [];
   return;
  }
  const remaining: PendingRequest[] = [];
  for (const req of session.pendingRequests) {
   if (req.generation <= session.committedGeneration) {
    if (!session.inFlight.has(req.generation)) {
     req.resolve();
    } else {
     remaining.push(req);
    }
   } else if (session.inFlight.size === 0) {
    req.resolve();
   } else {
    remaining.push(req);
   }
  }
  session.pendingRequests = remaining;
 }

 isSuperseded(id: string, generation: number): boolean {
  const session = this.sessions.get(id);
  if (!session || session.closed) return true;
  return generation < session.generation || generation <= session.committedGeneration;
 }

 getGeneration(id: string): number {
  return this.sessions.get(id)?.generation ?? 0;
 }

 getCommittedGeneration(id: string): number {
  return this.sessions.get(id)?.committedGeneration ?? 0;
 }

 getInFlightCount(id: string): number {
  return this.sessions.get(id)?.inFlight.size ?? 0;
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

 createGraphUpdate(
  currentBefore: Pick<Analysis, 'revision' | 'sequence' | 'graph'> | undefined,
  result: Analysis,
  projectId?: string
 ): GraphUpdate {
  return createGraphUpdate(currentBefore, result, projectId);
 }

 async stop(id: string): Promise<void> {
  const session = this.sessions.get(id);
  if (!session) return;
  session.closed = true;
  if (session.debounce) {
   clearTimeout(session.debounce);
   session.debounce = undefined;
  }
  if (session.timer) {
   clearInterval(session.timer);
   session.timer = undefined;
  }
  if (session.stabilizationTimer) {
   clearTimeout(session.stabilizationTimer);
   session.stabilizationTimer = undefined;
  }
  if (session.startTimeout) {
   clearTimeout(session.startTimeout);
   session.startTimeout = undefined;
  }
  if (session.watcher) {
   await session.watcher.close();
   session.watcher = undefined;
  }
  if (!this.options.worker || session.worker !== this.options.worker) {
   await session.worker.close();
  }
  this.settlePendingRequests(session);
  this.sessions.delete(id);
 }

 async close(id?: string): Promise<void> {
  if (id !== undefined) {
   return this.stop(id);
  }
  const sessionIds = Array.from(this.sessions.keys());
  for (const sessionId of sessionIds) {
   await this.stop(sessionId);
  }
 }
}
