import {it,expect,describe} from 'vitest';
import {mkdtemp,writeFile,rm,mkdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer,reconcileGraphIdentities} from '../server/analyzer';
import {SyncService} from '../server/sync';
import {freezeNode,protectionIssues,resolveBindingRecord,reconcileSourceBindings,resolveBinding,acceptBinding,acceptBindingInGraph,acceptBindingCandidate} from '../server/review';
import {createServer} from '../server/main';
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

describe('T061: Review ambiguous source bindings without resetting baselines', () => {
  describe('Concrete Validation Scenario 1: Move two same-named protected functions', () => {
    it('detects ambiguous renames/moves for two same-named protected functions, details candidates with ranges/evidence, and retains baselines without arbitrary selection', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-scenario-1-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'Scenario1-MoveTwo' });
      const sync = new SyncService(store, { watch: false });

      const bindingEvents: any[] = [];
      sync.on('binding-review', (_id, records) => {
        bindingEvents.push(records);
      });

      try {
        // Initial files: two same-named functions with distinct implementations in different files
        const codeA = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}\n';
        const codeB = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 1.15;\n}\n';
        await writeFile(join(p.root, 'billingA.ts'), codeA);
        await writeFile(join(p.root, 'billingB.ts'), codeB);

        await sync.start(p.id);

        const projectAfterInitial = await store.get(p.id);
        const nodeA = projectAfterInitial.analysis?.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'billingA.ts');
        const nodeB = projectAfterInitial.analysis?.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'billingB.ts');
        expect(nodeA).toBeDefined();
        expect(nodeB).toBeDefined();

        // Human sets frozen-implementation baselines for both functions
        const frozenA = { ...freezeNode(nodeA!, 'frozen-implementation', projectAfterInitial.analysis), parentId: undefined };
        const frozenB = { ...freezeNode(nodeB!, 'frozen-implementation', projectAfterInitial.analysis), parentId: undefined };
        expect(frozenA.baseline?.text).toBe('export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}');
        expect(frozenB.baseline?.text).toBe('export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 1.15;\n}');

        // Store specification with both frozen nodes
        const specWithProtected = GraphSchema.parse({
          schemaVersion: 1,
          nodes: [frozenA, frozenB],
          edges: [],
        });
        await store.updateSpec(p.id, projectAfterInitial.specRevision, specWithProtected);

        // Move both functions into new subfolder locations: v2/billingA.ts and v2/billingB.ts
        await mkdir(join(p.root, 'v2'), { recursive: true });
        await writeFile(join(p.root, 'v2', 'billingA.ts'), codeA);
        await writeFile(join(p.root, 'v2', 'billingB.ts'), codeB);
        await rm(join(p.root, 'billingA.ts'));
        await rm(join(p.root, 'billingB.ts'));

        // Trigger synchronization
        await sync.request(p.id);

        const projectAfterMove = await store.get(p.id);
        const analysis = projectAfterMove.analysis!;

        // 1. Automatic sync NEVER resets specification baselines
        const specNodeA = projectAfterMove.specification.nodes.find(n => n.id === frozenA.id);
        const specNodeB = projectAfterMove.specification.nodes.find(n => n.id === frozenB.id);
        expect(specNodeA).toBeDefined();
        expect(specNodeB).toBeDefined();
        expect(specNodeA!.baseline?.text).toBe('export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}');
        expect(specNodeB!.baseline?.text).toBe('export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 1.15;\n}');
        expect(specNodeA!.baseline?.source?.path).toBe('billingA.ts');
        expect(specNodeB!.baseline?.source?.path).toBe('billingB.ts');

        // 2. Both protected functions produce explicit ambiguous review records
        const reviews = reconcileSourceBindings(projectAfterMove.specification, analysis);
        expect(reviews).toHaveLength(2);

        const reviewA = reviews.find(r => r.nodeId === frozenA.id);
        const reviewB = reviews.find(r => r.nodeId === frozenB.id);
        expect(reviewA).toBeDefined();
        expect(reviewB).toBeDefined();

        expect(reviewA!.status).toBe('ambiguous');
        expect(reviewB!.status).toBe('ambiguous');

        // Neither candidate is selected arbitrarily
        expect(reviewA!.selectedCandidate).toBeUndefined();
        expect(reviewB!.selectedCandidate).toBeUndefined();

        // 3. Both reviews provide full candidate evidence with paths, ranges, and lines
        expect(reviewA!.candidates.length).toBeGreaterThanOrEqual(2);
        expect(reviewB!.candidates.length).toBeGreaterThanOrEqual(2);

        for (const cand of reviewA!.candidates) {
          expect(cand.source.path).toMatch(/v2\/billing[AB]\.ts/);
          expect(cand.source.line).toBeGreaterThanOrEqual(1);
          expect(typeof cand.source.start).toBe('number');
          expect(typeof cand.source.end).toBe('number');
          expect(cand.contract).toContain('calculateTotal');
          expect(cand.evidenceText).toBeDefined();
          expect(cand.evidenceText).toContain('return qty * price');
        }

        // 4. Protection issues block verification for both ambiguous protected items
        const issues = protectionIssues(projectAfterMove, analysis);
        expect(issues).toHaveLength(2);
        expect(issues.some(i => i.nodeId === frozenA.id && i.code === 'binding')).toBe(true);
        expect(issues.some(i => i.nodeId === frozenB.id && i.code === 'binding')).toBe(true);
        expect(issues[0].message).toContain('ambiguous binding');
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Validation Scenario 2: Accept a binding candidate and verify baseline content is retained', () => {
    it('accepts a binding candidate, updates node source binding, and strictly retains original baseline content', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-scenario-2-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'Scenario2-AcceptCandidate' });
      const sync = new SyncService(store, { watch: false });

      try {
        const originalTextA = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}\n';
        const originalTextB = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 1.15;\n}\n';
        await writeFile(join(p.root, 'ordersA.ts'), originalTextA);
        await writeFile(join(p.root, 'ordersB.ts'), originalTextB);

        await sync.start(p.id);
        const p1 = await store.get(p.id);

        const nodeA = p1.analysis?.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'ordersA.ts')!;
        const nodeB = p1.analysis?.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'ordersB.ts')!;

        const baselineTextA = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}';
        const baselineTextB = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 1.15;\n}';

        const frozenA = { ...freezeNode(nodeA, 'frozen-implementation', p1.analysis), parentId: undefined };
        const frozenB = { ...freezeNode(nodeB, 'frozen-implementation', p1.analysis), parentId: undefined };
        expect(frozenA.baseline?.text).toBe(baselineTextA);
        expect(frozenB.baseline?.text).toBe(baselineTextB);

        await store.updateSpec(p.id, p1.specRevision, GraphSchema.parse({
          schemaVersion: 1,
          nodes: [frozenA, frozenB],
          edges: [],
        }));

        // Move both functions to shared/v2/
        await mkdir(join(p.root, 'shared', 'v2'), { recursive: true });
        await writeFile(join(p.root, 'shared', 'v2', 'calcA.ts'), originalTextA);
        await writeFile(join(p.root, 'shared', 'v2', 'calcB.ts'), originalTextB);
        await rm(join(p.root, 'ordersA.ts'));
        await rm(join(p.root, 'ordersB.ts'));

        await sync.request(p.id);
        const pMoved = await store.get(p.id);
        const analysis = pMoved.analysis!;

        // Find candidate corresponding to calcA
        const candidateNodeA = analysis.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'shared/v2/calcA.ts');
        expect(candidateNodeA).toBeDefined();

        // 1. Human explicitly accepts candidate A for node A
        const { graph: updatedGraph, updatedNode: reboundA } = acceptBindingCandidate(
          pMoved.specification,
          frozenA.id,
          candidateNodeA!.id,
          analysis,
          { preserveBaseline: true }
        );

        // Source binding is updated to new location
        expect(reboundA.source?.path).toBe('shared/v2/calcA.ts');
        expect(reboundA.source?.line).toBe(1);

        // CRUCIAL: Baseline text and historical source are strictly retained!
        expect(reboundA.baseline?.text).toBe(baselineTextA);
        expect(reboundA.baseline?.source?.path).toBe('ordersA.ts');

        // Persist updated specification
        const pAcceptedA = await store.updateSpec(p.id, pMoved.specRevision, updatedGraph);

        // 2. Node A is now unambiguous and passes protection verification because content matches baseline
        const reviewAAfterAccept = resolveBindingRecord(reboundA, analysis);
        expect(reviewAAfterAccept.status).toBe('unambiguous');
        expect(reviewAAfterAccept.selectedCandidate?.id).toBe(candidateNodeA!.id);

        const issuesAfterAcceptA = protectionIssues(pAcceptedA, analysis);
        // Node A has no issues!
        expect(issuesAfterAcceptA.some(i => i.nodeId === frozenA.id)).toBe(false);
        // Node B is still unaccepted and remains blocking
        expect(issuesAfterAcceptA.some(i => i.nodeId === frozenB.id)).toBe(true);

        // 3. Now verify divergence detection: externally modify shared/v2/calcA.ts
        const modifiedTextA = 'export function calculateTotal(qty: number, price: number): number {\n  return qty * price * 0.99;\n}\n';
        await writeFile(join(p.root, 'shared', 'v2', 'calcA.ts'), modifiedTextA);
        await sync.request(p.id);

        const pDiverged = await store.get(p.id);
        const issuesDiverged = protectionIssues(pDiverged, pDiverged.analysis!);

        // Divergence from frozen baseline is detected without resetting the baseline!
        const aViolation = issuesDiverged.find(i => i.nodeId === frozenA.id);
        expect(aViolation).toBeDefined();
        expect(aViolation!.code).toBe('frozen-implementation');
        expect(aViolation!.message).toContain('Frozen implementation changed');

        // The baseline text remains the original baseline, proving it was NOT reset!
        const nodeAStillOriginalBaseline = pDiverged.specification.nodes.find(n => n.id === frozenA.id);
        expect(nodeAStillOriginalBaseline!.baseline?.text).toBe(baselineTextA);

        // 4. Accept candidate B for node B
        const candidateNodeB = pDiverged.analysis!.graph.nodes.find(n => n.name === 'calculateTotal' && n.source?.path === 'shared/v2/calcB.ts');
        expect(candidateNodeB).toBeDefined();

        const { graph: finalGraph, updatedNode: reboundB } = acceptBindingCandidate(
          pDiverged.specification,
          frozenB.id,
          candidateNodeB!.id,
          pDiverged.analysis!,
          { preserveBaseline: true }
        );

        expect(reboundB.source?.path).toBe('shared/v2/calcB.ts');
        expect(reboundB.baseline?.text).toBe(baselineTextB);
        expect(reboundB.baseline?.source?.path).toBe('ordersB.ts');

        await store.updateSpec(p.id, pDiverged.specRevision, finalGraph);
        const pFinal = await store.get(p.id);

        // Node B now passes protection verification because calcB matches baselineTextB
        const finalIssues = protectionIssues(pFinal, pFinal.analysis!);
        expect(finalIssues.some(i => i.nodeId === frozenB.id)).toBe(false);
        // Node A still flags divergence
        expect(finalIssues.some(i => i.nodeId === frozenA.id)).toBe(true);
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts binding candidate for frozen-contract and preserves baseline contract across moves and internal edits', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-frozen-contract-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'FrozenContractRebinding' });

      try {
        const initialCode = 'export function processInvoice(id: string, amount: number): Promise<boolean> {\n  return Promise.resolve(amount > 0);\n}\n';
        await writeFile(join(p.root, 'invoices.ts'), initialCode);

        const analyzer = new Analyzer();
        const initialAnalysis = await analyzer.analyze(p.root);
        const node = initialAnalysis.graph.nodes.find(n => n.name === 'processInvoice')!;

        const frozenContractNode = { ...freezeNode(node, 'frozen-contract', initialAnalysis), parentId: undefined };
        expect(frozenContractNode.policy).toBe('frozen-contract');
        expect(frozenContractNode.baseline?.contract).toBe('processInvoice(id: string, amount: number): Promise<boolean>');

        const spec = GraphSchema.parse({ schemaVersion: 1, nodes: [frozenContractNode], edges: [] });
        await store.updateSpec(p.id, 0, spec);

        // Move to finance/invoices.ts with internal refactoring (same interface contract)
        await mkdir(join(p.root, 'finance'), { recursive: true });
        const movedInternalRefactor = [
          'export function processInvoice(id: string, amount: number): Promise<boolean> {',
          '  console.log("processing invoice", id);',
          '  const isValid = amount > 0 && id.length > 0;',
          '  return Promise.resolve(isValid);',
          '}',
        ].join('\n');
        await writeFile(join(p.root, 'finance', 'invoices.ts'), movedInternalRefactor);
        await rm(join(p.root, 'invoices.ts'));

        const movedAnalysis = await analyzer.analyze(p.root);
        const movedCandidate = movedAnalysis.graph.nodes.find(n => n.name === 'processInvoice')!;

        // Before accepting: moved protected item is ambiguous and requires human review
        const reviewBeforeAccept = resolveBindingRecord(frozenContractNode, movedAnalysis);
        expect(reviewBeforeAccept.status).toBe('ambiguous');
        expect(reviewBeforeAccept.selectedCandidate).toBeUndefined();

        // Human accepts candidate
        const { graph: acceptedGraph, updatedNode: reboundNode } = acceptBindingCandidate(
          spec,
          frozenContractNode.id,
          movedCandidate.id,
          movedAnalysis
        );

        expect(reboundNode.source?.path).toBe('finance/invoices.ts');
        // Baseline contract is strictly preserved!
        expect(reboundNode.baseline?.contract).toBe('processInvoice(id: string, amount: number): Promise<boolean>');

        const projectAccepted = await store.updateSpec(p.id, 1, acceptedGraph);

        // Internal edits under frozen contract pass verification!
        const issuesValid = protectionIssues(projectAccepted, movedAnalysis);
        expect(issuesValid).toHaveLength(0);

        // Now break the contract externally: change parameter type
        const brokenContractCode = 'export function processInvoice(id: number, amount: number): Promise<boolean> {\n  return Promise.resolve(true);\n}\n';
        await writeFile(join(p.root, 'finance', 'invoices.ts'), brokenContractCode);

        const brokenAnalysis = await analyzer.analyze(p.root);
        const issuesBroken = protectionIssues(projectAccepted, brokenAnalysis);
        expect(issuesBroken.some(i => i.code === 'frozen-contract')).toBe(true);
        expect(issuesBroken[0].message).toContain('Frozen interface changed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 1: Ambiguity is visible with actionable review', () => {
    it('produces structured BindingReviewRecord detailing old binding, candidates list with ranges, and actionable reasons', () => {
      const frozenNode: ProgramNode = NodeSchema.parse({
        id: 'fn-payout',
        kind: 'function',
        name: 'calculatePayout',
        policy: 'frozen-implementation',
        contract: 'calculatePayout(acc: string): number',
        baseline: { text: 'function calculatePayout(acc: string) { return 100; }', source: { path: 'old/payout.ts', start: 0, end: 53, line: 1, hash: 'h0', revision: 'r1' } },
        source: { path: 'old/payout.ts', symbol: 'calculatePayout', start: 0, end: 53, line: 1, hash: 'h0', revision: 'r1' },
      });

      const cand1: ProgramNode = NodeSchema.parse({
        id: 'c1',
        kind: 'function',
        name: 'calculatePayout',
        source: { path: 'services/workerA.ts', symbol: 'calculatePayout', start: 100, end: 160, line: 10, hash: 'h1', revision: 'r2' },
        contract: 'calculatePayout(acc: string): number',
      });

      const cand2: ProgramNode = NodeSchema.parse({
        id: 'c2',
        kind: 'function',
        name: 'calculatePayout',
        source: { path: 'services/workerB.ts', symbol: 'calculatePayout', start: 200, end: 270, line: 20, hash: 'h2', revision: 'r2' },
        contract: 'calculatePayout(acc: string): number',
      });

      const analysis: Analysis = {
        revision: 'r2',
        sequence: 2,
        analyzedAt: new Date().toISOString(),
        status: 'current',
        graph: GraphSchema.parse({ schemaVersion: 1, nodes: [cand1, cand2], edges: [] }),
        files: {
          'services/workerA.ts': { hash: 'h1', text: 'export function calculatePayout(acc: string): number { return 100; }' },
          'services/workerB.ts': { hash: 'h2', text: 'export function calculatePayout(acc: string): number { return 200; }' },
        },
        durationMs: 12,
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
      expect(record.nodeId).toBe('fn-payout');
      expect(record.currentBinding?.path).toBe('old/payout.ts');
      expect(record.currentBinding?.line).toBe(1);
      expect(record.baseline?.text).toBe('function calculatePayout(acc: string) { return 100; }');

      expect(record.candidates).toHaveLength(2);
      expect(record.candidates[0].source.path).toBe('services/workerA.ts');
      expect(record.candidates[0].source.line).toBe(10);
      expect(record.candidates[0].evidenceText).toBeDefined();
      expect(record.candidates[1].source.path).toBe('services/workerB.ts');
      expect(record.candidates[1].source.line).toBe(20);
      expect(record.candidates[1].evidenceText).toBeDefined();

      expect(record.selectedCandidate).toBeUndefined();
    });
  });

  describe('Acceptance Criterion 2: Automatic sync never resets baseline', () => {
    it('continuous synchronization never modifies intended specification or resets baselines across multiple external edits', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-no-reset-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'NoResetBaselines' });
      const sync = new SyncService(store, { watch: false });

      try {
        const initial = 'export function computeHash(data: string): string {\n  return "hash_" + data;\n}\n';
        await writeFile(join(p.root, 'crypto.ts'), initial);

        await sync.start(p.id);
        const p1 = await store.get(p.id);
        const node = p1.analysis?.graph.nodes.find(n => n.name === 'computeHash')!;

        const baselineText = 'export function computeHash(data: string): string {\n  return "hash_" + data;\n}';
        const frozen = { ...freezeNode(node, 'frozen-implementation', p1.analysis), parentId: undefined };
        expect(frozen.baseline?.text).toBe(baselineText);

        await store.updateSpec(p.id, p1.specRevision, GraphSchema.parse({
          schemaVersion: 1,
          nodes: [frozen],
          edges: [],
        }));

        const originalSpecRevision = (await store.get(p.id)).specRevision;

        // Perform multiple aggressive external modifications on disk
        for (let i = 1; i <= 3; i++) {
          await writeFile(join(p.root, 'crypto.ts'), `// edit ${i}\nexport function computeHash(data: string): string {\n  return "MODIFIED_${i}_" + data;\n}\n`);
          await sync.request(p.id);

          const currentP = await store.get(p.id);
          // 1. Spec revision remains unchanged (sync never mutates specification)
          expect(currentP.specRevision).toBe(originalSpecRevision);

          // 2. Baseline is strictly intact
          const currentFrozen = currentP.specification.nodes.find(n => n.id === frozen.id)!;
          expect(currentFrozen.baseline?.text).toBe(baselineText);
          expect(currentFrozen.baseline?.source?.path).toBe('crypto.ts');

          // 3. Violation is reported against the intact baseline
          const issues = protectionIssues(currentP, currentP.analysis!);
          expect(issues.some(iss => iss.code === 'frozen-implementation')).toBe(true);
        }
      } finally {
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 3: Unresolved protected items remain unverified', () => {
    it('missing/deleted protected symbol yields unresolved status and blocks verification', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-unresolved-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'UnresolvedProtection' });

      try {
        const frozenNode: ProgramNode = NodeSchema.parse({
          id: 'fn-security-gate',
          kind: 'function',
          name: 'verifySecurityGate',
          policy: 'frozen-implementation',
          contract: 'verifySecurityGate(): boolean',
          baseline: { text: 'function verifySecurityGate() { return true; }', source: { path: 'security.ts', start: 0, end: 40, line: 1, hash: 'h', revision: 'r1' } },
          source: { path: 'security.ts', symbol: 'verifySecurityGate', start: 0, end: 40, line: 1, hash: 'h', revision: 'r1' },
        });

        await store.updateSpec(p.id, 0, GraphSchema.parse({
          schemaVersion: 1,
          nodes: [frozenNode],
          edges: [],
        }));

        // Empty analysis without security.ts
        const emptyAnalysis: Analysis = {
          revision: 'r2',
          sequence: 1,
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

        const proj = await store.get(p.id);
        const issues = protectionIssues(proj, emptyAnalysis);
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('binding');
        expect(issues[0].message).toContain('Protected item cannot be resolved: verifySecurityGate');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('HTTP API Endpoints: GET /api/projects/:id/bindings and POST /api/projects/:id/bindings/accept', () => {
    it('exposes binding review records and accepts binding candidate over HTTP API', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bindings-t061-http-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'HttpBindingTest' });
      const sync = new SyncService(store, { watch: false });
      const app = await createServer({ store, sync });

      try {
        const code = 'export function authorizeRole(role: string): boolean {\n  return role === "admin";\n}\n';
        await writeFile(join(p.root, 'auth.ts'), code);

        await sync.start(p.id);
        const p1 = await store.get(p.id);
        const node = p1.analysis?.graph.nodes.find(n => n.name === 'authorizeRole')!;

        const frozen = { ...freezeNode(node, 'frozen-implementation', p1.analysis), parentId: undefined };
        await store.updateSpec(p.id, p1.specRevision, GraphSchema.parse({
          schemaVersion: 1,
          nodes: [frozen],
          edges: [],
        }));

        // Move auth.ts to security/roles.ts
        await mkdir(join(p.root, 'security'), { recursive: true });
        await writeFile(join(p.root, 'security', 'roles.ts'), code);
        await rm(join(p.root, 'auth.ts'));

        await sync.request(p.id);

        // 1. GET /api/projects/:id/bindings
        const getRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${p.id}/bindings`,
        });
        expect(getRes.statusCode).toBe(200);
        const getBody = JSON.parse(getRes.payload);
        expect(getBody.records).toHaveLength(1);
        expect(getBody.records[0].status).toBe('ambiguous');
        expect(getBody.records[0].candidates).toHaveLength(1);

        const cand = getBody.records[0].candidates[0];

        // 2. POST /api/projects/:id/bindings/accept
        const postRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${p.id}/bindings/accept`,
          payload: {
            nodeId: frozen.id,
            candidateId: cand.id,
            preserveBaseline: true,
          },
        });
        expect(postRes.statusCode).toBe(200);
        const postBody = JSON.parse(postRes.payload);
        expect(postBody.success).toBe(true);
        expect(postBody.node.source.path).toBe('security/roles.ts');
        // Baseline text is strictly preserved!
        expect(postBody.node.baseline.text).toBe(frozen.baseline?.text);

        // Verification now passes without issues
        const updatedProject = await store.get(p.id);
        const issues = protectionIssues(updatedProject, updatedProject.analysis!);
        expect(issues).toHaveLength(0);
      } finally {
        await app.close();
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
