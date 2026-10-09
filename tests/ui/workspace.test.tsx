import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import { ErrorView } from '../../src/components/ErrorView';
import { EmptyWorkspace } from '../../src/components/EmptyWorkspace';
import { ProjectTree } from '../../src/components/ProjectTree';
import { Canvas } from '../../src/components/Canvas';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { SourceViewer } from '../../src/components/SourceViewer';
import { ReviewPanel } from '../../src/components/ReviewPanel';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import { emptyGraph, type Project, type Graph, type Analysis } from '../../shared/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createTestEmptyProject(id = 'empty-proj-1'): Project {
  return {
    id,
    name: 'Empty Architecture Workspace',
    description: 'A workspace project with no initial nodes or edges',
    target: 'TypeScript application',
    root: '/workspace/test-empty',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 0,
    specification: emptyGraph(),
    layout: {},
    layoutRevision: 0,
    scopedLayouts: {},
    checks: {
      test: { command: 'npm', args: ['test'] },
      typecheck: { command: 'npx', args: ['tsc', '--noEmit'] },
    },
  };
}

function createTestPopulatedProject(id = 'pop-proj-1'): Project {
  const graph: Graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'sys-1',
        kind: 'system',
        name: 'Core System',
        description: 'Top-level system boundary',
        provenance: 'human',
        policy: 'editable',
        contract: 'export interface CoreSystem {}',
        requiredChecks: ['test'],
        instructions: '',
        outputPath: '',
        fields: [],
      },
      {
        id: 'mod-1',
        kind: 'module',
        name: 'AuthModule',
        parentId: 'sys-1',
        description: 'Authentication and authorization module',
        provenance: 'human',
        policy: 'sensitive',
        contract: 'export interface AuthModule {}',
        requiredChecks: ['test', 'typecheck'],
        instructions: 'Do not modify token signing logic without security review',
        outputPath: 'src/auth.ts',
        source: {
          path: 'src/auth.ts',
          symbol: 'AuthModule',
          line: 12,
          start: 240,
          end: 680,
          hash: 'sha256-abc123auth',
          revision: 'rev-001',
        },
        fields: [],
      },
      {
        id: 'fn-1',
        kind: 'function',
        name: 'verifyToken',
        parentId: 'mod-1',
        description: 'Verifies bearer token authenticity',
        provenance: 'extracted',
        policy: 'frozen-implementation',
        contract: '(token: string) => Promise<UserSession>',
        inputs: 'token: string',
        outputs: 'Promise<UserSession>',
        rules: 'Reject expired or unsigned tokens',
        errors: 'UnauthorizedError',
        scenarios: ['valid token returns session', 'expired token throws 401'],
        requiredChecks: ['test'],
        instructions: 'Implementation is frozen; must match exact source',
        outputPath: 'src/auth.ts',
        source: {
          path: 'src/auth.ts',
          symbol: 'verifyToken',
          line: 45,
          start: 890,
          end: 1420,
          hash: 'sha256-fn123tok',
          revision: 'rev-001',
        },
        baseline: {
          text: 'export async function verifyToken(token: string) { return decode(token); }',
          source: {
            path: 'src/auth.ts',
            symbol: 'verifyToken',
            line: 45,
            start: 890,
            end: 1420,
            hash: 'sha256-fn123tok',
            revision: 'rev-001',
          },
        },
        fields: [],
      },
      {
        id: 'ent-1',
        kind: 'entity',
        name: 'UserAccount',
        description: 'User persistence model',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'prisma/schema.prisma',
        fields: [
          { name: 'id', type: 'String', key: 'primary', optional: false },
          { name: 'email', type: 'String', key: 'unique', optional: false },
          { name: 'displayName', type: 'String', key: '', optional: true },
        ],
      },
    ],
    edges: [
      {
        id: 'edge-sys-mod',
        source: 'sys-1',
        target: 'mod-1',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
      {
        id: 'edge-mod-fn',
        source: 'mod-1',
        target: 'fn-1',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
    ],
    requirements: [
      {
        id: 'req-auth',
        text: 'All API routes must require verified tokens',
        nodeIds: ['mod-1', 'fn-1'],
        edgeIds: [],
        constraints: ['Zero token leakage'],
        scenarios: ['Unauthorized requests are rejected with 401'],
      },
    ],
  };

  const analysis: Analysis = {
    revision: 'rev-001',
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    durationMs: 42,
    graph,
    files: {
      'src/auth.ts': {
        hash: 'sha256-abc123auth',
        text: 'export interface AuthModule {}\nexport async function verifyToken(token: string) { return decode(token); }',
      },
    },
    quality: {
      eligibleFiles: 4,
      analyzedFiles: 4,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
  };

  return {
    id,
    name: 'Identity and Access Platform',
    description: 'Enterprise IAM service architecture',
    target: 'TypeScript application',
    root: '/workspace/iam-service',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 3,
    specification: graph,
    layout: {
      'sys-1': { x: 50, y: 50 },
      'mod-1': { x: 280, y: 50 },
      'fn-1': { x: 520, y: 50 },
      'ent-1': { x: 50, y: 260 },
    },
    layoutRevision: 1,
    scopedLayouts: {},
    analysis,
    checks: {
      test: { command: 'npm', args: ['test'] },
      typecheck: { command: 'npx', args: ['tsc', '--noEmit'] },
    },
  };
}

describe('T016 — Local Browser Workspace Shell', () => {
  describe('Acceptance Criterion 1: The browser opens a local workspace & Criterion 2: Each required panel has a clear place', () => {
    it('mounts the workspace shell and establishes clear places for all 5 required panels in an empty project', () => {
      const emptyProject = createTestEmptyProject();
      const html = renderToString(<App initialProject={emptyProject} autoLoad={false} />);

      // Workspace shell container
      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="workspace-header"');
      expect(html).toContain('data-testid="workspace-main"');

      // 1. Project tree panel
      expect(html).toContain('data-testid="project-tree-panel"');
      expect(html).toContain('Project Tree');

      // 2. Scoped canvas panel
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('Scope:');

      // 3. Property inspector panel
      expect(html).toContain('data-testid="property-inspector-panel"');
      expect(html).toContain('Property Inspector');

      // 4. Source viewer panel
      expect(html).toContain('data-testid="source-viewer-panel"');
      expect(html).toContain('Source Viewer');

      // 5. Review area / panel
      expect(html).toContain('data-testid="review-panel"');
      expect(html).toContain('Review Area');

      // Verifies empty project details inside panels
      expect(html).toContain('data-testid="tree-empty-state"');
      expect(html).toContain('No elements defined in this project');
      expect(html).toContain('data-testid="canvas-empty-state"');
      expect(html).toContain('data-testid="project-inspector"');
      expect(html).toContain(emptyProject.name);
      expect(html).toContain('data-testid="source-overview"');
      expect(html).toContain(emptyProject.root);
    });

    it('mounts the workspace shell and renders populated nodes and inspection details in a populated project', () => {
      const populatedProject = createTestPopulatedProject();
      const html = renderToString(<App initialProject={populatedProject} autoLoad={false} />);

      // Verifies workspace shell
      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain(populatedProject.name);
      expect(html).toMatch(/Rev (<!-- -->)?3/);

      // Verifies all 5 panels are present
      expect(html).toContain('data-testid="project-tree-panel"');
      expect(html).toContain('data-testid="scoped-canvas-panel"');
      expect(html).toContain('data-testid="property-inspector-panel"');
      expect(html).toContain('data-testid="source-viewer-panel"');
      expect(html).toContain('data-testid="review-panel"');

      // Verifies populated elements in Project Tree
      expect(html).toContain('data-testid="tree-node-sys-1"');
      expect(html).toContain('Core System');
      expect(html).toContain('data-testid="tree-node-mod-1"');
      expect(html).toContain('AuthModule');
      expect(html).toContain('data-testid="tree-node-fn-1"');
      expect(html).toContain('verifyToken');
      expect(html).toContain('data-testid="tree-node-ent-1"');
      expect(html).toContain('UserAccount');

      // Verifies Review Panel policy counts and status
      expect(html).toContain('data-testid="review-panel"');
      expect(html).toContain('Editable');
      expect(html).toContain('Sensitive');
      expect(html).toContain('Frozen Impl');
      expect(html).toContain('data-testid="review-checks-list"');
      expect(html).toContain('npm test');
      expect(html).toContain('npx tsc --noEmit');
    });

    it('renders selected node properties and source bindings across inspector and source viewer', () => {
      const populatedProject = createTestPopulatedProject();
      const fnNode = populatedProject.specification.nodes.find(n => n.id === 'fn-1')!;

      // Render Property Inspector for fn-1 (frozen-implementation with baseline)
      const inspectorHtml = renderToString(
        <PropertyInspector
          project={populatedProject}
          graph={populatedProject.specification}
          viewState={{
            selectedId: 'fn-1',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
        />
      );

      expect(inspectorHtml).toContain('data-testid="node-inspector"');
      expect(inspectorHtml).toContain('verifyToken');
      expect(inspectorHtml).toContain('frozen-implementation');
      expect(inspectorHtml).toContain('extracted');
      expect(inspectorHtml).toContain('UnauthorizedError');
      expect(inspectorHtml).toContain('valid token returns session');

      // Render Source Viewer for fn-1
      const sourceViewerHtml = renderToString(
        <SourceViewer
          project={populatedProject}
          graph={populatedProject.specification}
          analysisState={{
            analysis: populatedProject.analysis!,
            status: 'current',
            lastChecked: Date.now(),
          }}
          viewState={{
            selectedId: 'fn-1',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      expect(sourceViewerHtml).toContain('data-testid="source-bound-view"');
      expect(sourceViewerHtml).toContain('src/auth.ts');
      expect(sourceViewerHtml).toMatch(/line (<!-- -->)?45/);
      expect(sourceViewerHtml).toContain('data-testid="source-code-block"');
      expect(sourceViewerHtml).toContain('export async function verifyToken(token: string)');
    });
  });

  describe('Acceptance Criterion 3: Connection and loading errors are actionable', () => {
    it('displays clear actionable error instructions and a retry button on connection error', () => {
      const errorHtml = renderToString(
        <ErrorView
          error={{
            title: 'Service Connection Error',
            message: 'Unable to reach local architecture service at http://127.0.0.1:4317/api/projects: Network request failed',
            actionableSteps: [
              'Verify that the local architecture workspace service is running (`npm start` or `npm run dev`).',
              'Check that the service is listening on loopback at http://127.0.0.1:4317.',
              'Ensure the host header and network permissions allow loopback connections.',
            ],
            isConnectionError: true,
          }}
          onRetry={() => {}}
        />
      );

      expect(errorHtml).toContain('data-testid="error-state"');
      expect(errorHtml).toContain('data-testid="error-title"');
      expect(errorHtml).toContain('Service Connection Error');
      expect(errorHtml).toContain('data-testid="error-message"');
      expect(errorHtml).toContain('Network request failed');

      // Actionable steps
      expect(errorHtml).toContain('data-testid="actionable-steps"');
      expect(errorHtml).toContain('npm start');
      expect(errorHtml).toContain('127.0.0.1:4317');
      expect(errorHtml).toContain('loopback connections');

      // Retry button
      expect(errorHtml).toContain('data-testid="retry-btn"');
      expect(errorHtml).toContain('Retry Connection');
    });

    it('ApiConnectionError constructs actionable guidance for troubleshooting loopback communication', () => {
      const err = new api.ApiConnectionError('Failed to fetch from 127.0.0.1:4317');
      expect(err.isConnectionError).toBe(true);
      expect(err.actionableSteps.length).toBeGreaterThanOrEqual(2);
      expect(err.actionableSteps[0]).toContain('npm start');
      expect(err.actionableSteps[1]).toContain('127.0.0.1:4317');
    });
  });

  describe('Concrete Scenario: Disconnect the local service during load', () => {
    it('fails with actionable connection error when the local service is disconnected or unavailable', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'architect-ui-disconnect-'));
      try {
        const store = new ProjectStore(tmpDir);
        const app = await createServer({ store, host: '127.0.0.1' });

        // Bind to dynamic loopback port
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const baseUrl = `http://127.0.0.1:${port}/api`;

        // 1. Healthy connection
        const health = await api.checkHealth(baseUrl);
        expect(health.status).toBe('ok');

        // 2. Disconnect / close the service
        await app.close();

        // 3. Attempting to fetch after disconnect throws ApiConnectionError with actionable steps
        let thrownError: api.ApiConnectionError | null = null;
        try {
          await api.getProjects(baseUrl);
        } catch (err: any) {
          thrownError = err;
        }

        expect(thrownError).toBeInstanceOf(api.ApiConnectionError);
        expect(thrownError?.isConnectionError).toBe(true);
        expect(thrownError?.actionableSteps.length).toBeGreaterThan(0);
        expect(thrownError?.actionableSteps.some(step => step.includes('npm start') || step.includes('127.0.0.1'))).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario: Open an empty project and a populated project', () => {
    it('opens empty workspace view when no projects exist in the store', () => {
      const emptyHtml = renderToString(
        <EmptyWorkspace
          availableProjects={[]}
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
        />
      );

      expect(emptyHtml).toContain('data-testid="empty-workspace"');
      expect(emptyHtml).toContain('Architecture Workspace');
      expect(emptyHtml).toContain('data-testid="create-project-form"');
      expect(emptyHtml).toContain('data-testid="input-project-name"');
      expect(emptyHtml).toContain('data-testid="input-project-target"');
      expect(emptyHtml).toContain('data-testid="submit-create-project-btn"');
    });

    it('renders project list in empty workspace when multiple projects are available', () => {
      const p1 = createTestEmptyProject('proj-a');
      const p2 = createTestPopulatedProject('proj-b');

      const html = renderToString(
        <EmptyWorkspace
          availableProjects={[p1, p2]}
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
        />
      );

      expect(html).toContain('data-testid="existing-projects-section"');
      expect(html).toContain('data-testid="project-card-proj-a"');
      expect(html).toContain(p1.name);
      expect(html).toContain('data-testid="project-card-proj-b"');
      expect(html).toContain(p2.name);
    });
  });

  describe('Decoupled View State vs Specification and Analysis State', () => {
    it('isolates tree filtering and scope navigation from graph data', () => {
      const project = createTestPopulatedProject();
      const initialNodesCount = project.specification.nodes.length;

      // Filter query for "Auth"
      const treeHtml = renderToString(
        <ProjectTree
          graph={project.specification}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: 'Auth',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
          onSearchChange={() => {}}
        />
      );

      // Matches AuthModule
      expect(treeHtml).toContain('AuthModule');
      // Does not alter graph length
      expect(project.specification.nodes.length).toBe(initialNodesCount);
    });

    it('renders scoped canvas isolating child nodes when activeScope is set', () => {
      const project = createTestPopulatedProject();

      // Scoped into mod-1 (AuthModule)
      const canvasHtml = renderToString(
        <Canvas
          graph={project.specification}
          layout={project.layout}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: 'mod-1',
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onSelectNode={() => {}}
          onScopeChange={() => {}}
        />
      );

      expect(canvasHtml).toContain('Scope:');
      expect(canvasHtml).toContain('AuthModule');
      expect(canvasHtml).toContain('data-testid="canvas-back-scope"');
      // Child node verifyToken is displayed
      expect(canvasHtml).toContain('verifyToken');
    });
  });
});
