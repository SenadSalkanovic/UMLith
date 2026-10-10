import React, { useState, useMemo } from 'react';
import type {
  Quality,
  Diagnostic,
  Analysis,
  Source,
} from '../../shared/model';
import type { ImportQualityReportResponse } from '../../shared/api';
import type { SyncStatus } from '../types';
import {
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Info,
  FileCode,
  Layers,
  Database,
  Cpu,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Shield,
  HelpCircle,
  Hash,
  MapPin,
} from 'lucide-react';

export const BEHAVIORAL_LIMIT_STATEMENT =
  'File coverage must not be presented as proof of behavioral completeness.';

export interface QualityReportProps {
  report?: ImportQualityReportResponse | null;
  quality?: Quality | null;
  analysis?: Analysis | null;
  status?: SyncStatus;
  revision?: string;
  onViewSource?: (path: string, line?: number) => void;
  onSelectDiagnostic?: (diagnostic: Diagnostic) => void;
  compact?: boolean;
  className?: string;
  title?: string;
}

export const QualityReport: React.FC<QualityReportProps> = ({
  report,
  quality: explicitQuality,
  analysis,
  status: explicitStatus,
  revision: explicitRevision,
  onViewSource,
  onSelectDiagnostic,
  compact = false,
  className = '',
  title = 'Import Quality Report',
}) => {
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'errors' | 'warnings' | 'info' | 'missing-deps'>('all');
  const [isDiagnosticsExpanded, setIsDiagnosticsExpanded] = useState<boolean>(true);
  const [isOpaqueExpanded, setIsOpaqueExpanded] = useState<boolean>(true);
  const [isInferredExpanded, setIsInferredExpanded] = useState<boolean>(true);

  // Derive consolidated quality data
  const quality: Quality = useMemo(() => {
    if (report?.quality) return report.quality;
    if (explicitQuality) return explicitQuality;
    if (analysis?.quality) return analysis.quality;
    return {
      eligibleFiles: report?.eligibleFiles ?? 0,
      analyzedFiles: report?.analyzedFiles ?? 0,
      unresolvedReferences: report?.unresolvedReferences ?? 0,
      unsupportedConstructs: report?.unsupportedConstructs ?? 0,
      inferredItems: report?.inferredItems ?? 0,
      prismaValidation: report?.prismaValidation ?? 'not-applicable',
      diagnostics: report?.diagnostics ?? [],
    };
  }, [report, explicitQuality, analysis]);

  const status: SyncStatus = useMemo(() => {
    if (report?.status) return report.status as SyncStatus;
    if (explicitStatus) return explicitStatus;
    if (analysis?.status) return analysis.status as SyncStatus;
    return 'current';
  }, [report, explicitStatus, analysis]);

  const revision: string = useMemo(() => {
    if (report?.revision !== undefined) return report.revision;
    if (explicitRevision !== undefined) return explicitRevision;
    if (analysis?.revision !== undefined) return analysis.revision;
    return '';
  }, [report, explicitRevision, analysis]);

  const eligibleFiles = report?.eligibleFiles ?? quality.eligibleFiles ?? 0;
  const analyzedFiles = report?.analyzedFiles ?? quality.analyzedFiles ?? 0;
  const coverageRatio = report?.coverage?.ratio ?? (eligibleFiles > 0 ? analyzedFiles / eligibleFiles : 1);
  const coveragePercentage = report?.coverage?.percentage ?? Math.round(coverageRatio * 100);
  const isFullyCovered = report?.coverage?.isFullyCovered ?? (eligibleFiles > 0 && analyzedFiles === eligibleFiles);

  const unresolvedReferences = report?.unresolvedReferences ?? quality.unresolvedReferences ?? 0;
  const unsupportedConstructs = report?.unsupportedConstructs ?? quality.unsupportedConstructs ?? 0;
  const inferredItems = report?.inferredItems ?? quality.inferredItems ?? 0;
  const prismaValidation = report?.prismaValidation ?? quality.prismaValidation ?? 'not-applicable';
  const diagnostics = report?.diagnostics ?? quality.diagnostics ?? [];

  const limitStatement = report?.behavioralLimitStatement || report?.limitStatement || BEHAVIORAL_LIMIT_STATEMENT;

  // Diagnostic breakdowns
  const errors = useMemo(() => diagnostics.filter(d => d.severity === 'error'), [diagnostics]);
  const warnings = useMemo(() => diagnostics.filter(d => d.severity === 'warning'), [diagnostics]);
  const info = useMemo(() => diagnostics.filter(d => d.severity === 'info'), [diagnostics]);

  const missingDependencyDiagnostics = useMemo(() => {
    return diagnostics.filter(d => {
      const msg = (d.message || '').toLowerCase();
      const code = (d.code || '').toLowerCase();
      return (
        code === 'ts2307' ||
        code === 'ts2318' ||
        code === 'incomplete-revision' ||
        msg.includes('cannot find module') ||
        msg.includes('missing dependency') ||
        msg.includes('unresolved') ||
        msg.includes('could not find a declaration file')
      );
    });
  }, [diagnostics]);

  // Determine if this analysis represents a partial import or has missing dependencies
  const isPartialImport = status === 'partial' || unresolvedReferences > 0 || missingDependencyDiagnostics.length > 0;
  const isStaleImport = status === 'stale';

  // Opaque nodes from analysis graph (if available)
  const opaqueNodes = useMemo(() => {
    if (!analysis?.graph?.nodes) return [];
    return analysis.graph.nodes.filter(n => n.stepType === 'opaque');
  }, [analysis]);

  // AI-inferred edges/nodes from analysis graph (if available)
  const inferredEdges = useMemo(() => {
    if (!analysis?.graph?.edges) return [];
    return analysis.graph.edges.filter(e => e.provenance === 'ai' || e.uncertain);
  }, [analysis]);

  const inferredNodes = useMemo(() => {
    if (!analysis?.graph?.nodes) return [];
    return analysis.graph.nodes.filter(n => n.provenance === 'ai');
  }, [analysis]);

  const filteredDiagnostics = useMemo(() => {
    switch (selectedFilter) {
      case 'errors':
        return errors;
      case 'warnings':
        return warnings;
      case 'info':
        return info;
      case 'missing-deps':
        return missingDependencyDiagnostics;
      case 'all':
      default:
        return diagnostics;
    }
  }, [selectedFilter, errors, warnings, info, missingDependencyDiagnostics, diagnostics]);

  return (
    <div
      className={`quality-report-card ${compact ? 'quality-report-compact' : ''} ${className}`}
      data-testid="quality-report"
    >
      {/* 1. Report Header */}
      <div className="quality-report-header">
        <div className="quality-header-title-row">
          <Layers size={18} className="text-primary" />
          <h3 className="quality-report-title" data-testid="quality-report-title">
            {title}
          </h3>
          <div className="quality-header-badges">
            <span
              className={`status-badge status-${status}`}
              data-testid="quality-status-badge"
            >
              {status.toUpperCase()}
            </span>
            {revision && (
              <span
                className="revision-badge"
                data-testid="quality-revision-badge"
                title={`Captured Source Revision: ${revision}`}
              >
                {`Rev: ${revision}`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Mandatory Behavioral Completeness Disclaimer (R09 & R39) */}
      <div
        className="quality-behavioral-notice alert alert-warning"
        data-testid="quality-behavioral-limit-notice"
      >
        <AlertTriangle size={15} className="alert-icon text-warning shrink-0" />
        <div className="behavioral-notice-content">
          <strong className="behavioral-notice-bold" data-testid="behavioral-limit-text">
            {limitStatement}
          </strong>
          <span className="behavioral-notice-sub">
            Runtime behavior and business intent retain uncertainty. Tests and human review complement structural analysis (R09, R39).
          </span>
        </div>
      </div>

      {/* 3. Visible Limits / Partial Import Alert */}
      {isPartialImport && (
        <div
          className="quality-partial-alert alert alert-danger"
          data-testid="quality-partial-limits-banner"
        >
          <AlertCircle size={15} className="alert-icon text-danger shrink-0" />
          <div className="partial-alert-content">
            <div className="partial-alert-title">
              <strong>Partial Import with Visible Limits Detected:</strong>
            </div>
            <ul className="partial-limits-list" data-testid="partial-limits-list">
              {analyzedFiles < eligibleFiles && (
                <li>
                  {`File coverage is partial: ${analyzedFiles} of ${eligibleFiles} eligible files analyzed.`}
                </li>
              )}
              {unresolvedReferences > 0 && (
                <li>
                  {`${unresolvedReferences} unresolved reference${unresolvedReferences > 1 ? 's' : ''} detected in codebase.`}
                </li>
              )}
              {missingDependencyDiagnostics.length > 0 && (
                <li>
                  {`Missing external dependencies or type declarations (${missingDependencyDiagnostics.length} diagnostic${missingDependencyDiagnostics.length > 1 ? 's' : ''}).`}
                </li>
              )}
              {unsupportedConstructs > 0 && (
                <li>
                  {`${unsupportedConstructs} unsupported language construct${unsupportedConstructs > 1 ? 's' : ''} retained as source-backed opaque findings.`}
                </li>
              )}
            </ul>
            <span className="partial-alert-note">
              Extracted structure is incomplete; human review is required before adopting items into the intended specification.
            </span>
          </div>
        </div>
      )}

      {isStaleImport && (
        <div className="alert alert-secondary" data-testid="quality-stale-banner">
          <AlertTriangle size={15} className="text-secondary shrink-0" />
          <span>
            Analysis is marked as stale. Displaying last valid structural findings with original evidence.
          </span>
        </div>
      )}

      {/* 4. Quality Counts & Metrics Grid */}
      <div className="quality-counts-grid" data-testid="quality-counts-grid">
        {/* Metric 1: File Coverage */}
        <div
          className={`quality-metric-box ${isFullyCovered ? 'metric-success' : 'metric-partial'}`}
          data-testid="quality-coverage-card"
        >
          <div className="metric-header">
            <span className="metric-label">File Coverage</span>
            <span
              className={`metric-pill ${isFullyCovered ? 'pill-success' : 'pill-partial'}`}
              data-testid="quality-coverage-pill"
            >
              {isFullyCovered ? 'Full' : 'Partial'}
            </span>
          </div>
          <div className="metric-value-row">
            <span className="metric-main-value" data-testid="quality-coverage-value">
              {`${analyzedFiles} / ${eligibleFiles}`}
            </span>
            <span className="metric-sub-value" data-testid="quality-coverage-percentage">
              {`(${coveragePercentage}%)`}
            </span>
          </div>
          <div className="coverage-progress-bar">
            <div
              className={`progress-fill ${isFullyCovered ? 'fill-success' : 'fill-warning'}`}
              style={{ width: `${Math.min(100, coveragePercentage)}%` }}
            />
          </div>
        </div>

        {/* Metric 2: Diagnostics */}
        <div
          className={`quality-metric-box ${errors.length > 0 ? 'metric-error' : warnings.length > 0 ? 'metric-warning' : 'metric-normal'}`}
          data-testid="quality-diagnostics-card"
        >
          <div className="metric-header">
            <span className="metric-label">Diagnostics</span>
            <span className="metric-pill pill-neutral" data-testid="quality-diagnostics-total">
              {diagnostics.length}
            </span>
          </div>
          <div className="metric-diagnostics-breakdown" data-testid="quality-diagnostics-breakdown">
            <span className="badge-breakdown badge-error" data-testid="diag-count-errors">
              {`${errors.length} err`}
            </span>
            <span className="badge-breakdown badge-warning" data-testid="diag-count-warnings">
              {`${warnings.length} warn`}
            </span>
            <span className="badge-breakdown badge-info" data-testid="diag-count-info">
              {`${info.length} info`}
            </span>
          </div>
        </div>

        {/* Metric 3: Unresolved References */}
        <div
          className={`quality-metric-box ${unresolvedReferences > 0 ? 'metric-warning' : 'metric-normal'}`}
          data-testid="quality-unresolved-card"
        >
          <div className="metric-header">
            <span className="metric-label">Unresolved References</span>
          </div>
          <div className="metric-value-row">
            <span className="metric-main-value" data-testid="quality-unresolved-value">
              {unresolvedReferences}
            </span>
          </div>
          <span className="metric-hint">
            {unresolvedReferences === 0 ? 'All symbols resolved' : 'Incomplete types/modules'}
          </span>
        </div>

        {/* Metric 4: Unsupported Constructs */}
        <div
          className={`quality-metric-box ${unsupportedConstructs > 0 ? 'metric-warning' : 'metric-normal'}`}
          data-testid="quality-unsupported-card"
        >
          <div className="metric-header">
            <span className="metric-label">Unsupported Constructs</span>
          </div>
          <div className="metric-value-row">
            <span className="metric-main-value" data-testid="quality-unsupported-value">
              {unsupportedConstructs}
            </span>
          </div>
          <span className="metric-hint">Preserved as opaque nodes</span>
        </div>

        {/* Metric 5: Inferred Interpretations */}
        <div
          className={`quality-metric-box ${inferredItems > 0 ? 'metric-inferred' : 'metric-normal'}`}
          data-testid="quality-inferred-card"
        >
          <div className="metric-header">
            <span className="metric-label">Inferred Items (AI)</span>
          </div>
          <div className="metric-value-row">
            <span className="metric-main-value" data-testid="quality-inferred-value">
              {inferredItems}
            </span>
          </div>
          <span className="metric-hint">Unverified heuristic claims</span>
        </div>

        {/* Metric 6: Prisma Validation */}
        <div className="quality-metric-box metric-normal" data-testid="quality-prisma-card">
          <div className="metric-header">
            <span className="metric-label">Prisma Validation</span>
          </div>
          <div className="metric-value-row">
            <span
              className={`metric-pill pill-prisma-${prismaValidation}`}
              data-testid="quality-prisma-status"
            >
              {prismaValidation.toUpperCase()}
            </span>
          </div>
          <span className="metric-hint">Schema definition only</span>
        </div>
      </div>

      {/* 5. Diagnostics List Section */}
      <div className="quality-section quality-diagnostics-section" data-testid="quality-diagnostics-section">
        <div
          className="quality-section-header"
          onClick={() => setIsDiagnosticsExpanded(!isDiagnosticsExpanded)}
          style={{ cursor: 'pointer' }}
        >
          <div className="section-title-row">
            {isDiagnosticsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="section-title">Diagnostics ({diagnostics.length})</span>
          </div>
          <div className="diagnostics-filters" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={`filter-btn ${selectedFilter === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedFilter('all')}
              data-testid="filter-diag-all"
            >
              All ({diagnostics.length})
            </button>
            <button
              type="button"
              className={`filter-btn ${selectedFilter === 'errors' ? 'active' : ''}`}
              onClick={() => setSelectedFilter('errors')}
              data-testid="filter-diag-errors"
            >
              Errors ({errors.length})
            </button>
            <button
              type="button"
              className={`filter-btn ${selectedFilter === 'warnings' ? 'active' : ''}`}
              onClick={() => setSelectedFilter('warnings')}
              data-testid="filter-diag-warnings"
            >
              Warnings ({warnings.length})
            </button>
            {missingDependencyDiagnostics.length > 0 && (
              <button
                type="button"
                className={`filter-btn btn-missing-deps ${selectedFilter === 'missing-deps' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('missing-deps')}
                data-testid="filter-diag-missing-deps"
              >
                Missing Deps ({missingDependencyDiagnostics.length})
              </button>
            )}
          </div>
        </div>

        {isDiagnosticsExpanded && (
          <div className="quality-section-content" data-testid="quality-diagnostics-list">
            {filteredDiagnostics.length === 0 ? (
              <div className="empty-diagnostics-notice" data-testid="no-diagnostics-notice">
                <CheckCircle2 size={14} className="text-success" />
                <span>No diagnostics found for this filter.</span>
              </div>
            ) : (
              <div className="diagnostics-items-list">
                {filteredDiagnostics.map((diag, idx) => (
                  <div
                    key={`${diag.code || 'diag'}-${idx}`}
                    className={`diagnostic-card diagnostic-${diag.severity}`}
                    data-testid="diagnostic-item"
                    onClick={() => onSelectDiagnostic && onSelectDiagnostic(diag)}
                  >
                    <div className="diagnostic-header-row">
                      <span className={`diagnostic-severity-badge severity-${diag.severity}`}>
                        {diag.severity.toUpperCase()}
                      </span>
                      {diag.code && (
                        <span className="diagnostic-code-badge" data-testid="diagnostic-code">
                          {diag.code}
                        </span>
                      )}
                      {diag.path && (
                        <span className="diagnostic-location" data-testid="diagnostic-location">
                          <code className="diag-path">{diag.path}</code>
                          {diag.line && <span className="diag-line">:{diag.line}</span>}
                        </span>
                      )}
                    </div>
                    <p className="diagnostic-message" data-testid="diagnostic-message">
                      {diag.message}
                    </p>
                    {diag.path && onViewSource && (
                      <div className="diagnostic-actions">
                        <button
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={e => {
                            e.stopPropagation();
                            onViewSource(diag.path!, diag.line);
                          }}
                          data-testid="diagnostic-view-source-btn"
                        >
                          <FileCode size={11} />
                          <span>View Source</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 6. Unsupported / Opaque Constructs Details */}
      {(unsupportedConstructs > 0 || opaqueNodes.length > 0) && (
        <div className="quality-section quality-opaque-section" data-testid="quality-opaque-section">
          <div
            className="quality-section-header"
            onClick={() => setIsOpaqueExpanded(!isOpaqueExpanded)}
            style={{ cursor: 'pointer' }}
          >
            <div className="section-title-row">
              {isOpaqueExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <ShieldAlert size={14} className="text-warning" />
              <span className="section-title">
                Unsupported Constructs & Opaque Findings ({unsupportedConstructs || opaqueNodes.length})
              </span>
            </div>
          </div>

          {isOpaqueExpanded && (
            <div className="quality-section-content" data-testid="quality-opaque-list">
              <p className="opaque-section-desc">
                Unsupported language constructs are retained as source-backed opaque nodes without losing source context (R08).
              </p>
              {opaqueNodes.length > 0 ? (
                <div className="opaque-items-list">
                  {opaqueNodes.map(node => (
                    <div key={node.id} className="opaque-node-card" data-testid="opaque-node-item">
                      <div className="opaque-card-title-row">
                        <span className="opaque-node-name"><strong>{node.name}</strong></span>
                        <span className="opaque-kind-tag">Kind: {node.kind}</span>
                      </div>
                      {node.source && (
                        <div className="opaque-source-meta">
                          <span><MapPin size={11} /> <code>{`${node.source.path}:${node.source.line}`}</code></span>
                          <span><Hash size={11} /> {`Bytes: ${node.source.start}–${node.source.end}`}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="opaque-summary-box">
                  <span>{`${unsupportedConstructs} complex AST structure(s) preserved with source evidence.`}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 7. Inferred Interpretations & Uncertain Findings */}
      {(inferredItems > 0 || inferredEdges.length > 0 || inferredNodes.length > 0) && (
        <div className="quality-section quality-inferred-section" data-testid="quality-inferred-section">
          <div
            className="quality-section-header"
            onClick={() => setIsInferredExpanded(!isInferredExpanded)}
            style={{ cursor: 'pointer' }}
          >
            <div className="section-title-row">
              {isInferredExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Cpu size={14} className="icon-ai" />
              <span className="section-title">
                AI Inferred Interpretations ({inferredItems || (inferredEdges.length + inferredNodes.length)})
              </span>
            </div>
          </div>

          {isInferredExpanded && (
            <div className="quality-section-content" data-testid="quality-inferred-list">
              <div className="ai-inferred-caveat-box alert alert-warning" data-testid="inferred-warning-box">
                <AlertTriangle size={13} className="text-warning shrink-0" />
                <span>
                  Inferred suggestions retain uncertainty and are heuristic interpretations, not compiler-verified facts. Human review is required before adoption into intent (R03, R39).
                </span>
              </div>
              {inferredEdges.length > 0 && (
                <div className="inferred-edges-list">
                  <h5>Uncertain Relationships ({inferredEdges.length}):</h5>
                  {inferredEdges.map(edge => (
                    <div key={edge.id} className="inferred-edge-item" data-testid="inferred-edge-item">
                      <span className="edge-endpoints">
                        <code>{edge.source}</code> → <code>{edge.target}</code> ({edge.kind})
                      </span>
                      <span className="badge-uncertain">Uncertain / Heuristic</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
