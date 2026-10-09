import React, { useState, useMemo, useCallback } from 'react';
import type { ProgramNode, ProgramEdge, Graph, Project, Analysis } from '../../shared/model';
import type { ViewState } from '../types';
import {
  Folder,
  Box,
  Layers,
  Code2,
  FileCode,
  Terminal,
  Database,
  List,
  ChevronRight,
  ChevronDown,
  Shield,
  Search,
  Focus,
  Trash2,
  Tag,
} from 'lucide-react';

export interface ProjectTreeProps {
  graph: Graph | null;
  viewState: ViewState;
  onSelectNode: (id: string | null) => void;
  onScopeChange: (scopeId: string | null) => void;
  onSearchChange: (query: string) => void;
  project?: Project | null;
  analysis?: Analysis | null;
  onGraphContextChange?: (context: 'intended' | 'implemented') => void;
  onDeleteNode?: (id: string) => void;
}

export const ProjectTree: React.FC<ProjectTreeProps> = ({
  graph,
  viewState,
  onSelectNode,
  onScopeChange,
  onSearchChange,
  project,
  analysis,
  onGraphContextChange,
  onDeleteNode,
}) => {
  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const edges = useMemo(() => graph?.edges || [], [graph]);

  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const currentContext: 'intended' | 'implemented' = viewState.graphContext || 'intended';

  const nodesMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  // Determine a node's parent via node.parentId or an incoming 'contains' edge
  const getNodeParentId = useCallback((node: ProgramNode): string | undefined => {
    if (node.parentId && nodesMap.has(node.parentId)) {
      return node.parentId;
    }
    const containsEdge = edges.find(e => e.kind === 'contains' && e.target === node.id);
    if (containsEdge && nodesMap.has(containsEdge.source)) {
      return containsEdge.source;
    }
    return undefined;
  }, [nodesMap, edges]);

  const getNodeIcon = (kind: ProgramNode['kind']) => {
    switch (kind) {
      case 'system': return <Layers size={14} className="kind-icon icon-system" />;
      case 'module': return <Box size={14} className="kind-icon icon-module" />;
      case 'class': return <Code2 size={14} className="kind-icon icon-class" />;
      case 'interface': return <FileCode size={14} className="kind-icon icon-interface" />;
      case 'function': return <Terminal size={14} className="kind-icon icon-function" />;
      case 'entity': return <Database size={14} className="kind-icon icon-entity" />;
      case 'enum': return <List size={14} className="kind-icon icon-enum" />;
      case 'step': return <ChevronRight size={14} className="kind-icon icon-step" />;
      default: return <Folder size={14} className="kind-icon" />;
    }
  };

  const matchingNodeIds = useMemo(() => {
    if (!viewState.searchQuery) {
      return new Set(nodes.map(n => n.id));
    }
    const q = viewState.searchQuery.toLowerCase();
    const matches = new Set<string>();

    nodes.forEach(n => {
      if (
        n.name.toLowerCase().includes(q) ||
        n.kind.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q)
      ) {
        matches.add(n.id);
        // Include ancestors so hierarchy displays the match
        let currId = getNodeParentId(n);
        while (currId) {
          matches.add(currId);
          const parentNode = nodesMap.get(currId);
          currId = parentNode ? getNodeParentId(parentNode) : undefined;
        }
      }
    });

    return matches;
  }, [nodes, viewState.searchQuery, getNodeParentId, nodesMap]);

  const filteredNodes = useMemo(() => {
    return nodes.filter(n => matchingNodeIds.has(n.id));
  }, [nodes, matchingNodeIds]);

  // Group nodes: top-level vs nested
  const { topLevelNodes, childNodesMap } = useMemo(() => {
    const top: ProgramNode[] = [];
    const childrenMap = new Map<string, ProgramNode[]>();

    filteredNodes.forEach(node => {
      const parentId = getNodeParentId(node);
      if (parentId) {
        const list = childrenMap.get(parentId) || [];
        list.push(node);
        childrenMap.set(parentId, list);
      } else {
        top.push(node);
      }
    });

    return { topLevelNodes: top, childNodesMap: childrenMap };
  }, [filteredNodes, getNodeParentId]);

  const toggleCollapse = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNodeClick = (node: ProgramNode) => {
    onSelectNode(node.id);
    const parentId = getNodeParentId(node);
    // Tree selection opens the correct graph scope containing the node
    onScopeChange(parentId ?? null);
  };

  const activeScopeNode = useMemo(() => {
    if (!viewState.activeScope) return null;
    return nodesMap.get(viewState.activeScope) || null;
  }, [viewState.activeScope, nodesMap]);

  // Calculate scope breadcrumb trail from root down to active scope
  const scopeBreadcrumbs = useMemo(() => {
    if (!viewState.activeScope) return [];
    const crumbs: ProgramNode[] = [];
    let curr: ProgramNode | undefined = nodesMap.get(viewState.activeScope);
    while (curr) {
      crumbs.unshift(curr);
      const parentId = getNodeParentId(curr);
      curr = parentId ? nodesMap.get(parentId) : undefined;
    }
    return crumbs;
  }, [viewState.activeScope, nodesMap, getNodeParentId]);

  const activeScopeChildren = useMemo(() => {
    if (!viewState.activeScope) return [];
    return childNodesMap.get(viewState.activeScope) || [];
  }, [viewState.activeScope, childNodesMap]);

  const renderNodeItem = (node: ProgramNode, depth = 0) => {
    const isSelected = viewState.selectedId === node.id;
    const isScoped = viewState.activeScope === node.id;
    const children = childNodesMap.get(node.id) || [];
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedNodes.has(node.id) && !viewState.searchQuery;
    const isContainer = ['system', 'module', 'class', 'interface', 'function'].includes(node.kind);

    return (
      <div key={node.id} className="tree-node-group">
        <div
          className={`tree-node-row ${isSelected ? 'selected' : ''} ${isScoped ? 'scoped' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          onClick={() => handleNodeClick(node)}
          data-testid={`tree-node-${node.id}`}
        >
          {hasChildren ? (
            <button
              className="tree-expand-btn"
              onClick={(e) => toggleCollapse(node.id, e)}
              data-testid={`expand-btn-${node.id}`}
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : (
            <span className="tree-expand-spacer" />
          )}

          <span className="tree-node-icon">{getNodeIcon(node.kind)}</span>
          <span className="tree-node-name" title={node.name}>{node.name}</span>
          <span className="tree-node-kind">{node.kind}</span>

          <span
            className={`tree-prov-badge prov-${node.provenance || 'human'}`}
            title={`Provenance: ${node.provenance || 'human'}`}
            data-testid={`node-provenance-${node.id}`}
          >
            {node.provenance || 'human'}
          </span>

          {node.policy && node.policy !== 'editable' && (
            <span
              className={`tree-policy-badge policy-${node.policy}`}
              title={`Policy: ${node.policy}`}
              data-testid={`node-policy-${node.id}`}
            >
              <Shield size={10} />
            </span>
          )}

          <div className="tree-node-actions">
            {isContainer && (
              <button
                className="btn-scope-in"
                title="Focus/Scope into this container"
                onClick={(e) => {
                  e.stopPropagation();
                  onScopeChange(node.id);
                }}
                data-testid={`scope-in-${node.id}`}
              >
                <Focus size={12} />
              </button>
            )}

            {onDeleteNode && (
              <button
                className="btn-delete-node"
                title={`Delete ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteNode(node.id);
                }}
                data-testid={`delete-node-${node.id}`}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>

        {hasChildren && !isCollapsed && (
          <div className="tree-node-children">
            {children.map(child => renderNodeItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="panel project-tree-panel"
      data-testid="project-tree-panel"
      aria-label="Project Tree"
    >
      <div className="panel-header">
        <div className="panel-title">
          <Folder size={16} />
          <span>Project Tree</span>
          <span className="node-count-badge">({nodes.length})</span>
        </div>
        {viewState.activeScope && (
          <button
            className="btn btn-xs btn-outline"
            onClick={() => onScopeChange(null)}
            title="Clear scope and return to root"
            data-testid="clear-scope-btn"
          >
            Reset Scope
          </button>
        )}
      </div>

      {/* Model Context Header - Always visible */}
      <div className="model-context-bar" data-testid="model-context-bar">
        <div className="model-context-info">
          <span className={`context-status-dot dot-${currentContext}`} />
          <span className="model-context-indicator" data-testid="model-context-indicator">
            {`Context: ${currentContext === 'implemented' ? 'Implemented Architecture' : 'Intended Specification'}`}
          </span>
        </div>
        <div className="graph-context-actions" data-testid="graph-context-actions">
          <button
            type="button"
            className={`context-tab-btn ${currentContext === 'intended' ? 'active' : ''}`}
            data-testid="context-tab-intended"
            onClick={() => onGraphContextChange?.('intended')}
            title="View intended specification"
          >
            Intended
          </button>
          <button
            type="button"
            className={`context-tab-btn ${currentContext === 'implemented' ? 'active' : ''}`}
            data-testid="context-tab-implemented"
            onClick={() => onGraphContextChange?.('implemented')}
            title="View implemented analysis"
          >
            Implemented
          </button>
          <button
            type="button"
            className="btn-switch-context"
            data-testid="switch-graph-context-btn"
            onClick={() => onGraphContextChange?.(currentContext === 'intended' ? 'implemented' : 'intended')}
            title="Switch graph context"
          >
            Switch Context
          </button>
        </div>
      </div>

      {/* Scope Breadcrumbs when scoped */}
      {viewState.activeScope && (
        <div className="tree-scope-breadcrumbs" data-testid="tree-scope-breadcrumbs">
          <span className="breadcrumbs-label">Scope:</span>
          <button
            type="button"
            className="breadcrumb-crumb"
            data-testid="breadcrumb-root"
            onClick={() => onScopeChange(null)}
          >
            Root
          </button>
          {scopeBreadcrumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.id}>
              <span className="breadcrumb-separator">/</span>
              <button
                type="button"
                className={`breadcrumb-crumb ${idx === scopeBreadcrumbs.length - 1 ? 'current' : ''}`}
                data-testid={`breadcrumb-${crumb.id}`}
                onClick={() => onScopeChange(crumb.id)}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="panel-search">
        <Search size={14} className="search-icon" />
        <input
          type="text"
          className="search-input"
          placeholder="Filter tree items..."
          value={viewState.searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          data-testid="tree-search-input"
        />
      </div>

      <div className="panel-content tree-content">
        {nodes.length === 0 ? (
          <div className="tree-empty-state" data-testid="tree-empty-state">
            <p>No elements defined in this project.</p>
            <span className="empty-hint">Create modules or import source code to populate the hierarchy.</span>
          </div>
        ) : filteredNodes.length === 0 ? (
          <div className="tree-empty-state">
            <p>No matching elements found.</p>
          </div>
        ) : viewState.activeScope && activeScopeChildren.length === 0 ? (
          <div className="tree-empty-scope" data-testid="tree-empty-scope">
            <p>Scope &quot;{activeScopeNode?.name || viewState.activeScope}&quot; has no child elements.</p>
            <button
              className="btn btn-xs btn-secondary"
              onClick={() => onScopeChange(null)}
              data-testid="empty-scope-reset-btn"
            >
              Return to Root Scope
            </button>
          </div>
        ) : (
          <div className="tree-list">
            {topLevelNodes.map(node => renderNodeItem(node, 0))}
          </div>
        )}
      </div>
    </aside>
  );
};
