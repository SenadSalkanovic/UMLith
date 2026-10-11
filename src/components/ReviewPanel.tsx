import React, { useState, useMemo } from 'react';
import type {
  Graph,
  Project,
  ProgramNode,
  ProgramEdge,
  Requirement,
  ValidationIssue,
  Diagnostic,
  FileChange,
  ValidationReport,
  DesignProposal,
  GraphDelta,
  Analysis,
  BindingReviewRecord,
  DivergenceReport,
} from '../../shared/model';
import { graphDelta } from '../../shared/model';
import type { AnalysisState, SyncStatus } from '../types';
import { QualityReport } from './QualityReport';
import { BindingReview } from './BindingReview';
import { DivergencePanel } from './DivergencePanel';
import {
  CheckSquare,
  Shield,
  Clock,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  GitPullRequest,
  RefreshCw,
  FileCode,
  Code,
  FileText,
  XCircle,
  Check,
  X,
  ArrowLeft,
  ArrowRight,
  Layers,
  Activity,
  Terminal,
  HelpCircle,
  ShieldAlert,
  Link as LinkIcon,
} from 'lucide-react';

export type ReviewState = 'empty' | 'pending-review' | 'invalid' | 'stale-review';
export type ReviewKind = 'architecture' | 'implementation';

export interface ArchitectureProposalReview {
  id: string;
  kind: 'architecture';
  title: string;
  description?: string;
  createdAt?: string;
  specRevision: number;
  targetRevision?: number;
  status?: 'pending' | 'applied' | 'rejected' | 'stale' | 'invalid';
  proposal: DesignProposal;
  delta?: GraphDelta;
  validationIssues?: ValidationIssue[];
  diagnostics?: Diagnostic[];
  isStale?: boolean;
  staleReason?: string;
}

export interface ImplementationReview {
  id: string;
  kind: 'implementation';
  title: string;
  description?: string;
  task?: string;
  createdAt?: string;
  specRevision: number;
  sourceHashes?: Record<string, string>;
  status?: 'pending' | 'applied' | 'rejected' | 'stale' | 'invalid';
  scope?: string[];
  changes: FileChange[];
  candidate?: Analysis;
  preview?: Analysis;
  report?: ValidationReport;
  validationIssues?: ValidationIssue[];
  diagnostics?: Diagnostic[];
  checks?: Record<string, { passed: boolean; output: string }>;
  isStale?: boolean;
  staleReason?: string;
}

export type PendingReviewItem = ArchitectureProposalReview | ImplementationReview;

export interface ReviewStateEvaluation {
  state: ReviewState;
  isStale: boolean;
  staleReason?: string;
  isInvalid: boolean;
  invalidReasons: string[];
  canAccept: boolean;
}

/**
 * Pure evaluation of a review item against current project state and captured hashes.
 * Deliberately blocks acceptance if the review is stale or invalid.
 */
export function computeReviewState(
  review: PendingReviewItem | null | undefined,
  project: Project | null,
  currentSourceHashes?: Record<string, string>
): ReviewStateEvaluation {
  if (!review) {
    return {
      state: 'empty',
      isStale: false,
      isInvalid: false,
      invalidReasons: [],
      canAccept: false,
    };
  }

  // 1. Check Staleness
  let isStale = false;
  let staleReason: string | undefined;

  if (review.isStale) {
    isStale = true;
    staleReason = review.staleReason || 'Review candidate is explicitly marked as stale.';
  } else if (project && review.specRevision !== undefined && review.specRevision !== project.specRevision) {
    isStale = true;
    staleReason = `Specification revision mismatch: candidate was prepared against revision ${review.specRevision}, but current project specification is revision ${project.specRevision}. Revalidate or generate a fresh candidate before application.`;
  } else if (review.kind === 'implementation' && review.sourceHashes && currentSourceHashes) {
    const hasHashMismatch = Object.entries(review.sourceHashes).some(
      ([path, hash]) => currentSourceHashes[path] !== undefined && currentSourceHashes[path] !== hash
    );
    if (hasHashMismatch) {
      isStale = true;
      staleReason = 'Source files were modified externally after this task started. Captured hashes no longer match the baseline.';
    }
  } else if (review.status === 'stale') {
    isStale = true;
    staleReason = review.staleReason || 'Candidate status is marked as stale.';
  }

  // 2. Check Validity
  const invalidReasons: string[] = [];

  if (review.status === 'invalid') {
    invalidReasons.push('Review candidate is marked as invalid.');
  }

  if (review.validationIssues && review.validationIssues.length > 0) {
    for (const issue of review.validationIssues) {
      invalidReasons.push(`[${issue.code}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`);
    }
  }

  if (review.kind === 'implementation') {
    if (review.report && !review.report.passed) {
      for (const issue of review.report.issues) {
        const text = `[${issue.code}] ${issue.message}${issue.path ? ` (${issue.path})` : ''}`;
        if (!invalidReasons.includes(text)) {
          invalidReasons.push(text);
        }
      }
      if (review.report.checks) {
        for (const [name, check] of Object.entries(review.report.checks)) {
          if (!check.passed) {
            invalidReasons.push(`Required check failed: ${name}`);
          }
        }
      }
    }

    if (review.checks) {
      for (const [name, check] of Object.entries(review.checks)) {
        if (!check.passed) {
          invalidReasons.push(`Required check failed: ${name}`);
        }
      }
    }
  }

  if (review.diagnostics) {
    for (const diag of review.diagnostics) {
      if (diag.severity === 'error') {
        invalidReasons.push(`Diagnostic error: ${diag.message}${diag.path ? ` in ${diag.path}` : ''}`);
      }
    }
  }

  const isInvalid = invalidReasons.length > 0;

  // Determine Overall State
  let state: ReviewState;
  if (isStale) {
    state = 'stale-review';
  } else if (isInvalid) {
    state = 'invalid';
  } else {
    state = 'pending-review';
  }

  // Deliberate action rule: can only accept when neither stale nor invalid
  const canAccept = state === 'pending-review';

  return {
    state,
    isStale,
    staleReason,
    isInvalid,
    invalidReasons,
    canAccept,
  };
}

export interface SpecDiffResult {
  addedNodes: ProgramNode[];
  removedNodes: ProgramNode[];
  modifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[];
  addedEdges: ProgramEdge[];
  removedEdges: ProgramEdge[];
  addedReqs: Requirement[];
  removedReqs: Requirement[];
}

/**
 * Pure diff between current specification and proposed graph.
 */
export function computeSpecDiff(currentGraph: Graph | null, proposedGraph: Graph): SpecDiffResult {
  const currentNodes = currentGraph?.nodes || [];
  const currentEdges = currentGraph?.edges || [];
  const currentReqs = currentGraph?.requirements || [];

  const currentNodeMap = new Map(currentNodes.map(n => [n.id, n]));
  const proposedNodeMap = new Map(proposedGraph.nodes.map(n => [n.id, n]));

  const addedNodes = proposedGraph.nodes.filter(n => !currentNodeMap.has(n.id));
  const removedNodes = currentNodes.filter(n => !proposedNodeMap.has(n.id));

  const modifiedNodes: { before: ProgramNode; after: ProgramNode; changes: string[] }[] = [];
  for (const proposed of proposedGraph.nodes) {
    const existing = currentNodeMap.get(proposed.id);
    if (!existing) continue;

    const changes: string[] = [];
    if (existing.name !== proposed.name) changes.push(`Renamed from "${existing.name}" to "${proposed.name}"`);
    if (existing.kind !== proposed.kind) changes.push(`Kind changed from ${existing.kind} to ${proposed.kind}`);
    if (existing.policy !== proposed.policy) changes.push(`Policy changed from ${existing.policy} to ${proposed.policy}`);
    if (existing.contract !== proposed.contract) changes.push('Contract modified');
    if (existing.description !== proposed.description) changes.push('Description updated');
    if (existing.parentId !== proposed.parentId) changes.push(`Parent moved from ${existing.parentId || 'root'} to ${proposed.parentId || 'root'}`);
    if (JSON.stringify(existing.fields) !== JSON.stringify(proposed.fields)) changes.push('Fields modified');
    if (JSON.stringify(existing.requiredChecks) !== JSON.stringify(proposed.requiredChecks)) changes.push('Required checks modified');

    if (changes.length > 0) {
      modifiedNodes.push({ before: existing, after: proposed, changes });
    }
  }

  const currentEdgeMap = new Map(currentEdges.map(e => [e.id, e]));
  const proposedEdgeMap = new Map(proposedGraph.edges.map(e => [e.id, e]));

  const addedEdges = proposedGraph.edges.filter(e => !currentEdgeMap.has(e.id));
  const removedEdges = currentEdges.filter(e => !proposedEdgeMap.has(e.id));

  const currentReqMap = new Map(currentReqs.map(r => [r.id, r]));
  const proposedReqMap = new Map(proposedGraph.requirements.map(r => [r.id, r]));

  const addedReqs = proposedGraph.requirements.filter(r => !currentReqMap.has(r.id));
  const removedReqs = currentReqs.filter(r => !proposedReqMap.has(r.id));

  return {
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdges,
    removedEdges,
    addedReqs,
    removedReqs,
  };
}

export interface ReviewPanelProps {
  project: Project | null;
  graph: Graph | null;
  analysisState: AnalysisState;
  pendingReviews?: PendingReviewItem[];
  activeReviewId?: string | null;
  onSelectReview?: (id: string | null) => void;
  onAccept?: (review: PendingReviewItem) => void | Promise<void>;
  onReject?: (review: PendingReviewItem) => void | Promise<void>;
  onDismiss?: (review: PendingReviewItem) => void;
  initialTab?: 'overview' | 'architecture' | 'implementation' | 'import' | 'bindings' | 'divergence';
  onOpenImportReview?: () => void;
  bindingReviews?: BindingReviewRecord[];
  onAcceptBinding?: (nodeId: string, candidateId: string) => void | Promise<void>;
  divergenceReport?: DivergenceReport | null;
  onRefreshDivergence?: () => void;
}

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  project,
  graph,
  analysisState,
  pendingReviews = [],
  activeReviewId,
  onSelectReview,
  onAccept,
  onReject,
  onDismiss,
  initialTab = 'overview',
  onOpenImportReview,
  bindingReviews = [],
  onAcceptBinding,
  divergenceReport,
  onRefreshDivergence,
}) => {
  const [internalActiveId, setInternalActiveId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'architecture' | 'implementation' | 'import' | 'bindings' | 'divergence'>(initialTab);
  const [reviewSection, setReviewSection] = useState<'spec' | 'code' | 'diagnostics'>('spec');

  const selectedId = activeReviewId !== undefined ? activeReviewId : internalActiveId;

  const handleSelectReviewItem = (id: string | null) => {
    if (onSelectReview) {
      onSelectReview(id);
    } else {
      setInternalActiveId(id);
    }
  };

  const activeReview = useMemo(() => {
    if (!selectedId) return null;
    return pendingReviews.find(r => r.id === selectedId) || null;
  }, [pendingReviews, selectedId]);

  const archReviews = useMemo(
    () => pendingReviews.filter(r => r.kind === 'architecture'),
    [pendingReviews]
  );
  const implReviews = useMemo(
    () => pendingReviews.filter(r => r.kind === 'implementation'),
    [pendingReviews]
  );

  const evaluation = useMemo(() => {
    return computeReviewState(activeReview, project);
  }, [activeReview, project]);

  const specDiff = useMemo(() => {
    if (!activeReview) return null;
    if (activeReview.kind === 'architecture') {
      return computeSpecDiff(graph, activeReview.proposal.graph);
    } else if (activeReview.candidate?.graph) {
      return computeSpecDiff(graph, activeReview.candidate.graph);
    } else if (activeReview.preview?.graph) {
      return computeSpecDiff(graph, activeReview.preview.graph);
    }
    return null;
  }, [activeReview, graph]);

  // Tally policies from current specification
  const nodes = graph?.nodes || [];
  const policyCounts = {
    editable: nodes.filter(n => !n.policy || n.policy === 'editable').length,
    sensitive: nodes.filter(n => n.policy === 'sensitive').length,
    'frozen-implementation': nodes.filter(n => n.policy === 'frozen-implementation').length,
    'frozen-contract': nodes.filter(n => n.policy === 'frozen-contract').length,
  };

  const getStatusExplanation = (status: SyncStatus) => {
    switch (status) {
      case 'current':
        return 'Analysis is complete and synchronized with saved files.';
      case 'updating':
        return 'Source analysis or sync is currently running in the background.';
      case 'partial':
        return 'Analysis succeeded partially; some references or files may remain unresolved.';
      case 'stale':
        return 'Analysis is stale or encountered errors; displaying last valid snapshot.';
      default:
        return 'Standing by for changes or manual rescan.';
    }
  };

  const checks = project?.checks || {};
  const checkEntries = Object.entries(checks);

  // Deliberate actions: never trigger mutation automatically
  const handleAccept = () => {
    if (!activeReview || !evaluation.canAccept) return;
    if (onAccept) {
      onAccept(activeReview);
    }
  };

  const handleDismiss = () => {
    if (!activeReview) return;
    if (onDismiss) {
      onDismiss(activeReview);
    } else if (onReject) {
      onReject(activeReview);
    }
    handleSelectReviewItem(null);
  };

  const handleReject = () => {
    if (!activeReview) return;
    if (onReject) {
      onReject(activeReview);
    } else if (onDismiss) {
      onDismiss(activeReview);
    }
    handleSelectReviewItem(null);
  };

  return (
    <section
      className="panel review-panel"
      data-testid="review-panel"
      aria-label="Human Review Area"
    >
      <div className="panel-header">
        <div className="panel-title">
          <CheckSquare size={16} />
          <span>Review Area</span>
        </div>
        <div className="panel-header-badges">
          {activeReview && (
            <span
              className={`review-item-badge review-badge-${evaluation.state}`}
              data-testid="review-state-badge"
            >
              {evaluation.state.toUpperCase().replace('-', ' ')}
            </span>
          )}
          <span className={`review-status-badge status-${analysisState.status}`}>
            {analysisState.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Review Category and Navigation Switcher */}
      <div className="review-nav-tabs" data-testid="review-nav-tabs">
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'overview' && !activeReview ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('overview');
            handleSelectReviewItem(null);
          }}
          data-testid="tab-overview"
        >
          <Activity size={13} />
          <span>Overview</span>
        </button>
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'architecture' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('architecture');
            if (archReviews.length > 0 && !activeReview) {
              handleSelectReviewItem(archReviews[0].id);
            }
          }}
          data-testid="tab-architecture"
        >
          <Layers size={13} />
          <span>{`Architecture (${archReviews.length})`}</span>
        </button>
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'implementation' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('implementation');
            if (implReviews.length > 0 && !activeReview) {
              handleSelectReviewItem(implReviews[0].id);
            }
          }}
          data-testid="tab-implementation"
        >
          <Code size={13} />
          <span>{`Implementation (${implReviews.length})`}</span>
        </button>
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'import' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('import');
            handleSelectReviewItem(null);
          }}
          data-testid="tab-import"
        >
          <FileCode size={13} />
          <span>Import Quality</span>
        </button>
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'bindings' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('bindings');
            handleSelectReviewItem(null);
          }}
          data-testid="tab-bindings"
        >
          <LinkIcon size={13} />
          <span>{`Bindings (${bindingReviews.length})`}</span>
        </button>
        <button
          type="button"
          className={`review-tab-btn ${activeTab === 'divergence' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('divergence');
            handleSelectReviewItem(null);
          }}
          data-testid="tab-divergence"
        >
          <Layers size={13} />
          <span>{`Divergence (${divergenceReport?.summary.totalDrift ?? 0})`}</span>
        </button>
      </div>

      <div className="panel-content review-content">
        {/* VIEW 1: ACTIVE REVIEW INSPECTION */}
        {activeReview ? (
          <div className="active-review-view" data-testid="active-review-view">
            {/* Review Title Bar & Back Link */}
            <div className="review-detail-header">
              <button
                type="button"
                className="btn-back-review"
                onClick={() => handleSelectReviewItem(null)}
                data-testid="review-back-btn"
                title="Return to review list"
              >
                <ArrowLeft size={14} />
                <span>All Reviews</span>
              </button>
              <div className="review-title-info">
                <div className="review-kind-tag">
                  {activeReview.kind === 'architecture' ? (
                    <span className="badge-arch">Architecture Proposal</span>
                  ) : (
                    <span className="badge-impl">Implementation Candidate</span>
                  )}
                  <span className="review-rev-info">
                    Base Rev: {activeReview.specRevision} (Current: {project?.specRevision ?? 0})
                  </span>
                </div>
                <h3 className="review-item-title" data-testid="review-item-title">
                  {activeReview.title}
                </h3>
                {activeReview.description && (
                  <p className="review-item-desc">{activeReview.description}</p>
                )}
              </div>
            </div>

            {/* STALE STATE BANNER & EXPLANATION */}
            {evaluation.isStale && (
              <div
                className="review-state-banner review-state-stale"
                data-testid="review-stale-explanation"
                role="alert"
              >
                <div className="banner-title">
                  <Clock size={16} />
                  <strong>Stale Review Candidate</strong>
                </div>
                <p className="banner-message">{evaluation.staleReason}</p>
                <p className="banner-subtext">
                  Acceptance is disabled. You must dismiss or reject this candidate, or re-run
                  analysis to produce a current candidate matching specification revision{' '}
                  {project?.specRevision ?? 0}.
                </p>
              </div>
            )}

            {/* INVALID STATE BANNER & EXPLANATION */}
            {evaluation.isInvalid && (
              <div
                className="review-state-banner review-state-invalid"
                data-testid="review-invalid-explanation"
                role="alert"
              >
                <div className="banner-title">
                  <AlertOctagon size={16} />
                  <strong>Validation Issues Detected</strong>
                </div>
                <p className="banner-message">
                  Candidate cannot be accepted due to the following blocking policy or validation
                  violations:
                </p>
                <ul className="invalid-issues-list" data-testid="review-invalid-issues-list">
                  {evaluation.invalidReasons.map((reason, idx) => (
                    <li key={idx} className="invalid-issue-item">
                      {reason}
                    </li>
                  ))}
                </ul>
                <p className="banner-subtext">
                  Application is disabled until all blocking issues and required checks pass.
                </p>
              </div>
            )}

            {/* SECTION TABS: SPECIFICATION | CODE | DIAGNOSTICS */}
            <div className="review-section-tabs" data-testid="review-section-tabs">
              <button
                type="button"
                className={`section-tab-btn ${reviewSection === 'spec' ? 'active' : ''}`}
                onClick={() => setReviewSection('spec')}
                data-testid="tab-section-spec"
              >
                <Layers size={13} />
                <span>Specification</span>
                {specDiff && (
                  <span className="diff-pill">
                    +{specDiff.addedNodes.length} / ~{specDiff.modifiedNodes.length} / -{specDiff.removedNodes.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`section-tab-btn ${reviewSection === 'code' ? 'active' : ''}`}
                onClick={() => setReviewSection('code')}
                data-testid="tab-section-code"
              >
                <Code size={13} />
                <span>Code</span>
                {activeReview.kind === 'implementation' && (
                  <span className="diff-pill">
                    {activeReview.changes.length} file(s)
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`section-tab-btn ${reviewSection === 'diagnostics' ? 'active' : ''}`}
                onClick={() => setReviewSection('diagnostics')}
                data-testid="tab-section-diagnostics"
              >
                <AlertTriangle size={13} />
                <span>Diagnostics</span>
                {(evaluation.invalidReasons.length > 0 || (activeReview.diagnostics?.length || 0) > 0) && (
                  <span className={`diff-pill ${evaluation.isInvalid ? 'pill-danger' : ''}`}>
                    {evaluation.invalidReasons.length + (activeReview.diagnostics?.length || 0)}
                  </span>
                )}
              </button>
            </div>

            {/* SECTION 1: SPECIFICATION */}
            {reviewSection === 'spec' && (
              <div className="review-section-panel" data-testid="review-spec-section">
                {activeReview.kind === 'architecture' && (
                  <div className="proposal-rationale-box">
                    <div className="box-header">
                      <HelpCircle size={14} />
                      <span>Proposal Rationale & Explanation</span>
                    </div>
                    <p className="proposal-explanation-text">
                      {activeReview.proposal.explanation || 'No rationale provided by proposal.'}
                    </p>
                    {activeReview.proposal.questions && activeReview.proposal.questions.length > 0 && (
                      <div className="proposal-questions">
                        <strong>Open Design Questions:</strong>
                        <ul>
                          {activeReview.proposal.questions.map((q, i) => (
                            <li key={i}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {specDiff && (
                  <div className="spec-diff-container" data-testid="spec-diff-container">
                    {/* Added Nodes */}
                    {specDiff.addedNodes.length > 0 && (
                      <div className="diff-group diff-added">
                        <h4>{`Added Specification Elements (${specDiff.addedNodes.length})`}</h4>
                        <div className="diff-nodes-list">
                          {specDiff.addedNodes.map(node => (
                            <div key={node.id} className="diff-node-item node-added" data-testid={`diff-node-added-${node.id}`}>
                              <span className="diff-icon">+</span>
                              <span className="diff-node-kind">{node.kind}</span>
                              <strong className="diff-node-name">{node.name}</strong>
                              <span className="diff-node-policy">{node.policy}</span>
                              {node.contract && (
                                <code className="diff-node-contract">{node.contract}</code>
                              )}
                              {node.policy === 'sensitive' && (
                                <div className="review-sensitive-callout" data-testid={`sensitive-review-callout-${node.id}`}>
                                  <ShieldAlert size={14} className="sensitive-icon" />
                                  <span><strong>Sensitive Element:</strong> Human review emphasis required (R24).</span>
                                  {node.instructions && (
                                    <div className="review-sensitive-instructions" data-testid={`sensitive-instructions-${node.id}`}>
                                      <em>Instructions:</em> {node.instructions}
                                    </div>
                                  )}
                                  {node.requiredChecks?.length > 0 && (
                                    <div className="review-sensitive-checks" data-testid={`sensitive-checks-${node.id}`}>
                                      <em>Required Checks:</em> {node.requiredChecks.join(', ')}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Modified Nodes */}
                    {specDiff.modifiedNodes.length > 0 && (
                      <div className="diff-group diff-modified">
                        <h4>{`Modified Elements (${specDiff.modifiedNodes.length})`}</h4>
                        <div className="diff-nodes-list">
                          {specDiff.modifiedNodes.map(({ before, after, changes }) => (
                            <div key={after.id} className="diff-node-item node-modified" data-testid={`diff-node-modified-${after.id}`}>
                              <span className="diff-icon">~</span>
                              <span className="diff-node-kind">{after.kind}</span>
                              <strong className="diff-node-name">{after.name}</strong>
                              <ul className="diff-node-changes">
                                {changes.map((c, i) => (
                                  <li key={i}>{c}</li>
                                ))}
                              </ul>
                              {(before.policy === 'sensitive' || after.policy === 'sensitive') && (
                                <div className="review-sensitive-callout" data-testid={`sensitive-review-callout-${after.id}`}>
                                  <ShieldAlert size={14} className="sensitive-icon" />
                                  <span><strong>Sensitive Element:</strong> Human review emphasis required (R24).</span>
                                  {after.instructions && (
                                    <div className="review-sensitive-instructions" data-testid={`sensitive-instructions-${after.id}`}>
                                      <em>Instructions:</em> {after.instructions}
                                    </div>
                                  )}
                                  {after.requiredChecks?.length > 0 && (
                                    <div className="review-sensitive-checks" data-testid={`sensitive-checks-${after.id}`}>
                                      <em>Required Checks:</em> {after.requiredChecks.join(', ')}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Removed Nodes */}
                    {specDiff.removedNodes.length > 0 && (
                      <div className="diff-group diff-removed">
                        <h4>{`Removed Elements (${specDiff.removedNodes.length})`}</h4>
                        <div className="diff-nodes-list">
                          {specDiff.removedNodes.map(node => (
                            <div key={node.id} className="diff-node-item node-removed" data-testid={`diff-node-removed-${node.id}`}>
                              <span className="diff-icon">-</span>
                              <span className="diff-node-kind">{node.kind}</span>
                              <strong className="diff-node-name">{node.name}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Edges Diff */}
                    {(specDiff.addedEdges.length > 0 || specDiff.removedEdges.length > 0) && (
                      <div className="diff-group diff-relationships">
                        <h4>Relationship Changes</h4>
                        <ul className="diff-edges-list">
                          {specDiff.addedEdges.map(e => (
                            <li key={e.id} className="edge-added">
                              {`+ ${e.source} --[${e.kind}: ${e.label || e.kind}]--> ${e.target}`}
                            </li>
                          ))}
                          {specDiff.removedEdges.map(e => (
                            <li key={e.id} className="edge-removed">
                              {`- ${e.source} --[${e.kind}: ${e.label || e.kind}]--> ${e.target}`}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {specDiff.addedNodes.length === 0 &&
                      specDiff.modifiedNodes.length === 0 &&
                      specDiff.removedNodes.length === 0 &&
                      specDiff.addedEdges.length === 0 &&
                      specDiff.removedEdges.length === 0 && (
                        <p className="empty-subtext">No specification changes detected in this candidate.</p>
                      )}
                  </div>
                )}
              </div>
            )}

            {/* SECTION 2: CODE DIFFERENCES */}
            {reviewSection === 'code' && (
              <div className="review-section-panel" data-testid="review-code-section">
                {activeReview.kind === 'implementation' ? (
                  activeReview.changes.length === 0 ? (
                    <p className="empty-subtext" data-testid="no-code-changes">No file changes in this implementation candidate.</p>
                  ) : (
                    <div className="file-changes-list" data-testid="file-changes-list">
                      {activeReview.changes.map(file => (
                        <div
                          key={file.path}
                          className="file-change-card"
                          data-testid={`file-change-${file.path}`}
                        >
                          <div className="file-change-header">
                            <span className={`file-kind-badge kind-${file.kind}`}>
                              {file.kind.toUpperCase()}
                            </span>
                            <code className="file-change-path">{file.path}</code>
                          </div>
                          {file.diff ? (
                            <pre className="code-diff-block" data-testid="code-diff-block">
                              <code>
                                {file.diff.split('\n').map((line, idx) => {
                                  let lineClass = 'diff-line-context';
                                  if (line.startsWith('+') && !line.startsWith('+++')) {
                                    lineClass = 'diff-line-added';
                                  } else if (line.startsWith('-') && !line.startsWith('---')) {
                                    lineClass = 'diff-line-removed';
                                  } else if (line.startsWith('@')) {
                                    lineClass = 'diff-line-hunk';
                                  }
                                  return (
                                    <div key={idx} className={`diff-line ${lineClass}`}>
                                      {line}
                                    </div>
                                  );
                                })}
                              </code>
                            </pre>
                          ) : (
                            <p className="empty-subtext">No text diff available (binary file).</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  <div className="arch-code-notice">
                    <p>
                      Architecture proposals modify intended model specifications and requirements.
                      Corresponding source code changes are generated and verified during implementation tasks (R27 / Phase 7).
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 3: DIAGNOSTICS & CHECKS */}
            {reviewSection === 'diagnostics' && (
              <div className="review-section-panel" data-testid="review-diagnostic-section">
                {/* Compiler / Type Diagnostics */}
                <div className="review-card">
                  <div className="review-card-header">
                    <AlertTriangle size={14} />
                    <span>Compiler & Schema Diagnostics</span>
                  </div>
                  {(!activeReview.diagnostics || activeReview.diagnostics.length === 0) ? (
                    <p className="empty-subtext" data-testid="no-diagnostics">No compiler or schema diagnostics reported.</p>
                  ) : (
                    <ul className="diagnostics-list" data-testid="review-diagnostics-list">
                      {activeReview.diagnostics.map((diag, i) => (
                        <li key={i} className={`diagnostic-item severity-${diag.severity}`}>
                          <span className="diag-severity">{diag.severity.toUpperCase()}</span>
                          {diag.path && <code className="diag-path">{diag.path}:{diag.line}</code>}
                          <span className="diag-msg">{diag.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Validation Issues / Policy Checks */}
                <div className="review-card">
                  <div className="review-card-header">
                    <Shield size={14} />
                    <span>Policy & Boundary Verification</span>
                  </div>
                  {evaluation.invalidReasons.length === 0 ? (
                    <div className="verification-pass" data-testid="verification-passed">
                      <CheckCircle2 size={16} className="text-success" />
                      <span>All protection policies and boundary rules verified.</span>
                    </div>
                  ) : (
                    <ul className="validation-issues-list" data-testid="review-validation-issues">
                      {evaluation.invalidReasons.map((issue, i) => (
                        <li key={i} className="validation-issue-item">
                          <XCircle size={14} className="text-danger" />
                          <span>{issue}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Check Results */}
                {activeReview.kind === 'implementation' && (
                  <div className="review-card">
                    <div className="review-card-header">
                      <Terminal size={14} />
                      <span>Configured Check Results</span>
                    </div>
                    {(!activeReview.checks && !activeReview.report?.checks) ? (
                      <p className="empty-subtext">No required check outputs recorded.</p>
                    ) : (
                      <div className="checks-results-list" data-testid="review-checks-results">
                        {Object.entries({
                          ...(activeReview.report?.checks || {}),
                          ...(activeReview.checks || {}),
                        }).map(([name, check]) => (
                          <div key={name} className="check-result-item">
                            <div className="check-result-header">
                              <span className={`check-status-badge ${check.passed ? 'passed' : 'failed'}`}>
                                {check.passed ? 'PASSED' : 'FAILED'}
                              </span>
                              <strong>{name}</strong>
                            </div>
                            {check.output && (
                              <pre className="check-output-snippet">
                                <code>{check.output}</code>
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* DELIBERATE ACTIONS BAR */}
            <div className="review-actions-bar" data-testid="review-actions-bar">
              <div className="actions-explanation">
                {!evaluation.canAccept ? (
                  <span className="blocked-explanation" data-testid="review-blocked-explanation">
                    {evaluation.isStale
                      ? 'Acceptance disabled: candidate is stale against current specification revision.'
                      : 'Acceptance disabled: blocking validation issues or checks must be resolved.'}
                  </span>
                ) : (
                  <span className="ready-explanation">
                    Review candidate verified. Explicit deliberate action required before mutation (R37).
                  </span>
                )}
              </div>

              <div className="actions-buttons">
                <button
                  type="button"
                  className="btn-review-action btn-dismiss"
                  onClick={handleDismiss}
                  data-testid="review-dismiss-btn"
                  title="Dismiss review candidate without applying mutations"
                >
                  <X size={14} />
                  <span>Dismiss</span>
                </button>
                <button
                  type="button"
                  className="btn-review-action btn-reject"
                  onClick={handleReject}
                  data-testid="review-reject-btn"
                  title="Reject review candidate without mutation"
                >
                  <XCircle size={14} />
                  <span>Reject</span>
                </button>
                <button
                  type="button"
                  className="btn-review-action btn-accept"
                  disabled={!evaluation.canAccept}
                  aria-disabled={!evaluation.canAccept}
                  onClick={handleAccept}
                  data-testid="review-accept-btn"
                  title={
                    evaluation.canAccept
                      ? 'Accept and apply changes to project'
                      : evaluation.staleReason || 'Cannot accept invalid review'
                  }
                >
                  <Check size={14} />
                  <span>
                    {activeReview.kind === 'architecture' ? 'Accept Proposal' : 'Apply Changes'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* VIEW 2: OVERVIEW & LIST OF PENDING REVIEWS */
          <div className="review-overview-view" data-testid="review-overview-view">
            {/* Filtered List when Architecture or Implementation tab is chosen */}
            {activeTab === 'architecture' && (
              <div className="reviews-list-container" data-testid="arch-reviews-list">
                <h4>Pending Architecture Proposals</h4>
                {archReviews.length === 0 ? (
                  <div className="review-empty-state" data-testid="review-empty-state">
                    <p>No pending architecture proposals awaiting review.</p>
                  </div>
                ) : (
                  <div className="review-items-grid">
                    {archReviews.map(item => (
                      <div
                        key={item.id}
                        className="review-item-card"
                        data-testid={`review-item-${item.id}`}
                        onClick={() => handleSelectReviewItem(item.id)}
                      >
                        <div className="item-card-header">
                          <span className="badge-arch">Proposal</span>
                          <span className="item-rev">Base Rev: {item.specRevision}</span>
                        </div>
                        <h4 className="item-card-title">{item.title}</h4>
                        <p className="item-card-desc">{item.description || item.proposal.explanation}</p>
                        <button type="button" className="btn-open-review">
                          Inspect &amp; Review &rarr;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'implementation' && (
              <div className="reviews-list-container" data-testid="impl-reviews-list">
                <h4>Pending Implementation Candidates</h4>
                {implReviews.length === 0 ? (
                  <div className="review-empty-state" data-testid="review-empty-state">
                    <p>No pending implementation candidates awaiting review.</p>
                  </div>
                ) : (
                  <div className="review-items-grid">
                    {implReviews.map(item => (
                      <div
                        key={item.id}
                        className="review-item-card"
                        data-testid={`review-item-${item.id}`}
                        onClick={() => handleSelectReviewItem(item.id)}
                      >
                        <div className="item-card-header">
                          <span className="badge-impl">Candidate</span>
                          <span className="item-rev">Files: {item.changes.length}</span>
                        </div>
                        <h4 className="item-card-title">{item.title}</h4>
                        <p className="item-card-desc">{item.description || item.task}</p>
                        <button type="button" className="btn-open-review">
                          Inspect &amp; Review &rarr;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'import' && (
              <div className="review-import-view" data-testid="review-import-view">
                {onOpenImportReview && (
                  <div className="import-review-action-banner mb-3 p-2 bg-card border rounded flex items-center justify-between">
                    <div>
                      <strong>Import Quality & Architecture Adoption</strong>
                      <p className="text-xs text-muted">Review extracted codebase structure and adopt elements into your intended architecture.</p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={onOpenImportReview}
                      data-testid="panel-open-import-review-btn"
                    >
                      <FileCode size={14} className="mr-1 inline" />
                      <span>Review & Adopt</span>
                    </button>
                  </div>
                )}
                <QualityReport
                  analysis={analysisState.analysis}
                  status={analysisState.status}
                />
              </div>
            )}

            {/* TAB: BINDING REVIEWS (T061) */}
            {activeTab === 'bindings' && (
              <div className="review-bindings-container" data-testid="review-bindings-container">
                <BindingReview
                  project={project}
                  specification={graph}
                  analysis={analysisState.analysis || project?.analysis}
                  bindingReviews={bindingReviews}
                  onAcceptBinding={onAcceptBinding}
                />
              </div>
            )}

            {/* TAB: DIVERGENCE (T062) */}
            {activeTab === 'divergence' && (
              <div className="review-divergence-container" data-testid="review-divergence-container">
                <DivergencePanel
                  report={divergenceReport}
                  project={project}
                  onRefresh={onRefreshDivergence}
                />
              </div>
            )}

            {/* Standard Overview Cards (Preserving all existing T016 & T026 contract tests) */}
            {activeTab === 'overview' && (
              <>
                {divergenceReport && divergenceReport.summary.totalDrift > 0 && (
                  <div
                    className={`review-card overview-divergence-banner ${
                      divergenceReport.summary.hasBlockingViolations
                        ? 'border-red-500/50 bg-red-500/5 text-red-400'
                        : 'border-blue-500/30 bg-blue-500/5'
                    }`}
                    data-testid="overview-divergence-banner"
                  >
                    <div className="review-card-header flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {divergenceReport.summary.hasBlockingViolations ? (
                          <ShieldAlert size={14} className="text-red-500" />
                        ) : (
                          <Layers size={14} className="text-blue-400" />
                        )}
                        <span className="font-semibold">Architecture & Protection Divergence</span>
                      </div>
                      <button
                        type="button"
                        className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground font-medium"
                        onClick={() => setActiveTab('divergence')}
                        data-testid="btn-overview-open-divergence"
                      >
                        {`View Details (${divergenceReport.summary.totalDrift})`}
                      </button>
                    </div>
                    <p className="text-xs text-muted mt-1 leading-relaxed">
                      {divergenceReport.summary.hasBlockingViolations
                        ? `${divergenceReport.summary.protectionViolations} blocking protection violation(s) detected. External edits to frozen code raise violations without resetting the protected baseline.`
                        : `${divergenceReport.summary.totalDrift} structural drift item(s) detected between intended architecture and implemented code.`}
                    </p>
                  </div>
                )}

                <div className="review-card">
                  <div className="review-card-header">
                    <Clock size={14} />
                    <span>Synchronization State</span>
                  </div>
                  <p className="status-description">{getStatusExplanation(analysisState.status)}</p>
                </div>

                <div className="review-card">
                  <div className="review-card-header">
                    <Shield size={14} />
                    <span>Protection Policies</span>
                  </div>
                  <div className="policy-grid">
                    <div className="policy-item">
                      <span className="policy-count">{policyCounts.editable}</span>
                      <span className="policy-label">Editable</span>
                    </div>
                    <div className="policy-item policy-sensitive-box">
                      <span className="policy-count">{policyCounts.sensitive}</span>
                      <span className="policy-label">Sensitive</span>
                    </div>
                    <div className="policy-item policy-frozen-box">
                      <span className="policy-count">{policyCounts['frozen-implementation']}</span>
                      <span className="policy-label">Frozen Impl</span>
                    </div>
                    <div className="policy-item policy-contract-box">
                      <span className="policy-count">{policyCounts['frozen-contract']}</span>
                      <span className="policy-label">Frozen Contract</span>
                    </div>
                  </div>
                  {policyCounts.sensitive > 0 && (
                    <div className="review-sensitive-overview" data-testid="review-sensitive-items-summary">
                      <div className="sensitive-overview-header">
                        <ShieldAlert size={13} className="text-amber" />
                        <span>Sensitive Elements Requiring Review Emphasis ({policyCounts.sensitive}):</span>
                      </div>
                      <ul className="sensitive-overview-list" data-testid="review-sensitive-items-list">
                        {nodes.filter(n => n.policy === 'sensitive').map(n => (
                          <li key={n.id} className="sensitive-overview-item" data-testid={`sensitive-overview-item-${n.id}`}>
                            <strong>{n.name}</strong> <code>({n.kind})</code>
                            {n.instructions && <span className="item-instructions"> — {n.instructions}</span>}
                            {n.requiredChecks?.length > 0 && (
                              <span className="item-checks"> [Checks: {n.requiredChecks.join(', ')}]</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {bindingReviews.some(r => r.status !== 'unambiguous') && (
                  <div className="review-card" data-testid="ambiguous-bindings-alert">
                    <div className="review-card-header text-amber">
                      <AlertTriangle size={14} />
                      <span>Source Binding Reviews ({bindingReviews.filter(r => r.status !== 'unambiguous').length})</span>
                    </div>
                    <div className="human-review-callout">
                      <ShieldAlert size={14} className="callout-icon text-amber" />
                      <span>
                        Ambiguous renames or moves require binding review before changes can apply. Baselines are preserved.
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-review-category"
                      onClick={() => {
                        setActiveTab('bindings');
                        handleSelectReviewItem(null);
                      }}
                      data-testid="goto-bindings-btn"
                    >
                      <span>Review Source Bindings</span>
                      <ArrowRight size={12} />
                    </button>
                  </div>
                )}

                <div className="review-card">
                  <div className="review-card-header">
                    <CheckCircle2 size={14} />
                    <span>Configured Checks ({checkEntries.length})</span>
                  </div>
                  {checkEntries.length === 0 ? (
                    <p className="empty-subtext">No required verification checks configured.</p>
                  ) : (
                    <ul className="checks-list" data-testid="review-checks-list">
                      {checkEntries.map(([name, check]) => (
                        <li key={name} className="check-item">
                          <strong>{name}:</strong>
                          <code>{`${check.command} ${check.args.join(' ')}`}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="review-card">
                  <div className="review-card-header">
                    <GitPullRequest size={14} />
                    <span>Pending Proposals</span>
                  </div>
                  <div className="human-review-callout">
                    <AlertTriangle size={14} className="callout-icon" />
                    <span>
                      All AI proposals and code changes require human review before application (R37).
                    </span>
                  </div>
                  {pendingReviews.length === 0 ? (
                    <p className="no-proposals-text" data-testid="review-empty-state">
                      No pending specification or code proposals awaiting review.
                    </p>
                  ) : (
                    <div className="pending-reviews-summary">
                      <p className="pending-summary-text">
                        {`${pendingReviews.length} pending review item(s) available for human inspection.`}
                      </p>
                      <div className="pending-chips">
                        {archReviews.length > 0 && (
                          <button
                            type="button"
                            className="chip-btn"
                            onClick={() => {
                              setActiveTab('architecture');
                              handleSelectReviewItem(archReviews[0].id);
                            }}
                          >
                            {`${archReviews.length} Architecture Proposal(s)`}
                          </button>
                        )}
                        {implReviews.length > 0 && (
                          <button
                            type="button"
                            className="chip-btn"
                            onClick={() => {
                              setActiveTab('implementation');
                              handleSelectReviewItem(implReviews[0].id);
                            }}
                          >
                            {`${implReviews.length} Implementation Candidate(s)`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {analysisState.analysis && analysisState.analysis.graph.nodes.length > 0 && (
                  <div className="review-card" data-testid="imported-structure-card">
                    <div className="review-card-header">
                      <FileCode size={14} />
                      <span>Imported Structure (Implemented Model)</span>
                    </div>
                    <div className="imported-structure-info">
                      <p className="imported-structure-desc">
                        Imported code populates the <strong>implemented graph</strong> (
                        <strong data-testid="implemented-count">
                          {analysisState.analysis.graph.nodes.length}
                        </strong>{' '}
                        node(s)).{' '}
                        {project?.specification.nodes.length
                          ? 'The intended specification is maintained separately'
                          : 'The intended specification remains unadopted'}{' '}
                        (Revision {project?.specRevision ?? 0}) under human control (R03).
                      </p>
                      <div className="imported-node-chips" data-testid="imported-node-chips">
                        {analysisState.analysis.graph.nodes.map(node => (
                          <span
                            key={node.id}
                            className="imported-node-chip"
                            title={`${node.kind}: ${node.name}`}
                            data-testid={`imported-node-${node.id}`}
                          >
                            <span className="chip-kind">{node.kind}</span>
                            <span className="chip-name">{node.name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
