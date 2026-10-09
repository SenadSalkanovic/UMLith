import React, { useState, useMemo, useEffect } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Requirement, Project, Source } from '../../shared/model';
import { GraphSchema, createNodeId, validRelationship } from '../../shared/model';
import {
  Workflow,
  Plus,
  Trash2,
  Edit3,
  Link2,
  AlertCircle,
  CheckCircle2,
  X,
  Shield,
  Info,
  ChevronRight,
  GitBranch,
  Repeat,
  CornerDownRight,
  HelpCircle,
  FileCode,
  Tag,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';

export const WORKFLOW_OPTIONAL_BANNER =
  'Workflows are optional: functions can be specified as description-only or detailed without defining explicit calls, conditions, loops, exceptions, or returns.';

export const STEP_TYPES = [
  'operation',
  'call',
  'condition',
  'loop',
  'try',
  'throw',
  'return',
  'opaque',
] as const;

export type WorkflowStepType = (typeof STEP_TYPES)[number];

export const WORKFLOW_EDGE_KINDS = [
  'next',
  'true',
  'false',
  'exception',
] as const;

export type WorkflowEdgeKind = (typeof WORKFLOW_EDGE_KINDS)[number];

export interface CreateWorkflowStepInput {
  functionId: string;
  name: string;
  stepType: WorkflowStepType;
  parentStepId?: string;
  description?: string;
  policy?: ProgramNode['policy'];
  instructions?: string;
  requiredChecks?: string[];
  outputPath?: string;
  source?: Source;
  id?: string;
}

export interface UpdateWorkflowStepInput {
  name?: string;
  stepType?: WorkflowStepType;
  description?: string;
  policy?: ProgramNode['policy'];
  instructions?: string;
  requiredChecks?: string[];
  outputPath?: string;
  source?: Source;
}

export interface ConnectWorkflowStepsInput {
  sourceId: string;
  targetId: string;
  kind?: ProgramEdge['kind'];
  label?: string;
  id?: string;
}

export interface WorkflowEditorProps {
  project?: Project | null;
  graph: Graph | null;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  selectedFunctionId?: string | null;
  onSelectFunction?: (id: string | null) => void;
  selectedStepId?: string | null;
  onSelectStep?: (id: string | null) => void;
  isOpen?: boolean;
  onClose?: () => void;
  mode?: 'modal' | 'panel' | 'inline';
  readOnly?: boolean;
  initialTab?: 'steps' | 'connect' | 'opaque' | 'overview' | 'remove';
}

/**
 * Traverses upwards through parentId and contains edges to identify the owning function node.
 */
export function findOwningFunction(graph: Graph, nodeId: string): ProgramNode | null {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  let current = nodeMap.get(nodeId);
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);

    if (current.kind === 'function') {
      return current;
    }

    if (current.parentId) {
      current = nodeMap.get(current.parentId);
    } else {
      const containsEdge = graph.edges.find(e => e.kind === 'contains' && e.target === current!.id);
      current = containsEdge ? nodeMap.get(containsEdge.source) : undefined;
    }
  }

  return null;
}

/**
 * Checks whether a given step belongs to an owning function.
 */
export function isStepOwnedByFunction(graph: Graph, stepId: string, functionId: string): boolean {
  const step = graph.nodes.find(n => n.id === stepId && n.kind === 'step');
  if (!step) return false;
  const owner = findOwningFunction(graph, stepId);
  return owner?.id === functionId;
}

/**
 * Retrieves all step nodes owned directly or indirectly by the specified function.
 */
export function getFunctionWorkflowSteps(graph: Graph, functionId: string): ProgramNode[] {
  return graph.nodes.filter(
    n => n.kind === 'step' && findOwningFunction(graph, n.id)?.id === functionId
  );
}

/**
 * Retrieves all edges related to the specified function's workflow.
 */
export function getFunctionWorkflowEdges(graph: Graph, functionId: string): ProgramEdge[] {
  const steps = getFunctionWorkflowSteps(graph, functionId);
  const stepIds = new Set(steps.map(s => s.id));
  return graph.edges.filter(e => stepIds.has(e.source) || stepIds.has(e.target));
}

/**
 * Creates a workflow step inside a selected function, supporting all 8 step kinds,
 * nested container steps, and opaque source evidence.
 */
export function createWorkflowStep(
  graph: Graph,
  input: CreateWorkflowStepInput
): { graph: Graph; node: ProgramNode } {
  if (!input.name.trim()) {
    throw new Error('Workflow step name must not be blank');
  }

  const funcNode = graph.nodes.find(n => n.id === input.functionId);
  if (!funcNode) {
    throw new Error(`Owning function not found: ${input.functionId}`);
  }
  if (funcNode.kind !== 'function') {
    throw new Error(`Target container ${input.functionId} is not a function (kind: ${funcNode.kind})`);
  }

  let parentId = input.functionId;
  if (input.parentStepId) {
    const parentStep = graph.nodes.find(n => n.id === input.parentStepId);
    if (!parentStep) {
      throw new Error(`Parent step not found: ${input.parentStepId}`);
    }
    if (parentStep.kind !== 'step') {
      throw new Error(`Parent step ${input.parentStepId} is not a step (kind: ${parentStep.kind})`);
    }
    const parentOwner = findOwningFunction(graph, input.parentStepId);
    if (parentOwner?.id !== input.functionId) {
      throw new Error('Parent step must belong to the same owning function');
    }
    parentId = input.parentStepId;
  }

  if (input.stepType === 'opaque') {
    if (!input.source) {
      throw new Error(
        'Opaque steps require source evidence with a path, range, line, content hash and analysis revision'
      );
    }
    if (!input.source.path.trim()) {
      throw new Error('Opaque step source path must not be blank');
    }
    if (!input.source.hash.trim()) {
      throw new Error('Opaque step source content hash must not be blank');
    }
    if (!input.source.revision.trim()) {
      throw new Error('Opaque step source analysis revision must not be blank');
    }
  }

  const stepId = input.id || createNodeId();
  if (graph.nodes.some(n => n.id === stepId)) {
    throw new Error(`Duplicate node ID: ${stepId}`);
  }

  const newStep: ProgramNode = {
    id: stepId,
    kind: 'step',
    name: input.name.trim(),
    parentId,
    stepType: input.stepType,
    description: input.description !== undefined ? input.description : '',
    provenance: 'human',
    policy: input.policy || 'editable',
    contract: '',
    requiredChecks: input.requiredChecks || [],
    instructions: input.instructions !== undefined ? input.instructions : '',
    outputPath: input.outputPath !== undefined ? input.outputPath : '',
    fields: [],
  };

  if (input.source) {
    newStep.source = input.source;
  }

  const nextGraph: Graph = {
    ...graph,
    nodes: [...graph.nodes, newStep],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(
      validation.error.issues[0]?.message || 'Graph validation failed after creating workflow step'
    );
  }

  return { graph: validation.data, node: newStep };
}

/**
 * Updates an existing workflow step while preserving its stable ID and ownership.
 */
export function updateWorkflowStep(
  graph: Graph,
  stepId: string,
  updates: UpdateWorkflowStepInput
): { graph: Graph; node: ProgramNode } {
  const existingStep = graph.nodes.find(n => n.id === stepId);
  if (!existingStep) {
    throw new Error(`Workflow step not found: ${stepId}`);
  }
  if (existingStep.kind !== 'step') {
    throw new Error(`Node ${stepId} is not a workflow step (kind: ${existingStep.kind})`);
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existingStep.name;
  if (!nextName) {
    throw new Error('Workflow step name must not be blank');
  }

  const nextStepType = updates.stepType !== undefined ? updates.stepType : existingStep.stepType;
  const nextSource = updates.source !== undefined ? updates.source : existingStep.source;

  if (nextStepType === 'opaque' && !nextSource) {
    throw new Error(
      'Opaque steps require source evidence with a path, range, line, content hash and analysis revision'
    );
  }

  const updatedStep: ProgramNode = {
    ...existingStep,
    name: nextName,
    stepType: nextStepType,
    description: updates.description !== undefined ? updates.description : existingStep.description,
    policy: updates.policy !== undefined ? updates.policy : existingStep.policy,
    instructions: updates.instructions !== undefined ? updates.instructions : existingStep.instructions,
    requiredChecks: updates.requiredChecks !== undefined ? updates.requiredChecks : existingStep.requiredChecks,
    outputPath: updates.outputPath !== undefined ? updates.outputPath : existingStep.outputPath,
    source: nextSource,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === stepId ? updatedStep : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(
      validation.error.issues[0]?.message || 'Graph validation failed after updating workflow step'
    );
  }

  return { graph: validation.data, node: updatedStep };
}

/**
 * Recursively removes a workflow step, its nested child steps, incident edges, and cleans requirement references.
 */
export function removeWorkflowStep(
  graph: Graph,
  stepId: string
): { graph: Graph; removedNode: ProgramNode; removedDescendantsCount: number } {
  const targetStep = graph.nodes.find(n => n.id === stepId);
  if (!targetStep) {
    throw new Error(`Workflow step not found: ${stepId}`);
  }
  if (targetStep.kind !== 'step') {
    throw new Error(`Node ${stepId} is not a workflow step (kind: ${targetStep.kind})`);
  }

  // Find all descendants recursively
  const toDelete = new Set<string>([stepId]);
  let added = true;
  while (added) {
    added = false;
    for (const node of graph.nodes) {
      if (node.parentId && toDelete.has(node.parentId) && !toDelete.has(node.id)) {
        toDelete.add(node.id);
        added = true;
      }
    }
    for (const edge of graph.edges) {
      if (edge.kind === 'contains' && toDelete.has(edge.source) && !toDelete.has(edge.target)) {
        toDelete.add(edge.target);
        added = true;
      }
    }
  }

  const removedEdges = graph.edges.filter(e => toDelete.has(e.source) || toDelete.has(e.target));
  const removedEdgeIds = new Set(removedEdges.map(e => e.id));

  const nextNodes = graph.nodes.filter(n => !toDelete.has(n.id));
  const nextEdges = graph.edges.filter(e => !removedEdgeIds.has(e.id));

  const nextRequirements: Requirement[] = graph.requirements.map(req => ({
    ...req,
    nodeIds: req.nodeIds.filter(id => !toDelete.has(id)),
    edgeIds: req.edgeIds.filter(id => !removedEdgeIds.has(id)),
  }));

  const nextGraph: Graph = {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
    requirements: nextRequirements,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(
      validation.error.issues[0]?.message || 'Graph validation failed after removing workflow step'
    );
  }

  return {
    graph: validation.data,
    removedNode: targetStep,
    removedDescendantsCount: toDelete.size - 1,
  };
}

/**
 * Validates whether a connection between two steps or external targets complies with graph rules.
 */
export function validateWorkflowConnection(
  graph: Graph,
  sourceId: string,
  targetId: string,
  kind: ProgramEdge['kind'] = 'next'
): { valid: boolean; error?: string } {
  const sourceNode = graph.nodes.find(n => n.id === sourceId);
  const targetNode = graph.nodes.find(n => n.id === targetId);

  if (!sourceNode) {
    return { valid: false, error: `Source node not found: ${sourceId}` };
  }
  if (!targetNode) {
    return { valid: false, error: `Target node not found: ${targetId}` };
  }

  if (!validRelationship(kind, sourceNode.kind, targetNode.kind)) {
    return {
      valid: false,
      error: `Invalid relationship: "${kind}" is not supported from ${sourceNode.kind} to ${targetNode.kind}`,
    };
  }

  if (['next', 'true', 'false', 'exception'].includes(kind)) {
    if (sourceNode.kind !== 'step' || targetNode.kind !== 'step') {
      return {
        valid: false,
        error: `Workflow connection kind "${kind}" is only valid between workflow steps`,
      };
    }

    const sourceOwner = findOwningFunction(graph, sourceNode.id);
    const targetOwner = findOwningFunction(graph, targetNode.id);

    if (!sourceOwner || !targetOwner) {
      return {
        valid: false,
        error: 'Workflow steps must have an owning function',
      };
    }

    if (sourceOwner.id !== targetOwner.id) {
      return {
        valid: false,
        error: 'Workflow flow must stay within the same owning function',
      };
    }

    if (kind === 'true' || kind === 'false') {
      if (sourceNode.stepType !== 'condition' && sourceNode.stepType !== 'loop') {
        return {
          valid: false,
          error: `A "${kind}" branch must originate at a condition or loop step (source is "${sourceNode.stepType}")`,
        };
      }

      const existingBranch = graph.edges.find(
        e => e.source === sourceId && e.kind === kind
      );
      if (existingBranch) {
        return {
          valid: false,
          error: `Duplicate "${kind}" branch for step: ${sourceId}`,
        };
      }
    }

    if (kind === 'next' && (sourceNode.stepType === 'return' || sourceNode.stepType === 'throw')) {
      return {
        valid: false,
        error: `Return and throw steps cannot continue with next (source is "${sourceNode.stepType}")`,
      };
    }
  }

  return { valid: true };
}

/**
 * Connects two workflow steps or external targets with a labeled branch, exception path, or next step transition.
 */
export function connectWorkflowSteps(
  graph: Graph,
  input: ConnectWorkflowStepsInput
): { graph: Graph; edge: ProgramEdge } {
  const kind = input.kind || 'next';
  const validation = validateWorkflowConnection(graph, input.sourceId, input.targetId, kind);

  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid workflow connection');
  }

  const edgeId = input.id || `wf-edge-${createNodeId()}`;
  if (graph.edges.some(e => e.id === edgeId)) {
    throw new Error(`Duplicate edge ID: ${edgeId}`);
  }

  let label = input.label;
  if (label === undefined) {
    if (kind === 'true') label = 'true';
    else if (kind === 'false') label = 'false';
    else if (kind === 'exception') label = 'exception';
    else label = '';
  }

  const newEdge: ProgramEdge = {
    id: edgeId,
    source: input.sourceId,
    target: input.targetId,
    kind,
    label,
    provenance: 'human',
    uncertain: false,
  };

  const nextGraph: Graph = {
    ...graph,
    edges: [...graph.edges, newEdge],
  };

  const schemaValidation = GraphSchema.safeParse(nextGraph);
  if (!schemaValidation.success) {
    throw new Error(
      schemaValidation.error.issues[0]?.message || 'Graph validation failed after creating workflow connection'
    );
  }

  return { graph: schemaValidation.data, edge: newEdge };
}

/**
 * Removes a workflow edge and cleans any requirements referencing it.
 */
export function removeWorkflowEdge(
  graph: Graph,
  edgeId: string
): { graph: Graph; removedEdge: ProgramEdge } {
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) {
    throw new Error(`Workflow edge not found: ${edgeId}`);
  }

  const nextEdges = graph.edges.filter(e => e.id !== edgeId);
  const nextRequirements = graph.requirements.map(req => ({
    ...req,
    edgeIds: req.edgeIds.filter(id => id !== edgeId),
  }));

  const nextGraph: Graph = {
    ...graph,
    edges: nextEdges,
    requirements: nextRequirements,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(
      validation.error.issues[0]?.message || 'Graph validation failed after removing workflow edge'
    );
  }

  return { graph: validation.data, removedEdge: edge };
}

/**
 * Removes the detailed workflow (all steps and transitions) from a function
 * while strictly retaining the function's contract, description, inputs, outputs,
 * rules, errors, and acceptance scenarios.
 */
export function removeFunctionWorkflow(
  graph: Graph,
  functionId: string
): {
  graph: Graph;
  removedStepsCount: number;
  removedEdgesCount: number;
  functionNode: ProgramNode;
} {
  const fnNode = graph.nodes.find(n => n.id === functionId);
  if (!fnNode) {
    throw new Error(`Function node not found: ${functionId}`);
  }
  if (fnNode.kind !== 'function') {
    throw new Error(`Node ${functionId} is not a function (kind: ${fnNode.kind})`);
  }

  const workflowSteps = getFunctionWorkflowSteps(graph, functionId);
  const stepIds = new Set(workflowSteps.map(s => s.id));

  const removedEdges = graph.edges.filter(e => stepIds.has(e.source) || stepIds.has(e.target));
  const removedEdgeIds = new Set(removedEdges.map(e => e.id));

  const nextNodes = graph.nodes.filter(n => !stepIds.has(n.id));
  const nextEdges = graph.edges.filter(e => !removedEdgeIds.has(e.id));

  const nextRequirements = graph.requirements.map(req => ({
    ...req,
    nodeIds: req.nodeIds.filter(id => !stepIds.has(id)),
    edgeIds: req.edgeIds.filter(id => !removedEdgeIds.has(id)),
  }));

  const nextGraph: Graph = {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
    requirements: nextRequirements,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(
      validation.error.issues[0]?.message || 'Graph validation failed after removing function workflow'
    );
  }

  return {
    graph: validation.data,
    removedStepsCount: workflowSteps.length,
    removedEdgesCount: removedEdges.length,
    functionNode: fnNode,
  };
}

/**
 * Helper to build a complete loop, conditional call, and return workflow inside a function.
 * Demonstrates concrete validation scenario 1.
 */
export function buildLoopWithConditionAndReturn(
  graph: Graph,
  functionId: string,
  options?: {
    loopName?: string;
    conditionName?: string;
    callName?: string;
    returnName?: string;
  }
): {
  graph: Graph;
  loopStep: ProgramNode;
  conditionStep: ProgramNode;
  callStep: ProgramNode;
  returnStep: ProgramNode;
  edges: ProgramEdge[];
} {
  // Step 1: Loop
  const s1 = createWorkflowStep(graph, {
    functionId,
    name: options?.loopName || 'ForEachItem',
    stepType: 'loop',
    description: 'Iterates over elements in the collection',
  });

  // Step 2: Condition
  const s2 = createWorkflowStep(s1.graph, {
    functionId,
    name: options?.conditionName || 'CheckItemValid',
    stepType: 'condition',
    description: 'Tests if current item passes validation criteria',
  });

  // Step 3: Call
  const s3 = createWorkflowStep(s2.graph, {
    functionId,
    name: options?.callName || 'ProcessItemCall',
    stepType: 'call',
    description: 'Invokes item processing logic',
  });

  // Step 4: Return
  const s4 = createWorkflowStep(s3.graph, {
    functionId,
    name: options?.returnName || 'ReturnSummary',
    stepType: 'return',
    description: 'Returns the completed batch summary',
  });

  // Edges:
  // loop --[true]--> condition
  const e1 = connectWorkflowSteps(s4.graph, {
    sourceId: s1.node.id,
    targetId: s2.node.id,
    kind: 'true',
    label: 'has next item',
  });

  // condition --[true]--> call
  const e2 = connectWorkflowSteps(e1.graph, {
    sourceId: s2.node.id,
    targetId: s3.node.id,
    kind: 'true',
    label: 'item is valid',
  });

  // call --[next]--> loop (loop back-edge)
  const e3 = connectWorkflowSteps(e2.graph, {
    sourceId: s3.node.id,
    targetId: s1.node.id,
    kind: 'next',
    label: 'next iteration',
  });

  // condition --[false]--> loop (skip invalid and continue loop)
  const e4 = connectWorkflowSteps(e3.graph, {
    sourceId: s2.node.id,
    targetId: s1.node.id,
    kind: 'false',
    label: 'skip invalid',
  });

  // loop --[false]--> return (exit loop)
  const e5 = connectWorkflowSteps(e4.graph, {
    sourceId: s1.node.id,
    targetId: s4.node.id,
    kind: 'false',
    label: 'iteration complete',
  });

  return {
    graph: e5.graph,
    loopStep: s1.node,
    conditionStep: s2.node,
    callStep: s3.node,
    returnStep: s4.node,
    edges: [e1.edge, e2.edge, e3.edge, e4.edge, e5.edge],
  };
}

export const WorkflowEditor: React.FC<WorkflowEditorProps> = ({
  project,
  graph,
  onUpdateSpecification,
  selectedFunctionId,
  onSelectFunction,
  selectedStepId,
  onSelectStep,
  isOpen = true,
  onClose,
  mode = 'modal',
  readOnly = false,
  initialTab = 'steps',
}) => {
  const [activeTab, setActiveTab] = useState<'steps' | 'connect' | 'opaque' | 'overview' | 'remove'>(
    initialTab
  );
  const [internalFunctionId, setInternalFunctionId] = useState<string | null>(
    selectedFunctionId || null
  );
  const [internalStepId, setInternalStepId] = useState<string | null>(
    selectedStepId || null
  );

  // Form states: Add step
  const [stepName, setStepName] = useState<string>('');
  const [stepType, setStepType] = useState<WorkflowStepType>('operation');
  const [stepParentContainer, setStepParentContainer] = useState<string>('');
  const [stepDescription, setStepDescription] = useState<string>('');
  const [stepPolicy, setStepPolicy] = useState<ProgramNode['policy']>('editable');
  const [stepInstructions, setStepInstructions] = useState<string>('');
  const [stepRequiredChecks, setStepRequiredChecks] = useState<string>('');

  // Opaque source fields
  const [opaquePath, setOpaquePath] = useState<string>('');
  const [opaqueLine, setOpaqueLine] = useState<number>(1);
  const [opaqueStart, setOpaqueStart] = useState<number>(0);
  const [opaqueEnd, setOpaqueEnd] = useState<number>(100);
  const [opaqueHash, setOpaqueHash] = useState<string>('');
  const [opaqueRevision, setOpaqueRevision] = useState<string>('rev-1');

  // Form states: Connect steps
  const [connectSource, setConnectSource] = useState<string>('');
  const [connectTarget, setConnectTarget] = useState<string>('');
  const [connectKind, setConnectKind] = useState<ProgramEdge['kind']>('next');
  const [connectLabel, setConnectLabel] = useState<string>('');

  // UI feedback & error
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // All available functions in graph
  const functionNodes = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter(n => n.kind === 'function');
  }, [graph]);

  // Sync internal function selection
  useEffect(() => {
    if (selectedFunctionId) {
      setInternalFunctionId(selectedFunctionId);
    } else if (!internalFunctionId && functionNodes.length > 0) {
      setInternalFunctionId(functionNodes[0].id);
    }
  }, [selectedFunctionId, functionNodes, internalFunctionId]);

  const activeFunction = useMemo(() => {
    if (!graph || !internalFunctionId) return null;
    return graph.nodes.find(n => n.id === internalFunctionId && n.kind === 'function') || null;
  }, [graph, internalFunctionId]);

  const currentWorkflowSteps = useMemo(() => {
    if (!graph || !internalFunctionId) return [];
    return getFunctionWorkflowSteps(graph, internalFunctionId);
  }, [graph, internalFunctionId]);

  const currentWorkflowEdges = useMemo(() => {
    if (!graph || !internalFunctionId) return [];
    return getFunctionWorkflowEdges(graph, internalFunctionId);
  }, [graph, internalFunctionId]);

  const opaqueSteps = useMemo(() => {
    return currentWorkflowSteps.filter(s => s.stepType === 'opaque');
  }, [currentWorkflowSteps]);

  const handleFunctionChange = (id: string) => {
    setInternalFunctionId(id);
    if (onSelectFunction) onSelectFunction(id);
    setInternalStepId(null);
    setConnectSource('');
    setConnectTarget('');
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const handleCreateStepSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!graph || !internalFunctionId) return;
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      let sourceInput: Source | undefined = undefined;
      if (stepType === 'opaque') {
        if (!opaquePath.trim() || !opaqueHash.trim() || !opaqueRevision.trim()) {
          throw new Error('Opaque steps require path, content hash, and revision');
        }
        sourceInput = {
          path: opaquePath.trim(),
          line: Number(opaqueLine) || 1,
          start: Number(opaqueStart) || 0,
          end: Number(opaqueEnd) || 0,
          hash: opaqueHash.trim(),
          revision: opaqueRevision.trim(),
        };
      }

      const checks = stepRequiredChecks
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const result = createWorkflowStep(graph, {
        functionId: internalFunctionId,
        parentStepId: stepParentContainer || undefined,
        name: stepName,
        stepType,
        description: stepDescription,
        policy: stepPolicy,
        instructions: stepInstructions,
        requiredChecks: checks,
        source: sourceInput,
      });

      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }

      setStatusMessage(`Step "${result.node.name}" created successfully.`);
      setStepName('');
      setStepDescription('');
      setStepInstructions('');
      setStepRequiredChecks('');
      setStepParentContainer('');
      if (stepType === 'opaque') {
        setOpaquePath('');
        setOpaqueHash('');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to create workflow step');
    }
  };

  const handleConnectStepsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!graph || !internalFunctionId) return;
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const result = connectWorkflowSteps(graph, {
        sourceId: connectSource,
        targetId: connectTarget,
        kind: connectKind,
        label: connectLabel,
      });

      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }

      setStatusMessage(`Workflow transition connected successfully.`);
      setConnectLabel('');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to connect workflow steps');
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    if (!graph || readOnly) return;
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const result = removeWorkflowStep(graph, stepId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      setStatusMessage(`Removed step "${result.removedNode.name}".`);
      if (internalStepId === stepId) setInternalStepId(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to remove step');
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    if (!graph || readOnly) return;
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const result = removeWorkflowEdge(graph, edgeId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      setStatusMessage(`Removed workflow connection.`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to remove connection');
    }
  };

  const handleRemoveWorkflowSubmit = async () => {
    if (!graph || !internalFunctionId || readOnly) return;
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const result = removeFunctionWorkflow(graph, internalFunctionId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      setStatusMessage(
        `Workflow removed cleanly: ${result.removedStepsCount} step(s) and ${result.removedEdgesCount} transition(s) removed. Function contract and scenarios preserved.`
      );
      setActiveTab('steps');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to remove workflow');
    }
  };

  if (!isOpen && mode === 'modal') return null;

  return (
    <div
      className={mode === 'modal' ? 'modal-backdrop' : 'workflow-editor-inline'}
      data-testid="workflow-editor-modal"
    >
      <div
        className={
          mode === 'modal'
            ? 'modal-content workflow-editor-modal-container'
            : 'workflow-editor-container'
        }
      >
        {/* Header */}
        <div className="workflow-editor-header" data-testid="workflow-editor-header">
          <div className="workflow-header-title">
            <Workflow className="workflow-header-icon" size={20} />
            <div>
              <h2>Function Workflow Editor</h2>
              <span className="workflow-subtitle">
                Optional control-flow graphs: calls, conditions, loops, exceptions, and returns
              </span>
            </div>
          </div>
          {mode === 'modal' && onClose && (
            <button
              className="btn-close-workflow"
              onClick={onClose}
              title="Close Workflow Editor"
              data-testid="close-workflow-editor"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* Optionality Banner */}
        <div className="workflow-optional-banner" data-testid="workflow-optional-banner">
          <Info size={16} />
          <span>{WORKFLOW_OPTIONAL_BANNER}</span>
        </div>

        {/* Function Selector & Status Bar */}
        <div className="workflow-function-bar" data-testid="workflow-function-bar">
          <div className="function-select-row">
            <label htmlFor="workflow-func-select">Active Function:</label>
            <select
              id="workflow-func-select"
              value={internalFunctionId || ''}
              onChange={e => handleFunctionChange(e.target.value)}
              className="select-sm"
              data-testid="workflow-function-select"
            >
              {functionNodes.length === 0 && (
                <option value="">No functions available</option>
              )}
              {functionNodes.map(fn => (
                <option key={fn.id} value={fn.id}>
                  {fn.name} {fn.parentId ? `(${fn.parentId})` : ''}
                </option>
              ))}
            </select>
          </div>

          {activeFunction && (
            <div className="function-meta-badges">
              <span className="badge-kind">function</span>
              <span className={`badge-policy policy-${activeFunction.policy}`}>
                <Shield size={12} /> {activeFunction.policy}
              </span>
              <span className="badge-step-count" data-testid="workflow-steps-count-badge">
                {currentWorkflowSteps.length} {currentWorkflowSteps.length === 1 ? 'step' : 'steps'}
              </span>
              {activeFunction.contract && (
                <span className="badge-contract-indicator" title={activeFunction.contract}>
                  Contract ✓
                </span>
              )}
              {activeFunction.scenarios && activeFunction.scenarios.length > 0 && (
                <span className="badge-scenarios-indicator">
                  {activeFunction.scenarios.length} scenarios ✓
                </span>
              )}
            </div>
          )}
        </div>

        {/* Alert Messages */}
        {errorMessage && (
          <div className="alert-box alert-error" data-testid="workflow-error-message">
            <AlertCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}
        {statusMessage && (
          <div className="alert-box alert-success" data-testid="workflow-status-message">
            <CheckCircle2 size={16} />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="workflow-tab-bar" data-testid="workflow-tab-bar">
          <button
            type="button"
            className={`workflow-tab-btn ${activeTab === 'steps' ? 'active' : ''}`}
            onClick={() => setActiveTab('steps')}
            data-testid="tab-steps"
          >
            <GitBranch size={14} />
            <span>Steps ({currentWorkflowSteps.length})</span>
          </button>
          <button
            type="button"
            className={`workflow-tab-btn ${activeTab === 'connect' ? 'active' : ''}`}
            onClick={() => setActiveTab('connect')}
            data-testid="tab-connect"
          >
            <Link2 size={14} />
            <span>Transitions & Branches ({currentWorkflowEdges.length})</span>
          </button>
          <button
            type="button"
            className={`workflow-tab-btn ${activeTab === 'opaque' ? 'active' : ''}`}
            onClick={() => setActiveTab('opaque')}
            data-testid="tab-opaque"
          >
            <FileCode size={14} />
            <span>Opaque Steps ({opaqueSteps.length})</span>
          </button>
          <button
            type="button"
            className={`workflow-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
            data-testid="tab-overview"
          >
            <Workflow size={14} />
            <span>Graph Overview</span>
          </button>
          <button
            type="button"
            className={`workflow-tab-btn tab-danger ${activeTab === 'remove' ? 'active' : ''}`}
            onClick={() => setActiveTab('remove')}
            data-testid="tab-remove"
          >
            <Trash2 size={14} />
            <span>Remove Workflow</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="workflow-editor-body">
          {!activeFunction ? (
            <div className="workflow-empty-state" data-testid="workflow-no-function">
              <Workflow size={36} />
              <p>Please create or select a function to edit its optional workflow graph.</p>
            </div>
          ) : (
            <>
              {/* TAB 1: STEPS */}
              {activeTab === 'steps' && (
                <div className="workflow-pane pane-steps" data-testid="pane-steps">
                  <div className="steps-split-view">
                    {/* Left: Step List */}
                    <div className="steps-list-column">
                      <div className="column-header">
                        <h3>Workflow Steps</h3>
                        <span className="text-muted">{currentWorkflowSteps.length} defined</span>
                      </div>

                      {currentWorkflowSteps.length === 0 ? (
                        <div className="steps-empty-notice" data-testid="steps-empty-notice">
                          <p>No workflow steps defined.</p>
                          <small>Functions without workflows remain completely valid.</small>
                        </div>
                      ) : (
                        <div className="steps-card-list" data-testid="steps-list">
                          {currentWorkflowSteps.map(step => (
                            <div
                              key={step.id}
                              className={`step-card ${internalStepId === step.id ? 'selected' : ''}`}
                              onClick={() => {
                                setInternalStepId(step.id);
                                if (onSelectStep) onSelectStep(step.id);
                              }}
                              data-testid={`step-item-${step.id}`}
                            >
                              <div className="step-card-header">
                                <span className={`step-type-pill step-type-${step.stepType}`}>
                                  {step.stepType}
                                </span>
                                <span className="step-card-name" title={step.name}>
                                  {step.name}
                                </span>
                                {!readOnly && (
                                  <button
                                    type="button"
                                    className="btn-icon-xs btn-delete"
                                    onClick={e => {
                                      e.stopPropagation();
                                      handleDeleteStep(step.id);
                                    }}
                                    title={`Delete step ${step.name}`}
                                    data-testid={`delete-step-btn-${step.id}`}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </div>
                              {step.description && (
                                <p className="step-card-desc">{step.description}</p>
                              )}
                              <div className="step-card-meta">
                                {step.parentId !== internalFunctionId && (
                                  <span className="step-nested-badge">
                                    nested in: {step.parentId}
                                  </span>
                                )}
                                {step.stepType === 'opaque' && step.source && (
                                  <span className="step-opaque-badge">
                                    source: {step.source.path}:{step.source.line}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Right: Add Step Form */}
                    {!readOnly && (
                      <div className="steps-form-column">
                        <div className="column-header">
                          <h3>Add Control-Flow Step</h3>
                        </div>

                        <form onSubmit={handleCreateStepSubmit} data-testid="add-step-form">
                          <div className="form-group">
                            <label htmlFor="step-name">Step Name *</label>
                            <input
                              id="step-name"
                              type="text"
                              value={stepName}
                              onChange={e => setStepName(e.target.value)}
                              placeholder="e.g. CheckUserStatus, ProcessPayment, ForEachOrder"
                              required
                              data-testid="step-name-input"
                            />
                          </div>

                          <div className="form-group-row">
                            <div className="form-group">
                              <label htmlFor="step-type">Step Kind *</label>
                              <select
                                id="step-type"
                                value={stepType}
                                onChange={e => setStepType(e.target.value as WorkflowStepType)}
                                data-testid="step-type-select"
                              >
                                {STEP_TYPES.map(k => (
                                  <option key={k} value={k}>
                                    {k}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="form-group">
                              <label htmlFor="step-parent">Container Nesting</label>
                              <select
                                id="step-parent"
                                value={stepParentContainer}
                                onChange={e => setStepParentContainer(e.target.value)}
                                data-testid="step-parent-select"
                              >
                                <option value="">Function Root ({activeFunction.name})</option>
                                {currentWorkflowSteps
                                  .filter(s => ['loop', 'try', 'condition'].includes(s.stepType || ''))
                                  .map(s => (
                                    <option key={s.id} value={s.id}>
                                      Inside [{s.stepType}] {s.name}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          </div>

                          <div className="form-group">
                            <label htmlFor="step-desc">Description</label>
                            <input
                              id="step-desc"
                              type="text"
                              value={stepDescription}
                              onChange={e => setStepDescription(e.target.value)}
                              placeholder="Describe control flow operation"
                              data-testid="step-desc-input"
                            />
                          </div>

                          {/* Opaque step fields */}
                          {stepType === 'opaque' && (
                            <div className="opaque-inputs-section" data-testid="opaque-step-fields">
                              <div className="section-label">Source Evidence (Required for Opaque)</div>
                              <div className="form-group">
                                <label htmlFor="opaque-path">Source File Path *</label>
                                <input
                                  id="opaque-path"
                                  type="text"
                                  value={opaquePath}
                                  onChange={e => setOpaquePath(e.target.value)}
                                  placeholder="src/services/billing.ts"
                                  required
                                  data-testid="step-opaque-path-input"
                                />
                              </div>

                              <div className="form-group-row">
                                <div className="form-group">
                                  <label htmlFor="opaque-line">Line Number *</label>
                                  <input
                                    id="opaque-line"
                                    type="number"
                                    min={1}
                                    value={opaqueLine}
                                    onChange={e => setOpaqueLine(parseInt(e.target.value) || 1)}
                                    data-testid="step-opaque-line-input"
                                  />
                                </div>
                                <div className="form-group">
                                  <label htmlFor="opaque-start">Char Start</label>
                                  <input
                                    id="opaque-start"
                                    type="number"
                                    min={0}
                                    value={opaqueStart}
                                    onChange={e => setOpaqueStart(parseInt(e.target.value) || 0)}
                                    data-testid="step-opaque-start-input"
                                  />
                                </div>
                                <div className="form-group">
                                  <label htmlFor="opaque-end">Char End</label>
                                  <input
                                    id="opaque-end"
                                    type="number"
                                    min={0}
                                    value={opaqueEnd}
                                    onChange={e => setOpaqueEnd(parseInt(e.target.value) || 0)}
                                    data-testid="step-opaque-end-input"
                                  />
                                </div>
                              </div>

                              <div className="form-group-row">
                                <div className="form-group">
                                  <label htmlFor="opaque-hash">Content Hash *</label>
                                  <input
                                    id="opaque-hash"
                                    type="text"
                                    value={opaqueHash}
                                    onChange={e => setOpaqueHash(e.target.value)}
                                    placeholder="sha256-..."
                                    required
                                    data-testid="step-opaque-hash-input"
                                  />
                                </div>
                                <div className="form-group">
                                  <label htmlFor="opaque-rev">Analysis Revision *</label>
                                  <input
                                    id="opaque-rev"
                                    type="text"
                                    value={opaqueRevision}
                                    onChange={e => setOpaqueRevision(e.target.value)}
                                    placeholder="rev-1"
                                    required
                                    data-testid="step-opaque-revision-input"
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="form-group-row">
                            <div className="form-group">
                              <label htmlFor="step-policy">Policy</label>
                              <select
                                id="step-policy"
                                value={stepPolicy}
                                onChange={e => setStepPolicy(e.target.value as ProgramNode['policy'])}
                                data-testid="step-policy-select"
                              >
                                <option value="editable">editable</option>
                                <option value="sensitive">sensitive</option>
                              </select>
                            </div>
                            <div className="form-group">
                              <label htmlFor="step-checks">Required Checks</label>
                              <input
                                id="step-checks"
                                type="text"
                                value={stepRequiredChecks}
                                onChange={e => setStepRequiredChecks(e.target.value)}
                                placeholder="npm test"
                                data-testid="step-checks-input"
                              />
                            </div>
                          </div>

                          <div className="form-group">
                            <label htmlFor="step-inst">Instructions</label>
                            <input
                              id="step-inst"
                              type="text"
                              value={stepInstructions}
                              onChange={e => setStepInstructions(e.target.value)}
                              placeholder="Implementation details or constraints"
                              data-testid="step-instructions-input"
                            />
                          </div>

                          <button
                            type="submit"
                            className="btn btn-primary btn-block"
                            data-testid="create-step-submit-btn"
                          >
                            <Plus size={14} />
                            <span>Add Step</span>
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: CONNECT & BRANCHES */}
              {activeTab === 'connect' && (
                <div className="workflow-pane pane-connect" data-testid="pane-connect">
                  <div className="connect-split-view">
                    {/* Left: Existing Transitions */}
                    <div className="transitions-list-column">
                      <div className="column-header">
                        <h3>Workflow Transitions & Branches</h3>
                        <span className="text-muted">{currentWorkflowEdges.length} connections</span>
                      </div>

                      {currentWorkflowEdges.length === 0 ? (
                        <div className="steps-empty-notice" data-testid="connections-empty-notice">
                          <p>No control-flow transitions defined.</p>
                          <small>Connect workflow steps below using branches or sequential transitions.</small>
                        </div>
                      ) : (
                        <div className="transitions-table-wrapper" data-testid="transitions-table">
                          <table className="transitions-table">
                            <thead>
                              <tr>
                                <th>Source Step</th>
                                <th>Kind</th>
                                <th>Branch Label</th>
                                <th>Target Step</th>
                                {!readOnly && <th>Action</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {currentWorkflowEdges.map(edge => {
                                const srcNode = graph?.nodes.find(n => n.id === edge.source);
                                const tgtNode = graph?.nodes.find(n => n.id === edge.target);
                                return (
                                  <tr key={edge.id} data-testid={`edge-row-${edge.id}`}>
                                    <td>
                                      <strong>{srcNode?.name || edge.source}</strong>
                                      {srcNode?.stepType && (
                                        <span className="sub-type"> ({srcNode.stepType})</span>
                                      )}
                                    </td>
                                    <td>
                                      <span className={`edge-kind-pill edge-kind-${edge.kind}`}>
                                        {edge.kind}
                                      </span>
                                    </td>
                                    <td>
                                      <code className="branch-label">
                                        {edge.label || '-'}
                                      </code>
                                    </td>
                                    <td>
                                      <strong>{tgtNode?.name || edge.target}</strong>
                                      {tgtNode?.stepType && (
                                        <span className="sub-type"> ({tgtNode.stepType})</span>
                                      )}
                                    </td>
                                    {!readOnly && (
                                      <td>
                                        <button
                                          type="button"
                                          className="btn-icon-xs btn-delete"
                                          onClick={() => handleDeleteEdge(edge.id)}
                                          title="Delete transition"
                                          data-testid={`delete-edge-btn-${edge.id}`}
                                        >
                                          <Trash2 size={12} />
                                        </button>
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Right: Connect Form */}
                    {!readOnly && (
                      <div className="transitions-form-column">
                        <div className="column-header">
                          <h3>Create Transition or Branch</h3>
                        </div>

                        <form onSubmit={handleConnectStepsSubmit} data-testid="connect-steps-form">
                          <div className="form-group">
                            <label htmlFor="conn-source">Source Step *</label>
                            <select
                              id="conn-source"
                              value={connectSource}
                              onChange={e => setConnectSource(e.target.value)}
                              required
                              data-testid="connect-source-select"
                            >
                              <option value="">Select source step</option>
                              {currentWorkflowSteps.map(s => (
                                <option key={s.id} value={s.id}>
                                  [{s.stepType}] {s.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="form-group-row">
                            <div className="form-group">
                              <label htmlFor="conn-kind">Transition Kind *</label>
                              <select
                                id="conn-kind"
                                value={connectKind}
                                onChange={e => setConnectKind(e.target.value as ProgramEdge['kind'])}
                                data-testid="connect-kind-select"
                              >
                                <option value="next">next (Sequential)</option>
                                <option value="true">true (Conditional / Loop Branch)</option>
                                <option value="false">false (Conditional / Loop Exit)</option>
                                <option value="exception">exception (Try / Catch Path)</option>
                                <option value="calls">calls (External function/class)</option>
                                <option value="reads">reads (Data entity read)</option>
                                <option value="writes">writes (Data entity write)</option>
                              </select>
                            </div>

                            <div className="form-group">
                              <label htmlFor="conn-label">Branch / Exception Label</label>
                              <input
                                id="conn-label"
                                type="text"
                                value={connectLabel}
                                onChange={e => setConnectLabel(e.target.value)}
                                placeholder={
                                  connectKind === 'true'
                                    ? 'e.g. true, is_valid, items_remain'
                                    : connectKind === 'false'
                                    ? 'e.g. false, not_found, loop_done'
                                    : connectKind === 'exception'
                                    ? 'e.g. on error, catch InvalidInput'
                                    : 'e.g. next'
                                }
                                data-testid="connect-label-input"
                              />
                            </div>
                          </div>

                          <div className="form-group">
                            <label htmlFor="conn-target">Target Step *</label>
                            <select
                              id="conn-target"
                              value={connectTarget}
                              onChange={e => setConnectTarget(e.target.value)}
                              required
                              data-testid="connect-target-select"
                            >
                              <option value="">Select target step</option>
                              {currentWorkflowSteps.map(s => (
                                <option key={s.id} value={s.id}>
                                  [{s.stepType}] {s.name}
                                </option>
                              ))}
                              {/* External call/read/write targets */}
                              {['calls', 'reads', 'writes'].includes(connectKind) &&
                                (graph?.nodes || [])
                                  .filter(
                                    n =>
                                      (connectKind === 'calls' && ['function', 'class'].includes(n.kind)) ||
                                      ((connectKind === 'reads' || connectKind === 'writes') &&
                                        n.kind === 'entity')
                                  )
                                  .map(ext => (
                                    <option key={ext.id} value={ext.id}>
                                      [ext {ext.kind}] {ext.name}
                                    </option>
                                  ))}
                            </select>
                          </div>

                          <button
                            type="submit"
                            className="btn btn-primary btn-block"
                            disabled={!connectSource || !connectTarget}
                            data-testid="connect-steps-submit-btn"
                          >
                            <Link2 size={14} />
                            <span>Connect Steps</span>
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: OPAQUE STEPS */}
              {activeTab === 'opaque' && (
                <div className="workflow-pane pane-opaque" data-testid="pane-opaque">
                  <div className="opaque-header-info">
                    <Info size={16} />
                    <span>
                      Unsupported logic remains visible as source-backed opaque nodes. Opaque steps
                      preserve full file ranges, line mappings, content hashes, and analysis
                      revisions without guessing runtime behavior.
                    </span>
                  </div>

                  {opaqueSteps.length === 0 ? (
                    <div className="steps-empty-notice" data-testid="opaque-empty-notice">
                      <p>No opaque steps in this workflow.</p>
                      <small>All control flow logic is represented with explicit typed steps.</small>
                    </div>
                  ) : (
                    <div className="opaque-cards-grid" data-testid="opaque-steps-grid">
                      {opaqueSteps.map(step => (
                        <div key={step.id} className="opaque-step-card" data-testid={`opaque-card-${step.id}`}>
                          <div className="opaque-card-top">
                            <span className="opaque-tag">opaque</span>
                            <h4>{step.name}</h4>
                          </div>
                          {step.description && <p className="opaque-desc">{step.description}</p>}
                          {step.source && (
                            <div className="opaque-source-box">
                              <div>
                                <strong>File:</strong> <code>{step.source.path}</code>
                              </div>
                              <div>
                                <strong>Line:</strong> {step.source.line} (Range: {step.source.start}..{step.source.end})
                              </div>
                              <div>
                                <strong>Hash:</strong> <code>{step.source.hash}</code>
                              </div>
                              <div>
                                <strong>Revision:</strong> {step.source.revision}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: GRAPH OVERVIEW */}
              {activeTab === 'overview' && (
                <div className="workflow-pane pane-overview" data-testid="pane-overview">
                  <div className="overview-summary-card">
                    <h3>Workflow Summary for {activeFunction.name}</h3>
                    <div className="summary-metrics">
                      <div className="metric">
                        <span className="metric-val">{currentWorkflowSteps.length}</span>
                        <span className="metric-label">Total Steps</span>
                      </div>
                      <div className="metric">
                        <span className="metric-val">{currentWorkflowEdges.length}</span>
                        <span className="metric-label">Transitions</span>
                      </div>
                      <div className="metric">
                        <span className="metric-val">
                          {currentWorkflowSteps.filter(s => s.stepType === 'loop').length}
                        </span>
                        <span className="metric-label">Loops</span>
                      </div>
                      <div className="metric">
                        <span className="metric-val">
                          {currentWorkflowSteps.filter(s => s.stepType === 'condition').length}
                        </span>
                        <span className="metric-label">Conditions</span>
                      </div>
                      <div className="metric">
                        <span className="metric-val">
                          {currentWorkflowSteps.filter(s => s.stepType === 'return').length}
                        </span>
                        <span className="metric-label">Returns</span>
                      </div>
                    </div>
                  </div>

                  <div className="overview-steps-flow" data-testid="overview-steps-flow">
                    <h4>Step Flow Sequence</h4>
                    {currentWorkflowSteps.length === 0 ? (
                      <p className="text-muted">No steps defined in this workflow.</p>
                    ) : (
                      <ul className="flow-step-list">
                        {currentWorkflowSteps.map(step => {
                          const outgoing = currentWorkflowEdges.filter(e => e.source === step.id);
                          return (
                            <li key={step.id} className="flow-step-item">
                              <div className="flow-step-badge-wrap">
                                <span className={`step-type-pill step-type-${step.stepType}`}>
                                  {step.stepType}
                                </span>
                                <strong>{step.name}</strong>
                              </div>
                              {outgoing.length > 0 && (
                                <div className="flow-outgoing-links">
                                  {outgoing.map(out => {
                                    const tgt = graph?.nodes.find(n => n.id === out.target);
                                    return (
                                      <span key={out.id} className="flow-edge-badge">
                                        --[{out.kind}{out.label ? `: "${out.label}"` : ''}]--&gt;{' '}
                                        {tgt?.name || out.target}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 5: REMOVE WORKFLOW */}
              {activeTab === 'remove' && (
                <div className="workflow-pane pane-remove" data-testid="pane-remove">
                  <div className="remove-workflow-card">
                    <div className="card-warning-header">
                      <AlertTriangle size={20} className="warning-icon" />
                      <div>
                        <h3>Remove Detailed Workflow</h3>
                        <p>
                          Remove the detailed workflow while retaining the function contract and acceptance scenarios.
                        </p>
                      </div>
                    </div>

                    <div className="remove-details-list">
                      <div className="detail-item">
                        <CheckCircle2 size={16} className="text-success" />
                        <span>
                          <strong>Function Preserved:</strong> Name ({activeFunction.name}), policy, and output path remain unchanged.
                        </span>
                      </div>
                      <div className="detail-item">
                        <CheckCircle2 size={16} className="text-success" />
                        <span>
                          <strong>Contract Preserved:</strong> Interface definition and signatures remain intact.
                        </span>
                      </div>
                      <div className="detail-item">
                        <CheckCircle2 size={16} className="text-success" />
                        <span>
                          <strong>Scenarios Preserved:</strong> All acceptance scenarios ({activeFunction.scenarios?.length || 0}) remain intact.
                        </span>
                      </div>
                      <div className="detail-item">
                        <CheckCircle2 size={16} className="text-success" />
                        <span>
                          <strong>Specification Validity:</strong> The resulting graph is immediately valid as a description-only or contract-only function.
                        </span>
                      </div>
                    </div>

                    <div className="removal-impact-summary">
                      <p>
                        This operation will delete <strong>{currentWorkflowSteps.length} workflow steps</strong> and{' '}
                        <strong>{currentWorkflowEdges.length} transitions</strong> attached to {activeFunction.name}.
                      </p>
                    </div>

                    {!readOnly && (
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={currentWorkflowSteps.length === 0}
                        onClick={handleRemoveWorkflowSubmit}
                        data-testid="remove-workflow-submit-btn"
                      >
                        <Trash2 size={16} />
                        <span>Remove Workflow (Retain Function & Contract)</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
