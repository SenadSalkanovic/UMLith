import {it,expect,describe} from 'vitest';
import {mkdtemp,writeFile,rm,mkdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer,reconcileGraphIdentities} from '../server/analyzer';
import {SyncService} from '../server/sync';
import {freezeNode,protectionIssues,resolveBindingRecord,reconcileSourceBindings,resolveBinding} from '../server/review';
import {captureFiles,hashes} from '../server/files';
import {
  GraphSchema,
  NodeSchema,
  emptyGraph,
  sourceIdentityKey,
  type Analysis,
  type GraphUpdate,
  type Project,
  type ProgramNode,
} from '../shared/model';

describe('T056: Preserve identity for unambiguous source matches', () => {
  describe('Concrete Validation Scenario 1: Insert text before an existing function', () => {
    it('preserves stable function node ID despite line number and source offset shifts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-scenario-1-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'Scenario1' });
      const sync = new SyncService(store, { watch: false });

      const updates: GraphUpdate[] = [];
      sync.on('notification', (_id, event) => {
        if (event.type === 'analysis') {
          updates.push(event as GraphUpdate);
        }
      });

      try {
        // Initial file with a single function
        const initialCode = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}\n';
        await writeFile(join(p.root, 'orders.ts'), initialCode);

        await sync.start(p.id);

        const beforeProject = await store.get(p.id);
        const originalNode = beforeProject.analysis?.graph.nodes.find(n => n.name === 'calculateTotal');
        expect(originalNode).toBeDefined();
        const originalId = originalNode!.id;
        const originalStart = originalNode!.source?.start;
        const originalLine = originalNode!.source?.line;
        expect(originalLine).toBe(1);

        // Insert text (license comments, imports, other declaration, whitespace) before existing function
        const updatedCode = [
          '/**',
          ' * Order processing module',
          ' * (c) 2026 Test Enterprise Systems',
          ' */',
          "import { normalize } from './utils';",
          '',
          'export const TAX_RATE = 0.08;',
          '',
          'export function getTax(amount: number): number {',
          '  return amount * TAX_RATE;',
          '}',
          '',
          'export function calculateTotal(qty: number, price: number): number {',
          '  return qty * price;',
          '}',
          '',
        ].join('\n');

        await writeFile(join(p.root, 'orders.ts'), updatedCode);
        await sync.request(p.id);

        const afterProject = await store.get(p.id);
        const updatedNode = afterProject.analysis?.graph.nodes.find(n => n.name === 'calculateTotal');
        expect(updatedNode).toBeDefined();

        // 1. Stable node ID is strictly preserved
        expect(updatedNode!.id).toBe(originalId);

        // 2. Source offset and line numbers reflect the new position
        expect(updatedNode!.source?.line).toBe(13);
        expect(updatedNode!.source?.start).toBeGreaterThan(originalStart!);

        // 3. Deltas reflect change to existing node, NOT deletion + recreation
        expect(updates).toHaveLength(2);
        const secondDelta = updates[1].delta;
        expect(secondDelta.deletedNodes).not.toContain(originalId);
        expect(secondDelta.changedNodes.some(n => n.id === originalId)).toBe(true);
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves frozen-implementation baseline validity when inserting text before function', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-protected-offset-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'ProtectedOffset' });
      const sync = new SyncService(store, { watch: false });

      try {
        const initialCode = 'export function secureHash(input: string): string {\n  return "hash:" + input;\n}\n';
        await writeFile(join(p.root, 'crypto.ts'), initialCode);

        await sync.start(p.id);
        const initialProject = await store.get(p.id);
        const initialFn = initialProject.analysis?.graph.nodes.find(n => n.name === 'secureHash')!;

        const frozen = freezeNode(initialFn, 'frozen-implementation', initialProject.analysis);
        await store.updateSpec(p.id, 0, { nodes: [{ ...frozen, parentId: undefined }], edges: [] });

        // Insert code before secureHash without modifying its body
        const modifiedCode = '// Preamble header\nexport const SALT = "abc";\n\n' + initialCode;
        await writeFile(join(p.root, 'crypto.ts'), modifiedCode);

        await sync.request(p.id);
        const currentProject = await store.get(p.id);

        // The node ID is preserved
        const currentFn = currentProject.analysis?.graph.nodes.find(n => n.name === 'secureHash')!;
        expect(currentFn.id).toBe(initialFn.id);
        expect(currentFn.source?.line).toBe(4);

        // Protection issues must be zero because the exact bound text has not changed
        const issues = protectionIssues(currentProject, currentProject.analysis!);
        expect(issues).toHaveLength(0);

        // Specification baseline text remains intact
        const specNode = currentProject.specification.nodes.find(n => n.name === 'secureHash')!;
        expect(specNode.baseline?.text).toBe(frozen.baseline?.text);
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Validation Scenario 2: Rename/move two identical symbols and assert ambiguity', () => {
    it('detects ambiguity and never selects a candidate arbitrarily when two identical symbols are moved/renamed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-scenario-2-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'Scenario2' });
      const sync = new SyncService(store, { watch: false });

      const bindingReviewEvents: any[] = [];
      sync.on('binding-review', (_id, reviews) => {
        bindingReviewEvents.push(reviews);
      });

      try {
        // Two separate modules define identical functions
        await writeFile(join(p.root, 'billingA.ts'), 'export function formatCurrency(amount: number): string {\n  return "$" + amount.toFixed(2);\n}\n');
        await writeFile(join(p.root, 'billingB.ts'), 'export function formatCurrency(amount: number): string {\n  return "$" + amount.toFixed(2);\n}\n');

        await sync.start(p.id);
        const initProject = await store.get(p.id);
        const nodeA = initProject.analysis?.graph.nodes.find(n => n.source?.path === 'billingA.ts' && n.name === 'formatCurrency')!;
        const nodeB = initProject.analysis?.graph.nodes.find(n => n.source?.path === 'billingB.ts' && n.name === 'formatCurrency')!;
        expect(nodeA).toBeDefined();
        expect(nodeB).toBeDefined();
        expect(nodeA.id).not.toBe(nodeB.id);

        // Adopt both into specification with source bindings
        await store.updateSpec(p.id, 0, {
          nodes: [
            { ...nodeA, parentId: undefined, policy: 'sensitive', instructions: 'Handle format A' },
            { ...nodeB, parentId: undefined, policy: 'sensitive', instructions: 'Handle format B' },
          ],
          edges: [],
        });

        // Move/rename both into a single combined module or rename them identically
        // E.g., billingA.ts and billingB.ts are removed, and shared.ts introduces formatCurrencyUSD and formatCurrencyCAD with the same signature
        await rm(join(p.root, 'billingA.ts'));
        await rm(join(p.root, 'billingB.ts'));
        await writeFile(
          join(p.root, 'shared.ts'),
          [
            'export function formatCurrency(amount: number): string { return "$" + amount.toFixed(2); }',
            'export function formatCurrencyBackup(amount: number): string { return "$" + amount.toFixed(2); }',
          ].join('\n')
        );

        await sync.request(p.id);

        const currentProject = await store.get(p.id);
        const reviews = sync.getBindingReviews(p.id);
        expect(reviews.length).toBeGreaterThan(0);

        // Both original symbols must be flagged as ambiguous
        const reviewA = reviews.find(r => r.nodeId === nodeA.id);
        const reviewB = reviews.find(r => r.nodeId === nodeB.id);

        expect(reviewA).toBeDefined();
        expect(reviewB).toBeDefined();

        // 1. Status is ambiguous
        expect(reviewA!.status).toBe('ambiguous');
        expect(reviewB!.status).toBe('ambiguous');

        // 2. Candidates list contains multiple potential matches
        expect(reviewA!.candidates.length).toBeGreaterThanOrEqual(2);
        expect(reviewB!.candidates.length).toBeGreaterThanOrEqual(2);

        // 3. Neither candidate is arbitrarily selected (no guessing)
        expect(reviewA!.selectedCandidate).toBeUndefined();
        expect(reviewB!.selectedCandidate).toBeUndefined();

        // 4. resolveBinding refuses to arbitrarily bind either
        expect(resolveBinding(currentProject.specification.nodes[0], currentProject.analysis!)).toBeUndefined();
        expect(resolveBinding(currentProject.specification.nodes[1], currentProject.analysis!)).toBeUndefined();
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('flags ambiguous rebinding for protected items and prevents automatic baseline reset', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-protected-ambiguity-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'ProtectedAmbiguity' });
      const sync = new SyncService(store, { watch: false });

      try {
        await writeFile(join(p.root, 'alpha.ts'), 'export function authenticate(token: string): boolean {\n  return token.length > 10;\n}\n');
        await writeFile(join(p.root, 'beta.ts'), 'export function authenticate(token: string): boolean {\n  return token.length > 10;\n}\n');

        await sync.start(p.id);
        const initProject = await store.get(p.id);
        const fnAlpha = initProject.analysis?.graph.nodes.find(n => n.source?.path === 'alpha.ts' && n.name === 'authenticate')!;
        const fnBeta = initProject.analysis?.graph.nodes.find(n => n.source?.path === 'beta.ts' && n.name === 'authenticate')!;

        // Freeze both implementations
        const frozenAlpha = freezeNode(fnAlpha, 'frozen-implementation', initProject.analysis!);
        const frozenBeta = freezeNode(fnBeta, 'frozen-implementation', initProject.analysis!);

        await store.updateSpec(p.id, 0, {
          nodes: [{ ...frozenAlpha, parentId: undefined }, { ...frozenBeta, parentId: undefined }],
          edges: [],
        });

        // Now delete alpha and beta, and move one identical function to auth.ts
        await rm(join(p.root, 'alpha.ts'));
        await rm(join(p.root, 'beta.ts'));
        await writeFile(join(p.root, 'auth.ts'), 'export function authenticate(token: string): boolean {\n  return token.length > 10;\n}\n');

        await sync.request(p.id);

        const updatedProject = await store.get(p.id);

        // Both protected nodes should produce visible binding issues
        const issues = protectionIssues(updatedProject, updatedProject.analysis!);
        expect(issues.some(i => i.nodeId === frozenAlpha.id && i.code === 'binding')).toBe(true);
        expect(issues.some(i => i.nodeId === frozenBeta.id && i.code === 'binding')).toBe(true);

        // Baselines must remain strictly intact; synchronization cannot reset baselines
        const specAlpha = updatedProject.specification.nodes.find(n => n.id === frozenAlpha.id)!;
        const specBeta = updatedProject.specification.nodes.find(n => n.id === frozenBeta.id)!;
        expect(specAlpha.baseline?.text).toBe(frozenAlpha.baseline?.text);
        expect(specBeta.baseline?.text).toBe(frozenBeta.baseline?.text);

        // Binding reviews reflect ambiguity
        const reviews = sync.getBindingReviews(p.id);
        const reviewAlpha = reviews.find(r => r.nodeId === frozenAlpha.id);
        expect(reviewAlpha?.status).toBe('ambiguous');
        expect(reviewAlpha?.selectedCandidate).toBeUndefined();
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 1: Ordinary edits keep existing IDs', () => {
    it('preserves node IDs across multiple functions and member declarations when editing bodies', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-ordinary-edits-'));
      const analyzer = new Analyzer();

      try {
        await writeFile(
          join(dir, 'service.ts'),
          [
            'export class OrderService {',
            '  create(id: string): void {}',
            '  cancel(id: string): void {}',
            '}',
            'export function validateOrder(id: string): boolean {',
            '  return true;',
            '}',
          ].join('\n')
        );

        const a1 = await analyzer.analyze(dir);
        const classNode1 = a1.graph.nodes.find(n => n.name === 'OrderService')!;
        const createMethod1 = a1.graph.nodes.find(n => n.name === 'create')!;
        const cancelMethod1 = a1.graph.nodes.find(n => n.name === 'cancel')!;
        const fnNode1 = a1.graph.nodes.find(n => n.name === 'validateOrder')!;

        // Modify bodies and add comments
        await writeFile(
          join(dir, 'service.ts'),
          [
            '// Updated service implementation',
            'export class OrderService {',
            '  create(id: string): void {',
            '    console.log("created", id);',
            '  }',
            '  cancel(id: string): void {',
            '    console.log("cancelled", id);',
            '  }',
            '}',
            '// Validation logic',
            'export function validateOrder(id: string): boolean {',
            '  return id.length > 5;',
            '}',
          ].join('\n')
        );

        const a2 = await analyzer.analyze(dir, { previousGraph: a1.graph });
        const classNode2 = a2.graph.nodes.find(n => n.name === 'OrderService')!;
        const createMethod2 = a2.graph.nodes.find(n => n.name === 'create')!;
        const cancelMethod2 = a2.graph.nodes.find(n => n.name === 'cancel')!;
        const fnNode2 = a2.graph.nodes.find(n => n.name === 'validateOrder')!;

        expect(classNode2.id).toBe(classNode1.id);
        expect(createMethod2.id).toBe(createMethod1.id);
        expect(cancelMethod2.id).toBe(cancelMethod1.id);
        expect(fnNode2.id).toBe(fnNode1.id);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves Prisma entity and enum IDs across schema edits', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-prisma-'));
      const analyzer = new Analyzer();

      try {
        await mkdir(join(dir, 'prisma'), { recursive: true });
        await writeFile(
          join(dir, 'prisma', 'schema.prisma'),
          [
            'datasource db {',
            '  provider = "sqlite"',
            '}',
            'model User {',
            '  id    Int    @id',
            '  email String',
            '  role  Role',
            '}',
            'enum Role {',
            '  USER',
            '  ADMIN',
            '}',
          ].join('\n')
        );

        const a1 = await analyzer.analyze(dir);
        const user1 = a1.graph.nodes.find(n => n.name === 'User')!;
        const role1 = a1.graph.nodes.find(n => n.name === 'Role')!;

        // Add comments and additional field in schema.prisma
        await writeFile(
          join(dir, 'prisma', 'schema.prisma'),
          [
            'datasource db {',
            '  provider = "sqlite"',
            '}',
            '// User model definition',
            'model User {',
            '  id        Int      @id',
            '  name      String?',
            '  email     String',
            '  role      Role',
            '}',
            '// Role enum definition',
            'enum Role {',
            '  USER',
            '  MANAGER',
            '  ADMIN',
            '}',
          ].join('\n')
        );

        const a2 = await analyzer.analyze(dir, { previousGraph: a1.graph });
        const user2 = a2.graph.nodes.find(n => n.name === 'User')!;
        const role2 = a2.graph.nodes.find(n => n.name === 'Role')!;

        expect(user2.id).toBe(user1.id);
        expect(role2.id).toBe(role1.id);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 2: Ambiguous matches never select a candidate arbitrarily', () => {
    it('refuses to use first-match order or nearest offset to break ties on duplicate keys', () => {
      const nodeSourceA = { path: 'module.ts', symbol: 'item', start: 10, end: 50, line: 2, hash: 'h1', revision: 'r1' };
      const nodeSourceB = { path: 'module.ts', symbol: 'item', start: 100, end: 150, line: 10, hash: 'h1', revision: 'r1' };

      const prevA: ProgramNode = NodeSchema.parse({ id: 'id-a', kind: 'function', name: 'item', source: nodeSourceA, contract: 'item(): void' });
      const prevB: ProgramNode = NodeSchema.parse({ id: 'id-b', kind: 'function', name: 'item', source: nodeSourceB, contract: 'item(): void' });

      const beforeGraph = GraphSchema.parse({
        schemaVersion: 1,
        nodes: [prevA, prevB],
        edges: [],
      });

      const curr1: ProgramNode = NodeSchema.parse({ id: 'new-1', kind: 'function', name: 'item', source: { ...nodeSourceA, start: 12 }, contract: 'item(): void' });
      const curr2: ProgramNode = NodeSchema.parse({ id: 'new-2', kind: 'function', name: 'item', source: { ...nodeSourceB, start: 102 }, contract: 'item(): void' });

      const currentGraph = GraphSchema.parse({
        schemaVersion: 1,
        nodes: [curr1, curr2],
        edges: [],
      });

      const result = reconcileGraphIdentities(beforeGraph, currentGraph);

      // Duplicate keys in both snapshots must produce ambiguity, not arbitrary assignment
      expect(result.ambiguous.length).toBeGreaterThan(0);
      expect(result.idMap.has('new-1')).toBe(false);
      expect(result.idMap.has('new-2')).toBe(false);
    });

    it('rejects arbitrary selection when a moved function has multiple same-named targets', () => {
      const prevNode: ProgramNode = NodeSchema.parse({
        id: 'orig-id',
        kind: 'function',
        name: 'compute',
        source: { path: 'orig.ts', symbol: 'compute', start: 0, end: 30, line: 1, hash: 'h', revision: 'r1' },
        contract: 'compute(n: number): number',
      });

      const beforeGraph = GraphSchema.parse({
        schemaVersion: 1,
        nodes: [prevNode],
        edges: [],
      });

      // Target graph has two candidate 'compute' functions in different files
      const candidate1: ProgramNode = NodeSchema.parse({
        id: 'cand-1',
        kind: 'function',
        name: 'compute',
        source: { path: 'targetA.ts', symbol: 'compute', start: 0, end: 30, line: 1, hash: 'h2', revision: 'r2' },
        contract: 'compute(n: number): number',
      });
      const candidate2: ProgramNode = NodeSchema.parse({
        id: 'cand-2',
        kind: 'function',
        name: 'compute',
        source: { path: 'targetB.ts', symbol: 'compute', start: 0, end: 30, line: 1, hash: 'h3', revision: 'r2' },
        contract: 'compute(n: number): number',
      });

      const currentGraph = GraphSchema.parse({
        schemaVersion: 1,
        nodes: [candidate1, candidate2],
        edges: [],
      });

      const result = reconcileGraphIdentities(beforeGraph, currentGraph);

      // Must be marked ambiguous and neither candidate gets orig-id
      expect(result.ambiguous).toHaveLength(1);
      expect(result.ambiguous[0].nodeId).toBe('orig-id');
      expect(result.ambiguous[0].status).toBe('ambiguous');
      expect(result.ambiguous[0].candidates).toHaveLength(2);
      expect(result.idMap.has('cand-1')).toBe(false);
      expect(result.idMap.has('cand-2')).toBe(false);
    });
  });

  describe('Acceptance Criterion 3: Protected items receive visible binding review', () => {
    it('produces actionable binding review records for frozen contract with detailed candidate evidence', () => {
      const frozenNode: ProgramNode = NodeSchema.parse({
        id: 'frozen-user-auth',
        kind: 'function',
        name: 'authenticateUser',
        policy: 'frozen-contract',
        contract: 'authenticateUser(user: string, pass: string): Promise<boolean>',
        baseline: { contract: 'authenticateUser(user: string, pass: string): Promise<boolean>' },
        source: { path: 'auth/legacy.ts', symbol: 'authenticateUser', start: 0, end: 80, line: 1, hash: 'h1', revision: 'r1' },
      });

      // Analyzed graph after refactoring legacy.ts into oauth.ts and local.ts
      const candA: ProgramNode = NodeSchema.parse({
        id: 'oauth-fn',
        kind: 'function',
        name: 'authenticateUser',
        source: { path: 'auth/oauth.ts', symbol: 'authenticateUser', start: 10, end: 90, line: 2, hash: 'h2', revision: 'r2' },
        contract: 'authenticateUser(user: string, pass: string): Promise<boolean>',
      });
      const candB: ProgramNode = NodeSchema.parse({
        id: 'local-fn',
        kind: 'function',
        name: 'authenticateUser',
        source: { path: 'auth/local.ts', symbol: 'authenticateUser', start: 15, end: 95, line: 3, hash: 'h3', revision: 'r2' },
        contract: 'authenticateUser(user: string, pass: string): Promise<boolean>',
      });

      const analysis: Analysis = {
        revision: 'r2',
        sequence: 2,
        analyzedAt: new Date().toISOString(),
        status: 'current',
        graph: GraphSchema.parse({
          schemaVersion: 1,
          nodes: [candA, candB],
          edges: [],
        }),
        files: {
          'auth/oauth.ts': { hash: 'h2', text: 'export async function authenticateUser(user: string, pass: string): Promise<boolean> { return true; }' },
          'auth/local.ts': { hash: 'h3', text: 'export async function authenticateUser(user: string, pass: string): Promise<boolean> { return false; }' },
        },
        durationMs: 10,
        quality: {
          eligibleFiles: 2,
          analyzedFiles: 2,
          unresolvedReferences: 0,
          unsupportedConstructs: 0,
          inferredItems: 0,
          prismaValidation: 'not-applicable',
          diagnostics: [],
        },
      };

      const record = resolveBindingRecord(frozenNode, analysis);
      expect(record.status).toBe('ambiguous');
      expect(record.nodeId).toBe('frozen-user-auth');
      expect(record.policy).toBe('frozen-contract');
      expect(record.selectedCandidate).toBeUndefined();
      expect(record.candidates).toHaveLength(2);

      // Candidates contain source ranges, paths, contracts
      expect(record.candidates[0].source.path).toBe('auth/oauth.ts');
      expect(record.candidates[0].source.line).toBe(2);
      expect(record.candidates[1].source.path).toBe('auth/local.ts');
      expect(record.candidates[1].source.line).toBe(3);

      const reviews = reconcileSourceBindings(
        GraphSchema.parse({ schemaVersion: 1, nodes: [frozenNode], edges: [] }),
        analysis
      );
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toEqual(record);
    });

    it('reports unresolved binding review for deleted protected symbols without guessing', () => {
      const frozenNode: ProgramNode = NodeSchema.parse({
        id: 'deleted-fn',
        kind: 'function',
        name: 'legacyCleanup',
        policy: 'frozen-implementation',
        contract: 'legacyCleanup(): void',
        baseline: { text: 'function legacyCleanup() {}', source: { path: 'legacy.ts', start: 0, end: 27, line: 1, hash: 'h', revision: 'r1' } },
        source: { path: 'legacy.ts', symbol: 'legacyCleanup', start: 0, end: 27, line: 1, hash: 'h', revision: 'r1' },
      });

      const analysis: Analysis = {
        revision: 'r2',
        sequence: 2,
        analyzedAt: new Date().toISOString(),
        status: 'current',
        graph: emptyGraph(),
        files: {},
        durationMs: 5,
        quality: {
          eligibleFiles: 0,
          analyzedFiles: 0,
          unresolvedReferences: 0,
          unsupportedConstructs: 0,
          inferredItems: 0,
          prismaValidation: 'not-applicable',
          diagnostics: [],
        },
      };

      const record = resolveBindingRecord(frozenNode, analysis);
      expect(record.status).toBe('unresolved');
      expect(record.candidates).toHaveLength(0);
      expect(record.selectedCandidate).toBeUndefined();
      expect(record.reason).toContain('not found in analyzed source');
    });
  });
});
