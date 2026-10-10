import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GraphSchema,
  emptyGraph,
  graphDelta,
  applyGraphUpdate,
  createGraphUpdate,
  reconstructAnalysisSnapshot,
  deleteNodeWithIncidentEdges,
  SnapshotReconciliationError,
  GraphUpdateSchema,
  type Analysis,
  type Graph,
} from '../shared/model';
import { ProjectStore } from '../server/store';
import { SyncService } from '../server/sync';
import { AnalysisWorker } from '../server/worker';

describe('T053: Produce versioned node and edge deltas', () => {
  const dummyQuality = {
    eligibleFiles: 1,
    analyzedFiles: 1,
    unresolvedReferences: 0,
    unsupportedConstructs: 0,
    inferredItems: 0,
    prismaValidation: 'not-applicable' as const,
    diagnostics: [],
  };

  const makeSnapshot = (
    revision: string,
    sequence: number,
    graph: Graph,
    status: Analysis['status'] = 'current',
    diagnostics: Analysis['quality']['diagnostics'] = []
  ): Analysis => ({
    revision,
    sequence,
    analyzedAt: '2026-10-10T20:00:00.000Z',
    durationMs: 42,
    status,
    quality: {
      ...dummyQuality,
      diagnostics,
    },
    graph,
    files: {},
  });

  describe('Checklist & AC 1: Computing added/changed/deleted nodes and edges by stable IDs', () => {
    it('computes additions and modifications by stable IDs from an empty lineage', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'alpha' },
          { id: 'node-b', kind: 'function', name: 'beta' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
        ],
        requirements: [],
      });

      const delta = graphDelta(baseGraph, nextGraph);
      expect(delta.changedNodes).toHaveLength(2);
      expect(delta.changedNodes.map(n => n.id).sort()).toEqual(['node-a', 'node-b']);
      expect(delta.deletedNodes).toEqual([]);
      expect(delta.changedEdges).toHaveLength(1);
      expect(delta.changedEdges[0].id).toBe('edge-ab');
      expect(delta.deletedEdges).toEqual([]);

      const update = createGraphUpdate(undefined, makeSnapshot('rev-1', 1, nextGraph));
      expect(update.baseRevision).toBeNull();
      expect(update.baseSequence).toBe(0);
      expect(update.revision).toBe('rev-1');
      expect(update.sequence).toBe(1);

      const reconstructed = applyGraphUpdate(undefined, update);
      expect(reconstructed).toEqual(nextGraph);
    });

    it('computes property modifications while preserving stable IDs and unmodified items', () => {
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'alpha' },
          { id: 'node-b', kind: 'function', name: 'beta' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
        ],
        requirements: [],
      });

      const nextGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'alpha' },
          { id: 'node-b', kind: 'function', name: 'betaRenamed', description: 'renamed' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
        ],
        requirements: [],
      });

      const delta = graphDelta(baseGraph, nextGraph);
      expect(delta.changedNodes).toHaveLength(1);
      expect(delta.changedNodes[0].id).toBe('node-b');
      expect(delta.changedNodes[0].name).toBe('betaRenamed');
      expect(delta.deletedNodes).toEqual([]);
      expect(delta.changedEdges).toEqual([]);
      expect(delta.deletedEdges).toEqual([]);

      const snap1 = makeSnapshot('rev-1', 1, baseGraph);
      const snap2 = makeSnapshot('rev-2', 2, nextGraph);
      const update = createGraphUpdate(snap1, snap2);

      expect(update.baseRevision).toBe('rev-1');
      expect(update.baseSequence).toBe(1);
      expect(update.revision).toBe('rev-2');
      expect(update.sequence).toBe(2);

      const reconstructed = applyGraphUpdate(snap1, update);
      expect(reconstructed).toEqual(nextGraph);
    });

    it('includes status, diagnostics, source revision, and update sequence in the versioned envelope', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [{ id: 'node-a', kind: 'function', name: 'alpha' }],
        edges: [],
        requirements: [],
      });

      const snap1 = makeSnapshot('rev-1', 1, baseGraph);
      const snap2 = makeSnapshot('rev-2', 2, nextGraph, 'partial', [
        { severity: 'warning', message: 'Incomplete symbol resolution', code: 'unresolved-import' },
      ]);
      snap2.staleEvidence = { scope: 'paths', paths: ['src/unresolved.ts'], reason: 'Unresolved import' };

      const update = createGraphUpdate(snap1, snap2);
      expect(update.status).toBe('partial');
      expect(update.quality.diagnostics).toHaveLength(1);
      expect(update.quality.diagnostics[0].code).toBe('unresolved-import');
      expect(update.staleEvidence).toEqual({
        scope: 'paths',
        paths: ['src/unresolved.ts'],
        reason: 'Unresolved import',
      });
      expect(update.revision).toBe('rev-2');
      expect(update.sequence).toBe(2);
      expect(update.baseRevision).toBe('rev-1');
      expect(update.baseSequence).toBe(1);

      const reconstructedSnapshot = reconstructAnalysisSnapshot(snap1, update);
      expect(reconstructedSnapshot.revision).toBe('rev-2');
      expect(reconstructedSnapshot.sequence).toBe(2);
      expect(reconstructedSnapshot.status).toBe('partial');
      expect(reconstructedSnapshot.quality.diagnostics).toEqual(snap2.quality.diagnostics);
      expect(reconstructedSnapshot.staleEvidence).toEqual(snap2.staleEvidence);
      expect(reconstructedSnapshot.graph).toEqual(nextGraph);
    });
  });

  describe('AC 1 & Concrete Scenario 1: Compare delta application with a fresh next snapshot', () => {
    it('applies sequential deltas across multiple revisions and matches fresh snapshots at each step', () => {
      // Revision 1: initial math module with add
      const graphRev1 = GraphSchema.parse({
        nodes: [
          { id: 'n1', kind: 'module', name: 'math' },
          { id: 'n2', kind: 'function', name: 'add' },
        ],
        edges: [
          { id: 'e1', kind: 'contains', source: 'n1', target: 'n2' },
        ],
        requirements: [],
      });
      const snapRev1 = makeSnapshot('hash-rev-1', 1, graphRev1);

      // Revision 2: add subtract function and requirement
      const graphRev2 = GraphSchema.parse({
        nodes: [
          { id: 'n1', kind: 'module', name: 'math' },
          { id: 'n2', kind: 'function', name: 'add' },
          { id: 'n3', kind: 'function', name: 'subtract' },
        ],
        edges: [
          { id: 'e1', kind: 'contains', source: 'n1', target: 'n2' },
          { id: 'e2', kind: 'contains', source: 'n1', target: 'n3' },
        ],
        requirements: [
          { id: 'r1', text: 'Math functions', nodeIds: ['n2', 'n3'], edgeIds: ['e1', 'e2'] },
        ],
      });
      const snapRev2 = makeSnapshot('hash-rev-2', 2, graphRev2);

      // Revision 3: modify add, remove subtract and its edge & requirement reference
      const graphRev3 = GraphSchema.parse({
        nodes: [
          { id: 'n1', kind: 'module', name: 'math' },
          { id: 'n2', kind: 'function', name: 'addNumbers' },
        ],
        edges: [
          { id: 'e1', kind: 'contains', source: 'n1', target: 'n2' },
        ],
        requirements: [
          { id: 'r1', text: 'Math functions', nodeIds: ['n2'], edgeIds: ['e1'] },
        ],
      });
      const snapRev3 = makeSnapshot('hash-rev-3', 3, graphRev3);

      // Step 1: Initial delta to rev1
      const update1 = createGraphUpdate(undefined, snapRev1);
      const appliedRev1 = applyGraphUpdate(undefined, update1);
      expect(appliedRev1).toEqual(graphRev1);

      // Step 2: Delta rev1 -> rev2
      const update2 = createGraphUpdate(snapRev1, snapRev2);
      const appliedRev2 = applyGraphUpdate(snapRev1, update2);
      expect(appliedRev2).toEqual(graphRev2);

      // Step 3: Delta rev2 -> rev3
      const update3 = createGraphUpdate(snapRev2, snapRev3);
      expect(update3.delta.deletedNodes).toContain('n3');
      expect(update3.delta.deletedEdges).toContain('e2');
      expect(update3.delta.changedNodes[0].name).toBe('addNumbers');
      expect(update3.delta.changedRequirements[0].nodeIds).toEqual(['n2']);

      const appliedRev3 = applyGraphUpdate(snapRev2, update3);
      expect(appliedRev3).toEqual(graphRev3);

      // Snapshot reconstruction
      const snapshotRev3 = reconstructAnalysisSnapshot(snapRev2, update3);
      expect(snapshotRev3.graph).toEqual(graphRev3);
      expect(snapshotRev3.revision).toBe('hash-rev-3');
      expect(snapshotRev3.sequence).toBe(3);
    });
  });

  describe('AC 2 & Concrete Scenario 2: Delete a node with two incident edges', () => {
    it('scenario: deletes a node with two incident edges (incoming and outgoing) and includes orphaned edges in deletions', () => {
      // Node A calls Node B; Node B calls Node C.
      // Node B has two incident edges:
      // - Edge 1 (incoming): source A, target B
      // - Edge 2 (outgoing): source B, target C
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'caller' },
          { id: 'node-b', kind: 'function', name: 'mediator' },
          { id: 'node-c', kind: 'function', name: 'callee' },
        ],
        edges: [
          { id: 'edge-inc', kind: 'calls', source: 'node-a', target: 'node-b' },
          { id: 'edge-out', kind: 'calls', source: 'node-b', target: 'node-c' },
        ],
        requirements: [],
      });

      // Delete Node B: next graph contains only Node A and Node C.
      // Both incident edges are removed because their endpoint Node B no longer exists.
      const nextGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'caller' },
          { id: 'node-c', kind: 'function', name: 'callee' },
        ],
        edges: [],
        requirements: [],
      });

      const delta = graphDelta(baseGraph, nextGraph);

      // AC 2: Deletions include orphaned edges
      expect(delta.deletedNodes).toEqual(['node-b']);
      expect(delta.deletedEdges.sort()).toEqual(['edge-inc', 'edge-out'].sort());
      expect(delta.changedNodes).toEqual([]);
      expect(delta.changedEdges).toEqual([]);

      const snapBase = makeSnapshot('rev-base', 10, baseGraph);
      const snapNext = makeSnapshot('rev-next', 11, nextGraph);
      const update = createGraphUpdate(snapBase, snapNext);

      expect(update.delta.deletedNodes).toContain('node-b');
      expect(update.delta.deletedEdges).toContain('edge-inc');
      expect(update.delta.deletedEdges).toContain('edge-out');

      // Applying the delta reconstructs nextGraph without orphaned edges
      const reconstructed = applyGraphUpdate(snapBase, update);
      expect(reconstructed).toEqual(nextGraph);
      expect(reconstructed.nodes.find(n => n.id === 'node-b')).toBeUndefined();
      expect(reconstructed.edges).toHaveLength(0);
    });

    it('scenario: deletes a node with two incoming incident edges', () => {
      // Node A calls Node C; Node B calls Node C.
      // Node C has two incoming incident edges.
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'callerA' },
          { id: 'node-b', kind: 'function', name: 'callerB' },
          { id: 'node-c', kind: 'function', name: 'target' },
        ],
        edges: [
          { id: 'edge-ac', kind: 'calls', source: 'node-a', target: 'node-c' },
          { id: 'edge-bc', kind: 'calls', source: 'node-b', target: 'node-c' },
        ],
        requirements: [],
      });

      const nextGraph = deleteNodeWithIncidentEdges(baseGraph, 'node-c');
      expect(nextGraph.nodes.map(n => n.id).sort()).toEqual(['node-a', 'node-b']);
      expect(nextGraph.edges).toEqual([]);

      const delta = graphDelta(baseGraph, nextGraph);
      expect(delta.deletedNodes).toEqual(['node-c']);
      expect(delta.deletedEdges.sort()).toEqual(['edge-ac', 'edge-bc'].sort());

      const update = createGraphUpdate(makeSnapshot('rev-1', 1, baseGraph), makeSnapshot('rev-2', 2, nextGraph));
      const applied = applyGraphUpdate(makeSnapshot('rev-1', 1, baseGraph), update);
      expect(applied).toEqual(nextGraph);
    });

    it('scenario: deletes a node with two outgoing incident edges', () => {
      // Node A calls Node B and Node C.
      // Node A has two outgoing incident edges.
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'dispatcher' },
          { id: 'node-b', kind: 'function', name: 'workerB' },
          { id: 'node-c', kind: 'function', name: 'workerC' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
          { id: 'edge-ac', kind: 'calls', source: 'node-a', target: 'node-c' },
        ],
        requirements: [],
      });

      const nextGraph = deleteNodeWithIncidentEdges(baseGraph, 'node-a');
      expect(nextGraph.nodes.map(n => n.id).sort()).toEqual(['node-b', 'node-c']);
      expect(nextGraph.edges).toEqual([]);

      const delta = graphDelta(baseGraph, nextGraph);
      expect(delta.deletedNodes).toEqual(['node-a']);
      expect(delta.deletedEdges.sort()).toEqual(['edge-ab', 'edge-ac'].sort());

      const update = createGraphUpdate(makeSnapshot('rev-1', 1, baseGraph), makeSnapshot('rev-2', 2, nextGraph));
      const applied = applyGraphUpdate(makeSnapshot('rev-1', 1, baseGraph), update);
      expect(applied).toEqual(nextGraph);
    });

    it('rejects an invalid delta that deletes a node but omits its incident edges from deletedEdges', () => {
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'caller' },
          { id: 'node-b', kind: 'function', name: 'callee' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
        ],
        requirements: [],
      });
      const snapBase = makeSnapshot('rev-base', 1, baseGraph);

      // Faulty delta: deletes node-b, but deletedEdges is empty (orphaned edge-ab not deleted)
      const faultyUpdate = {
        type: 'analysis' as const,
        schemaVersion: 1 as const,
        baseRevision: 'rev-base',
        baseSequence: 1,
        revision: 'rev-next',
        sequence: 2,
        analyzedAt: '2026-10-10T20:00:00.000Z',
        durationMs: 10,
        status: 'current' as const,
        quality: dummyQuality,
        delta: {
          changedNodes: [],
          deletedNodes: ['node-b'],
          changedEdges: [],
          deletedEdges: [], // Omitted!
          changedRequirements: [],
          deletedRequirements: [],
        },
      };

      // Applying faulty update must fail because edge-ab is left orphaned without target node-b
      expect(() => applyGraphUpdate(snapBase, faultyUpdate)).toThrow(/Missing edge endpoint: node-b/i);
    });

    it('cascades deletion through requirements referencing the deleted node and incident edges', () => {
      const baseGraph = GraphSchema.parse({
        nodes: [
          { id: 'node-a', kind: 'function', name: 'alpha' },
          { id: 'node-b', kind: 'function', name: 'beta' },
        ],
        edges: [
          { id: 'edge-ab', kind: 'calls', source: 'node-a', target: 'node-b' },
        ],
        requirements: [
          { id: 'req-1', text: 'Call beta', nodeIds: ['node-b'], edgeIds: ['edge-ab'] },
        ],
      });

      const cleanedNext = deleteNodeWithIncidentEdges(baseGraph, 'node-b');
      expect(cleanedNext.nodes.map(n => n.id)).toEqual(['node-a']);
      expect(cleanedNext.edges).toEqual([]);
      expect(cleanedNext.requirements[0].nodeIds).toEqual([]);
      expect(cleanedNext.requirements[0].edgeIds).toEqual([]);

      const delta = graphDelta(baseGraph, cleanedNext);
      expect(delta.deletedNodes).toEqual(['node-b']);
      expect(delta.deletedEdges).toEqual(['edge-ab']);
      expect(delta.changedRequirements).toHaveLength(1);

      const update = createGraphUpdate(makeSnapshot('r1', 1, baseGraph), makeSnapshot('r2', 2, cleanedNext));
      const reconstructed = applyGraphUpdate(makeSnapshot('r1', 1, baseGraph), update);
      expect(reconstructed).toEqual(cleanedNext);
    });
  });

  describe('AC 3: Invalid bases force snapshot reconciliation', () => {
    it('throws SnapshotReconciliationError when base revision mismatches, explicitly directing client to fetch fresh snapshot', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [{ id: 'node-a', kind: 'function', name: 'alpha' }],
        edges: [],
        requirements: [],
      });

      const snapBase = makeSnapshot('server-rev-A', 5, baseGraph);
      const snapNext = makeSnapshot('server-rev-B', 6, nextGraph);
      const update = createGraphUpdate(snapBase, snapNext);

      // Client is at 'client-rev-outdated'
      const clientSnapshot = makeSnapshot('client-rev-outdated', 5, baseGraph);

      let caughtError: any;
      try {
        applyGraphUpdate(clientSnapshot, update);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SnapshotReconciliationError);
      expect(caughtError.reason).toBe('revision');
      expect(caughtError.message).toMatch(/base revision mismatch; fetch a fresh snapshot/i);
    });

    it('throws SnapshotReconciliationError when base sequence mismatches (e.g. dropped intermediate event)', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [{ id: 'node-a', kind: 'function', name: 'alpha' }],
        edges: [],
        requirements: [],
      });

      const snapBase = makeSnapshot('rev-common', 5, baseGraph);
      const snapNext = makeSnapshot('rev-new', 6, nextGraph);
      const update = createGraphUpdate(snapBase, snapNext);

      // Client missed an event and is at sequence 4 instead of 5
      const clientSnapshot = makeSnapshot('rev-common', 4, baseGraph);

      let caughtError: any;
      try {
        applyGraphUpdate(clientSnapshot, update);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SnapshotReconciliationError);
      expect(caughtError.reason).toBe('sequence');
      expect(caughtError.message).toMatch(/base sequence mismatch; fetch a fresh snapshot/i);
    });

    it('throws SnapshotReconciliationError when client has no prior base (undefined) but update is not initial', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [{ id: 'node-a', kind: 'function', name: 'alpha' }],
        edges: [],
        requirements: [],
      });

      const snapBase = makeSnapshot('rev-1', 1, baseGraph);
      const snapNext = makeSnapshot('rev-2', 2, nextGraph);
      const update = createGraphUpdate(snapBase, snapNext);

      expect(() => applyGraphUpdate(undefined, update)).toThrow(SnapshotReconciliationError);
      expect(() => applyGraphUpdate(undefined, update)).toThrow(/fetch a fresh snapshot/i);
    });

    it('throws SnapshotReconciliationError when client has existing base but update expects empty lineage', () => {
      const baseGraph = emptyGraph();
      const nextGraph = GraphSchema.parse({
        nodes: [{ id: 'node-a', kind: 'function', name: 'alpha' }],
        edges: [],
        requirements: [],
      });

      const initialUpdate = createGraphUpdate(undefined, makeSnapshot('rev-1', 1, nextGraph));
      const clientSnapshot = makeSnapshot('rev-existing', 3, baseGraph);

      expect(() => applyGraphUpdate(clientSnapshot, initialUpdate)).toThrow(SnapshotReconciliationError);
      expect(() => applyGraphUpdate(clientSnapshot, initialUpdate)).toThrow(/fetch a fresh snapshot/i);
    });

    it('rejects malformed update envelopes where sequence does not advance or lineage is contradictory', () => {
      const valid = createGraphUpdate(undefined, makeSnapshot('r1', 1, emptyGraph()));

      // sequence <= baseSequence
      expect(() =>
        GraphUpdateSchema.parse({
          ...valid,
          baseSequence: 2,
          sequence: 2,
        })
      ).toThrow(/sequence/i);

      // null baseRevision with non-zero baseSequence
      expect(() =>
        GraphUpdateSchema.parse({
          ...valid,
          baseRevision: null,
          baseSequence: 1,
        })
      ).toThrow(/empty lineage/i);

      // non-null baseRevision with zero baseSequence
      expect(() =>
        GraphUpdateSchema.parse({
          ...valid,
          baseRevision: 'r0',
          baseSequence: 0,
        })
      ).toThrow(/empty lineage/i);
    });
  });

  describe('End-to-End Live Synchronization: SyncService node deletion with incident edges', () => {
    it('watches source, detects deletion of a node with two incident edges, and publishes versioned delta matching fresh snapshot', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-sync-delta-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'DeltaSyncProject' });

      // Create a TypeScript file where function B has two incident edges:
      // incoming edge: C calls B
      // outgoing edge: B calls A
      await writeFile(
        join(p.root, 'service.ts'),
        `export function funcA(): number {
  return 10;
}

export function funcB(): number {
  return funcA() + 1;
}

export function funcC(): number {
  return funcB() * 2;
}
`
      );

      const worker = new AnalysisWorker();
      const sync = new SyncService(store, { worker, debounceMs: 50 });

      const notifications: any[] = [];
      sync.on('notification', (_id, update) => {
        if (update.type === 'analysis') {
          notifications.push(update);
        }
      });

      try {
        // Initial request establishes baseline snapshot
        await sync.start(p.id);

        const projectAfterInitial = await store.get(p.id);
        const initialAnalysis = projectAfterInitial.analysis!;
        expect(initialAnalysis).toBeDefined();
        expect(initialAnalysis.sequence).toBe(1);

        const nodeA = initialAnalysis.graph.nodes.find(n => n.name === 'funcA')!;
        const nodeB = initialAnalysis.graph.nodes.find(n => n.name === 'funcB')!;
        const nodeC = initialAnalysis.graph.nodes.find(n => n.name === 'funcC')!;
        expect(nodeA).toBeDefined();
        expect(nodeB).toBeDefined();
        expect(nodeC).toBeDefined();

        // Incident edges: C -> B and B -> A
        const edgeCB = initialAnalysis.graph.edges.find(e => e.source === nodeC.id && e.target === nodeB.id)!;
        const edgeBA = initialAnalysis.graph.edges.find(e => e.source === nodeB.id && e.target === nodeA.id)!;
        expect(edgeCB).toBeDefined();
        expect(edgeBA).toBeDefined();

        expect(notifications).toHaveLength(1);
        const initialNotification = notifications[0];
        expect(initialNotification.baseRevision).toBeNull();
        expect(initialNotification.baseSequence).toBe(0);
        expect(initialNotification.sequence).toBe(1);

        // Verify initial delta reconstructs initial graph
        const reconstructedInitial = applyGraphUpdate(undefined, initialNotification);
        expect(reconstructedInitial).toEqual(initialAnalysis.graph);

        // Edit service.ts to DELETE funcB and remove call from funcC
        await writeFile(
          join(p.root, 'service.ts'),
          `export function funcA(): number {
  return 10;
}

export function funcC(): number {
  return 42;
}
`
        );

        // Request next sync cycle
        await sync.request(p.id);

        const projectAfterDelete = await store.get(p.id);
        const updatedAnalysis = projectAfterDelete.analysis!;
        expect(updatedAnalysis.sequence).toBe(2);
        expect(updatedAnalysis.revision).not.toBe(initialAnalysis.revision);

        // In the fresh updated snapshot:
        // funcB is deleted, both incident edges are deleted
        expect(updatedAnalysis.graph.nodes.some(n => n.name === 'funcB')).toBe(false);
        expect(updatedAnalysis.graph.edges.some(e => e.id === edgeCB.id)).toBe(false);
        expect(updatedAnalysis.graph.edges.some(e => e.id === edgeBA.id)).toBe(false);

        // A second analysis notification was published
        expect(notifications).toHaveLength(2);
        const deleteNotification = notifications[1];

        // Verify versioned envelope
        expect(deleteNotification.baseRevision).toBe(initialAnalysis.revision);
        expect(deleteNotification.baseSequence).toBe(1);
        expect(deleteNotification.revision).toBe(updatedAnalysis.revision);
        expect(deleteNotification.sequence).toBe(2);

        // AC 2: Deletions include orphaned edges
        expect(deleteNotification.delta.deletedNodes).toContain(nodeB.id);
        expect(deleteNotification.delta.deletedEdges).toContain(edgeCB.id);
        expect(deleteNotification.delta.deletedEdges).toContain(edgeBA.id);

        // AC 1 & Concrete scenario 1: Applying delta to initial snapshot reconstructs next snapshot
        const reconstructedNext = applyGraphUpdate(initialAnalysis, deleteNotification);
        expect(reconstructedNext).toEqual(updatedAnalysis.graph);

        // AC 3: An invalid base forces snapshot reconciliation
        expect(() =>
          applyGraphUpdate({ ...initialAnalysis, revision: 'wrong-hash' }, deleteNotification)
        ).toThrow(SnapshotReconciliationError);

        expect(() =>
          applyGraphUpdate({ ...initialAnalysis, sequence: 99 }, deleteNotification)
        ).toThrow(SnapshotReconciliationError);
      } finally {
        await sync.close();
        await worker.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
