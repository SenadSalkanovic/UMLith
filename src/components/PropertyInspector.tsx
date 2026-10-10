import React, { useState, useEffect, useMemo } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Requirement, Project } from '../../shared/model';
import {
  validRelationship,
  GraphSchema,
  createNodeId,
  policies,
  nodeKinds,
} from '../../shared/model';
import type { ViewState } from '../types';
import * as api from '../api';
import {
  Sliders,
  Shield,
  Tag,
  CheckCircle2,
  AlertCircle,
  Info,
  Trash2,
  Edit3,
  Database,
  Terminal,
  Workflow,
  Save,
  X,
  Plus,
  Link2,
  AlertTriangle,
  FileText,
  ListPlus,
  RefreshCw,
  Cpu,
  ShieldAlert,
  Clock,
  Lock,
} from 'lucide-react';

export interface NodeDraft {
  name: string;
  kind?: ProgramNode['kind'];
  parentId?: string;
  description?: string;
  policy?: ProgramNode['policy'];
  provenance?: ProgramNode['provenance'];
  contract?: string;
  inputs?: string;
  outputs?: string;
  rules?: string;
  errors?: string;
  scenarios?: string[];
  requiredChecks?: string[];
  instructions?: string;
  outputPath?: string;
  fields?: ProgramNode['fields'];
  stepType?: ProgramNode['stepType'];
}

export interface EdgeDraft {
  kind?: ProgramEdge['kind'];
  label?: string;
  provenance?: ProgramEdge['provenance'];
  uncertain?: boolean;
}

export interface PropertyInspectorProps {
  project: Project | null;
  graph: Graph | null;
  viewState: ViewState;
  onClearSelection: () => void;
  onDeleteNode?: (id: string) => void;
  onEditNode?: (id: string) => void;
  onEditErNode?: (id: string) => void;
  onEditFunctionNode?: (id: string) => void;
  onEditWorkflowNode?: (id: string) => void;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  apiBaseUrl?: string;
  isEditing?: boolean;
  initialTab?: 'overview' | 'edit' | 'requirements';
  onOpenRevisionHistory?: () => void;
  onEditProtection?: (id: string) => void;
  isReadOnly?: boolean;
}

/**
 * Validates a node draft against model rules, containment, policies, and graph integrity.
 */
export function validateNodeDraft(
  draft: Partial<NodeDraft>,
  existingNode: ProgramNode,
  graph: Graph
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (draft.name !== undefined && !draft.name.trim()) {
    errors.name = 'Node name must not be blank';
  }

  const effectiveParentId = draft.parentId !== undefined ? draft.parentId.trim() : existingNode.parentId;
  const effectiveKind = draft.kind || existingNode.kind;

  if (effectiveParentId) {
    if (effectiveParentId === existingNode.id) {
      errors.parentId = 'Node cannot be its own parent';
    } else {
      const parent = graph.nodes.find(n => n.id === effectiveParentId);
      if (!parent) {
        errors.parentId = `Parent container does not exist: ${effectiveParentId}`;
      } else if (!validRelationship('contains', parent.kind, effectiveKind)) {
        errors.parentId = `Invalid containment: ${parent.kind} cannot contain ${effectiveKind}`;
      }
    }
  }

  const effectivePolicy = draft.policy || existingNode.policy;
  const effectiveContract = draft.contract !== undefined ? draft.contract : existingNode.contract;

  if (effectivePolicy === 'frozen-implementation') {
    if (!existingNode.source) {
      errors.policy = 'Frozen implementation requires a source binding';
    } else if (!existingNode.baseline?.source) {
      errors.policy = 'Frozen implementation requires captured source evidence';
    } else if (existingNode.baseline?.text === undefined) {
      errors.policy = 'Frozen implementation requires an exact text baseline';
    }
  } else if (effectivePolicy === 'frozen-contract') {
    if (!existingNode.source && !effectiveContract.trim()) {
      errors.policy = 'Frozen contract requires a source binding or an explicit interface';
    } else if (!existingNode.baseline?.contract?.trim()) {
      errors.policy = 'Frozen contract requires a declared interface baseline';
    }
  }

  const effectiveStepType = draft.stepType !== undefined ? draft.stepType : existingNode.stepType;
  if (effectiveKind === 'step') {
    if (!effectiveStepType) {
      errors.stepType = 'Workflow steps require an explicit step type';
    } else if (effectiveStepType === 'opaque' && !existingNode.source) {
      errors.stepType = 'Opaque steps require source evidence';
    }
  } else if (effectiveStepType !== undefined) {
    errors.stepType = 'Only workflow steps have a step type';
  }

  if (draft.fields) {
    for (let i = 0; i < draft.fields.length; i++) {
      const f = draft.fields[i];
      if (!f.name?.trim()) {
        errors.fields = 'Field name must not be blank';
        break;
      }
      if (!f.type?.trim()) {
        errors.fields = 'Field type must not be blank';
        break;
      }
    }
  }

  if (Object.keys(errors).length === 0) {
    const candidateNode: ProgramNode = {
      ...existingNode,
      ...draft,
      name: draft.name !== undefined ? draft.name.trim() : existingNode.name,
      parentId: effectiveParentId || undefined,
      description: draft.description !== undefined ? draft.description.trim() : existingNode.description,
      policy: effectivePolicy,
      contract: effectiveContract,
      instructions: draft.instructions !== undefined ? draft.instructions.trim() : existingNode.instructions,
      outputPath: draft.outputPath !== undefined ? draft.outputPath.trim() : existingNode.outputPath,
    };

    const candidateGraph: Graph = {
      ...graph,
      nodes: graph.nodes.map(n => (n.id === existingNode.id ? candidateNode : n)),
    };

    const parsed = GraphSchema.safeParse(candidateGraph);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const pathStr = issue.path.join('.');
        if (pathStr.includes('name')) errors.name = issue.message;
        else if (pathStr.includes('parentId')) errors.parentId = issue.message;
        else if (pathStr.includes('policy')) errors.policy = issue.message;
        else if (pathStr.includes('stepType')) errors.stepType = issue.message;
        else if (pathStr.includes('contract')) errors.contract = issue.message;
        else errors._global = issue.message;
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validates an edge draft against relationship endpoints and integrity.
 */
export function validateEdgeDraft(
  draft: Partial<EdgeDraft>,
  existingEdge: ProgramEdge,
  graph: Graph
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const sourceNode = graph.nodes.find(n => n.id === existingEdge.source);
  const targetNode = graph.nodes.find(n => n.id === existingEdge.target);

  if (!sourceNode) {
    errors.source = `Source node does not exist: ${existingEdge.source}`;
  }
  if (!targetNode) {
    errors.target = `Target node does not exist: ${existingEdge.target}`;
  }

  const nextKind = draft.kind || existingEdge.kind;
  if (sourceNode && targetNode && !validRelationship(nextKind, sourceNode.kind, targetNode.kind)) {
    errors.kind = `Invalid relationship: "${nextKind}" is not supported from ${sourceNode.kind} to ${targetNode.kind}.`;
  }

  const nextProv = draft.provenance || existingEdge.provenance;
  const nextUncertain = draft.uncertain !== undefined ? draft.uncertain : existingEdge.uncertain;
  if (nextProv === 'ai' && nextUncertain === false) {
    errors.uncertain = 'AI-inferred relationships must remain uncertain';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Saves node property updates into the graph after schema validation.
 */
export function saveNodeProperties(
  graph: Graph,
  nodeId: string,
  updates: Partial<ProgramNode>
): { graph: Graph; node: ProgramNode } {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const updatedNode: ProgramNode = {
    ...node,
    ...updates,
    parentId:
      updates.parentId !== undefined
        ? updates.parentId.trim()
          ? updates.parentId.trim()
          : undefined
        : node.parentId,
    name: updates.name !== undefined ? updates.name.trim() : node.name,
    description: updates.description !== undefined ? updates.description.trim() : node.description,
    instructions: updates.instructions !== undefined ? updates.instructions.trim() : node.instructions,
    outputPath: updates.outputPath !== undefined ? updates.outputPath.trim() : node.outputPath,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after saving node properties');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Saves edge property updates into the graph after schema validation.
 */
export function saveEdgeProperties(
  graph: Graph,
  edgeId: string,
  updates: Partial<ProgramEdge>
): { graph: Graph; edge: ProgramEdge } {
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) {
    throw new Error(`Edge not found: ${edgeId}`);
  }

  const updatedEdge: ProgramEdge = {
    ...edge,
    ...updates,
    label: updates.label !== undefined ? updates.label.trim() : edge.label,
  };

  const nextGraph: Graph = {
    ...graph,
    edges: graph.edges.map(e => (e.id === edgeId ? updatedEdge : e)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after saving edge properties');
  }

  return { graph: validation.data, edge: updatedEdge };
}

/**
 * Returns requirements attached to the specified node or edge.
 */
export function getLinkedRequirements(
  graph: Graph | null,
  itemId: string | null,
  itemType?: 'node' | 'edge' | null
): Requirement[] {
  if (!graph || !itemId) return [];
  return graph.requirements.filter(req => {
    if (itemType === 'edge') {
      return req.edgeIds.includes(itemId);
    } else if (itemType === 'node') {
      return req.nodeIds.includes(itemId);
    }
    return req.nodeIds.includes(itemId) || req.edgeIds.includes(itemId);
  });
}

/**
 * Resolves requirement item IDs to actual nodes and edges in the graph.
 */
export function resolveRequirementItems(
  graph: Graph | null,
  requirement: Requirement
): { nodes: ProgramNode[]; edges: ProgramEdge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const nodes = requirement.nodeIds
    .map(id => graph.nodes.find(n => n.id === id))
    .filter((n): n is ProgramNode => !!n);
  const edges = requirement.edgeIds
    .map(id => graph.edges.find(e => e.id === id))
    .filter((e): e is ProgramEdge => !!e);
  return { nodes, edges };
}

/**
 * Attaches an existing requirement to a node or edge.
 */
export function attachRequirementToItem(
  graph: Graph,
  reqId: string,
  item: { type: 'node' | 'edge'; id: string }
): { graph: Graph; requirement: Requirement } {
  const req = graph.requirements.find(r => r.id === reqId);
  if (!req) throw new Error(`Requirement not found: ${reqId}`);

  let updatedReq: Requirement;
  if (item.type === 'node') {
    if (req.nodeIds.includes(item.id)) return { graph, requirement: req };
    updatedReq = { ...req, nodeIds: [...req.nodeIds, item.id] };
  } else {
    if (req.edgeIds.includes(item.id)) return { graph, requirement: req };
    updatedReq = { ...req, edgeIds: [...req.edgeIds, item.id] };
  }

  const nextGraph: Graph = {
    ...graph,
    requirements: graph.requirements.map(r => (r.id === reqId ? updatedReq : r)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after attaching requirement');
  }

  return { graph: validation.data, requirement: updatedReq };
}

/**
 * Detaches a requirement from a node or edge.
 */
export function detachRequirementFromItem(
  graph: Graph,
  reqId: string,
  item: { type: 'node' | 'edge'; id: string }
): { graph: Graph; requirement: Requirement } {
  const req = graph.requirements.find(r => r.id === reqId);
  if (!req) throw new Error(`Requirement not found: ${reqId}`);

  let updatedReq: Requirement;
  if (item.type === 'node') {
    updatedReq = { ...req, nodeIds: req.nodeIds.filter(id => id !== item.id) };
  } else {
    updatedReq = { ...req, edgeIds: req.edgeIds.filter(id => id !== item.id) };
  }

  const nextGraph: Graph = {
    ...graph,
    requirements: graph.requirements.map(r => (r.id === reqId ? updatedReq : r)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after detaching requirement');
  }

  return { graph: validation.data, requirement: updatedReq };
}

/**
 * Creates a new requirement and attaches it directly to the given item.
 */
export function createAndAttachRequirement(
  graph: Graph,
  input: { id?: string; text: string; constraints?: string[]; scenarios?: string[] },
  item: { type: 'node' | 'edge'; id: string }
): { graph: Graph; requirement: Requirement } {
  if (!input.text.trim()) {
    throw new Error('Requirement text must not be blank');
  }

  const reqId = input.id?.trim() || `req-${createNodeId().slice(0, 8)}`;
  if (graph.requirements.some(r => r.id === reqId)) {
    throw new Error(`Requirement with ID already exists: ${reqId}`);
  }

  const newReq: Requirement = {
    id: reqId,
    text: input.text.trim(),
    nodeIds: item.type === 'node' ? [item.id] : [],
    edgeIds: item.type === 'edge' ? [item.id] : [],
    constraints: input.constraints || [],
    scenarios: input.scenarios || [],
  };

  const nextGraph: Graph = {
    ...graph,
    requirements: [...graph.requirements, newReq],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating requirement');
  }

  return { graph: validation.data, requirement: newReq };
}

/**
 * Adds an acceptance scenario to a requirement.
 */
export function addRequirementScenario(
  graph: Graph,
  reqId: string,
  scenarioText: string
): { graph: Graph; requirement: Requirement } {
  if (!scenarioText.trim()) {
    throw new Error('Scenario text must not be blank');
  }
  const req = graph.requirements.find(r => r.id === reqId);
  if (!req) throw new Error(`Requirement not found: ${reqId}`);

  const updatedReq: Requirement = {
    ...req,
    scenarios: [...req.scenarios, scenarioText.trim()],
  };

  const nextGraph: Graph = {
    ...graph,
    requirements: graph.requirements.map(r => (r.id === reqId ? updatedReq : r)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after adding scenario to requirement');
  }

  return { graph: validation.data, requirement: updatedReq };
}

/**
 * Adds an acceptance scenario to a function node.
 */
export function addFunctionScenarioToNode(
  graph: Graph,
  nodeId: string,
  scenarioText: string
): { graph: Graph; node: ProgramNode } {
  if (!scenarioText.trim()) {
    throw new Error('Scenario text must not be blank');
  }
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const scenarios = node.scenarios ? [...node.scenarios, scenarioText.trim()] : [scenarioText.trim()];
  return saveNodeProperties(graph, nodeId, { scenarios });
}

export const PropertyInspector: React.FC<PropertyInspectorProps> = ({
  project,
  graph,
  viewState,
  onClearSelection,
  onDeleteNode,
  onEditNode,
  onEditErNode,
  onEditFunctionNode,
  onEditWorkflowNode,
  onUpdateSpecification,
  onSelectNode,
  onSelectEdge,
  apiBaseUrl,
  isEditing = false,
  initialTab,
  onOpenRevisionHistory,
  onEditProtection,
  isReadOnly = false,
}) => {
  const selectedNode = viewState.selectedId
    ? graph?.nodes.find(n => n.id === viewState.selectedId) || null
    : null;

  const selectedEdge = viewState.selectedId
    ? graph?.edges.find(e => e.id === viewState.selectedId) || null
    : null;

  // Tab mode
  const [activeTab, setActiveTab] = useState<'overview' | 'edit' | 'requirements'>(() => {
    if (initialTab) return initialTab;
    if (isEditing) return 'edit';
    return 'overview';
  });

  useEffect(() => {
    if (isEditing) {
      setActiveTab('edit');
    }
  }, [isEditing]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Track initial base revision to detect concurrent conflicts
  const [baseRevision, setBaseRevision] = useState<number>(project?.specRevision ?? 0);
  useEffect(() => {
    if (project) {
      setBaseRevision(project.specRevision);
    }
  }, [project?.id]);

  // Node Draft State
  const [draftName, setDraftName] = useState<string>('');
  const [draftParentId, setDraftParentId] = useState<string>('');
  const [draftDescription, setDraftDescription] = useState<string>('');
  const [draftPolicy, setDraftPolicy] = useState<ProgramNode['policy']>('editable');
  const [draftContract, setDraftContract] = useState<string>('');
  const [draftInputs, setDraftInputs] = useState<string>('');
  const [draftOutputs, setDraftOutputs] = useState<string>('');
  const [draftRules, setDraftRules] = useState<string>('');
  const [draftErrors, setDraftErrors] = useState<string>('');
  const [draftScenarios, setDraftScenarios] = useState<string[]>([]);
  const [draftOutputPath, setDraftOutputPath] = useState<string>('');
  const [draftInstructions, setDraftInstructions] = useState<string>('');
  const [draftStepType, setDraftStepType] = useState<ProgramNode['stepType'] | undefined>(undefined);
  const [draftFields, setDraftFields] = useState<ProgramNode['fields']>([]);

  // Edge Draft State
  const [draftEdgeKind, setDraftEdgeKind] = useState<ProgramEdge['kind']>('depends-on');
  const [draftEdgeLabel, setDraftEdgeLabel] = useState<string>('');
  const [draftEdgeProvenance, setDraftEdgeProvenance] = useState<ProgramEdge['provenance']>('human');
  const [draftEdgeUncertain, setDraftEdgeUncertain] = useState<boolean>(false);

  // Field addition in entity editor
  const [newFieldName, setNewFieldName] = useState<string>('');
  const [newFieldType, setNewFieldType] = useState<string>('String');
  const [newFieldKey, setNewFieldKey] = useState<string>('');
  const [newFieldOptional, setNewFieldOptional] = useState<boolean>(false);
  const [newFieldMapped, setNewFieldMapped] = useState<string>('');

  // Scenario addition inputs
  const [newScenarioText, setNewScenarioText] = useState<string>('');
  const [newReqScenarioText, setNewReqScenarioText] = useState<Record<string, string>>({});

  // Requirements creation & attach state
  const [selectedUnlinkedReqId, setSelectedUnlinkedReqId] = useState<string>('');
  const [newReqId, setNewReqId] = useState<string>('');
  const [newReqText, setNewReqText] = useState<string>('');
  const [newReqConstraints, setNewReqConstraints] = useState<string>('');
  const [newReqScenarios, setNewReqScenarios] = useState<string>('');

  // Feedback states
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [revisionConflict, setRevisionConflict] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Reset form when selected item changes
  useEffect(() => {
    setValidationErrors({});
    setRevisionConflict(null);
    setSaveSuccess(false);
    setGeneralError(null);

    if (selectedNode) {
      setDraftName(selectedNode.name);
      setDraftParentId(selectedNode.parentId || '');
      setDraftDescription(selectedNode.description || '');
      setDraftPolicy(selectedNode.policy || 'editable');
      setDraftContract(selectedNode.contract || '');
      setDraftInputs(selectedNode.inputs ?? '');
      setDraftOutputs(selectedNode.outputs ?? '');
      setDraftRules(selectedNode.rules ?? '');
      setDraftErrors(selectedNode.errors ?? '');
      setDraftScenarios(selectedNode.scenarios ? [...selectedNode.scenarios] : []);
      setDraftOutputPath(selectedNode.outputPath || '');
      setDraftInstructions(selectedNode.instructions || '');
      setDraftStepType(selectedNode.stepType);
      setDraftFields(selectedNode.fields ? [...selectedNode.fields] : []);
    } else if (selectedEdge) {
      setDraftEdgeKind(selectedEdge.kind);
      setDraftEdgeLabel(selectedEdge.label || '');
      setDraftEdgeProvenance(selectedEdge.provenance || 'human');
      setDraftEdgeUncertain(selectedEdge.uncertain ?? false);
    }

    if (project) {
      setBaseRevision(project.specRevision);
    }
  }, [viewState.selectedId, viewState.selectedType]);

  // Linked requirements for currently selected item
  const linkedRequirements = useMemo(() => {
    if (!graph || !viewState.selectedId) return [];
    const itemType = selectedNode ? 'node' : selectedEdge ? 'edge' : null;
    return getLinkedRequirements(graph, viewState.selectedId, itemType);
  }, [graph, viewState.selectedId, selectedNode, selectedEdge]);

  // Unlinked requirements available for attachment
  const unlinkedRequirements = useMemo(() => {
    if (!graph || !viewState.selectedId) return [];
    const linkedIds = new Set(linkedRequirements.map(r => r.id));
    return graph.requirements.filter(r => !linkedIds.has(r.id));
  }, [graph, viewState.selectedId, linkedRequirements]);

  // Potential parent nodes for selection
  const potentialParents = useMemo(() => {
    if (!graph || !selectedNode) return [];
    return graph.nodes.filter(
      n => n.id !== selectedNode.id && validRelationship('contains', n.kind, selectedNode.kind)
    );
  }, [graph, selectedNode]);

  // Submit and save handler
  const handleSaveProperties = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!graph) return;
    if (isReadOnly) {
      setGeneralError('Historical snapshot is read-only. Cannot overwrite newer data implicitly.');
      return;
    }

    setGeneralError(null);
    setSaveSuccess(false);

    if (selectedNode) {
      const nodeDraft: Partial<NodeDraft> = {
        name: draftName,
        parentId: draftParentId.trim() ? draftParentId.trim() : undefined,
        description: draftDescription,
        policy: draftPolicy,
        contract: draftContract,
        inputs: draftInputs,
        outputs: draftOutputs,
        rules: draftRules,
        errors: draftErrors,
        scenarios: draftScenarios,
        outputPath: draftOutputPath,
        instructions: draftInstructions,
        stepType: draftStepType,
        fields: draftFields,
      };

      const validation = validateNodeDraft(nodeDraft, selectedNode, graph);
      if (!validation.valid) {
        setValidationErrors(validation.errors);
        // Retain unsaved user draft!
        return;
      }

      // Check revision conflict
      if (project && project.specRevision !== baseRevision) {
        setRevisionConflict(
          `Specification conflict: Current revision is ${project.specRevision}, but your draft was based on revision ${baseRevision}. Reload to reconcile.`
        );
        // Retain unsaved user draft!
        return;
      }

      try {
        setIsSaving(true);
        const { graph: nextGraph } = saveNodeProperties(graph, selectedNode.id, {
          name: draftName,
          parentId: draftParentId.trim() ? draftParentId.trim() : undefined,
          description: draftDescription,
          policy: draftPolicy,
          contract: draftContract,
          inputs: draftInputs || undefined,
          outputs: draftOutputs || undefined,
          rules: draftRules || undefined,
          errors: draftErrors || undefined,
          scenarios: draftScenarios.length > 0 ? draftScenarios : undefined,
          outputPath: draftOutputPath,
          instructions: draftInstructions,
          stepType: draftStepType,
          fields: draftFields,
        });

        if (onUpdateSpecification) {
          await onUpdateSpecification(nextGraph);
        } else if (project && !project.root?.startsWith('/test')) {
          await api.updateSpecification(project.id, baseRevision, nextGraph, apiBaseUrl);
        }

        setValidationErrors({});
        setRevisionConflict(null);
        setSaveSuccess(true);
        if (project) setBaseRevision(project.specRevision + 1);
      } catch (err: any) {
        if (err?.statusCode === 409 || err?.message?.includes('conflict') || err?.message?.includes('revision')) {
          setRevisionConflict(
            err?.message || `Specification conflict: Current revision is ${project?.specRevision ?? 'updated'}.`
          );
        } else {
          setGeneralError(err?.message || 'Failed to save properties');
        }
      } finally {
        setIsSaving(false);
      }
    } else if (selectedEdge) {
      const edgeDraft: Partial<EdgeDraft> = {
        kind: draftEdgeKind,
        label: draftEdgeLabel,
        provenance: draftEdgeProvenance,
        uncertain: draftEdgeUncertain,
      };

      const validation = validateEdgeDraft(edgeDraft, selectedEdge, graph);
      if (!validation.valid) {
        setValidationErrors(validation.errors);
        // Retain unsaved user draft!
        return;
      }

      // Check revision conflict
      if (project && project.specRevision !== baseRevision) {
        setRevisionConflict(
          `Specification conflict: Current revision is ${project.specRevision}, but your draft was based on revision ${baseRevision}. Reload to reconcile.`
        );
        return;
      }

      try {
        setIsSaving(true);
        const { graph: nextGraph } = saveEdgeProperties(graph, selectedEdge.id, {
          kind: draftEdgeKind,
          label: draftEdgeLabel,
          provenance: draftEdgeProvenance,
          uncertain: draftEdgeUncertain,
        });

        if (onUpdateSpecification) {
          await onUpdateSpecification(nextGraph);
        } else if (project && !project.root?.startsWith('/test')) {
          await api.updateSpecification(project.id, baseRevision, nextGraph, apiBaseUrl);
        }

        setValidationErrors({});
        setRevisionConflict(null);
        setSaveSuccess(true);
        if (project) setBaseRevision(project.specRevision + 1);
      } catch (err: any) {
        if (err?.statusCode === 409 || err?.message?.includes('conflict') || err?.message?.includes('revision')) {
          setRevisionConflict(
            err?.message || `Specification conflict: Current revision is ${project?.specRevision ?? 'updated'}.`
          );
        } else {
          setGeneralError(err?.message || 'Failed to save properties');
        }
      } finally {
        setIsSaving(false);
      }
    }
  };

  // Add field in entity editor
  const handleAddField = () => {
    if (!newFieldName.trim()) {
      setValidationErrors(prev => ({ ...prev, fields: 'Field name must not be blank' }));
      return;
    }
    setDraftFields(prev => [
      ...prev,
      {
        name: newFieldName.trim(),
        type: newFieldType.trim() || 'String',
        key: newFieldKey,
        optional: newFieldOptional,
        mappedName: newFieldMapped.trim() || undefined,
      },
    ]);
    setNewFieldName('');
    setNewFieldType('String');
    setNewFieldKey('');
    setNewFieldOptional(false);
    setNewFieldMapped('');
    setValidationErrors(prev => {
      const copy = { ...prev };
      delete copy.fields;
      return copy;
    });
  };

  // Remove field in entity editor
  const handleRemoveField = (index: number) => {
    setDraftFields(prev => prev.filter((_, i) => i !== index));
  };

  // Add acceptance scenario to function draft
  const handleAddScenario = () => {
    if (!newScenarioText.trim()) return;
    setDraftScenarios(prev => [...prev, newScenarioText.trim()]);
    setNewScenarioText('');
  };

  // Remove acceptance scenario from function draft
  const handleRemoveScenario = (index: number) => {
    setDraftScenarios(prev => prev.filter((_, i) => i !== index));
  };

  // Attach existing requirement
  const handleAttachExistingReq = async () => {
    if (!graph || !selectedUnlinkedReqId || !viewState.selectedId) return;
    const itemType = selectedNode ? 'node' : 'edge';
    try {
      const { graph: nextGraph } = attachRequirementToItem(graph, selectedUnlinkedReqId, {
        type: itemType,
        id: viewState.selectedId,
      });
      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setSelectedUnlinkedReqId('');
    } catch (err: any) {
      setGeneralError(err?.message || 'Failed to attach requirement');
    }
  };

  // Create and attach new requirement
  const handleCreateAndAttachReq = async () => {
    if (!graph || !viewState.selectedId) return;
    if (!newReqText.trim()) {
      setValidationErrors(prev => ({ ...prev, reqText: 'Requirement text must not be blank' }));
      return;
    }
    const itemType = selectedNode ? 'node' : 'edge';
    try {
      const constraints = newReqConstraints.trim()
        ? newReqConstraints.split('\n').map(s => s.trim()).filter(Boolean)
        : [];
      const scenarios = newReqScenarios.trim()
        ? newReqScenarios.split('\n').map(s => s.trim()).filter(Boolean)
        : [];

      const { graph: nextGraph } = createAndAttachRequirement(
        graph,
        {
          id: newReqId.trim() || undefined,
          text: newReqText.trim(),
          constraints,
          scenarios,
        },
        {
          type: itemType,
          id: viewState.selectedId,
        }
      );

      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setNewReqId('');
      setNewReqText('');
      setNewReqConstraints('');
      setNewReqScenarios('');
      setValidationErrors(prev => {
        const copy = { ...prev };
        delete copy.reqText;
        return copy;
      });
    } catch (err: any) {
      setGeneralError(err?.message || 'Failed to create requirement');
    }
  };

  // Detach requirement
  const handleDetachReq = async (reqId: string) => {
    if (!graph || !viewState.selectedId) return;
    const itemType = selectedNode ? 'node' : 'edge';
    try {
      const { graph: nextGraph } = detachRequirementFromItem(graph, reqId, {
        type: itemType,
        id: viewState.selectedId,
      });
      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
    } catch (err: any) {
      setGeneralError(err?.message || 'Failed to detach requirement');
    }
  };

  // Add scenario to requirement
  const handleAddReqScenario = async (reqId: string) => {
    const text = newReqScenarioText[reqId];
    if (!graph || !text || !text.trim()) return;
    try {
      const { graph: nextGraph } = addRequirementScenario(graph, reqId, text.trim());
      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setNewReqScenarioText(prev => ({ ...prev, [reqId]: '' }));
    } catch (err: any) {
      setGeneralError(err?.message || 'Failed to add scenario to requirement');
    }
  };

  return (
    <aside
      className="panel property-inspector-panel"
      data-testid="property-inspector-panel"
      aria-label="Property Inspector"
    >
      <div className="panel-header">
        <div className="panel-title">
          <Sliders size={16} />
          <span>Property Inspector</span>
        </div>
        {viewState.selectedId && (
          <button
            className="btn btn-xs btn-outline"
            onClick={onClearSelection}
            title="Deselect item"
            data-testid="clear-selection-btn"
          >
            Clear
          </button>
        )}
      </div>

      {(selectedNode || selectedEdge) && (
        <div className="inspector-tabs" data-testid="inspector-tabs">
          <button
            className={`inspector-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
            data-testid="tab-overview"
          >
            Overview
          </button>
          <button
            className={`inspector-tab-btn ${activeTab === 'edit' ? 'active' : ''}`}
            onClick={() => setActiveTab('edit')}
            data-testid="tab-edit"
          >
            Edit Properties
          </button>
          <button
            className={`inspector-tab-btn ${activeTab === 'requirements' ? 'active' : ''}`}
            onClick={() => setActiveTab('requirements')}
            data-testid="tab-requirements"
          >
            Requirements ({linkedRequirements.length})
          </button>
        </div>
      )}

      <div className="panel-content inspector-content">
        {isReadOnly && (
          <div className="alert alert-warning historical-readonly-alert" data-testid="inspector-historical-readonly-alert">
            <Clock size={14} />
            <span>Historical snapshot is read-only. Edits cannot overwrite newer data implicitly.</span>
          </div>
        )}

        {activeTab === 'edit' && (selectedNode || selectedEdge) ? (
          <div className="inspector-edit-mode" data-testid="inspector-edit-form">
            <div className="inspector-section">
              <span className="section-label">
                Editing {selectedNode ? `Node (${selectedNode.kind})` : `Relationship (${selectedEdge?.kind})`}
              </span>
              <h3 className="item-title">{selectedNode?.name || selectedEdge?.kind}</h3>
            </div>

            {/* Validation Banner */}
            {Object.keys(validationErrors).length > 0 && (
              <div className="alert alert-danger inspector-validation-alert" data-testid="inspector-validation-error">
                <AlertCircle size={14} />
                <span>
                  {validationErrors._global || 'Validation failed. Please correct highlighted fields.'}
                </span>
              </div>
            )}

            {/* Revision Conflict Banner */}
            {revisionConflict && (
              <div className="alert alert-warning revision-conflict-alert" data-testid="revision-conflict-error">
                <AlertTriangle size={14} />
                <div className="conflict-alert-content-inner">
                  <span>{revisionConflict}</span>
                  <div className="conflict-draft-saved-note" data-testid="conflict-draft-saved-note">
                    Your unsaved draft text has been preserved.
                  </div>
                  <div className="conflict-inspector-actions">
                    {project && (
                      <button
                        type="button"
                        className="btn btn-xs btn-secondary"
                        onClick={() => {
                          setBaseRevision(project.specRevision);
                          setRevisionConflict(null);
                        }}
                        data-testid="inspector-conflict-reload-btn"
                        title="Acknowledge latest server revision and keep your current draft"
                      >
                        Acknowledge & Sync Base Rev
                      </button>
                    )}
                    {onOpenRevisionHistory && (
                      <button
                        type="button"
                        className="btn btn-xs btn-secondary"
                        onClick={onOpenRevisionHistory}
                        data-testid="inspector-conflict-review-btn"
                        title="Open revision history to review conflicts and recover"
                      >
                        Review History & Conflicts
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* General Error Banner */}
            {generalError && (
              <div className="alert alert-danger" data-testid="inspector-general-error">
                <AlertCircle size={14} />
                <span>{generalError}</span>
              </div>
            )}

            {/* Success Banner */}
            {saveSuccess && (
              <div className="alert alert-success inspector-save-success" data-testid="inspector-save-success">
                <CheckCircle2 size={14} />
                <span>Properties saved successfully.</span>
              </div>
            )}

            <form onSubmit={handleSaveProperties} className="inspector-form">
              {selectedNode ? (
                <>
                  <div className="inspector-form-group">
                    <label htmlFor="input-node-name">Name *</label>
                    <input
                      id="input-node-name"
                      type="text"
                      className={`form-input ${validationErrors.name ? 'is-invalid' : ''}`}
                      value={draftName}
                      onChange={e => {
                        setDraftName(e.target.value);
                        setValidationErrors(prev => {
                          const copy = { ...prev };
                          delete copy.name;
                          return copy;
                        });
                      }}
                      data-testid="input-node-name"
                    />
                    {validationErrors.name && (
                      <span className="field-error-msg" data-testid="field-error-name">
                        <AlertCircle size={12} /> {validationErrors.name}
                      </span>
                    )}
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="select-node-parent">Parent Container</label>
                    <select
                      id="select-node-parent"
                      className={`form-select ${validationErrors.parentId ? 'is-invalid' : ''}`}
                      value={draftParentId}
                      onChange={e => {
                        setDraftParentId(e.target.value);
                        setValidationErrors(prev => {
                          const copy = { ...prev };
                          delete copy.parentId;
                          return copy;
                        });
                      }}
                      data-testid="select-node-parent"
                    >
                      <option value="">(None / Root Scope)</option>
                      {potentialParents.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.kind})
                        </option>
                      ))}
                    </select>
                    {validationErrors.parentId && (
                      <span className="field-error-msg" data-testid="field-error-parentId">
                        <AlertCircle size={12} /> {validationErrors.parentId}
                      </span>
                    )}
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="select-node-policy">Policy</label>
                    <select
                      id="select-node-policy"
                      className={`form-select ${validationErrors.policy ? 'is-invalid' : ''}`}
                      value={draftPolicy}
                      onChange={e => {
                        setDraftPolicy(e.target.value as ProgramNode['policy']);
                        setValidationErrors(prev => {
                          const copy = { ...prev };
                          delete copy.policy;
                          return copy;
                        });
                      }}
                      data-testid="select-node-policy"
                    >
                      {policies.map(p => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    {validationErrors.policy && (
                      <span className="field-error-msg" data-testid="field-error-policy">
                        <AlertCircle size={12} /> {validationErrors.policy}
                      </span>
                    )}
                    {onEditProtection && (
                      <button
                        type="button"
                        className="btn-open-protection-editor"
                        onClick={() => onEditProtection(selectedNode.id)}
                        data-testid="open-protection-editor-btn"
                      >
                        <Shield size={12} /> Manage Protection Policies & Baselines
                      </button>
                    )}
                  </div>

                  {selectedNode.kind === 'step' && (
                    <div className="inspector-form-group">
                      <label htmlFor="select-step-type">Step Type</label>
                      <select
                        id="select-step-type"
                        className={`form-select ${validationErrors.stepType ? 'is-invalid' : ''}`}
                        value={draftStepType || 'operation'}
                        onChange={e => {
                          setDraftStepType(e.target.value as ProgramNode['stepType']);
                          setValidationErrors(prev => {
                            const copy = { ...prev };
                            delete copy.stepType;
                            return copy;
                          });
                        }}
                        data-testid="select-step-type"
                      >
                        <option value="operation">operation</option>
                        <option value="call">call</option>
                        <option value="condition">condition</option>
                        <option value="loop">loop</option>
                        <option value="try">try</option>
                        <option value="throw">throw</option>
                        <option value="return">return</option>
                        <option value="opaque">opaque</option>
                      </select>
                      {validationErrors.stepType && (
                        <span className="field-error-msg" data-testid="field-error-stepType">
                          <AlertCircle size={12} /> {validationErrors.stepType}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="inspector-form-group">
                    <label htmlFor="input-node-description">Description</label>
                    <textarea
                      id="input-node-description"
                      className="form-textarea"
                      rows={2}
                      value={draftDescription}
                      onChange={e => setDraftDescription(e.target.value)}
                      data-testid="input-node-description"
                    />
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="input-node-outputPath">Output Path</label>
                    <input
                      id="input-node-outputPath"
                      type="text"
                      className="form-input"
                      value={draftOutputPath}
                      onChange={e => setDraftOutputPath(e.target.value)}
                      data-testid="input-node-output-path"
                    />
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="input-node-contract">Contract / Interface</label>
                    <textarea
                      id="input-node-contract"
                      className={`form-textarea font-mono ${validationErrors.contract ? 'is-invalid' : ''}`}
                      rows={3}
                      value={draftContract}
                      onChange={e => {
                        setDraftContract(e.target.value);
                        setValidationErrors(prev => {
                          const copy = { ...prev };
                          delete copy.contract;
                          return copy;
                        });
                      }}
                      data-testid="input-node-contract"
                    />
                    {validationErrors.contract && (
                      <span className="field-error-msg" data-testid="field-error-contract">
                        <AlertCircle size={12} /> {validationErrors.contract}
                      </span>
                    )}
                  </div>

                  {selectedNode.kind === 'function' && (
                    <>
                      <div className="inspector-form-group">
                        <label htmlFor="input-function-inputs">Inputs</label>
                        <textarea
                          id="input-function-inputs"
                          className="form-textarea font-mono"
                          rows={2}
                          value={draftInputs}
                          onChange={e => setDraftInputs(e.target.value)}
                          data-testid="input-function-inputs"
                        />
                      </div>

                      <div className="inspector-form-group">
                        <label htmlFor="input-function-outputs">Outputs</label>
                        <textarea
                          id="input-function-outputs"
                          className="form-textarea font-mono"
                          rows={2}
                          value={draftOutputs}
                          onChange={e => setDraftOutputs(e.target.value)}
                          data-testid="input-function-outputs"
                        />
                      </div>

                      <div className="inspector-form-group">
                        <label htmlFor="input-function-rules">Rules</label>
                        <textarea
                          id="input-function-rules"
                          className="form-textarea"
                          rows={2}
                          value={draftRules}
                          onChange={e => setDraftRules(e.target.value)}
                          data-testid="input-function-rules"
                        />
                      </div>

                      <div className="inspector-form-group">
                        <label htmlFor="input-function-errors">Errors</label>
                        <textarea
                          id="input-function-errors"
                          className="form-textarea"
                          rows={2}
                          value={draftErrors}
                          onChange={e => setDraftErrors(e.target.value)}
                          data-testid="input-function-errors"
                        />
                      </div>

                      <div className="inspector-form-group">
                        <label>Acceptance Scenarios ({draftScenarios.length})</label>
                        <ul className="scenario-list">
                          {draftScenarios.map((sc, i) => (
                            <li key={i} className="scenario-item">
                              <span className="multiline-text">{sc}</span>
                              <button
                                type="button"
                                className="btn btn-xs btn-outline-danger"
                                onClick={() => handleRemoveScenario(i)}
                                data-testid={`remove-scenario-${i}`}
                              >
                                <Trash2 size={10} />
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="flex-row gap-2 mt-2">
                          <input
                            type="text"
                            placeholder="Add scenario..."
                            className="form-input flex-1"
                            value={newScenarioText}
                            onChange={e => setNewScenarioText(e.target.value)}
                            data-testid="input-new-scenario"
                          />
                          <button
                            type="button"
                            className="btn btn-xs btn-outline"
                            onClick={handleAddScenario}
                            data-testid="add-scenario-btn"
                          >
                            <Plus size={12} /> Add
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {(selectedNode.kind === 'entity' || selectedNode.kind === 'enum') && (
                    <div className="inspector-form-group">
                      <label>Fields ({draftFields.length})</label>
                      {validationErrors.fields && (
                        <span className="field-error-msg" data-testid="field-error-fields">
                          <AlertCircle size={12} /> {validationErrors.fields}
                        </span>
                      )}
                      <table className="fields-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Key</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftFields.map((f, i) => (
                            <tr key={i}>
                              <td>
                                {f.name}
                                {f.optional ? '?' : ''}
                              </td>
                              <td>
                                <code>{f.type}</code>
                              </td>
                              <td>{f.key || '-'}</td>
                              <td>
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline-danger"
                                  onClick={() => handleRemoveField(i)}
                                  data-testid={`remove-field-${f.name}`}
                                >
                                  <Trash2 size={10} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="add-field-row mt-2">
                        <input
                          type="text"
                          placeholder="Name"
                          className="form-input"
                          value={newFieldName}
                          onChange={e => setNewFieldName(e.target.value)}
                          data-testid="input-field-name"
                        />
                        <input
                          type="text"
                          placeholder="Type"
                          className="form-input"
                          value={newFieldType}
                          onChange={e => setNewFieldType(e.target.value)}
                          data-testid="input-field-type"
                        />
                        <select
                          className="form-select"
                          value={newFieldKey}
                          onChange={e => setNewFieldKey(e.target.value)}
                          data-testid="select-field-key"
                        >
                          <option value="">Regular</option>
                          <option value="primary">primary</option>
                          <option value="unique">unique</option>
                        </select>
                        <button
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={handleAddField}
                          data-testid="add-field-btn"
                        >
                          <Plus size={12} /> Add Field
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="inspector-form-group">
                    <label htmlFor="input-node-instructions">Instructions</label>
                    <textarea
                      id="input-node-instructions"
                      className="form-textarea"
                      rows={2}
                      value={draftInstructions}
                      onChange={e => setDraftInstructions(e.target.value)}
                      data-testid="input-node-instructions"
                    />
                  </div>
                </>
              ) : selectedEdge ? (
                <>
                  <div className="inspector-form-group">
                    <label htmlFor="select-edge-kind">Relationship Kind</label>
                    <select
                      id="select-edge-kind"
                      className={`form-select ${validationErrors.kind ? 'is-invalid' : ''}`}
                      value={draftEdgeKind}
                      onChange={e => {
                        setDraftEdgeKind(e.target.value as ProgramEdge['kind']);
                        setValidationErrors(prev => {
                          const copy = { ...prev };
                          delete copy.kind;
                          return copy;
                        });
                      }}
                      data-testid="select-edge-kind"
                    >
                      <option value="depends-on">depends-on</option>
                      <option value="calls">calls</option>
                      <option value="contains">contains</option>
                      <option value="inherits">inherits</option>
                      <option value="implements">implements</option>
                      <option value="relates-to">relates-to</option>
                      <option value="next">next</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                      <option value="exception">exception</option>
                      <option value="reads">reads</option>
                      <option value="writes">writes</option>
                    </select>
                    {validationErrors.kind && (
                      <span className="field-error-msg" data-testid="field-error-kind">
                        <AlertCircle size={12} /> {validationErrors.kind}
                      </span>
                    )}
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="input-edge-label">Label</label>
                    <input
                      id="input-edge-label"
                      type="text"
                      className="form-input"
                      value={draftEdgeLabel}
                      onChange={e => setDraftEdgeLabel(e.target.value)}
                      data-testid="input-edge-label"
                    />
                  </div>

                  <div className="inspector-form-group">
                    <label htmlFor="select-edge-provenance">Provenance</label>
                    <select
                      id="select-edge-provenance"
                      className="form-select"
                      value={draftEdgeProvenance}
                      onChange={e => setDraftEdgeProvenance(e.target.value as ProgramEdge['provenance'])}
                      data-testid="select-edge-provenance"
                    >
                      <option value="human">human</option>
                      <option value="extracted">extracted</option>
                      <option value="ai">ai</option>
                    </select>
                  </div>

                  <div className="inspector-form-group checkbox-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={draftEdgeUncertain}
                        onChange={e => setDraftEdgeUncertain(e.target.checked)}
                        data-testid="input-edge-uncertain"
                      />
                      <span>Uncertain Relationship</span>
                    </label>
                    {validationErrors.uncertain && (
                      <span className="field-error-msg" data-testid="field-error-uncertain">
                        <AlertCircle size={12} /> {validationErrors.uncertain}
                      </span>
                    )}
                  </div>
                </>
              ) : null}

              <div className="inspector-form-actions mt-4">
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={isSaving}
                  data-testid="save-properties-btn"
                >
                  <Save size={14} />
                  <span>{isSaving ? 'Saving…' : 'Save Properties'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setActiveTab('overview');
                    setValidationErrors({});
                    setRevisionConflict(null);
                  }}
                  data-testid="cancel-edit-btn"
                >
                  <X size={14} />
                  <span>Cancel</span>
                </button>
              </div>
            </form>
          </div>
        ) : activeTab === 'requirements' && (selectedNode || selectedEdge) ? (
          <div className="inspector-requirements-mode" data-testid="inspector-requirements-section">
            <div className="inspector-section">
              <span className="section-label">Linked Requirements</span>
              <h3 className="item-title">{selectedNode?.name || selectedEdge?.kind}</h3>
              <p className="item-desc">
                {linkedRequirements.length} requirement(s) linked to this {selectedNode ? 'node' : 'relationship'}.
              </p>
            </div>

            {/* Linked requirements list */}
            <div className="linked-reqs-list">
              {linkedRequirements.length > 0 ? (
                linkedRequirements.map(req => {
                  const resolved = resolveRequirementItems(graph, req);
                  return (
                    <div key={req.id} className="req-card" data-testid={`req-card-${req.id}`}>
                      <div className="req-card-header">
                        <strong className="req-id" data-testid={`req-id-${req.id}`}>{req.id}</strong>
                        <button
                          type="button"
                          className="btn btn-xs btn-outline-danger"
                          onClick={() => handleDetachReq(req.id)}
                          title="Detach requirement"
                          data-testid={`detach-req-${req.id}`}
                        >
                          <X size={12} /> Detach
                        </button>
                      </div>
                      <p className="req-text" data-testid={`req-text-${req.id}`}>{req.text}</p>

                      {req.constraints.length > 0 && (
                        <div className="req-constraints mt-1">
                          <span className="sub-label">Constraints:</span>
                          <ul>
                            {req.constraints.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Scenarios on requirement */}
                      <div className="req-scenarios mt-2" data-testid={`req-scenarios-${req.id}`}>
                        <span className="sub-label">Acceptance Scenarios ({req.scenarios.length}):</span>
                        <ul className="scenario-list">
                          {req.scenarios.map((sc, i) => (
                            <li key={i} className="multiline-text">{sc}</li>
                          ))}
                        </ul>
                        <div className="flex-row gap-1 mt-1">
                          <input
                            type="text"
                            placeholder="Add scenario..."
                            className="form-input form-input-xs flex-1"
                            value={newReqScenarioText[req.id] || ''}
                            onChange={e =>
                              setNewReqScenarioText(prev => ({ ...prev, [req.id]: e.target.value }))
                            }
                            data-testid={`input-req-scenario-${req.id}`}
                          />
                          <button
                            type="button"
                            className="btn btn-xs btn-outline"
                            onClick={() => handleAddReqScenario(req.id)}
                            data-testid={`btn-add-req-scenario-${req.id}`}
                          >
                            <Plus size={10} /> Add
                          </button>
                        </div>
                      </div>

                      {/* Owning Items / Linked Items resolution */}
                      <div className="req-owning-items mt-2" data-testid={`req-owning-items-${req.id}`}>
                        <span className="sub-label">Owning & Linked Items:</span>
                        <div className="badge-row flex-wrap gap-1 mt-1">
                          {resolved.nodes.map(n => (
                            <button
                              key={n.id}
                              type="button"
                              className="btn btn-xs btn-ghost-link"
                              onClick={() => onSelectNode && onSelectNode(n.id)}
                              title={`Navigate to node ${n.name}`}
                              data-testid={`req-resolve-node-${n.id}`}
                            >
                              <Tag size={10} /> Node: {n.name}
                            </button>
                          ))}
                          {resolved.edges.map(e => (
                            <button
                              key={e.id}
                              type="button"
                              className="btn btn-xs btn-ghost-link"
                              onClick={() => onSelectEdge && onSelectEdge(e.id)}
                              title={`Navigate to edge ${e.kind}`}
                              data-testid={`req-resolve-edge-${e.id}`}
                            >
                              <Link2 size={10} /> Edge: {e.kind} ({e.id})
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty-sub-state">
                  <p>No requirements linked to this item yet.</p>
                </div>
              )}
            </div>

            {/* Attach existing requirement */}
            {unlinkedRequirements.length > 0 && (
              <div className="attach-req-section mt-4">
                <span className="section-label">Attach Existing Requirement</span>
                <div className="flex-row gap-2 mt-1">
                  <select
                    className="form-select flex-1"
                    value={selectedUnlinkedReqId}
                    onChange={e => setSelectedUnlinkedReqId(e.target.value)}
                    data-testid="select-unlinked-requirement"
                  >
                    <option value="">Select a requirement…</option>
                    {unlinkedRequirements.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.id}: {r.text.slice(0, 35)}…
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    disabled={!selectedUnlinkedReqId}
                    onClick={handleAttachExistingReq}
                    data-testid="attach-requirement-btn"
                  >
                    <Plus size={12} /> Attach
                  </button>
                </div>
              </div>
            )}

            {/* Create and attach new requirement */}
            <div className="create-req-section mt-4">
              <span className="section-label">Create & Attach New Requirement</span>
              <div className="inspector-form mt-2">
                <div className="inspector-form-group">
                  <label htmlFor="input-new-req-id">Requirement ID (Optional)</label>
                  <input
                    id="input-new-req-id"
                    type="text"
                    placeholder="e.g. req-auth-verify"
                    className="form-input"
                    value={newReqId}
                    onChange={e => setNewReqId(e.target.value)}
                    data-testid="input-new-req-id"
                  />
                </div>
                <div className="inspector-form-group">
                  <label htmlFor="input-new-req-text">Specification Statement *</label>
                  <textarea
                    id="input-new-req-text"
                    className={`form-textarea ${validationErrors.reqText ? 'is-invalid' : ''}`}
                    rows={2}
                    placeholder="Must guarantee..."
                    value={newReqText}
                    onChange={e => {
                      setNewReqText(e.target.value);
                      setValidationErrors(prev => {
                        const copy = { ...prev };
                        delete copy.reqText;
                        return copy;
                      });
                    }}
                    data-testid="input-new-req-text"
                  />
                  {validationErrors.reqText && (
                    <span className="field-error-msg" data-testid="field-error-req-text">
                      <AlertCircle size={12} /> {validationErrors.reqText}
                    </span>
                  )}
                </div>
                <div className="inspector-form-group">
                  <label htmlFor="input-new-req-constraints">Constraints (one per line)</label>
                  <textarea
                    id="input-new-req-constraints"
                    className="form-textarea"
                    rows={2}
                    value={newReqConstraints}
                    onChange={e => setNewReqConstraints(e.target.value)}
                    data-testid="input-new-req-constraints"
                  />
                </div>
                <div className="inspector-form-group">
                  <label htmlFor="input-new-req-scenarios">Acceptance Scenarios (one per line)</label>
                  <textarea
                    id="input-new-req-scenarios"
                    className="form-textarea"
                    rows={2}
                    value={newReqScenarios}
                    onChange={e => setNewReqScenarios(e.target.value)}
                    data-testid="input-new-req-scenarios"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary mt-2"
                  onClick={handleCreateAndAttachReq}
                  data-testid="create-attach-requirement-btn"
                >
                  <Plus size={12} /> Create & Attach
                </button>
              </div>
            </div>
          </div>
        ) : selectedNode ? (
          <div className="inspector-details" data-testid="node-inspector">
            <div className="inspector-section">
              <div className="inspector-title-row">
                <div>
                  <span className="section-label">Selected Node</span>
                  <h3 className="item-title" title={selectedNode.name}>
                    {selectedNode.name}
                  </h3>
                </div>
                <div className="inspector-actions">
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => setActiveTab('edit')}
                    title={`Edit properties for ${selectedNode.name}`}
                    data-testid="inspector-edit-properties-btn"
                  >
                    <Edit3 size={12} />
                    <span>Edit Properties</span>
                  </button>

                  {(selectedNode.kind === 'entity' || selectedNode.kind === 'enum') && onEditErNode ? (
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => onEditErNode(selectedNode.id)}
                      title={`Edit ER schema for ${selectedNode.name}`}
                      data-testid="inspector-edit-er-node"
                    >
                      <Database size={12} />
                      <span>Edit ER</span>
                    </button>
                  ) : selectedNode.kind === 'function' ? (
                    <>
                      {onEditFunctionNode && (
                        <button
                          className="btn btn-xs btn-outline"
                          onClick={() => onEditFunctionNode(selectedNode.id)}
                          title={`Edit function contract for ${selectedNode.name}`}
                          data-testid="inspector-edit-function-node"
                        >
                          <Terminal size={12} />
                          <span>Edit Function</span>
                        </button>
                      )}
                      {onEditWorkflowNode && (
                        <button
                          className="btn btn-xs btn-outline"
                          onClick={() => onEditWorkflowNode(selectedNode.id)}
                          title={`Edit workflow for ${selectedNode.name}`}
                          data-testid="inspector-edit-workflow-node"
                        >
                          <Workflow size={12} />
                          <span>Workflow</span>
                        </button>
                      )}
                    </>
                  ) : selectedNode.kind === 'step' && onEditWorkflowNode ? (
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => onEditWorkflowNode(selectedNode.id)}
                      title={`Edit workflow step ${selectedNode.name}`}
                      data-testid="inspector-edit-step-node"
                    >
                      <Workflow size={12} />
                      <span>Edit Step</span>
                    </button>
                  ) : onEditNode ? (
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => onEditNode(selectedNode.id)}
                      title={`Edit ${selectedNode.name}`}
                      data-testid="inspector-edit-node"
                    >
                      <Edit3 size={12} />
                      <span>Edit</span>
                    </button>
                  ) : null}
                  {onDeleteNode && (
                    <button
                      className="btn btn-xs btn-outline-danger"
                      onClick={() => onDeleteNode(selectedNode.id)}
                      title={`Delete ${selectedNode.name}`}
                      data-testid="inspector-delete-node"
                    >
                      <Trash2 size={12} />
                      <span>Delete</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="badge-row">
                <span className="kind-badge">{selectedNode.kind}</span>
                {selectedNode.stepType && (
                  <span
                    className={`step-badge step-badge-${selectedNode.stepType}`}
                    data-testid="inspector-step-type"
                  >
                    {selectedNode.stepType}
                  </span>
                )}
                <span className={`policy-badge policy-${selectedNode.policy}`}>
                  <Shield size={12} />
                  {selectedNode.policy}
                </span>
                <span className={`prov-badge prov-${selectedNode.provenance}`}>
                  <Tag size={12} />
                  {selectedNode.provenance}
                </span>
              </div>

              {selectedNode.provenance === 'ai' && (
                <div className="ai-notice-banner" data-testid="ai-notice-banner">
                  <Cpu size={14} />
                  <span>AI-inferred interpretation: not compiler-verified evidence.</span>
                </div>
              )}

              {selectedNode.stepType === 'opaque' && (
                <div className="opaque-logic-banner" data-testid="opaque-logic-banner">
                  <ShieldAlert size={14} />
                  <span>Opaque logic: unsupported constructs retained as source-backed opaque node. Source access preserved.</span>
                </div>
              )}

              {selectedNode.policy === 'sensitive' && (
                <div className="inspector-sensitive-banner" data-testid="inspector-sensitive-banner">
                  <ShieldAlert size={14} />
                  <span>Sensitive element: subject to additional human review emphasis and configured verification checks (R24).</span>
                </div>
              )}
            </div>

            <div className="inspector-field">
              <label>Node ID</label>
              <code>{selectedNode.id}</code>
            </div>

            {selectedNode.parentId && (
              <div className="inspector-field">
                <label>Parent Container</label>
                {onSelectNode ? (
                  <button
                    type="button"
                    className="btn-ghost-link"
                    onClick={() => onSelectNode(selectedNode.parentId!)}
                    data-testid="node-parent-link"
                  >
                    {selectedNode.parentId}
                  </button>
                ) : (
                  <span>{selectedNode.parentId}</span>
                )}
              </div>
            )}

            {selectedNode.description && (
              <div className="inspector-field">
                <label>Description</label>
                <p className="item-desc">{selectedNode.description}</p>
              </div>
            )}

            {selectedNode.contract && (
              <div className="inspector-field">
                <label>Contract / Interface</label>
                <pre className="code-block">{selectedNode.contract}</pre>
              </div>
            )}

            {selectedNode.fields && selectedNode.fields.length > 0 && (
              <div className="inspector-field">
                <label>Fields ({selectedNode.fields.length})</label>
                <div className="fields-table-wrapper">
                  <table className="fields-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Key</th>
                        <th>Mapped</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedNode.fields.map((f, i) => (
                        <tr key={i}>
                          <td>
                            {f.name}
                            {f.optional ? '?' : ''}
                          </td>
                          <td>
                            <code>{f.type}</code>
                          </td>
                          <td>{f.key || '-'}</td>
                          <td>{f.mappedName ? <code>{f.mappedName}</code> : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedNode.inputs && (
              <div className="inspector-field">
                <label>Inputs</label>
                <p className="item-desc multiline-text">{selectedNode.inputs}</p>
              </div>
            )}

            {selectedNode.outputs && (
              <div className="inspector-field">
                <label>Outputs</label>
                <p className="item-desc multiline-text">{selectedNode.outputs}</p>
              </div>
            )}

            {selectedNode.rules && (
              <div className="inspector-field">
                <label>Rules</label>
                <p className="item-desc multiline-text">{selectedNode.rules}</p>
              </div>
            )}

            {selectedNode.errors && (
              <div className="inspector-field">
                <label>Errors</label>
                <p className="item-desc multiline-text">{selectedNode.errors}</p>
              </div>
            )}

            {selectedNode.scenarios && selectedNode.scenarios.length > 0 && (
              <div className="inspector-field">
                <label>Scenarios ({selectedNode.scenarios.length})</label>
                <ul className="scenario-list">
                  {selectedNode.scenarios.map((sc, i) => (
                    <li key={i} className="multiline-text">
                      {sc}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedNode.requiredChecks && selectedNode.requiredChecks.length > 0 && (
              <div className="inspector-field">
                <label>Required Checks ({selectedNode.requiredChecks.length})</label>
                <ul className="check-list">
                  {selectedNode.requiredChecks.map((chk, i) => (
                    <li key={i}>
                      <CheckCircle2 size={12} /> {chk}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedNode.instructions && (
              <div className="inspector-field" data-testid="inspector-instructions">
                <label>Sensitive Instructions</label>
                <p className="item-desc multiline-text">{selectedNode.instructions}</p>
              </div>
            )}

            {selectedNode.baseline && (
              <div className="inspector-field" data-testid="inspector-baseline">
                <label>Deliberate Baseline</label>
                <div className="baseline-summary-badge">
                  <Lock size={12} />
                  <span>
                    {selectedNode.baseline.text !== undefined
                      ? 'Frozen Implementation Baseline'
                      : 'Frozen Contract Baseline'}
                  </span>
                </div>
              </div>
            )}

            {selectedNode.outputPath && (
              <div className="inspector-field">
                <label>Output Path</label>
                <code>{selectedNode.outputPath}</code>
              </div>
            )}

            {selectedNode.source && (
              <div
                className="inspector-field"
                data-testid={selectedNode.stepType === 'opaque' ? 'opaque-source-access' : undefined}
              >
                <label>Bound Source</label>
                <div className="source-meta-card">
                  <div>
                    <strong>File:</strong>{' '}
                    <span data-testid={selectedNode.stepType === 'opaque' ? 'opaque-source-path' : undefined}>
                      {selectedNode.source.path}
                    </span>
                  </div>
                  <div>
                    <strong>Line:</strong>{' '}
                    <span data-testid={selectedNode.stepType === 'opaque' ? 'opaque-source-line' : undefined}>
                      {selectedNode.source.line}
                    </span>
                  </div>
                  <div>
                    <strong>Revision:</strong>{' '}
                    <span data-testid={selectedNode.stepType === 'opaque' ? 'opaque-source-revision' : undefined}>
                      {selectedNode.source.revision}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Linked Requirements Section */}
            <div className="inspector-field" data-testid="inspector-linked-requirements">
              <div className="flex-row justify-between align-center mb-1">
                <label>Linked Requirements ({linkedRequirements.length})</label>
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={() => setActiveTab('requirements')}
                  data-testid="inspector-manage-req-btn"
                >
                  <Link2 size={10} /> Manage
                </button>
              </div>
              {linkedRequirements.length > 0 ? (
                <div className="linked-req-summary-list">
                  {linkedRequirements.map(req => {
                    const resolved = resolveRequirementItems(graph, req);
                    return (
                      <div key={req.id} className="req-summary-card">
                        <div className="flex-row justify-between align-center">
                          <strong>{req.id}</strong>
                        </div>
                        <p className="item-desc">{req.text}</p>
                        {resolved.nodes.length > 0 && (
                          <div className="req-owners-row mt-1">
                            <span className="sub-label">Owning nodes:</span>
                            {resolved.nodes.map(n => (
                              <button
                                key={n.id}
                                type="button"
                                className="btn-ghost-link"
                                onClick={() => onSelectNode && onSelectNode(n.id)}
                                data-testid={`req-resolve-node-${n.id}`}
                              >
                                {n.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="item-desc text-muted">No requirements attached.</p>
              )}
            </div>
          </div>
        ) : selectedEdge ? (
          <div className="inspector-details" data-testid="edge-inspector">
            <div className="inspector-section">
              <div className="inspector-title-row">
                <div>
                  <span className="section-label">Selected Relationship</span>
                  <h3 className="item-title">{selectedEdge.kind}</h3>
                </div>
                <div className="inspector-actions">
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => setActiveTab('edit')}
                    title={`Edit relationship properties`}
                    data-testid="inspector-edit-properties-btn"
                  >
                    <Edit3 size={12} />
                    <span>Edit Properties</span>
                  </button>
                </div>
              </div>
              <div className="badge-row">
                <span className="kind-badge">{selectedEdge.kind}</span>
                <span className={`prov-badge prov-${selectedEdge.provenance}`}>
                  {selectedEdge.provenance}
                </span>
                {selectedEdge.uncertain && (
                  <span className="uncertain-badge">
                    <AlertCircle size={12} /> Uncertain
                  </span>
                )}
              </div>

              {selectedEdge.provenance === 'ai' && (
                <div className="ai-notice-banner" data-testid="ai-notice-banner">
                  <Cpu size={14} />
                  <span>AI-inferred interpretation: not compiler-verified evidence.</span>
                </div>
              )}
            </div>

            <div className="inspector-field">
              <label>Edge ID</label>
              <code>{selectedEdge.id}</code>
            </div>

            <div className="inspector-field">
              <label>Source Node</label>
              {onSelectNode ? (
                <button
                  type="button"
                  className="btn-ghost-link"
                  onClick={() => onSelectNode(selectedEdge.source)}
                  data-testid="edge-source-node-link"
                >
                  {graph?.nodes.find(n => n.id === selectedEdge.source)?.name || selectedEdge.source}
                </button>
              ) : (
                <span data-testid="edge-source-node-link">
                  {graph?.nodes.find(n => n.id === selectedEdge.source)?.name || selectedEdge.source}
                </span>
              )}
            </div>

            <div className="inspector-field">
              <label>Target Node</label>
              {onSelectNode ? (
                <button
                  type="button"
                  className="btn-ghost-link"
                  onClick={() => onSelectNode(selectedEdge.target)}
                  data-testid="edge-target-node-link"
                >
                  {graph?.nodes.find(n => n.id === selectedEdge.target)?.name || selectedEdge.target}
                </button>
              ) : (
                <span data-testid="edge-target-node-link">
                  {graph?.nodes.find(n => n.id === selectedEdge.target)?.name || selectedEdge.target}
                </span>
              )}
            </div>

            {selectedEdge.label && (
              <div className="inspector-field">
                <label>Label</label>
                <span>{selectedEdge.label}</span>
              </div>
            )}

            {/* Linked Requirements for Edge */}
            <div className="inspector-field" data-testid="inspector-linked-requirements">
              <div className="flex-row justify-between align-center mb-1">
                <label>Linked Requirements ({linkedRequirements.length})</label>
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={() => setActiveTab('requirements')}
                  data-testid="inspector-manage-req-btn"
                >
                  <Link2 size={10} /> Manage
                </button>
              </div>
              {linkedRequirements.length > 0 ? (
                <div className="linked-req-summary-list">
                  {linkedRequirements.map(req => {
                    const resolved = resolveRequirementItems(graph, req);
                    return (
                      <div key={req.id} className="req-summary-card">
                        <strong>{req.id}</strong>
                        <p className="item-desc">{req.text}</p>
                        {resolved.edges.length > 0 && (
                          <div className="req-owners-row mt-1">
                            <span className="sub-label">Owning edges:</span>
                            {resolved.edges.map(e => (
                              <button
                                key={e.id}
                                type="button"
                                className="btn-ghost-link"
                                onClick={() => onSelectEdge && onSelectEdge(e.id)}
                                data-testid={`req-resolve-edge-${e.id}`}
                              >
                                {e.kind} ({e.id})
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="item-desc text-muted">No requirements attached.</p>
              )}
            </div>
          </div>
        ) : project ? (
          <div className="inspector-details" data-testid="project-inspector">
            <div className="inspector-section">
              <span className="section-label">Project Overview</span>
              <h3 className="item-title">{project.name}</h3>
              <p className="item-desc">{project.description || 'No description provided.'}</p>
            </div>

            <div className="inspector-field">
              <label>Project ID</label>
              <code>{project.id}</code>
            </div>

            <div className="inspector-field">
              <label>Target Platform</label>
              <span>{project.target}</span>
            </div>

            <div className="inspector-field">
              <label>Root Directory</label>
              <code>{project.root || 'In-memory / Unmanaged'}</code>
            </div>

            <div className="inspector-field">
              <label>Specification Revision</label>
              <span>Revision {project.specRevision}</span>
            </div>

            <div className="inspector-field">
              <label>Configured Checks</label>
              <span>{Object.keys(project.checks || {}).length} check(s) configured</span>
            </div>

            <div className="inspector-tip">
              <Info size={14} />
              <span>
                Select any element in the Project Tree or Canvas to inspect its individual properties,
                policies, and contracts.
              </span>
            </div>
          </div>
        ) : (
          <div className="inspector-empty" data-testid="inspector-empty">
            <p>No project or item selected.</p>
          </div>
        )}
      </div>
    </aside>
  );
};
