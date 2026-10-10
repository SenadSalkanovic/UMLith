import React, { useState, useEffect } from 'react';
import type { Graph, ProgramNode, ProgramEdge, Project, Requirement } from '../../shared/model';
import type { RevisionRecord } from '../../shared/api';
import * as api from '../api';
import {
  History,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Eye,
  CheckCircle2,
  X,
  ArrowRight,
  GitCommit,
  Layers,
  Clock,
  ShieldAlert,
} from 'lucide-react';

export interface RevisionChangeSummary {
  addedNodes: string[];
  removedNodes: string[];
  modifiedNodes: string[];
  addedEdgesCount: number;
  removedEdgesCount: number;
  addedReqsCount: number;
  removedReqsCount: number;
  summaryText: string[];
}

export interface SpecificationRevisionItem {
  revision: number;
  createdAt: string;
  schemaVersion: number;
  graph: Graph;
  nodeCount: number;
  edgeCount: number;
  requirementCount: number;
  isCurrent: boolean;
  changeSummary?: RevisionChangeSummary;
}

export interface SpecificationConflictState {
  projectId: string;
  expectedRevision: number;
  currentRevision: number;
  draftGraph: Graph;
  errorMessage?: string;
  timestamp?: number;
}

export interface ConflictDiffResult {
  draftAddedNodes: ProgramNode[];
  draftRemovedNodes: ProgramNode[];
  draftModifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[];
  serverAddedNodes: ProgramNode[];
  serverRemovedNodes: ProgramNode[];
  serverModifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[];
  draftSummary: string[];
  serverSummary: string[];
  hasDirectNodeOverlap: boolean;
}

/**
 * Pure diff between previous graph and next graph in revision history.
 */
export function computeRevisionChanges(
  prevGraph: Graph | null,
  nextGraph: Graph
): RevisionChangeSummary {
  if (!prevGraph) {
    const summaryText = [
      `Initial specification created with ${nextGraph.nodes.length} node${nextGraph.nodes.length === 1 ? '' : 's'}`,
    ];
    if (nextGraph.edges.length > 0) {
      summaryText.push(`${nextGraph.edges.length} relationship${nextGraph.edges.length === 1 ? '' : 's'}`);
    }
    if (nextGraph.requirements.length > 0) {
      summaryText.push(`${nextGraph.requirements.length} requirement${nextGraph.requirements.length === 1 ? '' : 's'}`);
    }
    return {
      addedNodes: nextGraph.nodes.map(n => n.name || n.id),
      removedNodes: [],
      modifiedNodes: [],
      addedEdgesCount: nextGraph.edges.length,
      removedEdgesCount: 0,
      addedReqsCount: nextGraph.requirements.length,
      removedReqsCount: 0,
      summaryText,
    };
  }

  const prevNodeMap = new Map(prevGraph.nodes.map(n => [n.id, n]));
  const nextNodeMap = new Map(nextGraph.nodes.map(n => [n.id, n]));

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const modifiedNodes: string[] = [];

  for (const node of nextGraph.nodes) {
    const prev = prevNodeMap.get(node.id);
    if (!prev) {
      addedNodes.push(node.name || node.id);
    } else {
      const changed =
        prev.name !== node.name ||
        prev.kind !== node.kind ||
        prev.policy !== node.policy ||
        prev.contract !== node.contract ||
        prev.description !== node.description ||
        prev.parentId !== node.parentId ||
        JSON.stringify(prev.fields) !== JSON.stringify(node.fields) ||
        JSON.stringify(prev.requiredChecks) !== JSON.stringify(node.requiredChecks);
      if (changed) {
        modifiedNodes.push(node.name || node.id);
      }
    }
  }

  for (const prev of prevGraph.nodes) {
    if (!nextNodeMap.has(prev.id)) {
      removedNodes.push(prev.name || prev.id);
    }
  }

  const prevEdgeMap = new Map(prevGraph.edges.map(e => [e.id, e]));
  const nextEdgeMap = new Map(nextGraph.edges.map(e => [e.id, e]));
  const addedEdgesCount = nextGraph.edges.filter(e => !prevEdgeMap.has(e.id)).length;
  const removedEdgesCount = prevGraph.edges.filter(e => !nextEdgeMap.has(e.id)).length;

  const prevReqMap = new Map(prevGraph.requirements.map(r => [r.id, r]));
  const nextReqMap = new Map(nextGraph.requirements.map(r => [r.id, r]));
  const addedReqsCount = nextGraph.requirements.filter(r => !prevReqMap.has(r.id)).length;
  const removedReqsCount = prevGraph.requirements.filter(r => !nextReqMap.has(r.id)).length;

  const summaryText: string[] = [];
  if (addedNodes.length > 0) summaryText.push(`+${addedNodes.length} node${addedNodes.length === 1 ? '' : 's'} (${addedNodes.slice(0, 3).join(', ')}${addedNodes.length > 3 ? '…' : ''})`);
  if (removedNodes.length > 0) summaryText.push(`-${removedNodes.length} node${removedNodes.length === 1 ? '' : 's'} (${removedNodes.slice(0, 3).join(', ')}${removedNodes.length > 3 ? '…' : ''})`);
  if (modifiedNodes.length > 0) summaryText.push(`Modified ${modifiedNodes.length} node${modifiedNodes.length === 1 ? '' : 's'} (${modifiedNodes.slice(0, 3).join(', ')}${modifiedNodes.length > 3 ? '…' : ''})`);
  if (addedEdgesCount > 0) summaryText.push(`+${addedEdgesCount} relationship${addedEdgesCount === 1 ? '' : 's'}`);
  if (removedEdgesCount > 0) summaryText.push(`-${removedEdgesCount} relationship${removedEdgesCount === 1 ? '' : 's'}`);
  if (addedReqsCount > 0) summaryText.push(`+${addedReqsCount} requirement${addedReqsCount === 1 ? '' : 's'}`);
  if (removedReqsCount > 0) summaryText.push(`-${removedReqsCount} requirement${removedReqsCount === 1 ? '' : 's'}`);

  if (summaryText.length === 0) {
    summaryText.push('No structural specification differences');
  }

  return {
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdgesCount,
    removedEdgesCount,
    addedReqsCount,
    removedReqsCount,
    summaryText,
  };
}

/**
 * Builds displayable revision history items sorted descending with calculated change summaries.
 */
export function buildRevisionItems(
  revisions: RevisionRecord[],
  currentRevision: number
): SpecificationRevisionItem[] {
  const sortedAsc = [...revisions].sort((a, b) => a.revision - b.revision);
  const items: SpecificationRevisionItem[] = [];

  for (let i = 0; i < sortedAsc.length; i++) {
    const rev = sortedAsc[i];
    const prevRev = i > 0 ? sortedAsc[i - 1] : null;
    const changeSummary = computeRevisionChanges(prevRev ? prevRev.graph : null, rev.graph);

    items.push({
      revision: rev.revision,
      createdAt: rev.createdAt,
      schemaVersion: rev.schemaVersion,
      graph: rev.graph,
      nodeCount: rev.graph.nodes.length,
      edgeCount: rev.graph.edges.length,
      requirementCount: rev.graph.requirements.length,
      isCurrent: rev.revision === currentRevision,
      changeSummary,
    });
  }

  // Return reverse chronological order for human inspection
  return items.reverse();
}

/**
 * Computes difference between human draft and current specification.
 */
export function computeConflictDiff(
  draftGraph: Graph,
  currentGraph: Graph,
  baseGraph?: Graph | null
): ConflictDiffResult {
  const baseNodes = baseGraph?.nodes || [];
  const baseMap = new Map(baseNodes.map(n => [n.id, n]));
  const currentMap = new Map(currentGraph.nodes.map(n => [n.id, n]));
  const draftMap = new Map(draftGraph.nodes.map(n => [n.id, n]));

  // Draft vs Base
  const draftAddedNodes = draftGraph.nodes.filter(n => !baseMap.has(n.id) && !currentMap.has(n.id));
  const draftRemovedNodes = baseNodes.filter(n => !draftMap.has(n.id));
  const draftModifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[] = [];

  for (const node of draftGraph.nodes) {
    const base = baseMap.get(node.id) || currentMap.get(node.id);
    if (!base) continue;
    const changes: string[] = [];
    if (base.name !== node.name) changes.push(`Renamed to "${node.name}"`);
    if (base.kind !== node.kind) changes.push(`Kind changed to ${node.kind}`);
    if (base.description !== node.description) changes.push('Description edited');
    if (base.contract !== node.contract) changes.push('Contract modified');
    if (changes.length > 0) {
      draftModifiedNodes.push({ before: base, after: node, changes });
    }
  }

  // Server vs Base
  const serverAddedNodes = currentGraph.nodes.filter(n => !baseMap.has(n.id));
  const serverRemovedNodes = baseNodes.filter(n => !currentMap.has(n.id));
  const serverModifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[] = [];

  for (const node of currentGraph.nodes) {
    const base = baseMap.get(node.id);
    if (!base) continue;
    const changes: string[] = [];
    if (base.name !== node.name) changes.push(`Renamed on server to "${node.name}"`);
    if (base.kind !== node.kind) changes.push(`Kind on server changed to ${node.kind}`);
    if (base.description !== node.description) changes.push('Server updated description');
    if (changes.length > 0) {
      serverModifiedNodes.push({ before: base, after: node, changes });
    }
  }

  const draftSummary: string[] = [
    `Draft has ${draftGraph.nodes.length} nodes, ${draftGraph.edges.length} edges`,
  ];
  if (draftAddedNodes.length > 0) draftSummary.push(`Adds ${draftAddedNodes.length} new node(s)`);
  if (draftModifiedNodes.length > 0) draftSummary.push(`Modifies ${draftModifiedNodes.length} node(s)`);

  const serverSummary: string[] = [
    `Current server has ${currentGraph.nodes.length} nodes, ${currentGraph.edges.length} edges`,
  ];
  if (serverAddedNodes.length > 0) serverSummary.push(`Server added ${serverAddedNodes.length} node(s)`);
  if (serverModifiedNodes.length > 0) serverSummary.push(`Server modified ${serverModifiedNodes.length} node(s)`);

  const draftTouchedIds = new Set([
    ...draftAddedNodes.map(n => n.id),
    ...draftRemovedNodes.map(n => n.id),
    ...draftModifiedNodes.map(n => n.after.id),
  ]);
  const serverTouchedIds = new Set([
    ...serverAddedNodes.map(n => n.id),
    ...serverRemovedNodes.map(n => n.id),
    ...serverModifiedNodes.map(n => n.after.id),
  ]);
  let hasDirectNodeOverlap = false;
  for (const id of draftTouchedIds) {
    if (serverTouchedIds.has(id)) {
      hasDirectNodeOverlap = true;
      break;
    }
  }

  return {
    draftAddedNodes,
    draftRemovedNodes,
    draftModifiedNodes,
    serverAddedNodes,
    serverRemovedNodes,
    serverModifiedNodes,
    draftSummary,
    serverSummary,
    hasDirectNodeOverlap,
  };
}

/**
 * Checks if a mutation only altered diagram positions, keeping specification revision unchanged.
 */
export function isLayoutOnlyMutation(projectBefore: Project, projectAfter: Project): boolean {
  const sameSpecRevision = projectBefore.specRevision === projectAfter.specRevision;
  const sameGraph = JSON.stringify(projectBefore.specification) === JSON.stringify(projectAfter.specification);
  const layoutChanged =
    projectBefore.layoutRevision !== projectAfter.layoutRevision ||
    JSON.stringify(projectBefore.layout) !== JSON.stringify(projectAfter.layout);
  return sameSpecRevision && sameGraph && layoutChanged;
}

/**
 * Ensures historical views cannot implicitly overwrite newer revisions.
 */
export function canHistoricalViewOverwrite(isHistorical: boolean): boolean {
  return !isHistorical;
}

/**
 * Prepares an explicit forward restoration edit based on the latest project revision.
 */
export function prepareRestoreEdit(
  historicalRecord: RevisionRecord,
  currentProject: Project
): { expectedRevision: number; graph: Graph } {
  return {
    expectedRevision: currentProject.specRevision,
    graph: historicalRecord.graph,
  };
}

export interface RevisionHistoryProps {
  project: Project | null;
  currentRevision?: number;
  currentGraph?: Graph | null;
  revisions?: RevisionRecord[];
  isOpen?: boolean;
  onClose?: () => void;
  activeHistoricalRevision?: number | null;
  onSelectHistoricalRevision?: (revision: number | null) => void;
  onRestoreRevision?: (targetRevision: RevisionRecord) => Promise<void> | void;
  conflict?: SpecificationConflictState | null;
  onResolveConflictReload?: () => Promise<void> | void;
  onResolveConflictReview?: () => void;
  onResolveConflictApply?: () => Promise<void> | void;
  onResolveConflictDiscard?: () => void;
  apiBaseUrl?: string;
  mode?: 'modal' | 'panel';
}

export const RevisionHistory: React.FC<RevisionHistoryProps> = ({
  project,
  currentRevision = project?.specRevision ?? 0,
  currentGraph = project?.specification || null,
  revisions: propRevisions,
  isOpen = true,
  onClose,
  activeHistoricalRevision = null,
  onSelectHistoricalRevision,
  onRestoreRevision,
  conflict = null,
  onResolveConflictReload,
  onResolveConflictReview,
  onResolveConflictApply,
  onResolveConflictDiscard,
  apiBaseUrl,
  mode = 'modal',
}) => {
  const [revisions, setRevisions] = useState<RevisionRecord[]>(propRevisions || []);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedDetailRev, setSelectedDetailRev] = useState<number | null>(
    activeHistoricalRevision !== null ? activeHistoricalRevision : currentRevision
  );
  const [isReviewingConflictDiff, setIsReviewingConflictDiff] = useState<boolean>(false);

  // Sync prop revisions if updated externally
  useEffect(() => {
    if (propRevisions) {
      setRevisions(propRevisions);
    }
  }, [propRevisions]);

  // Fetch revisions from server if not provided via props
  const fetchRevisions = async () => {
    if (!project?.id) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const history = await api.getSpecificationHistory(project.id, apiBaseUrl);
      setRevisions(history);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to load specification revisions');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (project?.id && (!propRevisions || propRevisions.length === 0)) {
      fetchRevisions();
    }
  }, [project?.id, currentRevision]);

  if (!isOpen && mode === 'modal') {
    return null;
  }

  const revisionItems = buildRevisionItems(revisions, currentRevision);
  const selectedRecord = revisions.find(r => r.revision === selectedDetailRev) || null;
  const isHistoricalActive =
    activeHistoricalRevision !== null && activeHistoricalRevision !== currentRevision;

  const conflictDiff =
    conflict && currentGraph
      ? computeConflictDiff(conflict.draftGraph, currentGraph)
      : null;

  const content = (
    <div
      className={`revision-history-container ${mode === 'modal' ? 'revision-history-modal' : 'revision-history-panel'}`}
      data-testid="revision-history-container"
    >
      {/* Header */}
      <div className="revision-history-header" data-testid="revision-history-header">
        <div className="revision-header-title">
          <History size={18} className="header-icon" />
          <h3>Specification Revisions & History</h3>
          <span className="current-rev-tag" data-testid="current-rev-badge">
            Current: Rev {currentRevision}
          </span>
        </div>
        <div className="revision-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={fetchRevisions}
            disabled={isLoading}
            title="Refresh Revisions"
            data-testid="refresh-revisions-btn"
          >
            <RefreshCw size={14} className={isLoading ? 'spinner' : ''} />
            <span>Refresh</span>
          </button>
          {mode === 'modal' && onClose && (
            <button
              type="button"
              className="btn-icon btn-close"
              onClick={onClose}
              title="Close Revisions History"
              data-testid="close-revisions-btn"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* R05 Layout Separation Notice */}
      <div className="layout-separation-notice" data-testid="layout-separation-notice">
        <Layers size={14} />
        <span>
          <strong>Layout is decoupled:</strong> Diagram repositioning updates separate layout files and does not increment specification revisions (R05).
        </span>
      </div>

      {/* Conflict Resolution Section */}
      {conflict && (
        <div className="conflict-resolution-section" data-testid="conflict-resolution-section">
          <div className="conflict-alert" data-testid="conflict-alert">
            <AlertTriangle size={18} className="alert-icon" />
            <div className="conflict-alert-content">
              <h4 data-testid="conflict-title">Specification Conflict Detected</h4>
              <p className="conflict-info" data-testid="conflict-info">
                Your draft was based on <strong>Revision {conflict.expectedRevision}</strong>, but the server is now at <strong>Revision {conflict.currentRevision}</strong>.
              </p>
              <p className="draft-preserved-notice" data-testid="draft-preserved-notice">
                <CheckCircle2 size={14} className="preserved-icon" />
                <span>Your draft has been preserved and is safe. Review changes or reload to recover.</span>
              </p>
            </div>
          </div>

          <div className="conflict-actions" data-testid="conflict-actions">
            {onResolveConflictReload && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onResolveConflictReload}
                data-testid="conflict-reload-btn"
                title="Fetch latest specification while retaining draft in recovery buffer"
              >
                <RefreshCw size={14} />
                <span>Reload Latest Revision</span>
              </button>
            )}

            <button
              type="button"
              className={`btn btn-secondary btn-sm ${isReviewingConflictDiff ? 'active' : ''}`}
              onClick={() => {
                setIsReviewingConflictDiff(prev => !prev);
                if (onResolveConflictReview) onResolveConflictReview();
              }}
              data-testid="conflict-review-btn"
              title="Inspect side-by-side differences between your draft and the server"
            >
              <Eye size={14} />
              <span>{isReviewingConflictDiff ? 'Hide Conflict Diff' : 'Review Conflict Diff'}</span>
            </button>

            {onResolveConflictApply && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onResolveConflictApply}
                data-testid="conflict-apply-btn"
                title="Explicitly commit your preserved draft on top of latest revision"
              >
                <ArrowRight size={14} />
                <span>Apply Draft as Rev {conflict.currentRevision + 1}</span>
              </button>
            )}

            {onResolveConflictDiscard && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={onResolveConflictDiscard}
                data-testid="conflict-discard-btn"
                title="Discard your draft and adopt server state"
              >
                <X size={14} />
                <span>Discard Draft</span>
              </button>
            )}
          </div>

          {/* Expanded Conflict Diff Viewer */}
          {isReviewingConflictDiff && conflictDiff && (
            <div className="conflict-diff-card" data-testid="conflict-diff-card">
              <h5>Conflict Analysis: Draft vs. Server</h5>
              <div className="diff-columns">
                <div className="diff-col draft-col">
                  <h6>Your Preserved Draft</h6>
                  <ul>
                    {conflictDiff.draftSummary.map((text, idx) => (
                      <li key={idx}>{text}</li>
                    ))}
                    {conflictDiff.draftAddedNodes.map(n => (
                      <li key={n.id} className="diff-added">+ Added node: {n.name} ({n.kind})</li>
                    ))}
                    {conflictDiff.draftModifiedNodes.map(m => (
                      <li key={m.after.id} className="diff-modified">~ Modified: {m.after.name} ({m.changes.join(', ')})</li>
                    ))}
                  </ul>
                </div>
                <div className="diff-col server-col">
                  <h6>Current Server State (Rev {conflict.currentRevision})</h6>
                  <ul>
                    {conflictDiff.serverSummary.map((text, idx) => (
                      <li key={idx}>{text}</li>
                    ))}
                    {conflictDiff.serverAddedNodes.map(n => (
                      <li key={n.id} className="diff-added">+ Added on server: {n.name} ({n.kind})</li>
                    ))}
                    {conflictDiff.serverModifiedNodes.map(m => (
                      <li key={m.after.id} className="diff-modified">~ Changed on server: {m.after.name}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {conflictDiff.hasDirectNodeOverlap && (
                <div className="diff-overlap-warning">
                  <ShieldAlert size={14} />
                  <span>Warning: Both your draft and server modified overlapping specification nodes. Review carefully before applying.</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Historical View Warning Banner */}
      {isHistoricalActive && (
        <div className="historical-view-notice" data-testid="historical-view-notice">
          <Clock size={16} className="notice-icon" />
          <div className="notice-content">
            <span className="notice-title">
              Viewing Historical Snapshot: <strong>Revision {activeHistoricalRevision} (Read-Only)</strong>
            </span>
            <span className="notice-text" data-testid="historical-read-only-msg">
              Historical views are read-only and cannot overwrite newer revisions implicitly.
            </span>
          </div>
          <div className="notice-actions">
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => onSelectHistoricalRevision?.(null)}
              data-testid="exit-historical-btn"
            >
              Exit Historical View
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => {
                const target = selectedRecord || revisions.find(r => r.revision === activeHistoricalRevision);
                if (target) onRestoreRevision?.(target);
              }}
              data-testid="restore-historical-btn"
              title={`Restore Revision ${activeHistoricalRevision} as new Revision ${currentRevision + 1}`}
            >
              <RotateCcw size={12} />
              <span>Restore as Rev {currentRevision + 1}</span>
            </button>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="alert alert-danger" data-testid="revisions-error-banner">
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Main Content Area */}
      <div className="revision-history-body">
        {/* Left Side: Revision List */}
        <div className="revision-list-pane">
          <div className="pane-title">
            <span>Saved Specification History</span>
            <span className="count-badge">{revisionItems.length} Revisions</span>
          </div>

          <div className="revision-list" data-testid="revision-list">
            {revisionItems.length === 0 ? (
              <div className="empty-revisions-msg" data-testid="empty-revisions-msg">
                No specification history records found.
              </div>
            ) : (
              revisionItems.map(item => {
                const isSelected = selectedDetailRev === item.revision;
                const isViewingInWorkspace = activeHistoricalRevision === item.revision;
                return (
                  <div
                    key={item.revision}
                    className={`revision-item ${item.isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''} ${isViewingInWorkspace ? 'active-view' : ''}`}
                    data-testid={`revision-item-${item.revision}`}
                    onClick={() => setSelectedDetailRev(item.revision)}
                  >
                    <div className="revision-item-header">
                      <div className="rev-badge-row">
                        <span
                          className={`rev-badge ${item.isCurrent ? 'badge-current' : 'badge-historical'}`}
                          data-testid={`revision-badge-${item.revision}`}
                        >
                          Rev {item.revision}
                        </span>
                        {item.isCurrent && (
                          <span className="tag-current" data-testid="revision-current-tag">
                            Current
                          </span>
                        )}
                        {isViewingInWorkspace && (
                          <span className="tag-viewing" data-testid="revision-viewing-tag">
                            Viewing (Read-Only)
                          </span>
                        )}
                      </div>
                      <span className="rev-date" data-testid={`revision-date-${item.revision}`}>
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="revision-item-summary" data-testid={`revision-summary-${item.revision}`}>
                      {item.changeSummary?.summaryText.map((text, idx) => (
                        <div key={idx} className="summary-line">
                          {text}
                        </div>
                      ))}
                    </div>

                    <div className="revision-item-footer">
                      <span className="counts" data-testid={`revision-counts-${item.revision}`}>
                        {item.nodeCount} nodes · {item.edgeCount} relationships · {item.requirementCount} reqs
                      </span>
                      <div className="item-actions">
                        {onSelectHistoricalRevision && !item.isCurrent && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={e => {
                              e.stopPropagation();
                              onSelectHistoricalRevision(item.revision);
                            }}
                            data-testid={`select-revision-${item.revision}`}
                            title="Inspect this historical specification snapshot in workspace (read-only)"
                          >
                            <Eye size={12} />
                            <span>View</span>
                          </button>
                        )}
                        {onRestoreRevision && !item.isCurrent && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={e => {
                              e.stopPropagation();
                              const record = revisions.find(r => r.revision === item.revision);
                              if (record) onRestoreRevision(record);
                            }}
                            data-testid={`restore-revision-${item.revision}`}
                            title={`Explicitly restore Revision ${item.revision} as new Revision ${currentRevision + 1}`}
                          >
                            <RotateCcw size={12} />
                            <span>Restore</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Selected Revision Details */}
        <div className="revision-detail-pane" data-testid="revision-detail-pane">
          {selectedRecord ? (
            <div className="revision-detail-card" data-testid="revision-detail-card">
              <div className="detail-header">
                <h4>Specification Revision {selectedRecord.revision}</h4>
                <div className="detail-meta">
                  <span>Created: {new Date(selectedRecord.createdAt).toLocaleString()}</span>
                  <span>Schema Version: {selectedRecord.schemaVersion}</span>
                </div>
              </div>

              <div className="detail-section">
                <h5>Nodes in this revision ({selectedRecord.graph.nodes.length})</h5>
                <div className="detail-node-list">
                  {selectedRecord.graph.nodes.map(n => (
                    <div key={n.id} className="detail-node-badge">
                      <span className="node-kind">{n.kind}</span>
                      <span className="node-name">{n.name}</span>
                      {n.policy && <span className="node-policy">[{n.policy}]</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <h5>Relationships ({selectedRecord.graph.edges.length})</h5>
                <div className="detail-edge-list">
                  {selectedRecord.graph.edges.map(e => (
                    <div key={e.id} className="detail-edge-badge">
                      <span>{e.kind}: {e.source} → {e.target}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <h5>Requirements ({selectedRecord.graph.requirements.length})</h5>
                <div className="detail-req-list">
                  {selectedRecord.graph.requirements.map(r => (
                    <div key={r.id} className="detail-req-badge">
                      <span>{r.text} ({r.id})</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-actions">
                {selectedRecord.revision !== currentRevision && (
                  <>
                    {onSelectHistoricalRevision && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onSelectHistoricalRevision(selectedRecord.revision)}
                        data-testid="detail-view-snapshot-btn"
                      >
                        <Eye size={14} />
                        <span>Inspect Snapshot in Workspace</span>
                      </button>
                    )}
                    {onRestoreRevision && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => onRestoreRevision(selectedRecord)}
                        data-testid="detail-restore-btn"
                      >
                        <RotateCcw size={14} />
                        <span>Restore as Rev {currentRevision + 1}</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="no-detail-selected">
              <span>Select a revision from the list to inspect details.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="revision-modal-backdrop" data-testid="revision-modal-backdrop">
        <div className="revision-modal-container">{content}</div>
      </div>
    );
  }

  return content;
};
