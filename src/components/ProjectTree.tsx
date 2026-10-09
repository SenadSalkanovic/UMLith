import React from 'react';
import type { ProgramNode, Graph } from '../../shared/model';
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
  Shield,
  Search,
  Focus,
} from 'lucide-react';

interface ProjectTreeProps {
  graph: Graph | null;
  viewState: ViewState;
  onSelectNode: (id: string | null) => void;
  onScopeChange: (scopeId: string | null) => void;
  onSearchChange: (query: string) => void;
}

export const ProjectTree: React.FC<ProjectTreeProps> = ({
  graph,
  viewState,
  onSelectNode,
  onScopeChange,
  onSearchChange,
}) => {
  const nodes = graph?.nodes || [];

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

  const matchingNodeIds = React.useMemo(() => {
    if (!viewState.searchQuery) {
      return new Set(nodes.map(n => n.id));
    }
    const q = viewState.searchQuery.toLowerCase();
    const matches = new Set<string>();
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    nodes.forEach(n => {
      if (
        n.name.toLowerCase().includes(q) ||
        n.kind.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q)
      ) {
        matches.add(n.id);
        // Include ancestors so hierarchy displays the match
        let curr = n.parentId ? nodeMap.get(n.parentId) : undefined;
        while (curr) {
          matches.add(curr.id);
          curr = curr.parentId ? nodeMap.get(curr.parentId) : undefined;
        }
      }
    });

    return matches;
  }, [nodes, viewState.searchQuery]);

  const filteredNodes = nodes.filter(n => matchingNodeIds.has(n.id));

  // Group nodes: top-level vs nested
  const topLevelNodes = filteredNodes.filter(n => !n.parentId);
  const childNodesMap = new Map<string, ProgramNode[]>();
  filteredNodes.forEach(n => {
    if (n.parentId) {
      const list = childNodesMap.get(n.parentId) || [];
      list.push(n);
      childNodesMap.set(n.parentId, list);
    }
  });

  const renderNodeItem = (node: ProgramNode, depth = 0) => {
    const isSelected = viewState.selectedId === node.id;
    const isScoped = viewState.activeScope === node.id;
    const children = childNodesMap.get(node.id) || [];
    const isContainer = ['system', 'module', 'class', 'function'].includes(node.kind);

    return (
      <div key={node.id} className="tree-node-group">
        <div
          className={`tree-node-row ${isSelected ? 'selected' : ''} ${isScoped ? 'scoped' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          onClick={() => onSelectNode(node.id)}
          data-testid={`tree-node-${node.id}`}
        >
          <span className="tree-node-icon">{getNodeIcon(node.kind)}</span>
          <span className="tree-node-name" title={node.name}>{node.name}</span>
          <span className="tree-node-kind">{node.kind}</span>

          {node.policy && node.policy !== 'editable' && (
            <span className={`tree-policy-badge policy-${node.policy}`} title={`Policy: ${node.policy}`}>
              <Shield size={10} />
            </span>
          )}

          {isContainer && (
            <button
              className="btn-scope-in"
              title="Focus/Scope into this element"
              onClick={(e) => {
                e.stopPropagation();
                onScopeChange(node.id);
              }}
              data-testid={`scope-in-${node.id}`}
            >
              <Focus size={12} />
            </button>
          )}
        </div>

        {children.length > 0 && (
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
        ) : (
          <div className="tree-list">
            {topLevelNodes.map(node => renderNodeItem(node, 0))}
          </div>
        )}
      </div>
    </aside>
  );
};
