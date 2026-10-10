import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  RevisionHistory,
  buildRevisionItems,
  computeRevisionChanges,
  computeConflictDiff,
  isLayoutOnlyMutation,
  canHistoricalViewOverwrite,
  prepareRestoreEdit,
  type SpecificationConflictState,
} from '../../src/components/RevisionHistory';
import { App } from '../../src/App';
import { Header } from '../../src/components/Header';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore, SpecificationConflictError } from '../../server/store';
import {
  emptyGraph,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Requirement,
} from '../../shared/model';
import type { RevisionRecord } from '../../shared/api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createMockGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'sys-core',
      kind: 'system',
      name: 'CoreSystem',
      description: 'Central system boundary',
      provenance: 'human',
      policy: 'editable',
      contract: 'export interface CoreSystem {}',
      requiredChecks: ['npm test'],
      instructions: 'Primary system',
      outputPath: 'src/core.ts',
      fields: [],
    },
    {
      id: 'mod-auth',
      kind: 'module',
      name: 'AuthModule',
      parentId: 'sys-core',
      description: 'Authentication module',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export interface AuthModule {}',
      requiredChecks: ['npm test'],
      instructions: 'Sensitive auth',
      outputPath: 'src/auth.ts',
      fields: [],
    },
  ];

  const edges: ProgramEdge[] = [
    {
      id: 'edge-sys-mod',
      kind: 'contains',
      source: 'sys-core',
      target: 'mod-auth',
      provenance: 'human',
      label: '',
      uncertain: false,
    },
  ];

  const requirements: Requirement[] = [
    {
      id: 'req-auth',
      text: 'Users must authenticate securely',
      nodeIds: ['mod-auth'],
      edgeIds: [],
      constraints: ['Use TLS 1.3'],
      scenarios: ['Given valid credentials, user logs in'],
    },
  ];

  return {
    schemaVersion: 1,
    nodes,
    edges,
    requirements,
  };
}

function createMockProject(specRevision = 1): Project {
  const spec = createMockGraph();
  return {
    id: 'proj-t028',
    name: 'Revision Workspace',
    description: 'Project for testing revisions and conflict recovery',
    target: 'TypeScript application',
    root: '/test/workspace',
    managed: true,
    createdAt: '2026-10-08T10:00:00.000Z',
    specRevision,
    specification: spec,
    layout: { 'sys-core': { x: 100, y: 150 }, 'mod-auth': { x: 250, y: 300 } },
    layoutRevision: 1,
    scopedLayouts: {},
    checks: {},
  };
}

function createMockRevisionRecords(): RevisionRecord[] {
  const g0 = emptyGraph();
  const g1 = createMockGraph();
  const g2: Graph = {
    ...g1,
    nodes: [
      ...g1.nodes,
      {
        id: 'fn-login',
        kind: 'function',
        name: 'loginUser',
        parentId: 'mod-auth',
        description: 'Authenticates user credentials',
        provenance: 'human',
        policy: 'editable',
        contract: '(creds: Credentials) => Promise<Session>',
        requiredChecks: ['npm test'],
        instructions: 'Secure login handler',
        outputPath: 'src/login.ts',
        fields: [],
      },
    ],
  };

  return [
    {
      schemaVersion: 1,
      revision: 0,
      createdAt: '2026-10-08T10:00:00.000Z',
      graph: g0,
    },
    {
      schemaVersion: 1,
      revision: 1,
      createdAt: '2026-10-08T10:05:00.000Z',
      graph: g1,
    },
    {
      schemaVersion: 1,
      revision: 2,
      createdAt: '2026-10-08T10:10:00.000Z',
      graph: g2,
    },
  ];
}

describe('T028: Expose specification revisions and edit conflicts', () => {
  describe('Work Checklist Item 1 & Acceptance Criterion 1: Show saved revisions without treating layout moves as revisions', () => {
    it('history identifies specification revisions and change summaries accurately', () => {
      const records = createMockRevisionRecords();
      const items = buildRevisionItems(records, 2);

      expect(items).toHaveLength(3);
      // Returned in reverse chronological order
      expect(items[0].revision).toBe(2);
      expect(items[0].isCurrent).toBe(true);
      expect(items[0].nodeCount).toBe(3);
      expect(items[0].changeSummary?.summaryText.some(t => t.includes('fn-login') || t.includes('node'))).toBe(true);

      expect(items[1].revision).toBe(1);
      expect(items[1].isCurrent).toBe(false);
      expect(items[1].nodeCount).toBe(2);

      expect(items[2].revision).toBe(0);
      expect(items[2].isCurrent).toBe(false);
      expect(items[2].nodeCount).toBe(0);
    });

    it('computes detailed revision changes (additions, modifications, removals)', () => {
      const prevGraph = createMockGraph();
      const nextGraph: Graph = {
        ...prevGraph,
        nodes: [
          prevGraph.nodes[0], // sys-core unmodified
          { ...prevGraph.nodes[1], description: 'Updated auth description' }, // mod-auth modified
          {
            id: 'entity-token',
            kind: 'entity',
            name: 'AuthToken',
            description: 'Authentication token entity',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          }, // entity-token added
        ],
      };

      const changes = computeRevisionChanges(prevGraph, nextGraph);
      expect(changes.addedNodes).toContain('AuthToken');
      expect(changes.modifiedNodes).toContain('AuthModule');
      expect(changes.removedNodes).toHaveLength(0);
      expect(changes.summaryText.some(t => t.includes('AuthToken'))).toBe(true);
      expect(changes.summaryText.some(t => t.includes('AuthModule'))).toBe(true);
    });

    it('verifies that diagram repositioning / layout move is NOT treated as a specification revision', () => {
      const projectBefore = createMockProject(1);
      const projectAfterLayoutMove: Project = {
        ...projectBefore,
        layout: {
          ...projectBefore.layout,
          'sys-core': { x: 500, y: 600 }, // Repositioned node
        },
        layoutRevision: projectBefore.layoutRevision! + 1,
        // specRevision remains strictly identical!
        specRevision: projectBefore.specRevision,
      };

      const isLayoutMove = isLayoutOnlyMutation(projectBefore, projectAfterLayoutMove);
      expect(isLayoutMove).toBe(true);

      // Verify specification revision did NOT increment
      expect(projectAfterLayoutMove.specRevision).toBe(projectBefore.specRevision);
      expect(projectAfterLayoutMove.specification).toEqual(projectBefore.specification);
    });
  });

  describe('Work Checklist Item 2 & Acceptance Criterion 2: Handle conflict responses by preserving draft and offering reload/review', () => {
    it('conflicts never silently discard a human draft', () => {
      const baseGraph = createMockGraph();
      // Server moved ahead to Rev 2 with a new node
      const currentServerGraph: Graph = {
        ...baseGraph,
        nodes: [
          ...baseGraph.nodes,
          {
            id: 'mod-payment',
            kind: 'module',
            name: 'PaymentModule',
            description: 'Payment processing module',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
        ],
      };

      // Human in View B concurrently edited 'AuthModule' description and added 'UserRole' entity
      const humanDraftGraph: Graph = {
        ...baseGraph,
        nodes: [
          baseGraph.nodes[0],
          { ...baseGraph.nodes[1], description: 'Human unsaved draft description' },
          {
            id: 'entity-user-role',
            kind: 'entity',
            name: 'UserRole',
            description: 'User role entity',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
        ],
      };

      const conflictState: SpecificationConflictState = {
        projectId: 'proj-t028',
        expectedRevision: 1,
        currentRevision: 2,
        draftGraph: humanDraftGraph,
        errorMessage: 'Specification changed (expected 1, current 2). Reload project and review your edit.',
        timestamp: Date.now(),
      };

      // Ensure the human draft is fully preserved in conflict state
      expect(conflictState.draftGraph).toBe(humanDraftGraph);
      expect(conflictState.draftGraph.nodes.some(n => n.name === 'UserRole')).toBe(true);
      expect(
        conflictState.draftGraph.nodes.find(n => n.id === 'mod-auth')?.description
      ).toBe('Human unsaved draft description');

      // Compute conflict diff between preserved draft and server graph
      const diff = computeConflictDiff(humanDraftGraph, currentServerGraph, baseGraph);
      expect(diff.draftAddedNodes.some(n => n.name === 'UserRole')).toBe(true);
      expect(diff.serverAddedNodes.some(n => n.name === 'PaymentModule')).toBe(true);
      expect(diff.draftModifiedNodes.some(m => m.after.name === 'AuthModule')).toBe(true);
    });

    it('renders conflict resolution UI offering reload, review, and apply actions', () => {
      const project = createMockProject(2);
      const conflict: SpecificationConflictState = {
        projectId: project.id,
        expectedRevision: 1,
        currentRevision: 2,
        draftGraph: createMockGraph(),
        errorMessage: 'Specification changed (expected 1, current 2).',
      };

      const onReload = vi.fn();
      const onReview = vi.fn();
      const onApply = vi.fn();
      const onDiscard = vi.fn();

      const html = renderToString(
        <RevisionHistory
          project={project}
          currentRevision={2}
          currentGraph={project.specification}
          revisions={createMockRevisionRecords()}
          isOpen={true}
          conflict={conflict}
          onResolveConflictReload={onReload}
          onResolveConflictReview={onReview}
          onResolveConflictApply={onApply}
          onResolveConflictDiscard={onDiscard}
          mode="modal"
        />
      );

      // Verify conflict banner and resolution actions are rendered
      expect(html).toContain('data-testid="conflict-resolution-section"');
      expect(html).toContain('data-testid="conflict-alert"');
      expect(html).toContain('data-testid="conflict-info"');
      expect(html).toContain('data-testid="draft-preserved-notice"');
      expect(html).toContain('Your draft has been preserved and is safe');
      expect(html).toContain('data-testid="conflict-reload-btn"');
      expect(html).toContain('data-testid="conflict-review-btn"');
      expect(html).toContain('data-testid="conflict-apply-btn"');
      expect(html).toContain('data-testid="conflict-discard-btn"');
      expect(html).toContain('data-testid="layout-separation-notice"');
    });
  });

  describe('Work Checklist Item 3 & Acceptance Criterion 3: Keep historical views read-only until an explicit new edit is made', () => {
    it('historical views cannot overwrite newer data implicitly', () => {
      // Rule verification: canHistoricalViewOverwrite returns false for historical views
      expect(canHistoricalViewOverwrite(true)).toBe(false);
      expect(canHistoricalViewOverwrite(false)).toBe(true);
    });

    it('prepares an explicit forward restoration edit based on the latest project revision', () => {
      const currentProject = createMockProject(3); // current is Rev 3
      const historicalRecord: RevisionRecord = {
        schemaVersion: 1,
        revision: 1, // historical Rev 1
        createdAt: '2026-10-08T10:05:00.000Z',
        graph: createMockGraph(),
      };

      const restoreEdit = prepareRestoreEdit(historicalRecord, currentProject);
      // Crucial: expectedRevision MUST be current revision (3), not historical revision (1)
      expect(restoreEdit.expectedRevision).toBe(3);
      expect(restoreEdit.graph).toBe(historicalRecord.graph);
    });

    it('renders historical view warning banner and read-only notice when viewing past revision', () => {
      const project = createMockProject(3);
      const records = createMockRevisionRecords();

      const html = renderToString(
        <RevisionHistory
          project={project}
          currentRevision={3}
          currentGraph={project.specification}
          revisions={records}
          isOpen={true}
          activeHistoricalRevision={1} // Viewing Rev 1 while current is Rev 3
          mode="modal"
        />
      );

      expect(html).toContain('data-testid="historical-view-notice"');
      expect(html).toContain('data-testid="historical-read-only-msg"');
      expect(html).toContain('Historical views are read-only and cannot overwrite newer revisions implicitly');
      expect(html).toContain('data-testid="exit-historical-btn"');
      expect(html).toContain('data-testid="restore-historical-btn"');
    });

    it('PropertyInspector respects isReadOnly prop and displays read-only banner', () => {
      const project = createMockProject(3);
      const graph = createMockGraph();

      const html = renderToString(
        <PropertyInspector
          project={project}
          graph={graph}
          viewState={{
            selectedId: 'sys-core',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={vi.fn()}
          isReadOnly={true} // Historical read-only mode
        />
      );

      expect(html).toContain('data-testid="inspector-historical-readonly-alert"');
      expect(html).toContain('Historical snapshot is read-only. Edits cannot overwrite newer data implicitly');
    });
  });

  describe('UI Integration in App and Header', () => {
    it('Header renders History button and clickable revision badge', () => {
      const project = createMockProject(2);
      const onOpenHistory = vi.fn();

      const html = renderToString(
        <Header
          project={project}
          syncStatus="current"
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onTogglePanel={vi.fn()}
          onOpenNewProject={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onOpenRevisionHistory={onOpenHistory}
        />
      );

      expect(html).toContain('data-testid="header-open-history"');
      expect(html).toContain('data-testid="header-revision-badge"');
      expect(html).toContain('Rev 2');
    });

    it('App renders Header with History integration and RevisionHistory container', () => {
      const project = createMockProject(1);

      const html = renderToString(
        <App
          initialProject={project}
          autoLoad={false}
        />
      );

      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="header-open-history"');
      expect(html).toContain('data-testid="header-revision-badge"');
    });
  });

  describe('Concrete Scenario 1: Open two views and edit the same specification', () => {
    it('simulates concurrent edit race: View A advances revision; View B is rejected, preserves draft, and resolves conflict', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'architect-scenario1-'));
      try {
        const store = new ProjectStore(tmpDir);
        const app = await createServer({ store, host: '127.0.0.1' });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const baseUrl = `http://127.0.0.1:${port}/api`;

        // 1. Initial State: Project created at revision 0
        const initialProject = await api.createBlankProject(
          { name: 'Concurrent Edit Project' },
          baseUrl
        );
        expect(initialProject.specRevision).toBe(0);

        // View A and View B both open the project at Revision 0
        const viewABaseRev = initialProject.specRevision; // 0
        const viewBBaseRev = initialProject.specRevision; // 0

        // 2. View A prepares an edit adding 'ServiceA' and commits
        const viewAGraph: Graph = {
          ...initialProject.specification,
          nodes: [
            {
              id: 'svc-a',
              kind: 'system',
              name: 'ServiceA',
              description: 'Service A system',
              provenance: 'human',
              policy: 'editable',
              contract: '',
              requiredChecks: [],
              instructions: '',
              outputPath: '',
              fields: [],
            },
          ],
        };

        const viewASaved = await api.updateSpecification(
          initialProject.id,
          viewABaseRev,
          viewAGraph,
          baseUrl
        );
        expect(viewASaved.specRevision).toBe(1);

        // 3. View B had prepared an edit adding 'ServiceB' based on Revision 0
        const viewBDraftGraph: Graph = {
          ...initialProject.specification,
          nodes: [
            {
              id: 'svc-b',
              kind: 'system',
              name: 'ServiceB',
              description: 'Service B system',
              provenance: 'human',
              policy: 'editable',
              contract: '',
              requiredChecks: [],
              instructions: '',
              outputPath: '',
              fields: [],
            },
          ],
        };

        // View B attempts to save using its base revision 0
        let conflictError: any = null;
        try {
          await api.updateSpecification(
            initialProject.id,
            viewBBaseRev, // Stale revision 0!
            viewBDraftGraph,
            baseUrl
          );
        } catch (err) {
          conflictError = err;
        }

        // Must fail with 409 Conflict
        expect(conflictError).toBeInstanceOf(api.ApiConnectionError);
        expect(conflictError?.statusCode).toBe(409);
        expect(conflictError?.expectedRevision).toBe(0);
        expect(conflictError?.currentRevision).toBe(1);

        // 4. View B's draft is STRICTLY PRESERVED
        expect(viewBDraftGraph.nodes[0].name).toBe('ServiceB');

        // View B constructs conflict recovery state
        const conflictState: SpecificationConflictState = {
          projectId: initialProject.id,
          expectedRevision: conflictError.expectedRevision,
          currentRevision: conflictError.currentRevision,
          draftGraph: viewBDraftGraph,
          errorMessage: conflictError.message,
        };
        expect(conflictState.draftGraph.nodes[0].name).toBe('ServiceB');

        // 5. View B reviews diff vs current server specification
        const freshProject = await api.getProject(initialProject.id, baseUrl);
        expect(freshProject.specRevision).toBe(1);
        const conflictDiff = computeConflictDiff(conflictState.draftGraph, freshProject.specification);
        expect(conflictDiff.draftAddedNodes.some(n => n.name === 'ServiceB')).toBe(true);
        expect(conflictDiff.serverAddedNodes.some(n => n.name === 'ServiceA')).toBe(true);

        // 6. View B merges or explicitly applies draft on top of latest server revision 1
        const mergedGraph: Graph = {
          ...freshProject.specification,
          nodes: [
            ...freshProject.specification.nodes, // keeps ServiceA
            ...conflictState.draftGraph.nodes,    // adds ServiceB
          ],
        };

        const viewBSaved = await api.updateSpecification(
          initialProject.id,
          freshProject.specRevision, // 1
          mergedGraph,
          baseUrl
        );
        expect(viewBSaved.specRevision).toBe(2);
        expect(viewBSaved.specification.nodes.some(n => n.name === 'ServiceA')).toBe(true);
        expect(viewBSaved.specification.nodes.some(n => n.name === 'ServiceB')).toBe(true);

        // 7. Verify history contains all revisions
        const history = await api.getSpecificationHistory(initialProject.id, baseUrl);
        expect(history).toHaveLength(3); // Rev 0, Rev 1, Rev 2
        expect(history[0].revision).toBe(0);
        expect(history[1].revision).toBe(1);
        expect(history[2].revision).toBe(2);

        await app.close();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario 2: Move a node and verify no new semantic revision appears', () => {
    it('moving a diagram node updates layoutRevision without creating a new specification revision', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'architect-scenario2-'));
      try {
        const store = new ProjectStore(tmpDir);
        const app = await createServer({ store, host: '127.0.0.1' });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const baseUrl = `http://127.0.0.1:${port}/api`;

        // 1. Create a project and commit initial specification (Rev 1)
        const project = await api.createBlankProject({ name: 'Layout Separation Project' }, baseUrl);
        const initialGraph = createMockGraph();
        const savedSpec = await api.updateSpecification(project.id, 0, initialGraph, baseUrl);
        expect(savedSpec.specRevision).toBe(1);

        // Check history right after spec commit: exactly 2 revisions (0 and 1)
        const historyBeforeLayout = await api.getSpecificationHistory(project.id, baseUrl);
        expect(historyBeforeLayout).toHaveLength(2);

        // 2. Move a node in the diagram (e.g. 'sys-core' to x: 300, y: 400)
        const updatedLayout = {
          'sys-core': { x: 300, y: 400 },
          'mod-auth': { x: 600, y: 700 },
        };
        const layoutRes = await api.updateLayout(project.id, updatedLayout, undefined, baseUrl);
        expect(layoutRes.layoutRevision).toBe(1);
        expect(layoutRes.layout['sys-core']).toEqual({ x: 300, y: 400 });

        // 3. Move another node (second move)
        const secondMove = {
          ...updatedLayout,
          'sys-core': { x: 350, y: 450 },
        };
        const secondLayoutRes = await api.updateLayout(project.id, secondMove, undefined, baseUrl);
        expect(secondLayoutRes.layoutRevision).toBe(2);
        expect(secondLayoutRes.layout['sys-core']).toEqual({ x: 350, y: 450 });

        // 4. Verify specification revision did NOT increment
        const freshProject = await api.getProject(project.id, baseUrl);
        expect(freshProject.specRevision).toBe(1); // STILL 1!
        expect(freshProject.layoutRevision).toBe(2);
        expect(freshProject.specification).toEqual(savedSpec.specification);

        // 5. Verify NO new specification revision was appended to history
        const historyAfterLayout = await api.getSpecificationHistory(project.id, baseUrl);
        expect(historyAfterLayout).toHaveLength(2); // Still exactly 2!
        expect(historyAfterLayout[0].revision).toBe(0);
        expect(historyAfterLayout[1].revision).toBe(1);

        await app.close();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
