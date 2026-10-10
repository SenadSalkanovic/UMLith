import React, { useState, useMemo, useEffect } from 'react';
import type {
  Graph,
  Project,
  ProgramNode,
  ProgramEdge,
  Analysis,
  Source,
} from '../../shared/model';
import {
  GraphSchema,
  emptyGraph,
} from '../../shared/model';
import type { ImportQualityReportResponse } from '../../shared/api';
import type { SyncStatus } from '../types';
import {
  computeSpecDiff,
  type SpecDiffResult,
} from './ReviewPanel';
import {
  QualityReport,
  BEHAVIORAL_LIMIT_STATEMENT,
} from './QualityReport';
import {
  ProvenanceBadge,
} from './ModelContext';
import {
  CheckSquare,
  Layers,
  FileCode,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Cpu,
  ArrowRight,
  Shield,
  HelpCircle,
  RefreshCw,
  X,
  Plus,
  Minus,
  MapPin,
  GitBranch,
  Hash,
  Activity,
  ShieldAlert,
  Database,
  Terminal,
} from 'lucide-react';

export interface HumanAcceptanceRecord {
  timestamp: string;
  reviewer: string;
  specRevisionBefore: number;
  acceptedNodeIds: string[];
  acceptedEdgeIds: string[];
  rejectedNodeIds: string[];
  rejectedEdgeIds: string[];
  adoptedGraph: Graph;
  diffSummary: {
    addedNodesCount: number;
    addedEdgesCount: number;
    modifiedNodesCount: number;
  };
}

export interface HumanRejectionRecord {
  timestamp: string;
  reviewer: string;
  specRevision: number;
  rejectedNodeIds: string[];
  rejectedEdgeIds: string[];
  reason?: string;
}

export interface ImportReviewProps {
  project: Project | null;
  specification: Graph | null;
  analysis: Analysis | null;
  report?: ImportQualityReportResponse | null;
  analysisStatus?: SyncStatus;
  isOpen?: boolean;
  onClose?: () => void;
  onAdopt?: (
    adoptedGraph: Graph,
    record: HumanAcceptanceRecord
  ) => void | Promise<void>;
  onReject?: (record?: HumanRejectionRecord) => void | Promise<void>;
  apiBaseUrl?: string;
  mode?: 'modal' | 'embedded' | 'panel';
  initialTab?: 'items' | 'diff' | 'quality' | 'record';
}

/**
 * Pure helper function to construct the prospective intended graph from human selection,
 * preserving compiler-grounded provenance and source bindings while strictly filtering
 * rejected or unselected elements.
 */
export function buildProposedIntendedGraph(
  intendedGraph: Graph | null,
  analysisGraph: Graph | null,
  selectedNodeIds: Set<string>,
  selectedEdgeIds: Set<string>
): {
  proposedGraph: Graph;
  validationError: string | null;
  acceptedNodes: ProgramNode[];
  acceptedEdges: ProgramEdge[];
  rejectedNodes: ProgramNode[];
  rejectedEdges: ProgramEdge[];
} {
  const baseGraph: Graph = intendedGraph ? JSON.parse(JSON.stringify(intendedGraph)) : emptyGraph();
  const baseNodeMap = new Map<string, ProgramNode>(baseGraph.nodes.map(n => [n.id, n]));
  const baseEdgeMap = new Map<string, ProgramEdge>(baseGraph.edges.map(e => [e.id, e]));

  const extractedNodes = analysisGraph?.nodes || [];
  const extractedEdges = analysisGraph?.edges || [];

  const acceptedNodes: ProgramNode[] = [];
  const rejectedNodes: ProgramNode[] = [];

  for (const node of extractedNodes) {
    if (selectedNodeIds.has(node.id)) {
      acceptedNodes.push(node);
      // Preserve provenance, source, and exact attributes from extracted AST
      baseNodeMap.set(node.id, {
        ...node,
        provenance: node.provenance || 'extracted',
        source: node.source,
      });
    } else {
      rejectedNodes.push(node);
    }
  }

  // Ensure containment integrity: if a child's parentId is not present in the proposed graph, clear it
  const allProposedNodeIds = new Set(baseNodeMap.keys());
  const finalNodes: ProgramNode[] = Array.from(baseNodeMap.values()).map(n => {
    if (n.parentId && !allProposedNodeIds.has(n.parentId)) {
      return { ...n, parentId: undefined };
    }
    return n;
  });

  const acceptedEdges: ProgramEdge[] = [];
  const rejectedEdges: ProgramEdge[] = [];

  for (const edge of extractedEdges) {
    if (selectedEdgeIds.has(edge.id)) {
      // Validate that both source and target endpoints exist in the proposed node set
      if (allProposedNodeIds.has(edge.source) && allProposedNodeIds.has(edge.target)) {
        acceptedEdges.push(edge);
        baseEdgeMap.set(edge.id, {
          ...edge,
          provenance: edge.provenance || 'extracted',
        });
      } else {
        // Omit edge if endpoints are missing
        rejectedEdges.push(edge);
      }
    } else {
      rejectedEdges.push(edge);
    }
  }

  const finalEdges = Array.from(baseEdgeMap.values());
  const finalReqs = baseGraph.requirements || [];

  const candidateGraph: Graph = {
    schemaVersion: 1,
    nodes: finalNodes,
    edges: finalEdges,
    requirements: finalReqs,
  };

  const parsed = GraphSchema.safeParse(candidateGraph);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return {
      proposedGraph: candidateGraph,
      validationError: errorMsg,
      acceptedNodes,
      acceptedEdges,
      rejectedNodes,
      rejectedEdges,
    };
  }

  return {
    proposedGraph: parsed.data,
    validationError: null,
    acceptedNodes,
    acceptedEdges,
    rejectedNodes,
    rejectedEdges,
  };
}

export const ImportReview: React.FC<ImportReviewProps> = ({
  project,
  specification,
  analysis,
  report,
  analysisStatus,
  isOpen = true,
  onClose,
  onAdopt,
  onReject,
  apiBaseUrl,
  mode = 'modal',
  initialTab = 'items',
}) => {
  const [activeTab, setActiveTab] = useState<'items' | 'diff' | 'quality' | 'record'>(initialTab);
  const [itemFilter, setItemFilter] = useState<'all' | 'modules' | 'entities' | 'functions' | 'relationships' | 'inferred' | 'opaque'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Track selection of extracted nodes and edges
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    if (analysis?.graph?.nodes) {
      for (const n of analysis.graph.nodes) {
        ids.add(n.id);
      }
    }
    return ids;
  });

  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    if (analysis?.graph?.edges) {
      for (const e of analysis.graph.edges) {
        // By default include extracted edges, but user can explicitly toggle / reject
        ids.add(e.id);
      }
    }
    return ids;
  });

  // Track human acceptance & rejection outcomes
  const [acceptanceRecord, setAcceptanceRecord] = useState<HumanAcceptanceRecord | null>(null);
  const [rejectionRecord, setRejectionRecord] = useState<HumanRejectionRecord | null>(null);
  const [isAdopted, setIsAdopted] = useState<boolean>(false);
  const [isRejected, setIsRejected] = useState<boolean>(false);
  const [adoptionError, setAdoptionError] = useState<string | null>(null);

  // Synchronize when analysis changes
  useEffect(() => {
    if (analysis?.graph) {
      setSelectedNodeIds(new Set(analysis.graph.nodes.map(n => n.id)));
      setSelectedEdgeIds(new Set(analysis.graph.edges.map(e => e.id)));
    }
  }, [analysis?.revision, analysis?.sequence]);

  const effectiveStatus = analysisStatus || report?.status || analysis?.status || 'current';
  const isPartialImport = effectiveStatus === 'partial' || (analysis?.quality?.unresolvedReferences ?? 0) > 0;

  // Build the proposed intended graph from selected items
  const {
    proposedGraph,
    validationError,
    acceptedNodes,
    acceptedEdges,
    rejectedNodes,
    rejectedEdges,
  } = useMemo(() => {
    return buildProposedIntendedGraph(
      specification,
      analysis?.graph || null,
      selectedNodeIds,
      selectedEdgeIds
    );
  }, [specification, analysis, selectedNodeIds, selectedEdgeIds]);

  // Compute specification diff against base intended specification
  const specDiff: SpecDiffResult = useMemo(() => {
    return computeSpecDiff(specification, proposedGraph);
  }, [specification, proposedGraph]);

  // Filtered extracted nodes
  const extractedNodes = analysis?.graph?.nodes || [];
  const extractedEdges = analysis?.graph?.edges || [];

  const filteredNodes = useMemo(() => {
    return extractedNodes.filter(node => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = node.name.toLowerCase().includes(q);
        const matchesKind = node.kind.toLowerCase().includes(q);
        const matchesPath = (node.source?.path || '').toLowerCase().includes(q);
        if (!matchesName && !matchesKind && !matchesPath) return false;
      }

      switch (itemFilter) {
        case 'modules':
          return node.kind === 'module';
        case 'entities':
          return node.kind === 'entity';
        case 'functions':
          return node.kind === 'function';
        case 'opaque':
          return node.stepType === 'opaque';
        case 'inferred':
          return node.provenance === 'ai';
        case 'relationships':
          return false;
        case 'all':
        default:
          return true;
      }
    });
  }, [extractedNodes, searchQuery, itemFilter]);

  const filteredEdges = useMemo(() => {
    if (itemFilter === 'modules' || itemFilter === 'entities' || itemFilter === 'functions' || itemFilter === 'opaque') {
      return [];
    }
    return extractedEdges.filter(edge => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesKind = edge.kind.toLowerCase().includes(q);
        const matchesSource = edge.source.toLowerCase().includes(q);
        const matchesTarget = edge.target.toLowerCase().includes(q);
        if (!matchesKind && !matchesSource && !matchesTarget) return false;
      }

      if (itemFilter === 'inferred') {
        return edge.provenance === 'ai' || edge.uncertain;
      }
      return true;
    });
  }, [extractedEdges, searchQuery, itemFilter]);

  // Selection toggles
  const handleToggleNode = (id: string) => {
    setSelectedNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleEdge = (id: string) => {
    setSelectedEdgeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedNodeIds(new Set(extractedNodes.map(n => n.id)));
    setSelectedEdgeIds(new Set(extractedEdges.map(e => e.id)));
  };

  const handleDeselectAll = () => {
    setSelectedNodeIds(new Set());
    setSelectedEdgeIds(new Set());
  };

  const handleSelectExtractedOnly = () => {
    const extractedNodeIds = new Set(extractedNodes.filter(n => n.provenance !== 'ai').map(n => n.id));
    const extractedEdgeIds = new Set(extractedEdges.filter(e => e.provenance !== 'ai' && !e.uncertain).map(e => e.id));
    setSelectedNodeIds(extractedNodeIds);
    setSelectedEdgeIds(extractedEdgeIds);
  };

  const handleRejectInferredRelationships = () => {
    setSelectedEdgeIds(prev => {
      const next = new Set(prev);
      for (const e of extractedEdges) {
        if (e.provenance === 'ai' || e.uncertain) {
          next.delete(e.id);
        }
      }
      return next;
    });
  };

  const handleRejectEdge = (id: string) => {
    setSelectedEdgeIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleRejectNode = (id: string) => {
    setSelectedNodeIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Human Acceptance Action
  const handleAdoptSelected = async () => {
    if (validationError) {
      setAdoptionError(`Cannot adopt: ${validationError}`);
      return;
    }

    const record: HumanAcceptanceRecord = {
      timestamp: new Date().toISOString(),
      reviewer: 'Human Architect',
      specRevisionBefore: project?.specRevision ?? 0,
      acceptedNodeIds: acceptedNodes.map(n => n.id),
      acceptedEdgeIds: acceptedEdges.map(e => e.id),
      rejectedNodeIds: rejectedNodes.map(n => n.id),
      rejectedEdgeIds: rejectedEdges.map(e => e.id),
      adoptedGraph: proposedGraph,
      diffSummary: {
        addedNodesCount: specDiff.addedNodes.length,
        addedEdgesCount: specDiff.addedEdges.length,
        modifiedNodesCount: specDiff.modifiedNodes.length,
      },
    };

    setAcceptanceRecord(record);
    setIsAdopted(true);
    setIsRejected(false);
    setAdoptionError(null);

    if (onAdopt) {
      await onAdopt(proposedGraph, record);
    }
  };

  // Human Rejection Action
  const handleRejectAll = async () => {
    const record: HumanRejectionRecord = {
      timestamp: new Date().toISOString(),
      reviewer: 'Human Architect',
      specRevision: project?.specRevision ?? 0,
      rejectedNodeIds: extractedNodes.map(n => n.id),
      rejectedEdgeIds: extractedEdges.map(e => e.id),
      reason: 'Rejected by human reviewer; intended specification remains untouched.',
    };

    setRejectionRecord(record);
    setIsRejected(true);
    setIsAdopted(false);

    if (onReject) {
      await onReject(record);
    }
  };

  if (!isOpen) return null;

  const content = (
    <div className="import-review-container" data-testid="import-review-modal">
      {/* 1. Review Header */}
      <div className="import-review-header">
        <div className="header-title-row">
          <Layers size={18} className="text-primary" />
          <h2 className="modal-title" data-testid="import-review-title">
            Import Review & Intended Architecture Adoption
          </h2>
          <span className={`status-badge status-${effectiveStatus}`} data-testid="import-status-badge">
            {effectiveStatus.toUpperCase()}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            className="btn-icon close-btn"
            onClick={onClose}
            aria-label="Close"
            data-testid="import-close-btn"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* 2. Rule R03 Notice: No Intended Changes Occur Before Acceptance */}
      <div className="import-review-banner alert alert-info" data-testid="import-review-banner">
        <Shield size={16} className="text-primary shrink-0" />
        <div className="banner-text">
          <span>
            <strong>Separate Intended & Implemented Graphs (R03):</strong> Imported code populates the implemented graph. The intended specification remains untouched until you explicitly accept items.
          </span>
        </div>
      </div>

      {/* 3. Partial Import / Missing Dependencies Alert */}
      {isPartialImport && (
        <div className="alert alert-warning" data-testid="import-partial-limits-notice">
          <AlertTriangle size={16} className="text-warning shrink-0" />
          <div className="banner-text">
            <span>
              <strong>Partial Import with Visible Limits:</strong> This project contains unresolved references or missing dependencies. Review extracted items with visible limits.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-xs btn-secondary"
            onClick={() => setActiveTab('quality')}
            data-testid="view-quality-report-btn"
          >
            Inspect Quality Report
          </button>
        </div>
      )}

      {/* 4. Human Acceptance Success Banner */}
      {isAdopted && acceptanceRecord && (
        <div className="alert alert-success" data-testid="adoption-success-banner">
          <CheckCircle2 size={16} className="text-success shrink-0" />
          <div className="banner-text">
            <span>
              <strong>Human Acceptance Recorded:</strong> Successfully adopted {acceptanceRecord.acceptedNodeIds.length} node(s) and {acceptanceRecord.acceptedEdgeIds.length} edge(s) into intended architecture. Compiler provenance and source bindings are preserved.
            </span>
          </div>
        </div>
      )}

      {/* 5. Rejection Notice */}
      {isRejected && (
        <div className="alert alert-secondary" data-testid="rejection-success-banner">
          <XCircle size={16} className="text-secondary shrink-0" />
          <div className="banner-text">
            <span>
              <strong>Suggestions Rejected:</strong> Imported structure was rejected. Intended specification remains completely unchanged.
            </span>
          </div>
        </div>
      )}

      {adoptionError && (
        <div className="alert alert-danger" data-testid="adoption-error-banner">
          <AlertTriangle size={16} className="text-danger shrink-0" />
          <span>{adoptionError}</span>
        </div>
      )}

      {/* 6. Navigation Tabs */}
      <div className="import-nav-tabs" data-testid="import-nav-tabs">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'items' ? 'active' : ''}`}
          onClick={() => setActiveTab('items')}
          data-testid="tab-import-items"
        >
          <Layers size={13} />
          <span>Extracted Items ({extractedNodes.length + extractedEdges.length})</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
          onClick={() => setActiveTab('diff')}
          data-testid="tab-import-diff"
        >
          <GitBranch size={13} />
          <span>Specification Diff (+{specDiff.addedNodes.length} nodes, +{specDiff.addedEdges.length} edges)</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'quality' ? 'active' : ''}`}
          onClick={() => setActiveTab('quality')}
          data-testid="tab-import-quality"
        >
          <Activity size={13} />
          <span>Quality Report</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'record' ? 'active' : ''}`}
          onClick={() => setActiveTab('record')}
          data-testid="tab-import-record"
        >
          <CheckSquare size={13} />
          <span>Acceptance Record</span>
        </button>
      </div>

      {/* 7. Tab Content */}
      <div className="import-tab-body">
        {/* Tab 1: Extracted Items & Selection */}
        {activeTab === 'items' && (
          <div className="items-tab-content" data-testid="import-items-view">
            {/* Toolbar */}
            <div className="items-toolbar">
              <div className="toolbar-search">
                <input
                  type="text"
                  placeholder="Filter extracted items by name, kind, path..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="search-input"
                  data-testid="import-search-input"
                />
              </div>
              <div className="toolbar-filters">
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setItemFilter('all')}
                  data-testid="filter-all"
                >
                  All
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'modules' ? 'active' : ''}`}
                  onClick={() => setItemFilter('modules')}
                  data-testid="filter-modules"
                >
                  Modules
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'entities' ? 'active' : ''}`}
                  onClick={() => setItemFilter('entities')}
                  data-testid="filter-entities"
                >
                  Entities
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'functions' ? 'active' : ''}`}
                  onClick={() => setItemFilter('functions')}
                  data-testid="filter-functions"
                >
                  Functions
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'relationships' ? 'active' : ''}`}
                  onClick={() => setItemFilter('relationships')}
                  data-testid="filter-relationships"
                >
                  Relationships
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'inferred' ? 'active' : ''}`}
                  onClick={() => setItemFilter('inferred')}
                  data-testid="filter-inferred"
                >
                  Inferred (AI)
                </button>
                <button
                  type="button"
                  className={`pill-btn ${itemFilter === 'opaque' ? 'active' : ''}`}
                  onClick={() => setItemFilter('opaque')}
                  data-testid="filter-opaque"
                >
                  Opaque
                </button>
              </div>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={handleSelectAll}
                  data-testid="import-select-all"
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={handleDeselectAll}
                  data-testid="import-deselect-all"
                >
                  Deselect All
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={handleSelectExtractedOnly}
                  data-testid="import-select-extracted-only"
                  title="Select compiler-extracted items, excluding AI inferred"
                >
                  Select Extracted Only
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-outline btn-warning"
                  onClick={handleRejectInferredRelationships}
                  data-testid="import-reject-inferred"
                  title="Reject all AI-inferred relationships"
                >
                  Reject Inferred Relationships
                </button>
              </div>
            </div>

            {/* Extracted Nodes List */}
            <div className="extracted-section">
              <h4 className="section-label">
                Extracted Architecture Elements ({filteredNodes.length})
              </h4>
              {filteredNodes.length === 0 ? (
                <div className="empty-notice">No architecture elements match the criteria.</div>
              ) : (
                <div className="extracted-grid" data-testid="extracted-nodes-list">
                  {filteredNodes.map(node => {
                    const isSelected = selectedNodeIds.has(node.id);
                    const isOpaque = node.stepType === 'opaque';
                    const isAi = node.provenance === 'ai';

                    return (
                      <div
                        key={node.id}
                        className={`item-review-card ${isSelected ? 'selected' : 'unselected'} ${isAi ? 'card-ai' : ''}`}
                        data-testid={`extracted-node-${node.id}`}
                      >
                        <div className="item-card-header">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleNode(node.id)}
                              data-testid={`select-node-${node.id}`}
                            />
                            <span className="item-name" data-testid={`node-name-${node.id}`}>
                              {node.name}
                            </span>
                          </label>
                          <div className="item-badges">
                            <span className="item-kind-badge">{node.kind}</span>
                            <ProvenanceBadge
                              provenance={node.provenance}
                              uncertain={isAi}
                              isOpaque={isOpaque}
                              size="sm"
                            />
                          </div>
                        </div>

                        {node.source && (
                          <div className="item-source-row">
                            <MapPin size={11} />
                            <code className="source-path" data-testid={`node-source-${node.id}`}>
                              {node.source.path}:{node.source.line}
                            </code>
                            <span className="source-hash" title={node.source.hash}>
                              rev: {node.source.revision}
                            </span>
                          </div>
                        )}

                        <div className="item-card-footer">
                          <button
                            type="button"
                            className={`btn btn-xs ${isSelected ? 'btn-outline-danger' : 'btn-outline-success'}`}
                            onClick={() => (isSelected ? handleRejectNode(node.id) : handleToggleNode(node.id))}
                            data-testid={`reject-node-${node.id}`}
                          >
                            {isSelected ? 'Exclude' : 'Include'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Extracted Relationships / Edges List */}
            {filteredEdges.length > 0 && (
              <div className="extracted-section mt-4">
                <h4 className="section-label">
                  Extracted & Inferred Relationships ({filteredEdges.length})
                </h4>
                <div className="extracted-grid" data-testid="extracted-edges-list">
                  {filteredEdges.map(edge => {
                    const isSelected = selectedEdgeIds.has(edge.id);
                    const isAi = edge.provenance === 'ai' || edge.uncertain;

                    return (
                      <div
                        key={edge.id}
                        className={`item-review-card edge-card ${isSelected ? 'selected' : 'unselected'} ${isAi ? 'card-ai-uncertain' : ''}`}
                        data-testid={`extracted-edge-${edge.id}`}
                      >
                        <div className="item-card-header">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleEdge(edge.id)}
                              data-testid={`select-edge-${edge.id}`}
                            />
                            <div className="edge-endpoints-display">
                              <code>{edge.source}</code>
                              <ArrowRight size={12} className="mx-1" />
                              <span className="edge-kind-tag">({edge.kind})</span>
                              <ArrowRight size={12} className="mx-1" />
                              <code>{edge.target}</code>
                            </div>
                          </label>
                          <ProvenanceBadge
                            provenance={edge.provenance}
                            uncertain={isAi}
                            size="sm"
                          />
                        </div>

                        {isAi && (
                          <div
                            className="uncertain-edge-warning alert alert-warning py-1 px-2 my-1"
                            data-testid={`uncertain-edge-${edge.id}`}
                          >
                            <AlertTriangle size={12} className="text-warning shrink-0 mr-1" />
                            <span className="text-xs">
                              AI-inferred interpretation: heuristic relationship, not compiler proof.
                            </span>
                          </div>
                        )}

                        <div className="item-card-footer">
                          <button
                            type="button"
                            className={`btn btn-xs ${isSelected ? 'btn-outline-danger' : 'btn-outline-success'}`}
                            onClick={() => (isSelected ? handleRejectEdge(edge.id) : handleToggleEdge(edge.id))}
                            data-testid={`reject-edge-${edge.id}`}
                          >
                            {isSelected ? 'Reject Relationship' : 'Include'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Specification Diff */}
        {activeTab === 'diff' && (
          <div className="diff-tab-content" data-testid="import-diff-view">
            <div className="diff-header-summary">
              <h4>Prospective Intended Specification Diff</h4>
              <p className="diff-explainer">
                The diff below reflects the intended specification changes that will be applied when you confirm adoption.
              </p>
              <div className="diff-badges-row">
                <span className="badge badge-success" data-testid="diff-added-nodes-badge">
                  +{specDiff.addedNodes.length} Added Nodes
                </span>
                <span className="badge badge-success" data-testid="diff-added-edges-badge">
                  +{specDiff.addedEdges.length} Added Edges
                </span>
                <span className="badge badge-neutral">
                  {specDiff.modifiedNodes.length} Modified Nodes
                </span>
              </div>
            </div>

            <div
              className="provenance-preservation-notice alert alert-info my-2"
              data-testid="diff-provenance-summary"
            >
              <CheckCircle2 size={14} className="text-success shrink-0" />
              <span>
                <strong>Provenance Preserved:</strong> All accepted elements preserve their extracted compiler provenance, source path bindings, and hash revisions into the intended graph.
              </span>
            </div>

            <div
              className="no-changes-yet-notice alert alert-secondary my-2"
              data-testid="import-diff-no-change-notice"
            >
              <Shield size={14} className="text-secondary shrink-0" />
              <span>
                No intended specification changes have occurred yet. Acceptance is recorded only when you click "Adopt Selected into Intent".
              </span>
            </div>

            {/* Added Nodes List */}
            {specDiff.addedNodes.length > 0 && (
              <div className="diff-section" data-testid="diff-added-nodes-section">
                <h5>Added Nodes ({specDiff.addedNodes.length}):</h5>
                <ul className="diff-list">
                  {specDiff.addedNodes.map(node => (
                    <li key={node.id} className="diff-list-item" data-testid={`diff-node-${node.id}`}>
                      <span className="diff-item-name">+{node.name}</span>
                      <span className="diff-item-kind">({node.kind})</span>
                      <ProvenanceBadge provenance={node.provenance} size="sm" />
                      {node.source && (
                        <code className="diff-source-path">{node.source.path}</code>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Added Edges List */}
            {specDiff.addedEdges.length > 0 && (
              <div className="diff-section mt-3" data-testid="diff-added-edges-section">
                <h5>Added Relationships ({specDiff.addedEdges.length}):</h5>
                <ul className="diff-list">
                  {specDiff.addedEdges.map(edge => (
                    <li key={edge.id} className="diff-list-item" data-testid={`diff-edge-${edge.id}`}>
                      <span>
                        +{edge.source} → {edge.target} ({edge.kind})
                      </span>
                      <ProvenanceBadge provenance={edge.provenance} uncertain={edge.uncertain} size="sm" />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {rejectedEdges.length > 0 && (
              <div className="diff-section mt-3 alert alert-secondary" data-testid="diff-rejected-edges-section">
                <h5>Rejected / Excluded Relationships ({rejectedEdges.length}):</h5>
                <p className="text-xs">These relationships will NOT be added to the intended graph:</p>
                <ul className="diff-list">
                  {rejectedEdges.map(edge => (
                    <li key={edge.id} className="diff-list-item text-muted" data-testid={`diff-rejected-edge-${edge.id}`}>
                      <span>
                        ✕ {edge.source} → {edge.target} ({edge.kind})
                      </span>
                      <ProvenanceBadge provenance={edge.provenance} uncertain={edge.uncertain} size="sm" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Quality Report */}
        {activeTab === 'quality' && (
          <div className="quality-tab-content" data-testid="import-quality-tab-view">
            <QualityReport
              report={report}
              analysis={analysis}
              status={effectiveStatus}
              revision={analysis?.revision}
            />
          </div>
        )}

        {/* Tab 4: Acceptance Record */}
        {activeTab === 'record' && (
          <div className="record-tab-content" data-testid="import-record-view">
            {acceptanceRecord ? (
              <div className="record-details-card" data-testid="human-acceptance-record">
                <h4>Human Acceptance Record</h4>
                <div className="record-meta-grid">
                  <div><strong>Reviewer:</strong> {acceptanceRecord.reviewer}</div>
                  <div><strong>Timestamp:</strong> {acceptanceRecord.timestamp}</div>
                  <div><strong>Specification Revision Before:</strong> Rev {acceptanceRecord.specRevisionBefore}</div>
                  <div><strong>Accepted Nodes:</strong> {acceptanceRecord.acceptedNodeIds.length}</div>
                  <div><strong>Accepted Edges:</strong> {acceptanceRecord.acceptedEdgeIds.length}</div>
                  <div><strong>Rejected Nodes:</strong> {acceptanceRecord.rejectedNodeIds.length}</div>
                  <div><strong>Rejected Edges:</strong> {acceptanceRecord.rejectedEdgeIds.length}</div>
                </div>
                <div className="record-ids-section mt-3">
                  <h5>Accepted Node IDs:</h5>
                  <div className="tag-cloud">
                    {acceptanceRecord.acceptedNodeIds.map(id => (
                      <span key={id} className="badge badge-success">{id}</span>
                    ))}
                  </div>
                </div>
                {acceptanceRecord.rejectedEdgeIds.length > 0 && (
                  <div className="record-ids-section mt-3">
                    <h5>Rejected Edge IDs:</h5>
                    <div className="tag-cloud">
                      {acceptanceRecord.rejectedEdgeIds.map(id => (
                        <span key={id} className="badge badge-secondary">{id}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : rejectionRecord ? (
              <div className="record-details-card" data-testid="human-rejection-record">
                <h4>Human Rejection Record</h4>
                <div><strong>Reviewer:</strong> {rejectionRecord.reviewer}</div>
                <div><strong>Timestamp:</strong> {rejectionRecord.timestamp}</div>
                <div><strong>Reason:</strong> {rejectionRecord.reason}</div>
                <div className="mt-2 text-success">
                  <strong>Outcome:</strong> Intended specification graph remained completely unchanged.
                </div>
              </div>
            ) : (
              <div className="empty-record-notice" data-testid="empty-record-notice">
                <CheckSquare size={16} />
                <span>No acceptance or rejection action has been committed yet.</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 8. Modal Actions Footer */}
      <div className="import-review-footer">
        <div className="footer-left">
          <span className="selected-summary-text" data-testid="selected-summary-text">
            Selected: {acceptedNodes.length} node(s), {acceptedEdges.length} edge(s)
            {rejectedEdges.length > 0 && ` (${rejectedEdges.length} relationship(s) rejected)`}
          </span>
        </div>
        <div className="footer-buttons">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleRejectAll}
            data-testid="import-reject-btn"
          >
            Reject All Suggestions
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAdoptSelected}
            disabled={acceptedNodes.length === 0 || Boolean(validationError)}
            data-testid="import-adopt-btn"
          >
            Adopt Selected into Intent
          </button>
        </div>
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="modal-backdrop" data-testid="import-review-backdrop">
        <div className="modal-dialog modal-xl">{content}</div>
      </div>
    );
  }

  return content;
};
