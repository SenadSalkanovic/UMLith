import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import { Header } from '../../src/components/Header';
import { ProjectTree } from '../../src/components/ProjectTree';
import { Canvas } from '../../src/components/Canvas';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { RevisionHistory, buildRevisionItems, computeRevisionChanges } from '../../src/components/RevisionHistory';
import { ProjectPicker } from '../../src/components/ProjectPicker';
import {
  WorkflowEditor,
  WORKFLOW_OPTIONAL_BANNER,
  createWorkflowStep,
  connectWorkflowSteps,
  removeFunctionWorkflow,
  getFunctionWorkflowSteps,
  getFunctionWorkflowEdges,
} from '../../src/components/WorkflowEditor';
import {
  FunctionEditor,
  WORKFLOW_OPTIONAL_NOTICE,
  createFunctionNode,
  updateFunctionNode,
  isDescriptionOnlyFunction,
  isDetailedFunction,
  hasWorkflow,
} from '../../src/components/FunctionEditor';
import {
  ArchitectureEditor,
  createArchitectureNode,
  connectNodes,
} from '../../src/components/ArchitectureEditor';
import {
  ErEditor,
  createEntityNode,
  addEntityField,
  createEnumNode,
  createEntityRelationship,
} from '../../src/components/ErEditor';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import { exportBundle } from '../../server/export';
import { hash } from '../../server/files';
import {
  emptyGraph,
  GraphSchema,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Requirement,
  type Layout,
} from '../../shared/model';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('T030 — Validate the mixed-detail new-project editing journey', () => {
  // =========================================================================
  // Concrete Validation Scenario 1: Build a project with one simple and one workflow function and reload
  // =========================================================================
  describe('Concrete Scenario 1: Build a project with one simple and one workflow function and reload', () => {
    it('exercises create, architecture/ER/function editing, and optional workflow editing together, saves, restarts service and reloads state', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-journey-'));

      try {
        // Step 1: Start service instance 1
        const initialStore = new ProjectStore(storeDir);
        let app = await createServer({ store: initialStore });
        let address = await app.listen({ host: '127.0.0.1', port: 0 });
        let apiBase = `${address}/api`;

        // Create new project with desktop target metadata without imposing a generation template
        const createdProject = await api.createBlankProject(
          {
            name: 'CloudInventoryPlatform',
            description: 'Warehouse inventory control with mixed-detail functions',
            target: 'Desktop application (Electron)',
          },
          apiBase
        );

        expect(createdProject.id).toBeDefined();
        expect(createdProject.name).toBe('CloudInventoryPlatform');
        expect(createdProject.target).toBe('Desktop application (Electron)');
        expect(createdProject.specRevision).toBe(0);
        expect(createdProject.specification.nodes).toHaveLength(0);

        // Step 2: Architecture Editing
        // Create root system
        const { graph: g1, node: sysNode } = createArchitectureNode(createdProject.specification, {
          name: 'InventorySystem',
          kind: 'system',
          description: 'Top-level warehouse management system boundary',
        });

        // Create module inside system
        const { graph: g2, node: modNode } = createArchitectureNode(g1, {
          name: 'StockModule',
          kind: 'module',
          parentId: sysNode.id,
          description: 'Real-time stock reservation and fulfillment module',
        });

        // Create interface inside module
        const { graph: g3, node: ifaceNode } = createArchitectureNode(g2, {
          name: 'IStockService',
          kind: 'interface',
          parentId: modNode.id,
          description: 'Stock operations interface contract',
        });

        // Connect architecture nodes
        const { graph: g4 } = connectNodes(g3, {
          sourceId: modNode.id,
          targetId: ifaceNode.id,
          kind: 'contains',
        });

        // Step 3: ER Editing
        // Create entity with primary key, unique constraint, and optional field
        const { graph: g5, node: itemEntity } = createEntityNode(g4, {
          name: 'InventoryItem',
          parentId: modNode.id,
          description: 'Persisted stock item entity · Database table: inventory_items',
        });

        const { graph: g6 } = addEntityField(g5, itemEntity.id, {
          name: 'id',
          type: 'Int',
          key: 'PK',
          optional: false,
        });

        const { graph: g7 } = addEntityField(g6, itemEntity.id, {
          name: 'sku',
          type: 'String',
          key: 'UNIQUE',
          optional: false,
          mappedName: 'sku_code',
        });

        const { graph: g8 } = addEntityField(g7, itemEntity.id, {
          name: 'quantityOnHand',
          type: 'Int',
          key: '',
          optional: false,
        });

        // Create status enum
        const { graph: g9, node: statusEnum } = createEnumNode(g8, {
          name: 'StockStatus',
          parentId: modNode.id,
          description: 'Item reservation availability status',
          members: ['AVAILABLE', 'RESERVED', 'DISCONTINUED'],
        });

        // Step 4: Mixed Function Editing
        // 4a: Simple Description-Only Function (healthPing)
        const { graph: g10, node: simplePingFn } = createFunctionNode(g9, {
          name: 'healthPing',
          parentId: modNode.id,
          description: 'Lightweight liveness probe checking memory and DB latency',
          policy: 'editable',
          contract: 'export function healthPing(): boolean',
          outputPath: 'src/stock/ping.ts',
          // inputs, outputs, rules, errors, scenarios, workflow are all omitted!
        });

        expect(isDescriptionOnlyFunction(simplePingFn)).toBe(true);
        expect(isDetailedFunction(simplePingFn)).toBe(false);
        expect(hasWorkflow(g10, simplePingFn.id)).toBe(false);

        // 4b: Detailed Function (reserveStock)
        const { graph: g11, node: detailedReserveFn } = createFunctionNode(g10, {
          name: 'reserveStock',
          parentId: modNode.id,
          description: 'Atomically reserves stock for a customer order with rollback support',
          policy: 'sensitive',
          contract: 'export function reserveStock(sku: string, qty: number): Promise<ReservationReceipt>',
          inputs: 'sku: string\nqty: number',
          outputs: 'Promise<ReservationReceipt>',
          rules: 'Quantity must be strictly positive\nMust decrement quantityOnHand atomically\nMust emit StockReserved audit event',
          errors: 'InsufficientStockError: qty > available\nItemNotFoundError: SKU does not exist',
          scenarios: [
            'Given 10 available items, when reserving 2, returns receipt and updates quantity to 8',
            'When requested quantity exceeds available, rolls back and raises InsufficientStockError',
          ],
          instructions: 'Maintain exact database transaction isolation. Never execute non-atomic partial decrements.',
          requiredChecks: ['npm test', 'npx tsc --noEmit'],
          outputPath: 'src/stock/reservation.ts',
        });

        expect(isDescriptionOnlyFunction(detailedReserveFn)).toBe(false);
        expect(isDetailedFunction(detailedReserveFn)).toBe(true);

        // Step 5: Optional Function Workflow Editing inside detailedReserveFn
        // Step 5a: Condition step
        const { graph: g12, node: stepCheckQty } = createWorkflowStep(g11, {
          functionId: detailedReserveFn.id,
          stepType: 'condition',
          name: 'checkAvailability',
          description: 'Verify quantityOnHand >= qty requested',
        });

        // Step 5b: Loop step for retry
        const { graph: g13, node: stepRetryLoop } = createWorkflowStep(g12, {
          functionId: detailedReserveFn.id,
          stepType: 'loop',
          name: 'retryDbLock',
          description: 'Retry optimistic lock acquisition up to 3 times',
        });

        // Step 5c: Call step for decrementing
        const { graph: g14, node: stepExecDecrement } = createWorkflowStep(g13, {
          functionId: detailedReserveFn.id,
          stepType: 'call',
          name: 'executeDecrement',
          description: 'Issue SQL UPDATE decrementing stock count',
        });

        // Step 5d: Throw/exception step for out-of-stock
        const { graph: g15, node: stepHandleOutOfStock } = createWorkflowStep(g14, {
          functionId: detailedReserveFn.id,
          stepType: 'throw',
          name: 'handleInsufficient',
          description: 'Rollback transaction and raise InsufficientStockError',
        });

        // Step 5e: Return step for success
        const { graph: g16, node: stepReturnReceipt } = createWorkflowStep(g15, {
          functionId: detailedReserveFn.id,
          stepType: 'return',
          name: 'returnReceipt',
          description: 'Construct and return signed ReservationReceipt',
        });

        // Connect workflow steps
        const { graph: g17 } = connectWorkflowSteps(g16, {
          sourceId: stepCheckQty.id,
          targetId: stepRetryLoop.id,
          kind: 'true',
          label: 'sufficient',
        });

        const { graph: g18 } = connectWorkflowSteps(g17, {
          sourceId: stepCheckQty.id,
          targetId: stepHandleOutOfStock.id,
          kind: 'false',
          label: 'insufficient',
        });

        const { graph: g19 } = connectWorkflowSteps(g18, {
          sourceId: stepRetryLoop.id,
          targetId: stepExecDecrement.id,
          kind: 'next',
          label: 'attempt',
        });

        const { graph: g20 } = connectWorkflowSteps(g19, {
          sourceId: stepExecDecrement.id,
          targetId: stepReturnReceipt.id,
          kind: 'next',
          label: 'success',
        });

        // Add a requirement linking the items
        const manualGraph: Graph = {
          ...g20,
          requirements: [
            {
              id: 'req-atomic-reservation',
              text: 'Stock reservation must be atomic and audit-logged',
              nodeIds: [detailedReserveFn.id, itemEntity.id],
              edgeIds: [],
              constraints: ['Zero dirty reads', 'Strict isolation'],
              scenarios: ['Given parallel reservation requests, total reserved equals sum of requests'],
            },
          ],
        };

        // Step 6: Save the complete manual specification
        const savedSpecProject = await api.updateSpecification(
          createdProject.id,
          0,
          manualGraph,
          apiBase
        );

        expect(savedSpecProject.specRevision).toBe(1);
        expect(savedSpecProject.specification.nodes).toHaveLength(manualGraph.nodes.length);

        // Step 7: Layout Editing (Root + Scoped Workflow Layout)
        const rootLayout: Layout = {
          [sysNode.id]: { x: 100, y: 50 },
          [modNode.id]: { x: 150, y: 150 },
          [ifaceNode.id]: { x: 200, y: 250 },
          [itemEntity.id]: { x: 400, y: 250 },
          [statusEnum.id]: { x: 600, y: 250 },
          [simplePingFn.id]: { x: 150, y: 400 },
          [detailedReserveFn.id]: { x: 450, y: 400 },
        };

        const workflowScopedLayout: Layout = {
          [stepCheckQty.id]: { x: 50, y: 50 },
          [stepHandleOutOfStock.id]: { x: 300, y: 50 },
          [stepRetryLoop.id]: { x: 50, y: 180 },
          [stepExecDecrement.id]: { x: 50, y: 300 },
          [stepReturnReceipt.id]: { x: 50, y: 420 },
        };

        await api.updateLayout(createdProject.id, rootLayout, undefined, apiBase);
        const savedLayoutProject = await api.updateLayout(
          createdProject.id,
          workflowScopedLayout,
          `function:${detailedReserveFn.id}`,
          apiBase
        );

        expect(savedLayoutProject.layoutRevision).toBe(2);
        expect(savedLayoutProject.specRevision).toBe(1); // Layout does NOT increment spec revision

        // Step 8: SHUTDOWN service instance 1
        await app.close();

        // Step 9: RESTART service instance 2 on the same storage directory
        const restartedStore = new ProjectStore(storeDir);
        app = await createServer({ store: restartedStore });
        address = await app.listen({ host: '127.0.0.1', port: 0 });
        apiBase = `${address}/api`;

        // Step 10: RELOAD state via API
        const reloadedProject = await api.getProject(createdProject.id, apiBase);

        // Verify fundamental project identity and revisions across restart
        expect(reloadedProject.id).toBe(createdProject.id);
        expect(reloadedProject.name).toBe('CloudInventoryPlatform');
        expect(reloadedProject.target).toBe('Desktop application (Electron)');
        expect(reloadedProject.specRevision).toBe(1);
        expect(reloadedProject.layoutRevision).toBe(2);

        // Verify architecture and ER items survived restart
        const reloadedSys = reloadedProject.specification.nodes.find(n => n.id === sysNode.id)!;
        expect(reloadedSys).toBeDefined();
        expect(reloadedSys.name).toBe('InventorySystem');
        expect(reloadedSys.kind).toBe('system');

        const reloadedMod = reloadedProject.specification.nodes.find(n => n.id === modNode.id)!;
        expect(reloadedMod).toBeDefined();
        expect(reloadedMod.name).toBe('StockModule');
        expect(reloadedMod.parentId).toBe(sysNode.id);

        const reloadedEntity = reloadedProject.specification.nodes.find(n => n.id === itemEntity.id)!;
        expect(reloadedEntity).toBeDefined();
        expect(reloadedEntity.fields).toHaveLength(3);
        expect(reloadedEntity.fields.find(f => f.name === 'sku')?.key).toBe('UNIQUE');

        const reloadedEnum = reloadedProject.specification.nodes.find(n => n.id === statusEnum.id)!;
        expect(reloadedEnum).toBeDefined();
        expect(reloadedEnum.fields.map(f => f.name)).toEqual(['AVAILABLE', 'RESERVED', 'DISCONTINUED']);

        // Verify Description-only function survived restart exactly as description-only
        const reloadedPing = reloadedProject.specification.nodes.find(n => n.id === simplePingFn.id)!;
        expect(reloadedPing).toBeDefined();
        expect(reloadedPing.name).toBe('healthPing');
        expect(reloadedPing.description).toBe('Lightweight liveness probe checking memory and DB latency');
        expect(reloadedPing.contract).toBe('export function healthPing(): boolean');
        expect(reloadedPing.inputs).toBeUndefined();
        expect(reloadedPing.outputs).toBeUndefined();
        expect(reloadedPing.rules).toBeUndefined();
        expect(reloadedPing.errors).toBeUndefined();
        expect(reloadedPing.scenarios).toBeUndefined();
        expect(isDescriptionOnlyFunction(reloadedPing)).toBe(true);
        expect(hasWorkflow(reloadedProject.specification, reloadedPing.id)).toBe(false);

        // Verify Detailed function survived restart with full contract, policies, and workflows
        const reloadedReserve = reloadedProject.specification.nodes.find(n => n.id === detailedReserveFn.id)!;
        expect(reloadedReserve).toBeDefined();
        expect(reloadedReserve.name).toBe('reserveStock');
        expect(reloadedReserve.policy).toBe('sensitive');
        expect(reloadedReserve.contract).toContain('reserveStock(sku: string, qty: number)');
        expect(reloadedReserve.inputs).toBe('sku: string\nqty: number');
        expect(reloadedReserve.outputs).toBe('Promise<ReservationReceipt>');
        expect(reloadedReserve.rules).toContain('Must decrement quantityOnHand atomically');
        expect(reloadedReserve.errors).toContain('InsufficientStockError');
        expect(reloadedReserve.scenarios).toHaveLength(2);
        expect(reloadedReserve.instructions).toContain('Maintain exact database transaction isolation');
        expect(reloadedReserve.requiredChecks).toEqual(['npm test', 'npx tsc --noEmit']);
        expect(isDetailedFunction(reloadedReserve)).toBe(true);
        expect(hasWorkflow(reloadedProject.specification, reloadedReserve.id)).toBe(true);

        // Verify workflow steps survived restart
        const reloadedSteps = getFunctionWorkflowSteps(reloadedProject.specification, detailedReserveFn.id);
        expect(reloadedSteps).toHaveLength(5);
        expect(reloadedSteps.map(s => s.name)).toEqual([
          'checkAvailability',
          'retryDbLock',
          'executeDecrement',
          'handleInsufficient',
          'returnReceipt',
        ]);

        const reloadedEdges = getFunctionWorkflowEdges(reloadedProject.specification, detailedReserveFn.id);
        expect(reloadedEdges).toHaveLength(4);
        expect(reloadedEdges.find(e => e.label === 'sufficient')?.kind).toBe('true');
        expect(reloadedEdges.find(e => e.label === 'insufficient')?.kind).toBe('false');

        // Verify independent layouts survived restart
        expect(reloadedProject.layout[sysNode.id]).toEqual({ x: 100, y: 50 });
        expect(reloadedProject.layout[simplePingFn.id]).toEqual({ x: 150, y: 400 });
        expect(reloadedProject.layout[detailedReserveFn.id]).toEqual({ x: 450, y: 400 });

        const reloadedScoped = reloadedProject.scopedLayouts?.[`function:${detailedReserveFn.id}`];
        expect(reloadedScoped).toBeDefined();
        expect(reloadedScoped?.[stepCheckQty.id]).toEqual({ x: 50, y: 50 });
        expect(reloadedScoped?.[stepHandleOutOfStock.id]).toEqual({ x: 300, y: 50 });

        await app.close();
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Compare persisted JSON with the expected manual model
  // =========================================================================
  describe('Concrete Scenario 2: Compare persisted JSON with the expected manual model', () => {
    it('compares persisted project.json, layout.json, and revision files directly against the expected manual model', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-json-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({
          name: 'ManualModelVerification',
          description: 'Validates on-disk JSON structure against model rules',
          target: 'Web service',
        });

        const simpleFn: ProgramNode = {
          id: 'fn-simple',
          kind: 'function',
          name: 'simplePing',
          description: 'Description-only ping',
          provenance: 'human',
          policy: 'editable',
          contract: 'export function simplePing(): void',
          requiredChecks: [],
          instructions: '',
          outputPath: 'src/ping.ts',
          fields: [],
        };

        const detailedFn: ProgramNode = {
          id: 'fn-detail',
          kind: 'function',
          name: 'computeInvoice',
          description: 'Detailed billing calculation with workflow',
          provenance: 'human',
          policy: 'sensitive',
          contract: 'export function computeInvoice(total: number): number',
          inputs: 'total: number',
          outputs: 'number',
          rules: 'Non-negative totals only',
          errors: 'InvalidTotalError',
          scenarios: ['Given 100, returns 110 with 10% tax'],
          requiredChecks: ['npm test'],
          instructions: 'Always round to nearest cent',
          outputPath: 'src/invoice.ts',
          fields: [],
        };

        const stepNode: ProgramNode = {
          id: 'step-1',
          kind: 'step',
          stepType: 'call',
          parentId: 'fn-detail',
          name: 'applyTax',
          description: 'Calculates tax rate',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        const stepReturn: ProgramNode = {
          id: 'step-2',
          kind: 'step',
          stepType: 'return',
          parentId: 'fn-detail',
          name: 'returnTotal',
          description: 'Returns grand total',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        const workflowEdge: ProgramEdge = {
          id: 'edge-step-1-2',
          source: 'step-1',
          target: 'step-2',
          kind: 'next',
          label: 'done',
          provenance: 'human',
          uncertain: false,
        };

        const graph = GraphSchema.parse({
          nodes: [simpleFn, detailedFn, stepNode, stepReturn],
          edges: [workflowEdge],
          requirements: [
            {
              id: 'req-tax',
              text: 'Tax calculations must be reproducible',
              nodeIds: ['fn-detail'],
              edgeIds: [],
              constraints: ['Fixed 10% standard rate'],
              scenarios: ['Given standard purchase, calculate exact tax'],
            },
          ],
        });

        // Save spec revision 1
        await store.updateSpec(p.id, 0, graph);

        // Save layout
        const rootLayout: Layout = {
          'fn-simple': { x: 10, y: 20 },
          'fn-detail': { x: 200, y: 20 },
        };
        const scopedLayout: Layout = {
          'step-1': { x: 15, y: 15 },
          'step-2': { x: 15, y: 115 },
        };
        await store.updateLayout(p.id, rootLayout);
        await store.updateLayout(p.id, scopedLayout, 'function:fn-detail');

        const projectDir = store.projectDir(p.id);

        // 1. Compare project.json
        const projectJsonText = await readFile(join(projectDir, 'project.json'), 'utf8');
        const projectDoc = JSON.parse(projectJsonText);

        expect(projectDoc.specification.schemaVersion).toBe(1);
        expect(projectDoc.id).toBe(p.id);
        expect(projectDoc.name).toBe('ManualModelVerification');
        expect(projectDoc.target).toBe('Web service');
        expect(projectDoc.managed).toBe(true);
        expect(projectDoc.specRevision).toBe(1);

        // Verify layout geometry is NOT stored in project.json
        expect(projectDoc).not.toHaveProperty('layout');
        expect(projectDoc).not.toHaveProperty('scopedLayouts');
        expect(projectDoc).not.toHaveProperty('layoutRevision');

        // Verify description-only node in JSON
        const rawSimple = projectDoc.specification.nodes.find((n: any) => n.id === 'fn-simple');
        expect(rawSimple).toBeDefined();
        expect(rawSimple.name).toBe('simplePing');
        expect(rawSimple.description).toBe('Description-only ping');
        for (const omitField of ['inputs', 'outputs', 'rules', 'errors', 'scenarios']) {
          expect(rawSimple).not.toHaveProperty(omitField);
        }

        // Verify detailed node in JSON
        const rawDetailed = projectDoc.specification.nodes.find((n: any) => n.id === 'fn-detail');
        expect(rawDetailed).toBeDefined();
        expect(rawDetailed.name).toBe('computeInvoice');
        expect(rawDetailed.inputs).toBe('total: number');
        expect(rawDetailed.outputs).toBe('number');
        expect(rawDetailed.rules).toBe('Non-negative totals only');
        expect(rawDetailed.errors).toBe('InvalidTotalError');
        expect(rawDetailed.scenarios).toEqual(['Given 100, returns 110 with 10% tax']);
        expect(rawDetailed.policy).toBe('sensitive');
        expect(rawDetailed.instructions).toBe('Always round to nearest cent');
        expect(rawDetailed.requiredChecks).toEqual(['npm test']);

        // Verify workflow steps in JSON
        const rawStep1 = projectDoc.specification.nodes.find((n: any) => n.id === 'step-1');
        expect(rawStep1.kind).toBe('step');
        expect(rawStep1.stepType).toBe('call');
        expect(rawStep1.parentId).toBe('fn-detail');

        // 2. Compare layout.json
        const layoutJsonText = await readFile(join(projectDir, 'layout.json'), 'utf8');
        const layoutDoc = JSON.parse(layoutJsonText);

        expect(layoutDoc.schemaVersion).toBe(1);
        expect(layoutDoc.revision).toBe(2);
        expect(layoutDoc.layout).toEqual(rootLayout);
        expect(layoutDoc.scopedLayouts['function:fn-detail']).toEqual(scopedLayout);

        // 3. Compare revisions/ on disk
        const revisionFiles = await readdir(join(projectDir, 'revisions'));
        expect(revisionFiles.sort()).toEqual(['0.json', '1.json']);

        const rev0Text = await readFile(join(projectDir, 'revisions', '0.json'), 'utf8');
        const rev0Doc = JSON.parse(rev0Text);
        expect(rev0Doc.revision).toBe(0);
        expect(rev0Doc.graph.nodes).toHaveLength(0);

        const rev1Text = await readFile(join(projectDir, 'revisions', '1.json'), 'utf8');
        const rev1Doc = JSON.parse(rev1Text);
        expect(rev1Doc.revision).toBe(1);
        expect(rev1Doc.graph.nodes).toHaveLength(4);
        expect(rev1Doc.graph.nodes.find((n: any) => n.id === 'fn-simple')).not.toHaveProperty('inputs');
        expect(rev1Doc.graph.nodes.find((n: any) => n.id === 'fn-detail')).toHaveProperty('inputs');
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: Description-only and detailed functions both survive restart
  // =========================================================================
  describe('Acceptance Criterion 1: Description-only and detailed functions both survive restart', () => {
    it('description-only function survives restart without injected default fields or workflows', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-desc-survives-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({ name: 'SimpleFunctionTest' });

        const simpleFn: ProgramNode = {
          id: 'fn-echo',
          kind: 'function',
          name: 'echoMessage',
          description: 'Basic echo function taking arbitrary message',
          provenance: 'human',
          policy: 'editable',
          contract: 'export function echoMessage(): string',
          requiredChecks: [],
          instructions: '',
          outputPath: 'src/echo.ts',
          fields: [],
        };

        await store.updateSpec(p.id, 0, {
          schemaVersion: 1,
          nodes: [simpleFn],
          edges: [],
          requirements: [],
        });

        // Restart store
        const restartedStore = new ProjectStore(storeDir);
        const reloaded = await restartedStore.get(p.id);

        const loadedFn = reloaded.specification.nodes[0];
        expect(loadedFn.name).toBe('echoMessage');
        expect(loadedFn.description).toBe('Basic echo function taking arbitrary message');
        expect(loadedFn.inputs).toBeUndefined();
        expect(loadedFn.outputs).toBeUndefined();
        expect(loadedFn.rules).toBeUndefined();
        expect(loadedFn.errors).toBeUndefined();
        expect(loadedFn.scenarios).toBeUndefined();
        expect(isDescriptionOnlyFunction(loadedFn)).toBe(true);
        expect(isDetailedFunction(loadedFn)).toBe(false);
        expect(hasWorkflow(reloaded.specification, loadedFn.id)).toBe(false);
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });

    it('enriching a description-only function or removing a workflow preserves function validity and revision history', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-enrich-remove-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({ name: 'FunctionEvolution' });

        // Phase A: start as description-only
        const initialFn: ProgramNode = {
          id: 'fn-evolution',
          kind: 'function',
          name: 'processItem',
          description: 'Process an inventory item',
          provenance: 'human',
          policy: 'editable',
          contract: 'export function processItem(): void',
          requiredChecks: [],
          instructions: '',
          outputPath: 'src/item.ts',
          fields: [],
        };

        const spec0 = await store.updateSpec(p.id, 0, {
          schemaVersion: 1,
          nodes: [initialFn],
          edges: [],
          requirements: [],
        });
        expect(spec0.specRevision).toBe(1);

        // Phase B: enrich with contract, rules, scenarios, and workflow
        const enrichedFn: ProgramNode = {
          ...initialFn,
          contract: 'export function processItem(id: string): Promise<boolean>',
          inputs: 'id: string',
          outputs: 'Promise<boolean>',
          rules: 'Valid ID required',
          errors: 'ItemNotFoundError',
          scenarios: ['Given valid ID, returns true'],
        };

        const stepNode: ProgramNode = {
          id: 'step-ev-1',
          kind: 'step',
          stepType: 'call',
          parentId: 'fn-evolution',
          name: 'fetchItem',
          description: 'Fetch item from DB',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        const spec1 = await store.updateSpec(p.id, 1, {
          schemaVersion: 1,
          nodes: [enrichedFn, stepNode],
          edges: [],
          requirements: [],
        });
        expect(spec1.specRevision).toBe(2);

        // Phase C: remove workflow using removeFunctionWorkflow helper while retaining function contract and scenarios
        const { graph: cleanedGraph } = removeFunctionWorkflow(spec1.specification, 'fn-evolution');
        expect(cleanedGraph.nodes).toHaveLength(1);
        expect(cleanedGraph.nodes[0].id).toBe('fn-evolution');
        expect(cleanedGraph.nodes[0].inputs).toBe('id: string');
        expect(cleanedGraph.nodes[0].scenarios).toEqual(['Given valid ID, returns true']);
        expect(hasWorkflow(cleanedGraph, 'fn-evolution')).toBe(false);

        const spec2 = await store.updateSpec(p.id, 2, cleanedGraph);
        expect(spec2.specRevision).toBe(3);

        // Restart store and verify all 3 revisions in history
        const restarted = new ProjectStore(storeDir);
        const history = await restarted.history(p.id);

        expect(history).toHaveLength(4); // rev 0 (blank), rev 1 (desc only), rev 2 (detailed+workflow), rev 3 (detailed without workflow)
        expect(isDescriptionOnlyFunction(history[1].graph.nodes[0])).toBe(true);
        expect(isDetailedFunction(history[2].graph.nodes[0])).toBe(true);
        expect(hasWorkflow(history[2].graph, 'fn-evolution')).toBe(true);
        expect(isDetailedFunction(history[3].graph.nodes[0])).toBe(true);
        expect(hasWorkflow(history[3].graph, 'fn-evolution')).toBe(false);
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Human intent and layout remain separate
  // =========================================================================
  describe('Acceptance Criterion 2: Human intent and layout remain separate', () => {
    it('repositioning diagram nodes updates layoutRevision without changing specRevision or project.json hash', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-layout-sep-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({ name: 'LayoutSeparation' });

        const simpleFn: ProgramNode = {
          id: 'fn-a',
          kind: 'function',
          name: 'computeA',
          description: 'A simple compute function',
          provenance: 'human',
          policy: 'editable',
          contract: 'export function computeA(): number',
          requiredChecks: [],
          instructions: '',
          outputPath: 'src/a.ts',
          fields: [],
        };

        await store.updateSpec(p.id, 0, {
          schemaVersion: 1,
          nodes: [simpleFn],
          edges: [],
          requirements: [],
        });

        await store.updateLayout(p.id, { 'fn-a': { x: 50, y: 50 } });

        const projectJsonBefore = await readFile(join(store.projectDir(p.id), 'project.json'), 'utf8');
        const hashBefore = hash(projectJsonBefore);
        const historyBefore = await store.history(p.id);

        // Reposition node
        await store.updateLayout(p.id, { 'fn-a': { x: 250, y: 350 } });

        // Reload from fresh store
        const restarted = new ProjectStore(storeDir);
        const reloaded = await restarted.get(p.id);

        expect(reloaded.specRevision).toBe(1); // specRevision unchanged!
        expect(reloaded.layoutRevision).toBe(2); // layoutRevision incremented
        expect(reloaded.layout['fn-a']).toEqual({ x: 250, y: 350 });

        // project.json must be identical byte-for-byte
        const projectJsonAfter = await readFile(join(store.projectDir(p.id), 'project.json'), 'utf8');
        expect(projectJsonAfter).toBe(projectJsonBefore);
        expect(hash(projectJsonAfter)).toBe(hashBefore);

        // History count unchanged
        const historyAfter = await restarted.history(p.id);
        expect(historyAfter).toHaveLength(historyBefore.length);
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });

    it('deleting a node cleans up its layout entry without displacing surviving nodes across restart', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-delete-layout-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({ name: 'NodeDeleteLayout' });

        const nodeKeep: ProgramNode = {
          id: 'fn-keep',
          kind: 'function',
          name: 'survivingNode',
          description: 'Node that stays',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        const nodeDrop: ProgramNode = {
          id: 'fn-drop',
          kind: 'function',
          name: 'deletedNode',
          description: 'Node that will be removed',
          provenance: 'human',
          policy: 'editable',
          contract: '',
          requiredChecks: [],
          instructions: '',
          outputPath: '',
          fields: [],
        };

        await store.updateSpec(p.id, 0, {
          schemaVersion: 1,
          nodes: [nodeKeep, nodeDrop],
          edges: [],
          requirements: [],
        });

        await store.updateLayout(p.id, {
          'fn-keep': { x: 100, y: 200 },
          'fn-drop': { x: 400, y: 500 },
        });

        // Delete fn-drop in spec revision 2
        await store.updateSpec(p.id, 1, {
          schemaVersion: 1,
          nodes: [nodeKeep],
          edges: [],
          requirements: [],
        });

        // Restart store
        const restarted = new ProjectStore(storeDir);
        const reloaded = await restarted.get(p.id);

        expect(reloaded.specification.nodes).toHaveLength(1);
        expect(reloaded.layout['fn-keep']).toEqual({ x: 100, y: 200 });
        expect(reloaded.layout['fn-drop']).toBeUndefined();
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Portable export coverage is completed in the export task
  // =========================================================================
  describe('Acceptance Criterion 3: Portable export coverage is completed in the export task', () => {
    it('exports portable handoff package from the reloaded mixed-detail project with separate geometry and neutral instructions', async () => {
      const storeDir = await mkdtemp(join(tmpdir(), 'architect-t030-export-'));

      try {
        const store = new ProjectStore(storeDir);
        const p = await store.create({
          name: 'ExportValidationPlatform',
          description: 'Verifies portable export bundle on reloaded model',
          target: 'Electron desktop client',
        });

        const simpleFn: ProgramNode = {
          id: 'fn-simple',
          kind: 'function',
          name: 'getStatus',
          description: 'Simple status checker',
          provenance: 'human',
          policy: 'editable',
          contract: 'export function getStatus(): string',
          requiredChecks: [],
          instructions: '',
          outputPath: 'src/status.ts',
          fields: [],
        };

        const detailedFn: ProgramNode = {
          id: 'fn-detail',
          kind: 'function',
          name: 'processTransaction',
          description: 'Processes credit transaction',
          provenance: 'human',
          policy: 'sensitive',
          contract: 'export function processTransaction(amount: number): Promise<boolean>',
          inputs: 'amount: number',
          outputs: 'Promise<boolean>',
          rules: 'Amount must be positive',
          errors: 'NegativeAmountError',
          scenarios: ['Given 50, processes transaction'],
          requiredChecks: ['npm test'],
          instructions: 'Never log credit card credentials',
          outputPath: 'src/transaction.ts',
          fields: [],
        };

        const graph = GraphSchema.parse({
          nodes: [simpleFn, detailedFn],
          edges: [],
          requirements: [
            {
              id: 'req-security',
              text: 'Ensure strict confidentiality of transaction data',
              nodeIds: ['fn-detail'],
              edgeIds: [],
              constraints: ['Zero plain-text card numbers in logs'],
              scenarios: ['When transaction fails, sanitize error log'],
            },
          ],
        });

        await store.updateSpec(p.id, 0, graph);
        await store.updateLayout(p.id, {
          'fn-simple': { x: 10, y: 10 },
          'fn-detail': { x: 200, y: 200 },
        });

        // Restart and load project
        const restartedStore = new ProjectStore(storeDir);
        const reloaded = await restartedStore.get(p.id);

        // Generate portable export bundle
        const zipBytes = exportBundle(reloaded, 'Implement transaction processing', ['src/']);
        const files = unzipSync(zipBytes);

        expect(files['specification.json']).toBeDefined();
        expect(files['ARCHITECTURE.md']).toBeDefined();
        expect(files['AGENT_TASK.md']).toBeDefined();

        // specification.json: contains blueprint without layout coordinates or server directory paths
        const specJson = JSON.parse(strFromU8(files['specification.json']));
        expect(specJson.schemaVersion).toBe(1);
        expect(specJson.project.name).toBe('ExportValidationPlatform');
        expect(specJson.project.target).toBe('Electron desktop client');
        expect(specJson.graph.nodes).toHaveLength(2);
        expect(specJson.graph.requirements).toHaveLength(1);
        expect(strFromU8(files['specification.json'])).not.toContain(storeDir);

        const exportedSimple = specJson.graph.nodes.find((n: any) => n.id === 'fn-simple');
        expect(exportedSimple.name).toBe('getStatus');
        for (const f of ['inputs', 'outputs', 'rules', 'errors', 'scenarios']) {
          expect(exportedSimple).not.toHaveProperty(f);
        }

        const exportedDetailed = specJson.graph.nodes.find((n: any) => n.id === 'fn-detail');
        expect(exportedDetailed.name).toBe('processTransaction');
        expect(exportedDetailed.inputs).toBe('amount: number');
        expect(exportedDetailed.rules).toBe('Amount must be positive');
        expect(exportedDetailed.policy).toBe('sensitive');

        // ARCHITECTURE.md: documents both functions and requirements
        const archText = strFromU8(files['ARCHITECTURE.md']);
        expect(archText).toContain('getStatus (function)');
        expect(archText).toContain('processTransaction (function)');
        expect(archText).toContain('Policy: sensitive');
        expect(archText).toContain('Never log credit card credentials');
        expect(archText).toContain('Required checks: npm test');
        expect(archText).toContain('req-security');

        // AGENT_TASK.md: neutral instructions confirming missing details are unspecified
        const taskText = strFromU8(files['AGENT_TASK.md']);
        expect(taskText).toContain('Missing function details and workflows are unspecified; supplied details and scenarios do not prove implementation completeness.');
        expect(taskText).toContain('Target: Electron desktop client');
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // UI Component Integration Rendering
  // =========================================================================
  describe('UI Component Integration Rendering', () => {
    function createTestProject(): Project {
      const simpleFn: ProgramNode = {
        id: 'fn-ping',
        kind: 'function',
        name: 'pingService',
        description: 'Liveness ping probe',
        provenance: 'human',
        policy: 'editable',
        contract: 'export function pingService(): boolean',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/ping.ts',
        fields: [],
      };

      const detailedFn: ProgramNode = {
        id: 'fn-order',
        kind: 'function',
        name: 'fulfillOrder',
        description: 'Fulfills customer orders',
        provenance: 'human',
        policy: 'sensitive',
        contract: 'export function fulfillOrder(orderId: string): Promise<boolean>',
        inputs: 'orderId: string',
        outputs: 'Promise<boolean>',
        rules: 'OrderId must be valid UUID',
        errors: 'OrderNotFoundError',
        scenarios: ['Given orderId, marks order fulfilled'],
        requiredChecks: ['npm test'],
        instructions: 'Do not modify order fulfillment status without audit event',
        outputPath: 'src/order.ts',
        fields: [],
      };

      const stepNode: ProgramNode = {
        id: 'step-f1',
        kind: 'step',
        stepType: 'call',
        parentId: 'fn-order',
        name: 'saveStatus',
        description: 'Save order status to DB',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };

      return {
        id: 'test-project-1',
        name: 'UIJourneyWorkspace',
        description: 'Workspace rendering verification',
        target: 'Desktop application',
        root: '/workspace/test',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 1,
        specification: {
          schemaVersion: 1,
          nodes: [simpleFn, detailedFn, stepNode],
          edges: [],
          requirements: [],
        },
        layout: {
          'fn-ping': { x: 50, y: 50 },
          'fn-order': { x: 250, y: 50 },
        },
        layoutRevision: 1,
        scopedLayouts: {
          'function:fn-order': {
            'step-f1': { x: 10, y: 10 },
          },
        },
        checks: {},
      };
    }

    it('renders full App workspace shell with reloaded project and verifies all panels and badges', () => {
      const project = createTestProject();
      const html = renderToString(<App initialProject={project} autoLoad={false} />);

      expect(html).toContain('UIJourneyWorkspace');
      expect(html).toContain('project-name');
      expect(html).toContain('Desktop application');
      expect(html).toContain('data-testid="header-revision-badge"');
      expect(html).toContain('Rev 1');
      expect(html).toContain('pingService');
      expect(html).toContain('fulfillOrder');
    });

    it('renders PropertyInspector for description-only vs detailed function', () => {
      const project = createTestProject();

      // 1. Inspect description-only function
      const htmlSimple = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: 'fn-ping',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            graphContext: 'intended',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
        />
      );

      expect(htmlSimple).toContain('pingService');
      expect(htmlSimple).toContain('Liveness ping probe');
      expect(htmlSimple).toContain('export function pingService(): boolean');
      expect(htmlSimple).toContain('editable');

      // 2. Inspect detailed function
      const htmlDetailed = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: 'fn-order',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            graphContext: 'intended',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
        />
      );

      expect(htmlDetailed).toContain('fulfillOrder');
      expect(htmlDetailed).toContain('Fulfills customer orders');
      expect(htmlDetailed).toContain('orderId: string');
      expect(htmlDetailed).toContain('OrderId must be valid UUID');
      expect(htmlDetailed).toContain('OrderNotFoundError');
      expect(htmlDetailed).toContain('Given orderId, marks order fulfilled');
      expect(htmlDetailed).toContain('Do not modify order fulfillment status without audit event');
      expect(htmlDetailed).toContain('npm test');
      expect(htmlDetailed).toContain('sensitive');

      // 3. Verify FunctionEditor renders WORKFLOW_OPTIONAL_NOTICE
      const htmlFunctionEditor = renderToString(
        <FunctionEditor
          graph={project.specification}
          isOpen={true}
          selectedNodeId="fn-ping"
          onClose={() => {}}
        />
      );
      expect(htmlFunctionEditor).toContain(WORKFLOW_OPTIONAL_NOTICE);
    });

    it('renders WorkflowEditor for detailed function showing optional workflow banner and steps', () => {
      const project = createTestProject();

      const htmlWorkflow = renderToString(
        <WorkflowEditor
          graph={project.specification}
          isOpen={true}
          selectedFunctionId="fn-order"
          mode="modal"
          initialTab="steps"
          onClose={() => {}}
        />
      );

      expect(htmlWorkflow).toContain(WORKFLOW_OPTIONAL_BANNER);
      expect(htmlWorkflow).toContain('saveStatus');
      expect(htmlWorkflow).toContain('call');
      expect(htmlWorkflow).toContain('Save order status to DB');
    });

    it('renders RevisionHistory showing all manual specification revisions', () => {
      const project = createTestProject();
      const htmlHistory = renderToString(
        <RevisionHistory
          project={project}
          currentRevision={1}
          currentGraph={project.specification}
          revisions={[
            {
              schemaVersion: 1,
              revision: 0,
              createdAt: '2026-10-10T00:00:00Z',
              graph: emptyGraph(),
            },
            {
              schemaVersion: 1,
              revision: 1,
              createdAt: '2026-10-10T00:05:00Z',
              graph: project.specification,
            },
          ]}
          isOpen={true}
          onClose={() => {}}
        />
      );

      expect(htmlHistory).toContain('Specification Revisions');
      expect(htmlHistory).toContain('data-testid="revision-badge-0"');
      expect(htmlHistory).toContain('data-testid="revision-badge-1"');
      expect(htmlHistory).toContain('Current');
    });

    it('renders ProjectPicker allowing project selection and quick actions', () => {
      const project = createTestProject();

      const htmlPicker = renderToString(
        <ProjectPicker
          availableProjects={[project]}
          activeProjectId={project.id}
          isOpen={true}
          initialTab="list"
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
        />
      );

      expect(htmlPicker).toContain('UIJourneyWorkspace');
      expect(htmlPicker).toContain('Active');
      expect(htmlPicker).toContain('Desktop application');
    });
  });
});
