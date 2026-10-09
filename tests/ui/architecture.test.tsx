import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ArchitectureEditor,
  canNest,
  getCreatableKinds,
  validateRelationship,
  previewDestructiveEdit,
  createArchitectureNode,
  updateArchitectureNode,
  connectNodes,
  removeArchitectureNode,
} from '../../src/components/ArchitectureEditor';
import { App } from '../../src/App';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { Header } from '../../src/components/Header';
import { Canvas } from '../../src/components/Canvas';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import {
  emptyGraph,
  validRelationship,
  GraphSchema,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Requirement,
} from '../../shared/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createInitialTestGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'sys-core',
      kind: 'system',
      name: 'CoreSystem',
      description: 'System boundary',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: '',
      fields: [],
    },
    {
      id: 'mod-billing',
      kind: 'module',
      name: 'BillingModule',
      parentId: 'sys-core',
      description: 'Billing and invoicing services',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export interface BillingModule {}',
      requiredChecks: ['test'],
      instructions: 'Protect invoicing computations',
      outputPath: 'src/billing.ts',
      fields: [],
    },
  ];

  return {
    schemaVersion: 1,
    nodes,
    edges: [],
    requirements: [],
  };
}

describe('T020 — Edit systems, modules, classes, and interfaces', () => {
  // =========================================================================
  // Concrete Validation Scenario 1: Create a module with an interface and implementing class
  // =========================================================================
  describe('Concrete Scenario 1: Create a module with an interface and implementing class', () => {
    it('creates a module, an interface inside it, and an implementing class connected via implements', () => {
      let graph = emptyGraph();

      // Step 1: Create module
      const { graph: g1, node: modNode } = createArchitectureNode(graph, {
        name: 'OrderModule',
        kind: 'module',
        description: 'Handles order lifecycle, placement, and cancellation',
      });
      graph = g1;
      expect(modNode.id).toBeDefined();
      expect(modNode.name).toBe('OrderModule');
      expect(modNode.kind).toBe('module');
      expect(modNode.description).toBe('Handles order lifecycle, placement, and cancellation');
      expect(graph.nodes).toHaveLength(1);

      // Step 2: Create interface nested inside the module
      const { graph: g2, node: ifaceNode } = createArchitectureNode(graph, {
        name: 'IOrderService',
        kind: 'interface',
        parentId: modNode.id,
        description: 'Interface contract for order management operations',
        contract: 'export interface IOrderService { processOrder(orderId: string): Promise<boolean>; }',
      });
      graph = g2;
      expect(ifaceNode.id).toBeDefined();
      expect(ifaceNode.name).toBe('IOrderService');
      expect(ifaceNode.parentId).toBe(modNode.id);
      expect(ifaceNode.contract).toContain('processOrder(orderId: string): Promise<boolean>');
      expect(graph.nodes).toHaveLength(2);

      // Step 3: Create class nested inside the module
      const { graph: g3, node: clsNode } = createArchitectureNode(graph, {
        name: 'OrderService',
        kind: 'class',
        parentId: modNode.id,
        description: 'Concrete implementation of IOrderService',
      });
      graph = g3;
      expect(clsNode.id).toBeDefined();
      expect(clsNode.name).toBe('OrderService');
      expect(clsNode.parentId).toBe(modNode.id);
      expect(graph.nodes).toHaveLength(3);

      // Step 4: Connect class to interface with 'implements' relationship
      const { graph: g4, edge: implEdge } = connectNodes(graph, {
        sourceId: clsNode.id,
        targetId: ifaceNode.id,
        kind: 'implements',
        label: 'implements contract',
      });
      graph = g4;
      expect(implEdge.source).toBe(clsNode.id);
      expect(implEdge.target).toBe(ifaceNode.id);
      expect(implEdge.kind).toBe('implements');
      expect(implEdge.label).toBe('implements contract');
      expect(graph.edges).toHaveLength(1);

      // Validate entire graph schema
      const parseResult = GraphSchema.safeParse(graph);
      expect(parseResult.success).toBe(true);

      // Verify containment semantics
      expect(canNest('module', 'interface')).toBe(true);
      expect(canNest('module', 'class')).toBe(true);
      expect(validRelationship('implements', 'class', 'interface')).toBe(true);
    });

    it('persists module, interface, and implementing class through Fastify server and updates revision', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't020-scenario1-'));
      const store = new ProjectStore(dataDir);
      const app = await createServer({ store, host: '127.0.0.1' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        // Create blank project with "Desktop application" target (proving target doesn't restrict kinds)
        const proj = await api.createBlankProject(
          { name: 'Desktop Order App', target: 'Desktop application' },
          baseUrl
        );
        expect(proj.specRevision).toBe(0);

        // Build architecture: module + interface + class + implements edge
        let currentGraph = proj.specification;
        const { graph: g1, node: mod } = createArchitectureNode(currentGraph, {
          name: 'SalesModule',
          kind: 'module',
          description: 'Sales and dispatching operations',
        });
        const { graph: g2, node: iface } = createArchitectureNode(g1, {
          name: 'ISalesProcessor',
          kind: 'interface',
          parentId: mod.id,
          contract: 'export interface ISalesProcessor { process(): void; }',
        });
        const { graph: g3, node: cls } = createArchitectureNode(g2, {
          name: 'SalesProcessor',
          kind: 'class',
          parentId: mod.id,
        });
        const { graph: g4 } = connectNodes(g3, {
          sourceId: cls.id,
          targetId: iface.id,
          kind: 'implements',
        });

        // Persist to server
        const updated = await api.updateSpecification(proj.id, proj.specRevision, g4, baseUrl);
        expect(updated.specRevision).toBe(1);
        expect(updated.specification.nodes).toHaveLength(3);
        expect(updated.specification.edges).toHaveLength(1);

        // Fetch back and assert persistence
        const fetched = await api.getSpecification(proj.id, baseUrl);
        expect(fetched.nodes.map(n => n.name)).toContain('SalesModule');
        expect(fetched.nodes.map(n => n.name)).toContain('ISalesProcessor');
        expect(fetched.nodes.map(n => n.name)).toContain('SalesProcessor');
        expect(fetched.edges[0].kind).toBe('implements');
        expect(fetched.edges[0].source).toBe(cls.id);
        expect(fetched.edges[0].target).toBe(iface.id);
      } finally {
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Remove a referenced item and expose affected relationships
  // =========================================================================
  describe('Concrete Scenario 2: Remove a referenced item and expose affected relationships', () => {
    it('previews removal of a referenced interface, exposes affected edges, child elements, and preserved requirements', () => {
      // Setup graph with:
      // Mod -> Class and Mod -> Interface
      // Class -> Interface (implements)
      // Interface has child (e.g. inner function/method)
      // Requirement referencing the interface and edge
      const modNode: ProgramNode = {
        id: 'mod-orders',
        kind: 'module',
        name: 'Orders',
        description: 'Orders module',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };
      const ifaceNode: ProgramNode = {
        id: 'iface-orders',
        kind: 'interface',
        name: 'IOrderService',
        parentId: 'mod-orders',
        description: 'Order service interface',
        provenance: 'human',
        policy: 'frozen-contract',
        contract: 'export interface IOrderService {}',
        baseline: { contract: 'export interface IOrderService {}' },
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };
      const clsNode: ProgramNode = {
        id: 'cls-orders',
        kind: 'class',
        name: 'OrderService',
        parentId: 'mod-orders',
        description: 'Order service implementation',
        provenance: 'human',
        policy: 'editable',
        contract: 'export class OrderService {}',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };
      const childFunc: ProgramNode = {
        id: 'fn-helper',
        kind: 'function',
        name: 'validateOrderParams',
        parentId: 'iface-orders',
        description: 'Helper validation function',
        provenance: 'human',
        policy: 'editable',
        contract: '() => boolean',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };

      const implEdge: ProgramEdge = {
        id: 'edge-impl-1',
        source: 'cls-orders',
        target: 'iface-orders',
        kind: 'implements',
        label: 'implements IOrderService',
        provenance: 'human',
        uncertain: false,
      };

      const depEdge: ProgramEdge = {
        id: 'edge-dep-1',
        source: 'mod-orders',
        target: 'iface-orders',
        kind: 'depends-on',
        label: '',
        provenance: 'human',
        uncertain: false,
      };

      const req1: Requirement = {
        id: 'req-order-validation',
        text: 'All orders must validate parameters against interface specification',
        nodeIds: ['mod-orders', 'iface-orders', 'cls-orders'],
        edgeIds: ['edge-impl-1'],
        constraints: ['Strict schema enforcement'],
        scenarios: ['Given an order with missing amount, reject transaction'],
      };

      const graph: Graph = {
        schemaVersion: 1,
        nodes: [modNode, ifaceNode, clsNode, childFunc],
        edges: [implEdge, depEdge],
        requirements: [req1],
      };

      // 1. Preview destructive edit before removal
      const preview = previewDestructiveEdit(graph, 'iface-orders');
      expect(preview.affectedNode.id).toBe('iface-orders');
      expect(preview.affectedNode.name).toBe('IOrderService');

      // Exposed affected relationships: exactly 2 edges connected to iface-orders
      expect(preview.affectedEdges).toHaveLength(2);
      expect(preview.affectedEdges.map(e => e.id)).toEqual(
        expect.arrayContaining(['edge-impl-1', 'edge-dep-1'])
      );

      // Exposed nested children: childFunc is nested under iface-orders
      expect(preview.childNodes).toHaveLength(1);
      expect(preview.childNodes[0].id).toBe('fn-helper');

      // Exposed referenced requirements: req1 references iface-orders and edge-impl-1
      expect(preview.referencingRequirements).toHaveLength(1);
      expect(preview.referencingRequirements[0].id).toBe('req-order-validation');

      // 2. Perform removal and confirm affected relationships are deleted and requirements are preserved
      const {
        graph: updatedGraph,
        removedNode,
        removedEdges,
        reparentedChildren,
        preservedRequirements,
      } = removeArchitectureNode(graph, 'iface-orders');

      expect(removedNode.id).toBe('iface-orders');
      expect(removedEdges).toHaveLength(2);
      expect(updatedGraph.nodes.some(n => n.id === 'iface-orders')).toBe(false);
      expect(updatedGraph.edges).toHaveLength(0); // Both incident edges removed

      // Child func was re-parented to targetNode's parent ('mod-orders')
      expect(reparentedChildren).toHaveLength(1);
      const reparentedChild = updatedGraph.nodes.find(n => n.id === 'fn-helper');
      expect(reparentedChild?.parentId).toBe('mod-orders');

      // Requirements are PRESERVED with references updated
      expect(preservedRequirements).toHaveLength(1);
      expect(updatedGraph.requirements).toHaveLength(1);
      expect(updatedGraph.requirements[0].id).toBe('req-order-validation');
      expect(updatedGraph.requirements[0].text).toBe(
        'All orders must validate parameters against interface specification'
      );
      // 'iface-orders' was stripped from nodeIds, remaining nodes preserved
      expect(updatedGraph.requirements[0].nodeIds).toEqual(['mod-orders', 'cls-orders']);
      // Deleted edge was stripped from edgeIds
      expect(updatedGraph.requirements[0].edgeIds).toEqual([]);
      // Constraints and scenarios are intact
      expect(updatedGraph.requirements[0].constraints).toEqual(['Strict schema enforcement']);
      expect(updatedGraph.requirements[0].scenarios).toEqual([
        'Given an order with missing amount, reject transaction',
      ]);

      // Graph passes validation
      expect(GraphSchema.safeParse(updatedGraph).success).toBe(true);
    });

    it('renders destructive preview in ArchitectureEditor UI displaying affected edges and preserved requirements', () => {
      const graph: Graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mod-1',
            kind: 'module',
            name: 'SecurityModule',
            description: 'Security boundary',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
          {
            id: 'iface-1',
            kind: 'interface',
            name: 'ITokenValidator',
            parentId: 'mod-1',
            description: 'Token validation contract',
            provenance: 'human',
            policy: 'editable',
            contract: 'export interface ITokenValidator {}',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
          {
            id: 'cls-1',
            kind: 'class',
            name: 'JwtTokenValidator',
            parentId: 'mod-1',
            description: 'JWT implementation',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
        ],
        edges: [
          {
            id: 'edge-impl',
            source: 'cls-1',
            target: 'iface-1',
            kind: 'implements',
            label: 'implements token contract',
            provenance: 'human',
            uncertain: false,
          },
        ],
        requirements: [
          {
            id: 'req-sec-1',
            text: 'Tokens must be signed with RS256 algorithm',
            nodeIds: ['mod-1', 'iface-1'],
            edgeIds: ['edge-impl'],
            constraints: [],
            scenarios: [],
          },
        ],
      };

      const html = renderToString(
        <ArchitectureEditor
          graph={graph}
          selectedNodeId="iface-1"
          initialTab="preview-delete"
          mode="inline"
        />
      );

      // Verify destructive edit preview UI
      expect(html).toContain('data-testid="arch-destructive-preview"');
      expect(html).toContain('data-testid="preview-impact-card"');
      expect(html).toContain('Previewing Destructive Graph Edit');
      expect(html).toContain('ITokenValidator');

      // Verify exposed affected relationships list
      expect(html).toContain('data-testid="arch-affected-relationships-list"');
      expect(html).toContain('JwtTokenValidator');
      expect(html).toContain('implements');

      // Verify exposed preserved requirements list
      expect(html).toContain('data-testid="arch-preserved-requirements-list"');
      expect(html).toContain('req-sec-1');
      expect(html).toContain('Tokens must be signed with RS256 algorithm');
      expect(html).toContain('Item reference will be removed; requirement definition preserved');

      // Verify confirmation and cancel buttons
      expect(html).toContain('data-testid="arch-confirm-delete-btn"');
      expect(html).toContain('data-testid="arch-cancel-delete-btn"');
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: Architecture edits affect intended graph only
  // =========================================================================
  describe('Acceptance Criterion 1: Architecture edits affect intended graph only', () => {
    it('ensures architecture edits never mutate or alter implemented analysis models', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't020-criterion1-'));
      const store = new ProjectStore(dataDir);
      const app = await createServer({ store, host: '127.0.0.1' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        const proj = await api.createBlankProject({ name: 'Dual Graph Project' }, baseUrl);

        // Simulate an implemented analysis graph (e.g. from compiler/import)
        const implementedNode: ProgramNode = {
          id: 'imp-node-1',
          kind: 'class',
          name: 'ImplementedLegacyService',
          description: 'Legacy class extracted from source',
          provenance: 'extracted',
          policy: 'frozen-implementation',
          contract: 'export class ImplementedLegacyService {}',
          source: {
            path: 'legacy.ts',
            start: 0,
            end: 50,
            line: 1,
            hash: 'hash-legacy-123',
            revision: 'rev-impl-1',
          },
          baseline: {
            text: 'export class ImplementedLegacyService {}',
            source: {
              path: 'legacy.ts',
              start: 0,
              end: 50,
              line: 1,
              hash: 'hash-legacy-123',
              revision: 'rev-impl-1',
            },
          },
          requiredChecks: [],
          instructions: '',
          outputPath: 'legacy.ts',
          fields: [],
        };

        const implementedGraph: Graph = {
          schemaVersion: 1,
          nodes: [implementedNode],
          edges: [],
          requirements: [],
        };

        // Attach analysis to store project
        await store.updateAnalysis(proj.id, {
          revision: 'rev-impl-1',
          sequence: 1,
          analyzedAt: new Date().toISOString(),
          status: 'current',
          quality: {
            eligibleFiles: 1,
            analyzedFiles: 1,
            unresolvedReferences: 0,
            unsupportedConstructs: 0,
            inferredItems: 0,
            prismaValidation: 'not-applicable',
            diagnostics: [],
          },
          durationMs: 50,
          graph: implementedGraph,
          files: {
            'legacy.ts': {
              hash: 'hash-legacy-123',
              text: 'export class ImplementedLegacyService {}',
            },
          },
        });

        const projWithAnalysis = await api.getProject(proj.id, baseUrl);
        expect(projWithAnalysis.analysis).toBeDefined();
        const initialAnalysisSnapshot = JSON.stringify(projWithAnalysis.analysis);

        // Now perform human architecture editing on intended specification
        const initialSpec = projWithAnalysis.specification;
        const { graph: afterAddMod } = createArchitectureNode(initialSpec, {
          name: 'NewIntendedModule',
          kind: 'module',
          description: 'Human intent for business logic',
        });

        const { graph: afterAddIface } = createArchitectureNode(afterAddMod, {
          name: 'IIntendedInterface',
          kind: 'interface',
          contract: 'export interface IIntendedInterface {}',
        });

        const updatedProject = await api.updateSpecification(
          proj.id,
          projWithAnalysis.specRevision,
          afterAddIface,
          baseUrl
        );

        // Verify: Intended specification updated
        expect(updatedProject.specRevision).toBe(1);
        expect(updatedProject.specification.nodes).toHaveLength(2);
        expect(updatedProject.specification.nodes.map(n => n.name)).toContain('NewIntendedModule');
        expect(updatedProject.specification.nodes.map(n => n.name)).toContain('IIntendedInterface');

        // Verify: Implemented analysis snapshot is STRICTLY UNCHANGED
        const refreshedProject = await api.getProject(proj.id, baseUrl);
        expect(JSON.stringify(refreshedProject.analysis)).toBe(initialAnalysisSnapshot);
        expect(refreshedProject.analysis?.graph.nodes).toHaveLength(1);
        expect(refreshedProject.analysis?.graph.nodes[0].name).toBe('ImplementedLegacyService');
        expect(refreshedProject.analysis?.graph.nodes[0].provenance).toBe('extracted');
      } finally {
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Supported relationships validate
  // =========================================================================
  describe('Acceptance Criterion 2: Supported relationships validate', () => {
    it('accepts valid relationship combinations', () => {
      // implements: class -> interface, class -> class
      expect(validateRelationship('implements', 'class', 'interface').valid).toBe(true);
      expect(validateRelationship('implements', 'class', 'class').valid).toBe(true);

      // inherits: class -> class, interface -> interface, interface -> class
      expect(validateRelationship('inherits', 'class', 'class').valid).toBe(true);
      expect(validateRelationship('inherits', 'interface', 'interface').valid).toBe(true);
      expect(validateRelationship('inherits', 'interface', 'class').valid).toBe(true);

      // contains: system -> module, module -> class, module -> interface, class -> function
      expect(validateRelationship('contains', 'system', 'module').valid).toBe(true);
      expect(validateRelationship('contains', 'module', 'class').valid).toBe(true);
      expect(validateRelationship('contains', 'module', 'interface').valid).toBe(true);
      expect(validateRelationship('contains', 'class', 'function').valid).toBe(true);

      // depends-on: between any non-step items
      expect(validateRelationship('depends-on', 'module', 'module').valid).toBe(true);
      expect(validateRelationship('depends-on', 'class', 'class').valid).toBe(true);
      expect(validateRelationship('depends-on', 'system', 'system').valid).toBe(true);

      // calls: class -> function, module -> function, function -> function
      expect(validateRelationship('calls', 'class', 'function').valid).toBe(true);
      expect(validateRelationship('calls', 'module', 'function').valid).toBe(true);
      expect(validateRelationship('calls', 'function', 'function').valid).toBe(true);

      // relates-to: entity -> entity
      expect(validateRelationship('relates-to', 'entity', 'entity').valid).toBe(true);
    });

    it('rejects unsupported relationship combinations with informative error messages', () => {
      // interface cannot implement a class
      const r1 = validateRelationship('implements', 'interface', 'class');
      expect(r1.valid).toBe(false);
      expect(r1.error).toContain('is not supported from interface to class');

      // system cannot implement module
      const r2 = validateRelationship('implements', 'system', 'module');
      expect(r2.valid).toBe(false);

      // class cannot inherit interface (must implement interface)
      const r3 = validateRelationship('inherits', 'class', 'interface');
      expect(r3.valid).toBe(false);

      // relates-to is only for entity -> entity
      const r4 = validateRelationship('relates-to', 'class', 'class');
      expect(r4.valid).toBe(false);

      // entity cannot contain class
      const r5 = validateRelationship('contains', 'entity', 'class');
      expect(r5.valid).toBe(false);

      // step cannot depend on non-step
      const r6 = validateRelationship('depends-on', 'step', 'class');
      expect(r6.valid).toBe(false);
    });

    it('throws when attempting to connect nodes with an unsupported relationship', () => {
      const graph: Graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: 'iface-1',
            kind: 'interface',
            name: 'IDataSource',
            description: 'Data source interface',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
          {
            id: 'cls-1',
            kind: 'class',
            name: 'SqlDataSource',
            description: 'SQL data source implementation',
            provenance: 'human',
            policy: 'editable',
            contract: '',
            requiredChecks: [],
            instructions: '',
            outputPath: '',
            fields: [],
          },
        ],
        edges: [],
        requirements: [],
      };

      // Attempting: interface implements class (invalid)
      expect(() => {
        connectNodes(graph, {
          sourceId: 'iface-1',
          targetId: 'cls-1',
          kind: 'implements',
        });
      }).toThrow(/Invalid relationship.*not supported from interface to class/);

      // Attempting: class inherits interface (invalid)
      expect(() => {
        connectNodes(graph, {
          sourceId: 'cls-1',
          targetId: 'iface-1',
          kind: 'inherits',
        });
      }).toThrow(/Invalid relationship.*not supported from class to interface/);
    });

    it('rejects containment cycles during nesting', () => {
      const nodeA: ProgramNode = {
        id: 'mod-a',
        kind: 'module',
        name: 'ModuleA',
        description: 'Module A description',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };
      const nodeB: ProgramNode = {
        id: 'mod-b',
        kind: 'module',
        name: 'ModuleB',
        parentId: 'mod-a',
        description: 'Module B description',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };

      const graph: Graph = {
        schemaVersion: 1,
        nodes: [nodeA, nodeB],
        edges: [],
        requirements: [],
      };

      // Trying to make ModuleA a child of ModuleB while ModuleB is a child of ModuleA
      expect(() => {
        updateArchitectureNode(graph, 'mod-a', { parentId: 'mod-b' });
      }).toThrow(/Containment cycle involving/);
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Target metadata does not restrict available architecture kinds
  // =========================================================================
  describe('Acceptance Criterion 3: Target metadata does not restrict available architecture kinds', () => {
    it('returns all architecture kinds regardless of target platform metadata', () => {
      const expectedKinds = ['system', 'module', 'class', 'interface', 'function', 'entity', 'enum'];

      const testTargets = [
        'Web application',
        'Desktop application',
        'CLI tool',
        'Microservices platform',
        'Embedded IoT system',
        'Mobile application (iOS/Android)',
        'TypeScript library',
        '',
        undefined,
      ];

      testTargets.forEach(target => {
        const available = getCreatableKinds(target);
        expect(available).toEqual(expectedKinds);
      });
    });

    it('allows creating any architecture kind under Desktop, Web, or custom target metadata', () => {
      const kindsToTest: ProgramNode['kind'][] = [
        'system',
        'module',
        'class',
        'interface',
        'function',
        'entity',
        'enum',
      ];

      let graph = emptyGraph();
      kindsToTest.forEach((kind, idx) => {
        const { graph: nextGraph, node } = createArchitectureNode(graph, {
          name: `Item_${kind}_${idx}`,
          kind,
          description: `Architecture definition of kind ${kind} on desktop/web target`,
        });
        graph = nextGraph;
        expect(node.kind).toBe(kind);
      });

      expect(graph.nodes).toHaveLength(kindsToTest.length);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('renders target metadata badge in ArchitectureEditor without disabling kinds', () => {
      const mockProject: Project = {
        id: 'proj-desktop-1',
        name: 'CrossPlatformDesk',
        description: 'Native desktop application',
        target: 'Desktop application (Electron / Tauri)',
        root: '/app/desktop',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 0,
        specification: emptyGraph(),
        layout: {},
        checks: {},
      };

      const html = renderToString(
        <ArchitectureEditor
          project={mockProject}
          graph={mockProject.specification}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="arch-target-badge"');
      expect(html).toContain('Target: Desktop application (Electron / Tauri)');
      expect(html).toContain('value="system"');
      expect(html).toContain('value="module"');
      expect(html).toContain('value="class"');
      expect(html).toContain('value="interface"');
      expect(html).toContain('Available regardless of project target metadata');
    });
  });

  // =========================================================================
  // Checklist: Add, rename, nest, remove, and connect architecture items
  // =========================================================================
  describe('Work Checklist: Complete architecture editing workflows', () => {
    it('renames an item, updates module responsibilities, and modifies interface definitions', () => {
      let graph = createInitialTestGraph();

      // Find initial BillingModule
      const billingMod = graph.nodes.find(n => n.name === 'BillingModule')!;
      expect(billingMod.description).toBe('Billing and invoicing services');

      // Update name and description (module responsibilities)
      const { graph: g1, node: updatedMod } = updateArchitectureNode(graph, billingMod.id, {
        name: 'InvoicingAndPaymentModule',
        description: 'Responsible for Stripe integration, PCI DSS compliance, and PDF invoices',
      });
      graph = g1;
      expect(updatedMod.name).toBe('InvoicingAndPaymentModule');
      expect(updatedMod.description).toBe(
        'Responsible for Stripe integration, PCI DSS compliance, and PDF invoices'
      );

      // Add interface and update its definition
      const { graph: g2, node: iface } = createArchitectureNode(graph, {
        name: 'IPaymentGateway',
        kind: 'interface',
        parentId: updatedMod.id,
        contract: 'export interface IPaymentGateway {}',
      });
      graph = g2;

      // Edit interface definition / contract
      const { graph: g3, node: updatedIface } = updateArchitectureNode(graph, iface.id, {
        contract:
          'export interface IPaymentGateway {\n  charge(amount: number, currency: string): Promise<string>;\n  refund(chargeId: string): Promise<boolean>;\n}',
      });
      graph = g3;
      expect(updatedIface.contract).toContain('charge(amount: number, currency: string)');
      expect(updatedIface.contract).toContain('refund(chargeId: string)');

      // Verify schema
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('nests and re-parents architecture items respecting containment rules', () => {
      let graph = emptyGraph();

      const { graph: g1, node: sys } = createArchitectureNode(graph, {
        name: 'EnterpriseSystem',
        kind: 'system',
      });
      const { graph: g2, node: mod1 } = createArchitectureNode(g1, {
        name: 'ModuleAlpha',
        kind: 'module',
      });
      const { graph: g3, node: mod2 } = createArchitectureNode(g2, {
        name: 'ModuleBeta',
        kind: 'module',
      });
      const { graph: g4, node: cls } = createArchitectureNode(g3, {
        name: 'WorkerClass',
        kind: 'class',
        parentId: mod1.id, // initially in mod1
      });
      graph = g4;

      expect(cls.parentId).toBe(mod1.id);

      // Re-parent class from mod1 into mod2
      const { graph: g5, node: movedCls } = updateArchitectureNode(graph, cls.id, {
        parentId: mod2.id,
      });
      graph = g5;
      expect(movedCls.parentId).toBe(mod2.id);

      // Re-parent mod1 into sys
      const { graph: g6, node: nestedMod } = updateArchitectureNode(graph, mod1.id, {
        parentId: sys.id,
      });
      graph = g6;
      expect(nestedMod.parentId).toBe(sys.id);

      // Move class to root (null parentId)
      const { graph: g7, node: rootCls } = updateArchitectureNode(graph, cls.id, {
        parentId: null,
      });
      graph = g7;
      expect(rootCls.parentId).toBeUndefined();

      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('rejects invalid nesting attempts', () => {
      const { graph, node: iface } = createArchitectureNode(emptyGraph(), {
        name: 'ISomething',
        kind: 'interface',
      });
      const { graph: g2, node: sys } = createArchitectureNode(graph, {
        name: 'Sys',
        kind: 'system',
      });

      // System cannot be nested inside an interface
      expect(() => {
        updateArchitectureNode(g2, sys.id, { parentId: iface.id });
      }).toThrow(/Invalid nesting: interface cannot contain system/);
    });
  });

  // =========================================================================
  // UI Component Integration Tests
  // =========================================================================
  describe('UI Component Integration', () => {
    it('renders ArchitectureEditor with tabs, forms, and testids in modal mode', () => {
      const graph = createInitialTestGraph();

      const html = renderToString(
        <ArchitectureEditor
          graph={graph}
          isOpen={true}
          mode="modal"
          initialTab="add"
        />
      );

      expect(html).toContain('data-testid="arch-modal-backdrop"');
      expect(html).toContain('data-testid="architecture-editor"');
      expect(html).toContain('data-testid="arch-tabs"');
      expect(html).toContain('data-testid="arch-tab-add"');
      expect(html).toContain('data-testid="arch-tab-edit"');
      expect(html).toContain('data-testid="arch-tab-connect"');
      expect(html).toContain('data-testid="arch-tab-preview"');
      expect(html).toContain('data-testid="arch-add-form"');
      expect(html).toContain('data-testid="arch-add-kind-select"');
      expect(html).toContain('data-testid="arch-add-name-input"');
      expect(html).toContain('data-testid="arch-add-desc-input"');
      expect(html).toContain('data-testid="arch-add-contract-input"');
      expect(html).toContain('data-testid="arch-add-submit-btn"');
    });

    it('renders Edit tab in ArchitectureEditor with selected item details', () => {
      const graph = createInitialTestGraph();

      const html = renderToString(
        <ArchitectureEditor
          graph={graph}
          selectedNodeId="mod-billing"
          initialTab="edit"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="arch-edit-form"');
      expect(html).toContain('data-testid="arch-edit-node-select"');
      expect(html).toContain('data-testid="arch-edit-name-input"');
      expect(html).toContain('value="BillingModule"');
      expect(html).toContain('Billing and invoicing services');
      expect(html).toContain('data-testid="arch-edit-submit-btn"');
      expect(html).toContain('data-testid="arch-open-delete-preview-btn"');
    });

    it('renders Connect tab with relationship validation feedback', () => {
      let graph = emptyGraph();
      const { graph: g1, node: cls } = createArchitectureNode(graph, {
        name: 'UserService',
        kind: 'class',
      });
      const { graph: g2, node: iface } = createArchitectureNode(g1, {
        name: 'IUserService',
        kind: 'interface',
      });

      const html = renderToString(
        <ArchitectureEditor
          graph={g2}
          initialTab="connect"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="arch-connect-form"');
      expect(html).toContain('data-testid="arch-connect-source-select"');
      expect(html).toContain('data-testid="arch-connect-target-select"');
      expect(html).toContain('data-testid="arch-connect-kind-select"');
      expect(html).toContain('data-testid="arch-connect-submit-btn"');
    });

    it('integrates Architecture action in Header, Canvas, and PropertyInspector', () => {
      const project: Project = {
        id: 'p-integrated',
        name: 'Integrated Architecture App',
        description: 'Complete workspace test',
        target: 'Web application',
        root: '/app/test',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 0,
        specification: createInitialTestGraph(),
        layout: {},
        checks: {},
      };

      // Header button integration
      const headerHtml = renderToString(
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
          onTogglePanel={() => {}}
          onOpenNewProject={() => {}}
          onOpenProjectPicker={() => {}}
          onOpenArchitectureEditor={() => {}}
        />
      );
      expect(headerHtml).toContain('data-testid="header-open-architecture"');

      // PropertyInspector edit action integration
      const inspectorHtml = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: 'mod-billing',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onDeleteNode={() => {}}
          onEditNode={() => {}}
        />
      );
      expect(inspectorHtml).toContain('data-testid="inspector-edit-node"');

      // Canvas add button integration
      const canvasHtml = renderToString(
        <Canvas
          graph={project.specification}
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
          onOpenArchitectureEditor={() => {}}
        />
      );
      expect(canvasHtml).toContain('data-testid="canvas-add-node-btn"');
    });

    it('renders full App shell with ArchitectureEditor modal integration', () => {
      const project: Project = {
        id: 'p-app-full',
        name: 'Full Workspace App',
        description: 'Workspace shell test',
        target: 'Desktop application',
        root: '/app/full',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 0,
        specification: createInitialTestGraph(),
        layout: {},
        checks: {},
      };

      const appHtml = renderToString(<App initialProject={project} autoLoad={false} />);
      expect(appHtml).toContain('data-testid="workspace-shell"');
      expect(appHtml).toContain('data-testid="header-open-architecture"');
      expect(appHtml).toContain('data-testid="canvas-add-node-btn"');
    });
  });
});
