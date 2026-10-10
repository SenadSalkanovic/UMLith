import React, { useState } from 'react';
import type { Analysis, Diagnostic, StaleEvidence, Project } from '../../shared/model';
import type { SyncStatus } from '../types';
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  FileCode,
  Info,
  Clock,
  ShieldAlert,
} from 'lucide-react';

export type AnalysisStatusType = SyncStatus;

export interface AnalysisStatusProps {
  status?: SyncStatus;
  analysis?: Analysis | null;
  project?: Project | null;
  staleEvidence?: StaleEvidence;
  diagnostics?: Diagnostic[];
  isUpdating?: boolean;
  message?: string;
  onRefresh?: () => void;
  onViewDiagnostics?: () => void;
  compact?: boolean;
  className?: string;
}

export function isFirstImportFailure(analysis: Analysis | null | undefined): boolean {
  if (!analysis) return false;
  return analysis.status === 'stale' && (analysis.revision === '' || !analysis.revision) && analysis.sequence === 0;
}

export function getAnalysisLifecycleState(
  analysis: Analysis | null | undefined,
  isUpdating?: boolean
): SyncStatus {
  if (isUpdating) return 'updating';
  if (!analysis) return 'current';
  return analysis.status;
}

export function getOutdatedPortions(
  analysis: Analysis | null | undefined,
  staleEvidence?: StaleEvidence
): { scope: 'all' | 'paths'; paths: string[]; reason: string } | null {
  const ev = staleEvidence || analysis?.staleEvidence;
  if (ev) {
    return {
      scope: ev.scope,
      paths: ev.paths,
      reason: ev.reason,
    };
  }
  if (analysis?.status === 'stale') {
    return {
      scope: 'all',
      paths: [],
      reason: 'Model is outdated due to analysis error or modified source files',
    };
  }
  if (analysis?.status === 'partial') {
    const errorPaths = Array.from(
      new Set(
        (analysis.quality?.diagnostics || [])
          .filter(d => d.severity === 'error' && d.path)
          .map(d => d.path!)
      )
    ).sort();
    if (errorPaths.length > 0) {
      return {
        scope: 'paths',
        paths: errorPaths,
        reason: `Partial analysis: errors encountered in ${errorPaths.join(', ')}`,
      };
    }
  }
  return null;
}

export const AnalysisStatus: React.FC<AnalysisStatusProps> = ({
  status: explicitStatus,
  analysis,
  project,
  staleEvidence: explicitStaleEvidence,
  diagnostics: explicitDiagnostics,
  isUpdating = false,
  message,
  onRefresh,
  onViewDiagnostics,
  compact = false,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(!compact);

  // Determine effective status
  const effectiveStatus: SyncStatus =
    isUpdating || explicitStatus === 'updating'
      ? 'updating'
      : (explicitStatus || analysis?.status || 'current');

  const stalePortions = getOutdatedPortions(analysis, explicitStaleEvidence);
  const isFirstFailure = isFirstImportFailure(analysis);
  const diagnosticsList: Diagnostic[] =
    explicitDiagnostics || analysis?.quality?.diagnostics || [];

  // 1. Compact Badge Mode
  if (compact) {
    const getCompactBadge = () => {
      switch (effectiveStatus) {
        case 'updating':
          return (
            <span
              className="status-badge status-updating"
              data-testid="status-updating"
              data-testid-alt="analysis-status-updating"
              title="Analysis is running in the background"
            >
              <Loader2 className="spinner" size={12} style={{ marginRight: 4 }} />
              Updating…
            </span>
          );
        case 'current':
          return (
            <span
              className="status-badge status-current"
              data-testid="status-current"
              data-testid-alt="analysis-status-current"
              title={`Analysis current (Rev: ${analysis?.revision?.slice(0, 8) || 'latest'})`}
            >
              <CheckCircle2 size={12} style={{ marginRight: 4 }} />
              Current
            </span>
          );
        case 'partial':
          return (
            <span
              className="status-badge status-partial"
              data-testid="status-partial"
              data-testid-alt="analysis-status-partial"
              title="Partial analysis: errors/warnings in some files, valid findings retained"
            >
              <AlertTriangle size={12} style={{ marginRight: 4 }} />
              Partial
            </span>
          );
        case 'stale':
          return (
            <span
              className="status-badge status-stale"
              data-testid="status-stale"
              data-testid-alt="analysis-status-stale"
              title={
                isFirstFailure
                  ? 'First analysis failed with no valid model extracted'
                  : 'Analysis failed: retaining last valid model with original evidence'
              }
            >
              <AlertCircle size={12} style={{ marginRight: 4 }} />
              Stale
            </span>
          );
        default:
          return (
            <span className="status-badge status-idle" data-testid="status-idle">
              Ready
            </span>
          );
      }
    };

    return (
      <div
        className={`analysis-status-compact-container ${className}`}
        data-testid="analysis-status-badge"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}
      >
        {getCompactBadge()}
      </div>
    );
  }

  // 2. Full / Banner / Expanded Mode
  return (
    <div
      className={`analysis-status-card analysis-status-${effectiveStatus} ${className}`}
      data-testid="analysis-status-card"
    >
      <div className="analysis-status-header">
        <div className="analysis-status-title-row">
          {effectiveStatus === 'updating' && (
            <span
              className="status-badge status-updating"
              data-testid="status-updating"
              data-testid-alt="analysis-status-updating"
            >
              <Loader2 className="spinner" size={14} style={{ marginRight: 6 }} />
              Updating…
            </span>
          )}
          {effectiveStatus === 'current' && (
            <span
              className="status-badge status-current"
              data-testid="status-current"
              data-testid-alt="analysis-status-current"
            >
              <CheckCircle2 size={14} style={{ marginRight: 6 }} />
              Current
            </span>
          )}
          {effectiveStatus === 'partial' && (
            <span
              className="status-badge status-partial"
              data-testid="status-partial"
              data-testid-alt="analysis-status-partial"
            >
              <AlertTriangle size={14} style={{ marginRight: 6 }} />
              Partial
            </span>
          )}
          {effectiveStatus === 'stale' && (
            <span
              className="status-badge status-stale"
              data-testid="status-stale"
              data-testid-alt="analysis-status-stale"
            >
              <AlertCircle size={14} style={{ marginRight: 6 }} />
              Stale
            </span>
          )}

          <h3 className="analysis-status-title">
            {effectiveStatus === 'updating' && 'Analysis in Progress'}
            {effectiveStatus === 'current' && 'Analysis Up to Date'}
            {effectiveStatus === 'partial' && 'Partial Analysis Result'}
            {effectiveStatus === 'stale' && (isFirstFailure ? 'Initial Import Failed' : 'Analysis Stale')}
          </h3>
        </div>

        <div className="analysis-status-actions">
          {onRefresh && (
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={onRefresh}
              data-testid="analysis-refresh-btn"
              title="Rescan and re-analyze project files"
            >
              <RefreshCw size={12} style={{ marginRight: 4 }} />
              Rescan
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid="analysis-toggle-details-btn"
            title={isExpanded ? 'Collapse details' : 'Expand details'}
          >
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Main Status Description */}
      <div className="analysis-status-body">
        {effectiveStatus === 'updating' && (
          <div className="status-updating-body" data-testid="updating-indicator">
            <p className="status-narrative">
              {message || 'Analyzing project changes… Larger analyses remain visibly in progress.'}
            </p>
            {analysis?.revision && (
              <p className="status-note" data-testid="retained-during-updating">
                Retaining last valid model (Revision {analysis.revision.slice(0, 8)}, Sequence {analysis.sequence}) while updated analysis is running.
              </p>
            )}
          </div>
        )}

        {effectiveStatus === 'current' && (
          <div className="status-current-body" data-testid="current-indicator">
            <p className="status-narrative">
              All eligible files have been analyzed successfully. Model reflects current saved code.
            </p>
            {analysis && (
              <div className="analysis-meta-row">
                <span className="meta-item" data-testid="analysis-revision">
                  Revision: <strong>{analysis.revision.slice(0, 10)}</strong>
                </span>
                <span className="meta-item" data-testid="analysis-sequence">
                  Sequence: <strong>{analysis.sequence}</strong>
                </span>
                {typeof analysis.durationMs === 'number' && (
                  <span className="meta-item" data-testid="analysis-duration">
                    Duration: <strong>{Math.round(analysis.durationMs)} ms</strong>
                  </span>
                )}
                {analysis.analyzedAt && (
                  <span className="meta-item" data-testid="analysis-timestamp">
                    Analyzed: <strong>{new Date(analysis.analyzedAt).toLocaleTimeString()}</strong>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {effectiveStatus === 'partial' && (
          <div className="status-partial-body" data-testid="partial-indicator">
            <p className="status-narrative">
              Analysis completed with errors or unsupported syntax in one or more files. Valid neighboring findings remain available.
            </p>
            <p className="status-note" data-testid="retained-findings-note">
              Valid findings from neighboring files are preserved in the graph.
            </p>
          </div>
        )}

        {effectiveStatus === 'stale' && (
          <div className="status-stale-body" data-testid="stale-indicator">
            {isFirstFailure ? (
              <div className="first-import-failure-notice alert alert-danger" data-testid="first-import-failure">
                <ShieldAlert size={16} />
                <div className="notice-content">
                  <strong>No Valid Model Extracted:</strong> The initial analysis encountered fatal syntax or configuration errors. Workspace has no valid evidence.
                </div>
              </div>
            ) : (
              <div className="retained-model-notice alert alert-warning" data-testid="retained-model-info">
                <Clock size={16} />
                <div className="notice-content">
                  <span>
                    Analysis failed. Retaining last valid model (Revision{' '}
                    <strong>{analysis?.revision ? analysis.revision.slice(0, 10) : 'initial'}</strong>, Sequence{' '}
                    <strong>{analysis?.sequence ?? 0}</strong>).
                  </span>
                  <div className="evidence-note" data-testid="evidence-preservation-note">
                    Source bindings, content hashes, and ranges remain tied to the last valid capture.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Outdated Portions Section */}
        {stalePortions && (
          <div className="outdated-portions-section" data-testid="outdated-portions">
            <div className="section-header">
              <AlertTriangle size={14} className="icon-warning" />
              <strong>Outdated Portions:</strong>
            </div>
            <div className="outdated-scope-info" data-testid="outdated-scope">
              {stalePortions.scope === 'all' ? (
                <span>Scope: All portions of the model are outdated due to analysis failure.</span>
              ) : (
                <span>Scope: Specific files are outdated due to errors or disk edits.</span>
              )}
            </div>
            {stalePortions.paths && stalePortions.paths.length > 0 && (
              <ul className="outdated-paths-list" data-testid="outdated-paths-list">
                {stalePortions.paths.map((p, idx) => (
                  <li key={idx} className="outdated-path-item" data-testid="outdated-path-item">
                    <FileCode size={12} style={{ marginRight: 4 }} />
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            )}
            {stalePortions.reason && (
              <div className="outdated-reason" data-testid="outdated-reason">
                <em>Reason: {stalePortions.reason}</em>
              </div>
            )}
          </div>
        )}

        {/* Detailed Diagnostics Section */}
        {isExpanded && diagnosticsList.length > 0 && (
          <div className="analysis-diagnostics-section" data-testid="analysis-diagnostics">
            <div className="section-header">
              <Info size={14} />
              <strong>Diagnostic Reasons ({diagnosticsList.length}):</strong>
            </div>
            <div className="diagnostics-list">
              {diagnosticsList.map((d, idx) => (
                <div
                  key={idx}
                  className={`diagnostic-item severity-${d.severity}`}
                  data-testid="diagnostic-item"
                >
                  <span className={`diagnostic-severity badge-${d.severity}`} data-testid="diagnostic-severity">
                    {d.severity.toUpperCase()}
                  </span>
                  {d.code && (
                    <span className="diagnostic-code" data-testid="diagnostic-code">
                      [{d.code}]
                    </span>
                  )}
                  {d.path && (
                    <span className="diagnostic-location" data-testid="diagnostic-location">
                      <code>
                        {d.path}
                        {typeof d.line === 'number' ? `:${d.line}` : ''}
                      </code>
                    </span>
                  )}
                  <span className="diagnostic-message" data-testid="diagnostic-message">
                    {d.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
