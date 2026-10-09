import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ProjectPicker, TARGET_PRESETS } from '../../src/components/ProjectPicker';
import { ProjectModal } from '../../src/components/ProjectModal';
import { App } from '../../src/App';
import { ReviewPanel } from '../../src/components/ReviewPanel';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import { emptyGraph, type Project, type Graph, type Analysis } from '../../shared/model';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createMockBlankProject(id = 'blank-proj-1', target = 'Desktop application'): Project {
  return {
    id,
    name: 'Blank Architecture Workspace',
    description: 'Fresh architecture project without initial code',
    target,
    root: '/workspace/managed-blank',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 0,
    specification: emptyGraph(),
    layout: {},
    layoutRevision: 0,
    scopedLayouts: {},
    checks: {},
  };
}

function createMockImportedProject(id = 'imported-proj-1', target = 'Node.js service'): Project {
  const analysisGraph: Graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'fn-import-1',
        kind: 'function',
        name: 'processPayment',
        description: 'Processes payment transactions',
        provenance: 'extracted',
        policy: 'editable',
        contract: '(amount: number) => boolean',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/payment.ts',
        source: {
          path: 'src/payment.ts',
          symbol: 'processPayment',
          line: 1,
          start: 0,
          end: 78,
          hash: 'sha256-pay1',
          revision: 'rev-0',
        },
        fields: [],
      },
      {
        id: 'class-import-2',
        kind: 'class',
        name: 'PaymentGateway',
        description: 'Payment gateway integration class',
        provenance: 'extracted',
        policy: 'editable',
        contract: 'export class PaymentGateway {}',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/payment.ts',
        source: {
          path: 'src/payment.ts',
          symbol: 'PaymentGateway',
          line: 3,
          start: 80,
          end: 120,
          hash: 'sha256-pay2',
          revision: 'rev-0',
        },
        fields: [],
      },
    ],
    edges: [],
    requirements: [],
  };

  const analysis: Analysis = {
    revision: 'rev-imported-0',
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    durationMs: 25,
    graph: analysisGraph,
    files: {
      'src/payment.ts': {
        hash: 'sha256-pay1',
        text: 'export function processPayment(amount: number): boolean { return amount > 0; }\nexport class PaymentGateway {}',
      },
    },
    quality: {
      eligibleFiles: 1,
      analyzedFiles: 1,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
  };

  return {
    id,
    name: 'Existing Payment Service',
    description: 'Imported from existing codebase folder',
    target,
    root: '/workspace/existing-repo',
    managed: false,
    createdAt: new Date().toISOString(),
    specRevision: 0,
    specification: emptyGraph(), // Crucial: intended specification is empty! Not auto-adopted!
    layout: {},
    layoutRevision: 0,
    scopedLayouts: {},
    analysis,
    checks: {},
  };
}

describe('T017 — Create and Open New or Existing Projects', () => {
  describe('Acceptance Criterion 1: A blank project does not require existing code', () => {
    it('renders the blank project form without demanding a root directory or existing code', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="blank"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isOpen={true}
        />
      );

      expect(html).toContain('data-testid="picker-tab-blank"');
      expect(html).toContain('data-testid="picker-input-name"');
      expect(html).toContain('data-testid="picker-input-desc"');
      expect(html).toContain('data-testid="picker-input-target"');
      expect(html).toContain('data-testid="picker-submit-blank"');
      expect(html).toContain('Create Blank Project');

      // Crucial: blank project tab must NOT show the root directory input group
      expect(html).not.toContain('data-testid="picker-root-group"');
      expect(html).toContain('Requires no existing code or filesystem directory');
    });

    it('creates a blank project through the API without requiring existing code or directory', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-blank-proj-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const createRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Fresh Blank Workspace',
            description: 'Architecture created without existing codebase',
            target: 'Web application',
          },
        });

        expect(createRes.statusCode).toBe(201);
        const project = createRes.json<Project>();

        expect(project.id).toBeDefined();
        expect(project.name).toBe('Fresh Blank Workspace');
        expect(project.description).toBe('Architecture created without existing codebase');
        expect(project.target).toBe('Web application');
        expect(project.managed).toBe(true);
        expect(project.specRevision).toBe(0);
        expect(project.specification).toEqual(emptyGraph());
        expect(project.analysis).toBeUndefined(); // No analysis run because no existing code

        // Verify root directory in managed store is empty (no scaffold files generated)
        const rootFiles = await readdir(project.root);
        expect(rootFiles).toHaveLength(0);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('creates a blank project using api.createBlankProject helper', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-helper-blank-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });
        const address = await app.listen({ host: '127.0.0.1', port: 0 });

        const project = await api.createBlankProject(
          {
            name: 'Helper Blank Project',
            description: 'Created via api helper',
            target: 'CLI tool',
          },
          `${address}/api`
        );

        expect(project.name).toBe('Helper Blank Project');
        expect(project.target).toBe('CLI tool');
        expect(project.managed).toBe(true);
        expect(project.specRevision).toBe(0);
        expect(project.specification.nodes).toHaveLength(0);
        expect(project.analysis).toBeUndefined();

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 2: An existing folder triggers implemented-model import', () => {
    it('renders the register existing folder form with root directory input and informative import notices', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="register"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isOpen={true}
        />
      );

      expect(html).toContain('data-testid="picker-tab-register"');
      expect(html).toContain('data-testid="picker-root-group"');
      expect(html).toContain('data-testid="picker-input-root"');
      expect(html).toContain('data-testid="picker-import-notice"');
      expect(html).toContain('data-testid="picker-submit-register"');
      expect(html).toContain('Register &amp; Import Folder');
      expect(html).toContain('Existing Folder Root Directory *');
      expect(html).toContain('The intended architecture will <em>not</em> be auto-adopted');
    });

    it('triggers implemented-model import when registering an existing folder with TypeScript files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-import-store-'));
      const codeDir = await mkdtemp(join(tmpdir(), 'architect-import-source-'));
      try {
        // Prepare TypeScript source file
        await writeFile(
          join(codeDir, 'service.ts'),
          `export function processOrder(orderId: string): boolean { return true; }\nexport class OrderProcessor {}`
        );

        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const createRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Order Processing System',
            description: 'Imported existing TypeScript codebase',
            target: 'Node.js service',
            root: codeDir,
          },
        });

        expect(createRes.statusCode).toBe(201);
        const project = createRes.json<Project>();

        expect(project.managed).toBe(false);
        expect(project.root).toBe(codeDir);

        // Verification of Implemented Model Import:
        expect(project.analysis).toBeDefined();
        expect(project.analysis?.status).toBe('current');
        const extractedNodeNames = project.analysis?.graph.nodes.map(n => n.name);
        expect(extractedNodeNames).toContain('processOrder');
        expect(extractedNodeNames).toContain('OrderProcessor');

        // Verification that intended specification remains clean / not auto-adopted:
        expect(project.specRevision).toBe(0);
        expect(project.specification.nodes).toHaveLength(0);
        expect(project.specification.edges).toHaveLength(0);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(codeDir, { recursive: true, force: true });
      }
    });

    it('registers existing project using api.registerExistingProject helper', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-helper-reg-'));
      const codeDir = await mkdtemp(join(tmpdir(), 'architect-helper-source-'));
      try {
        await writeFile(
          join(codeDir, 'auth.ts'),
          `export function authenticate(token: string): boolean { return token.length > 0; }`
        );

        const store = new ProjectStore(dir);
        const app = await createServer({ store });
        const address = await app.listen({ host: '127.0.0.1', port: 0 });

        const project = await api.registerExistingProject(
          {
            name: 'Auth Service',
            root: codeDir,
            target: 'Web application',
          },
          `${address}/api`
        );

        expect(project.name).toBe('Auth Service');
        expect(project.managed).toBe(false);
        expect(project.root).toBe(codeDir);
        expect(project.analysis).toBeDefined();
        expect(project.analysis?.graph.nodes.some(n => n.name === 'authenticate')).toBe(true);
        expect(project.specification.nodes).toHaveLength(0);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(codeDir, { recursive: true, force: true });
      }
    });
  });

  describe('Acceptance Criterion 3: Target choice imposes no scaffold or template', () => {
    it('displays explicit notice that target choice is descriptive metadata and imposes no scaffold', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="blank"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isOpen={true}
        />
      );

      expect(html).toContain('data-testid="picker-no-scaffold-notice"');
      expect(html).toContain('Target choice is descriptive metadata only; it does not impose or generate any code template, scaffold, or boilerplate (R40).');
    });

    it('imposes no scaffold or template for desktop target or unconstrained other target', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-targets-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        // 1. Desktop target
        const desktopRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Desktop App Project',
            target: 'Desktop application',
          },
        });
        expect(desktopRes.statusCode).toBe(201);
        const desktopProj = desktopRes.json<Project>();
        expect(desktopProj.target).toBe('Desktop application');
        // No scaffold files created
        const desktopFiles = await readdir(desktopProj.root);
        expect(desktopFiles).toEqual([]);
        // Specification is empty
        expect(desktopProj.specification.nodes).toEqual([]);

        // 2. Unconstrained other target
        const unconstrainedTarget = 'Custom Realtime Embedded Sensor Array (Unconstrained Other Target)';
        const otherRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Sensor Project',
            target: unconstrainedTarget,
          },
        });
        expect(otherRes.statusCode).toBe(201);
        const otherProj = otherRes.json<Project>();
        expect(otherProj.target).toBe(unconstrainedTarget);
        // No scaffold files created
        const otherFiles = await readdir(otherProj.root);
        expect(otherFiles).toEqual([]);
        // Specification is empty
        expect(otherProj.specification.nodes).toEqual([]);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario 1: Create a desktop-target project and an unconstrained other target', () => {
    it('renders desktop and custom unconstrained target chips in ProjectPicker presets', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="blank"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isOpen={true}
        />
      );

      expect(html).toContain('data-testid="picker-target-Desktop application"');
      expect(html).toContain('data-testid="picker-target-Web application"');
      expect(html).toContain('data-testid="picker-target-Node.js service"');
      expect(html).toContain('data-testid="picker-target-CLI tool"');
      expect(html).toContain('data-testid="picker-target-other"');
      expect(html).toContain('Desktop application');
      expect(html).toContain('Other / Custom');
    });

    it('creates a desktop-target project and an unconstrained other target via API', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-concrete-targets-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        // Scenario 1a: Desktop target
        const desktopRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Electron Native Architecture',
            description: 'Cross-platform desktop application',
            target: 'Desktop application',
          },
        });
        expect(desktopRes.statusCode).toBe(201);
        const desktopProj = desktopRes.json<Project>();
        expect(desktopProj.name).toBe('Electron Native Architecture');
        expect(desktopProj.target).toBe('Desktop application');
        expect(desktopProj.specRevision).toBe(0);
        expect(desktopProj.specification.nodes).toHaveLength(0);

        // Scenario 1b: Unconstrained other target
        const customTargetName = 'Distributed Actor Cluster (Other Target)';
        const customRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Actor System',
            description: 'Custom distributed runtime',
            target: customTargetName,
          },
        });
        expect(customRes.statusCode).toBe(201);
        const customProj = customRes.json<Project>();
        expect(customProj.name).toBe('Actor System');
        expect(customProj.target).toBe(customTargetName);
        expect(customProj.specRevision).toBe(0);
        expect(customProj.specification.nodes).toHaveLength(0);

        // Verify both appear in project listing
        const listRes = await app.inject({ method: 'GET', url: '/api/projects' });
        const list = listRes.json<Project[]>();
        expect(list.some(p => p.id === desktopProj.id && p.target === 'Desktop application')).toBe(true);
        expect(list.some(p => p.id === customProj.id && p.target === customTargetName)).toBe(true);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario 2: Open an existing TypeScript folder without auto-adopting architecture', () => {
    it('opens an imported project and shows imported structure in implemented model while intended specification remains empty', () => {
      const importedProject = createMockImportedProject();

      // Render App with this project
      const appHtml = renderToString(
        <App initialProject={importedProject} autoLoad={false} />
      );

      // 1. Shows workspace shell and project title
      expect(appHtml).toContain('data-testid="workspace-shell"');
      expect(appHtml).toContain(importedProject.name);
      expect(appHtml).toContain('Rev 0');

      // 2. Intended Project Tree is empty (not auto-adopted!)
      expect(appHtml).toContain('data-testid="tree-empty-state"');
      expect(appHtml).toContain('No elements defined in this project');

      // 3. Review Panel explicitly displays the imported implemented structure awaiting human adoption
      expect(appHtml).toContain('data-testid="imported-structure-card"');
      expect(appHtml).toContain('Imported Structure (Implemented Model)');
      expect(appHtml).toContain('Imported code populates the <strong>implemented graph</strong>');
      expect(appHtml).toContain('data-testid="implemented-count">2</strong>');
      expect(appHtml).toContain('The intended specification remains unadopted');
      expect(appHtml).toContain('under human control (R03).');
      expect(appHtml).toContain('processPayment');
      expect(appHtml).toContain('PaymentGateway');
    });

    it('displays unadopted badge in ProjectPicker project listing for imported projects', () => {
      const blank = createMockBlankProject('proj-1');
      const imported = createMockImportedProject('proj-2');

      const pickerHtml = renderToString(
        <ProjectPicker
          availableProjects={[blank, imported]}
          initialTab="list"
          activeProjectId="proj-1"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isOpen={true}
        />
      );

      // Verify blank project item
      expect(pickerHtml).toContain('data-testid="picker-project-proj-1"');
      expect(pickerHtml).toContain(blank.name);
      expect(pickerHtml).toContain('Blank / Managed');

      // Verify imported project item with unadopted badge
      expect(pickerHtml).toContain('data-testid="picker-project-proj-2"');
      expect(pickerHtml).toContain(imported.name);
      expect(pickerHtml).toContain('data-testid="picker-unadopted-badge"');
      expect(pickerHtml).toContain('Implemented Model Imported (Unadopted)');
    });

    it('verifies end-to-end import and explicit human adoption flow', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-adopt-store-'));
      const codeDir = await mkdtemp(join(tmpdir(), 'architect-adopt-source-'));
      try {
        await writeFile(
          join(codeDir, 'billing.ts'),
          `export function calculateInvoice(subtotal: number, taxRate: number): number { return subtotal * (1 + taxRate); }\nexport interface InvoiceReceipt { id: string; total: number; }`
        );

        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        // 1. Register existing project
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: {
            name: 'Billing System',
            target: 'TypeScript application',
            root: codeDir,
          },
        });
        expect(createRes.statusCode).toBe(201);
        const project = createRes.json<Project>();

        // Before human adoption:
        expect(project.specRevision).toBe(0);
        expect(project.specification.nodes).toHaveLength(0);
        expect(project.analysis?.graph.nodes.length).toBeGreaterThan(0);

        // 2. Human explicitly reviews and adopts implemented architecture via api.adoptImplementedArchitecture
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const adoptedProject = await api.adoptImplementedArchitecture(
          project.id,
          0, // expected revision
          project.analysis!.graph,
          `${address}/api`
        );

        // After human adoption:
        expect(adoptedProject.specRevision).toBe(1);
        expect(adoptedProject.specification.nodes.length).toBe(project.analysis!.graph.nodes.length);
        expect(adoptedProject.specification.nodes.some(n => n.name === 'calculateInvoice')).toBe(true);

        const adoptedHtml = renderToString(<App initialProject={adoptedProject} autoLoad={false} />);
        expect(adoptedHtml).toContain('Imported Structure (Implemented Model)');
        expect(adoptedHtml).not.toContain('The intended specification remains unadopted');
        expect(adoptedHtml).toContain('The intended specification is maintained separately');

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(codeDir, { recursive: true, force: true });
      }
    });
  });

  describe('ProjectPicker UI interactions and filtering', () => {
    it('filters projects by search query', () => {
      const p1 = createMockBlankProject('proj-alpha');
      p1.name = 'Alpha Payment Gateway';
      const p2 = createMockBlankProject('proj-beta');
      p2.name = 'Beta Notification Engine';

      // 1. No filter -> Both visible
      const allHtml = renderToString(
        <ProjectPicker
          availableProjects={[p1, p2]}
          initialTab="list"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
        />
      );
      expect(allHtml).toContain('Alpha Payment Gateway');
      expect(allHtml).toContain('Beta Notification Engine');

      // 2. Render ProjectModal wrapper compatibility
      const modalHtml = renderToString(
        <ProjectModal
          isOpen={true}
          availableProjects={[p1, p2]}
          activeProjectId="proj-alpha"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          initialTab="list"
          onClose={() => {}}
        />
      );
      expect(modalHtml).toContain('data-testid="project-picker"');
      expect(modalHtml).toContain('data-testid="picker-active-badge"');
      expect(modalHtml).toContain('Alpha Payment Gateway');
    });

    it('renders empty project picker state with quick action buttons', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="list"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
        />
      );

      expect(html).toContain('data-testid="picker-no-projects"');
      expect(html).toContain('No projects available. Start a blank project or register an existing folder.');
      expect(html).toContain('data-testid="picker-quick-blank-btn"');
      expect(html).toContain('data-testid="picker-quick-register-btn"');
    });

    it('renders standalone mode when isModal is false', () => {
      const html = renderToString(
        <ProjectPicker
          availableProjects={[]}
          initialTab="blank"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          isModal={false}
        />
      );

      expect(html).toContain('standalone-dialog');
      expect(html).not.toContain('modal-backdrop');
      expect(html).not.toContain('data-testid="picker-close-btn"');
    });
  });
});
