import React, { useMemo, useState, useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type Connection,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import type { Graph, Layout, ProgramNode, ProgramEdge, BindingReviewRecord } from '../../shared/model';
import { validRelationship, GraphSchema } from '../../shared/model';
import type { ViewState } from '../types';
import {
  ArrowLeft,
  Layers,
  Plus,
  Trash2,
  AlertCircle,
  X,
  Maximize2,
  HelpCircle,
  Database,
  Terminal,
} from 'lucide-react';
import * as api from '../api';
import { visibleDesignNodes, ownerId } from '../navigation-state';
import { PlantUmlCanvas } from './PlantUmlCanvas';
import { DiagramEdge, DiagramMarkers, relationshipMarkers } from './DiagramEdge';
import { useRef } from 'react';
import type { Viewport } from '@xyflow/react';

export interface GraphCanvasProps {
  graph: Graph | null;
  layout: Layout;
  scopedLayouts?: Record<string, Layout>;
  viewState: ViewState;
  onSelectNode: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  onScopeChange: (scopeId: string | null) => void;
  onLayoutChange?: (layout: Layout, scopeId?: string | null) => void | Promise<void>;
  onUpdateSpecification?: (graph: Graph) => void | Promise<void>;
  bindingReviews?: BindingReviewRecord[];
  projectId?: string;
  apiBaseUrl?: string;
  readOnly?: boolean;
  onSelectField?: (ownerId: string, fieldName: string) => void;
  onConnectNodes?: (sourceId: string, targetId: string) => void;
  onCanvasEdit?: (graph: Graph, selectedId: string) => void;
  creationDisabled?: boolean;
  onOpenArchitectureEditor?: () => void;
  onOpenErEditor?: () => void;
  onOpenFunctionEditor?: () => void;
  onOpenWorkflowEditor?: () => void;
}

export function getValidRelationshipKinds(
  sourceKind: ProgramNode['kind'],
  targetKind: ProgramNode['kind']
): ProgramEdge['kind'][] {
  const allKinds: ProgramEdge['kind'][] = [
    'depends-on',
    'calls',
    'contains',
    'inherits',
    'implements',
    'associates-with',
    'aggregates',
    'composes',
    'relates-to',
    'next',
    'true',
    'false',
    'exception',
    'reads',
    'writes',
  ];
  return allKinds.filter(k => validRelationship(k, sourceKind, targetKind));
}

export function methodSignature(node: ProgramNode): string {
  if (!node.signature) return node.contract ? `${node.name} ${node.contract}` : `${node.name}()`;
  return `${node.name}(${node.signature.parameters.map(p => `${p.name}${p.optional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ')})${node.signature.returnType ? ': ' + node.signature.returnType : ''}`;
}
const visibilitySymbol = (visibility?: ProgramNode['visibility']) => visibility === 'public' ? '+' : visibility === 'private' ? '−' : visibility === 'protected' ? '#' : visibility === 'package' ? '~' : '';
export const ArchitectureNode: React.FC<{
  data: { node: ProgramNode; members?: ProgramNode[]; isSelected?: boolean; selectedMemberId?: string | null; isAmbiguous?: boolean; isEntry?: boolean; onSelectMember?: (id: string) => void; onSelectField?: (ownerId: string, fieldName: string) => void; onScopeIn?: (id: string) => void; };
  selected?: boolean;
}> = ({ data, selected }) => {
  const { node, members = [], onScopeIn, isAmbiguous } = data;
  const isSelected = selected || data.isSelected || members.some(member => member.id === data.selectedMemberId);
  const uml = ['class', 'interface', 'enum', 'entity'].includes(node.kind);
  return <div className={`custom-flow-node ${uml ? 'uml-node' : ''} ${isSelected ? 'selected' : ''} kind-${node.kind} ${node.isAbstract ? 'is-abstract' : ''} ${isAmbiguous ? 'binding-ambiguous' : ''}`} data-testid={`canvas-flow-node-${node.id}`}>
    <Handle type="target" position={Position.Top} id="target-top"/>
    <Handle type="target" position={Position.Left} id="target-left"/>
    <div className="flow-node-header">
      {node.kind !== 'class' && <span className="flow-node-kind">{node.kind === 'interface' || node.kind === 'enum' ? `«${node.kind}»` : node.moduleRole || node.kind}</span>}
      <div className="flow-node-badges">
        {isAmbiguous && <span className="flow-node-badge badge-ambiguous" data-testid={`binding-ambiguous-${node.id}`}>Ambiguous binding</span>}
        {node.policy !== 'editable' && <span className={`flow-node-policy policy-${node.policy}`}>{node.policy}</span>}
        {node.stepType && <span className="flow-node-badge flow-node-step">{data.isEntry ? 'Entry · ' : ''}{node.stepType === 'return' || node.stepType === 'throw' ? 'Exit · ' : ''}{node.stepType}</span>}
        {node.provenance !== 'human' && <span className={`flow-node-badge prov-${node.provenance}`}>{node.provenance}</span>}
      </div>
    </div>
    <div className="flow-node-title">{node.name}{node.mappedName && <small> ↦ {node.mappedName}</small>}</div>
    {uml && <div className="uml-compartment uml-attributes">{node.fields.length ? node.fields.map(field => <button type="button" key={field.name} className={`uml-member nodrag nopan ${field.isStatic ? 'is-static' : ''}`} onClick={event => { event.stopPropagation(); data.onSelectField?.(node.id, field.name); }} aria-label={`Edit ${node.name}.${field.name}`}>
      <span>{visibilitySymbol(field.visibility)} {field.name}{field.type ? ': ' + field.type : ''}{field.optional ? ' ?' : ''}{field.key ? ' [' + field.key + ']' : ''}{field.defaultValue ? ' = ' + field.defaultValue : ''}</span>
    </button>) : <span className="uml-empty">{node.kind === 'entity' ? 'No fields yet' : 'No attributes'}</span>}
    {node.kind === 'entity' && [...(node.compositeKeys || []), ...(node.indexes || [])].map((key, index) => <div className="uml-key" key={index}>{key.type} ({key.fields.join(', ')}){key.name ? ' · ' + key.name : ''}</div>)}</div>}
    {['class','interface'].includes(node.kind) && <div className="uml-compartment uml-methods">{members.length ? members.map(member => <button key={member.id} type="button" className={`uml-member nodrag nopan ${data.selectedMemberId === member.id ? 'selected' : ''} ${member.isStatic ? 'is-static' : ''} ${member.isAbstract ? 'is-abstract' : ''}`} aria-label={`Open method ${node.name}.${methodSignature(member)}`} onClick={event => { event.stopPropagation(); data.onSelectMember?.(member.id); }}><span>{visibilitySymbol(member.visibility)} {methodSignature(member)}</span></button>) : <span className="uml-empty">No methods yet</span>}</div>}
    {!uml && node.description && <div className="flow-node-desc">{node.description}</div>}
    {['system','module','class','interface','function'].includes(node.kind) && onScopeIn && <div className="flow-node-footer"><button type="button" className="btn btn-xs btn-scope-in nodrag nopan" onClick={event => { event.stopPropagation(); onScopeIn(node.id); }} data-testid={`canvas-scope-in-${node.id}`}><Layers size={12}/><span>Open {node.kind}</span></button></div>}
    <Handle type="source" position={Position.Right} id="source-right"/>
    <Handle type="source" position={Position.Bottom} id="source-bottom"/>
  </div>;
};

const edgeTypes = { diagram: DiagramEdge };
const nodeTypes = {
  architectureNode: ArchitectureNode,
};

const FlowCanvasInternal: React.FC<GraphCanvasProps> = ({
  graph,
  layout,
  scopedLayouts,
  viewState,
  onSelectNode,
  onSelectEdge,
  onScopeChange,
  onLayoutChange,
  onUpdateSpecification,
  bindingReviews,
  projectId,
  apiBaseUrl,
  readOnly = false,
  onOpenArchitectureEditor,
  onOpenErEditor,
  onOpenFunctionEditor,
  onOpenWorkflowEditor,
  onSelectField,
}) => {
  const allNodes = useMemo(() => graph?.nodes || [], [graph]);
  const allEdges = useMemo(() => graph?.edges || [], [graph]);

  // Error and UI state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isEdgeEditorOpen, setIsEdgeEditorOpen] = useState<boolean>(false);
  const [newEdgeSource, setNewEdgeSource] = useState<string>('');
  const [newEdgeTarget, setNewEdgeTarget] = useState<string>('');
  const [newEdgeKind, setNewEdgeKind] = useState<ProgramEdge['kind'] | ''>('');
  const [newEdgeLabel, setNewEdgeLabel] = useState<string>('');
  const [sourceRole, setSourceRole] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [sourceMultiplicity, setSourceMultiplicity] = useState('');
  const [targetMultiplicity, setTargetMultiplicity] = useState('');
  const viewports = useRef<Record<string, Viewport>>({});
  const canvasKey = `${viewState.graphContext || 'intended'}:${viewState.designView || 'legacy'}:${viewState.activeScope || 'root'}:${viewState.flowchartId || ''}`;

  // Map containment hierarchy
  const nodeParentMap = useMemo(() => {
    const map = new Map<string, string | undefined>();
    const nodeIds = new Set(allNodes.map(n => n.id));
    allNodes.forEach(n => {
      if (n.parentId && nodeIds.has(n.parentId)) {
        map.set(n.id, n.parentId);
      } else {
        const containsEdge = allEdges.find(e => e.kind === 'contains' && e.target === n.id);
        if (containsEdge && nodeIds.has(containsEdge.source)) {
          map.set(n.id, containsEdge.source);
        } else {
          map.set(n.id, undefined);
        }
      }
    });
    return map;
  }, [allNodes, allEdges]);

  // Scoped nodes
  const scopedNodes = useMemo(() => {
    if (graph && viewState.designView) return visibleDesignNodes(graph, viewState.designView, viewState.activeScope, viewState.flowchartId);
    if (viewState.activeScope === null) {
      // Root scope: nodes with no parent
      const top = allNodes.filter(n => !nodeParentMap.get(n.id));
      return top.length > 0 ? top : allNodes;
    }
    // Child nodes of activeScope
    return allNodes.filter(n => nodeParentMap.get(n.id) === viewState.activeScope);
  }, [graph, allNodes, viewState.activeScope, viewState.designView, viewState.flowchartId, nodeParentMap]);

  const scopedNodeIds = useMemo(() => new Set(scopedNodes.map(n => n.id)), [scopedNodes]);

  const activeScopeNode = useMemo(() => {
    if (!viewState.activeScope) return null;
    return allNodes.find(n => n.id === viewState.activeScope) || null;
  }, [allNodes, viewState.activeScope]);

  // Convert to React Flow nodes with stable IDs and positions
  const flowNodes: FlowNode[] = useMemo(() => {
    return scopedNodes.map((node, index) => {
      const activeScopedLayout = (scopedLayouts && viewState.activeScope)
        ? scopedLayouts[viewState.activeScope]
        : undefined;
      const savedPos = activeScopedLayout?.[node.id] || layout[node.id];
      const col = index % 3;
      const row = Math.floor(index / 3);
      const rowHeight = (rowIndex: number) => Math.max(...scopedNodes.slice(rowIndex * 3, rowIndex * 3 + 3).map(n => 150 + 32 * (n.fields.length + allNodes.filter(m => m.kind === 'function' && nodeParentMap.get(m.id) === n.id).length)), 220);
      const position = savedPos ? { x: savedPos.x, y: savedPos.y } : { x: col * 360 + 40, y: Array.from({ length: row }, (_, i) => rowHeight(i) + 60).reduce((a,b) => a + b, 40) };
      const isSelected = viewState.selectedId === node.id && viewState.selectedType === 'node';
      const isAmbiguous = bindingReviews?.some(
        r => r.nodeId === node.id && (r.status === 'ambiguous' || r.status === 'unresolved')
      );

      return {
        id: node.id,
        type: 'architectureNode',
        position,
        draggable: !readOnly,
        data: {
          node,
          isSelected,
          isAmbiguous,
          members: allNodes.filter(member => member.kind === 'function' && nodeParentMap.get(member.id) === node.id),
          selectedMemberId: viewState.selectedId,
          isEntry: node.kind === 'step' && !allEdges.some(edge => ['next','true','false','exception'].includes(edge.kind) && edge.target === node.id),
          onSelectMember: onSelectNode,
          onSelectField,
          onScopeIn: (id: string) => onScopeChange(id),
          // Fallback label for default React Flow renderer if custom type not picked up in SSR
          label: (
            <div className={`custom-flow-node ${isSelected ? 'selected' : ''} kind-${node.kind} ${isAmbiguous ? 'binding-ambiguous' : ''}`}>
              <div className="flow-node-header">
                <span className="flow-node-kind">{node.kind}</span>
                {isAmbiguous && (
                  <span className="flow-node-badge badge-ambiguous" data-testid={`binding-ambiguous-${node.id}`}>Ambiguous</span>
                )}
                {node.policy && node.policy !== 'editable' && (
                  <span className={`flow-node-policy policy-${node.policy}`}>{node.policy}</span>
                )}
              </div>
              <div className="flow-node-title" title={node.name}>{node.name}</div>
              {node.description && (
                <div className="flow-node-desc" title={node.description}>{node.description}</div>
              )}
            </div>
          ),
        },
      };
    });
  }, [scopedNodes, layout, scopedLayouts, bindingReviews, viewState.selectedId, viewState.selectedType, viewState.activeScope, readOnly, onScopeChange, onSelectNode, onSelectField, allNodes, allEdges, nodeParentMap]);

  // Scoped edges with stable IDs and visual styles
  const flowEdges: FlowEdge[] = useMemo(() => {
    return allEdges
      .filter(edge => scopedNodeIds.has(edge.source) && scopedNodeIds.has(edge.target))
      .map(edge => {
        const isSelected = viewState.selectedId === edge.id && viewState.selectedType === 'edge';
        const strokeColor = isSelected ? '#ff3d00' : edge.uncertain ? '#facc15' : '#a3a3a3';
        const markers = relationshipMarkers(edge);
        return {
          id: edge.id, source: edge.source, target: edge.target, type: 'diagram',
          label: edge.label || (['next','true','false','exception','reads','writes'].includes(edge.kind) ? edge.kind : ''),
          selected: isSelected,
          markerStart: markers.start, markerEnd: markers.end,
          style: { stroke: strokeColor, strokeWidth: isSelected ? 2.5 : 1.5, strokeDasharray: markers.dashed ? '6 4' : undefined },
          data: { programEdge: edge },
        };
      });
  }, [allEdges, scopedNodeIds, viewState.selectedId, viewState.selectedType]);

  // Selected edge object (if any)
  const selectedEdge = useMemo(() => {
    if (viewState.selectedType === 'edge' && viewState.selectedId) {
      return allEdges.find(e => e.id === viewState.selectedId) || null;
    }
    return null;
  }, [allEdges, viewState.selectedId, viewState.selectedType]);

  // Handlers for selection
  const handleNodeClick: NodeMouseHandler = (_, node) => {
    onSelectNode(node.id);
  };

  const handleNodeDoubleClick: NodeMouseHandler = (_, node) => {
    const programNode = allNodes.find(n => n.id === node.id);
    if (programNode && ['system', 'module', 'class', 'function'].includes(programNode.kind)) {
      onScopeChange(node.id);
    }
  };

  const handleEdgeClick: EdgeMouseHandler = (_, edge) => {
    if (onSelectEdge) {
      onSelectEdge(edge.id);
    } else {
      onSelectNode(null);
    }
  };

  const handlePaneClick = () => {
    onSelectNode(null);
    if (onSelectEdge) {
      onSelectEdge(null);
    }
  };

  // Node movement handler: strictly layout only!
  const handleNodeDragStop: OnNodeDrag = async (_, node) => {
    if (readOnly) return;
    const newPos = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    };

    const updatedLayout: Layout = {
      ...layout,
      [node.id]: newPos,
    };

    if (onLayoutChange) {
      try {
        await onLayoutChange(updatedLayout, viewState.activeScope);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Failed to update layout');
      }
    } else if (projectId) {
      try {
        await api.updateLayout(projectId, updatedLayout, viewState.activeScope || undefined, apiBaseUrl);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Failed to update layout');
      }
    }
  };

  // Connection handler (dragging handle to handle)
  const handleConnect = async (connection: Connection) => {
    if (readOnly || !graph || !onUpdateSpecification) return;
    if (!connection.source || !connection.target) return;

    const sourceNode = allNodes.find(n => n.id === connection.source);
    const targetNode = allNodes.find(n => n.id === connection.target);

    if (!sourceNode || !targetNode) {
      setErrorMessage(`Missing edge endpoint: ${!sourceNode ? connection.source : connection.target}`);
      return;
    }

    const validKinds = getValidRelationshipKinds(sourceNode.kind, targetNode.kind);
    if (validKinds.length === 0) {
      setErrorMessage(`Cannot create relationship between ${sourceNode.kind} and ${targetNode.kind}: no valid relationship types.`);
      return;
    }

    setNewEdgeSource(connection.source);
    setNewEdgeTarget(connection.target);
    setNewEdgeKind('');
    setIsEdgeEditorOpen(true);
    setErrorMessage(null);
  };

  // Add relationship from inline toolbar form
  const handleCreateRelationshipSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!graph || !onUpdateSpecification) return;
    if (!newEdgeSource || !newEdgeTarget) {
      setErrorMessage('Please select both source and target nodes.');
      return;
    }

    const sourceNode = allNodes.find(n => n.id === newEdgeSource);
    const targetNode = allNodes.find(n => n.id === newEdgeTarget);

    if (!sourceNode || !targetNode) {
      setErrorMessage(`Missing edge endpoint: ${!sourceNode ? newEdgeSource : newEdgeTarget}`);
      return;
    }

    if (!newEdgeKind || !validRelationship(newEdgeKind, sourceNode.kind, targetNode.kind)) {
      setErrorMessage(`Invalid relationship ${newEdgeKind}: ${sourceNode.kind} → ${targetNode.kind}`);
      return;
    }

    const newEdgeId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const newEdge: ProgramEdge = {
      id: newEdgeId,
      source: newEdgeSource,
      target: newEdgeTarget,
      kind: newEdgeKind as ProgramEdge['kind'],
      ...(['associates-with','aggregates','composes','relates-to'].includes(newEdgeKind) ? { sourceEndpoint: { role: sourceRole || undefined, multiplicity: sourceMultiplicity || undefined }, targetEndpoint: { role: targetRole || undefined, multiplicity: targetMultiplicity || undefined } } : {}),
      label: newEdgeLabel.trim(),
      provenance: 'human',
      uncertain: false,
    };

    const nextGraph: Graph = {
      ...graph,
      edges: [...graph.edges, newEdge],
    };

    const validation = GraphSchema.safeParse(nextGraph);
    if (!validation.success) {
      setErrorMessage(validation.error.issues[0]?.message || 'Graph validation failed');
      return;
    }

    try {
      setErrorMessage(null);
      await onUpdateSpecification(nextGraph);
      setIsEdgeEditorOpen(false);
      setNewEdgeLabel('');
      if (onSelectEdge) {
        onSelectEdge(newEdgeId);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Server rejected relationship update');
    }
  };

  // Delete edge handler
  const handleDeleteEdge = async (edgeId: string) => {
    if (!graph || !onUpdateSpecification) return;
    const nextEdges = graph.edges.filter(e => e.id !== edgeId);
    const nextGraph: Graph = {
      ...graph,
      edges: nextEdges,
      requirements: graph.requirements.map(req => ({
        ...req,
        edgeIds: req.edgeIds.filter(id => id !== edgeId),
      })),
    };

    const validation = GraphSchema.safeParse(nextGraph);
    if (!validation.success) {
      setErrorMessage(validation.error.issues[0]?.message || 'Graph validation failed');
      return;
    }

    try {
      setErrorMessage(null);
      await onUpdateSpecification(nextGraph);
      if (onSelectEdge) {
        onSelectEdge(null);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to delete relationship');
    }
  };

  // Valid kinds between currently selected source and target in the inline form
  const availableKindsForForm = useMemo(() => {
    if (!newEdgeSource || !newEdgeTarget) return [];
    const src = allNodes.find(n => n.id === newEdgeSource);
    const tgt = allNodes.find(n => n.id === newEdgeTarget);
    if (!src || !tgt) return [];
    return getValidRelationshipKinds(src.kind, tgt.kind);
  }, [newEdgeSource, newEdgeTarget, allNodes]);

  return (
    <section
      className="panel scoped-canvas-panel"
      data-testid="scoped-canvas-panel"
      aria-label="Scoped Canvas"
    >
      <div className="panel-header canvas-header">
        <div className="scope-indicator">
          {viewState.activeScope && (
            <button
              className="btn btn-xs btn-secondary btn-back-scope"
              onClick={() => onScopeChange(null)}
              title="Return to Root Scope"
              data-testid="canvas-back-scope"
            >
              <ArrowLeft size={14} />
              <span>Root</span>
            </button>
          )}
          <span className="scope-label" data-testid="scope-label">
            Scope:{' '}
            {activeScopeNode ? (
              <strong>{`${activeScopeNode.name} (${activeScopeNode.kind})`}</strong>
            ) : (
              <strong>Root (Global Architecture)</strong>
            )}
          </span>
          <span className="scope-count">({scopedNodes.length} nodes)</span>
        </div>

        <div className="canvas-scoped-pills" data-testid="canvas-scoped-pills">
          {scopedNodes.map(n => {
            const isAmbiguous = bindingReviews?.some(
              r => r.nodeId === n.id && (r.status === 'ambiguous' || r.status === 'unresolved')
            );
            return (
              <button
                key={n.id}
                className={`canvas-scoped-pill kind-${n.kind} ${viewState.selectedId === n.id && viewState.selectedType === 'node' ? 'selected' : ''} ${isAmbiguous ? 'pill-ambiguous' : ''}`}
                onClick={() => onSelectNode(n.id)}
                data-testid={`canvas-node-${n.id}`}
                title={`Inspect ${n.name} (${n.kind})${isAmbiguous ? ' [Ambiguous Binding]' : ''}`}
              >
                <span>{n.name}</span>
                {isAmbiguous && <span className="pill-ambiguous-tag" data-testid={`pill-ambiguous-${n.id}`}>?</span>}
              </button>
            );
          })}
        </div>

        <div className="canvas-header-actions" data-testid="canvas-header-actions">
          {selectedEdge && (
            <div className="canvas-selected-edge-bar" data-testid="selected-edge-info">
              <span className="edge-info-badge">
                {`Edge: ${selectedEdge.source} → ${selectedEdge.target} (${selectedEdge.kind})`}
              </span>
              {!readOnly && onUpdateSpecification && (
                <button
                  className="btn btn-xs btn-outline-danger"
                  onClick={() => handleDeleteEdge(selectedEdge.id)}
                  title="Delete selected relationship"
                  data-testid="canvas-delete-edge-btn"
                >
                  <Trash2 size={12} />
                  <span>Delete Edge</span>
                </button>
              )}
            </div>
          )}

          {!readOnly && onOpenArchitectureEditor && (
            <button
              className="btn btn-xs btn-outline"
              onClick={onOpenArchitectureEditor}
              title="Add architecture element"
              data-testid="canvas-add-node-btn"
            >
              <Plus size={12} />
              <span>Add Item</span>
            </button>
          )}

          {!readOnly && onOpenErEditor && (
            <button
              className="btn btn-xs btn-outline"
              onClick={onOpenErEditor}
              title="Open ER Schema Editor"
              data-testid="canvas-open-er-btn"
            >
              <Database size={12} />
              <span>ER Schema</span>
            </button>
          )}

          {!readOnly && onOpenFunctionEditor && (
            <button
              className="btn btn-xs btn-outline"
              onClick={onOpenFunctionEditor}
              title="Open Function Specifications & Contracts Editor"
              data-testid="canvas-open-function-btn"
            >
              <Terminal size={12} />
              <span>Functions</span>
            </button>
          )}

          {!readOnly && onUpdateSpecification && scopedNodes.length >= 2 && (
            <button
              className={`btn btn-xs ${isEdgeEditorOpen ? 'btn-secondary' : 'btn-outline'}`}
              onClick={() => {
                setIsEdgeEditorOpen(!isEdgeEditorOpen);
                if (!newEdgeSource && scopedNodes.length >= 2) {
                  setNewEdgeSource(scopedNodes[0].id);
                  setNewEdgeTarget(scopedNodes[1].id);
                }
              }}
              title="Add a relationship edge between scoped nodes"
              data-testid="canvas-add-edge-btn"
            >
              <Plus size={12} />
              <span>{isEdgeEditorOpen ? 'Cancel' : 'Add Edge'}</span>
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div className="canvas-error-banner" data-testid="canvas-error-banner">
          <AlertCircle size={14} className="error-icon" />
          <span className="error-text">{errorMessage}</span>
          <button
            className="btn btn-xs btn-icon btn-dismiss-error"
            onClick={() => setErrorMessage(null)}
            title="Dismiss error"
            data-testid="dismiss-canvas-error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {isEdgeEditorOpen && (
        <form
          className="canvas-edge-editor"
          onSubmit={handleCreateRelationshipSubmit}
          data-testid="canvas-edge-editor"
        >
          <div className="editor-form-row">
            <div className="form-group">
              <label htmlFor="edge-source-select">Source Node</label>
              <select
                id="edge-source-select"
                className="input input-sm"
                value={newEdgeSource}
                onChange={(e) => setNewEdgeSource(e.target.value)}
                data-testid="edge-source-select"
              >
                <option value="">Select source…</option>
                {scopedNodes.map(n => (
                  <option key={n.id} value={n.id}>{n.name} ({n.kind})</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="edge-target-select">Target Node</label>
              <select
                id="edge-target-select"
                className="input input-sm"
                value={newEdgeTarget}
                onChange={(e) => setNewEdgeTarget(e.target.value)}
                data-testid="edge-target-select"
              >
                <option value="">Select target…</option>
                {scopedNodes.map(n => (
                  <option key={n.id} value={n.id}>{n.name} ({n.kind})</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="edge-kind-select">Relationship Kind</label>
              <select
                id="edge-kind-select"
                className="input input-sm"
                value={newEdgeKind}
                onChange={(e) => setNewEdgeKind(e.target.value as ProgramEdge['kind'])}
                data-testid="edge-kind-select"
                disabled={availableKindsForForm.length === 0}
              >
                <option value="">Choose relationship…</option>
                {availableKindsForForm.length === 0 ? (
                  <option value="">No valid relationship</option>
                ) : (
                  availableKindsForForm.map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))
                )}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="edge-label-input">Label (optional)</label>
              <input
                id="edge-label-input"
                type="text"
                className="input input-sm"
                placeholder="e.g. calls service"
                value={newEdgeLabel}
                onChange={(e) => setNewEdgeLabel(e.target.value)}
                data-testid="edge-label-input"
              />
            </div>

            {['associates-with','aggregates','composes','relates-to'].includes(newEdgeKind) && <div className="edge-endpoint-fields">{[['Source role',sourceRole,setSourceRole],['Source multiplicity',sourceMultiplicity,setSourceMultiplicity],['Target role',targetRole,setTargetRole],['Target multiplicity',targetMultiplicity,setTargetMultiplicity]].map(([label,value,set]) => <label key={String(label)}>{String(label)}<input value={String(value)} onChange={event => (set as (value:string)=>void)(event.target.value)}/></label>)}</div>}
            <div className="editor-form-actions">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={!newEdgeKind || availableKindsForForm.length === 0}
                data-testid="edge-connect-submit"
              >
                Connect
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setIsEdgeEditorOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      <DiagramMarkers/>
      <div className="canvas-wrapper" data-testid="canvas-wrapper">
        {scopedNodes.length === 0 ? (
          <div className="canvas-empty-state" data-testid="canvas-empty-state">
            <Layers size={32} className="empty-icon" />
            <h2>{viewState.designView === 'database' ? 'Plan your data.' : viewState.designView === 'overview' ? 'Start with the system.' : 'Start with a class.'}</h2>
            <p>No elements in this view yet.</p>
            {onOpenArchitectureEditor && <button className="btn btn-primary" onClick={onOpenArchitectureEditor}>{viewState.designView === 'database' ? 'Add your first table' : viewState.designView === 'overview' ? 'Add a system or module' : 'Add your first class'}</button>}
            {viewState.activeScope ? (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => onScopeChange(null)}
                data-testid="canvas-empty-return-root"
              >
                Return to Root Scope
              </button>
            ) : (
              <span className="empty-hint">Create architecture nodes or import existing code to view the diagram.</span>
            )}
          </div>
        ) : (
          <ReactFlow
            key={canvasKey}
            defaultViewport={viewports.current[canvasKey]}
            onMoveEnd={(_, viewport) => { viewports.current[canvasKey] = viewport; }}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            panActivationKeyCode="Space"
            deleteKeyCode={null}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            fitView={!viewports.current[canvasKey]}
            attributionPosition="bottom-right"
          >
            <Background gap={24} size={1} color="#262626" />
            <Controls />
            <MiniMap nodeColor="#a3a3a3" style={{ background: '#171717' }}/>
          </ReactFlow>
        )}
      </div>
    </section>
  );
};

export const GraphCanvas: React.FC<GraphCanvasProps> = (props) => {
  if (props.viewState.designView) return <PlantUmlCanvas {...props}/>;
  return (
    <ReactFlowProvider>
      <FlowCanvasInternal {...props} />
    </ReactFlowProvider>
  );
};
