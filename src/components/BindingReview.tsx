import React, { useState, useMemo } from 'react';
import type {
  BindingReviewRecord,
  BindingCandidate,
  ProgramNode,
  Project,
  Graph,
  Analysis,
} from '../../shared/model';
import {
  Link as LinkIcon,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Shield,
  ShieldAlert,
  FileCode,
  ArrowRight,
  Lock,
  Check,
  FileText,
  Activity,
  Layers,
  HelpCircle,
  Tag,
} from 'lucide-react';

export interface BindingReviewProps {
  project?: Project | null;
  specification?: Graph | null;
  analysis?: Analysis | null;
  bindingReviews?: BindingReviewRecord[];
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  onAcceptBinding?: (nodeId: string, candidateId: string) => void | Promise<void>;
  onDismiss?: () => void;
  initialFilter?: 'all' | 'ambiguous' | 'unresolved' | 'unambiguous';
  readOnly?: boolean;
}

export function formatSourceRange(source?: { path: string; line?: number; start?: number; end?: number }): string {
  if (!source) return 'Unbound';
  const linePart = source.line ? `Line ${source.line}` : '';
  const rangePart = (typeof source.start === 'number' && typeof source.end === 'number')
    ? `chars ${source.start}..${source.end}`
    : '';
  if (linePart && rangePart) return `${linePart} (${rangePart})`;
  if (linePart) return linePart;
  if (rangePart) return rangePart;
  return source.path;
}

export function formatPolicyLabel(policy: ProgramNode['policy']): string {
  switch (policy) {
    case 'frozen-implementation':
      return 'Frozen Implementation';
    case 'frozen-contract':
      return 'Frozen Contract';
    case 'sensitive':
      return 'Sensitive';
    case 'editable':
    default:
      return 'Editable';
  }
}

export const BindingReview: React.FC<BindingReviewProps> = ({
  project,
  specification,
  analysis,
  bindingReviews = [],
  selectedNodeId,
  onSelectNode,
  onAcceptBinding,
  onDismiss,
  initialFilter = 'all',
  readOnly = false,
}) => {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ambiguous' | 'unresolved' | 'unambiguous'>(initialFilter);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const effectiveSelectedId = selectedNodeId !== undefined ? selectedNodeId : internalSelectedId;

  const handleSelect = (id: string | null) => {
    if (onSelectNode) {
      onSelectNode(id);
    } else {
      setInternalSelectedId(id);
    }
  };

  const counts = useMemo(() => {
    const total = bindingReviews.length;
    const ambiguous = bindingReviews.filter(r => r.status === 'ambiguous').length;
    const unresolved = bindingReviews.filter(r => r.status === 'unresolved').length;
    const unambiguous = bindingReviews.filter(r => r.status === 'unambiguous').length;
    const protectedIssues = bindingReviews.filter(
      r => (r.policy === 'frozen-implementation' || r.policy === 'frozen-contract' || r.policy === 'sensitive') &&
           r.status !== 'unambiguous'
    ).length;
    return { total, ambiguous, unresolved, unambiguous, protectedIssues };
  }, [bindingReviews]);

  const filteredReviews = useMemo(() => {
    if (filter === 'all') return bindingReviews;
    return bindingReviews.filter(r => r.status === filter);
  }, [bindingReviews, filter]);

  // Select first item if current selection is invalid or null and items exist
  const activeReview = useMemo(() => {
    if (effectiveSelectedId) {
      const found = bindingReviews.find(r => r.nodeId === effectiveSelectedId);
      if (found) return found;
    }
    return filteredReviews.length > 0 ? filteredReviews[0] : null;
  }, [effectiveSelectedId, bindingReviews, filteredReviews]);

  const handleAccept = async (nodeId: string, candidateId: string) => {
    if (readOnly || !onAcceptBinding) return;
    try {
      setAcceptingId(candidateId);
      await onAcceptBinding(nodeId, candidateId);
    } finally {
      setAcceptingId(null);
    }
  };

  return (
    <div className="binding-review-panel" data-testid="binding-review-panel">
      {/* Header & Metrics */}
      <div className="binding-review-header">
        <div className="binding-review-title-row">
          <div className="binding-review-title">
            <LinkIcon size={16} />
            <h3>Source Binding Review</h3>
          </div>
          {onDismiss && (
            <button
              type="button"
              className="btn-dismiss-review"
              onClick={onDismiss}
              data-testid="dismiss-binding-review-btn"
            >
              Dismiss
            </button>
          )}
        </div>
        <p className="binding-review-desc">
          Review ambiguous renames, moves, and unresolved symbols. Accepting a binding preserves original protected baselines.
        </p>

        {/* Counts summary bar */}
        <div className="binding-review-metrics" data-testid="binding-review-metrics">
          <button
            type="button"
            className={`metric-badge ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
            data-testid="filter-all"
          >
            <span>Total:</span>
            <strong data-testid="count-total">{counts.total}</strong>
          </button>
          <button
            type="button"
            className={`metric-badge badge-ambiguous ${filter === 'ambiguous' ? 'active' : ''}`}
            onClick={() => setFilter('ambiguous')}
            data-testid="filter-ambiguous"
          >
            <AlertTriangle size={12} />
            <span>Ambiguous:</span>
            <strong data-testid="count-ambiguous">{counts.ambiguous}</strong>
          </button>
          <button
            type="button"
            className={`metric-badge badge-unresolved ${filter === 'unresolved' ? 'active' : ''}`}
            onClick={() => setFilter('unresolved')}
            data-testid="filter-unresolved"
          >
            <XCircle size={12} />
            <span>Unresolved:</span>
            <strong data-testid="count-unresolved">{counts.unresolved}</strong>
          </button>
          <button
            type="button"
            className={`metric-badge badge-unambiguous ${filter === 'unambiguous' ? 'active' : ''}`}
            onClick={() => setFilter('unambiguous')}
            data-testid="filter-unambiguous"
          >
            <CheckCircle2 size={12} />
            <span>Unambiguous:</span>
            <strong data-testid="count-unambiguous">{counts.unambiguous}</strong>
          </button>
        </div>
      </div>

      {/* Blocking Alert if protected items are ambiguous or unresolved */}
      {counts.protectedIssues > 0 && (
        <div className="binding-review-alert" data-testid="unresolved-protection-warning">
          <ShieldAlert size={16} className="text-amber-500" />
          <div className="alert-content">
            <strong>Unresolved protection blocks verification</strong>
            <p>
              {counts.protectedIssues} protected item{counts.protectedIssues > 1 ? 's have' : ' has'} ambiguous or unresolved source bindings.
              Automatic sync will never reset baseline content. Explicit human acceptance is required before candidate changes can verify and apply.
            </p>
          </div>
        </div>
      )}

      {/* Main Two-Pane Area: List and Details */}
      <div className="binding-review-body">
        {/* Left Pane: Review Items List */}
        <div className="binding-review-list" data-testid="binding-review-list">
          {filteredReviews.length === 0 ? (
            <div className="binding-empty-state" data-testid="no-reviews-message">
              <CheckCircle2 size={24} className="text-green-500" />
              <p>No source binding issues to review in this filter.</p>
            </div>
          ) : (
            filteredReviews.map(record => {
              const isSelected = activeReview?.nodeId === record.nodeId;
              const isProtected = record.policy === 'frozen-implementation' ||
                                  record.policy === 'frozen-contract' ||
                                  record.policy === 'sensitive';
              return (
                <div
                  key={record.nodeId}
                  className={`binding-item-card ${isSelected ? 'selected' : ''} status-${record.status}`}
                  onClick={() => handleSelect(record.nodeId)}
                  data-testid={`binding-review-item-${record.nodeId}`}
                >
                  <div className="binding-item-header">
                    <span className="node-name" data-testid="review-node-name">{record.nodeName}</span>
                    <span className="node-kind-tag" data-testid="review-node-kind">{record.kind}</span>
                  </div>
                  <div className="binding-item-sub">
                    <span className={`policy-badge policy-${record.policy}`} data-testid="review-node-policy">
                      {isProtected && <Shield size={10} />}
                      {formatPolicyLabel(record.policy)}
                    </span>
                    <span className={`status-badge status-${record.status}`} data-testid="review-status-badge">
                      {record.status === 'ambiguous' && <AlertTriangle size={10} />}
                      {record.status === 'unresolved' && <XCircle size={10} />}
                      {record.status === 'unambiguous' && <CheckCircle2 size={10} />}
                      {record.status}
                    </span>
                  </div>
                  <div className="binding-item-path text-muted">
                    {record.currentBinding?.path || 'No source file'}
                  </div>
                  <div className="binding-item-reason text-muted" data-testid="review-reason">
                    {record.reason}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Pane: Selected Review Detail */}
        <div className="binding-review-detail" data-testid="binding-review-detail">
          {activeReview ? (
            <div className="detail-content">
              {/* Detail Header */}
              <div className="detail-header">
                <div className="detail-title-row">
                  <h4 className="detail-node-name">{activeReview.nodeName}</h4>
                  <span className="detail-kind-pill">{activeReview.kind}</span>
                  <span className={`detail-policy-pill policy-${activeReview.policy}`}>
                    <Shield size={12} />
                    {formatPolicyLabel(activeReview.policy)}
                  </span>
                  <span className={`detail-status-pill status-${activeReview.status}`}>
                    {activeReview.status}
                  </span>
                </div>
                <div className="detail-reason-box">
                  <p>{activeReview.reason}</p>
                </div>
              </div>

              {/* Section 1: Old / Current Binding */}
              <div className="detail-section" data-testid="old-binding-section">
                <h5>Old / Current Binding</h5>
                <div className="binding-evidence-card">
                  <div className="evidence-row">
                    <span className="evidence-label">File Path:</span>
                    <span className="evidence-value" data-testid="old-binding-path">
                      {activeReview.currentBinding?.path || 'Unbound'}
                    </span>
                  </div>
                  <div className="evidence-row">
                    <span className="evidence-label">Range:</span>
                    <span className="evidence-value" data-testid="old-binding-range">
                      {formatSourceRange(activeReview.currentBinding)}
                    </span>
                  </div>
                  {activeReview.currentBinding?.line && (
                    <div className="evidence-row">
                      <span className="evidence-label">Line:</span>
                      <span className="evidence-value" data-testid="old-binding-line">
                        Line {activeReview.currentBinding.line}
                      </span>
                    </div>
                  )}
                  {activeReview.currentBinding?.symbol && (
                    <div className="evidence-row">
                      <span className="evidence-label">Symbol:</span>
                      <span className="evidence-value" data-testid="old-binding-symbol">
                        {activeReview.currentBinding.symbol}
                      </span>
                    </div>
                  )}
                  {activeReview.currentBinding?.hash && (
                    <div className="evidence-row">
                      <span className="evidence-label">Content Hash:</span>
                      <span className="evidence-value font-mono" data-testid="old-binding-hash">
                        {activeReview.currentBinding.hash.slice(0, 16)}...
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Section 2: Protected Baseline */}
              {activeReview.baseline && (
                <div className="detail-section" data-testid="protected-baseline-section">
                  <h5>Protected Baseline</h5>
                  <div className="baseline-retention-box" data-testid="baseline-retention-notice">
                    <Lock size={12} />
                    <span>
                      Baseline Retention Policy: Accepting a candidate rebinding strictly retains this original baseline. Baselines are never reset automatically.
                    </span>
                  </div>
                  <div className="baseline-content-box">
                    {activeReview.baseline.text !== undefined && (
                      <div className="baseline-text-wrap">
                        <span className="baseline-sub-title">Implementation Baseline Text:</span>
                        <pre className="code-snippet font-mono" data-testid="baseline-content">
                          {activeReview.baseline.text || '(empty implementation)'}
                        </pre>
                      </div>
                    )}
                    {activeReview.baseline.contract !== undefined && (
                      <div className="baseline-contract-wrap">
                        <span className="baseline-sub-title">Declared Interface Baseline:</span>
                        <pre className="code-snippet font-mono" data-testid="baseline-content">
                          {activeReview.baseline.contract || '(empty contract)'}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Section 3: Candidate Declarations */}
              <div className="detail-section" data-testid="candidates-section">
                <h5>
                  Candidate Declarations ({activeReview.candidates.length})
                </h5>

                {activeReview.candidates.length === 0 ? (
                  <div className="no-candidates-box" data-testid="no-candidates-message">
                    <XCircle size={16} className="text-red-500" />
                    <div>
                      <strong>Declaration not found in analyzed source</strong>
                      <p>
                        No candidate declarations match '{activeReview.nodeName}'.
                        Unresolved protected items remain unverified until the declaration is restored or explicitly updated.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="candidate-cards-list">
                    {activeReview.candidates.map((cand, idx) => {
                      const isSelectedCandidate = activeReview.selectedCandidate?.id === cand.id;
                      const isAccepting = acceptingId === cand.id;
                      return (
                        <div
                          key={cand.id || idx}
                          className={`candidate-card ${isSelectedCandidate ? 'selected-candidate' : ''}`}
                          data-testid={`candidate-item-${cand.id}`}
                        >
                          <div className="candidate-header">
                            <div className="cand-title">
                              <span className="cand-name" data-testid={`candidate-name-${cand.id}`}>{cand.name}</span>
                              <span className="cand-kind">{cand.kind}</span>
                              {cand.matchReason && (
                                <span className="cand-reason-pill" data-testid={`candidate-reason-${cand.id}`}>
                                  {cand.matchReason}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              className="btn-accept-binding"
                              onClick={() => handleAccept(activeReview.nodeId, cand.id)}
                              disabled={readOnly || isAccepting}
                              data-testid={`accept-binding-btn-${cand.id}`}
                            >
                              <Check size={13} />
                              <span>{isAccepting ? 'Accepting...' : 'Accept Binding (Keep Baseline)'}</span>
                            </button>
                          </div>

                          <div className="candidate-evidence-body">
                            <div className="cand-row">
                              <span className="lbl">Location:</span>
                              <span className="val" data-testid={`candidate-path-${cand.id}`}>
                                {cand.source.path}
                              </span>
                              <span className="val-range text-muted" data-testid={`candidate-range-${cand.id}`}>
                                {formatSourceRange(cand.source)}
                              </span>
                            </div>

                            {cand.contract && (
                              <div className="cand-row">
                                <span className="lbl">Contract:</span>
                                <code className="val font-mono" data-testid={`candidate-contract-${cand.id}`}>
                                  {cand.contract}
                                </code>
                              </div>
                            )}

                            {/* Candidate Evidence Code Preview */}
                            {cand.evidenceText && (
                              <div className="candidate-code-preview" data-testid={`candidate-evidence-${cand.id}`}>
                                <span className="lbl">Source Evidence Preview:</span>
                                <pre className="code-snippet font-mono">
                                  {cand.evidenceText}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="detail-empty-placeholder">
              <HelpCircle size={24} className="text-muted" />
              <p>Select an item to inspect binding candidates and baselines.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
