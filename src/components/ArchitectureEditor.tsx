import React, { useState, useMemo, useEffect } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Requirement, Project } from '../../shared/model';
import { validRelationship, GraphSchema, createNodeId, nodeKinds, policies } from '../../shared/model';
import {
  Layers,
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
  AlertTriangle,
} from 'lucide-react';

export interface ArchitectureEditorProps {
  project?: Project | null;
  graph: Graph | null;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  isOpen?: boolean;
  onClose?: () => void;
  mode?: 'modal' | 'panel' | 'inline';
  readOnly?: boolean;
  initialTab?: 'add' | 'edit' | 'connect' | 'preview-delete';
}

/**
 * Checks whether a child kind can be nested inside a parent kind according to containment rules.
 */
export function canNest(parentKind: ProgramNode['kind'], childKind: ProgramNode['kind']): boolean {
  return validRelationship('contains', parentKind, childKind);
}

/**
 * Returns available architecture kinds. Target metadata does not restrict available architecture kinds.
 */
export function getCreatableKinds(_target?: string): ProgramNode['kind'][] {
  return ['system', 'module', 'class', 'interface', 'function', 'entity', 'enum'];
}

/**
 * Validates whether a relationship kind is allowed between source and target node kinds.
 */
export function validateRelationship(
  kind: ProgramEdge['kind'],
  sourceKind: ProgramNode['kind'],
  targetKind: ProgramNode['kind']
): { valid: boolean; error?: string } {
  const isValid = validRelationship(kind, sourceKind, targetKind);
  if (!isValid) {
    return {
      valid: false,
      error: `Invalid relationship: "${kind}" is not supported from ${sourceKind} to ${targetKind}.`,
    };
  }
  return { valid: true };
}

export interface DestructiveEditPreview {
  affectedNode: ProgramNode;
  affectedEdges: ProgramEdge[];
  childNodes: ProgramNode[];
  referencingRequirements: Requirement[];
}

/**
 * Previews destructive graph edits before removing an architecture item.
 * Identifies affected edges (relationships), nested child nodes, and referenced requirements.
 */
export function previewDestructiveEdit(graph: Graph, nodeId: string): DestructiveEditPreview {
  const targetNode = graph.nodes.find(n => n.id === nodeId);
  if (!targetNode) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const affectedEdges = graph.edges.filter(e => e.source === nodeId || e.target === nodeId);
  const childNodes = graph.nodes.filter(n => n.parentId === nodeId);
  const affectedEdgeIds = new Set(affectedEdges.map(e => e.id));

  const referencingRequirements = graph.requirements.filter(req =>
    req.nodeIds.includes(nodeId) || req.edgeIds.some(eid => affectedEdgeIds.has(eid))
  );

  return {
    affectedNode: targetNode,
    affectedEdges,
    childNodes,
    referencingRequirements,
  };
}

/**
 * Creates an architecture node in the graph and validates containment rules and schema.
 */
export function createArchitectureNode(
  graph: Graph,
  input: {
    name: string;
    kind: ProgramNode['kind'];
    parentId?: string;
    description?: string;
    contract?: string;
    policy?: ProgramNode['policy'];
    id?: string;
    requiredChecks?: string[];
    instructions?: string;
    outputPath?: string;
  }
): { graph: Graph; node: ProgramNode } {
  if (!input.name.trim()) {
    throw new Error('Node name must not be blank');
  }

  if (input.parentId) {
    const parent = graph.nodes.find(n => n.id === input.parentId);
    if (!parent) {
      throw new Error(`Parent node does not exist: ${input.parentId}`);
    }
    if (!canNest(parent.kind, input.kind)) {
      throw new Error(`Invalid nesting: ${parent.kind} cannot contain ${input.kind}`);
    }
  }

  const nodeId = input.id || createNodeId();
  if (graph.nodes.some(n => n.id === nodeId)) {
    throw new Error(`Duplicate node ID: ${nodeId}`);
  }

  const policy = input.policy || 'editable';
  const contract = input.contract || '';

  const newNode: ProgramNode = {
    id: nodeId,
    kind: input.kind,
    name: input.name.trim(),
    parentId: input.parentId || undefined,
    description: input.description?.trim() || '',
    provenance: 'human',
    policy,
    contract,
    requiredChecks: input.requiredChecks || [],
    instructions: input.instructions?.trim() || '',
    outputPath: input.outputPath?.trim() || '',
    fields: [],
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: [...graph.nodes, newNode],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating node');
  }

  return { graph: validation.data, node: newNode };
}

/**
 * Updates an architecture node (renaming, editing description/module responsibilities,
 * editing interface definitions, updating nesting/parent).
 */
export function updateArchitectureNode(
  graph: Graph,
  nodeId: string,
  updates: {
    name?: string;
    description?: string;
    contract?: string;
    parentId?: string | null;
    policy?: ProgramNode['policy'];
    requiredChecks?: string[];
    instructions?: string;
    outputPath?: string;
  }
): { graph: Graph; node: ProgramNode } {
  const existingNode = graph.nodes.find(n => n.id === nodeId);
  if (!existingNode) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existingNode.name;
  if (!nextName) {
    throw new Error('Node name must not be blank');
  }

  let nextParentId: string | undefined = existingNode.parentId;
  if (updates.parentId !== undefined) {
    if (updates.parentId === null || updates.parentId === '') {
      nextParentId = undefined;
    } else {
      if (updates.parentId === nodeId) {
        throw new Error('A node cannot be its own parent');
      }
      const parentNode = graph.nodes.find(n => n.id === updates.parentId);
      if (!parentNode) {
        throw new Error(`Parent node does not exist: ${updates.parentId}`);
      }
      if (!canNest(parentNode.kind, existingNode.kind)) {
        throw new Error(`Invalid nesting: ${parentNode.kind} cannot contain ${existingNode.kind}`);
      }
      nextParentId = updates.parentId;
    }
  }

  const updatedNode: ProgramNode = {
    ...existingNode,
    name: nextName,
    description: updates.description !== undefined ? updates.description.trim() : existingNode.description,
    contract: updates.contract !== undefined ? updates.contract.trim() : existingNode.contract,
    parentId: nextParentId,
    policy: updates.policy !== undefined ? updates.policy : existingNode.policy,
    requiredChecks: updates.requiredChecks !== undefined ? updates.requiredChecks : existingNode.requiredChecks,
    instructions: updates.instructions !== undefined ? updates.instructions.trim() : existingNode.instructions,
    outputPath: updates.outputPath !== undefined ? updates.outputPath.trim() : existingNode.outputPath,
  };

  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId ? updatedNode : n)),
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after updating node');
  }

  return { graph: validation.data, node: updatedNode };
}

/**
 * Connects two architecture items with a relationship edge, validating relationship semantics.
 */
export function connectNodes(
  graph: Graph,
  input: {
    sourceId: string;
    targetId: string;
    kind: ProgramEdge['kind'];
    label?: string;
    id?: string;
  }
): { graph: Graph; edge: ProgramEdge } {
  const sourceNode = graph.nodes.find(n => n.id === input.sourceId);
  const targetNode = graph.nodes.find(n => n.id === input.targetId);

  if (!sourceNode) {
    throw new Error(`Source node not found: ${input.sourceId}`);
  }
  if (!targetNode) {
    throw new Error(`Target node not found: ${input.targetId}`);
  }

  const relCheck = validateRelationship(input.kind, sourceNode.kind, targetNode.kind);
  if (!relCheck.valid) {
    throw new Error(relCheck.error);
  }

  const edgeId = input.id || createNodeId();
  if (graph.edges.some(e => e.id === edgeId)) {
    throw new Error(`Duplicate edge ID: ${edgeId}`);
  }

  const newEdge: ProgramEdge = {
    id: edgeId,
    source: input.sourceId,
    target: input.targetId,
    kind: input.kind,
    label: input.label?.trim() || '',
    provenance: 'human',
    uncertain: false,
  };

  const nextGraph: Graph = {
    ...graph,
    edges: [...graph.edges, newEdge],
  };

  const validation = GraphSchema.safeParse(nextGraph);
  if (!validation.success) {
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after creating edge');
  }

  return { graph: validation.data, edge: newEdge };
}

/**
 * Removes an architecture node and its connected edges, re-parents its children,
 * and preserves referenced requirements (removing only node/edge ID references while keeping requirement items).
 */
export function removeArchitectureNode(
  graph: Graph,
  nodeId: string
): {
  graph: Graph;
  removedNode: ProgramNode;
  removedEdges: ProgramEdge[];
  reparentedChildren: ProgramNode[];
  preservedRequirements: Requirement[];
} {
  const targetNode = graph.nodes.find(n => n.id === nodeId);
  if (!targetNode) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const removedEdges = graph.edges.filter(e => e.source === nodeId || e.target === nodeId);
  const removedEdgeIds = new Set(removedEdges.map(e => e.id));

  // Re-parent children to targetNode's parent
  const reparentedChildren: ProgramNode[] = [];
  const nextNodes = graph.nodes
    .filter(n => n.id !== nodeId)
    .map(n => {
      if (n.parentId === nodeId) {
        const reparented = { ...n, parentId: targetNode.parentId };
        reparentedChildren.push(reparented);
        return reparented;
      }
      return n;
    });

  const nextEdges = graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

  // Preserve requirements: retain every requirement record, updating references
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
    throw new Error(validation.error.issues[0]?.message || 'Graph validation failed after removing node');
  }

  return {
    graph: validation.data,
    removedNode: targetNode,
    removedEdges,
    reparentedChildren,
    preservedRequirements,
  };
}

export const ArchitectureEditor: React.FC<ArchitectureEditorProps> = ({
  project,
  graph,
  onUpdateSpecification,
  selectedNodeId,
  onSelectNode,
  isOpen = true,
  onClose,
  mode = 'modal',
  readOnly = false,
  initialTab = 'add',
}) => {
  const [activeTab, setActiveTab] = useState<'add' | 'edit' | 'connect' | 'preview-delete'>(initialTab);
  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const edges = useMemo(() => graph?.edges || [], [graph]);
  const creatableKinds = useMemo(() => getCreatableKinds(project?.target), [project?.target]);

  const initialNode = useMemo(() => {
    if (selectedNodeId) {
      return nodes.find(n => n.id === selectedNodeId) || null;
    }
    return nodes.length > 0 ? nodes[0] : null;
  }, [selectedNodeId, nodes]);

  const [selectedForEditId, setSelectedForEditId] = useState<string>(initialNode?.id || '');
  const [selectedForDeleteId, setSelectedForDeleteId] = useState<string>(initialNode?.id || '');

  // Add Form State
  const [addName, setAddName] = useState<string>('');
  const [addKind, setAddKind] = useState<ProgramNode['kind']>('module');
  const [addParentId, setAddParentId] = useState<string>('');
  const [addDescription, setAddDescription] = useState<string>('');
  const [addContract, setAddContract] = useState<string>('');
  const [addPolicy, setAddPolicy] = useState<ProgramNode['policy']>('editable');

  // Edit Form State
  const [editName, setEditName] = useState<string>(initialNode?.name || '');
  const [editDescription, setEditDescription] = useState<string>(initialNode?.description || '');
  const [editContract, setEditContract] = useState<string>(initialNode?.contract || '');
  const [editParentId, setEditParentId] = useState<string>(initialNode?.parentId || '');
  const [editPolicy, setEditPolicy] = useState<ProgramNode['policy']>(initialNode?.policy || 'editable');

  // Connect Form State
  const [connectSourceId, setConnectSourceId] = useState<string>('');
  const [connectTargetId, setConnectTargetId] = useState<string>('');
  const [connectKind, setConnectKind] = useState<ProgramEdge['kind']>('implements');
  const [connectLabel, setConnectLabel] = useState<string>('');

  // Status/Error State
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sync selectedNodeId changes
  useEffect(() => {
    if (selectedNodeId) {
      setSelectedForEditId(selectedNodeId);
      setSelectedForDeleteId(selectedNodeId);
    }
  }, [selectedNodeId]);

  // Load selected edit node details into edit form
  useEffect(() => {
    if (!selectedForEditId) {
      if (nodes.length > 0) {
        setSelectedForEditId(nodes[0].id);
      }
      return;
    }
    const node = nodes.find(n => n.id === selectedForEditId);
    if (node) {
      setEditName(node.name);
      setEditDescription(node.description || '');
      setEditContract(node.contract || '');
      setEditParentId(node.parentId || '');
      setEditPolicy(node.policy || 'editable');
    }
  }, [selectedForEditId, nodes]);

  // Compute destructive preview for selectedForDeleteId
  const destructivePreview = useMemo<DestructiveEditPreview | null>(() => {
    if (!graph || !selectedForDeleteId) return null;
    try {
      return previewDestructiveEdit(graph, selectedForDeleteId);
    } catch {
      return null;
    }
  }, [graph, selectedForDeleteId]);

  // Potential container nodes for parent selection in Add/Edit
  const containerNodes = useMemo(() => {
    return nodes.filter(n => ['system', 'module', 'class', 'interface'].includes(n.kind));
  }, [nodes]);

  // Available relationship kinds between connectSource and connectTarget
  const availableConnectKinds = useMemo(() => {
    if (!connectSourceId || !connectTargetId) return [];
    const src = nodes.find(n => n.id === connectSourceId);
    const tgt = nodes.find(n => n.id === connectTargetId);
    if (!src || !tgt) return [];
    const allKinds: ProgramEdge['kind'][] = [
      'implements',
      'inherits',
      'depends-on',
      'calls',
      'contains',
      'relates-to',
      'reads',
      'writes',
    ];
    return allKinds.filter(k => validRelationship(k, src.kind, tgt.kind));
  }, [connectSourceId, connectTargetId, nodes]);

  // Update default connectKind when available kinds change
  useEffect(() => {
    if (availableConnectKinds.length > 0 && !availableConnectKinds.includes(connectKind)) {
      setConnectKind(availableConnectKinds[0]);
    }
  }, [availableConnectKinds, connectKind]);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!graph || !onUpdateSpecification) return;

    try {
      const { graph: nextGraph, node: created } = createArchitectureNode(graph, {
        name: addName,
        kind: addKind,
        parentId: addParentId || undefined,
        description: addDescription,
        contract: addContract,
        policy: addPolicy,
      });

      await onUpdateSpecification(nextGraph);
      setSuccessMessage(`Created ${created.kind} "${created.name}" successfully.`);
      setAddName('');
      setAddDescription('');
      setAddContract('');
      setAddParentId('');
      if (onSelectNode) {
        onSelectNode(created.id);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to create architecture item');
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!graph || !onUpdateSpecification || !selectedForEditId) return;

    try {
      const { graph: nextGraph, node: updated } = updateArchitectureNode(graph, selectedForEditId, {
        name: editName,
        description: editDescription,
        contract: editContract,
        parentId: editParentId || null,
        policy: editPolicy,
      });

      await onUpdateSpecification(nextGraph);
      setSuccessMessage(`Updated ${updated.kind} "${updated.name}" successfully.`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update architecture item');
    }
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!graph || !onUpdateSpecification) return;

    try {
      const { graph: nextGraph, edge: created } = connectNodes(graph, {
        sourceId: connectSourceId,
        targetId: connectTargetId,
        kind: connectKind,
        label: connectLabel,
      });

      await onUpdateSpecification(nextGraph);
      setSuccessMessage(`Connected nodes with relationship "${created.kind}".`);
      setConnectLabel('');
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to connect architecture items');
    }
  };

  const handleConfirmDelete = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!graph || !onUpdateSpecification || !selectedForDeleteId) return;

    try {
      const { graph: nextGraph, removedNode } = removeArchitectureNode(graph, selectedForDeleteId);
      await onUpdateSpecification(nextGraph);
      setSuccessMessage(`Removed ${removedNode.kind} "${removedNode.name}" and preserved referenced requirements.`);
      if (onSelectNode) {
        onSelectNode(null);
      }
      // Reset delete selection to remaining nodes
      const remaining = nextGraph.nodes;
      if (remaining.length > 0) {
        setSelectedForDeleteId(remaining[0].id);
        setSelectedForEditId(remaining[0].id);
      } else {
        setSelectedForDeleteId('');
        setSelectedForEditId('');
      }
      setActiveTab('edit');
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to remove architecture item');
    }
  };

  if (!isOpen) return null;

  const content = (
    <div
      className={`architecture-editor-container ${mode}`}
      data-testid="architecture-editor"
      aria-label="Architecture Editor"
    >
      <div className="arch-editor-header">
        <div className="arch-header-title">
          <Layers size={18} className="text-accent" />
          <h2>Architecture Editor</h2>
          {project && (
            <span className="arch-target-badge" data-testid="arch-target-badge">
              {`Target: ${project.target || 'General'}`}
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            className="btn btn-xs btn-icon btn-close-arch"
            onClick={onClose}
            aria-label="Close Architecture Editor"
            data-testid="close-arch-editor"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <nav className="arch-tabs" data-testid="arch-tabs">
        <button
          type="button"
          className={`arch-tab-btn ${activeTab === 'add' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('add');
            setErrorMessage(null);
            setSuccessMessage(null);
          }}
          data-testid="arch-tab-add"
        >
          <Plus size={14} />
          <span>Add Item</span>
        </button>
        <button
          type="button"
          className={`arch-tab-btn ${activeTab === 'edit' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('edit');
            setErrorMessage(null);
            setSuccessMessage(null);
          }}
          data-testid="arch-tab-edit"
        >
          <Edit3 size={14} />
          <span>Edit & Responsibilities</span>
        </button>
        <button
          type="button"
          className={`arch-tab-btn ${activeTab === 'connect' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('connect');
            setErrorMessage(null);
            setSuccessMessage(null);
          }}
          data-testid="arch-tab-connect"
        >
          <Link2 size={14} />
          <span>Connect Relationships</span>
        </button>
        <button
          type="button"
          className={`arch-tab-btn tab-danger ${activeTab === 'preview-delete' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('preview-delete');
            setErrorMessage(null);
            setSuccessMessage(null);
          }}
          data-testid="arch-tab-preview"
        >
          <Trash2 size={14} />
          <span>Destructive Edit Preview</span>
        </button>
      </nav>

      {errorMessage && (
        <div className="arch-banner banner-error" data-testid="arch-error-banner">
          <AlertCircle size={16} />
          <span>{errorMessage}</span>
          <button
            type="button"
            className="btn-dismiss"
            onClick={() => setErrorMessage(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="arch-banner banner-success" data-testid="arch-success-banner">
          <CheckCircle2 size={16} />
          <span>{successMessage}</span>
          <button
            type="button"
            className="btn-dismiss"
            onClick={() => setSuccessMessage(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="arch-editor-body">
        {/* TAB 1: ADD ITEM */}
        {activeTab === 'add' && (
          <form className="arch-form" onSubmit={handleAddSubmit} data-testid="arch-add-form">
            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="arch-add-kind">Architecture Kind</label>
                <select
                  id="arch-add-kind"
                  className="input input-sm"
                  value={addKind}
                  onChange={(e) => setAddKind(e.target.value as ProgramNode['kind'])}
                  data-testid="arch-add-kind-select"
                  disabled={readOnly}
                >
                  {creatableKinds.map(k => (
                    <option key={k} value={k}>
                      {k.toUpperCase()}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Available regardless of project target metadata.
                </span>
              </div>

              <div className="form-group">
                <label htmlFor="arch-add-name">Item Name *</label>
                <input
                  id="arch-add-name"
                  type="text"
                  className="input input-sm"
                  placeholder="e.g. OrderModule or IAuthService"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  data-testid="arch-add-name-input"
                  required
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="arch-add-parent">Nest Inside Container (Parent)</label>
                <select
                  id="arch-add-parent"
                  className="input input-sm"
                  value={addParentId}
                  onChange={(e) => setAddParentId(e.target.value)}
                  data-testid="arch-add-parent-select"
                  disabled={readOnly}
                >
                  <option value="">Root / Top-level (no parent)</option>
                  {containerNodes.map(c => {
                    const nestable = canNest(c.kind, addKind);
                    return (
                      <option key={c.id} value={c.id} disabled={!nestable}>
                        {c.name} ({c.kind}) {!nestable ? '— cannot nest' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="arch-add-policy">Protection Policy</label>
                <select
                  id="arch-add-policy"
                  className="input input-sm"
                  value={addPolicy}
                  onChange={(e) => setAddPolicy(e.target.value as ProgramNode['policy'])}
                  data-testid="arch-add-policy-select"
                  disabled={readOnly}
                >
                  {policies.map(p => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="arch-add-desc">Description & Module Responsibilities</label>
              <textarea
                id="arch-add-desc"
                className="input input-sm textarea"
                rows={3}
                placeholder="Declare responsibilities, domain boundaries, or business logic…"
                value={addDescription}
                onChange={(e) => setAddDescription(e.target.value)}
                data-testid="arch-add-desc-input"
                disabled={readOnly}
              />
            </div>

            <div className="form-group">
              <label htmlFor="arch-add-contract">Interface Definition / Declared Contract</label>
              <textarea
                id="arch-add-contract"
                className="input input-sm textarea font-mono"
                rows={3}
                placeholder="export interface IService { ... }"
                value={addContract}
                onChange={(e) => setAddContract(e.target.value)}
                data-testid="arch-add-contract-input"
                disabled={readOnly}
              />
            </div>

            <div className="arch-actions">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={readOnly || !addName.trim()}
                data-testid="arch-add-submit-btn"
              >
                <Plus size={14} />
                <span>Create Architecture Item</span>
              </button>
            </div>
          </form>
        )}

        {/* TAB 2: EDIT & MODULE RESPONSIBILITIES */}
        {activeTab === 'edit' && (
          <form className="arch-form" onSubmit={handleEditSubmit} data-testid="arch-edit-form">
            <div className="form-group">
              <label htmlFor="arch-edit-node-select">Select Architecture Item to Edit</label>
              <select
                id="arch-edit-node-select"
                className="input input-sm"
                value={selectedForEditId}
                onChange={(e) => {
                  setSelectedForEditId(e.target.value);
                  setSelectedForDeleteId(e.target.value);
                  if (onSelectNode) onSelectNode(e.target.value);
                }}
                data-testid="arch-edit-node-select"
              >
                <option value="">Select item…</option>
                {nodes.map(n => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.kind})
                  </option>
                ))}
              </select>
            </div>

            {selectedForEditId && (
              <>
                <div className="form-row-2">
                  <div className="form-group">
                    <label htmlFor="arch-edit-name">Item Name (Rename) *</label>
                    <input
                      id="arch-edit-name"
                      type="text"
                      className="input input-sm"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      data-testid="arch-edit-name-input"
                      required
                      disabled={readOnly}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="arch-edit-parent">Nest Container (Re-parent)</label>
                    <select
                      id="arch-edit-parent"
                      className="input input-sm"
                      value={editParentId}
                      onChange={(e) => setEditParentId(e.target.value)}
                      data-testid="arch-edit-parent-select"
                      disabled={readOnly}
                    >
                      <option value="">Root / Top-level (no parent)</option>
                      {containerNodes
                        .filter(c => c.id !== selectedForEditId)
                        .map(c => {
                          const curr = nodes.find(n => n.id === selectedForEditId);
                          const nestable = curr ? canNest(c.kind, curr.kind) : true;
                          return (
                            <option key={c.id} value={c.id} disabled={!nestable}>
                              {c.name} ({c.kind}) {!nestable ? '— cannot nest' : ''}
                            </option>
                          );
                        })}
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="arch-edit-desc">Module Responsibilities & Description</label>
                  <textarea
                    id="arch-edit-desc"
                    className="input input-sm textarea"
                    rows={3}
                    placeholder="Edit responsibilities and documentation…"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    data-testid="arch-edit-desc-input"
                    disabled={readOnly}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="arch-edit-contract">Interface Definition & Typed Contract</label>
                  <textarea
                    id="arch-edit-contract"
                    className="input input-sm textarea font-mono"
                    rows={4}
                    placeholder="export interface IService { ... }"
                    value={editContract}
                    onChange={(e) => setEditContract(e.target.value)}
                    data-testid="arch-edit-contract-input"
                    disabled={readOnly}
                  />
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label htmlFor="arch-edit-policy">Protection Policy</label>
                    <select
                      id="arch-edit-policy"
                      className="input input-sm"
                      value={editPolicy}
                      onChange={(e) => setEditPolicy(e.target.value as ProgramNode['policy'])}
                      data-testid="arch-edit-policy-select"
                      disabled={readOnly}
                    >
                      {policies.map(p => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="arch-actions space-between">
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={readOnly || !editName.trim()}
                    data-testid="arch-edit-submit-btn"
                  >
                    <CheckCircle2 size={14} />
                    <span>Save Changes</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => {
                      setSelectedForDeleteId(selectedForEditId);
                      setActiveTab('preview-delete');
                    }}
                    data-testid="arch-open-delete-preview-btn"
                  >
                    <Trash2 size={14} />
                    <span>Preview Removal…</span>
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        {/* TAB 3: CONNECT RELATIONSHIPS */}
        {activeTab === 'connect' && (
          <form className="arch-form" onSubmit={handleConnectSubmit} data-testid="arch-connect-form">
            <div className="form-row-3">
              <div className="form-group">
                <label htmlFor="arch-connect-src">Source Item</label>
                <select
                  id="arch-connect-src"
                  className="input input-sm"
                  value={connectSourceId}
                  onChange={(e) => setConnectSourceId(e.target.value)}
                  data-testid="arch-connect-source-select"
                  disabled={readOnly}
                >
                  <option value="">Select source…</option>
                  {nodes.map(n => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.kind})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="arch-connect-tgt">Target Item</label>
                <select
                  id="arch-connect-tgt"
                  className="input input-sm"
                  value={connectTargetId}
                  onChange={(e) => setConnectTargetId(e.target.value)}
                  data-testid="arch-connect-target-select"
                  disabled={readOnly}
                >
                  <option value="">Select target…</option>
                  {nodes.map(n => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.kind})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="arch-connect-kind">Relationship Kind</label>
                <select
                  id="arch-connect-kind"
                  className="input input-sm"
                  value={connectKind}
                  onChange={(e) => setConnectKind(e.target.value as ProgramEdge['kind'])}
                  data-testid="arch-connect-kind-select"
                  disabled={readOnly || availableConnectKinds.length === 0}
                >
                  {availableConnectKinds.length === 0 ? (
                    <option value="">No supported relationship</option>
                  ) : (
                    availableConnectKinds.map(k => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="arch-connect-label">Label (optional)</label>
              <input
                id="arch-connect-label"
                type="text"
                className="input input-sm"
                placeholder="e.g. implements interface contract"
                value={connectLabel}
                onChange={(e) => setConnectLabel(e.target.value)}
                data-testid="arch-connect-label-input"
                disabled={readOnly}
              />
            </div>

            {connectSourceId && connectTargetId && (
              <div
                className={`relationship-preview-note ${availableConnectKinds.length > 0 ? 'valid' : 'invalid'}`}
                data-testid="arch-relationship-validation-note"
              >
                {availableConnectKinds.length > 0 ? (
                  <>
                    <CheckCircle2 size={14} />
                    <span>
                      Supported relationship: {nodes.find(n => n.id === connectSourceId)?.kind} → {connectKind} → {nodes.find(n => n.id === connectTargetId)?.kind}
                    </span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={14} />
                    <span>
                      Unsupported relationship between {nodes.find(n => n.id === connectSourceId)?.kind} and {nodes.find(n => n.id === connectTargetId)?.kind}.
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="arch-actions">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={readOnly || !connectSourceId || !connectTargetId || availableConnectKinds.length === 0}
                data-testid="arch-connect-submit-btn"
              >
                <Link2 size={14} />
                <span>Create Relationship</span>
              </button>
            </div>

            {edges.length > 0 && (
              <div className="arch-existing-edges" data-testid="arch-existing-edges">
                <h4>Existing Relationships ({edges.length})</h4>
                <div className="edge-list-scroll">
                  {edges.map(e => {
                    const src = nodes.find(n => n.id === e.source);
                    const tgt = nodes.find(n => n.id === e.target);
                    return (
                      <div key={e.id} className="arch-edge-row" data-testid={`arch-edge-item-${e.id}`}>
                        <span className="edge-src">{src?.name || e.source}</span>
                        <ChevronRight size={12} />
                        <span className="edge-badge">{e.kind}</span>
                        <ChevronRight size={12} />
                        <span className="edge-tgt">{tgt?.name || e.target}</span>
                        {e.label && <span className="edge-label">({e.label})</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </form>
        )}

        {/* TAB 4: DESTRUCTIVE EDIT PREVIEW */}
        {activeTab === 'preview-delete' && (
          <div className="arch-preview-view" data-testid="arch-destructive-preview">
            <div className="form-group">
              <label htmlFor="arch-del-node-select">Select Architecture Item to Remove</label>
              <select
                id="arch-del-node-select"
                className="input input-sm"
                value={selectedForDeleteId}
                onChange={(e) => setSelectedForDeleteId(e.target.value)}
                data-testid="arch-delete-node-select"
              >
                <option value="">Select item…</option>
                {nodes.map(n => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.kind})
                  </option>
                ))}
              </select>
            </div>

            {destructivePreview ? (
              <div className="preview-impact-card" data-testid="preview-impact-card">
                <div className="preview-card-header">
                  <AlertTriangle size={18} className="text-warning" />
                  <div>
                    <h3>Previewing Destructive Graph Edit</h3>
                    <p>
                      Removing <strong>{destructivePreview.affectedNode.name}</strong> ({destructivePreview.affectedNode.kind})
                    </p>
                  </div>
                </div>

                <div className="preview-impact-section">
                  <div className="impact-item">
                    <h4>
                      Affected Relationships ({destructivePreview.affectedEdges.length})
                    </h4>
                    {destructivePreview.affectedEdges.length === 0 ? (
                      <p className="impact-empty">No relationships connected to this item.</p>
                    ) : (
                      <ul className="impact-list" data-testid="arch-affected-relationships-list">
                        {destructivePreview.affectedEdges.map(e => {
                          const src = nodes.find(n => n.id === e.source);
                          const tgt = nodes.find(n => n.id === e.target);
                          return (
                            <li key={e.id}>
                              <strong>{src?.name || e.source}</strong> → <em>{e.kind}</em> → <strong>{tgt?.name || e.target}</strong>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div className="impact-item">
                    <h4>
                      Nested Child Elements ({destructivePreview.childNodes.length})
                    </h4>
                    {destructivePreview.childNodes.length === 0 ? (
                      <p className="impact-empty">No nested elements.</p>
                    ) : (
                      <ul className="impact-list" data-testid="arch-child-elements-list">
                        {destructivePreview.childNodes.map(c => (
                          <li key={c.id}>
                            {c.name} ({c.kind}) — will be re-parented to{' '}
                            {destructivePreview.affectedNode.parentId ? 'parent container' : 'root'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="impact-item">
                    <h4>
                      Referenced Requirements ({destructivePreview.referencingRequirements.length})
                    </h4>
                    {destructivePreview.referencingRequirements.length === 0 ? (
                      <p className="impact-empty">No requirements currently reference this item.</p>
                    ) : (
                      <ul className="impact-list preserved-list" data-testid="arch-preserved-requirements-list">
                        {destructivePreview.referencingRequirements.map(req => (
                          <li key={req.id}>
                            <Shield size={12} className="text-accent" />
                            <span>
                              <strong>{req.id}</strong>: &quot;{req.text}&quot; (Item reference will be removed; requirement definition preserved)
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="arch-preview-notice">
                  <Info size={14} />
                  <span>
                    Architecture edits affect the intended specification only. Implemented models and source code are never altered. Referenced requirements are preserved.
                  </span>
                </div>

                <div className="arch-actions space-between">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => setActiveTab('edit')}
                    data-testid="arch-cancel-delete-btn"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={handleConfirmDelete}
                    disabled={readOnly}
                    data-testid="arch-confirm-delete-btn"
                  >
                    <Trash2 size={14} />
                    <span>Confirm Removal</span>
                  </button>
                </div>
              </div>
            ) : (
              <p className="arch-empty-hint">Please select an item above to preview the impact of removal.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="arch-modal-backdrop" data-testid="arch-modal-backdrop" onClick={onClose}>
        <div className="arch-modal-dialog" onClick={(e) => e.stopPropagation()}>
          {content}
        </div>
      </div>
    );
  }

  return content;
};
