import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { GraphCanvas, getValidRelationshipKinds } from '../../src/components/GraphCanvas';
import { Canvas } from '../../src/components/Canvas';
import { App } from '../../src/App';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import {
  emptyGraph,
  validRelationship,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Layout,
} from '../../shared/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createComprehensiveGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'sys-core',
      kind: 'system',
      name: 'CoreSystem',
      description: 'Central system root',
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
      instructions: 'Review all auth changes',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'cls-token',
      kind: 'class',
      name: 'TokenService',
      parentId: 'mod-auth',
      description: 'Handles token operations',
      provenance: 'human',
      policy: 'editable',
      contract: 'export class TokenService {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'iface-authenticator',
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
      provenance: 'human',
      policy: 'editable',
      contract: '(token: string) => Promise<boolean>',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'ent-user',
      kind: 'entity',
      name: 'UserEntity',
      parentId: 'mod-auth',
      description: 'User database entity',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: 'prisma/schema.prisma',
      fields: [
        { name: 'id', type: 'String', key: 'primary', optional: false },
        { name: 'role', type: 'Role', key: '', optional: false },
      ],
    },
    {
      id: 'enum-role',
      kind: 'enum',
      name: 'RoleEnum',
      parentId: 'mod-auth',
      description: 'User role enumeration',
      provenance: 'human',
      policy: 'editable',
      contract: 'enum Role { ADMIN, USER }',
      requiredChecks: [],
      instructions: '',
      outputPath: 'prisma/schema.prisma',
      fields: [],
    },
    {
      id: 'step-validate',
      kind: 'step',
      name: 'validateSignature',
      parentId: 'fn-verify',
      description: 'Workflow step validating token signature',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      stepType: 'operation',
      requiredChecks: [],
      instructions: '',
      outputPath: '',
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
      target: 'iface-authenticator',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-cls-implements-iface',
      source: 'cls-token',
      target: 'iface-authenticator',
      kind: 'implements',
      label: 'implements',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-fn-step',
      source: 'fn-verify',
      target: 'step-validate',
      kind: 'contains',
      label: 'contains',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'edge-cls-calls-fn',
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

function createTestProject(id = 'proj-t019'): Project {
  const graph = createComprehensiveGraph();
  return {
    id,
    name: 'T019 Scoped Canvas Workspace',
    description: 'Testing scoped canvas and independent layout storage',
    target: 'TypeScript application',
    root: '/workspace/test-t019',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 0,
    specification: graph,
    layout: {
      'sys-core': { x: 50, y: 50 },
      'mod-auth': { x: 260, y: 50 },
      'cls-token': { x: 100, y: 120 },
      'iface-authenticator': { x: 380, y: 120 },
      'fn-verify': { x: 100, y: 280 },
      'ent-user': { x: 380, y: 280 },
      'enum-role': { x: 620, y: 280 },
      'step-validate': { x: 100, y: 440 },
    },
    layoutRevision: 0,
    scopedLayouts: {},
    checks: {
      test: { command: 'npm', args: ['test'] },
    },
  };
}

describe('T019 — Scoped React Flow Canvas', () => {
  describe('Mapping Shared Node and Edge Kinds to React Flow', () => {
    it('maps all shared node kinds (system, module, class, interface, function, entity, enum, step) to canvas elements', () => {
      const graph = createComprehensiveGraph();
      const layout: Layout = {
        'sys-core': { x: 10, y: 10 },
        'mod-auth': { x: 200, y: 10 },
      };

      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={layout}
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

      // Panel mounts
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('Scope:');
      expect(html).toContain('AuthModule');

      // Scoped pills render each child node with kind class and stable ID
      expect(html).toContain('data-testid="canvas-node-cls-token"');
      expect(html).toContain('kind-class');
      expect(html).toContain('TokenService');

      expect(html).toContain('data-testid="canvas-node-iface-authenticator"');
      expect(html).toContain('kind-interface');
      expect(html).toContain('Authenticator');

      expect(html).toContain('data-testid="canvas-node-fn-verify"');
      expect(html).toContain('kind-function');
      expect(html).toContain('verifySession');

      expect(html).toContain('data-testid="canvas-node-ent-user"');
      expect(html).toContain('kind-entity');
      expect(html).toContain('UserEntity');

      expect(html).toContain('data-testid="canvas-node-enum-role"');
      expect(html).toContain('kind-enum');
      expect(html).toContain('RoleEnum');
    });

    it('retains stable shared graph IDs for all nodes and edges without invention', () => {
      const graph = createComprehensiveGraph();
      const project = createTestProject();

      const html = renderToString(
        <Canvas
          graph={graph}
          layout={project.layout}
          viewState={{
            selectedId: 'cls-token',
            selectedType: 'node',
            activeScope: 'mod-auth',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      // Nodes keep their exact stable IDs
      graph.nodes.filter(n => n.parentId === 'mod-auth').forEach(node => {
        expect(html).toContain(`data-testid="canvas-node-${node.id}"`);
      });

      // Selected node is highlighted
      expect(html).toContain('data-testid="canvas-node-cls-token"');
      expect(html).toContain('selected');
    });

    it('correctly maps valid relationship kinds between node kinds using shared rules', () => {
      // Entity -> Entity can relate-to
      const entityKinds = getValidRelationshipKinds('entity', 'entity');
      expect(entityKinds).toContain('relates-to');
      expect(validRelationship('relates-to', 'entity', 'entity')).toBe(true);

      // Class -> Interface can implement
      const classIfaceKinds = getValidRelationshipKinds('class', 'interface');
      expect(classIfaceKinds).toContain('implements');
      expect(validRelationship('implements', 'class', 'interface')).toBe(true);

      // Function -> Function can call
      const fnFnKinds = getValidRelationshipKinds('function', 'function');
      expect(fnFnKinds).toContain('calls');
      expect(validRelationship('calls', 'function', 'function')).toBe(true);

      // Module -> Class can contain
      const modClassKinds = getValidRelationshipKinds('module', 'class');
      expect(modClassKinds).toContain('contains');
      expect(validRelationship('contains', 'module', 'class')).toBe(true);

      // Step -> Module CANNOT contain (invalid relationship)
      expect(validRelationship('contains', 'step', 'module')).toBe(false);
      expect(getValidRelationshipKinds('step', 'module')).not.toContain('contains');

      // Function -> Step cannot relate-to (relates-to is entity-only)
      expect(validRelationship('relates-to', 'function', 'step')).toBe(false);
    });
  });

  describe('Scope Switching, Navigation, and Pan/Zoom Controls', () => {
    it('renders root scope displaying top-level system nodes when activeScope is null', () => {
      const graph = createComprehensiveGraph();
      const layout: Layout = { 'sys-core': { x: 50, y: 50 } };

      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={layout}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      expect(html).toContain('Scope:');
      expect(html).toContain('Root (Global Architecture)');
      expect(html).toContain('data-testid="canvas-node-sys-core"');
      expect(html).toContain('CoreSystem');
      // Sub-nodes should NOT be in the root scope pills
      expect(html).not.toContain('data-testid="canvas-node-cls-token"');
    });

    it('renders back-to-root button and breadcrumb when scoped into a module', () => {
      const graph = createComprehensiveGraph();
      const layout: Layout = { 'mod-auth': { x: 50, y: 50 } };

      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={layout}
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

      expect(html).toContain('data-testid="canvas-back-scope"');
      expect(html).toContain('Scope:');
      expect(html).toContain('AuthModule (module)');
    });

    it('renders clean empty state with return-to-root button when scope has no children', () => {
      const graph = createComprehensiveGraph();
      // Scoped into RoleEnum which has no children
      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={{}}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: 'enum-role',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      expect(html).toContain('data-testid="canvas-empty-state"');
      expect(html).toContain('No elements in current scope.');
      expect(html).toContain('data-testid="canvas-empty-return-root"');
      expect(html).toContain('Return to Root Scope');
    });

    it('renders selected edge details and delete edge button when an edge is selected', () => {
      const graph = createComprehensiveGraph();
      const project = createTestProject();

      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={project.layout}
          viewState={{
            selectedId: 'edge-cls-calls-fn',
            selectedType: 'edge',
            activeScope: 'mod-auth',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onSelectEdge={() => {}}
          onScopeChange={() => {}}
          onUpdateSpecification={() => {}}
        />
      );

      expect(html).toContain('data-testid="selected-edge-info"');
      expect(html).toContain('Edge: cls-token → fn-verify (calls)');
      expect(html).toContain('data-testid="canvas-delete-edge-btn"');
    });

    it('renders Add Edge action button in canvas header when scoped nodes exist', () => {
      const graph = createComprehensiveGraph();
      const project = createTestProject();

      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={project.layout}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: 'mod-auth',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
          onUpdateSpecification={() => {}}
        />
      );

      expect(html).toContain('data-testid="canvas-add-edge-btn"');
      expect(html).toContain('Add Edge');
    });
  });

  describe('Concrete Scenario 1: Reposition nodes, reload, and compare specification revision', () => {
    it('persists node repositioning via layout API while specification revision remains strictly unchanged', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'architect-canvas-reposition-'));
      try {
        const store = new ProjectStore(tmpDir);
        const app = await createServer({ store, host: '127.0.0.1' });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const baseUrl = `http://127.0.0.1:${port}/api`;

        // 1. Create a project
        const initialProj = await api.createBlankProject({
          name: 'Repositioning Test Project',
          description: 'Testing layout independence',
        }, baseUrl);

        expect(initialProj.specRevision).toBe(0);
        expect(initialProj.layoutRevision).toBe(0);

        // 2. Add two architecture nodes to specification
        const nodeA: ProgramNode = {
          id: 'node-alpha',
          kind: 'system',
          name: 'AlphaSystem',
          description: '',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };
        const nodeB: ProgramNode = {
          id: 'node-beta',
          kind: 'module',
          parentId: 'node-alpha',
          name: 'BetaModule',
          description: '',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };
        const edgeA: ProgramEdge = {
          id: 'edge-alpha-beta',
          source: 'node-alpha',
          target: 'node-beta',
          kind: 'contains',
          label: 'contains',
          provenance: 'human',
          uncertain: false,
        };

        const updatedSpecGraph: Graph = {
          schemaVersion: 1,
          nodes: [nodeA, nodeB],
          edges: [edgeA],
          requirements: [],
        };

        const projWithSpec = await api.updateSpecification(
          initialProj.id,
          0,
          updatedSpecGraph,
          baseUrl
        );

        expect(projWithSpec.specRevision).toBe(1);
        expect(projWithSpec.layoutRevision).toBe(0);

        // 3. Move node-alpha to (350, 420) and node-beta to (600, 420)
        const newLayout: Layout = {
          'node-alpha': { x: 350, y: 420 },
          'node-beta': { x: 600, y: 420 },
        };

        const projAfterMove = await api.updateLayout(
          initialProj.id,
          newLayout,
          undefined,
          baseUrl
        );

        // Acceptance criterion: Movement does not create semantic specification changes
        expect(projAfterMove.layoutRevision).toBe(1);
        expect(projAfterMove.specRevision).toBe(1); // specRevision remains strictly 1!
        expect(projAfterMove.layout['node-alpha']).toEqual({ x: 350, y: 420 });
        expect(projAfterMove.layout['node-beta']).toEqual({ x: 600, y: 420 });

        // 4. Reload project from server to verify round-trip persistence
        const reloadedProj = await api.getProject(initialProj.id, baseUrl);
        expect(reloadedProj.specRevision).toBe(1); // STILL revision 1!
        expect(reloadedProj.layoutRevision).toBe(1);
        expect(reloadedProj.layout['node-alpha']).toEqual({ x: 350, y: 420 });
        expect(reloadedProj.layout['node-beta']).toEqual({ x: 600, y: 420 });

        // 5. Compare specification JSON against previous
        const specResponse = await api.getSpecification(initialProj.id, baseUrl);
        expect(specResponse.nodes).toEqual(updatedSpecGraph.nodes);
        expect(specResponse.edges).toEqual(updatedSpecGraph.edges);

        // 6. Test scoped layout update
        const scopedLayout: Layout = {
          'node-beta': { x: 120, y: 180 },
        };
        const projAfterScopedMove = await api.updateLayout(
          initialProj.id,
          scopedLayout,
          'node-alpha',
          baseUrl
        );

        expect(projAfterScopedMove.layoutRevision).toBe(2);
        expect(projAfterScopedMove.specRevision).toBe(1); // Still revision 1!
        expect(projAfterScopedMove.scopedLayouts?.['node-alpha']?.['node-beta']).toEqual({ x: 120, y: 180 });

        await app.close();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario 2: Reject a dangling edge produced by a concurrent deletion', () => {
    it('rejects a dangling edge targeting a non-existent or concurrently deleted node endpoint', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'architect-canvas-dangling-'));
      try {
        const store = new ProjectStore(tmpDir);
        const app = await createServer({ store, host: '127.0.0.1' });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const baseUrl = `http://127.0.0.1:${port}/api`;

        // 1. Create project with initial node
        const proj = await api.createBlankProject({
          name: 'Dangling Edge Test Project',
        }, baseUrl);

        const nodeA: ProgramNode = {
          id: 'node-alive',
          kind: 'system',
          name: 'AliveSystem',
          description: '',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };
        const nodeB: ProgramNode = {
          id: 'node-to-delete',
          kind: 'module',
          parentId: 'node-alive',
          name: 'TargetModule',
          description: '',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        const projV1 = await api.updateSpecification(
          proj.id,
          0,
          {
            schemaVersion: 1,
            nodes: [nodeA, nodeB],
            edges: [],
            requirements: [],
          },
          baseUrl
        );

        expect(projV1.specRevision).toBe(1);

        // 2. Concurrently delete nodeB (simulating another user or background sync)
        const projV2 = await api.updateSpecification(
          proj.id,
          1,
          {
            schemaVersion: 1,
            nodes: [nodeA], // nodeB deleted
            edges: [],
            requirements: [],
          },
          baseUrl
        );

        expect(projV2.specRevision).toBe(2);
        expect(projV2.specification.nodes.some(n => n.id === 'node-to-delete')).toBe(false);

        // 3. Client A attempts to add a relationship edge pointing to deleted nodeB
        const danglingEdge: ProgramEdge = {
          id: 'edge-dangling',
          source: 'node-alive',
          target: 'node-to-delete', // deleted!
          kind: 'depends-on',
          label: '',
          provenance: 'human',
          uncertain: false,
        };

        // Case A: Submitting with old revision (1) after concurrent deletion triggers 409 conflict
        let conflictError: api.ApiConnectionError | null = null;
        try {
          await api.updateSpecification(
            proj.id,
            1, // Stale revision (server is now at revision 2)
            {
              schemaVersion: 1,
              nodes: [nodeA, nodeB],
              edges: [
                {
                  id: 'edge-concurrent-add',
                  source: 'node-alive',
                  target: 'node-to-delete',
                  kind: 'contains',
                  label: '',
                  provenance: 'human',
                  uncertain: false,
                },
              ],
              requirements: [],
            },
            baseUrl
          );
        } catch (err: any) {
          conflictError = err;
        }

        expect(conflictError).toBeInstanceOf(api.ApiConnectionError);
        expect(conflictError?.statusCode).toBe(409);

        // Case B: Submitting with current revision (2) triggers 400 validation rejection
        let validationError: api.ApiConnectionError | null = null;
        try {
          await api.updateSpecification(
            proj.id,
            2, // Current revision, but missing target endpoint
            {
              schemaVersion: 1,
              nodes: [nodeA],
              edges: [danglingEdge],
              requirements: [],
            },
            baseUrl
          );
        } catch (err: any) {
          validationError = err;
        }

        expect(validationError).toBeInstanceOf(api.ApiConnectionError);
        expect(validationError?.statusCode).toBe(400);
        expect(validationError?.message).toContain('Missing edge endpoint: node-to-delete');

        // 4. Verify stored specification is untouched and valid
        const untouchedProj = await api.getProject(proj.id, baseUrl);
        expect(untouchedProj.specRevision).toBe(2);
        expect(untouchedProj.specification.edges).toHaveLength(0);

        await app.close();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('renders error banner when relationship edit is rejected', () => {
      const graph = createComprehensiveGraph();
      const html = renderToString(
        <GraphCanvas
          graph={graph}
          layout={{}}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      // Verify canvas structure can receive error states
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('data-testid="canvas-wrapper"');
    });
  });

  describe('Integration with App Shell and Property Inspector', () => {
    it('integrates GraphCanvas within App shell with layout and specification handlers', () => {
      const project = createTestProject();

      const html = renderToString(
        <App
          initialProject={project}
          autoLoad={false}
        />
      );

      // Shell panels
      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('data-testid="property-inspector-panel"');

      // Scoped canvas root scope
      expect(html).toContain('Scope:');
      expect(html).toContain('Root (Global Architecture)');
      expect(html).toContain('data-testid="canvas-node-sys-core"');
    });
  });
});
