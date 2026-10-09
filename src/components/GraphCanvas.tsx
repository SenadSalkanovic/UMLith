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
import type { Graph, Layout, ProgramNode, ProgramEdge } from '../../shared/model';
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
} from 'lucide-react';
import * as api from '../api';

export interface GraphCanvasProps {
  graph: Graph | null;
  layout: Layout;
  viewState: ViewState;
  onSelectNode: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  onScopeChange: (scopeId: string | null) => void;
  onLayoutChange?: (layout: Layout, scopeId?: string | null) => void | Promise<void>;
  onUpdateSpecification?: (graph: Graph) => void | Promise<void>;
  projectId?: string;
  apiBaseUrl?: string;
  readOnly?: boolean;
  onOpenArchitectureEditor?: () => void;
  onOpenErEditor?: () => void;
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

// Custom Architecture Node Component for React Flow
export const ArchitectureNode: React.FC<{
  data: {
    node: ProgramNode;
    isSelected: boolean;
    onScopeIn?: (id: string) => void;
  };
  selected?: boolean;
}> = ({ data, selected }) => {
  const { node, onScopeIn } = data;
  const isSelected = selected || data.isSelected;
  const isContainer = ['system', 'module', 'class', 'function'].includes(node.kind);

  return (
    <div
      className={`custom-flow-node ${isSelected ? 'selected' : ''} kind-${node.kind}`}
      data-testid={`canvas-flow-node-${node.id}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="target-top"
        style={{ background: '#64748b', width: 8, height: 8 }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="target-left"
        style={{ background: '#64748b', width: 8, height: 8 }}
      />

      <div className="flow-node-header">
        <span className="flow-node-kind">{node.kind}</span>
        <div className="flow-node-badges">
          {node.policy && node.policy !== 'editable' && (
            <span className={`flow-node-policy policy-${node.policy}`}>{node.policy}</span>
          )}
          {node.stepType && (
            <span className="flow-node-badge flow-node-step">{node.stepType}</span>
          )}
          {node.provenance && node.provenance !== 'human' && (
            <span className={`flow-node-badge prov-${node.provenance}`}>{node.provenance}</span>
          )}
        </div>
      </div>

      <div className="flow-node-title" title={node.name}>
        {node.name}
      </div>

      {node.description && (
        <div className="flow-node-desc" title={node.description}>
          {node.description}
        </div>
      )}

      {node.fields && node.fields.length > 0 && (
        <div className="flow-node-meta">
          {node.fields.length} {node.fields.length === 1 ? 'field' : 'fields'}
        </div>
      )}

      {isContainer && onScopeIn && (
        <div className="flow-node-footer">
          <button
            type="button"
            className="btn btn-xs btn-scope-in"
            onClick={(e) => {
              e.stopPropagation();
              onScopeIn(node.id);
            }}
            title={`Scope into ${node.name}`}
            data-testid={`canvas-scope-in-${node.id}`}
          >
            <Layers size={10} />
            <span>Scope in</span>
          </button>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        style={{ background: '#38bdf8', width: 8, height: 8 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-bottom"
        style={{ background: '#38bdf8', width: 8, height: 8 }}
      />
    </div>
  );
};

const nodeTypes = {
  architectureNode: ArchitectureNode,
};

const FlowCanvasInternal: React.FC<GraphCanvasProps> = ({
  graph,
  layout,
  viewState,
  onSelectNode,
  onSelectEdge,
  onScopeChange,
  onLayoutChange,
  onUpdateSpecification,
  projectId,
  apiBaseUrl,
  readOnly = false,
  onOpenArchitectureEditor,
  onOpenErEditor,
}) => {
  const allNodes = useMemo(() => graph?.nodes || [], [graph]);
  const allEdges = useMemo(() => graph?.edges || [], [graph]);

  // Error and UI state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isEdgeEditorOpen, setIsEdgeEditorOpen] = useState<boolean>(false);
  const [newEdgeSource, setNewEdgeSource] = useState<string>('');
  const [newEdgeTarget, setNewEdgeTarget] = useState<string>('');
  const [newEdgeKind, setNewEdgeKind] = useState<ProgramEdge['kind']>('depends-on');
  const [newEdgeLabel, setNewEdgeLabel] = useState<string>('');

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
    if (viewState.activeScope === null) {
      // Root scope: nodes with no parent
      const top = allNodes.filter(n => !nodeParentMap.get(n.id));
      return top.length > 0 ? top : allNodes;
    }
    // Child nodes of activeScope
    return allNodes.filter(n => nodeParentMap.get(n.id) === viewState.activeScope);
  }, [allNodes, viewState.activeScope, nodeParentMap]);

  const scopedNodeIds = useMemo(() => new Set(scopedNodes.map(n => n.id)), [scopedNodes]);

  const activeScopeNode = useMemo(() => {
    if (!viewState.activeScope) return null;
    return allNodes.find(n => n.id === viewState.activeScope) || null;
  }, [allNodes, viewState.activeScope]);

  // Convert to React Flow nodes with stable IDs and positions
  const flowNodes: FlowNode[] = useMemo(() => {
    return scopedNodes.map((node, index) => {
      const savedPos = layout[node.id];
      const col = index % 3;
      const row = Math.floor(index / 3);
      const position = savedPos ? { x: savedPos.x, y: savedPos.y } : { x: col * 240 + 40, y: row * 160 + 40 };
      const isSelected = viewState.selectedId === node.id && viewState.selectedType === 'node';

      return {
        id: node.id,
        type: 'architectureNode',
        position,
        draggable: !readOnly,
        data: {
          node,
          isSelected,
          onScopeIn: (id: string) => onScopeChange(id),
          // Fallback label for default React Flow renderer if custom type not picked up in SSR
          label: (
            <div className={`custom-flow-node ${isSelected ? 'selected' : ''} kind-${node.kind}`}>
              <div className="flow-node-header">
                <span className="flow-node-kind">{node.kind}</span>
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
  }, [scopedNodes, layout, viewState.selectedId, viewState.selectedType, readOnly, onScopeChange]);

  // Scoped edges with stable IDs and visual styles
  const flowEdges: FlowEdge[] = useMemo(() => {
    return allEdges
      .filter(edge => scopedNodeIds.has(edge.source) && scopedNodeIds.has(edge.target))
      .map(edge => {
        const isSelected = viewState.selectedId === edge.id && viewState.selectedType === 'edge';
        const strokeColor = edge.uncertain
          ? '#fbbf24'
          : edge.kind === 'contains'
          ? '#818cf8'
          : edge.kind === 'relates-to'
          ? '#34d399'
          : edge.kind === 'calls'
          ? '#38bdf8'
          : '#64748b';

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label || edge.kind,
          animated: edge.kind === 'calls' || edge.kind === 'depends-on',
          selected: isSelected,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: strokeColor,
          },
          style: {
            stroke: strokeColor,
            strokeWidth: isSelected ? 2.5 : 1.5,
            strokeDasharray: edge.uncertain ? '5,5' : undefined,
          },
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

    // Default suitable kind
    let defaultKind: ProgramEdge['kind'] = validKinds[0];
    if (sourceNode.kind === 'entity' && targetNode.kind === 'entity' && validKinds.includes('relates-to')) {
      defaultKind = 'relates-to';
    } else if (sourceNode.kind === 'function' && targetNode.kind === 'function' && validKinds.includes('calls')) {
      defaultKind = 'calls';
    } else if (validKinds.includes('contains')) {
      defaultKind = 'contains';
    } else if (validKinds.includes('depends-on')) {
      defaultKind = 'depends-on';
    }

    const newEdgeId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const newEdge: ProgramEdge = {
      id: newEdgeId,
      source: connection.source,
      target: connection.target,
      kind: defaultKind,
      label: '',
      provenance: 'human',
      uncertain: false,
    };

    const nextGraph: Graph = {
      ...graph,
      edges: [...graph.edges, newEdge],
    };

    // Client-side validation check
    const validation = GraphSchema.safeParse(nextGraph);
    if (!validation.success) {
      setErrorMessage(validation.error.issues[0]?.message || 'Invalid relationship');
      return;
    }

    try {
      setErrorMessage(null);
      await onUpdateSpecification(nextGraph);
      if (onSelectEdge) {
        onSelectEdge(newEdgeId);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Server rejected relationship creation');
    }
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

    if (!validRelationship(newEdgeKind, sourceNode.kind, targetNode.kind)) {
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
      kind: newEdgeKind,
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
          {scopedNodes.map(n => (
            <button
              key={n.id}
              className={`canvas-scoped-pill kind-${n.kind} ${viewState.selectedId === n.id && viewState.selectedType === 'node' ? 'selected' : ''}`}
              onClick={() => onSelectNode(n.id)}
              data-testid={`canvas-node-${n.id}`}
              title={`Inspect ${n.name} (${n.kind})`}
            >
              <span>{n.name}</span>
            </button>
          ))}
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

            <div className="editor-form-actions">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={availableKindsForForm.length === 0}
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

      <div className="canvas-wrapper" data-testid="canvas-wrapper">
        {scopedNodes.length === 0 ? (
          <div className="canvas-empty-state" data-testid="canvas-empty-state">
            <Layers size={32} className="empty-icon" />
            <p>No elements in current scope.</p>
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
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            fitView
            attributionPosition="bottom-right"
          >
            <Background gap={16} size={1} color="#334155" />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                const pn = allNodes.find(n => n.id === node.id);
                switch (pn?.kind) {
                  case 'system': return '#38bdf8';
                  case 'module': return '#818cf8';
                  case 'entity': return '#34d399';
                  case 'function': return '#4ade80';
                  case 'class': return '#60a5fa';
                  case 'interface': return '#a78bfa';
                  case 'enum': return '#f472b6';
                  case 'step': return '#fb923c';
                  default: return '#64748b';
                }
              }}
              style={{ background: '#0f172a' }}
            />
          </ReactFlow>
        )}
      </div>
    </section>
  );
};

export const GraphCanvas: React.FC<GraphCanvasProps> = (props) => {
  return (
    <ReactFlowProvider>
      <FlowCanvasInternal {...props} />
    </ReactFlowProvider>
  );
};
