import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../server/store';
import { createServer } from '../server/main';
import { SyncService } from '../server/sync';
import { AnalysisWorker } from '../server/worker';
import {
  applyGraphUpdate,
  reconstructAnalysisSnapshot,
  GraphDeltaSchema,
  GraphUpdateSchema,
  type Graph,
} from '../shared/model';
import {
  SseReadyEventSchema,
  SseStatusEventSchema,
  SseDeltaEventSchema,
  SseDiagnosticsEventSchema,
} from '../shared/api';

interface SseParsedMessage {
  id?: string;
  event?: string;
  data: any;
  raw: string;
}

class TestSseClient {
  public messages: SseParsedMessage[] = [];
  public open = false;
  private controller: AbortController;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private waitResolvers: Array<() => void> = [];

  constructor(
    private url: string,
    private options: { origin?: string; headers?: Record<string, string> } = {}
  ) {
    this.controller = new AbortController();
  }

  async connect(): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(this.options.origin ? { Origin: this.options.origin } : {}),
      ...(this.options.headers ?? {}),
    };

    const res = await fetch(this.url, {
      method: 'GET',
      headers,
      signal: this.controller.signal,
    });

    if (res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream')) {
      this.open = true;
      this.reader = res.body!.getReader();
      void this.readLoop();
    }

    return res;
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this.open && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.parseBuffer();
      }
    } catch {
      // Stream aborted or closed
    } finally {
      this.open = false;
    }
  }

  private parseBuffer() {
    let delimIdx: number;
    while ((delimIdx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, delimIdx);
      this.buffer = this.buffer.slice(delimIdx + 2);
      if (!block.trim()) continue;

      const lines = block.split('\n');
      let id: string | undefined;
      let event: string | undefined;
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith(':')) {
          // SSE comment
          continue;
        } else if (line.startsWith('id: ')) {
          id = line.slice(4).trim();
        } else if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataStr += (dataStr ? '\n' : '') + line.slice(6);
        }
      }

      if (dataStr) {
        let parsedData: any;
        try {
          parsedData = JSON.parse(dataStr);
        } catch {
          parsedData = dataStr;
        }
        this.messages.push({ id, event, data: parsedData, raw: block });
        const resolvers = [...this.waitResolvers];
        this.waitResolvers = [];
        for (const r of resolvers) r();
      }
    }
  }

  async waitForEvent(
    predicate: (msg: SseParsedMessage) => boolean,
    timeoutMs = 5000
  ): Promise<SseParsedMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 50);
        this.waitResolvers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for SSE event. Collected messages: ${JSON.stringify(
        this.messages.map(m => ({ id: m.id, event: m.event }))
      )}`
    );
  }

  async disconnect() {
    this.open = false;
    this.controller.abort();
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
    }
  }
}

describe('T054: Stream analysis events through SSE', () => {
  it('Events identify their project and revision (AC 1 & Work checklist)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-id-rev-'));
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'index.ts'),
      'export function greet(): string { return "hello"; }\n'
    );

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    let client: TestSseClient | undefined;

    try {
      const project = await store.create({ name: 'Identified Project', root: sourceDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      client = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      const res = await client.connect();
      expect(res.status).toBe(200);

      // 1. Ready event identifies project and initial revision
      const readyMsg = await client.waitForEvent(m => m.event === 'ready');
      expect(readyMsg.id).toContain(project.id);
      expect(readyMsg.data.projectId).toBe(project.id);
      expect(readyMsg.data.revision).toBe(project.analysis?.revision);
      expect(readyMsg.data.status).toBe('connected');
      SseReadyEventSchema.parse(readyMsg.data);

      // 2. Trigger edit to verify status, delta, and diagnostics event IDs and payloads
      await writeFile(
        join(sourceDir, 'index.ts'),
        'export function greet(): string { return "world"; }\nexport function version(): number { return 1; }\n'
      );

      // Status transition to updating
      const updatingMsg = await client.waitForEvent(
        m => m.event === 'status' && m.data.status === 'updating'
      );
      expect(updatingMsg.id).toContain(project.id);
      expect(updatingMsg.data.projectId).toBe(project.id);
      expect(updatingMsg.data.revision).toBe(project.analysis?.revision);
      SseStatusEventSchema.parse(updatingMsg.data);

      // Delta event
      const deltaMsg = await client.waitForEvent(m => m.event === 'delta');
      expect(deltaMsg.id).toContain(project.id);
      expect(deltaMsg.data.projectId).toBe(project.id);
      expect(deltaMsg.data.baseRevision).toBe(project.analysis?.revision);
      expect(deltaMsg.data.revision).toBeTruthy();
      expect(deltaMsg.data.revision).not.toBe(project.analysis?.revision);
      expect(deltaMsg.data.status).toBe('current');
      SseDeltaEventSchema.parse(deltaMsg.data);

      // Diagnostics event
      const diagMsg = await client.waitForEvent(m => m.event === 'diagnostics');
      expect(diagMsg.id).toContain(project.id);
      expect(diagMsg.data.projectId).toBe(project.id);
      expect(diagMsg.data.revision).toBe(deltaMsg.data.revision);
      SseDiagnosticsEventSchema.parse(diagMsg.data);

      await client.disconnect();
    } finally {
      if (client) await client.disconnect();
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Disconnection releases resources (AC 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-disconnect-'));
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'math.ts'), 'export function pi(): number { return 3.14; }\n');

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    try {
      const project = await store.create({ name: 'Resource Cleanup', root: sourceDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      const initialSubs = (app as any).getActiveSubscriptions();
      const initialProjectSubs = (app as any).getProjectSubscriptions(project.id);
      const initialListeners = sync.listenerCount('notification');

      expect(initialSubs).toBe(0);
      expect(initialProjectSubs).toBe(0);

      // Client 1 connects
      const client1 = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://localhost:5173',
      });
      await client1.connect();
      await client1.waitForEvent(m => m.event === 'ready');

      expect((app as any).getActiveSubscriptions()).toBe(1);
      expect((app as any).getProjectSubscriptions(project.id)).toBe(1);
      expect(sync.listenerCount('notification')).toBe(initialListeners + 1);

      // Client 2 connects to same project
      const client2 = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      await client2.connect();
      await client2.waitForEvent(m => m.event === 'ready');

      expect((app as any).getActiveSubscriptions()).toBe(2);
      expect((app as any).getProjectSubscriptions(project.id)).toBe(2);
      expect(sync.listenerCount('notification')).toBe(initialListeners + 2);

      // Client 1 disconnects
      await client1.disconnect();
      // Allow Fastify socket close event to propagate
      await new Promise(r => setTimeout(r, 60));

      expect((app as any).getActiveSubscriptions()).toBe(1);
      expect((app as any).getProjectSubscriptions(project.id)).toBe(1);
      expect(sync.listenerCount('notification')).toBe(initialListeners + 1);

      // Client 2 disconnects
      await client2.disconnect();
      await new Promise(r => setTimeout(r, 60));

      // All resources released back to baseline
      expect((app as any).getActiveSubscriptions()).toBe(0);
      expect((app as any).getProjectSubscriptions(project.id)).toBe(0);
      expect(sync.listenerCount('notification')).toBe(initialListeners);
    } finally {
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Foreign origins cannot subscribe (AC 3 & R29)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-origins-'));
    const store = new ProjectStore(dir);
    const app = await createServer({ store });

    try {
      const project = await store.create({ name: 'Origin Enforced' });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // 1. Foreign origin to project SSE stream rejected with 403 Forbidden
      const evilProject = await fetch(`${address}/api/projects/${project.id}/events`, {
        headers: { Origin: 'http://attacker-site.com' },
      });
      expect(evilProject.status).toBe(403);
      expect(evilProject.headers.get('access-control-allow-origin')).toBeNull();
      const evilProjectJson = await evilProject.json();
      expect(evilProjectJson).toEqual(expect.objectContaining({ error: 'Forbidden', statusCode: 403 }));

      // 2. Foreign origin to global events stream rejected with 403
      const evilGlobal = await fetch(`${address}/api/events`, {
        headers: { Origin: 'http://malicious.org:8080' },
      });
      expect(evilGlobal.status).toBe(403);
      expect(evilGlobal.headers.get('access-control-allow-origin')).toBeNull();

      // 3. Null origin rejected
      const nullOrigin = await fetch(`${address}/api/projects/${project.id}/events`, {
        headers: { Origin: 'null' },
      });
      expect(nullOrigin.status).toBe(403);

      // 4. Cross-site request without origin rejected
      const crossSite = await fetch(`${address}/api/projects/${project.id}/events`, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(crossSite.status).toBe(403);

      // 5. Allowed origins succeed
      const allowed1 = await fetch(`${address}/api/projects/${project.id}/events?once=true`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      expect(allowed1.status).toBe(200);
      expect(allowed1.headers.get('content-type')).toContain('text/event-stream');
      expect(allowed1.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');

      const allowed2 = await fetch(`${address}/api/projects/${project.id}/events?once=true`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(allowed2.status).toBe(200);
      expect(allowed2.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Concrete Scenario 1: Subscribe, edit a fixture, and inspect emitted delta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-scenario1-'));
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const initialSource = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function subtract(a: number, b: number): number {',
      '  return a - b;',
      '}',
    ].join('\n');
    await writeFile(join(sourceDir, 'calc.ts'), initialSource);

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    let client: TestSseClient | undefined;

    try {
      const project = await store.create({ name: 'Live Calc', root: sourceDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      client = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      await client.connect();

      // Verify ready event
      const readyMsg = await client.waitForEvent(m => m.event === 'ready');
      expect(readyMsg.data.projectId).toBe(project.id);

      // Baseline snapshot established upon subscription
      const baselineSnapshot = (await store.get(project.id)).analysis!;
      expect(readyMsg.data.revision).toBe(baselineSnapshot.revision);
      expect(readyMsg.data.sequence).toBe(baselineSnapshot.sequence);
      expect(baselineSnapshot.graph.nodes.some(n => n.name === 'add')).toBe(true);
      expect(baselineSnapshot.graph.nodes.some(n => n.name === 'subtract')).toBe(true);

      // Edit fixture: add multiply function, modify add function, and delete subtract function
      const updatedSource = [
        'export function add(a: number, b: number): number {',
        '  return a + b + 0;',
        '}',
        'export function multiply(a: number, b: number): number {',
        '  return a * b;',
        '}',
      ].join('\n');
      await writeFile(join(sourceDir, 'calc.ts'), updatedSource);

      // Wait for delta event
      const deltaMsg = await client.waitForEvent(
        m => m.event === 'delta' && m.data.revision !== baselineSnapshot.revision
      );

      // Inspect emitted delta
      const deltaData = deltaMsg.data;
      expect(deltaData.projectId).toBe(project.id);
      expect(deltaData.baseRevision).toBe(baselineSnapshot.revision);
      expect(deltaData.baseSequence).toBe(baselineSnapshot.sequence);
      expect(deltaData.sequence).toBe(baselineSnapshot.sequence + 1);
      expect(deltaData.status).toBe('current');

      // Validate delta structure
      GraphDeltaSchema.parse(deltaData.delta);

      // delta contains the added 'multiply' function and modified 'add' function
      const addedOrChanged = deltaData.delta.changedNodes;
      expect(addedOrChanged.some((n: any) => n.name === 'multiply')).toBe(true);
      expect(addedOrChanged.some((n: any) => n.name === 'add')).toBe(true);

      // delta contains the deleted 'subtract' function
      expect(deltaData.delta.deletedNodes.length).toBeGreaterThan(0);
      const subNode = baselineSnapshot.graph.nodes.find(n => n.name === 'subtract')!;
      expect(deltaData.delta.deletedNodes).toContain(subNode.id);

      // Apply delta to baseline snapshot and verify complete graph reconstruction
      const reconstructedGraph = applyGraphUpdate(baselineSnapshot, deltaData.update);
      expect(reconstructedGraph.nodes.some(n => n.name === 'multiply')).toBe(true);
      expect(reconstructedGraph.nodes.some(n => n.name === 'add')).toBe(true);
      expect(reconstructedGraph.nodes.some(n => n.name === 'subtract')).toBe(false);

      const reconstructedSnapshot = reconstructAnalysisSnapshot(baselineSnapshot, deltaData.update);
      expect(reconstructedSnapshot.revision).toBe(deltaData.revision);
      expect(reconstructedSnapshot.sequence).toBe(deltaData.sequence);

      await client.disconnect();
    } finally {
      if (client) await client.disconnect();
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Concrete Scenario 2: Disconnect/reconnect and attempt a foreign-origin subscription', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-scenario2-'));
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'app.ts'), 'export function getTitle(): string { return "App"; }\n');

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    try {
      const project = await store.create({ name: 'Reconnect Workspace', root: sourceDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // Step 1: Connect legitimate subscriber
      const client1 = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      await client1.connect();
      const firstReady = await client1.waitForEvent(m => m.event === 'ready');
      expect(firstReady.data.projectId).toBe(project.id);
      expect((app as any).getActiveSubscriptions()).toBe(1);

      // Step 2: Disconnect client1
      const lastReceivedId = firstReady.id;
      await client1.disconnect();
      await new Promise(r => setTimeout(r, 60));
      expect((app as any).getActiveSubscriptions()).toBe(0);

      // Step 3: Reconnect with Last-Event-ID header
      const clientReconnected = new TestSseClient(
        `${address}/api/projects/${project.id}/events`,
        {
          origin: 'http://127.0.0.1:5173',
          headers: { 'Last-Event-ID': lastReceivedId || '' },
        }
      );
      await clientReconnected.connect();
      const reconnectedReady = await clientReconnected.waitForEvent(m => m.event === 'ready');
      expect(reconnectedReady.data.projectId).toBe(project.id);
      expect(reconnectedReady.data.reconnected).toBe(true);
      expect((app as any).getActiveSubscriptions()).toBe(1);

      // Step 4: Attempt a foreign-origin subscription
      const foreignRes = await fetch(`${address}/api/projects/${project.id}/events`, {
        headers: { Origin: 'http://hostile-site.io' },
      });
      expect(foreignRes.status).toBe(403);
      expect(foreignRes.headers.get('access-control-allow-origin')).toBeNull();

      // Legitimate client was untouched and active count is still 1
      expect((app as any).getActiveSubscriptions()).toBe(1);

      // Step 5: Edit fixture to ensure reconnected client receives updates normally
      await writeFile(
        join(sourceDir, 'app.ts'),
        'export function getTitle(): string { return "Updated App"; }\nexport function getVersion(): number { return 2; }\n'
      );
      const deltaMsg = await clientReconnected.waitForEvent(m => m.event === 'delta');
      expect(deltaMsg.data.projectId).toBe(project.id);
      expect(deltaMsg.data.status).toBe('current');

      await clientReconnected.disconnect();
      await new Promise(r => setTimeout(r, 60));
      expect((app as any).getActiveSubscriptions()).toBe(0);
    } finally {
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Streams diagnostics and status transitions on analysis failures and syntax errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-errors-'));
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'valid.ts'), 'export function check(): boolean { return true; }\n');

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    let client: TestSseClient | undefined;

    try {
      const project = await store.create({ name: 'Error Project', root: sourceDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      client = new TestSseClient(`${address}/api/projects/${project.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      await client.connect();
      await client.waitForEvent(m => m.event === 'ready');

      // Write syntax error file
      await writeFile(join(sourceDir, 'valid.ts'), 'export function broken() { = ; } // syntax error\n');

      // Receive status event with stale status and diagnostics
      const staleMsg = await client.waitForEvent(
        m => m.event === 'status' && m.data.status === 'stale',
        6000
      );
      expect(staleMsg.data.projectId).toBe(project.id);
      expect(staleMsg.data.status).toBe('stale');
      expect(staleMsg.data.diagnostics.length).toBeGreaterThan(0);

      // Receive diagnostics event
      const diagMsg = await client.waitForEvent(m => m.event === 'diagnostics', 6000);
      expect(diagMsg.data.projectId).toBe(project.id);
      expect(diagMsg.data.diagnostics.length).toBeGreaterThan(0);

      // Fix the error
      await writeFile(join(sourceDir, 'valid.ts'), 'export function check(): string { return "fixed"; }\n');

      // Status recovers to current and emits clean delta
      const recoveredDelta = await client.waitForEvent(
        m => m.event === 'delta' && m.data.status === 'current',
        6000
      );
      expect(recoveredDelta.data.projectId).toBe(project.id);
      expect(recoveredDelta.data.status).toBe('current');
      expect(recoveredDelta.data.diagnostics).toHaveLength(0);

      await client.disconnect();
    } finally {
      if (client) await client.disconnect();
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Isolates scoped subscriptions between projects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-scoped-'));
    const sourceA = join(dir, 'source-a');
    const sourceB = join(dir, 'source-b');
    await mkdir(sourceA, { recursive: true });
    await mkdir(sourceB, { recursive: true });
    await writeFile(join(sourceA, 'a.ts'), 'export function fnA(): string { return "A"; }\n');
    await writeFile(join(sourceB, 'b.ts'), 'export function fnB(): string { return "B"; }\n');

    const store = new ProjectStore(dir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
    const app = await createServer({ store, sync, worker });

    let clientA: TestSseClient | undefined;
    let clientB: TestSseClient | undefined;

    try {
      const projA = await store.create({ name: 'Project A', root: sourceA });
      const projB = await store.create({ name: 'Project B', root: sourceB });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      clientA = new TestSseClient(`${address}/api/projects/${projA.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });
      clientB = new TestSseClient(`${address}/api/projects/${projB.id}/events`, {
        origin: 'http://127.0.0.1:5173',
      });

      await clientA.connect();
      await clientB.connect();

      await clientA.waitForEvent(m => m.event === 'ready');
      await clientB.waitForEvent(m => m.event === 'ready');

      // Edit only Project A
      await writeFile(join(sourceA, 'a.ts'), 'export function fnA(): string { return "A updated"; }\nexport function fnA2(): number { return 2; }\n');

      const deltaA = await clientA.waitForEvent(m => m.event === 'delta');
      expect(deltaA.data.projectId).toBe(projA.id);

      // Client B did NOT receive any delta for project A
      const leakedDelta = clientB.messages.find(m => m.event === 'delta' || m.data.projectId === projA.id);
      expect(leakedDelta).toBeUndefined();

      await clientA.disconnect();
      await clientB.disconnect();
    } finally {
      if (clientA) await clientA.disconnect();
      if (clientB) await clientB.disconnect();
      await app.close();
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Rejects non-existent projects and invalid IDs on SSE endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't054-invalid-'));
    const store = new ProjectStore(dir);
    const app = await createServer({ store });

    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // Non-existent UUID -> 404
      const missingRes = await fetch(`${address}/api/projects/00000000-0000-0000-0000-000000000000/events`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      expect(missingRes.status).toBe(404);

      // Invalid ID format -> 400
      const invalidRes = await fetch(`${address}/api/projects/bad!id@chars/events`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      expect(invalidRes.status).toBe(400);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
