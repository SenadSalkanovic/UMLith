import {
  AnalysisSchema,
  AnalysisStatusSchema,
  applyGraphUpdate,
  emptyGraph,
  SnapshotReconciliationError,
  type Analysis,
  type GraphUpdate,
} from '../shared/model';
import {
  SseReadyEventSchema,
  SseStatusEventSchema,
  SseDeltaEventSchema,
  SseDiagnosticsEventSchema,
  type SseReadyEvent,
  type SseStatusEvent,
  type SseDeltaEvent,
  type SseDiagnosticsEvent,
} from '../shared/api';
import { getAnalysisSnapshot } from './api';

export type AnalysisStatus = 'updating' | 'current' | 'partial' | 'stale';

export type AnalysisClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type SnapshotChangeSource = 'snapshot' | 'delta';

export interface AnalysisClientOptions {
  projectId: string;
  baseUrl?: string;
  initialSnapshot?: Analysis | null;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  transport?: 'auto' | 'eventsource' | 'fetch';
  headers?: Record<string, string>;
  origin?: string;
  reconcileOnResume?: boolean;
  resumeAction?: (projectId: string, baseUrl?: string) => Promise<any>;
  rescanAction?: (projectId: string, baseUrl?: string) => Promise<Analysis | any>;
  createEventSource?: (url: string) => any;
  fetchSnapshot?: (projectId: string, baseUrl?: string) => Promise<Analysis>;
  onSnapshot?: (snapshot: Analysis, source: SnapshotChangeSource) => void;
  onStatus?: (status: SseStatusEvent) => void;
  onDelta?: (delta: SseDeltaEvent) => void;
  onDiagnostics?: (diagnostics: SseDiagnosticsEvent) => void;
  onResume?: () => void;
  onRescan?: (analysis: Analysis) => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (status: AnalysisClientConnectionStatus) => void;
}

export type AnalysisClientListener = (...args: any[]) => void;

function resolveBaseUrl(baseUrl?: string): string {
  const base = baseUrl || '/api';
  const clean = base.endsWith('/') ? base.slice(0, -1) : base;
  return clean.endsWith('/api') ? clean : `${clean}/api`;
}

export class AnalysisClient {
  public readonly projectId: string;
  private options: AnalysisClientOptions;
  private snapshot: Analysis | null = null;
  private lastEventId: string | null = null;
  private connectionStatus: AnalysisClientConnectionStatus = 'disconnected';
  private abortController: AbortController | null = null;
  private eventSource: any = null;
  private reconnectTimer: any = null;
  private reconnectDelay: number;
  private destroyed = false;
  private pendingSnapshotFetch: Promise<Analysis> | null = null;
  private pendingResume: Promise<void> | null = null;
  private pendingRescan: Promise<Analysis> | null = null;
  private visibilityListener: (() => void) | null = null;
  private focusListener: (() => void) | null = null;
  private onlineListener: (() => void) | null = null;
  private listeners: Map<string, Set<AnalysisClientListener>> = new Map();

  constructor(options: AnalysisClientOptions) {
    if (!options.projectId || typeof options.projectId !== 'string') {
      throw new Error('AnalysisClient requires a valid projectId');
    }
    this.projectId = options.projectId;
    this.options = { ...options };
    this.reconnectDelay = options.reconnectDelayMs ?? 500;

    if (options.initialSnapshot) {
      this.snapshot = AnalysisSchema.parse(options.initialSnapshot);
      if (this.snapshot.revision) {
        this.lastEventId = `${this.projectId}:${this.snapshot.revision}:${this.snapshot.sequence}`;
      }
    }

    this.setupLifecycleListeners();
  }

  // --- State Accessors ---

  public getSnapshot(): Analysis | null {
    return this.snapshot;
  }

  public getRevision(): string | null {
    return this.snapshot?.revision ?? null;
  }

  public getSequence(): number {
    return this.snapshot?.sequence ?? 0;
  }

  public getStatus(): AnalysisStatus {
    return this.snapshot?.status ?? 'current';
  }

  public getConnectionStatus(): AnalysisClientConnectionStatus {
    return this.connectionStatus;
  }

  public getLastEventId(): string | null {
    return this.lastEventId;
  }

  public isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  // --- Subscriptions ---

  public on(event: 'snapshot', listener: (snapshot: Analysis, source: SnapshotChangeSource) => void): () => void;
  public on(event: 'status', listener: (event: SseStatusEvent) => void): () => void;
  public on(event: 'delta', listener: (event: SseDeltaEvent) => void): () => void;
  public on(event: 'diagnostics', listener: (event: SseDiagnosticsEvent) => void): () => void;
  public on(event: 'ready', listener: (event: SseReadyEvent) => void): () => void;
  public on(event: 'connection', listener: (status: AnalysisClientConnectionStatus) => void): () => void;
  public on(event: 'resume', listener: () => void): () => void;
  public on(event: 'rescan', listener: (snapshot: Analysis) => void): () => void;
  public on(event: 'error', listener: (error: Error) => void): () => void;
  public on(event: string, listener: AnalysisClientListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => {
      this.off(event, listener);
    };
  }

  public off(event: string, listener: AnalysisClientListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  public subscribe(listener: (snapshot: Analysis) => void): () => void {
    return this.on('snapshot', (snap) => listener(snap));
  }

  private emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          (listener as any)(...args);
        } catch (err) {
          console.error(`Error in AnalysisClient '${event}' listener:`, err);
        }
      }
    }
  }

  private setConnectionStatus(status: AnalysisClientConnectionStatus): void {
    if (this.connectionStatus !== status) {
      this.connectionStatus = status;
      this.options.onConnectionChange?.(status);
      this.emit('connection', status);
    }
  }

  public setSnapshot(snapshot: Analysis, source: SnapshotChangeSource = 'snapshot'): void {
    const validated = AnalysisSchema.parse(snapshot);
    this.snapshot = validated;
    if (validated.revision && !this.lastEventId) {
      this.lastEventId = `${this.projectId}:${validated.revision}:${validated.sequence}`;
    }
    this.options.onSnapshot?.(validated, source);
    this.emit('snapshot', validated, source);
  }

  // --- Snapshot Fetching & Recovery ---

  public async fetchFreshSnapshot(): Promise<Analysis> {
    if (this.pendingSnapshotFetch) {
      return this.pendingSnapshotFetch;
    }

    const fetchPromise = (async () => {
      try {
        const fetcher = this.options.fetchSnapshot || getAnalysisSnapshot;
        const fresh = await fetcher(this.projectId, this.options.baseUrl);
        const validated = AnalysisSchema.parse(fresh);
        this.setSnapshot(validated, 'snapshot');
        return validated;
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error);
        this.emit('error', error);
        throw error;
      } finally {
        this.pendingSnapshotFetch = null;
      }
    })();

    this.pendingSnapshotFetch = fetchPromise;
    return fetchPromise;
  }

  // --- Lifecycle & Reconciliation on Resume (T060) ---

  private setupLifecycleListeners(): void {
    if (this.options.reconcileOnResume === false) return;

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          void this.resume().catch((err) => {
            this.options.onError?.(err);
            this.emit('error', err);
          });
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.focusListener = () => {
        void this.resume().catch((err) => {
          this.options.onError?.(err);
          this.emit('error', err);
        });
      };
      window.addEventListener('focus', this.focusListener);

      this.onlineListener = () => {
        void this.resume().catch((err) => {
          this.options.onError?.(err);
          this.emit('error', err);
        });
      };
      window.addEventListener('online', this.onlineListener);
    }
  }

  public async resume(): Promise<void> {
    if (this.pendingResume) {
      return this.pendingResume;
    }

    const resumePromise = (async () => {
      try {
        this.emit('resume');
        this.options.onResume?.();

        if (this.connectionStatus === 'disconnected' || this.connectionStatus === 'error') {
          if (this.options.autoReconnect !== false) {
            await this.connect();
          }
        }

        if (this.options.resumeAction) {
          await this.options.resumeAction(this.projectId, this.options.baseUrl);
        } else {
          const baseUrl = resolveBaseUrl(this.options.baseUrl);
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(this.options.headers || {}),
          };
          if (this.options.origin) {
            headers['Origin'] = this.options.origin;
          }
          await fetch(`${baseUrl}/projects/${encodeURIComponent(this.projectId)}/resume`, {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
          }).catch(() => {});
        }

        if (!this.snapshot) {
          await this.fetchFreshSnapshot().catch(() => {});
        }
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error);
        this.emit('error', error);
        throw error;
      } finally {
        this.pendingResume = null;
      }
    })();

    this.pendingResume = resumePromise;
    return resumePromise;
  }

  // --- Manual Full Rescan (T060) ---

  public async rescan(options?: { full?: boolean }): Promise<Analysis> {
    if (this.pendingRescan) {
      return this.pendingRescan;
    }

    const rescanPromise = (async () => {
      try {
        let freshSnapshot: Analysis;
        if (this.options.rescanAction) {
          const res = await this.options.rescanAction(this.projectId, this.options.baseUrl);
          freshSnapshot = AnalysisSchema.parse((res as any)?.analysis || res);
        } else {
          const baseUrl = resolveBaseUrl(this.options.baseUrl);
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(this.options.headers || {}),
          };
          if (this.options.origin) {
            headers['Origin'] = this.options.origin;
          }
          const response = await fetch(`${baseUrl}/projects/${encodeURIComponent(this.projectId)}/rescan`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ force: true, full: options?.full ?? true }),
          });
          if (!response.ok) {
            throw new Error(`Rescan failed with HTTP ${response.status}: ${response.statusText}`);
          }
          const data = await response.json();
          freshSnapshot = AnalysisSchema.parse(data.analysis || data);
        }

        this.setSnapshot(freshSnapshot, 'snapshot');
        this.emit('rescan', freshSnapshot);
        this.options.onRescan?.(freshSnapshot);
        return freshSnapshot;
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error);
        this.emit('error', error);
        throw error;
      } finally {
        this.pendingRescan = null;
      }
    })();

    this.pendingRescan = rescanPromise;
    return rescanPromise;
  }

  // --- Delta Application & Missed Event Recovery ---

  public async applyDelta(input: SseDeltaEvent | GraphUpdate | any): Promise<boolean> {
    const update = (input as any).update || input;
    const targetRevision = (input as any).revision || update.revision;
    const targetSequence = (input as any).sequence ?? update.sequence;
    const baseRevision = (input as any).baseRevision !== undefined ? (input as any).baseRevision : update.baseRevision;
    const baseSequence = (input as any).baseSequence !== undefined ? (input as any).baseSequence : update.baseSequence;
    const status = (input as any).status || update.status || 'current';
    const quality = (input as any).quality || update.quality;
    const staleEvidence = (input as any).staleEvidence || update.staleEvidence;

    // 1. Check for duplicate or superseded delta
    if (this.snapshot) {
      if (this.snapshot.revision === targetRevision && this.snapshot.sequence === targetSequence) {
        // Exact duplicate of current revision: harmless no-op
        return false;
      }
      if (typeof targetSequence === 'number' && targetSequence < this.snapshot.sequence) {
        // Older / superseded revision: harmless no-op
        return false;
      }
    }

    // 2. Check matching local revision
    if (!this.snapshot) {
      // No baseline snapshot exists locally: recover with fresh snapshot
      await this.fetchFreshSnapshot();
      return true;
    }

    const localRev = this.snapshot.revision || null;
    const localSeq = this.snapshot.sequence ?? 0;

    if (localRev !== baseRevision || localSeq !== baseSequence) {
      // Mismatched base! Missed intermediate event or independent branch
      // Acceptance Criterion: A missing event never silently corrupts the graph.
      // Recover by fetching and replacing with fresh server snapshot.
      await this.fetchFreshSnapshot();
      return true;
    }

    // 3. Matching base revision: apply delta to local snapshot
    try {
      const graphUpdate = (update.type === 'analysis' && update.delta)
        ? update
        : {
            type: 'analysis',
            schemaVersion: 1,
            projectId: this.projectId,
            baseRevision: baseRevision ?? null,
            baseSequence: baseSequence ?? 0,
            revision: targetRevision,
            sequence: targetSequence,
            status,
            quality: quality || this.snapshot.quality,
            durationMs: (input as any).durationMs ?? update.durationMs ?? 0,
            analyzedAt: (input as any).analyzedAt ?? update.analyzedAt ?? new Date().toISOString(),
            staleEvidence,
            delta: (input as any).delta || update.delta,
          };

      const nextGraph = applyGraphUpdate(this.snapshot, graphUpdate);
      const nextSnapshot: Analysis = {
        revision: targetRevision,
        sequence: targetSequence,
        status,
        quality: quality || this.snapshot.quality,
        durationMs: (input as any).durationMs ?? update.durationMs ?? 0,
        analyzedAt: (input as any).analyzedAt ?? update.analyzedAt ?? new Date().toISOString(),
        staleEvidence,
        files: this.snapshot.files,
        graph: nextGraph,
      };

      this.setSnapshot(nextSnapshot, 'delta');
      this.options.onDelta?.(input as SseDeltaEvent);
      this.emit('delta', input);
      return true;
    } catch (err) {
      if (err instanceof SnapshotReconciliationError) {
        // Base revision/sequence mismatch trapped by applyGraphUpdate
        await this.fetchFreshSnapshot();
        return true;
      }
      throw err;
    }
  }

  // --- SSE Event Handling ---

  public async handleEvent(eventName: string, eventId: string | undefined, data: any): Promise<void> {
    if (eventId) {
      this.lastEventId = eventId;
    }

    switch (eventName) {
      case 'ready': {
        const readyResult = SseReadyEventSchema.safeParse(data);
        const readyData = readyResult.success ? readyResult.data : data;
        const serverRev = readyData.revision ?? null;
        const serverSeq = readyData.sequence ?? 0;

        // Check if local state matches server state
        if (!this.snapshot) {
          if (serverRev) {
            await this.fetchFreshSnapshot();
          }
        } else if (serverRev && (this.snapshot.revision !== serverRev || this.snapshot.sequence !== serverSeq)) {
          // Reconnection or divergence detected: server revision differs from local
          // Acceptance Criterion: Reconnect converges to the server snapshot.
          await this.fetchFreshSnapshot();
        } else if (readyData.analysisStatus && this.snapshot.status !== readyData.analysisStatus) {
          this.snapshot = {
            ...this.snapshot,
            status: readyData.analysisStatus,
          };
          this.options.onSnapshot?.(this.snapshot, 'snapshot');
          this.emit('snapshot', this.snapshot, 'snapshot');
        }

        this.emit('ready', readyData);
        break;
      }

      case 'delta': {
        const deltaResult = SseDeltaEventSchema.safeParse(data);
        const deltaData = deltaResult.success ? deltaResult.data : data;
        await this.applyDelta(deltaData);
        break;
      }

      case 'status': {
        const statusResult = SseStatusEventSchema.safeParse(data);
        const statusData = statusResult.success ? statusResult.data : data;

        if (this.snapshot) {
          this.snapshot = {
            ...this.snapshot,
            status: statusData.status,
            quality: statusData.quality || (statusData.diagnostics ? { ...this.snapshot.quality, diagnostics: statusData.diagnostics } : this.snapshot.quality),
            staleEvidence: statusData.staleEvidence ?? (statusData.status === 'stale' ? this.snapshot.staleEvidence : undefined),
          };
          this.options.onSnapshot?.(this.snapshot, 'snapshot');
          this.emit('snapshot', this.snapshot, 'snapshot');
        } else if (statusData.status === 'stale' && (statusData.revision === '' || !statusData.revision)) {
          this.snapshot = {
            revision: '',
            sequence: 0,
            analyzedAt: statusData.timestamp || new Date().toISOString(),
            status: 'stale',
            staleEvidence: statusData.staleEvidence || { scope: 'all', paths: [], reason: statusData.message || 'Initial analysis failed' },
            graph: emptyGraph(),
            files: {},
            durationMs: 0,
            quality: statusData.quality || {
              eligibleFiles: 0,
              analyzedFiles: 0,
              unresolvedReferences: 0,
              unsupportedConstructs: 0,
              inferredItems: 0,
              prismaValidation: 'unavailable',
              diagnostics: statusData.diagnostics || (statusData.message ? [{ severity: 'error', code: 'analysis-failure', message: statusData.message }] : []),
            },
          };
          this.options.onSnapshot?.(this.snapshot, 'snapshot');
          this.emit('snapshot', this.snapshot, 'snapshot');
        }

        this.options.onStatus?.(statusData);
        this.emit('status', statusData);
        break;
      }

      case 'diagnostics': {
        const diagResult = SseDiagnosticsEventSchema.safeParse(data);
        const diagData = diagResult.success ? diagResult.data : data;

        if (this.snapshot && (!diagData.revision || diagData.revision === this.snapshot.revision)) {
          this.snapshot = {
            ...this.snapshot,
            quality: {
              ...this.snapshot.quality,
              diagnostics: diagData.diagnostics,
              ...(diagData.quality ? diagData.quality : {}),
            },
          };
          this.options.onSnapshot?.(this.snapshot, 'snapshot');
          this.emit('snapshot', this.snapshot, 'snapshot');
        }

        this.options.onDiagnostics?.(diagData);
        this.emit('diagnostics', diagData);
        break;
      }

      case 'binding-review': {
        const records = Array.isArray(data?.records) ? data.records : (Array.isArray(data) ? data : []);
        this.emit('binding-review', records);
        break;
      }

      case 'divergence': {
        const report = data?.report || data;
        this.emit('divergence', report);
        break;
      }

      case 'error': {
        const error = new Error(data?.message || 'SSE server reported error');
        this.options.onError?.(error);
        this.emit('error', error);
        break;
      }

      default:
        // Ignore ping and unknown events
        break;
    }
  }

  // --- Connection Management ---

  public async connect(): Promise<void> {
    if (this.connectionStatus === 'connected' || this.connectionStatus === 'connecting') {
      return;
    }

    this.destroyed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setConnectionStatus('connecting');

    const baseUrl = resolveBaseUrl(this.options.baseUrl);
    const lastId = this.lastEventId || (this.snapshot?.revision ? `${this.projectId}:${this.snapshot.revision}:${this.snapshot.sequence}` : null);
    const query = new URLSearchParams();
    if (lastId) {
      query.set('lastEventId', lastId);
    }
    const eventsUrl = `${baseUrl}/projects/${encodeURIComponent(this.projectId)}/events${query.toString() ? `?${query.toString()}` : ''}`;

    const useTransport = this.options.transport || 'auto';

    if (this.options.createEventSource) {
      this.startCustomEventSource(this.options.createEventSource(eventsUrl));
      return;
    }

    if (useTransport === 'eventsource' || (useTransport === 'auto' && typeof EventSource !== 'undefined' && !this.options.headers && !this.options.origin)) {
      this.startNativeEventSource(eventsUrl);
      return;
    }

    // Default to universal fetch-based SSE reader (works in Node and browsers)
    await this.startFetchStream(eventsUrl, lastId);
  }

  private startNativeEventSource(url: string): void {
    try {
      const es = new EventSource(url);
      this.eventSource = es;

      es.onopen = () => {
        this.setConnectionStatus('connected');
        this.reconnectDelay = this.options.reconnectDelayMs ?? 500;
      };

      const handle = (evtName: string) => async (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          await this.handleEvent(evtName, e.lastEventId, data);
        } catch {
          await this.handleEvent(evtName, e.lastEventId, e.data);
        }
      };

      es.addEventListener('ready', handle('ready') as any);
      es.addEventListener('status', handle('status') as any);
      es.addEventListener('delta', handle('delta') as any);
      es.addEventListener('diagnostics', handle('diagnostics') as any);
      es.addEventListener('error', handle('error') as any);

      es.onerror = (e) => {
        if (this.destroyed) return;
        es.close();
        this.eventSource = null;
        this.handleDisconnect(new Error('EventSource encountered connection error'));
      };
    } catch (err: any) {
      this.handleDisconnect(err);
    }
  }

  private startCustomEventSource(es: any): void {
    this.eventSource = es;

    if (es.onopen !== undefined) {
      es.onopen = () => {
        this.setConnectionStatus('connected');
        this.reconnectDelay = this.options.reconnectDelayMs ?? 500;
      };
    }

    const handle = (evtName: string) => async (e: any) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        await this.handleEvent(evtName, e.lastEventId || e.id, data);
      } catch {
        await this.handleEvent(evtName, e.lastEventId || e.id, e.data);
      }
    };

    if (es.addEventListener) {
      es.addEventListener('ready', handle('ready'));
      es.addEventListener('status', handle('status'));
      es.addEventListener('delta', handle('delta'));
      es.addEventListener('diagnostics', handle('diagnostics'));
    }

    if (es.onerror !== undefined) {
      es.onerror = (err: any) => {
        if (this.destroyed) return;
        this.handleDisconnect(err instanceof Error ? err : new Error('Custom EventSource connection error'));
      };
    }
  }

  private async startFetchStream(url: string, lastId: string | null): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(this.options.headers || {}),
    };
    if (this.options.origin) {
      headers['Origin'] = this.options.origin;
    }
    if (lastId) {
      headers['Last-Event-ID'] = lastId;
    }

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal,
      });

      if (!res.ok) {
        throw new Error(`SSE stream rejected with HTTP ${res.status}: ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error('SSE stream response has no body');
      }

      this.setConnectionStatus('connected');
      this.reconnectDelay = this.options.reconnectDelayMs ?? 500;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      void (async () => {
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            let delimIdx: number;
            while ((delimIdx = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, delimIdx);
              buffer = buffer.slice(delimIdx + 2);
              if (!block.trim()) continue;

              const lines = block.split('\n');
              let id: string | undefined;
              let eventName = 'message';
              let dataStr = '';

              for (const line of lines) {
                if (line.startsWith(':')) {
                  continue;
                } else if (line.startsWith('id:')) {
                  id = line.slice(3).replace(/^ /, '').trim();
                } else if (line.startsWith('event:')) {
                  eventName = line.slice(6).replace(/^ /, '').trim();
                } else if (line.startsWith('data:')) {
                  const dataVal = line.slice(5).replace(/^ /, '');
                  dataStr += (dataStr ? '\n' : '') + dataVal;
                }
              }

              if (dataStr) {
                let parsedData: any;
                try {
                  parsedData = JSON.parse(dataStr);
                } catch {
                  parsedData = dataStr;
                }
                await this.handleEvent(eventName, id, parsedData);
              }
            }
          }
        } catch (err: any) {
          if (!signal.aborted && !this.destroyed) {
            this.handleDisconnect(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          try {
            await reader.cancel();
          } catch {}
          if (!signal.aborted && !this.destroyed) {
            this.handleDisconnect(new Error('SSE stream closed by server'));
          }
        }
      })();
    } catch (err: any) {
      this.handleDisconnect(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleDisconnect(error?: Error): void {
    if (this.destroyed) return;

    if (error) {
      this.options.onError?.(error);
      this.emit('error', error);
    }

    if (this.options.autoReconnect === false) {
      this.setConnectionStatus('disconnected');
      return;
    }

    this.setConnectionStatus('reconnecting');
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 1.5,
      this.options.maxReconnectDelayMs ?? 10000
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        void this.connect();
      }
    }, delay);
  }

  public disconnect(): void {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.eventSource) {
      try {
        this.eventSource.close?.();
      } catch {}
      this.eventSource = null;
    }

    if (this.visibilityListener && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }

    if (this.focusListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', this.focusListener);
      this.focusListener = null;
    }

    if (this.onlineListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', this.onlineListener);
      this.onlineListener = null;
    }

    this.pendingResume = null;
    this.pendingRescan = null;

    this.setConnectionStatus('disconnected');
  }

  public async reconnect(): Promise<void> {
    this.disconnect();
    this.destroyed = false;
    await this.connect();
  }
}
