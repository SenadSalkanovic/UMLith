import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  FunctionEditor,
  createFunctionNode,
  updateFunctionNode,
  removeFunctionNode,
  addFunctionScenario,
  updateFunctionScenario,
  removeFunctionScenario,
  clearFunctionDetails,
  isDescriptionOnlyFunction,
  isDetailedFunction,
  hasWorkflow,
  getFunctionNodes,
  canNestInFunction,
  WORKFLOW_OPTIONAL_NOTICE,
  type CreateFunctionInput,
  type UpdateFunctionInput,
} from '../../src/components/FunctionEditor';
import { App } from '../../src/App';
import { Header } from '../../src/components/Header';
import { Canvas } from '../../src/components/Canvas';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import * as api from '../../src/api';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import {
  emptyGraph,
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

function createMixedFunctionGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'mod-billing',
      kind: 'module',
      name: 'BillingModule',
      description: 'Handles billing and payments',
      provenance: 'human',
      policy: 'editable',
      contract: 'export interface BillingModule {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/billing/index.ts',
      fields: [],
    },
    {
      id: 'fn-ping',
      kind: 'function',
      name: 'pingService',
      parentId: 'mod-billing',
      description: 'Simple health ping utility',
      provenance: 'human',
      policy: 'editable',
      contract: 'export function pingService(): boolean',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/billing/ping.ts',
      fields: [],
      // Description-only: inputs, outputs, rules, errors, scenarios are undefined
    },
    {
      id: 'fn-invoice',
      kind: 'function',
      name: 'generateInvoice',
      parentId: 'mod-billing',
      description: 'Generates monthly billing invoice for active subscriptions',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export function generateInvoice(accountId: string, period: BillingPeriod): Promise<Invoice>',
      inputs: 'accountId: string\nperiod: BillingPeriod\noptions?: InvoiceOptions',
      outputs: 'Promise<Invoice>\nResolves with persisted invoice record',
      rules: 'Must verify subscription status before generating\nInvoice amount must be non-negative\nMust log audit event',
      errors: 'AccountNotFoundError: Given account does not exist\nInactiveSubscriptionError: Subscription is canceled\nBillingFailedError: Tax calculation failure',
      scenarios: [
        'Given an active subscription\nWhen billing period ends\nThen generate invoice with tax and line items ✓',
        'When account has canceled subscription\nThen throw InactiveSubscriptionError without generating charge',
      ],
      requiredChecks: ['npm test'],
      instructions: 'Ensure decimal currency arithmetic is exact',
      outputPath: 'src/billing/invoice.ts',
      fields: [],
    },
  ];

  const edges: ProgramEdge[] = [
    {
      id: 'mod-contains-ping',
      source: 'mod-billing',
      target: 'fn-ping',
      kind: 'contains',
      label: '',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'mod-contains-invoice',
      source: 'mod-billing',
      target: 'fn-invoice',
      kind: 'contains',
      label: '',
      provenance: 'human',
      uncertain: false,
    },
  ];

  const requirements: Requirement[] = [
    {
      id: 'req-invoice-audit',
      text: 'Invoice generation must produce verifiable audit trail',
      nodeIds: ['fn-invoice'],
      edgeIds: [],
      constraints: ['ISO-27001 compliance'],
      scenarios: ['Given invoice generation\nThen audit log is written'],
    },
  ];

  return {
    schemaVersion: 1,
    nodes,
    edges,
    requirements,
  };
}

describe('T022 — Edit function descriptions and contracts', () => {
  // =========================================================================
  // Concrete Validation Scenario 1: Edit and reload one simple and one detailed function
  // =========================================================================
  describe('Concrete Scenario 1: Edit and reload one simple and one detailed function', () => {
    it('allows a simple description-only function and a detailed function to coexist in one project', () => {
      const graph = createMixedFunctionGraph();
      const validation = GraphSchema.safeParse(graph);
      expect(validation.success).toBe(true);

      const functions = getFunctionNodes(graph);
      expect(functions).toHaveLength(2);

      const simpleFn = functions.find(f => f.id === 'fn-ping')!;
      const detailedFn = functions.find(f => f.id === 'fn-invoice')!;

      expect(isDescriptionOnlyFunction(simpleFn)).toBe(true);
      expect(isDetailedFunction(simpleFn)).toBe(false);
      expect(simpleFn.inputs).toBeUndefined();
      expect(simpleFn.outputs).toBeUndefined();
      expect(simpleFn.rules).toBeUndefined();
      expect(simpleFn.errors).toBeUndefined();
      expect(simpleFn.scenarios).toBeUndefined();

      expect(isDetailedFunction(detailedFn)).toBe(true);
      expect(isDescriptionOnlyFunction(detailedFn)).toBe(false);
      expect(detailedFn.inputs).toContain('accountId: string');
      expect(detailedFn.outputs).toContain('Promise<Invoice>');
      expect(detailedFn.rules).toContain('Must verify subscription');
      expect(detailedFn.errors).toContain('AccountNotFoundError');
      expect(detailedFn.scenarios).toHaveLength(2);

      // Neither function has or needs workflow steps
      expect(hasWorkflow(graph, simpleFn.id)).toBe(false);
      expect(hasWorkflow(graph, detailedFn.id)).toBe(false);
    });

    it('edits both simple and detailed functions, preserving stable IDs and references', () => {
      const initialGraph = createMixedFunctionGraph();

      // 1. Edit the simple function without adding contract details (retaining description-only status)
      const { graph: afterSimpleEdit, node: updatedSimple } = updateFunctionNode(initialGraph, 'fn-ping', {
        description: 'Updated health check probe with timeout support\nSupports HTTP/2 ping',
        outputPath: 'src/billing/health.ts',
      });

      expect(updatedSimple.id).toBe('fn-ping'); // Stable identity
      expect(isDescriptionOnlyFunction(updatedSimple)).toBe(true);
      expect(updatedSimple.inputs).toBeUndefined();
      expect(updatedSimple.description).toContain('Supports HTTP/2 ping');

      // 2. Edit the detailed function: change inputs, outputs, rules, errors, scenarios, and contract
      const { graph: afterBothEdits, node: updatedDetailed } = updateFunctionNode(afterSimpleEdit, 'fn-invoice', {
        name: 'generateMonthlyInvoice',
        contract: 'export function generateMonthlyInvoice(accountId: string, period: BillingPeriod, dryRun?: boolean): Promise<InvoiceResult>',
        inputs: 'accountId: string\nperiod: BillingPeriod\ndryRun?: boolean // When true, computes without charging',
        outputs: 'Promise<InvoiceResult>\nContains computed charges and breakdown',
        rules: 'Must verify subscription\nMust handle prorated refunds\nDry run must skip payment gateway',
        errors: 'AccountNotFoundError: Unknown account\nGatewayTimeoutError: Payment processor did not respond\nInvalidTaxRateError: Tax zone unresolved',
        scenarios: [
          'Given active subscription with dryRun=true\nWhen generating monthly invoice\nThen return invoice preview without charging card',
          'Given active subscription with dryRun=false\nWhen generating monthly invoice\nThen bill card and mark invoice paid ✓',
          'When payment gateway times out\nThen retry once before raising GatewayTimeoutError',
        ],
      });

      expect(updatedDetailed.id).toBe('fn-invoice'); // Stable identity
      expect(updatedDetailed.name).toBe('generateMonthlyInvoice');
      expect(isDetailedFunction(updatedDetailed)).toBe(true);
      expect(updatedDetailed.inputs).toContain('dryRun?: boolean');
      expect(updatedDetailed.scenarios).toHaveLength(3);

      // Verify edges and requirements referencing fn-invoice are preserved
      expect(afterBothEdits.edges.some(e => e.target === 'fn-invoice')).toBe(true);
      expect(afterBothEdits.requirements.some(r => r.nodeIds.includes('fn-invoice'))).toBe(true);

      const validation = GraphSchema.safeParse(afterBothEdits);
      expect(validation.success).toBe(true);
    });

    it('persists and reloads one simple and one detailed function through ProjectStore on disk', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't022-reload-'));
      const store = new ProjectStore(dataDir);

      try {
        const initialGraph = createMixedFunctionGraph();
        const project = await store.create({
          name: 'Function Coexistence Project',
          target: 'Web application',
        });

        // Save initial graph containing both functions
        await store.updateSpec(project.id, 0, initialGraph);

        // Edit both functions
        let currentGraph = (await store.get(project.id))!.specification;
        const res1 = updateFunctionNode(currentGraph, 'fn-ping', {
          description: 'Refined probe description\nSecond line of simple spec',
        });
        const res2 = updateFunctionNode(res1.graph, 'fn-invoice', {
          inputs: 'accountId: string\ncurrency: CurrencyCode',
          outputs: 'Promise<InvoiceReceipt>',
          rules: 'Enforce strict idempotent processing',
          errors: 'CurrencyMismatchError: Mixed currencies not supported',
          scenarios: [
            'Given multi-currency account\nWhen billing currency matches\nThen process invoice successfully',
          ],
        });

        // Persist updated specification
        const updatedProj = await store.updateSpec(project.id, 1, res2.graph);
        expect(updatedProj.specRevision).toBe(2);

        // Reload project fresh from disk using a new ProjectStore instance
        const reloadedStore = new ProjectStore(dataDir);
        const reloadedProject = await reloadedStore.get(project.id);
        expect(reloadedProject).not.toBeNull();
        expect(reloadedProject!.specRevision).toBe(2);

        const reloadedGraph = reloadedProject!.specification;
        const reloadedFunctions = getFunctionNodes(reloadedGraph);
        expect(reloadedFunctions).toHaveLength(2);

        const reloadedSimple = reloadedFunctions.find(f => f.id === 'fn-ping')!;
        const reloadedDetailed = reloadedFunctions.find(f => f.id === 'fn-invoice')!;

        // Validate simple function survived reload
        expect(reloadedSimple.name).toBe('pingService');
        expect(reloadedSimple.description).toBe('Refined probe description\nSecond line of simple spec');
        expect(isDescriptionOnlyFunction(reloadedSimple)).toBe(true);
        expect(reloadedSimple.inputs).toBeUndefined();
        expect(reloadedSimple.outputs).toBeUndefined();
        expect(reloadedSimple.rules).toBeUndefined();
        expect(reloadedSimple.errors).toBeUndefined();
        expect(reloadedSimple.scenarios).toBeUndefined();

        // Validate detailed function survived reload
        expect(reloadedDetailed.name).toBe('generateInvoice');
        expect(isDetailedFunction(reloadedDetailed)).toBe(true);
        expect(reloadedDetailed.inputs).toBe('accountId: string\ncurrency: CurrencyCode');
        expect(reloadedDetailed.outputs).toBe('Promise<InvoiceReceipt>');
        expect(reloadedDetailed.rules).toBe('Enforce strict idempotent processing');
        expect(reloadedDetailed.errors).toBe('CurrencyMismatchError: Mixed currencies not supported');
        expect(reloadedDetailed.scenarios).toEqual([
          'Given multi-currency account\nWhen billing currency matches\nThen process invoice successfully',
        ]);

        // Validate no workflow was created or required
        expect(hasWorkflow(reloadedGraph, 'fn-ping')).toBe(false);
        expect(hasWorkflow(reloadedGraph, 'fn-invoice')).toBe(false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it('persists and reloads through Fastify API service end-to-end', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't022-api-'));
      const store = new ProjectStore(dataDir);
      const app = await createServer({ store, host: '127.0.0.1' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        const created = await api.createBlankProject(
          { name: 'Function API Test', target: 'Web application' },
          baseUrl
        );

        const initialGraph = createMixedFunctionGraph();
        const updated = await api.updateSpecification(created.id, 0, initialGraph, baseUrl);
        expect(updated.specRevision).toBe(1);

        // Edit via API
        const { graph: nextGraph } = updateFunctionNode(updated.specification, 'fn-ping', {
          description: 'Updated via API call',
        });
        const updated2 = await api.updateSpecification(created.id, 1, nextGraph, baseUrl);
        expect(updated2.specRevision).toBe(2);

        // Fetch project fresh
        const fetched = await api.getProject(created.id, baseUrl);
        const pingNode = fetched.specification.nodes.find(n => n.id === 'fn-ping')!;
        expect(pingNode.description).toBe('Updated via API call');
        expect(isDescriptionOnlyFunction(pingNode)).toBe(true);
      } finally {
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Add several acceptance scenarios and multiline errors
  // =========================================================================
  describe('Concrete Scenario 2: Add several acceptance scenarios and multiline errors', () => {
    it('adds several acceptance scenarios and multiline errors preserving exact formatting', () => {
      let graph = createMixedFunctionGraph();

      // Add multiline error specification with detailed error codes and descriptions
      const multilineErrors = [
        'PaymentGatewayError: Upstream payment processor returned 502 Bad Gateway',
        '  Code: PG_502_BAD_GATEWAY',
        '  Transient: true · Retryable after 5 seconds',
        'InsufficientFundsError: Account balance is below required threshold',
        '  Code: ACC_402_INSUFFICIENT_FUNDS',
        '  Transient: false · Requires user replenishment',
        'TaxCalculationError: Tax jurisdiction could not be determined for postal code "71000"',
        '  Code: TAX_422_UNRESOLVED_JURISDICTION',
      ].join('\n');

      const multilineRules = [
        '1. Transaction must be idempotent using idempotencyKey.',
        '2. Audit logs must capture (timestamp, actorId, amount, currency, status).',
        '   Preserve Unicode currency symbol: € / $ / KM ✓.',
        '3. If payment processor fails, write failure journal entry before exiting.',
      ].join('\n');

      // Update function with multiline errors and rules
      const { graph: g1, node: n1 } = updateFunctionNode(graph, 'fn-invoice', {
        errors: multilineErrors,
        rules: multilineRules,
      });
      graph = g1;

      expect(n1.errors).toBe(multilineErrors);
      expect(n1.rules).toBe(multilineRules);

      // Add several acceptance scenarios one by one
      const scenario1 = [
        'Given a verified customer account with €150.00 balance',
        'When monthly recurring billing cycle triggers',
        'Then deduct €150.00 and issue receipt with stamp č, ć, ž, š, đ ✓',
      ].join('\n');

      const scenario2 = [
        'Given a customer with expired credit card',
        'When recurring billing attempts charge',
        'Then record InsufficientFundsError',
        '  And dispatch notification email to customer within 60 seconds',
      ].join('\n');

      const scenario3 = [
        'Given network partition between billing and payment gateway',
        'When transaction is in-flight',
        'Then abort after 3 retries and preserve failure journal entry',
      ].join('\n');

      const { graph: g2 } = addFunctionScenario(graph, 'fn-invoice', scenario1);
      const { graph: g3 } = addFunctionScenario(g2, 'fn-invoice', scenario2);
      const { graph: g4, node: n4 } = addFunctionScenario(g3, 'fn-invoice', scenario3);
      graph = g4;

      // Originally had 2 scenarios, now has 2 + 3 = 5 scenarios
      expect(n4.scenarios).toHaveLength(5);
      expect(n4.scenarios![2]).toBe(scenario1);
      expect(n4.scenarios![3]).toBe(scenario2);
      expect(n4.scenarios![4]).toBe(scenario3);

      // Validate graph schema passes
      const validation = GraphSchema.safeParse(graph);
      expect(validation.success).toBe(true);
    });

    it('allows updating, reordering, and deleting scenarios', () => {
      let graph = createMixedFunctionGraph();

      // Add a scenario
      const { graph: g1 } = addFunctionScenario(graph, 'fn-invoice', 'Temporary scenario to be edited');

      // Update scenario at index 2
      const updatedText = 'Updated scenario text with newline\nThen succeed';
      const { graph: g2, node: n2 } = updateFunctionScenario(g1, 'fn-invoice', 2, updatedText);
      expect(n2.scenarios![2]).toBe(updatedText);

      // Remove scenario at index 1
      const { graph: g3, node: n3 } = removeFunctionScenario(g2, 'fn-invoice', 1);
      expect(n3.scenarios).toHaveLength(2);
      expect(n3.scenarios![1]).toBe(updatedText);

      // Verify validation
      expect(GraphSchema.safeParse(g3).success).toBe(true);
    });

    it('survives disk persistence and reload with multiline errors and acceptance scenarios intact', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't022-multiline-'));
      const store = new ProjectStore(dataDir);

      try {
        const project = await store.create({ name: 'Multiline Test Project' });
        let graph = createMixedFunctionGraph();

        const multilineErrors = 'Err1: Description\n  Indented line 1\n  Indented line 2\nErr2: Second error';
        const multilineScenarios = [
          'Scenario A:\n  Given condition\n  When action\n  Then verify č, ✓',
          'Scenario B:\n  When error occurs\n  Then rollback',
        ];

        const { graph: updatedGraph } = updateFunctionNode(graph, 'fn-invoice', {
          errors: multilineErrors,
          scenarios: multilineScenarios,
        });

        await store.updateSpec(project.id, 0, updatedGraph);

        // Reload from disk
        const reloadedStore = new ProjectStore(dataDir);
        const reloadedProj = await reloadedStore.get(project.id);
        const reloadedInvoice = reloadedProj!.specification.nodes.find(n => n.id === 'fn-invoice')!;

        expect(reloadedInvoice.errors).toBe(multilineErrors);
        expect(reloadedInvoice.scenarios).toEqual(multilineScenarios);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: All specified fields are editable and persistent
  // =========================================================================
  describe('Acceptance Criterion 1: All specified fields are editable and persistent', () => {
    it('creates a function with every field populated and validates graph schema', () => {
      const baseGraph = createMixedFunctionGraph();
      const input: CreateFunctionInput = {
        name: 'validatePayment',
        parentId: 'mod-billing',
        description: 'Validates raw payment card details\nPCI-DSS compliant check',
        contract: 'export function validatePayment(card: CardData): ValidationResult',
        inputs: 'card: CardData\noptions: ValidationOptions',
        outputs: 'ValidationResult\nContains validity status and masked card info',
        rules: 'Never store plain CVV\nCard number must pass Luhn algorithm check',
        errors: 'InvalidLuhnError: Card number failed checksum\nExpiredCardError: Expiry date is in the past',
        scenarios: [
          'Given card with valid Luhn checksum\nWhen validated\nThen return valid status',
          'Given card with invalid checksum\nWhen validated\nThen return InvalidLuhnError',
        ],
        policy: 'sensitive',
        outputPath: 'src/billing/validate.ts',
        requiredChecks: ['npm test', 'npm run lint'],
        instructions: 'Do not log PAN or CVV under any circumstances',
      };

      const { graph: newGraph, node } = createFunctionNode(baseGraph, input);
      expect(node.id).toBeDefined();
      expect(node.name).toBe('validatePayment');
      expect(node.parentId).toBe('mod-billing');
      expect(node.policy).toBe('sensitive');
      expect(node.requiredChecks).toEqual(['npm test', 'npm run lint']);
      expect(node.instructions).toContain('Do not log PAN');
      expect(node.inputs).toContain('card: CardData');
      expect(node.outputs).toContain('ValidationResult');
      expect(node.rules).toContain('Never store plain CVV');
      expect(node.errors).toContain('InvalidLuhnError');
      expect(node.scenarios).toHaveLength(2);

      const validation = GraphSchema.safeParse(newGraph);
      expect(validation.success).toBe(true);
    });

    it('allows clearing incomplete details and turning a detailed function into a description-only function', () => {
      const graph = createMixedFunctionGraph();
      const detailedNode = graph.nodes.find(n => n.id === 'fn-invoice')!;
      expect(isDetailedFunction(detailedNode)).toBe(true);

      const { graph: clearedGraph, node: clearedNode } = clearFunctionDetails(graph, 'fn-invoice');

      expect(clearedNode.id).toBe('fn-invoice'); // Preserves identity
      expect(clearedNode.name).toBe('generateInvoice');
      expect(clearedNode.description).toBe(detailedNode.description); // Retains description
      expect(isDescriptionOnlyFunction(clearedNode)).toBe(true);
      expect(clearedNode.inputs).toBeUndefined();
      expect(clearedNode.outputs).toBeUndefined();
      expect(clearedNode.rules).toBeUndefined();
      expect(clearedNode.errors).toBeUndefined();
      expect(clearedNode.scenarios).toBeUndefined();

      expect(GraphSchema.safeParse(clearedGraph).success).toBe(true);
    });

    it('allows partial/incomplete details without forcing all fields to be populated', () => {
      const graph = createMixedFunctionGraph();

      // Create function with description and inputs only; outputs, rules, errors, scenarios omitted
      const { graph: partialGraph, node: partialNode } = createFunctionNode(graph, {
        name: 'calculateTax',
        parentId: 'mod-billing',
        description: 'Calculates sales tax',
        inputs: 'subtotal: number\npostalCode: string',
      });

      expect(partialNode.inputs).toBe('subtotal: number\npostalCode: string');
      expect(partialNode.outputs).toBeUndefined();
      expect(partialNode.rules).toBeUndefined();
      expect(partialNode.errors).toBeUndefined();
      expect(partialNode.scenarios).toBeUndefined();

      expect(GraphSchema.safeParse(partialGraph).success).toBe(true);
    });

    it('removes a function node, cleaning incident edges and preserving requirements', () => {
      const graph = createMixedFunctionGraph();
      const { graph: afterRemoval, removedNode } = removeFunctionNode(graph, 'fn-invoice');

      expect(removedNode.id).toBe('fn-invoice');
      expect(afterRemoval.nodes.some(n => n.id === 'fn-invoice')).toBe(false);
      expect(afterRemoval.edges.some(e => e.target === 'fn-invoice')).toBe(false);

      // Requirement still exists, but fn-invoice is pruned from nodeIds
      const req = afterRemoval.requirements.find(r => r.id === 'req-invoice-audit')!;
      expect(req).toBeDefined();
      expect(req.nodeIds).not.toContain('fn-invoice');

      expect(GraphSchema.safeParse(afterRemoval).success).toBe(true);
    });

    it('rejects invalid inputs such as blank name, non-existent parent, or invalid nesting', () => {
      const graph = createMixedFunctionGraph();

      expect(() => createFunctionNode(graph, { name: '' })).toThrow(/Function name must not be blank/i);
      expect(() => createFunctionNode(graph, { name: 'fn', parentId: 'non-existent' })).toThrow(/Parent node does not exist/i);

      expect(() => updateFunctionNode(graph, 'fn-ping', { name: '' })).toThrow(/Function name must not be blank/i);
      expect(() => updateFunctionNode(graph, 'fn-ping', { parentId: 'fn-ping' })).toThrow(/cannot be its own parent/i);
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: A workflow is never mandatory
  // =========================================================================
  describe('Acceptance Criterion 2: A workflow is never mandatory', () => {
    it('validates that neither description-only nor detailed functions require workflow steps', () => {
      const graph = createMixedFunctionGraph();

      // Check step nodes count
      const stepNodes = graph.nodes.filter(n => n.kind === 'step');
      expect(stepNodes).toHaveLength(0);

      // Both functions validate without any step nodes
      const validation = GraphSchema.safeParse(graph);
      expect(validation.success).toBe(true);

      const functions = getFunctionNodes(graph);
      functions.forEach(fn => {
        expect(hasWorkflow(graph, fn.id)).toBe(false);
      });
    });

    it('exports WORKFLOW_OPTIONAL_NOTICE confirming workflow is optional', () => {
      expect(WORKFLOW_OPTIONAL_NOTICE).toContain('workflow is never mandatory');
    });

    it('validates containment rules allow nesting functions in system, module, class, interface, and function', () => {
      expect(canNestInFunction('system')).toBe(true);
      expect(canNestInFunction('module')).toBe(true);
      expect(canNestInFunction('class')).toBe(true);
      expect(canNestInFunction('interface')).toBe(true);
      expect(canNestInFunction('function')).toBe(true);
      expect(canNestInFunction('entity')).toBe(false);
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Details survive project reload
  // =========================================================================
  describe('Acceptance Criterion 3: Details survive project reload', () => {
    it('round-trips specification losslessly across JSON serialization/deserialization', () => {
      const graph = createMixedFunctionGraph();
      const serialized = JSON.stringify(graph);
      const deserialized = JSON.parse(serialized);

      const parsed = GraphSchema.parse(deserialized);
      expect(parsed.nodes).toHaveLength(graph.nodes.length);
      expect(parsed.edges).toHaveLength(graph.edges.length);
      expect(parsed.requirements).toHaveLength(graph.requirements.length);

      const detailedOriginal = graph.nodes.find(n => n.id === 'fn-invoice')!;
      const detailedRestored = parsed.nodes.find(n => n.id === 'fn-invoice')!;

      expect(detailedRestored.name).toBe(detailedOriginal.name);
      expect(detailedRestored.contract).toBe(detailedOriginal.contract);
      expect(detailedRestored.inputs).toBe(detailedOriginal.inputs);
      expect(detailedRestored.outputs).toBe(detailedOriginal.outputs);
      expect(detailedRestored.rules).toBe(detailedOriginal.rules);
      expect(detailedRestored.errors).toBe(detailedOriginal.errors);
      expect(detailedRestored.scenarios).toEqual(detailedOriginal.scenarios);
    });
  });

  // =========================================================================
  // UI Component & Integration Tests
  // =========================================================================
  describe('UI Component & Integration Tests', () => {
    it('renders FunctionEditor modal with all tabs and badges', () => {
      const graph = createMixedFunctionGraph();

      const html = renderToString(
        <FunctionEditor
          graph={graph}
          isOpen={true}
          selectedNodeId="fn-invoice"
          initialTab="details"
          mode="modal"
        />
      );

      expect(html).toContain('data-testid="function-editor-modal"');
      expect(html).toContain('data-testid="workflow-optional-notice"');
      expect(html).toContain('data-testid="function-tab-details"');
      expect(html).toContain('data-testid="function-tab-contract"');
      expect(html).toContain('data-testid="function-tab-scenarios"');
      expect(html).toContain('data-testid="function-tab-add"');
      expect(html).toContain('data-testid="badge-detailed"');
      expect(html).toContain('data-testid="badge-workflow-status"');
      expect(html).toContain('data-testid="function-name-input"');
      expect(html).toContain('data-testid="function-contract-input"');
      expect(html).toContain('data-testid="function-description-input"');
      expect(html).toContain('data-testid="function-save-btn"');
    });

    it('renders FunctionEditor contract pane with multiline inputs, outputs, rules, errors', () => {
      const graph = createMixedFunctionGraph();

      const html = renderToString(
        <FunctionEditor
          graph={graph}
          isOpen={true}
          selectedNodeId="fn-invoice"
          initialTab="contract"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-contract"');
      expect(html).toContain('data-testid="function-inputs-input"');
      expect(html).toContain('data-testid="function-outputs-input"');
      expect(html).toContain('data-testid="function-rules-input"');
      expect(html).toContain('data-testid="function-errors-input"');
      expect(html).toContain('data-testid="function-contract-save-btn"');
    });

    it('renders FunctionEditor scenarios pane with acceptance scenario cards', () => {
      const graph = createMixedFunctionGraph();

      const html = renderToString(
        <FunctionEditor
          graph={graph}
          isOpen={true}
          selectedNodeId="fn-invoice"
          initialTab="scenarios"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-scenarios"');
      expect(html).toContain('data-testid="scenarios-list"');
      expect(html).toContain('data-testid="scenario-card-0"');
      expect(html).toContain('data-testid="scenario-card-1"');
      expect(html).toContain('data-testid="new-scenario-textarea"');
      expect(html).toContain('data-testid="add-scenario-btn"');
    });

    it('renders FunctionEditor add pane with description-only vs detailed toggle', () => {
      const graph = createMixedFunctionGraph();

      const html = renderToString(
        <FunctionEditor
          graph={graph}
          isOpen={true}
          initialTab="add"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-add"');
      expect(html).toContain('data-testid="add-function-name-input"');
      expect(html).toContain('data-testid="add-function-detailed-toggle"');
      expect(html).toContain('data-testid="create-function-submit-btn"');
    });

    it('renders Header with Functions button', () => {
      const html = renderToString(
        <Header
          project={{
            id: 'proj-1',
            name: 'Test Project',
            target: 'Web application',
            root: '/test',
            specRevision: 1,
            checks: {},
          } as any}
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
          onOpenErEditor={() => {}}
          onOpenFunctionEditor={() => {}}
        />
      );

      expect(html).toContain('data-testid="header-open-functions"');
      expect(html).toContain('Functions');
    });

    it('renders PropertyInspector with Edit Function button and displays contract fields', () => {
      const graph = createMixedFunctionGraph();

      const html = renderToString(
        <PropertyInspector
          project={null}
          graph={graph}
          viewState={{
            selectedId: 'fn-invoice',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onEditNode={() => {}}
          onEditFunctionNode={() => {}}
        />
      );

      expect(html).toContain('data-testid="inspector-edit-function-node"');
      expect(html).toContain('Edit Function');
      expect(html).toContain('Inputs');
      expect(html).toContain('Outputs');
      expect(html).toContain('Rules');
      expect(html).toContain('Errors');
      expect(html).toContain('Scenarios');
      expect(html).toContain('multiline-text');
    });

    it('renders full App shell with FunctionEditor modal integrated', () => {
      const graph = createMixedFunctionGraph();
      const project: Project = {
        id: 'proj-full',
        name: 'Full Workspace Test',
        description: 'Testing full workspace shell',
        target: 'Web application',
        root: '/test',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 1,
        specification: graph,
        layout: {},
        checks: {},
      };

      const html = renderToString(<App initialProject={project} autoLoad={false} />);

      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="header-open-functions"');
    });
  });
});
