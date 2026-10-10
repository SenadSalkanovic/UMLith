import { it, expect, describe } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, isLoopbackHost, isWildcardHost, isAllowedOrigin, DEFAULT_ALLOWED_ORIGINS } from '../server/main';
import { ProjectStore } from '../server/store';
import { emptyGraph, GraphSchema, type Project, type Analysis } from '../shared/model';
import type { ImportQualityReport } from '../server/analyzer';
import type { AnalysisStatusResponse, ImportQualityReportResponse } from '../shared/api';
import {
  startAnalysis,
  getAnalysisStatus,
  getAnalysisSnapshot,
  getAnalysisReport,
  importProject,
} from '../src/api';

describe('Project and revision API interfaces (T014)', () => {
  it('creates, reloads, and lists a new local project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-create-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      // 1. Create project
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'My Workspace',
          description: 'Local workspace description',
          target: 'Desktop application',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json<Project>();
      expect(created.id).toMatch(/^[a-zA-Z0-9-]+$/);
      expect(created.name).toBe('My Workspace');
      expect(created.description).toBe('Local workspace description');
      expect(created.target).toBe('Desktop application');
      expect(created.managed).toBe(true);
      expect(created.specRevision).toBe(0);
      expect(created.specification).toEqual(emptyGraph());
      expect(created.layout).toEqual({});
      expect(created.layoutRevision).toBe(0);
      expect(created.scopedLayouts).toEqual({});
      expect(created.analysis).toBeUndefined();

      // 2. Reload project
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}`,
      });
      expect(getRes.statusCode).toBe(200);
      const reloaded = getRes.json<Project>();
      expect(reloaded).toEqual(created);

      // 3. List projects
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/projects',
      });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json<Project[]>();
      expect(Array.isArray(list)).toBe(true);
      expect(list.some(p => p.id === created.id)).toBe(true);

      // 4. History endpoint
      const histRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/revisions`,
      });
      expect(histRes.statusCode).toBe(200);
      const history = histRes.json<any[]>();
      expect(history).toHaveLength(1);
      expect(history[0].revision).toBe(0);
      expect(history[0].graph).toEqual(emptyGraph());

      // 5. Layout endpoint
      const layoutRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/layout`,
      });
      expect(layoutRes.statusCode).toBe(200);
      expect(layoutRes.json()).toEqual({
        layout: {},
        layoutRevision: 0,
        scopedLayouts: {},
      });

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates and registers an existing project root with structural import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-import-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const projectRoot = join(dir, 'source-repo');
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        join(projectRoot, 'main.ts'),
        'export function calculateSum(a: number, b: number): number { return a + b; }\nexport class Calculator {}'
      );

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Existing Calculator',
          target: 'Node service',
          root: projectRoot,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const project = createRes.json<Project>();
      expect(project.managed).toBe(false);
      expect(project.specRevision).toBe(0);
      expect(project.specification).toEqual(emptyGraph());
      expect(project.analysis).toBeDefined();
      expect(project.analysis?.graph.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'function', name: 'calculateSum', provenance: 'extracted' }),
        expect.objectContaining({ kind: 'class', name: 'Calculator', provenance: 'extracted' }),
      ]));
      expect(project.analysis?.files['main.ts']?.hash).toBeDefined();

      // Reload project and verify analysis is persisted
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}`,
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json<Project>().analysis?.graph.nodes).toHaveLength(project.analysis!.graph.nodes.length);

      // Adopt specification from analysis
      const adoptRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: project.analysis!.graph,
        },
      });
      expect(adoptRes.statusCode).toBe(200);
      const adopted = adoptRes.json<Project>();
      expect(adopted.specRevision).toBe(1);
      expect(adopted.specification.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'calculateSum' }),
        expect.objectContaining({ name: 'Calculator' }),
      ]));

      // Verify history contains both revision 0 and revision 1
      const historyRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/revisions`,
      });
      expect(historyRes.statusCode).toBe(200);
      const history = historyRes.json<any[]>();
      expect(history).toHaveLength(2);
      expect(history[0].revision).toBe(0);
      expect(history[1].revision).toBe(1);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid project creation requests and prevents malformed storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-invalid-create-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      // 1. Missing name
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { description: 'Missing name' },
      });
      expect(res1.statusCode).toBe(400);
      expect(res1.json().error).toBe('Bad Request');

      // 2. Blank name
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '    ' },
      });
      expect(res2.statusCode).toBe(400);

      // 3. Non-existent root
      const res3 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Invalid Root', root: join(dir, 'does-not-exist') },
      });
      expect(res3.statusCode).toBe(400);
      expect(res3.json().message).toMatch(/does not exist/i);

      // 4. Root is a file rather than a directory
      const filePath = join(dir, 'some-file.txt');
      await writeFile(filePath, 'plain text');
      const res4 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'File Root', root: filePath },
      });
      expect(res4.statusCode).toBe(400);
      expect(res4.json().message).toMatch(/directory/i);

      // 5. Root has invalid TypeScript syntax
      const syntaxDir = join(dir, 'syntax-err');
      await mkdir(syntaxDir);
      await writeFile(join(syntaxDir, 'broken.ts'), 'export function broken( {');
      const res5 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Syntax Err', root: syntaxDir },
      });
      expect(res5.statusCode).toBe(400);
      expect(res5.json().message).toMatch(/syntax/i);

      // 6. Malformed JSON payload
      const res6 = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'content-type': 'application/json' },
        payload: '{"name": "broken',
      });
      expect(res6.statusCode).toBe(400);

      // Confirm no malformed projects were stored
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/projects',
      });
      expect(listRes.json()).toEqual([]);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed graph JSON and preserves stored project validity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-malformed-graph-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const p = await store.create({ name: 'Specification test' });

      // 1. Missing node id
      const res1 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [{ id: '', kind: 'module', name: 'EmptyId' }],
            edges: [],
            requirements: [],
          },
        },
      });
      expect(res1.statusCode).toBe(400);
      expect(res1.json().message).toMatch(/graph\.nodes\.0\.id/);

      // 2. Invalid node kind
      const res2 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [{ id: 'n1', kind: 'invalid-kind', name: 'BadKind' }],
            edges: [],
            requirements: [],
          },
        },
      });
      expect(res2.statusCode).toBe(400);

      // 3. Duplicate node IDs
      const res3 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [
              { id: 'dup', kind: 'module', name: 'ModuleA' },
              { id: 'dup', kind: 'class', name: 'ClassB' },
            ],
            edges: [],
            requirements: [],
          },
        },
      });
      expect(res3.statusCode).toBe(400);
      expect(res3.json().message).toMatch(/duplicate node id/i);

      // 4. Containment cycle
      const res4 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [
              { id: 'n1', kind: 'module', name: 'A', parentId: 'n2' },
              { id: 'n2', kind: 'module', name: 'B', parentId: 'n1' },
            ],
            edges: [],
            requirements: [],
          },
        },
      });
      expect(res4.statusCode).toBe(400);
      expect(res4.json().message).toMatch(/containment cycle/i);

      // 5. Invalid relationship endpoints
      const res5 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [{ id: 'n1', kind: 'module', name: 'A' }],
            edges: [{ id: 'e1', kind: 'contains', source: 'n1', target: 'missing-node' }],
            requirements: [],
          },
        },
      });
      expect(res5.statusCode).toBe(400);
      expect(res5.json().message).toMatch(/missing edge endpoint/i);

      // 6. Unsupported schema version (v2)
      const res6 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 2,
            nodes: [],
            edges: [],
            requirements: [],
          },
        },
      });
      expect(res6.statusCode).toBe(400);

      // 7. Non-object graph
      const res7 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: 'not-a-graph',
        },
      });
      expect(res7.statusCode).toBe(400);

      // CONFIRM stored project is completely untouched after all malformed attempts
      const checkRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}`,
      });
      expect(checkRes.statusCode).toBe(200);
      const cleanProject = checkRes.json<Project>();
      expect(cleanProject.specRevision).toBe(0);
      expect(cleanProject.specification).toEqual(emptyGraph());

      // History still has only the initial revision
      const history = await store.history(p.id);
      expect(history).toHaveLength(1);
      expect(history[0].revision).toBe(0);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects stale specification revisions with explicit 409 conflict details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-conflict-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const p = await store.create({ name: 'Conflict test' });

      const validGraph = {
        schemaVersion: 1 as const,
        nodes: [{ id: 'm1', kind: 'module' as const, name: 'AuthModule', description: '' }],
        edges: [],
        requirements: [],
      };

      // 1. First edit: succeeds from revision 0 -> revision 1
      const edit1 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: validGraph,
        },
      });
      expect(edit1.statusCode).toBe(200);
      expect(edit1.json<Project>().specRevision).toBe(1);

      // 2. Stale edit: client still submits expectedRevision 0
      const staleGraph = {
        schemaVersion: 1 as const,
        nodes: [{ id: 'm2', kind: 'module' as const, name: 'BillingModule', description: '' }],
        edges: [],
        requirements: [],
      };
      const conflictRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: staleGraph,
        },
      });
      expect(conflictRes.statusCode).toBe(409);
      const conflictBody = conflictRes.json();
      expect(conflictBody.error).toBe('Conflict');
      expect(conflictBody.statusCode).toBe(409);
      expect(conflictBody.projectId).toBe(p.id);
      expect(conflictBody.expectedRevision).toBe(0);
      expect(conflictBody.currentRevision).toBe(1);
      expect(conflictBody.message).toMatch(/expected 0, current 1/i);
      expect(conflictBody.message).toMatch(new RegExp(`reload project ${p.id}`, 'i'));

      // Confirm stored project still has the first edit (revision 1), not the stale one
      const currentRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}`,
      });
      const current = currentRes.json<Project>();
      expect(current.specRevision).toBe(1);
      expect(current.specification.nodes).toEqual([expect.objectContaining({ name: 'AuthModule' })]);

      // 3. Client reloads, sees revision 1, and submits with expectedRevision: 1 -> succeeds
      const edit2 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 1,
          graph: staleGraph,
        },
      });
      expect(edit2.statusCode).toBe(200);
      expect(edit2.json<Project>().specRevision).toBe(2);

      // 4. Missing expected revision
      const missingExpected = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          graph: staleGraph,
        },
      });
      expect(missingExpected.statusCode).toBe(400);

      // 5. Negative expected revision
      const negativeExpected = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: -1,
          graph: staleGraph,
        },
      });
      expect(negativeExpected.statusCode).toBe(400);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manages layout endpoints independently from specification revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-layout-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const p = await store.create({ name: 'Layout test' });
      // Add nodes to specification so layout positions are retained
      await store.updateSpec(p.id, 0, {
        schemaVersion: 1,
        nodes: [
          { id: 'node-1', kind: 'module', name: 'Module1' },
          { id: 'node-2', kind: 'module', name: 'Module2' },
        ],
        edges: [],
        requirements: [],
      });
      const projWithNodes = await store.get(p.id);
      expect(projWithNodes.specRevision).toBe(1);
      expect(projWithNodes.layoutRevision).toBe(0);

      // 1. Initial layout GET
      const initialLayout = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}/layout`,
      });
      expect(initialLayout.statusCode).toBe(200);
      expect(initialLayout.json()).toEqual({
        layout: {},
        layoutRevision: 0,
        scopedLayouts: {},
      });

      // 2. Update default layout
      const update1 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/layout`,
        payload: {
          layout: {
            'node-1': { x: 100, y: 150 },
            'node-2': { x: 250, y: 300 },
          },
        },
      });
      expect(update1.statusCode).toBe(200);
      const projAfterLayout1 = update1.json<Project>();
      expect(projAfterLayout1.layoutRevision).toBe(1);
      expect(projAfterLayout1.specRevision).toBe(1); // MUST NOT change specification revision!
      expect(projAfterLayout1.layout).toEqual({
        'node-1': { x: 100, y: 150 },
        'node-2': { x: 250, y: 300 },
      });

      // 3. Update scoped layout view
      const update2 = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/layout`,
        payload: {
          layout: {
            'node-1': { x: 400, y: 500 },
          },
          view: 'architecture:scoped',
        },
      });
      expect(update2.statusCode).toBe(200);
      const projAfterLayout2 = update2.json<Project>();
      expect(projAfterLayout2.layoutRevision).toBe(2);
      expect(projAfterLayout2.specRevision).toBe(1); // STILL 1
      expect(projAfterLayout2.scopedLayouts?.['architecture:scoped']).toEqual({
        'node-1': { x: 400, y: 500 },
      });
      // Default view retained
      expect(projAfterLayout2.layout['node-1']).toEqual({ x: 100, y: 150 });

      // 4. Update layout using PATCH alias and direct position record
      const update3 = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${p.id}/layout`,
        payload: {
          'node-1': { x: 99, y: 88 },
        },
      });
      expect(update3.statusCode).toBe(200);
      expect(update3.json<Project>().layout['node-1']).toEqual({ x: 99, y: 88 });

      // 5. Invalid layout coordinates
      const badLayout = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/layout`,
        payload: {
          layout: {
            'node-1': { x: 'not-a-number', y: 10 },
          },
        },
      });
      expect(badLayout.statusCode).toBe(400);

      // 6. Blank view name
      const badView = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/layout`,
        payload: {
          layout: {},
          view: '    ',
        },
      });
      expect(badView.statusCode).toBe(400);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps missing-project and invalid-id errors to explicit 404 and 400 responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-errors-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      // 404 for missing project on all endpoints
      const getRes = await app.inject({ method: 'GET', url: `/api/projects/${nonExistentId}` });
      expect(getRes.statusCode).toBe(404);
      expect(getRes.json().error).toBe('Not Found');

      const specRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${nonExistentId}/specification`,
        payload: { expectedRevision: 0, graph: emptyGraph() },
      });
      expect(specRes.statusCode).toBe(404);

      const layoutRes = await app.inject({ method: 'GET', url: `/api/projects/${nonExistentId}/layout` });
      expect(layoutRes.statusCode).toBe(404);

      const histRes = await app.inject({ method: 'GET', url: `/api/projects/${nonExistentId}/revisions` });
      expect(histRes.statusCode).toBe(404);

      // 400 for invalid ID format (e.g. traversal attempt or invalid characters)
      const badIdRes = await app.inject({ method: 'GET', url: '/api/projects/invalid@id!' });
      expect(badIdRes.statusCode).toBe(400);
      expect(badIdRes.json().error).toBe('Bad Request');

      // 404 for unknown route
      const unknownRes = await app.inject({ method: 'GET', url: '/api/non-existent-route' });
      expect(unknownRes.statusCode).toBe(404);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves over real HTTP loopback network socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-network-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const healthRes = await fetch(`${address}/api/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: 'ok' });

      const createRes = await fetch(`${address}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Network project' }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as Project;
      expect(created.name).toBe('Network project');

      const getRes = await fetch(`${address}/api/projects/${created.id}`);
      expect(getRes.status).toBe(200);
      const reloaded = await getRes.json() as Project;
      expect(reloaded.id).toBe(created.id);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles concurrent specification updates by committing one and rejecting the other with 409 conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-concurrent-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });
      const p = await store.create({ name: 'Race test' });

      const reqA = app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [{ id: 'a', kind: 'module', name: 'ModuleA' }],
            edges: [],
            requirements: [],
          },
        },
      });

      const reqB = app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        payload: {
          expectedRevision: 0,
          graph: {
            schemaVersion: 1,
            nodes: [{ id: 'b', kind: 'module', name: 'ModuleB' }],
            edges: [],
            requirements: [],
          },
        },
      });

      const [resA, resB] = await Promise.all([reqA, reqB]);
      const statuses = [resA.statusCode, resB.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = resA.statusCode === 409 ? resA : resB;
      const successRes = resA.statusCode === 200 ? resA : resB;

      expect(conflictRes.json()).toEqual(expect.objectContaining({
        error: 'Conflict',
        statusCode: 409,
        projectId: p.id,
        expectedRevision: 0,
        currentRevision: 1,
      }));
      expect(successRes.json<Project>().specRevision).toBe(1);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports specification and history route aliases, omitted graph defaults, and checks endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-aliases-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });
      const p = await store.create({ name: 'Aliases test' });

      // Update via /spec alias and expected (instead of expectedRevision) and omitted schemaVersion/requirements
      const specRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/spec`,
        payload: {
          expected: 0,
          graph: {
            nodes: [{ id: 'm1', kind: 'module', name: 'M1' }],
            edges: [],
          },
        },
      });
      expect(specRes.statusCode).toBe(200);
      expect(specRes.json<Project>().specRevision).toBe(1);
      expect(specRes.json<Project>().specification.schemaVersion).toBe(1);
      expect(specRes.json<Project>().specification.requirements).toEqual([]);

      // GET via /spec and /specification
      const getSpec1 = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/spec` });
      expect(getSpec1.statusCode).toBe(200);
      expect(getSpec1.json().nodes).toHaveLength(1);

      const getSpec2 = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/specification` });
      expect(getSpec2.statusCode).toBe(200);
      expect(getSpec2.json()).toEqual(getSpec1.json());

      // GET via /history alias
      const getHist = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/history` });
      expect(getHist.statusCode).toBe(200);
      expect(getHist.json()).toHaveLength(2);

      // Checks endpoints
      const updateChecks = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/checks`,
        payload: {
          test: { command: 'npm', args: ['test'] },
        },
      });
      expect(updateChecks.statusCode).toBe(200);
      expect(updateChecks.json<Project>().checks).toEqual({
        test: { command: 'npm', args: ['test'] },
      });

      const getChecks = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/checks` });
      expect(getChecks.statusCode).toBe(200);
      expect(getChecks.json()).toEqual({
        test: { command: 'npm', args: ['test'] },
      });

      // Reject invalid check payload (e.g. args not array)
      const badChecks = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/checks`,
        payload: {
          bad: { command: 'echo', args: 'not-array' },
        },
      });
      expect(badChecks.statusCode).toBe(400);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Loopback binding and origin enforcement (T015)', () => {
  it('binds Fastify service to loopback and rejects wildcard and non-loopback interfaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-loopback-'));
    try {
      const store = new ProjectStore(dir);

      // 1. Rejects wildcard and non-loopback host at createServer configuration time
      await expect(createServer({ store, host: '0.0.0.0' })).rejects.toThrow(/non-loopback/i);
      await expect(createServer({ store, host: '::' })).rejects.toThrow(/non-loopback/i);
      await expect(createServer({ store, host: '192.168.1.100' })).rejects.toThrow(/non-loopback/i);

      // 2. Rejects wildcard and non-loopback host at app.listen time
      const app = await createServer({ store });
      await expect(app.listen({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/wildcard/i);
      await expect(app.listen({ host: '::', port: 0 })).rejects.toThrow(/wildcard/i);
      await expect(app.listen({ host: '[::]', port: 0 })).rejects.toThrow(/wildcard/i);
      await expect(app.listen({ host: '192.168.1.50', port: 0 })).rejects.toThrow(/non-loopback/i);

      // 3. Successfully binds to loopback interface and verifies actual listener address
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const serverAddr = app.server.address() as any;
      expect(serverAddr).toBeDefined();
      expect(serverAddr.address).toBe('127.0.0.1');
      expect(serverAddr.address).not.toBe('0.0.0.0');
      expect(serverAddr.address).not.toBe('::');
      expect(typeof serverAddr.port).toBe('number');
      expect(serverAddr.port).toBeGreaterThan(0);
      expect(address).toContain('127.0.0.1');

      // 4. Default listen without host binds to loopback
      const appDefault = await createServer({ store });
      await appDefault.listen({ port: 0 });
      const defaultAddr = appDefault.server.address() as any;
      expect(defaultAddr.address).toBe('127.0.0.1');

      await app.close();
      await appDefault.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles preflight OPTIONS requests for allowed origins and rejects foreign origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-preflight-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      // 1. Allowed Vite dev origin (127.0.0.1:5173) preflight returns 204 with CORS headers
      const resDev1 = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(resDev1.statusCode).toBe(204);
      expect(resDev1.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(resDev1.headers['access-control-allow-methods']).toContain('POST');
      expect(resDev1.headers['access-control-allow-methods']).toContain('GET');
      expect(resDev1.headers['access-control-allow-methods']).toContain('PUT');
      expect(resDev1.headers['access-control-allow-methods']).toContain('DELETE');
      expect(resDev1.headers['access-control-allow-headers']).toBe('content-type');
      expect(resDev1.headers['access-control-max-age']).toBe('86400');
      expect(resDev1.headers['vary']).toBe('Origin');

      // 2. Allowed localhost:5173 dev origin preflight on subroute
      const resDev2 = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects/proj-123/specification',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'PUT',
        },
      });
      expect(resDev2.statusCode).toBe(204);
      expect(resDev2.headers['access-control-allow-origin']).toBe('http://localhost:5173');

      // 3. Allowed IPv6 [::1]:5173 dev origin
      const resDev3 = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://[::1]:5173',
        },
      });
      expect(resDev3.statusCode).toBe(204);
      expect(resDev3.headers['access-control-allow-origin']).toBe('http://[::1]:5173');

      // 4. Foreign origin preflight is rejected with 403 Forbidden without CORS allow header
      const resEvil = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://evil.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(resEvil.statusCode).toBe(403);
      expect(resEvil.headers['access-control-allow-origin']).toBeUndefined();
      expect(resEvil.json()).toEqual(expect.objectContaining({
        error: 'Forbidden',
        statusCode: 403,
      }));

      // 5. Foreign origin preflight on subroute is rejected
      const resEvilSub = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects/some-id/layout',
        headers: {
          origin: 'http://attacker.local:8080',
        },
      });
      expect(resEvilSub.statusCode).toBe(403);
      expect(resEvilSub.headers['access-control-allow-origin']).toBeUndefined();

      // 6. Direct local OPTIONS without origin returns 204 with Allow header
      const resNoOrigin = await app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
      });
      expect(resNoOrigin.statusCode).toBe(204);
      expect(resNoOrigin.headers['allow']).toContain('GET');
      expect(resNoOrigin.headers['access-control-allow-origin']).toBeUndefined();

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects foreign browser origins on reads and mutations and prevents unauthorized state changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-foreign-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const p = await store.create({ name: 'Protected Workspace' });

      // 1. Foreign origin GET on projects list: 403
      const getList = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { origin: 'http://evil.com' },
      });
      expect(getList.statusCode).toBe(403);
      expect(getList.headers['access-control-allow-origin']).toBeUndefined();
      expect(getList.json()).toEqual(expect.objectContaining({ error: 'Forbidden', statusCode: 403 }));

      // 2. Foreign origin GET on single project: 403
      const getProj = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}`,
        headers: { origin: 'http://evil.com' },
      });
      expect(getProj.statusCode).toBe(403);

      // 3. Foreign origin GET on revisions: 403
      const getRevs = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}/revisions`,
        headers: { origin: 'http://evil.com' },
      });
      expect(getRevs.statusCode).toBe(403);

      // 4. Foreign origin GET on layout: 403
      const getLayout = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}/layout`,
        headers: { origin: 'http://evil.com' },
      });
      expect(getLayout.statusCode).toBe(403);

      // 5. Foreign origin GET on health: 403
      const getHealth = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'http://evil.com' },
      });
      expect(getHealth.statusCode).toBe(403);

      // 6. Foreign origin POST (mutation): 403 and project is NOT created
      const postProj = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { origin: 'http://evil.com' },
        payload: { name: 'Malicious Project' },
      });
      expect(postProj.statusCode).toBe(403);
      const allProjects = await store.list();
      expect(allProjects).toHaveLength(1);
      expect(allProjects[0].name).toBe('Protected Workspace');

      // 7. Foreign origin PUT specification (mutation): 403 and spec is NOT updated
      const putSpec = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/specification`,
        headers: { origin: 'http://evil.com' },
        payload: {
          expectedRevision: 0,
          graph: { nodes: [{ id: 'evil-node', kind: 'module', name: 'Evil' }], edges: [] },
        },
      });
      expect(putSpec.statusCode).toBe(403);
      const unchangedProject = await store.get(p.id);
      expect(unchangedProject.specRevision).toBe(0);
      expect(unchangedProject.specification.nodes).toHaveLength(0);

      // 8. Foreign origin PUT layout (mutation): 403 and layout is NOT updated
      const putLayout = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/layout`,
        headers: { origin: 'http://evil.com' },
        payload: { layout: { 'evil-node': { x: 1, y: 2 } } },
      });
      expect(putLayout.statusCode).toBe(403);

      // 9. Foreign origin PUT checks (mutation): 403 and checks are NOT updated
      const putChecks = await app.inject({
        method: 'PUT',
        url: `/api/projects/${p.id}/checks`,
        headers: { origin: 'http://evil.com' },
        payload: { check1: { command: 'echo', args: ['evil'] } },
      });
      expect(putChecks.statusCode).toBe(403);

      // 10. Rejection of other foreign origin shapes
      const foreignOrigins = [
        'https://evil.com',
        'null',
        'http://attacker.local:8080',
        'http://localhost.evil.com',
        'http://127.0.0.1.attacker.com',
        'http://192.168.1.100:5173',
        'http://localhost:8080',
        'http://127.0.0.1:9999',
      ];
      for (const fo of foreignOrigins) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/projects',
          headers: { origin: fo },
        });
        expect(res.statusCode).toBe(403);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces origin policy on SSE event stream routes (/api/events and /api/projects/:id/events)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-sse-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });
      const p = await store.create({ name: 'SSE Workspace' });

      // 1. Foreign origin to /api/events is rejected with 403
      const evilEvents = await app.inject({
        method: 'GET',
        url: '/api/events',
        headers: { origin: 'http://evil.com' },
      });
      expect(evilEvents.statusCode).toBe(403);
      expect(evilEvents.headers['access-control-allow-origin']).toBeUndefined();
      expect(evilEvents.json()).toEqual(expect.objectContaining({ error: 'Forbidden', statusCode: 403 }));

      // 2. Foreign origin to /api/projects/:id/events is rejected with 403
      const evilProjectEvents = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}/events`,
        headers: { origin: 'http://evil.com' },
      });
      expect(evilProjectEvents.statusCode).toBe(403);
      expect(evilProjectEvents.headers['access-control-allow-origin']).toBeUndefined();

      // 3. Allowed dev origin (127.0.0.1:5173) connects to /api/events and receives SSE stream
      const allowedEvents = await app.inject({
        method: 'GET',
        url: '/api/events?once=true',
        headers: { origin: 'http://127.0.0.1:5173' },
      });
      expect(allowedEvents.statusCode).toBe(200);
      expect(allowedEvents.headers['content-type']).toBe('text/event-stream');
      expect(allowedEvents.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(allowedEvents.headers['vary']).toBe('Origin');
      expect(allowedEvents.body).toContain('event: ready');
      expect(allowedEvents.body).toContain('"status":"connected"');

      // 4. Allowed localhost:5173 connects to /api/projects/:id/events and receives project SSE stream
      const allowedProjectEvents = await app.inject({
        method: 'GET',
        url: `/api/projects/${p.id}/events?once=true`,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(allowedProjectEvents.statusCode).toBe(200);
      expect(allowedProjectEvents.headers['content-type']).toBe('text/event-stream');
      expect(allowedProjectEvents.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(allowedProjectEvents.body).toContain('event: ready');
      expect(allowedProjectEvents.body).toContain(p.id);

      // 5. Non-existent project on SSE endpoint returns 404
      const missingProjEvents = await app.inject({
        method: 'GET',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/events',
        headers: { origin: 'http://127.0.0.1:5173' },
      });
      expect(missingProjEvents.statusCode).toBe(404);

      // 6. Test over real HTTP loopback network socket with fetch
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // Foreign origin over real socket: 403
      const netEvil = await fetch(`${address}/api/events`, {
        headers: { Origin: 'http://evil.com' },
      });
      expect(netEvil.status).toBe(403);
      expect(netEvil.headers.get('access-control-allow-origin')).toBeNull();

      // Allowed dev origin over real socket: 200 SSE
      const netAllowed = await fetch(`${address}/api/events`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      expect(netAllowed.status).toBe(200);
      expect(netAllowed.headers.get('content-type')).toBe('text/event-stream');
      expect(netAllowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
      const reader = netAllowed.body!.getReader();
      const chunk = await reader.read();
      const decoded = new TextDecoder().decode(chunk.value);
      expect(decoded).toContain('event: ready');
      await reader.cancel();

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports local development and configured custom allowed origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-custom-origins-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({
        store,
        allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      });

      // 1. Configured custom origin is allowed
      const res3000 = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { origin: 'http://localhost:3000' },
      });
      expect(res3000.statusCode).toBe(200);
      expect(res3000.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res3000.headers['vary']).toBe('Origin');

      // 2. Unconfigured origin on port 3001 is rejected
      const res3001 = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { origin: 'http://localhost:3001' },
      });
      expect(res3001.statusCode).toBe(403);

      // 3. Default dev origins still work alongside custom origins
      const resDev = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { origin: 'http://127.0.0.1:5173' },
        payload: { name: 'Dev Origin Project' },
      });
      expect(resDev.statusCode).toBe(201);
      expect(resDev.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports same-origin packaged production serving and client-side routing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-packaged-'));
    try {
      const store = new ProjectStore(dir);
      const staticDir = join(dir, 'dist');
      await mkdir(join(staticDir, 'assets'), { recursive: true });
      await writeFile(
        join(staticDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>UMLith Workspace</title></head><body><div id="root">App</div></body></html>'
      );
      await writeFile(join(staticDir, 'assets', 'index.js'), 'console.log("bundle");');

      const app = await createServer({ store, staticDir });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const serverAddr = app.server.address() as any;
      const origin = `http://127.0.0.1:${serverAddr.port}`;

      // 1. Same-origin root serves index.html
      const rootRes = await fetch(`${address}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain('UMLith Workspace');

      // 2. Same-origin direct index.html request
      const indexRes = await fetch(`${address}/index.html`);
      expect(indexRes.status).toBe(200);
      expect(await indexRes.text()).toContain('UMLith Workspace');

      // 3. Static asset file request
      const assetRes = await fetch(`${address}/assets/index.js`);
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toBe('console.log("bundle");');

      // 4. SPA client-side route fallback serves index.html
      const spaRes = await fetch(`${address}/projects/my-project`);
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toContain('UMLith Workspace');

      // 5. Unknown API route returns 404 JSON, NOT index.html
      const api404 = await fetch(`${address}/api/unknown-endpoint`);
      expect(api404.status).toBe(404);
      const api404Json = await api404.json() as any;
      expect(api404Json.error).toBe('Not Found');

      // 6. Same-origin API mutation with Origin header matching server's own port succeeds
      const createRes = await fetch(`${address}/api/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: origin,
        },
        body: JSON.stringify({ name: 'Production Project' }),
      });
      expect(createRes.status).toBe(201);
      expect(createRes.headers.get('access-control-allow-origin')).toBe(origin);
      const created = await createRes.json() as Project;
      expect(created.name).toBe('Production Project');

      // 7. Same-origin API read
      const getRes = await fetch(`${address}/api/projects/${created.id}`, {
        headers: { Origin: origin },
      });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('access-control-allow-origin')).toBe(origin);

      // 8. Foreign origin is still rejected in production mode
      const evilRes = await fetch(`${address}/api/projects`, {
        headers: { Origin: 'http://evil.com' },
      });
      expect(evilRes.status).toBe(403);
      expect(evilRes.headers.get('access-control-allow-origin')).toBeNull();

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('protects against DNS rebinding and cross-site requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-dns-rebinding-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      // 1. Host header set to foreign domain (DNS rebinding attempt): 403 Forbidden
      const resForeignHost = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: 'evil.com:4317' },
      });
      expect(resForeignHost.statusCode).toBe(403);
      expect(resForeignHost.json().message).toMatch(/foreign host header/i);

      // 2. Host header set to attacker domain: 403 Forbidden
      const resAttackerHost = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: 'attacker.local:8080' },
      });
      expect(resAttackerHost.statusCode).toBe(403);

      // 3. Cross-site request without allowed origin (Sec-Fetch-Site: cross-site): 403
      const resCrossSite = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(resCrossSite.statusCode).toBe(403);
      expect(resCrossSite.json().message).toMatch(/cross-site request/i);

      // 4. Valid loopback Host headers succeed
      const resLoopbackHost = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: '127.0.0.1:4317' },
      });
      expect(resLoopbackHost.statusCode).toBe(200);

      const resLocalhost = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: 'localhost:4317' },
      });
      expect(resLocalhost.statusCode).toBe(200);

      // 5. Security response headers are present
      expect(resLoopbackHost.headers['x-content-type-options']).toBe('nosniff');
      expect(resLoopbackHost.headers['x-frame-options']).toBe('DENY');

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates helper functions isLoopbackHost, isWildcardHost, and isAllowedOrigin', () => {
    // isWildcardHost
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('[::]')).toBe(true);
    expect(isWildcardHost('')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
    expect(isWildcardHost('localhost')).toBe(false);

    // isLoopbackHost
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);

    // isAllowedOrigin
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4317')).toBe(true);
    expect(isAllowedOrigin('http://localhost:4317')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:4317')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:9000', { port: 9000 })).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', { allowedOrigins: ['http://localhost:3000'] })).toBe(true);

    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin(null)).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.5:5173')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com:5173')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.attacker.com')).toBe(false);
  });
});

describe('Expose imports and analysis snapshots through local APIs (T045)', () => {
  it('imports a known fixture via API and compares its graph (T045 concrete scenario 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-fixture-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const fixtureDir = resolve('tests/fixtures/typescript-structure');
      const expectedPath = resolve('tests/fixtures/typescript-structure.expected.json');
      const expectedContent = await readFile(expectedPath, 'utf8');
      const expectedGraph = JSON.parse(expectedContent);

      // 1. Create project via API pointing to the known fixture
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'TypeScript Structure Fixture',
          target: 'TypeScript library',
          root: fixtureDir,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json<Project>();
      expect(created.managed).toBe(false);
      // AC 3: Import does not establish intended architecture automatically
      expect(created.specRevision).toBe(0);
      expect(created.specification).toEqual(emptyGraph());
      expect(created.specification.nodes).toHaveLength(0);
      expect(created.specification.edges).toHaveLength(0);

      // 2. Fetch validated analysis snapshot via GET /api/projects/:id/analysis/snapshot
      const snapshotRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/analysis/snapshot`,
      });
      expect(snapshotRes.statusCode).toBe(200);
      const snapshot = snapshotRes.json<Analysis>();
      expect(snapshot.graph.schemaVersion).toBe(expectedGraph.schemaVersion);
      expect(snapshot.graph.nodes.length).toBe(expectedGraph.nodes.length);
      expect(snapshot.graph.edges.length).toBe(expectedGraph.edges.length);
      expect(snapshot.graph).toEqual(expectedGraph);

      // 3. Fetch validated import-quality report via GET /api/projects/:id/analysis/report
      const reportRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/analysis/report`,
      });
      expect(reportRes.statusCode).toBe(200);
      const report = reportRes.json<ImportQualityReport>();
      // AC 2: Snapshot/report revisions match
      expect(report.revision).toBe(snapshot.revision);
      expect(report.status).toBe(snapshot.status);
      expect(report.eligibleFiles).toBeGreaterThan(0);
      expect(report.analyzedFiles).toBe(report.eligibleFiles);
      expect(report.coverage.isFullyCovered).toBe(true);
      expect(report.behavioralLimitStatement).toBe(
        'File coverage must not be presented as proof of behavioral completeness.'
      );

      // 4. Check analysis status endpoint
      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/analysis/status`,
      });
      expect(statusRes.statusCode).toBe(200);
      const status = statusRes.json<any>();
      expect(status.projectId).toBe(created.id);
      expect(status.status).toBe('current');
      expect(status.revision).toBe(snapshot.revision);
      expect(status.sequence).toBe(snapshot.sequence);

      // 5. Test route aliases: /snapshot, /report, and /import
      const aliasSnapshotRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/snapshot`,
      });
      expect(aliasSnapshotRes.statusCode).toBe(200);
      expect(aliasSnapshotRes.json<Analysis>().revision).toBe(snapshot.revision);

      const aliasReportRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}/report`,
      });
      expect(aliasReportRes.statusCode).toBe(200);
      expect(aliasReportRes.json<ImportQualityReport>().revision).toBe(snapshot.revision);

      // 6. Trigger re-analysis via POST /api/projects/:id/analysis
      const reAnalyzeRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${created.id}/analysis`,
      });
      expect(reAnalyzeRes.statusCode).toBe(200);
      const reAnalysisData = reAnalyzeRes.json<any>();
      expect(reAnalysisData.analysis.revision).toBe(snapshot.revision);
      expect(reAnalysisData.report.revision).toBe(snapshot.revision);

      // Verify specification remained untouched
      const projectReloadRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${created.id}`,
      });
      const reloaded = projectReloadRes.json<Project>();
      expect(reloaded.specRevision).toBe(0);
      expect(reloaded.specification).toEqual(emptyGraph());

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers parse failure while requesting project metadata (T045 concrete scenario 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-parse-fail-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const projectRoot = join(dir, 'source-repo');
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        join(projectRoot, 'valid.ts'),
        'export function validFunc(): string { return "valid"; }\n'
      );

      // 1. Create a valid project
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Responsive Metadata Test',
          root: projectRoot,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const project = createRes.json<Project>();
      expect(project.specRevision).toBe(0);
      expect(project.specification).toEqual(emptyGraph());

      // 2. Introduce invalid syntax in a TypeScript file
      await writeFile(
        join(projectRoot, 'broken.ts'),
        'export function brokenSyntax( {\n'
      );

      // 3. Concurrently trigger analysis while requesting project metadata, project list, and health
      const [analysisRes, metaRes, listRes, healthRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/analysis`,
        }),
        app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}`,
        }),
        app.inject({
          method: 'GET',
          url: '/api/projects',
        }),
        app.inject({
          method: 'GET',
          url: '/api/health',
        }),
      ]);

      // AC 1: The browser remains responsive
      expect(metaRes.statusCode).toBe(200);
      const meta = metaRes.json<Project>();
      expect(meta.id).toBe(project.id);
      expect(meta.name).toBe('Responsive Metadata Test');
      expect(meta.specRevision).toBe(0);
      expect(meta.specification).toEqual(emptyGraph());

      expect(listRes.statusCode).toBe(200);
      expect(listRes.json<Project[]>().some(p => p.id === project.id)).toBe(true);

      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json()).toEqual({ status: 'ok' });

      // AC 1: Analysis errors are explicit
      expect(analysisRes.statusCode).toBe(400);
      const analysisErr = analysisRes.json<any>();
      expect(analysisErr.error).toBe('Bad Request');
      expect(analysisErr.message).toMatch(/syntax/i);
      expect(analysisErr.message).toContain('broken.ts');
      expect(analysisErr.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'analysis-failure',
          message: expect.stringMatching(/syntax/i),
        }),
      ]));

      // 4. Verify analysis status endpoint reports stale state with explicit failure diagnostic
      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/status`,
      });
      expect(statusRes.statusCode).toBe(200);
      const statusData = statusRes.json<any>();
      expect(statusData.status).toBe('stale');
      expect(statusData.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'analysis-failure',
        }),
      ]));

      // 5. Subsequent project metadata request remains responsive and valid
      const recheckMetaRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}`,
      });
      expect(recheckMetaRes.statusCode).toBe(200);
      expect(recheckMetaRes.json<Project>().specification).toEqual(emptyGraph());

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports asynchronous analysis execution and status polling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-async-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const projectRoot = join(dir, 'source-repo');
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        join(projectRoot, 'service.ts'),
        'export class AppService { run(): void {} }\n'
      );

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Async Analysis Test',
          root: projectRoot,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const project = createRes.json<Project>();

      // Start analysis asynchronously with ?async=true
      const startRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/analysis?async=true`,
      });
      expect(startRes.statusCode).toBe(202);
      expect(startRes.json()).toEqual(expect.objectContaining({
        projectId: project.id,
        status: 'updating',
        message: 'Analysis started',
      }));

      // Poll status until done
      let attempts = 0;
      let finalStatus: any;
      while (attempts < 50) {
        attempts++;
        const stRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/analysis/status`,
        });
        expect(stRes.statusCode).toBe(200);
        finalStatus = stRes.json();
        if (finalStatus.status !== 'updating') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(finalStatus.status).toBe('current');

      // Fetch snapshot and report
      const snapshotRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/snapshot`,
      });
      expect(snapshotRes.statusCode).toBe(200);
      const snapshot = snapshotRes.json<Analysis>();

      const reportRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/report`,
      });
      expect(reportRes.statusCode).toBe(200);
      const report = reportRes.json<ImportQualityReport>();

      // Snapshot/report revisions match
      expect(report.revision).toBe(snapshot.revision);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports multi-construct fixture with Prisma schema and unsupported constructs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-import-quality-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      const fixtureDir = resolve('tests/fixtures/import-quality');

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Import Quality Fixture',
          root: fixtureDir,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const project = createRes.json<Project>();
      expect(project.specRevision).toBe(0);
      expect(project.specification).toEqual(emptyGraph());

      // Snapshot has extracted items
      const snapshotRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/snapshot`,
      });
      expect(snapshotRes.statusCode).toBe(200);
      const snapshot = snapshotRes.json<Analysis>();
      expect(snapshot.status).toBe('partial');
      expect(snapshot.graph.nodes.some(n => n.kind === 'class' && n.name === 'UserService')).toBe(true);
      expect(snapshot.graph.nodes.some(n => n.kind === 'step' && n.stepType === 'opaque')).toBe(true);

      // Report has explicit diagnostics and matching revision
      const reportRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/report`,
      });
      expect(reportRes.statusCode).toBe(200);
      const report = reportRes.json<ImportQualityReport>();
      expect(report.revision).toBe(snapshot.revision);
      expect(report.status).toBe('partial');
      expect(report.breakdown.parserDiagnostics).toBeGreaterThanOrEqual(1);
      expect(report.unsupportedConstructs).toBeGreaterThanOrEqual(1);
      expect(report.unresolvedReferences).toBeGreaterThanOrEqual(1);
      expect(report.behavioralLimitStatement).toBe(
        'File coverage must not be presented as proof of behavioral completeness.'
      );

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles missing analysis snapshots and reports cleanly with 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-missing-analysis-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });

      // Blank project without initial analysis
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Blank Project',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const project = createRes.json<Project>();
      expect(project.analysis).toBeUndefined();

      // Snapshot returns 404
      const snapshotRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/snapshot`,
      });
      expect(snapshotRes.statusCode).toBe(404);
      expect(snapshotRes.json().message).toMatch(/not found/i);

      // Report returns 404
      const reportRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/report`,
      });
      expect(reportRes.statusCode).toBe(404);
      expect(reportRes.json().message).toMatch(/not found/i);

      // Status returns stale/0
      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/analysis/status`,
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().status).toBe('stale');

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exercises client helpers from src/api.ts over real loopback network socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-api-client-helpers-'));
    try {
      const store = new ProjectStore(dir);
      const app = await createServer({ store });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      const fixtureDir = resolve('tests/fixtures/typescript-structure');

      // Create project via API
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Client Helper Test',
          root: fixtureDir,
        },
      });
      const project = createRes.json<Project>();

      // Use src/api helpers
      const status = await getAnalysisStatus(project.id, baseUrl);
      expect(status.projectId).toBe(project.id);
      expect(status.status).toBe('current');

      const snapshot = await getAnalysisSnapshot(project.id, baseUrl);
      expect(snapshot.graph.nodes.length).toBeGreaterThan(0);

      const report = await getAnalysisReport(project.id, baseUrl);
      expect(report.revision).toBe(snapshot.revision);

      const importResult = await importProject(project.id, {}, baseUrl);
      expect(importResult.analysis.revision).toBe(snapshot.revision);

      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
