import React, { useState, useMemo, useEffect } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Requirement, Project } from '../../shared/model';
import { GraphSchema, createNodeId, validRelationship } from '../../shared/model';
import {
  Terminal,
  Plus,
  Trash2,
  Edit3,
  CheckCircle2,
  AlertCircle,
  X,
  Shield,
  Info,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  List,
  FileCode,
  Check,
  RotateCcw,
} from 'lucide-react';

export const WORKFLOW_OPTIONAL_NOTICE =
  'A workflow is never mandatory: functions can be specified as description-only or enriched with contracts, rules, errors, and acceptance scenarios without defining workflow steps.';

export interface CreateFunctionInput {
  name: string;
  parentId?: string;
  description?: string;
  contract?: string;
  inputs?: string;
  outputs?: string;
  rules?: string;
  errors?: string;
  scenarios?: string[];
  policy?: ProgramNode['policy'];
  requiredChecks?: string[];
  instructions?: string;
  outputPath?: string;
  id?: string;
}

export interface UpdateFunctionInput {
  name?: string;
  parentId?: string | null;
  description?: string;
  contract?: string;
  inputs?: string | null;
  outputs?: string | null;
  rules?: string | null;
  errors?: string | null;
  scenarios?: string[] | null;
  policy?: ProgramNode['policy'];
  requiredChecks?: string[];
  instructions?: string;
  outputPath?: string;
}

export interface FunctionEditorProps {
  project?: Project | null;
  graph: Graph | null;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  isOpen?: boolean;
  onClose?: () => void;
  mode?: 'modal' | 'panel' | 'inline';
  readOnly?: boolean;
  initialTab?: 'details' | 'contract' | 'scenarios' | 'add';
}

/**
 * Returns true if the parent kind can contain a function node according to containment rules.
 */
export function canNestInFunction(parentKind: ProgramNode['kind']): boolean {
  return validRelationship('contains', parentKind, 'function');
}

/**
 * Checks whether a function is description-only (all workflow details, inputs, outputs,
 * rules, errors, and scenarios are omitted or empty).
 */
export function isDescriptionOnlyFunction(node: ProgramNode): boolean {
  if (node.kind !== 'function') return false;
  const hasInputs = node.inputs !== undefined && node.inputs !== '';
  const hasOutputs = node.outputs !== undefined && node.outputs !== '';
  const hasRules = node.rules !== undefined && node.rules !== '';
  const hasErrors = node.errors !== undefined && node.errors !== '';
  const hasScenarios = node.scenarios !== undefined && node.scenarios.length > 0;
  return !hasInputs && !hasOutputs && !hasRules && !hasErrors && !hasScenarios;
}

/**
 * Checks whether a function is detailed (contains inputs, outputs, rules, errors, or scenarios).
 */
export function isDetailedFunction(node: ProgramNode): boolean {
  return node.kind === 'function' && !isDescriptionOnlyFunction(node);
}

/**
 * Checks whether any workflow steps are attached to this function.
 * Note: Workflow steps are never mandatory.
 */
export function hasWorkflow(graph: Graph, nodeId: string): boolean {
  return graph.nodes.some(n => n.kind === 'step' && n.parentId === nodeId);
}

/**
 * Gets all function nodes present in the graph.
 */
export function getFunctionNodes(graph: Graph): ProgramNode[] {
  return graph.nodes.filter(n => n.kind === 'function');
}

/**
 * Creates a function node in the graph, supporting both description-only and detailed functions.
 * Validates schema and containment relationships. Preserves multiline strings.
 */
export function createFunctionNode(
  graph: Graph,
  input: CreateFunctionInput
): { graph: Graph; node: ProgramNode } {
  if (!input.name.trim()) {
    throw new Error('Function name must not be blank');
  }

  if (input.parentId) {
    const parent = graph.nodes.find(n => n.id === input.parentId);
    if (!parent) {
      throw new Error(`Parent node does not exist: ${input.parentId}`);
    }
    if (!canNestInFunction(parent.kind)) {
      throw new Error(`Invalid nesting: ${parent.kind} cannot contain function`);
    }
  }

  const nodeId = input.id || createNodeId();
  if (graph.nodes.some(n => n.id === nodeId)) {
    throw new Error(`Duplicate node ID: ${nodeId}`);
  }

  const newNode: ProgramNode = {
    id: nodeId,
    kind: 'function',
    name: input.name.trim(),
    parentId: input.parentId || undefined,
    description: input.description !== undefined ? input.description : '',
    provenance: 'human',
    policy: input.policy || 'editable',
    contract: input.contract !== undefined ? input.contract : '',
    requiredChecks: input.requiredChecks || [],
    instructions: input.instructions !== undefined ? input.instructions : '',
    outputPath: input.outputPath !== undefined ? input.outputPath : '',
    fields: [],
  };

  if (input.inputs !== undefined) newNode.inputs = input.inputs;
  if (input.outputs !== undefined) newNode.outputs = input.outputs;
  if (input.rules !== undefined) newNode.rules = input.rules;
  if (input.errors !== undefined) newNode.errors = input.errors;
  if (input.scenarios !== undefined) newNode.scenarios = [...input.scenarios];

  const nextGraph: Graph = {
    ...graph,
    nodes: [...graph.nodes, newNode],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating function node');
  }

  return { graph: validation.data, node: newNode };
}

/**
 * Updates a function node while strictly preserving its stable ID and all references.
 * Allows editing description, inputs, outputs, rules, errors, scenarios, and contract.
 * Allows omitting/clearing details (converting to description-only or keeping incomplete details).
 * Preserves multiline specification text verbatim.
 */
export function updateFunctionNode(
  graph: Graph,
  nodeId: string,
  updates: UpdateFunctionInput
): { graph: Graph; node: ProgramNode } {
  const existingNode = graph.nodes.find(n => n.id === nodeId);
  if (!existingNode) {
    throw new Error(`Function node not found: ${nodeId}`);
  }
  if (existingNode.kind !== 'function') {
    throw new Error(`Node ${nodeId} is not a function (kind: ${existingNode.kind})`);
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existingNode.name;
  if (!nextName) {
    throw new Error('Function name must not be blank');
  }

  let nextParentId: string | undefined = existingNode.parentId;
  if (updates.parentId !== undefined) {
    if (updates.parentId === null || updates.parentId === '') {
      nextParentId = undefined;
    } else {
      if (updates.parentId === nodeId) {
        throw new Error('A function cannot be its own parent');
      }
      const parentNode = graph.nodes.find(n => n.id === updates.parentId);
      if (!parentNode) {
        throw new Error(`Parent node does not exist: ${updates.parentId}`);
      }
      if (!canNestInFunction(parentNode.kind)) {
        throw new Error(`Invalid nesting: ${parentNode.kind} cannot contain function`);
      }
      nextParentId = updates.parentId;
    }
  }

  const updatedNode: ProgramNode = {
    ...existingNode,
    name: nextName,
    description: updates.description !== undefined ? updates.description : existingNode.description,
    contract: updates.contract !== undefined ? updates.contract : existingNode.contract,
    parentId: nextParentId,
    policy: updates.policy !== undefined ? updates.policy : existingNode.policy,
    requiredChecks: updates.requiredChecks !== undefined ? updates.requiredChecks : existingNode.requiredChecks,
    instructions: updates.instructions !== undefined ? updates.instructions : existingNode.instructions,
    outputPath: updates.outputPath !== undefined ? updates.outputPath : existingNode.outputPath,
  };

  // Inputs
  if (updates.inputs !== undefined) {
    if (updates.inputs === null) {
      delete updatedNode.inputs;
    } else {
      updatedNode.inputs = updates.inputs;
    }
  }

  // Outputs
  if (updates.outputs !== undefined) {
    if (updates.outputs === null) {
      delete updatedNode.outputs;
    } else {
      updatedNode.outputs = updates.outputs;
    }
  }

  // Rules
  if (updates.rules !== undefined) {
    if (updates.rules === null) {
      delete updatedNode.rules;
    } else {
      updatedNode.rules = updates.rules;
    }
  }

  // Errors
  if (updates.errors !== undefined) {
    if (updates.errors === null) {
      delete updatedNode.errors;
    } else {
      updatedNode.errors = updates.errors;
    }
  }

  // Scenarios
  if (updates.scenarios !== undefined) {
    if (updates.scenarios === null) {
      delete updatedNode.scenarios;
    } else {
      updatedNode.scenarios = [...updates.scenarios];
    }
  }

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating function node');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Removes a function node, its incident edges, and re-parents or cleans child elements.
 * Preserves requirement definitions while removing references to this node.
 */
export function removeFunctionNode(
  graph: Graph,
  nodeId: string
): { graph: Graph; removedNode: ProgramNode } {
  const targetNode = graph.nodes.find(n => n.id === nodeId);
  if (!targetNode) {
    throw new Error(`Function node not found: ${nodeId}`);
  }

  const removedEdges = graph.edges.filter(e => e.source === nodeId || e.target === nodeId);
  const removedEdgeIds = new Set(removedEdges.map(e => e.id));

  // Re-parent child nodes to targetNode's parent
  const nextNodes = graph.nodes
    .filter(n => n.id !== nodeId)
    .map(n => {
      if (n.parentId === nodeId) {
        return { ...n, parentId: targetNode.parentId };
      }
      return n;
    });

  const nextEdges = graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

  const preservedRequirements: Requirement[] = graph.requirements.map(req => ({
    ...req,
    nodeIds: req.nodeIds.filter(id => id !== nodeId),
    edgeIds: req.edgeIds.filter(id => !removedEdgeIds.has(id)),
  }));

  const nextGraph: Graph = {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
    requirements: preservedRequirements,
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing function node');
  }

  return { graph: validation.data, removedNode: targetNode };
}

/**
 * Appends an acceptance scenario to a function node.
 */
export function addFunctionScenario(
  graph: Graph,
  nodeId: string,
  scenarioText: string
): { graph: Graph; node: ProgramNode } {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) {
    throw new Error(`Function node not found: ${nodeId}`);
  }
  const currentScenarios = node.scenarios ? [...node.scenarios] : [];
  currentScenarios.push(scenarioText);

  return updateFunctionNode(graph, nodeId, { scenarios: currentScenarios });
}

/**
 * Updates an acceptance scenario at a specific index in a function node.
 */
export function updateFunctionScenario(
  graph: Graph,
  nodeId: string,
  index: number,
  scenarioText: string
): { graph: Graph; node: ProgramNode } {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) {
    throw new Error(`Function node not found: ${nodeId}`);
  }
  const currentScenarios = node.scenarios ? [...node.scenarios] : [];
  if (index < 0 || index >= currentScenarios.length) {
    throw new Error(`Scenario index out of bounds: ${index}`);
  }
  currentScenarios[index] = scenarioText;

  return updateFunctionNode(graph, nodeId, { scenarios: currentScenarios });
}

/**
 * Removes an acceptance scenario at a specific index from a function node.
 */
export function removeFunctionScenario(
  graph: Graph,
  nodeId: string,
  index: number
): { graph: Graph; node: ProgramNode } {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) {
    throw new Error(`Function node not found: ${nodeId}`);
  }
  const currentScenarios = node.scenarios ? [...node.scenarios] : [];
  if (index < 0 || index >= currentScenarios.length) {
    throw new Error(`Scenario index out of bounds: ${index}`);
  }
  currentScenarios.splice(index, 1);

  return updateFunctionNode(graph, nodeId, { scenarios: currentScenarios });
}

/**
 * Clears inputs, outputs, rules, errors, and scenarios from a function node,
 * converting it back to a pure description-only function while preserving its identity and description.
 */
export function clearFunctionDetails(
  graph: Graph,
  nodeId: string
): { graph: Graph; node: ProgramNode } {
  return updateFunctionNode(graph, nodeId, {
    inputs: null,
    outputs: null,
    rules: null,
    errors: null,
    scenarios: null,
  });
}

export const FunctionEditor: React.FC<FunctionEditorProps> = ({
  project,
  graph,
  onUpdateSpecification,
  selectedNodeId,
  onSelectNode,
  isOpen = true,
  onClose,
  mode = 'modal',
  readOnly = false,
  initialTab = 'details',
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'contract' | 'scenarios' | 'add'>(initialTab);
  const functionNodes = useMemo(() => (graph ? getFunctionNodes(graph) : []), [graph]);
  const allNodes = useMemo(() => graph?.nodes || [], [graph]);

  // Potential parent nodes: system, module, class, interface, function
  const potentialParents = useMemo(() => {
    return allNodes.filter(n => canNestInFunction(n.kind));
  }, [allNodes]);

  const initialFunctionNode = useMemo(() => {
    if (selectedNodeId) {
      const match = functionNodes.find(n => n.id === selectedNodeId);
      if (match) return match;
    }
    return functionNodes.length > 0 ? functionNodes[0] : null;
  }, [selectedNodeId, functionNodes]);

  const [activeFunctionId, setActiveFunctionId] = useState<string>(initialFunctionNode?.id || '');

  // Form State for Active Function
  const [name, setName] = useState<string>(initialFunctionNode?.name || '');
  const [parentId, setParentId] = useState<string>(initialFunctionNode?.parentId || '');
  const [description, setDescription] = useState<string>(initialFunctionNode?.description || '');
  const [contract, setContract] = useState<string>(initialFunctionNode?.contract || '');
  const [inputs, setInputs] = useState<string>(initialFunctionNode?.inputs ?? '');
  const [outputs, setOutputs] = useState<string>(initialFunctionNode?.outputs ?? '');
  const [rules, setRules] = useState<string>(initialFunctionNode?.rules ?? '');
  const [errors, setErrors] = useState<string>(initialFunctionNode?.errors ?? '');
  const [scenarios, setScenarios] = useState<string[]>(initialFunctionNode?.scenarios ?? []);
  const [policy, setPolicy] = useState<ProgramNode['policy']>(initialFunctionNode?.policy || 'editable');
  const [outputPath, setOutputPath] = useState<string>(initialFunctionNode?.outputPath || '');

  // Scenario addition input state
  const [newScenarioText, setNewScenarioText] = useState<string>('');

  // Add New Function Form State
  const [addName, setAddName] = useState<string>('');
  const [addParentId, setAddParentId] = useState<string>('');
  const [addDescription, setAddDescription] = useState<string>('');
  const [addContract, setAddContract] = useState<string>('');
  const [addIsDetailed, setAddIsDetailed] = useState<boolean>(false);
  const [addInputs, setAddInputs] = useState<string>('');
  const [addOutputs, setAddOutputs] = useState<string>('');
  const [addRules, setAddRules] = useState<string>('');
  const [addErrors, setAddErrors] = useState<string>('');
  const [addScenario, setAddScenario] = useState<string>('');
  const [addPolicy, setAddPolicy] = useState<ProgramNode['policy']>('editable');
  const [addOutputPath, setAddOutputPath] = useState<string>('');

  // Status/Error feedback
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sync selectedNodeId prop
  useEffect(() => {
    if (selectedNodeId) {
      const target = functionNodes.find(n => n.id === selectedNodeId);
      if (target) {
        setActiveFunctionId(selectedNodeId);
      }
    }
  }, [selectedNodeId, functionNodes]);

  // Load active function fields
  useEffect(() => {
    if (!activeFunctionId) {
      if (functionNodes.length > 0) {
        setActiveFunctionId(functionNodes[0].id);
      }
      return;
    }
    const node = functionNodes.find(n => n.id === activeFunctionId);
    if (node) {
      setName(node.name);
      setParentId(node.parentId || '');
      setDescription(node.description || '');
      setContract(node.contract || '');
      setInputs(node.inputs ?? '');
      setOutputs(node.outputs ?? '');
      setRules(node.rules ?? '');
      setErrors(node.errors ?? '');
      setScenarios(node.scenarios ? [...node.scenarios] : []);
      setPolicy(node.policy || 'editable');
      setOutputPath(node.outputPath || '');
    }
  }, [activeFunctionId, functionNodes]);

  const activeNode = useMemo(() => {
    return functionNodes.find(n => n.id === activeFunctionId) || null;
  }, [activeFunctionId, functionNodes]);

  const isCurrentDescOnly = useMemo(() => {
    if (!activeNode) return true;
    return isDescriptionOnlyFunction(activeNode);
  }, [activeNode]);

  const currentHasWorkflow = useMemo(() => {
    if (!graph || !activeNode) return false;
    return hasWorkflow(graph, activeNode.id);
  }, [graph, activeNode]);

  // Handlers
  const handleSelectFunction = (id: string) => {
    setActiveFunctionId(id);
    if (onSelectNode) onSelectNode(id);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleSaveActiveFunction = async () => {
    if (!graph || !activeFunctionId) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      // Determine what to pass for optional detail fields:
      // If the field has string content, pass it. If empty and previously set, pass empty string or null.
      const updates: UpdateFunctionInput = {
        name,
        parentId: parentId || null,
        description,
        contract,
        policy,
        outputPath,
        inputs: inputs !== '' ? inputs : (activeNode?.inputs !== undefined ? null : undefined),
        outputs: outputs !== '' ? outputs : (activeNode?.outputs !== undefined ? null : undefined),
        rules: rules !== '' ? rules : (activeNode?.rules !== undefined ? null : undefined),
        errors: errors !== '' ? errors : (activeNode?.errors !== undefined ? null : undefined),
        scenarios: scenarios.length > 0 ? scenarios : (activeNode?.scenarios !== undefined ? null : undefined),
      };

      const result = updateFunctionNode(graph, activeFunctionId, updates);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      setSuccessMessage(`Successfully updated function "${result.node.name}". Stable ID preserved.`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update function');
    }
  };

  const handleClearDetails = async () => {
    if (!graph || !activeFunctionId) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const result = clearFunctionDetails(graph, activeFunctionId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      setInputs('');
      setOutputs('');
      setRules('');
      setErrors('');
      setScenarios([]);
      setSuccessMessage(`Converted "${result.node.name}" to description-only function. All incomplete details cleared.`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to clear details');
    }
  };

  const handleDeleteActiveFunction = async () => {
    if (!graph || !activeFunctionId) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const result = removeFunctionNode(graph, activeFunctionId);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }
      const remaining = getFunctionNodes(result.graph);
      if (remaining.length > 0) {
        setActiveFunctionId(remaining[0].id);
        if (onSelectNode) onSelectNode(remaining[0].id);
      } else {
        setActiveFunctionId('');
        if (onSelectNode) onSelectNode(null);
      }
      setSuccessMessage(`Removed function "${result.removedNode.name}".`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to remove function');
    }
  };

  const handleAddScenario = () => {
    if (!newScenarioText) return;
    setScenarios(prev => [...prev, newScenarioText]);
    setNewScenarioText('');
  };

  const handleUpdateScenario = (index: number, val: string) => {
    setScenarios(prev => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  const handleRemoveScenario = (index: number) => {
    setScenarios(prev => prev.filter((_, i) => i !== index));
  };

  const handleMoveScenario = (index: number, direction: 'up' | 'down') => {
    setScenarios(prev => {
      const next = [...prev];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= next.length) return prev;
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  };

  const handleCreateFunction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!graph) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const input: CreateFunctionInput = {
        name: addName,
        parentId: addParentId || undefined,
        description: addDescription,
        contract: addContract,
        policy: addPolicy,
        outputPath: addOutputPath,
      };

      if (addIsDetailed) {
        if (addInputs) input.inputs = addInputs;
        if (addOutputs) input.outputs = addOutputs;
        if (addRules) input.rules = addRules;
        if (addErrors) input.errors = addErrors;
        if (addScenario) input.scenarios = [addScenario];
      }

      const result = createFunctionNode(graph, input);
      if (onUpdateSpecification) {
        await onUpdateSpecification(result.graph);
      }

      setActiveFunctionId(result.node.id);
      if (onSelectNode) onSelectNode(result.node.id);
      setActiveTab('details');

      // Reset add form
      setAddName('');
      setAddParentId('');
      setAddDescription('');
      setAddContract('');
      setAddIsDetailed(false);
      setAddInputs('');
      setAddOutputs('');
      setAddRules('');
      setAddErrors('');
      setAddScenario('');
      setAddOutputPath('');

      setSuccessMessage(`Created function "${result.node.name}" (${addIsDetailed ? 'Detailed' : 'Description-only'}).`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to create function');
    }
  };

  if (mode === 'modal' && !isOpen) {
    return null;
  }

  const content = (
    <div className="function-editor-container" data-testid="function-editor-container">
      {/* Header */}
      <div className="function-editor-header">
        <div className="function-header-title">
          <Terminal className="function-header-icon" size={20} />
          <div>
            <h2>Function Specifications & Contracts</h2>
            <span className="function-subtitle">R02: Description-only & detailed functions coexist · Workflow optional</span>
          </div>
        </div>
        {onClose && (
          <button
            className="btn-close-function"
            onClick={onClose}
            title="Close editor"
            data-testid="close-function-editor"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Workflow Optional Callout */}
      <div className="function-workflow-notice" data-testid="workflow-optional-notice">
        <Info size={14} className="notice-icon" />
        <span>{WORKFLOW_OPTIONAL_NOTICE}</span>
      </div>

      {/* Tabs */}
      <div className="function-tabs" role="tablist">
        <button
          className={`function-tab ${activeTab === 'details' ? 'active' : ''}`}
          onClick={() => setActiveTab('details')}
          data-testid="function-tab-details"
          role="tab"
          aria-selected={activeTab === 'details'}
        >
          <FileCode size={14} />
          <span>Overview & Metadata</span>
        </button>
        <button
          className={`function-tab ${activeTab === 'contract' ? 'active' : ''}`}
          onClick={() => setActiveTab('contract')}
          data-testid="function-tab-contract"
          role="tab"
          aria-selected={activeTab === 'contract'}
        >
          <Edit3 size={14} />
          <span>Inputs, Outputs & Rules</span>
        </button>
        <button
          className={`function-tab ${activeTab === 'scenarios' ? 'active' : ''}`}
          onClick={() => setActiveTab('scenarios')}
          data-testid="function-tab-scenarios"
          role="tab"
          aria-selected={activeTab === 'scenarios'}
        >
          <List size={14} />
          <span>Acceptance Scenarios ({scenarios.length})</span>
        </button>
        <button
          className={`function-tab ${activeTab === 'add' ? 'active' : ''}`}
          onClick={() => setActiveTab('add')}
          data-testid="function-tab-add"
          role="tab"
          aria-selected={activeTab === 'add'}
        >
          <Plus size={14} />
          <span>Add Function</span>
        </button>
      </div>

      {/* Alerts */}
      {errorMessage && (
        <div className="function-alert alert-error" data-testid="function-error-alert">
          <AlertCircle size={16} />
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="alert-dismiss"><X size={14} /></button>
        </div>
      )}
      {successMessage && (
        <div className="function-alert alert-success" data-testid="function-success-alert">
          <CheckCircle2 size={16} />
          <span>{successMessage}</span>
          <button onClick={() => setSuccessMessage(null)} className="alert-dismiss"><X size={14} /></button>
        </div>
      )}

      {/* Body Content */}
      <div className="function-editor-body">
        {/* TAB 1: DETAILS & METADATA */}
        {activeTab === 'details' && (
          <div className="function-tab-pane" data-testid="pane-details">
            {functionNodes.length === 0 ? (
              <div className="function-empty-state">
                <p>No functions found in this graph. Create one using the "Add Function" tab.</p>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setActiveTab('add')}
                  data-testid="empty-go-to-add-btn"
                >
                  <Plus size={14} />
                  <span>Create Function</span>
                </button>
              </div>
            ) : (
              <>
                <div className="function-selector-bar">
                  <label htmlFor="function-select">Active Function:</label>
                  <select
                    id="function-select"
                    className="function-select-input"
                    value={activeFunctionId}
                    onChange={e => handleSelectFunction(e.target.value)}
                    data-testid="function-select"
                  >
                    {functionNodes.map(fn => (
                      <option key={fn.id} value={fn.id}>
                        {fn.name} {isDescriptionOnlyFunction(fn) ? '(Description-only)' : '(Detailed)'}
                      </option>
                    ))}
                  </select>

                  <div className="function-badges">
                    {isCurrentDescOnly ? (
                      <span className="badge badge-desc-only" data-testid="badge-description-only">
                        Description-only
                      </span>
                    ) : (
                      <span className="badge badge-detailed" data-testid="badge-detailed">
                        Detailed Contract
                      </span>
                    )}
                    <span className="badge badge-no-workflow" data-testid="badge-workflow-status">
                      {currentHasWorkflow ? 'Has workflow steps' : 'No workflow steps (Optional)'}
                    </span>
                  </div>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label htmlFor="function-name-input">Function Name *</label>
                    <input
                      id="function-name-input"
                      type="text"
                      className="form-control"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="e.g. calculateInvoiceTotal"
                      disabled={readOnly}
                      data-testid="function-name-input"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-parent-select">Parent Container (Optional)</label>
                    <select
                      id="function-parent-select"
                      className="form-control"
                      value={parentId}
                      onChange={e => setParentId(e.target.value)}
                      disabled={readOnly}
                      data-testid="function-parent-select"
                    >
                      <option value="">(None - Top-level)</option>
                      {potentialParents
                        .filter(p => p.id !== activeFunctionId)
                        .map(p => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.kind})
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-policy-select">Protection Policy</label>
                    <select
                      id="function-policy-select"
                      className="form-control"
                      value={policy}
                      onChange={e => setPolicy(e.target.value as ProgramNode['policy'])}
                      disabled={readOnly}
                      data-testid="function-policy-select"
                    >
                      <option value="editable">editable</option>
                      <option value="sensitive">sensitive</option>
                      <option value="frozen-implementation">frozen-implementation</option>
                      <option value="frozen-contract">frozen-contract</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-output-path-input">Output / Target File Path</label>
                    <input
                      id="function-output-path-input"
                      type="text"
                      className="form-control"
                      value={outputPath}
                      onChange={e => setOutputPath(e.target.value)}
                      placeholder="e.g. src/billing/calculator.ts"
                      disabled={readOnly}
                      data-testid="function-output-path-input"
                    />
                  </div>
                </div>

                <div className="form-group full-width">
                  <label htmlFor="function-contract-input">Contract / Signature</label>
                  <textarea
                    id="function-contract-input"
                    className="form-control mono-textarea"
                    rows={2}
                    value={contract}
                    onChange={e => setContract(e.target.value)}
                    placeholder="e.g. export function calculateTotal(items: InvoiceItem[]): Promise<Money>"
                    disabled={readOnly}
                    data-testid="function-contract-input"
                  />
                  <small className="form-hint">Declared TypeScript contract or signature.</small>
                </div>

                <div className="form-group full-width">
                  <label htmlFor="function-description-input">Description (Multiline)</label>
                  <textarea
                    id="function-description-input"
                    className="form-control"
                    rows={4}
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="High-level description of function behavior and intent..."
                    disabled={readOnly}
                    data-testid="function-description-input"
                  />
                  <small className="form-hint">Multiline specification text is preserved verbatim across edits.</small>
                </div>

                <div className="function-actions-bar">
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveActiveFunction}
                    disabled={readOnly}
                    data-testid="function-save-btn"
                  >
                    <Check size={14} />
                    <span>Save Changes</span>
                  </button>

                  {!isCurrentDescOnly && (
                    <button
                      className="btn btn-outline"
                      onClick={handleClearDetails}
                      disabled={readOnly}
                      title="Clear inputs, outputs, rules, errors, and scenarios"
                      data-testid="function-clear-details-btn"
                    >
                      <RotateCcw size={14} />
                      <span>Make Description-Only</span>
                    </button>
                  )}

                  <button
                    className="btn btn-outline-danger"
                    onClick={handleDeleteActiveFunction}
                    disabled={readOnly}
                    data-testid="function-delete-btn"
                  >
                    <Trash2 size={14} />
                    <span>Delete Function</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 2: INPUTS, OUTPUTS, RULES, ERRORS */}
        {activeTab === 'contract' && (
          <div className="function-tab-pane" data-testid="pane-contract">
            {!activeNode ? (
              <p>Please select or create a function first.</p>
            ) : (
              <>
                <div className="contract-header-row">
                  <div>
                    <h3>Contract Specifications for <code>{activeNode.name}</code></h3>
                    <p className="section-note">
                      Define typed inputs, outputs, operational rules, and error conditions.
                      All fields support multiline text and remain optional.
                    </p>
                  </div>
                  <div className="badge-wrapper">
                    {isCurrentDescOnly ? (
                      <span className="badge badge-desc-only">Description-only</span>
                    ) : (
                      <span className="badge badge-detailed">Detailed</span>
                    )}
                  </div>
                </div>

                <div className="contract-fields-grid">
                  <div className="form-group">
                    <label htmlFor="function-inputs-input">Inputs (Multiline)</label>
                    <textarea
                      id="function-inputs-input"
                      className="form-control mono-textarea"
                      rows={5}
                      value={inputs}
                      onChange={e => setInputs(e.target.value)}
                      placeholder={"document: Document\ndestination: string\noptions?: SaveOptions"}
                      disabled={readOnly}
                      data-testid="function-inputs-input"
                    />
                    <small className="form-hint">Typed parameters, arguments, or preconditions.</small>
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-outputs-input">Outputs (Multiline)</label>
                    <textarea
                      id="function-outputs-input"
                      className="form-control mono-textarea"
                      rows={5}
                      value={outputs}
                      onChange={e => setOutputs(e.target.value)}
                      placeholder={"Promise<void>\nReturns saved document metadata"}
                      disabled={readOnly}
                      data-testid="function-outputs-input"
                    />
                    <small className="form-hint">Return types, promises, or postcondition guarantees.</small>
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-rules-input">Rules & Invariants (Multiline)</label>
                    <textarea
                      id="function-rules-input"
                      className="form-control"
                      rows={5}
                      value={rules}
                      onChange={e => setRules(e.target.value)}
                      placeholder={"Atomic write: keep original until success\nValidate schema prior to write\nAudit log on write"}
                      disabled={readOnly}
                      data-testid="function-rules-input"
                    />
                    <small className="form-hint">Business rules, constraints, and ordering guarantees.</small>
                  </div>

                  <div className="form-group">
                    <label htmlFor="function-errors-input">Errors & Exceptions (Multiline)</label>
                    <textarea
                      id="function-errors-input"
                      className="form-control mono-textarea"
                      rows={5}
                      value={errors}
                      onChange={e => setErrors(e.target.value)}
                      placeholder={"DiskFull: Storage capacity exceeded\nPermissionDenied: Read-only directory\nInvalidDocumentError: Format mismatch"}
                      disabled={readOnly}
                      data-testid="function-errors-input"
                    />
                    <small className="form-hint">Expected failure modes, exceptions, and error conditions.</small>
                  </div>
                </div>

                <div className="function-actions-bar">
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveActiveFunction}
                    disabled={readOnly}
                    data-testid="function-contract-save-btn"
                  >
                    <Check size={14} />
                    <span>Save Contract Details</span>
                  </button>

                  <button
                    className="btn btn-outline"
                    onClick={handleClearDetails}
                    disabled={readOnly}
                    data-testid="function-contract-clear-btn"
                  >
                    <RotateCcw size={14} />
                    <span>Clear All Contract Details</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 3: ACCEPTANCE SCENARIOS */}
        {activeTab === 'scenarios' && (
          <div className="function-tab-pane" data-testid="pane-scenarios">
            {!activeNode ? (
              <p>Please select or create a function first.</p>
            ) : (
              <>
                <div className="scenarios-header-row">
                  <div>
                    <h3>Acceptance Scenarios for <code>{activeNode.name}</code></h3>
                    <p className="section-note">
                      Concrete behavior scenarios (e.g. Given / When / Then). Multiline formatting is preserved verbatim.
                    </p>
                  </div>
                </div>

                <div className="scenarios-list" data-testid="scenarios-list">
                  {scenarios.length === 0 ? (
                    <div className="scenario-empty-notice" data-testid="no-scenarios-notice">
                      No acceptance scenarios specified yet for this function.
                    </div>
                  ) : (
                    scenarios.map((sc, index) => (
                      <div className="scenario-card" key={index} data-testid={`scenario-card-${index}`}>
                        <div className="scenario-card-header">
                          <span className="scenario-index">Scenario #{index + 1}</span>
                          <div className="scenario-card-controls">
                            <button
                              className="btn-icon btn-xs"
                              disabled={index === 0 || readOnly}
                              onClick={() => handleMoveScenario(index, 'up')}
                              title="Move up"
                              data-testid={`scenario-move-up-${index}`}
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              className="btn-icon btn-xs"
                              disabled={index === scenarios.length - 1 || readOnly}
                              onClick={() => handleMoveScenario(index, 'down')}
                              title="Move down"
                              data-testid={`scenario-move-down-${index}`}
                            >
                              <ChevronDown size={14} />
                            </button>
                            <button
                              className="btn-icon btn-xs text-danger"
                              disabled={readOnly}
                              onClick={() => handleRemoveScenario(index)}
                              title="Remove scenario"
                              data-testid={`scenario-delete-btn-${index}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        <textarea
                          className="form-control scenario-textarea"
                          rows={3}
                          value={sc}
                          onChange={e => handleUpdateScenario(index, e.target.value)}
                          disabled={readOnly}
                          data-testid={`scenario-textarea-${index}`}
                        />
                      </div>
                    ))
                  )}
                </div>

                {/* Add New Scenario Form */}
                <div className="add-scenario-box">
                  <h4>Add New Acceptance Scenario</h4>
                  <textarea
                    className="form-control"
                    rows={3}
                    value={newScenarioText}
                    onChange={e => setNewScenarioText(e.target.value)}
                    placeholder={"Given a valid document\nWhen save is called\nThen write atomically and return success ✓"}
                    disabled={readOnly}
                    data-testid="new-scenario-textarea"
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleAddScenario}
                    disabled={!newScenarioText.trim() || readOnly}
                    data-testid="add-scenario-btn"
                  >
                    <Plus size={14} />
                    <span>Add Scenario</span>
                  </button>
                </div>

                <div className="function-actions-bar">
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveActiveFunction}
                    disabled={readOnly}
                    data-testid="function-scenarios-save-btn"
                  >
                    <Check size={14} />
                    <span>Save Scenarios</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 4: ADD NEW FUNCTION */}
        {activeTab === 'add' && (
          <form className="function-tab-pane" onSubmit={handleCreateFunction} data-testid="pane-add">
            <h3>Create Function</h3>
            <p className="section-note">
              Create a new function. Choose between a lightweight description-only function or
              include detailed inputs, outputs, rules, errors, and scenarios. Workflows remain optional.
            </p>

            <div className="form-grid">
              <div className="form-group">
                <label htmlFor="add-function-name-input">Function Name *</label>
                <input
                  id="add-function-name-input"
                  type="text"
                  className="form-control"
                  value={addName}
                  onChange={e => setAddName(e.target.value)}
                  placeholder="e.g. processOrder"
                  required
                  data-testid="add-function-name-input"
                />
              </div>

              <div className="form-group">
                <label htmlFor="add-function-parent-select">Parent Container (Optional)</label>
                <select
                  id="add-function-parent-select"
                  className="form-control"
                  value={addParentId}
                  onChange={e => setAddParentId(e.target.value)}
                  data-testid="add-function-parent-select"
                >
                  <option value="">(None - Top-level)</option>
                  {potentialParents.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.kind})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="add-function-policy-select">Policy</label>
                <select
                  id="add-function-policy-select"
                  className="form-control"
                  value={addPolicy}
                  onChange={e => setAddPolicy(e.target.value as ProgramNode['policy'])}
                  data-testid="add-function-policy-select"
                >
                  <option value="editable">editable</option>
                  <option value="sensitive">sensitive</option>
                  <option value="frozen-implementation">frozen-implementation</option>
                  <option value="frozen-contract">frozen-contract</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="add-function-output-path-input">Output Path</label>
                <input
                  id="add-function-output-path-input"
                  type="text"
                  className="form-control"
                  value={addOutputPath}
                  onChange={e => setAddOutputPath(e.target.value)}
                  placeholder="e.g. src/orders/process.ts"
                  data-testid="add-function-output-path-input"
                />
              </div>
            </div>

            <div className="form-group full-width">
              <label htmlFor="add-function-description-input">Description (Multiline)</label>
              <textarea
                id="add-function-description-input"
                className="form-control"
                rows={3}
                value={addDescription}
                onChange={e => setAddDescription(e.target.value)}
                placeholder="High-level description of function responsibilities..."
                data-testid="add-function-description-input"
              />
            </div>

            <div className="form-group full-width">
              <label htmlFor="add-function-contract-input">Contract / Signature</label>
              <textarea
                id="add-function-contract-input"
                className="form-control mono-textarea"
                rows={2}
                value={addContract}
                onChange={e => setAddContract(e.target.value)}
                placeholder="export function processOrder(orderId: string): Promise<OrderResult>"
                data-testid="add-function-contract-input"
              />
            </div>

            {/* Toggle Detailed vs Description-Only */}
            <div className="detailed-toggle-box">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={addIsDetailed}
                  onChange={e => setAddIsDetailed(e.target.checked)}
                  data-testid="add-function-detailed-toggle"
                />
                <span>Include detailed contract fields (inputs, outputs, rules, errors, scenarios)</span>
              </label>
            </div>

            {addIsDetailed && (
              <div className="detailed-fields-block" data-testid="detailed-fields-block">
                <div className="contract-fields-grid">
                  <div className="form-group">
                    <label htmlFor="add-inputs-input">Inputs</label>
                    <textarea
                      id="add-inputs-input"
                      className="form-control mono-textarea"
                      rows={3}
                      value={addInputs}
                      onChange={e => setAddInputs(e.target.value)}
                      placeholder="orderId: string"
                      data-testid="add-inputs-input"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="add-outputs-input">Outputs</label>
                    <textarea
                      id="add-outputs-input"
                      className="form-control mono-textarea"
                      rows={3}
                      value={addOutputs}
                      onChange={e => setAddOutputs(e.target.value)}
                      placeholder="Promise<OrderResult>"
                      data-testid="add-outputs-input"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="add-rules-input">Rules</label>
                    <textarea
                      id="add-rules-input"
                      className="form-control"
                      rows={3}
                      value={addRules}
                      onChange={e => setAddRules(e.target.value)}
                      placeholder="Inventory must be checked before payment"
                      data-testid="add-rules-input"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="add-errors-input">Errors</label>
                    <textarea
                      id="add-errors-input"
                      className="form-control mono-textarea"
                      rows={3}
                      value={addErrors}
                      onChange={e => setAddErrors(e.target.value)}
                      placeholder="OutOfStockError: Item unavailable"
                      data-testid="add-errors-input"
                    />
                  </div>
                </div>

                <div className="form-group full-width">
                  <label htmlFor="add-scenario-input">Initial Acceptance Scenario</label>
                  <textarea
                    id="add-scenario-input"
                    className="form-control"
                    rows={2}
                    value={addScenario}
                    onChange={e => setAddScenario(e.target.value)}
                    placeholder="When valid order provided, returns confirmation with ID"
                    data-testid="add-scenario-input"
                  />
                </div>
              </div>
            )}

            <div className="function-actions-bar">
              <button
                type="submit"
                className="btn btn-primary"
                data-testid="create-function-submit-btn"
              >
                <Plus size={14} />
                <span>Create Function</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="modal-overlay" data-testid="function-editor-modal" role="dialog" aria-modal="true">
        <div className="modal-container modal-lg function-editor-modal-container">
          {content}
        </div>
      </div>
    );
  }

  return content;
};
