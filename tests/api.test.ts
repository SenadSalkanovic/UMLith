import { it, expect, describe } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/main';
import { ProjectStore } from '../server/store';
import { emptyGraph, GraphSchema, type Project } from '../shared/model';

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
