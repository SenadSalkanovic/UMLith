import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  WorkflowEditor,
  createWorkflowStep,
  updateWorkflowStep,
  removeWorkflowStep,
  connectWorkflowSteps,
  removeWorkflowEdge,
  removeFunctionWorkflow,
  validateWorkflowConnection,
  findOwningFunction,
  isStepOwnedByFunction,
  getFunctionWorkflowSteps,
  getFunctionWorkflowEdges,
  buildLoopWithConditionAndReturn,
  WORKFLOW_OPTIONAL_BANNER,
  STEP_TYPES,
  WORKFLOW_EDGE_KINDS,
  type CreateWorkflowStepInput,
  type UpdateWorkflowStepInput,
  type ConnectWorkflowStepsInput,
} from '../../src/components/WorkflowEditor';
import {
  FunctionEditor,
  createFunctionNode,
  isDescriptionOnlyFunction,
  isDetailedFunction,
} from '../../src/components/FunctionEditor';
import { App } from '../../src/App';
import { Header } from '../../src/components/Header';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { Canvas } from '../../src/components/Canvas';
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

function createBaseGraph(): Graph {
  const nodes: ProgramNode[] = [
    {
      id: 'mod-core',
      kind: 'module',
      name: 'CoreModule',
      description: 'Core system logic',
      provenance: 'human',
      policy: 'editable',
      contract: 'export interface CoreModule {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/core/index.ts',
      fields: [],
    },
    {
      id: 'fn-simple',
      kind: 'function',
      name: 'simplePing',
      parentId: 'mod-core',
      description: 'A description-only health ping function',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/core/ping.ts',
      fields: [],
    },
    {
      id: 'fn-orders',
      kind: 'function',
      name: 'processOrders',
      parentId: 'mod-core',
      description: 'Processes incoming customer orders in batches',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export function processOrders(orders: Order[]): Promise<BatchResult>',
      inputs: 'orders: Order[]',
      outputs: 'Promise<BatchResult>',
      rules: 'Atomic execution\nAudit trail required',
      errors: 'ValidationError: Invalid order payload\nPaymentFailedError: Payment declined',
      scenarios: [
        'Given 3 valid orders, when batch is processed, returns 3 successful transactions',
        'When payment is declined, rolls back and throws PaymentFailedError',
      ],
      requiredChecks: ['npm test'],
      instructions: 'Maintain decimal precision on money math',
      outputPath: 'src/core/orders.ts',
      fields: [],
    },
  ];

  const edges: ProgramEdge[] = [
    {
      id: 'mod-contains-simple',
      source: 'mod-core',
      target: 'fn-simple',
      kind: 'contains',
      label: '',
      provenance: 'human',
      uncertain: false,
    },
    {
      id: 'mod-contains-orders',
      source: 'mod-core',
      target: 'fn-orders',
      kind: 'contains',
      label: '',
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

describe('T023 — Edit Optional Function Workflows', () => {
  describe('Acceptance Criterion 1: All required workflow kinds are editable', () => {
    it('creates and edits every supported step kind (operation, call, condition, loop, try, throw, return, opaque)', () => {
      let graph = createBaseGraph();
      const createdSteps: ProgramNode[] = [];

      for (const stepType of STEP_TYPES) {
        const input: CreateWorkflowStepInput = {
          functionId: 'fn-orders',
          name: `Step_${stepType}`,
          stepType,
          description: `Testing step type ${stepType}`,
          policy: 'editable',
          instructions: `Instruction for ${stepType}`,
          requiredChecks: ['npm test'],
        };

        if (stepType === 'opaque') {
          input.source = {
            path: 'src/core/orders.ts',
            line: 42,
            start: 100,
            end: 250,
            hash: 'hash-abc-123',
            revision: 'rev-001',
          };
        }

        const res = createWorkflowStep(graph, input);
        graph = res.graph;
        createdSteps.push(res.node);

        expect(res.node.stepType).toBe(stepType);
        expect(res.node.kind).toBe('step');
        expect(res.node.parentId).toBe('fn-orders');
      }

      expect(createdSteps.length).toBe(STEP_TYPES.length);
      expect(getFunctionWorkflowSteps(graph, 'fn-orders').length).toBe(STEP_TYPES.length);
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Now edit/update steps
      for (const step of createdSteps) {
        const updated = updateWorkflowStep(graph, step.id, {
          name: `${step.name}_Renamed`,
          description: `Updated description for ${step.stepType}`,
          policy: 'sensitive',
          instructions: 'New instructions',
        });
        graph = updated.graph;

        expect(updated.node.name).toBe(`${step.name}_Renamed`);
        expect(updated.node.description).toBe(`Updated description for ${step.stepType}`);
        expect(updated.node.policy).toBe('sensitive');
        expect(updated.node.id).toBe(step.id); // Stable ID preserved
      }

      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Delete one step and ensure graph remains valid
      const stepToDelete = createdSteps[0];
      const afterDel = removeWorkflowStep(graph, stepToDelete.id);
      graph = afterDel.graph;

      expect(graph.nodes.some(n => n.id === stepToDelete.id)).toBe(false);
      expect(getFunctionWorkflowSteps(graph, 'fn-orders').length).toBe(STEP_TYPES.length - 1);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('supports nested workflow steps (e.g., steps inside loop or try containers)', () => {
      let graph = createBaseGraph();

      // Create a loop step
      const loopRes = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'OrderLoop',
        stepType: 'loop',
      });
      graph = loopRes.graph;

      // Create a step nested inside the loop step
      const childRes = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        parentStepId: loopRes.node.id,
        name: 'CheckStock',
        stepType: 'condition',
      });
      graph = childRes.graph;

      expect(childRes.node.parentId).toBe(loopRes.node.id);
      expect(findOwningFunction(graph, childRes.node.id)?.id).toBe('fn-orders');
      expect(isStepOwnedByFunction(graph, childRes.node.id, 'fn-orders')).toBe(true);
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Removing the parent loop step recursively removes the nested child step
      const delRes = removeWorkflowStep(graph, loopRes.node.id);
      graph = delRes.graph;

      expect(graph.nodes.some(n => n.id === loopRes.node.id)).toBe(false);
      expect(graph.nodes.some(n => n.id === childRes.node.id)).toBe(false);
      expect(delRes.removedDescendantsCount).toBe(1);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('creates and connects workflow transitions: next, true, false, and exception', () => {
      let graph = createBaseGraph();

      const tryStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'TryBlock',
        stepType: 'try',
      });
      graph = tryStep.graph;

      const callStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'CallPayment',
        stepType: 'call',
      });
      graph = callStep.graph;

      const throwStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'ThrowError',
        stepType: 'throw',
      });
      graph = throwStep.graph;

      const returnStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'ReturnOk',
        stepType: 'return',
      });
      graph = returnStep.graph;

      // Connect: TryBlock -> CallPayment (next)
      const e1 = connectWorkflowSteps(graph, {
        sourceId: tryStep.node.id,
        targetId: callStep.node.id,
        kind: 'next',
        label: 'execute payment',
      });
      graph = e1.graph;

      // Connect: TryBlock -> ThrowError (exception)
      const e2 = connectWorkflowSteps(graph, {
        sourceId: tryStep.node.id,
        targetId: throwStep.node.id,
        kind: 'exception',
        label: 'on PaymentError',
      });
      graph = e2.graph;

      // Connect: CallPayment -> ReturnOk (next)
      const e3 = connectWorkflowSteps(graph, {
        sourceId: callStep.node.id,
        targetId: returnStep.node.id,
        kind: 'next',
        label: 'payment succeeded',
      });
      graph = e3.graph;

      expect(getFunctionWorkflowEdges(graph, 'fn-orders').length).toBe(3);
      expect(e1.edge.kind).toBe('next');
      expect(e2.edge.kind).toBe('exception');
      expect(e2.edge.label).toBe('on PaymentError');
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Remove an edge
      const edgeDel = removeWorkflowEdge(graph, e2.edge.id);
      graph = edgeDel.graph;
      expect(getFunctionWorkflowEdges(graph, 'fn-orders').length).toBe(2);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });
  });

  describe('Acceptance Criterion 2: Description-only functions remain valid', () => {
    it('verifies that a function without workflow steps is completely valid as description-only', () => {
      const graph = createBaseGraph();
      const simpleFn = graph.nodes.find(n => n.id === 'fn-simple')!;

      expect(isDescriptionOnlyFunction(simpleFn)).toBe(true);
      expect(isDetailedFunction(simpleFn)).toBe(false);
      expect(getFunctionWorkflowSteps(graph, 'fn-simple').length).toBe(0);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });

    it('allows attaching workflow steps to a description-only function and retains validity', () => {
      let graph = createBaseGraph();

      const step = createWorkflowStep(graph, {
        functionId: 'fn-simple',
        name: 'PingOperation',
        stepType: 'operation',
        description: 'Send ICMP packet',
      });
      graph = step.graph;

      expect(getFunctionWorkflowSteps(graph, 'fn-simple').length).toBe(1);
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Remove the workflow step again
      const removed = removeWorkflowStep(graph, step.node.id);
      graph = removed.graph;

      expect(getFunctionWorkflowSteps(graph, 'fn-simple').length).toBe(0);
      const restoredFn = graph.nodes.find(n => n.id === 'fn-simple')!;
      expect(isDescriptionOnlyFunction(restoredFn)).toBe(true);
      expect(GraphSchema.safeParse(graph).success).toBe(true);
    });
  });

  describe('Acceptance Criterion 3: Graph validation blocks invalid ownership and endpoints', () => {
    it('blocks creating a workflow step with an invalid or non-function parent', () => {
      const graph = createBaseGraph();

      // Non-existent function
      expect(() =>
        createWorkflowStep(graph, {
          functionId: 'non-existent-fn',
          name: 'InvalidStep',
          stepType: 'operation',
        })
      ).toThrow(/Owning function not found/);

      // Module instead of function
      expect(() =>
        createWorkflowStep(graph, {
          functionId: 'mod-core',
          name: 'InvalidStep',
          stepType: 'operation',
        })
      ).toThrow(/is not a function/);
    });

    it('blocks creating an opaque step without complete source evidence', () => {
      const graph = createBaseGraph();

      expect(() =>
        createWorkflowStep(graph, {
          functionId: 'fn-orders',
          name: 'OpaqueStepWithoutSource',
          stepType: 'opaque',
        })
      ).toThrow(/Opaque steps require source evidence/);

      expect(() =>
        createWorkflowStep(graph, {
          functionId: 'fn-orders',
          name: 'OpaqueStepWithEmptyPath',
          stepType: 'opaque',
          source: {
            path: '   ',
            line: 1,
            start: 0,
            end: 10,
            hash: 'hash-1',
            revision: 'rev-1',
          },
        })
      ).toThrow(/Opaque step source path must not be blank/);
    });

    it('blocks workflow transitions connecting steps across different owning functions', () => {
      let graph = createBaseGraph();

      // Step in fn-simple
      const sSimple = createWorkflowStep(graph, {
        functionId: 'fn-simple',
        name: 'StepInSimple',
        stepType: 'operation',
      });
      graph = sSimple.graph;

      // Step in fn-orders
      const sOrders = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'StepInOrders',
        stepType: 'operation',
      });
      graph = sOrders.graph;

      const check = validateWorkflowConnection(graph, sSimple.node.id, sOrders.node.id, 'next');
      expect(check.valid).toBe(false);
      expect(check.error).toContain('Workflow flow must stay within the same owning function');

      expect(() =>
        connectWorkflowSteps(graph, {
          sourceId: sSimple.node.id,
          targetId: sOrders.node.id,
          kind: 'next',
        })
      ).toThrow(/Workflow flow must stay within the same owning function/);
    });

    it('blocks invalid branch kinds originating from non-condition/loop steps', () => {
      let graph = createBaseGraph();

      const opStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'OpStep',
        stepType: 'operation',
      });
      graph = opStep.graph;

      const retStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'RetStep',
        stepType: 'return',
      });
      graph = retStep.graph;

      const checkTrue = validateWorkflowConnection(graph, opStep.node.id, retStep.node.id, 'true');
      expect(checkTrue.valid).toBe(false);
      expect(checkTrue.error).toContain('A "true" branch must originate at a condition or loop');

      expect(() =>
        connectWorkflowSteps(graph, {
          sourceId: opStep.node.id,
          targetId: retStep.node.id,
          kind: 'true',
        })
      ).toThrow(/A "true" branch must originate at a condition or loop/);
    });

    it('blocks duplicate true/false branches originating from the same condition step', () => {
      let graph = createBaseGraph();

      const condStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'CheckStatus',
        stepType: 'condition',
      });
      graph = condStep.graph;

      const target1 = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'Target1',
        stepType: 'call',
      });
      graph = target1.graph;

      const target2 = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'Target2',
        stepType: 'call',
      });
      graph = target2.graph;

      // First true branch is allowed
      const conn1 = connectWorkflowSteps(graph, {
        sourceId: condStep.node.id,
        targetId: target1.node.id,
        kind: 'true',
      });
      graph = conn1.graph;

      // Duplicate true branch must be rejected
      const checkDup = validateWorkflowConnection(graph, condStep.node.id, target2.node.id, 'true');
      expect(checkDup.valid).toBe(false);
      expect(checkDup.error).toContain('Duplicate "true" branch');

      expect(() =>
        connectWorkflowSteps(graph, {
          sourceId: condStep.node.id,
          targetId: target2.node.id,
          kind: 'true',
        })
      ).toThrow(/Duplicate "true" branch/);
    });

    it('blocks next transitions continuing from return or throw steps', () => {
      let graph = createBaseGraph();

      const retStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'FinishReturn',
        stepType: 'return',
      });
      graph = retStep.graph;

      const nextStep = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'UnreachableStep',
        stepType: 'operation',
      });
      graph = nextStep.graph;

      const checkRet = validateWorkflowConnection(graph, retStep.node.id, nextStep.node.id, 'next');
      expect(checkRet.valid).toBe(false);
      expect(checkRet.error).toContain('Return and throw steps cannot continue with next');

      expect(() =>
        connectWorkflowSteps(graph, {
          sourceId: retStep.node.id,
          targetId: nextStep.node.id,
          kind: 'next',
        })
      ).toThrow(/Return and throw steps cannot continue with next/);
    });
  });

  describe('Concrete Validation Scenario 1: Draw a loop, conditional call, and return', () => {
    it('draws a complete control-flow graph containing a loop, conditional call, loop back-edge cycle, and return', () => {
      const baseGraph = createBaseGraph();

      const result = buildLoopWithConditionAndReturn(baseGraph, 'fn-orders', {
        loopName: 'ForEachCustomerOrder',
        conditionName: 'IsOrderPending',
        callName: 'ExecutePaymentGateway',
        returnName: 'ReturnProcessedSummary',
      });

      const { graph, loopStep, conditionStep, callStep, returnStep, edges } = result;

      // Verify all steps created
      expect(loopStep.stepType).toBe('loop');
      expect(conditionStep.stepType).toBe('condition');
      expect(callStep.stepType).toBe('call');
      expect(returnStep.stepType).toBe('return');

      // Verify ownership
      expect(getFunctionWorkflowSteps(graph, 'fn-orders').length).toBe(4);
      expect(getFunctionWorkflowEdges(graph, 'fn-orders').length).toBe(5);

      // Verify loop back-edge exists (call -> loop next)
      const loopCycleEdge = edges.find(e => e.source === callStep.id && e.target === loopStep.id);
      expect(loopCycleEdge).toBeDefined();
      expect(loopCycleEdge?.kind).toBe('next');
      expect(loopCycleEdge?.label).toBe('next iteration');

      // Verify condition true branch (condition -> call)
      const condTrueEdge = edges.find(e => e.source === conditionStep.id && e.target === callStep.id);
      expect(condTrueEdge).toBeDefined();
      expect(condTrueEdge?.kind).toBe('true');
      expect(condTrueEdge?.label).toBe('item is valid');

      // Verify condition false branch (condition -> loop back-edge)
      const condFalseEdge = edges.find(e => e.source === conditionStep.id && e.target === loopStep.id);
      expect(condFalseEdge).toBeDefined();
      expect(condFalseEdge?.kind).toBe('false');

      // Verify loop termination branch (loop -> return)
      const loopExitEdge = edges.find(e => e.source === loopStep.id && e.target === returnStep.id);
      expect(loopExitEdge).toBeDefined();
      expect(loopExitEdge?.kind).toBe('false');
      expect(loopExitEdge?.label).toBe('iteration complete');

      // Crucial verification: containment cycle check does not trigger on workflow loops!
      const schemaCheck = GraphSchema.safeParse(graph);
      expect(schemaCheck.success).toBe(true);
    });
  });

  describe('Concrete Validation Scenario 2: Remove the detailed workflow while retaining acceptance scenarios', () => {
    it('removes detailed workflow steps and transitions while retaining contract, inputs, rules, errors, and acceptance scenarios', () => {
      const baseGraph = createBaseGraph();

      // First add a detailed workflow to fn-orders
      const withWorkflow = buildLoopWithConditionAndReturn(baseGraph, 'fn-orders');
      let graph = withWorkflow.graph;

      // Add a requirement linking to one of the workflow steps
      const reqWithStep: Requirement = {
        id: 'req-order-processing',
        text: 'Must process orders reliably',
        nodeIds: ['fn-orders', withWorkflow.loopStep.id],
        edgeIds: [withWorkflow.edges[0].id],
        constraints: [],
        scenarios: [],
      };
      graph = {
        ...graph,
        requirements: [reqWithStep],
      };
      expect(GraphSchema.safeParse(graph).success).toBe(true);

      // Verify before state: 4 steps, 5 edges, 2 scenarios
      expect(getFunctionWorkflowSteps(graph, 'fn-orders').length).toBe(4);
      expect(getFunctionWorkflowEdges(graph, 'fn-orders').length).toBe(5);
      const fnBefore = graph.nodes.find(n => n.id === 'fn-orders')!;
      expect(fnBefore.scenarios?.length).toBe(2);
      expect(fnBefore.contract).toContain('processOrders');
      expect(fnBefore.inputs).toBe('orders: Order[]');
      expect(fnBefore.rules).toContain('Atomic execution');
      expect(fnBefore.errors).toContain('ValidationError');

      // Execute removeFunctionWorkflow
      const removeResult = removeFunctionWorkflow(graph, 'fn-orders');
      const nextGraph = removeResult.graph;

      // Verify workflow elements removed
      expect(removeResult.removedStepsCount).toBe(4);
      expect(removeResult.removedEdgesCount).toBe(5);
      expect(getFunctionWorkflowSteps(nextGraph, 'fn-orders').length).toBe(0);
      expect(getFunctionWorkflowEdges(nextGraph, 'fn-orders').length).toBe(0);

      // Verify function node and all contract/specification details strictly retained
      const fnAfter = nextGraph.nodes.find(n => n.id === 'fn-orders')!;
      expect(fnAfter).toBeDefined();
      expect(fnAfter.name).toBe('processOrders');
      expect(fnAfter.contract).toBe('export function processOrders(orders: Order[]): Promise<BatchResult>');
      expect(fnAfter.inputs).toBe('orders: Order[]');
      expect(fnAfter.outputs).toBe('Promise<BatchResult>');
      expect(fnAfter.rules).toBe('Atomic execution\nAudit trail required');
      expect(fnAfter.errors).toBe('ValidationError: Invalid order payload\nPaymentFailedError: Payment declined');
      expect(fnAfter.scenarios).toEqual([
        'Given 3 valid orders, when batch is processed, returns 3 successful transactions',
        'When payment is declined, rolls back and throws PaymentFailedError',
      ]);
      expect(fnAfter.policy).toBe('sensitive');
      expect(fnAfter.requiredChecks).toEqual(['npm test']);

      // Verify requirement was cleaned of deleted step and edge IDs, but still references fn-orders
      expect(nextGraph.requirements.length).toBe(1);
      expect(nextGraph.requirements[0].nodeIds).toEqual(['fn-orders']);
      expect(nextGraph.requirements[0].edgeIds).toEqual([]);

      // Verify the entire graph validates cleanly with GraphSchema
      expect(GraphSchema.safeParse(nextGraph).success).toBe(true);
    });
  });

  describe('UI Component and Workspace Integration', () => {
    it('renders WorkflowEditor modal with tabs, banner, and function selector', () => {
      const graph = createBaseGraph();

      const html = renderToString(
        <WorkflowEditor
          graph={graph}
          isOpen={true}
          selectedFunctionId="fn-orders"
          mode="modal"
        />
      );

      expect(html).toContain('data-testid="workflow-editor-modal"');
      expect(html).toContain('data-testid="workflow-editor-header"');
      expect(html).toContain('Function Workflow Editor');
      expect(html).toContain(WORKFLOW_OPTIONAL_BANNER);
      expect(html).toContain('data-testid="workflow-function-select"');
      expect(html).toContain('processOrders');
      expect(html).toContain('data-testid="tab-steps"');
      expect(html).toContain('data-testid="tab-connect"');
      expect(html).toContain('data-testid="tab-opaque"');
      expect(html).toContain('data-testid="tab-overview"');
      expect(html).toContain('data-testid="tab-remove"');
    });

    it('renders step list and add step form with all 8 step kinds in steps tab', () => {
      const graph = createBaseGraph();

      const html = renderToString(
        <WorkflowEditor
          graph={graph}
          isOpen={true}
          selectedFunctionId="fn-orders"
          initialTab="steps"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-steps"');
      expect(html).toContain('data-testid="add-step-form"');
      expect(html).toContain('data-testid="step-name-input"');
      expect(html).toContain('data-testid="step-type-select"');
      expect(html).toContain('data-testid="create-step-submit-btn"');

      for (const stepType of STEP_TYPES) {
        expect(html).toContain(`value="${stepType}"`);
      }
    });

    it('renders transitions and branches tab with connect form', () => {
      const baseGraph = createBaseGraph();
      const { graph } = buildLoopWithConditionAndReturn(baseGraph, 'fn-orders');

      const html = renderToString(
        <WorkflowEditor
          graph={graph}
          isOpen={true}
          selectedFunctionId="fn-orders"
          initialTab="connect"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-connect"');
      expect(html).toContain('data-testid="transitions-table"');
      expect(html).toContain('data-testid="connect-steps-form"');
      expect(html).toContain('data-testid="connect-source-select"');
      expect(html).toContain('data-testid="connect-kind-select"');
      expect(html).toContain('data-testid="connect-label-input"');
      expect(html).toContain('data-testid="connect-target-select"');
      expect(html).toContain('data-testid="connect-steps-submit-btn"');
    });

    it('renders opaque steps tab displaying bound source evidence', () => {
      let graph = createBaseGraph();
      const opaque = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'LegacyOrderParser',
        stepType: 'opaque',
        description: 'Unsupported AST parsing branch',
        source: {
          path: 'src/legacy/parser.ts',
          line: 88,
          start: 1200,
          end: 1850,
          hash: 'hash-opaque-999',
          revision: 'rev-42',
        },
      });
      graph = opaque.graph;

      const html = renderToString(
        <WorkflowEditor
          graph={graph}
          isOpen={true}
          selectedFunctionId="fn-orders"
          initialTab="opaque"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-opaque"');
      expect(html).toContain('LegacyOrderParser');
      expect(html).toContain('src/legacy/parser.ts');
      expect(html).toContain('<strong>Line:</strong>');
      expect(html).toContain('88');
      expect(html).toContain('1200');
      expect(html).toContain('1850');
      expect(html).toContain('hash-opaque-999');
      expect(html).toContain('rev-42');
      expect(html).toContain('data-testid="opaque-card-' + opaque.node.id + '"');
    });

    it('renders remove workflow tab with safety explanation and confirmation button', () => {
      const baseGraph = createBaseGraph();
      const { graph } = buildLoopWithConditionAndReturn(baseGraph, 'fn-orders');

      const html = renderToString(
        <WorkflowEditor
          graph={graph}
          isOpen={true}
          selectedFunctionId="fn-orders"
          initialTab="remove"
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="pane-remove"');
      expect(html).toContain('Remove Detailed Workflow');
      expect(html).toContain('Function Preserved:');
      expect(html).toContain('Contract Preserved:');
      expect(html).toContain('Scenarios Preserved:');
      expect(html).toContain('data-testid="remove-workflow-submit-btn"');
    });

    it('renders Header with Workflows button', () => {
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
          onOpenWorkflowEditor={() => {}}
        />
      );

      expect(html).toContain('data-testid="header-open-workflows"');
      expect(html).toContain('Workflows');
    });

    it('renders PropertyInspector with Workflow button and step badges', () => {
      let graph = createBaseGraph();
      const step = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'StepInspection',
        stepType: 'condition',
      });
      graph = step.graph;

      // 1. Function node inspection
      const htmlFunc = renderToString(
        <PropertyInspector
          project={null}
          graph={graph}
          viewState={{
            selectedId: 'fn-orders',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onEditNode={() => {}}
          onEditFunctionNode={() => {}}
          onEditWorkflowNode={() => {}}
        />
      );
      expect(htmlFunc).toContain('data-testid="inspector-edit-workflow-node"');
      expect(htmlFunc).toContain('Workflow');

      // 2. Step node inspection
      const htmlStep = renderToString(
        <PropertyInspector
          project={null}
          graph={graph}
          viewState={{
            selectedId: step.node.id,
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onEditNode={() => {}}
          onEditWorkflowNode={() => {}}
        />
      );
      expect(htmlStep).toContain('data-testid="inspector-step-type"');
      expect(htmlStep).toContain('condition');
      expect(htmlStep).toContain('data-testid="inspector-edit-step-node"');
    });

    it('renders FunctionEditor with Edit Workflow button', () => {
      let graph = createBaseGraph();
      const step = createWorkflowStep(graph, {
        functionId: 'fn-orders',
        name: 'ExistingStep',
        stepType: 'operation',
      });
      graph = step.graph;

      const html = renderToString(
        <FunctionEditor
          graph={graph}
          isOpen={true}
          selectedNodeId="fn-orders"
          mode="inline"
          onOpenWorkflowEditor={() => {}}
        />
      );

      expect(html).toContain('data-testid="function-open-workflow-btn"');
      expect(html).toContain('Edit Workflow');
    });

    it('renders full App shell with WorkflowEditor modal integrated', () => {
      const graph = createBaseGraph();
      const project: Project = {
        id: 'proj-wf-test',
        name: 'Workflow Integration Test',
        description: 'Testing full workspace shell with workflow editor',
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
      expect(html).toContain('data-testid="header-open-workflows"');
    });

    it('persists workflow creation, editing, and removal end-to-end via server and ProjectStore', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 't023-api-'));
      const store = new ProjectStore(dataDir);
      const app = await createServer({ store, host: '127.0.0.1' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}/api`;

      try {
        // Create project
        const created = await api.createProject(
          { name: 'Workflow API Test', description: 'Testing workflow API', target: 'Web application' },
          baseUrl
        );

        // Update spec with base graph
        const baseGraph = createBaseGraph();
        const updated1 = await api.updateSpecification(created.id, 0, baseGraph, baseUrl);
        expect(updated1.specRevision).toBe(1);

        // 1. Draw loop, conditional call, and return
        const loopWorkflow = buildLoopWithConditionAndReturn(baseGraph, 'fn-orders');
        const updated2 = await api.updateSpecification(created.id, 1, loopWorkflow.graph, baseUrl);
        expect(updated2.specRevision).toBe(2);

        // Fetch from store and verify
        const fetched1 = await api.getProject(created.id, baseUrl);
        expect(getFunctionWorkflowSteps(fetched1.specification, 'fn-orders').length).toBe(4);
        expect(getFunctionWorkflowEdges(fetched1.specification, 'fn-orders').length).toBe(5);

        // 2. Remove detailed workflow while retaining acceptance scenarios
        const removeRes = removeFunctionWorkflow(fetched1.specification, 'fn-orders');
        const updated3 = await api.updateSpecification(created.id, 2, removeRes.graph, baseUrl);
        expect(updated3.specRevision).toBe(3);

        // Fetch again and verify clean removal + scenario preservation
        const fetched2 = await api.getProject(created.id, baseUrl);
        expect(getFunctionWorkflowSteps(fetched2.specification, 'fn-orders').length).toBe(0);
        expect(getFunctionWorkflowEdges(fetched2.specification, 'fn-orders').length).toBe(0);

        const fnOrderFinal = fetched2.specification.nodes.find(n => n.id === 'fn-orders')!;
        expect(fnOrderFinal.contract).toContain('processOrders');
        expect(fnOrderFinal.scenarios?.length).toBe(2);
        expect(fnOrderFinal.rules).toContain('Atomic execution');
      } finally {
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });
});
