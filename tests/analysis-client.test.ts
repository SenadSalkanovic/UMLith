import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../server/store';
import { createServer } from '../server/main';
import { SyncService } from '../server/sync';
import { AnalysisWorker } from '../server/worker';
import {
  AnalysisClient,
  type AnalysisClientConnectionStatus,
  type SnapshotChangeSource,
} from '../src/analysis-client';
import {
  emptyGraph,
  createGraphUpdate,
  GraphSchema,
  type Analysis,
  type Graph,
  type GraphUpdate,
} from '../shared/model';
import type { SseDeltaEvent, SseStatusEvent, SseDiagnosticsEvent } from '../shared/api';

function createMockAnalysis(
  revision = 'rev-1',
  sequence = 1,
  nodeNames: string[] = ['greet']
): Analysis {
  return {
    revision,
    sequence,
    status: 'current',
    quality: {
      eligibleFiles: 1,
      analyzedFiles: 1,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
    durationMs: 42,
    analyzedAt: new Date().toISOString(),
    files: {
      'src/index.ts': {
        hash: 'hash-1',
        text: 'export function greet() {}',
      },
    },
    graph: GraphSchema.parse({
      nodes: nodeNames.map((name) => ({
        id: `node-${name}`,
        kind: 'function',
        name,
        path: 'src/index.ts',
      })),
      edges: [],
      requirements: [],
    }),
  };
}

describe('T055: Reconnect clients and recover with fresh snapshots', () => {
  describe('Unit Validation: Delta Matching, Harmless Duplicates, and Recovery', () => {
    it('Apply deltas only to their matching local revision (Work checklist & AC 1)', async () => {
      const initial = createMockAnalysis('rev-1', 1, ['alpha']);
      const nextMock = createMockAnalysis('rev-2', 2, ['alpha', 'beta']);
      const update = createGraphUpdate(initial, nextMock, 'test-proj');

      const client = new AnalysisClient({
        projectId: 'test-proj',
        initialSnapshot: initial,
      });

      expect(client.getRevision()).toBe('rev-1');
      expect(client.getSequence()).toBe(1);
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(1);

      let snapshotEmitted: Analysis | null = null;
      let sourceEmitted: SnapshotChangeSource | null = null;
      client.on('snapshot', (snap, source) => {
        snapshotEmitted = snap;
        sourceEmitted = source;
      });

      // Apply matching delta
      const applied = await client.applyDelta(update);
      expect(applied).toBe(true);

      // Verified: Delta applied to matching revision
      expect(client.getRevision()).toBe('rev-2');
      expect(client.getSequence()).toBe(2);
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(2);
      expect(client.getSnapshot()?.graph.nodes.some((n) => n.name === 'beta')).toBe(true);
      expect(sourceEmitted).toBe('delta');
      expect((snapshotEmitted as Analysis | null)?.revision).toBe('rev-2');
    });

    it('Duplicate events are harmless (AC 3 & Scenario 2)', async () => {
      const initial = createMockAnalysis('rev-1', 1, ['alpha']);
      const step2 = createMockAnalysis('rev-2', 2, ['alpha', 'beta']);
      const update1to2 = createGraphUpdate(initial, step2, 'test-proj');

      const client = new AnalysisClient({
        projectId: 'test-proj',
        initialSnapshot: initial,
      });

      // First delivery applies cleanly
      const applied1 = await client.applyDelta(update1to2);
      expect(applied1).toBe(true);
      expect(client.getRevision()).toBe('rev-2');
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(2);

      let snapshotListenerCalls = 0;
      client.on('snapshot', () => {
        snapshotListenerCalls++;
      });

      // Second delivery: exact duplicate event
      const applied2 = await client.applyDelta(update1to2);
      expect(applied2).toBe(false); // Harmless no-op
      expect(client.getRevision()).toBe('rev-2');
      expect(client.getSequence()).toBe(2);
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(2);
      expect(snapshotListenerCalls).toBe(0); // Did not redundantly re-trigger or corrupt

      // Third delivery: older/superseded event (e.g. sequence 1)
      const olderUpdate = createGraphUpdate(undefined, initial, 'test-proj');
      const appliedOlder = await client.applyDelta(olderUpdate);
      expect(appliedOlder).toBe(false); // Harmless no-op
      expect(client.getRevision()).toBe('rev-2');
      expect(client.getSequence()).toBe(2);
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(2);
    });

    it('A missing event never silently corrupts the graph (AC 1 & Scenario 2)', async () => {
      // Client is at rev-1 (seq 1).
      // Event for rev-2 (seq 2) was dropped!
      // Event for rev-3 (seq 3) arrives with baseRevision: rev-2, baseSequence: 2.
      const rev1 = createMockAnalysis('rev-1', 1, ['alpha']);
      const rev2 = createMockAnalysis('rev-2', 2, ['alpha', 'beta']);
      const rev3 = createMockAnalysis('rev-3', 3, ['alpha', 'beta', 'gamma']);

      // Delta 3 expects base rev-2
      const delta3 = createGraphUpdate(rev2, rev3, 'test-proj');

      let fetchCount = 0;
      const fetchSnapshot = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return rev3; // Server snapshot at rev-3
      });

      const client = new AnalysisClient({
        projectId: 'test-proj',
        initialSnapshot: rev1,
        fetchSnapshot,
      });

      expect(client.getRevision()).toBe('rev-1');

      // Deliver mismatched-base delta 3
      const result = await client.applyDelta(delta3);
      expect(result).toBe(true);

      // Verified: Client detected base mismatch, did NOT apply delta to rev-1 graph,
      // and recovered with fresh snapshot from server.
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(client.getRevision()).toBe('rev-3');
      expect(client.getSequence()).toBe(3);
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(3);
      expect(client.getSnapshot()?.graph.nodes.some((n) => n.name === 'gamma')).toBe(true);
    });

    it('Deliver duplicate and mismatched-base deltas sequentially (Scenario 2)', async () => {
      const snap1 = createMockAnalysis('rev-1', 1, ['base']);
      const snap2 = createMockAnalysis('rev-2', 2, ['base', 'extra']);
      const snap3 = createMockAnalysis('rev-3', 3, ['base', 'extra', 'final']);

      const delta1to2 = createGraphUpdate(snap1, snap2, 'p1');
      const mismatchedDelta = createGraphUpdate(
        createMockAnalysis('unknown-rev', 99, []),
        createMockAnalysis('corrupt-rev', 100, []),
        'p1'
      );

      const fetchSnapshot = vi.fn().mockResolvedValue(snap3);

      const client = new AnalysisClient({
        projectId: 'p1',
        initialSnapshot: snap1,
        fetchSnapshot,
      });

      // 1. Deliver valid delta 1->2
      await client.applyDelta(delta1to2);
      expect(client.getRevision()).toBe('rev-2');
      expect(fetchSnapshot).not.toHaveBeenCalled();

      // 2. Deliver duplicate delta 1->2
      const duplicateResult = await client.applyDelta(delta1to2);
      expect(duplicateResult).toBe(false);
      expect(client.getRevision()).toBe('rev-2');
      expect(fetchSnapshot).not.toHaveBeenCalled();

      // 3. Deliver mismatched-base delta
      const mismatchResult = await client.applyDelta(mismatchedDelta);
      expect(mismatchResult).toBe(true);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(client.getRevision()).toBe('rev-3');
      expect(client.getSnapshot()?.graph.nodes).toHaveLength(3);
    });

    it('Coalesces simultaneous fresh snapshot fetch requests safely', async () => {
      const freshSnap = createMockAnalysis('rev-fresh', 5, ['fresh']);
      let resolvePromise: (val: Analysis) => void;
      const fetchPromise = new Promise<Analysis>((resolve) => {
        resolvePromise = resolve;
      });

      const fetchSnapshot = vi.fn().mockImplementation(() => fetchPromise);

      const client = new AnalysisClient({
        projectId: 'coalesce-proj',
        fetchSnapshot,
      });

      // Trigger 3 concurrent fetch requests
      const p1 = client.fetchFreshSnapshot();
      const p2 = client.fetchFreshSnapshot();
      const p3 = client.fetchFreshSnapshot();

      resolvePromise!(freshSnap);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.revision).toBe('rev-fresh');
      expect(r2.revision).toBe('rev-fresh');
      expect(r3.revision).toBe('rev-fresh');

      // Only one actual network fetch was initiated
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    });

    it('Status and diagnostics events update client state appropriately', async () => {
      const initial = createMockAnalysis('rev-1', 1, ['alpha']);
      const client = new AnalysisClient({
        projectId: 'status-proj',
        initialSnapshot: initial,
      });

      let statusEventReceived: SseStatusEvent | null = null;
      client.on('status', (evt) => {
        statusEventReceived = evt;
      });

      // 1. Status event: updating
      await client.handleEvent('status', 'id-status-1', {
        event: 'status',
        type: 'status',
        projectId: 'status-proj',
        status: 'updating',
        revision: 'rev-1',
        sequence: 1,
        message: 'Analysis running',
      });

      expect(client.getStatus()).toBe('updating');
      expect((statusEventReceived as SseStatusEvent | null)?.status).toBe('updating');

      // 2. Diagnostics event
      let diagEventReceived: SseDiagnosticsEvent | null = null;
      client.on('diagnostics', (evt) => {
        diagEventReceived = evt;
      });

      await client.handleEvent('diagnostics', 'id-diag-1', {
        event: 'diagnostics',
        type: 'diagnostics',
        projectId: 'status-proj',
        revision: 'rev-1',
        sequence: 1,
        diagnostics: [{ severity: 'warning', code: 'W100', message: 'Test warning' }],
      });

      expect((diagEventReceived as SseDiagnosticsEvent | null)?.diagnostics).toHaveLength(1);
      expect(client.getSnapshot()?.quality.diagnostics).toHaveLength(1);
      expect(client.getSnapshot()?.quality.diagnostics[0].code).toBe('W100');
    });
  });

  describe('Integration with Live Server: Reconnection & Concrete Scenarios', () => {
    let tmpDir: string;
    let sourceDir: string;
    let store: ProjectStore;
    let worker: AnalysisWorker;
    let sync: SyncService;
    let app: any;
    let serverAddress: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 't055-live-'));
      sourceDir = join(tmpDir, 'source');
      await mkdir(sourceDir, { recursive: true });

      await writeFile(
        join(sourceDir, 'index.ts'),
        'export function alpha(): string { return "alpha"; }\n'
      );

      store = new ProjectStore(tmpDir);
      worker = new AnalysisWorker();
      sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
      app = await createServer({ store, sync, worker });
      serverAddress = await app.listen({ host: '127.0.0.1', port: 0 });
    });

    afterEach(async () => {
      await app?.close();
      await sync?.close();
      await worker?.close();
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('Concrete Scenario 1: Drop an event and reconnect with an old revision', async () => {
      const project = await store.create({ name: 'Reconnect Workspace', root: sourceDir });
      const apiBaseUrl = `${serverAddress}/api`;

      // 1. Initial connection: client connects and receives Revision 1 snapshot
      const client = new AnalysisClient({
        projectId: project.id,
        baseUrl: apiBaseUrl,
        origin: 'http://127.0.0.1:5173',
      });

      let snapshotReadyPromise = new Promise<Analysis>((resolve) => {
        const off = client.on('snapshot', (snap) => {
          if (snap.revision) {
            off();
            resolve(snap);
          }
        });
      });

      await client.connect();
      const initialSnapshot = await snapshotReadyPromise;
      expect(initialSnapshot.revision).toBeTruthy();
      expect(initialSnapshot.graph.nodes.some((n) => n.name === 'alpha')).toBe(true);

      const oldRevision = initialSnapshot.revision;
      const oldSequence = initialSnapshot.sequence;
      const lastEventIdBeforeDisconnect = client.getLastEventId();
      expect(lastEventIdBeforeDisconnect).toBeTruthy();

      // 2. Disconnect client (simulating dropped connection / missed events)
      client.disconnect();
      expect(client.getConnectionStatus()).toBe('disconnected');

      // 3. While disconnected, multiple edits occur on the server (Revision advances)
      // Edit 1: add beta
      await writeFile(
        join(sourceDir, 'index.ts'),
        'export function alpha(): string { return "alpha"; }\nexport function beta(): number { return 2; }\n'
      );
      // Wait for sync analysis to complete
      await new Promise((r) => setTimeout(r, 250));

      // Edit 2: add gamma
      await writeFile(
        join(sourceDir, 'index.ts'),
        'export function alpha(): string { return "alpha"; }\nexport function beta(): number { return 2; }\nexport function gamma(): boolean { return true; }\n'
      );
      await new Promise((r) => setTimeout(r, 250));

      const serverProject = await store.get(project.id);
      const latestServerSnapshot = serverProject.analysis!;
      expect(latestServerSnapshot.revision).not.toBe(oldRevision);
      expect(latestServerSnapshot.sequence).toBeGreaterThan(oldSequence);
      expect(latestServerSnapshot.graph.nodes.some((n) => n.name === 'gamma')).toBe(true);

      // 4. Reconnect client using old revision / lastEventId position
      const reconnectedClient = new AnalysisClient({
        projectId: project.id,
        baseUrl: apiBaseUrl,
        initialSnapshot, // starts with old revision
        origin: 'http://127.0.0.1:5173',
      });

      let convergedSnapshotPromise = new Promise<Analysis>((resolve) => {
        reconnectedClient.on('snapshot', (snap) => {
          if (snap.revision === latestServerSnapshot.revision) {
            resolve(snap);
          }
        });
      });

      await reconnectedClient.connect();

      // Verified: Reconnect converges to the fresh server snapshot (AC 2)
      const converged = await convergedSnapshotPromise;
      expect(converged.revision).toBe(latestServerSnapshot.revision);
      expect(converged.sequence).toBe(latestServerSnapshot.sequence);
      expect(converged.graph.nodes.some((n) => n.name === 'alpha')).toBe(true);
      expect(converged.graph.nodes.some((n) => n.name === 'beta')).toBe(true);
      expect(converged.graph.nodes.some((n) => n.name === 'gamma')).toBe(true);

      reconnectedClient.disconnect();
    });

    it('Concrete Scenario 2: Deliver duplicate and mismatched-base deltas on live stream', async () => {
      const project = await store.create({ name: 'Live Delta Workspace', root: sourceDir });
      const apiBaseUrl = `${serverAddress}/api`;

      const client = new AnalysisClient({
        projectId: project.id,
        baseUrl: apiBaseUrl,
        origin: 'http://127.0.0.1:5173',
      });

      // Connect and establish initial baseline
      let baselineReady = new Promise<Analysis>((resolve) => {
        const off = client.on('snapshot', (snap) => {
          off();
          resolve(snap);
        });
      });
      await client.connect();
      const baseline = await baselineReady;
      expect(baseline.graph.nodes.some((n) => n.name === 'alpha')).toBe(true);

      // Trigger server edit to receive live delta
      let liveDeltaPromise = new Promise<SseDeltaEvent>((resolve) => {
        const off = client.on('delta', (evt) => {
          off();
          resolve(evt);
        });
      });

      await writeFile(
        join(sourceDir, 'index.ts'),
        'export function alpha(): string { return "alpha"; }\nexport function multiply(a: number, b: number): number { return a * b; }\n'
      );

      const receivedDelta = await liveDeltaPromise;
      expect(receivedDelta.revision).toBeTruthy();
      expect(client.getSnapshot()?.graph.nodes.some((n) => n.name === 'multiply')).toBe(true);

      const stateAfterDelta = client.getSnapshot()!;

      // 1. Deliver DUPLICATE delta: must be harmless (AC 3)
      const duplicateResult = await client.applyDelta(receivedDelta);
      expect(duplicateResult).toBe(false); // harmless no-op
      expect(client.getSnapshot()?.revision).toBe(stateAfterDelta.revision);
      expect(client.getSnapshot()?.graph.nodes).toEqual(stateAfterDelta.graph.nodes);

      // 2. Deliver MISMATCHED-BASE delta: must not silently corrupt, must converge to server snapshot (AC 1)
      const bogusMismatchedDelta: SseDeltaEvent = {
        event: 'delta',
        type: 'analysis',
        projectId: project.id,
        schemaVersion: 1,
        revision: 'bogus-rev-999',
        baseRevision: 'non-existent-base-rev',
        sequence: 999,
        baseSequence: 998,
        status: 'current',
        delta: {
          changedNodes: [],
          deletedNodes: [stateAfterDelta.graph.nodes[0].id],
          changedEdges: [],
          deletedEdges: [],
          changedRequirements: [],
          deletedRequirements: [],
        },
        quality: stateAfterDelta.quality,
        diagnostics: [],
        analyzedAt: new Date().toISOString(),
        durationMs: 10,
      };

      const mismatchApplied = await client.applyDelta(bogusMismatchedDelta);
      expect(mismatchApplied).toBe(true);

      // Verified: Snapshot was NOT corrupted with deleted node from bogus delta;
      // instead it fetched fresh server snapshot and preserved the valid node!
      expect(client.getSnapshot()?.revision).not.toBe('bogus-rev-999');
      expect(client.getSnapshot()?.graph.nodes.some((n) => n.name === 'alpha')).toBe(true);
      expect(client.getSnapshot()?.graph.nodes.some((n) => n.name === 'multiply')).toBe(true);

      client.disconnect();
    });

    it('Reconnecting client without state advances receives initial snapshot', async () => {
      const project = await store.create({ name: 'Fresh Client Project', root: sourceDir });
      const apiBaseUrl = `${serverAddress}/api`;

      const client = new AnalysisClient({
        projectId: project.id,
        baseUrl: apiBaseUrl,
        origin: 'http://127.0.0.1:5173',
      });

      expect(client.getSnapshot()).toBeNull();

      let snapPromise = new Promise<Analysis>((resolve) => {
        client.on('snapshot', (snap) => resolve(snap));
      });

      await client.connect();
      const snapshot = await snapPromise;

      expect(snapshot).toBeTruthy();
      expect(snapshot.revision).toBeTruthy();
      expect(snapshot.graph.nodes.some((n) => n.name === 'alpha')).toBe(true);

      client.disconnect();
    });
  });
});
