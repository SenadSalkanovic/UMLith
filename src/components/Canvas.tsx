import React, { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeMouseHandler,
} from '@xyflow/react';
import type { Graph, Layout, ProgramNode } from '../../shared/model';
import type { ViewState } from '../types';
import { ArrowLeft, ZoomIn, ZoomOut, Maximize2, Layers } from 'lucide-react';

interface CanvasProps {
  graph: Graph | null;
  layout: Layout;
  viewState: ViewState;
  onSelectNode: (id: string | null) => void;
  onScopeChange: (scopeId: string | null) => void;
}

const FlowCanvasInternal: React.FC<CanvasProps> = ({
  graph,
  layout,
  viewState,
  onSelectNode,
  onScopeChange,
}) => {
  const allNodes = useMemo(() => graph?.nodes || [], [graph]);
  const allEdges = useMemo(() => graph?.edges || [], [graph]);

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

  // Determine current scoped nodes
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

  // Convert to React Flow nodes with positions
  const flowNodes: FlowNode[] = useMemo(() => {
    return scopedNodes.map((node, index) => {
      const savedPos = layout[node.id];
      // Default auto-grid if no position saved in layout
      const col = index % 3;
      const row = Math.floor(index / 3);
      const position = savedPos ? { x: savedPos.x, y: savedPos.y } : { x: col * 220 + 40, y: row * 140 + 40 };

      const isSelected = viewState.selectedId === node.id;

      return {
        id: node.id,
        position,
        data: {
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
  }, [scopedNodes, layout, viewState.selectedId]);

  // Filter edges where both source and target are in current scope
  const flowEdges: FlowEdge[] = useMemo(() => {
    return allEdges
      .filter(edge => scopedNodeIds.has(edge.source) && scopedNodeIds.has(edge.target))
      .map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label || edge.kind,
        animated: edge.kind === 'calls' || edge.kind === 'depends-on',
        style: { stroke: edge.uncertain ? '#fbbf24' : '#64748b' },
      }));
  }, [allEdges, scopedNodeIds]);

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    onSelectNode(node.id);
  };

  const handleNodeDoubleClick: NodeMouseHandler = (_, node) => {
    // If container node, double click scopes into it
    const programNode = allNodes.find(n => n.id === node.id);
    if (programNode && ['system', 'module', 'class', 'function'].includes(programNode.kind)) {
      onScopeChange(node.id);
    }
  };

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
              <strong>{activeScopeNode.name} ({activeScopeNode.kind})</strong>
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
              className={`canvas-scoped-pill kind-${n.kind} ${viewState.selectedId === n.id ? 'selected' : ''}`}
              onClick={() => onSelectNode(n.id)}
              data-testid={`canvas-node-${n.id}`}
              title={`Inspect ${n.name} (${n.kind})`}
            >
              <span>{n.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="canvas-wrapper" data-testid="canvas-wrapper">
        {scopedNodes.length === 0 ? (
          <div className="canvas-empty-state" data-testid="canvas-empty-state">
            <Layers size={32} className="empty-icon" />
            <p>No elements in current scope.</p>
            {viewState.activeScope ? (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => onScopeChange(null)}
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
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
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

export const Canvas: React.FC<CanvasProps> = (props) => {
  return (
    <ReactFlowProvider>
      <FlowCanvasInternal {...props} />
    </ReactFlowProvider>
  );
};
