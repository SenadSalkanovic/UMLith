import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { renderToString } from 'react-dom/server';
import {
  mergeLayoutAcrossUpdates,
  reconcileSelectionAndScope,
  reconcileWorkspaceState,
  isItemEditable,
  useWorkspaceSync,
  type WorkspaceState,
} from '../../src/workspace-state';
import { GraphCanvas, ArchitectureNode } from '../../src/components/GraphCanvas';
import { Canvas } from '../../src/components/Canvas';
import { App } from '../../src/App';
import { AnalysisClient } from '../../src/analysis-client';
import type {
  Graph,
  ProgramNode,
  ProgramEdge,
  Layout,
  Analysis,
  Project,
  BindingReviewRecord,
} from '../../shared/model';
import type { ViewState } from '../../src/types';

function createTestGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'sys-core',
      kind: 'system',
      name: 'CoreSystem',
      description: 'Root system',
      provenance: 'human',
      policy: 'editable',
      contract: 'export interface CoreSystem {}',
      requiredChecks: [],
      instructions: '',
      outputPath: '',
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
      requiredChecks: ['test'],
      instructions: 'Review auth modifications',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'cls-token',
      kind: 'class',
      name: 'TokenService',
      parentId: 'mod-auth',
      description: 'Token service class',
      provenance: 'human',
      policy: 'editable',
      contract: 'export class TokenService {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'iface-auth',
      kind: 'interface',
      name: 'Authenticator',
      parentId: 'mod-auth',
      description: 'Authenticator contract',
      provenance: 'human',
      policy: 'frozen-contract',
      contract: 'export interface Authenticator { verify(token: string): boolean; }',
      baseline: {
        contract: 'export interface Authenticator { verify(token: string): boolean; }',
      },
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'fn-verify',
      kind: 'function',
      name: 'verifySession',
      parentId: 'mod-auth',
      description: 'Verifies user session',
      provenance: 'extracted',
      policy: 'frozen-implementation',
      contract: '(token: string) => Promise<boolean>',
      requiredChecks: ['test'],
      instructions: 'Implementation is frozen; must match exact source',
      outputPath: 'src/auth.ts',
      source: {
        path: 'src/auth.ts',
        symbol: 'verifySession',
        line: 45,
        start: 1200,
        end: 1650,
        hash: 'sha256-verify-v1',
        revision: 'rev-001',
      },
      baseline: {
        text: 'export async function verifySession(token: string) { return isValid(token); }',
        source: {
          path: 'src/auth.ts',
          symbol: 'verifySession',
          line: 45,
          start: 1200,
          end: 1650,
          hash: 'sha256-verify-v1',
          revision: 'rev-001',
        },
      },
      fields: [],
    },
    {
      id: 'fn-generate',
      kind: 'function',
      name: 'generateToken',
      parentId: 'mod-auth',
      description: 'Generates user session token',
      provenance: 'human',
      policy: 'editable',
      contract: '(userId: string) => Promise<string>',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      fields: [],
    },
  ];

  const edges: ProgramEdge[] = [
    {
      id: 'edge-sys-mod',
      source: 'sys-core',
      target: 'mod-auth',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-mod-cls',
      source: 'mod-auth',
      target: 'cls-token',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-mod-iface',
      source: 'mod-auth',
      target: 'iface-auth',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-mod-fn',
      source: 'mod-auth',
      target: 'fn-verify',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-mod-gen',
      source: 'mod-auth',
      target: 'fn-generate',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-cls-calls-verify',
      source: 'cls-token',
      target: 'fn-verify',
      kind: 'calls',
      label: 'calls',
      provenance: 'human',
      uncertain: false,
    },
  ];

  return {
    schemaVersion: 1,
    nodes,
    edges,
    requirements: [],
  };
}

function createInitialLayout(): Layout {
  return {
    'sys-core': { x: 50, y: 50 },
    'mod-auth': { x: 280, y: 50 },
    'cls-token': { x: 180, y: 80 },
    'iface-auth': { x: 420, y: 80 },
    'fn-verify': { x: 180, y: 260 },
    'fn-generate': { x: 450, y: 260 },
  };
}

function createTestProject(): Project {
  const graph = createTestGraph();
  return {
    id: 'proj-sync-test',
    name: 'Sync State Test Project',
    description: 'Testing layout and selection preservation across live synchronization updates',
    target: 'TypeScript application',
    root: '/workspace/test-sync',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 1,
    specification: graph,
    layout: createInitialLayout(),
    layoutRevision: 1,
    scopedLayouts: {
      'mod-auth': {
        'cls-token': { x: 180, y: 80 },
        'iface-auth': { x: 420, y: 80 },
        'fn-verify': { x: 180, y: 260 },
        'fn-generate': { x: 450, y: 260 },
      },
    },
    checks: {
      test: { command: 'npm', args: ['test'] },
    },
  };
}

describe('T057: Preserve layout and selection across graph updates', () => {
  describe('Work Checklist: Merge graph updates without resetting independent positions', () => {
    it('preserves positions of surviving nodes without resetting to default layout or zeroes', () => {
      const initialLayout = createInitialLayout();
      const initialGraph = createTestGraph();

      // Updated graph: fn-verify has modified contract and line shift, fn-generate is unchanged, new node added
      const nextGraph: Graph = {
        ...initialGraph,
        nodes: initialGraph.nodes.map(n => {
          if (n.id === 'fn-verify') {
            return {
              ...n,
              contract: '(token: string, options?: VerifyOptions) => Promise<boolean>',
              source: n.source ? { ...n.source, line: 58, hash: 'sha256-verify-v2' } : undefined,
            };
          }
          return n;
        }).concat([
          {
            id: 'fn-refresh',
            kind: 'function',
            name: 'refreshToken',
            parentId: 'mod-auth',
            description: 'Refreshes existing token',
            provenance: 'human',
            policy: 'editable',
            contract: '(token: string) => Promise<string>',
            requiredChecks: [],
            instructions: '',
            outputPath: 'src/auth.ts',
            fields: [],
          },
        ]),
      };

      const result = mergeLayoutAcrossUpdates(initialLayout, nextGraph);

      // Surviving nodes strictly retain their original independent positions
      expect(result.layout['fn-verify']).toEqual({ x: 180, y: 260 });
      expect(result.layout['fn-generate']).toEqual({ x: 450, y: 260 });
      expect(result.layout['cls-token']).toEqual({ x: 180, y: 80 });
      expect(result.layout['iface-auth']).toEqual({ x: 420, y: 80 });
      expect(result.layout['mod-auth']).toEqual({ x: 280, y: 50 });
      expect(result.layout['sys-core']).toEqual({ x: 50, y: 50 });
      expect(result.retainedCount).toBe(6);
      expect(result.newNodesCount).toBe(1);
    });

    it('preserves scoped layouts for surviving nodes inside container scopes', () => {
      const initialLayout = createInitialLayout();
      const initialGraph = createTestGraph();
      const scopedLayouts: Record<string, Layout> = {
        'mod-auth': {
          'cls-token': { x: 100, y: 150 },
          'fn-verify': { x: 250, y: 350 },
        },
      };

      const nextGraph: Graph = {
        ...initialGraph,
        nodes: initialGraph.nodes.filter(n => n.id !== 'fn-generate'), // delete fn-generate
      };

      const result = mergeLayoutAcrossUpdates(initialLayout, nextGraph, scopedLayouts);

      // Scoped layout for surviving nodes in mod-auth is preserved
      expect(result.scopedLayouts['mod-auth']).toBeDefined();
      expect(result.scopedLayouts['mod-auth']['cls-token']).toEqual({ x: 100, y: 150 });
      expect(result.scopedLayouts['mod-auth']['fn-verify']).toEqual({ x: 250, y: 350 });
    });

    it('cleans up deleted node layout without discarding or shifting surviving neighboring positions', () => {
      const initialLayout = createInitialLayout();
      const initialGraph = createTestGraph();

      // Delete cls-token from graph
      const nextGraph: Graph = {
        ...initialGraph,
        nodes: initialGraph.nodes.filter(n => n.id !== 'cls-token'),
      };

      const resultPruned = mergeLayoutAcrossUpdates(
        initialLayout,
        nextGraph,
        undefined,
        undefined,
        undefined,
        { pruneStale: true }
      );

      // Surviving positions remain intact
      expect(resultPruned.layout['fn-verify']).toEqual({ x: 180, y: 260 });
      expect(resultPruned.layout['iface-auth']).toEqual({ x: 420, y: 80 });
      expect(resultPruned.layout['fn-generate']).toEqual({ x: 450, y: 260 });
      expect(resultPruned.layout['cls-token']).toBeUndefined();
      expect(resultPruned.prunedCount).toBe(1);
    });
  });

  describe('Work Checklist: Preserve selected node/edge and canvas scope when their identities survive', () => {
    it('preserves selected node and active canvas scope when the node and container survive', () => {
      const graph = createTestGraph();
      const viewState: ViewState = {
        selectedId: 'fn-verify',
        selectedType: 'node',
        activeScope: 'mod-auth',
        searchQuery: '',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      // Updated graph where fn-verify has been modified in place (identity preserved)
      const updatedGraph: Graph = {
        ...graph,
        nodes: graph.nodes.map(n => (n.id === 'fn-verify' ? { ...n, instructions: 'Updated notes' } : n)),
      };

      const resolution = reconcileSelectionAndScope(viewState, updatedGraph);

      expect(resolution.selectionSurvives).toBe(true);
      expect(resolution.selectedId).toBe('fn-verify');
      expect(resolution.selectedType).toBe('node');
      expect(resolution.scopeSurvives).toBe(true);
      expect(resolution.activeScope).toBe('mod-auth');
      expect(resolution.status).toBe('survived');
      expect(resolution.isEditable).toBe(true);
    });

    it('preserves selected edge when both endpoints and edge survive', () => {
      const graph = createTestGraph();
      const viewState: ViewState = {
        selectedId: 'edge-cls-calls-verify',
        selectedType: 'edge',
        activeScope: 'mod-auth',
        searchQuery: '',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      const updatedGraph: Graph = {
        ...graph,
        edges: graph.edges.map(e => (e.id === 'edge-cls-calls-verify' ? { ...e, label: 'calls (v2)' } : e)),
      };

      const resolution = reconcileSelectionAndScope(viewState, updatedGraph);

      expect(resolution.selectionSurvives).toBe(true);
      expect(resolution.selectedId).toBe('edge-cls-calls-verify');
      expect(resolution.selectedType).toBe('edge');
      expect(resolution.status).toBe('survived');
      expect(resolution.isEditable).toBe(true);
    });

    it('clears edge selection when one of its endpoints is deleted in update', () => {
      const graph = createTestGraph();
      const viewState: ViewState = {
        selectedId: 'edge-cls-calls-verify',
        selectedType: 'edge',
        activeScope: null,
        searchQuery: '',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      // cls-token deleted
      const updatedGraph: Graph = {
        ...graph,
        nodes: graph.nodes.filter(n => n.id !== 'cls-token'),
      };

      const resolution = reconcileSelectionAndScope(viewState, updatedGraph);

      expect(resolution.selectionSurvives).toBe(false);
      expect(resolution.selectedId).toBeNull();
      expect(resolution.selectedType).toBeNull();
      expect(resolution.status).toBe('deleted');
      expect(resolution.isEditable).toBe(false);
    });
  });

  describe('Concrete Scenario 1: Update a selected function and compare layout/selection', () => {
    it('preserves exact layout position and selection when a selected function is updated', () => {
      const project = createTestProject();
      const initialGraph = project.specification;
      const initialLayout = project.layout;

      const currentViewState: ViewState = {
        selectedId: 'fn-verify',
        selectedType: 'node',
        activeScope: 'mod-auth',
        searchQuery: '',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      const initialWorkspaceState: WorkspaceState = {
        graph: initialGraph,
        specification: initialGraph,
        layout: initialLayout,
        scopedLayouts: project.scopedLayouts || {},
        viewState: currentViewState,
        bindingReviews: [],
        syncStatus: 'current',
        protectionIssues: [],
      };

      // Update arrives: verifySession source line shifted from 45 to 80, body changed, hash changed
      const updatedFunctionNode: ProgramNode = {
        ...initialGraph.nodes.find(n => n.id === 'fn-verify')!,
        contract: '(token: string, secret?: string) => Promise<boolean>',
        source: {
          path: 'src/auth.ts',
          symbol: 'verifySession',
          line: 80,
          start: 2100,
          end: 2580,
          hash: 'sha256-verify-v2-shifted',
          revision: 'rev-002',
        },
      };

      const updatedGraph: Graph = {
        ...initialGraph,
        nodes: initialGraph.nodes.map(n => (n.id === 'fn-verify' ? updatedFunctionNode : n)),
      };

      const { nextState, resolution, specificationMutated, baselinesMutated } = reconcileWorkspaceState(
        initialWorkspaceState,
        {
          incomingGraph: updatedGraph,
          status: 'current',
        }
      );

      // 1. Surviving selection remains strictly unchanged
      expect(resolution.selectionSurvives).toBe(true);
      expect(resolution.selectedId).toBe('fn-verify');
      expect(resolution.selectedType).toBe('node');
      expect(nextState.viewState.selectedId).toBe('fn-verify');
      expect(nextState.viewState.selectedType).toBe('node');
      expect(nextState.viewState.activeScope).toBe('mod-auth');

      // 2. Surviving positions remain strictly unchanged
      expect(nextState.layout['fn-verify']).toEqual({ x: 180, y: 260 });
      expect(nextState.layout['fn-generate']).toEqual({ x: 450, y: 260 });
      expect(nextState.layout['cls-token']).toEqual({ x: 180, y: 80 });
      expect(nextState.layout['iface-auth']).toEqual({ x: 420, y: 80 });
      expect(nextState.scopedLayouts['mod-auth']['fn-verify']).toEqual({ x: 180, y: 260 });

      // 3. Intended specification and baselines remain strictly unchanged
      expect(specificationMutated).toBe(false);
      expect(baselinesMutated).toBe(false);
      expect(nextState.specification).toBe(initialWorkspaceState.specification);
      const specFn = nextState.specification?.nodes.find(n => n.id === 'fn-verify');
      expect(specFn?.baseline?.text).toBe(
        'export async function verifySession(token: string) { return isValid(token); }'
      );
    });

    it('renders the updated function in GraphCanvas with preserved layout and selected state', () => {
      const project = createTestProject();
      const updatedGraph = createTestGraph();
      // Update fn-verify in updatedGraph
      const target = updatedGraph.nodes.find(n => n.id === 'fn-verify')!;
      target.contract = '(token: string) => Promise<boolean>';

      const html = renderToString(
        <GraphCanvas
          graph={updatedGraph}
          layout={project.layout}
          scopedLayouts={project.scopedLayouts}
          viewState={{
            selectedId: 'fn-verify',
            selectedType: 'node',
            activeScope: 'mod-auth',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      // Verify panel and scope
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('AuthModule');

      // Verify node is rendered and selected
      expect(html).toContain('data-testid="canvas-node-fn-verify"');
      expect(html).toContain('verifySession');
      expect(html).toContain('selected');

      // Sibling nodes rendered in scope
      expect(html).toContain('data-testid="canvas-node-cls-token"');
      expect(html).toContain('data-testid="canvas-node-iface-auth"');
      expect(html).toContain('data-testid="canvas-node-fn-generate"');
    });
  });

  describe('Concrete Scenario 2: Delete or ambiguously rename the selected protected item', () => {
    describe('Part A: Delete the selected protected item', () => {
      it('resolves selection, blocks editing, and preserves intended specification and baselines when selected protected item is deleted', () => {
        const project = createTestProject();
        const initialGraph = project.specification;

        // Select protected function fn-verify (frozen-implementation with baseline)
        const currentViewState: ViewState = {
          selectedId: 'fn-verify',
          selectedType: 'node',
          activeScope: 'mod-auth',
          searchQuery: '',
          panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
        };

        const initialWorkspaceState: WorkspaceState = {
          graph: initialGraph,
          specification: initialGraph,
          layout: project.layout,
          scopedLayouts: project.scopedLayouts || {},
          viewState: currentViewState,
          bindingReviews: [],
          syncStatus: 'current',
          protectionIssues: [],
        };

        // Graph update arrives: fn-verify has been deleted in source code
        const updatedGraph: Graph = {
          ...initialGraph,
          nodes: initialGraph.nodes.filter(n => n.id !== 'fn-verify'),
          edges: initialGraph.edges.filter(e => e.source !== 'fn-verify' && e.target !== 'fn-verify'),
        };

        const { nextState, resolution, specificationMutated, baselinesMutated } = reconcileWorkspaceState(
          initialWorkspaceState,
          {
            incomingGraph: updatedGraph,
            status: 'current',
          }
        );

        // 1. Selection is explicitly resolved (not left pointing to deleted node)
        expect(resolution.selectionSurvives).toBe(false);
        expect(resolution.selectedId).toBeNull();
        expect(resolution.selectedType).toBeNull();
        expect(resolution.status).toBe('deleted');
        expect(nextState.viewState.selectedId).toBeNull();
        expect(nextState.viewState.selectedType).toBeNull();

        // 2. Acceptance criterion: Deleted items do not remain editable
        expect(resolution.isEditable).toBe(false);
        expect(isItemEditable('fn-verify', nextState.graph)).toBe(false);

        // 3. Acceptance criterion: Intended specification and baselines remain strictly unchanged
        expect(specificationMutated).toBe(false);
        expect(baselinesMutated).toBe(false);
        expect(nextState.specification).toBe(initialWorkspaceState.specification);
        const specProtectedNode = nextState.specification?.nodes.find(n => n.id === 'fn-verify');
        expect(specProtectedNode).toBeDefined();
        expect(specProtectedNode?.policy).toBe('frozen-implementation');
        expect(specProtectedNode?.baseline?.text).toBe(
          'export async function verifySession(token: string) { return isValid(token); }'
        );

        // 4. Protection issue is explicitly surfaced without silent rebinding
        expect(resolution.protectionIssue).toContain('Protected item "verifySession" cannot be resolved');
        expect(nextState.protectionIssues.length).toBeGreaterThan(0);
      });

      it('ensures Canvas empty state or surviving elements render without showing deleted item as selected', () => {
        const project = createTestProject();
        const updatedGraph: Graph = {
          ...project.specification,
          nodes: project.specification.nodes.filter(n => n.id !== 'fn-verify'),
        };

        const html = renderToString(
          <GraphCanvas
            graph={updatedGraph}
            layout={project.layout}
            viewState={{
              selectedId: null, // selection resolved
              selectedType: null,
              activeScope: 'mod-auth',
              searchQuery: '',
              panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
            }}
            onSelectNode={() => {}}
            onScopeChange={() => {}}
          />
        );

        // fn-verify is NOT rendered in scoped pills
        expect(html).not.toContain('data-testid="canvas-node-fn-verify"');
        expect(html).not.toContain('verifySession');

        // Surviving nodes remain visible
        expect(html).toContain('data-testid="canvas-node-cls-token"');
        expect(html).toContain('data-testid="canvas-node-iface-auth"');
        expect(html).toContain('data-testid="canvas-node-fn-generate"');
      });
    });

    describe('Part B: Ambiguously rename the selected protected item', () => {
      it('never silently rebinds an ambiguous protected item and marks it non-editable pending human review', () => {
        const project = createTestProject();
        const initialGraph = project.specification;

        // Select protected interface iface-auth (frozen-contract)
        const currentViewState: ViewState = {
          selectedId: 'iface-auth',
          selectedType: 'node',
          activeScope: 'mod-auth',
          searchQuery: '',
          panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
        };

        const initialWorkspaceState: WorkspaceState = {
          graph: initialGraph,
          specification: initialGraph,
          layout: project.layout,
          scopedLayouts: project.scopedLayouts || {},
          viewState: currentViewState,
          bindingReviews: [],
          syncStatus: 'current',
          protectionIssues: [],
        };

        // Source update creates ambiguous match: two competing candidate interfaces found in source
        const ambiguousBindingReview: BindingReviewRecord = {
          nodeId: 'iface-auth',
          nodeName: 'Authenticator',
          kind: 'interface',
          policy: 'frozen-contract',
          status: 'ambiguous',
          contract: 'export interface Authenticator { verify(token: string): boolean; }',
          baseline: {
            contract: 'export interface Authenticator { verify(token: string): boolean; }',
          },
          candidates: [
            {
              id: 'candidate-auth-core',
              name: 'Authenticator',
              kind: 'interface',
              source: {
                path: 'src/auth-core.ts',
                symbol: 'Authenticator',
                line: 10,
                start: 150,
                end: 320,
                hash: 'sha256-cand1',
                revision: 'rev-002',
              },
              contract: 'export interface Authenticator { verify(token: string): boolean; }',
              matchReason: 'Identical interface in candidate path src/auth-core.ts',
            },
            {
              id: 'candidate-auth-legacy',
              name: 'Authenticator',
              kind: 'interface',
              source: {
                path: 'src/auth-legacy.ts',
                symbol: 'Authenticator',
                line: 15,
                start: 200,
                end: 380,
                hash: 'sha256-cand2',
                revision: 'rev-002',
              },
              contract: 'export interface Authenticator { verify(token: string): boolean; }',
              matchReason: 'Identical interface in candidate path src/auth-legacy.ts',
            },
          ],
          selectedCandidate: undefined, // Never arbitrarily selected!
          reason: 'Multiple matching candidate declarations found across revisions',
        };

        const { nextState, resolution, specificationMutated, baselinesMutated } = reconcileWorkspaceState(
          initialWorkspaceState,
          {
            incomingGraph: initialGraph,
            bindingReviews: [ambiguousBindingReview],
            status: 'partial',
          }
        );

        // 1. Ambiguous selection is explicitly resolved and NOT arbitrarily rebound
        expect(resolution.status).toBe('ambiguous');
        expect(resolution.selectionSurvives).toBe(false);
        expect(resolution.selectedId).toBeNull(); // Cleared to prevent arbitrary direct edits!
        expect(resolution.selectedType).toBeNull();
        expect(resolution.bindingReview).toBeDefined();
        expect(resolution.bindingReview?.selectedCandidate).toBeUndefined(); // Arbitrary choice rejected!
        expect(resolution.bindingReview?.candidates).toHaveLength(2);

        // 2. Acceptance criterion: Ambiguous items do not remain editable without review
        expect(resolution.isEditable).toBe(false);
        expect(isItemEditable('iface-auth', nextState.graph, nextState.bindingReviews)).toBe(false);

        // 3. Acceptance criterion: Intended specification and baselines remain strictly unchanged
        expect(specificationMutated).toBe(false);
        expect(baselinesMutated).toBe(false);
        expect(nextState.specification).toBe(initialWorkspaceState.specification);
        const specIface = nextState.specification?.nodes.find(n => n.id === 'iface-auth');
        expect(specIface?.policy).toBe('frozen-contract');
        expect(specIface?.baseline?.contract).toBe(
          'export interface Authenticator { verify(token: string): boolean; }'
        );

        // 4. Protection issue flags ambiguity explicitly
        expect(resolution.protectionIssue).toContain('has ambiguous binding across 2 candidates');
      });

      it('renders visual Ambiguous badge in GraphCanvas when binding review is ambiguous', () => {
        const project = createTestProject();
        const graph = project.specification;

        const ambiguousReview: BindingReviewRecord = {
          nodeId: 'iface-auth',
          nodeName: 'Authenticator',
          kind: 'interface',
          policy: 'frozen-contract',
          status: 'ambiguous',
          contract: 'export interface Authenticator { verify(token: string): boolean; }',
          candidates: [],
          reason: 'Ambiguous rename',
        };

        // 1. Direct ArchitectureNode render displays ambiguous badge
        const ifaceNode = graph.nodes.find(n => n.id === 'iface-auth')!;
        const nodeHtml = renderToString(
          <ReactFlowProvider>
            <ArchitectureNode
              data={{
                node: ifaceNode,
                isSelected: false,
                isAmbiguous: true,
              }}
            />
          </ReactFlowProvider>
        );
        expect(nodeHtml).toContain('data-testid="binding-ambiguous-iface-auth"');
        expect(nodeHtml).toContain('badge-ambiguous');
        expect(nodeHtml).toContain('Ambiguous');
        expect(nodeHtml).toContain('binding-ambiguous');

        // 2. GraphCanvas scoped pills render ambiguous indicator
        const html = renderToString(
          <GraphCanvas
            graph={graph}
            layout={project.layout}
            bindingReviews={[ambiguousReview]}
            viewState={{
              selectedId: null,
              selectedType: null,
              activeScope: 'mod-auth',
              searchQuery: '',
              panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
            }}
            onSelectNode={() => {}}
            onScopeChange={() => {}}
          />
        );

        expect(html).toContain('pill-ambiguous');
        expect(html).toContain('data-testid="pill-ambiguous-iface-auth"');
      });
    });
  });

  describe('Integration: App Shell Reconciliation and AnalysisClient Live Synchronization', () => {
    it('integrates cleanly into App component preserving layout and selection across context switches', () => {
      const project = createTestProject();

      const html = renderToString(
        <App
          initialProject={project}
          autoLoad={false}
        />
      );

      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('data-testid="property-inspector-panel"');
    });

    it('reconciles live updates from AnalysisClient preserving surviving positions and selections', async () => {
      const project = createTestProject();
      const initialSnapshot: Analysis = {
        revision: 'rev-001',
        sequence: 1,
        analyzedAt: new Date().toISOString(),
        status: 'current',
        durationMs: 25,
        files: {},
        graph: project.specification,
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

      const client = new AnalysisClient({
        projectId: project.id,
        initialSnapshot,
        autoReconnect: false,
      });

      let currentWorkspace: WorkspaceState = {
        graph: project.specification,
        specification: project.specification,
        layout: project.layout,
        scopedLayouts: project.scopedLayouts || {},
        viewState: {
          selectedId: 'fn-verify',
          selectedType: 'node',
          activeScope: 'mod-auth',
          searchQuery: '',
          panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
        },
        bindingReviews: [],
        syncStatus: 'current',
        protectionIssues: [],
      };

      // Client receives new snapshot where verifySession shifted in line number but identity survived
      const shiftedFunction: ProgramNode = {
        ...project.specification.nodes.find(n => n.id === 'fn-verify')!,
        source: {
          path: 'src/auth.ts',
          symbol: 'verifySession',
          line: 72,
          start: 1900,
          end: 2350,
          hash: 'sha256-verify-v2',
          revision: 'rev-002',
        },
      };

      const updatedSnapshot: Analysis = {
        ...initialSnapshot,
        revision: 'rev-002',
        sequence: 2,
        graph: {
          ...project.specification,
          nodes: project.specification.nodes.map(n => (n.id === 'fn-verify' ? shiftedFunction : n)),
        },
      };

      // Reconcile update
      const { nextState, resolution } = reconcileWorkspaceState(currentWorkspace, {
        incomingAnalysis: updatedSnapshot,
        status: 'current',
      });

      expect(resolution.selectionSurvives).toBe(true);
      expect(resolution.selectedId).toBe('fn-verify');
      expect(nextState.layout['fn-verify']).toEqual({ x: 180, y: 260 });
      expect(nextState.scopedLayouts['mod-auth']['fn-verify']).toEqual({ x: 180, y: 260 });
      expect(nextState.viewState.activeScope).toBe('mod-auth');
    });
  });
});
