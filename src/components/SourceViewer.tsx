import React, { useMemo, useState, useEffect } from 'react';
import type { Graph, Project } from '../../shared/model';
import { resolveSourceEvidence, type SourceEvidence } from '../../shared/model';
import type { AnalysisState, ViewState } from '../types';
import * as api from '../api';
import {
  FileCode,
  Hash,
  GitBranch,
  MapPin,
  AlertCircle,
  Folder,
  Shield,
  AlertTriangle,
  Cpu,
  Layers,
} from 'lucide-react';

export interface SourceViewerProps {
  project: Project | null;
  graph: Graph | null;
  analysisState: AnalysisState;
  viewState: ViewState;
  apiBaseUrl?: string;
  onRefreshSource?: () => void;
}

export const SourceViewer: React.FC<SourceViewerProps> = ({
  project,
  graph,
  analysisState,
  viewState,
  apiBaseUrl,
}) => {
  const selectedNode = useMemo(() => {
    if (!viewState.selectedId) return null;
    return (
      graph?.nodes.find(n => n.id === viewState.selectedId) ||
      analysisState.analysis?.graph.nodes.find(n => n.id === viewState.selectedId) ||
      null
    );
  }, [viewState.selectedId, graph, analysisState.analysis]);

  const source = selectedNode?.source;
  const baseline = selectedNode?.baseline;
  const provenance = selectedNode?.provenance || 'human';
  const policy = selectedNode?.policy;

  // Live file state from server (when apiBaseUrl is supplied)
  const [liveFile, setLiveFile] = useState<{ path: string; text: string; hash: string } | null>(null);
  const [liveError, setLiveError] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    setLiveFile(null);
    setLiveError(null);
    if (!apiBaseUrl || !project?.id || !source?.path) {
      return;
    }
    const currentPath = source.path;
    let cancelled = false;
    api.getProjectFile(project.id, currentPath, undefined, apiBaseUrl)
      .then(res => {
        if (!cancelled) {
          setLiveFile(res);
          setLiveError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setLiveFile(null);
          setLiveError({ path: currentPath, message: err?.message || 'Failed to inspect file on disk' });
        }
      });
    return () => {
      cancelled = true;
      setLiveFile(null);
      setLiveError(null);
    };
  }, [apiBaseUrl, project?.id, source?.path, source?.revision]);

  // Resolve source evidence against analysis capture
  const evidence: SourceEvidence | null = useMemo(() => {
    if (!source) return null;
    return resolveSourceEvidence(source, analysisState.analysis || undefined, analysisState.analysis?.revision);
  }, [source, analysisState.analysis]);

  // Determine effective status and diagnostic explanation
  const { effectiveStatus, statusMessage, isStale, isMissing, isInvalid } = useMemo(() => {
    if (!source) {
      return {
        effectiveStatus: 'none',
        statusMessage: '',
        isStale: false,
        isMissing: false,
        isInvalid: false,
      };
    }

    let status: 'current' | 'stale' | 'unavailable' | 'invalid' = 'current';
    let msg = '';

    if (evidence) {
      status = evidence.status;
      if (evidence.status === 'stale') {
        msg =
          analysisState.analysis?.staleEvidence?.reason ||
          (source.revision !== analysisState.analysis?.revision
            ? `Analysis revision (${analysisState.analysis?.revision || 'none'}) superseded finding revision (${source.revision})`
            : 'File modified on disk or marked outdated by sync');
      } else if (evidence.status === 'unavailable') {
        msg = evidence.message;
      } else if (evidence.status === 'invalid') {
        msg = evidence.message;
      }
    } else {
      status = 'unavailable';
      msg = 'No captured analysis snapshot available for this workspace';
    }

    // Check project-level analysis status
    if (analysisState.status === 'stale' && status === 'current') {
      status = 'stale';
      msg = 'Project analysis status is marked stale';
    }

    // Check live file if fetched from server (strictly matching current source path)
    const activeLiveFile = liveFile && liveFile.path === source.path ? liveFile : null;
    const activeLiveError = liveError && liveError.path === source.path ? liveError.message : null;

    if (activeLiveFile && activeLiveFile.hash !== source.hash && status === 'current') {
      status = 'stale';
      msg = `Live file on disk modified since extraction (recorded hash ${source.hash.slice(0, 10)}… vs disk hash ${activeLiveFile.hash.slice(0, 10)}…)`;
    }

    if (activeLiveError && status === 'current' && !analysisState.analysis?.files[source.path]) {
      status = 'unavailable';
      msg = activeLiveError;
    }

    return {
      effectiveStatus: status,
      statusMessage: msg,
      isStale: status === 'stale',
      isMissing: status === 'unavailable',
      isInvalid: status === 'invalid',
    };
  }, [source, evidence, analysisState.status, analysisState.analysis, liveFile, liveError]);

  // Prepare source code representation and range highlighting
  const { fullText, before, highlighted, after, hasHighlight, isBaselineOnly } = useMemo(() => {
    if (!source) {
      return { fullText: null, before: '', highlighted: '', after: '', hasHighlight: false, isBaselineOnly: false };
    }

    const captured = analysisState.analysis?.files[source.path];

    // Case 1: Valid captured file matching revision and evidence
    if (captured && (effectiveStatus === 'current' || effectiveStatus === 'stale')) {
      const text = captured.text;
      if (source.start <= source.end && source.end <= text.length) {
        return {
          fullText: text,
          before: text.slice(0, source.start),
          highlighted: text.slice(source.start, source.end),
          after: text.slice(source.end),
          hasHighlight: true,
          isBaselineOnly: false,
        };
      }
    }

    // Case 2: Fall back to baseline text if provided (e.g. frozen implementation baseline or synthetic tests)
    if (baseline?.text) {
      return {
        fullText: baseline.text,
        before: '',
        highlighted: baseline.text,
        after: '',
        hasHighlight: true,
        isBaselineOnly: true,
      };
    }

    // Case 3: Missing, invalid, or hash-mismatched content without baseline
    // Never slice newer or unrelated content with an outdated byte range!
    return {
      fullText: null,
      before: '',
      highlighted: '',
      after: '',
      hasHighlight: false,
      isBaselineOnly: false,
    };
  }, [source, analysisState.analysis, effectiveStatus, baseline?.text]);

  return (
    <section
      className="panel source-viewer-panel"
      data-testid="source-viewer-panel"
      aria-label="Source Viewer"
    >
      <div className="panel-header">
        <div className="panel-title">
          <FileCode size={16} />
          <span>Source Viewer</span>
          {source && (
            <span className="source-file-badge" data-testid="source-file-badge">
              {source.path}
            </span>
          )}
          {source && (
            <span
              className={`status-badge status-${effectiveStatus}`}
              data-testid="source-status-badge"
            >
              {effectiveStatus}
            </span>
          )}
          {selectedNode && (
            <span
              className={`provenance-badge provenance-${provenance}`}
              data-testid="source-provenance-badge"
            >
              {provenance}
            </span>
          )}
        </div>
      </div>

      <div className="panel-content source-content">
        {selectedNode ? (
          source ? (
            <div className="source-bound-view" data-testid="source-bound-view">
              <div className="source-meta-bar" data-testid="source-meta-bar">
                <div className="source-meta-item" data-testid="source-meta-file">
                  <MapPin size={14} />
                  <span>
                    <strong>File:</strong> {`${source.path} : line ${source.line}`}
                  </span>
                </div>
                {source.symbol && (
                  <div className="source-meta-item" data-testid="source-meta-symbol">
                    <span>
                      <strong>Symbol:</strong> <code>{source.symbol}</code>
                    </span>
                  </div>
                )}
                <div className="source-meta-item" data-testid="source-meta-hash">
                  <Hash size={14} />
                  <span>
                    <strong>Hash:</strong> <code title={source.hash}>{source.hash.length > 16 ? source.hash.slice(0, 10) + '…' : source.hash}</code>
                  </span>
                </div>
                <div className="source-meta-item" data-testid="source-meta-revision">
                  <GitBranch size={14} />
                  <span>
                    <strong>Revision:</strong> <code>{source.revision}</code>
                  </span>
                </div>
                <div className="source-meta-item" data-testid="source-meta-provenance">
                  {provenance === 'ai' ? <Cpu size={14} /> : <Layers size={14} />}
                  <span>
                    <strong>Provenance:</strong> <span className={`provenance-tag provenance-${provenance}`}>{provenance}</span>
                  </span>
                </div>
                {policy && (
                  <div className="source-meta-item" data-testid="source-meta-policy">
                    <Shield size={14} />
                    <span>
                      <strong>Policy:</strong> <code>{policy}</code>
                    </span>
                  </div>
                )}
              </div>

              {provenance === 'ai' && (
                <div className="ai-notice-banner" data-testid="ai-notice-banner">
                  <Cpu size={14} />
                  <span>AI-inferred interpretation: not compiler-verified evidence.</span>
                </div>
              )}

              {isStale && (
                <div className="source-stale-banner" data-testid="source-stale-banner">
                  <AlertTriangle size={14} />
                  <span>
                    <strong>Stale Evidence:</strong> {statusMessage || `Captured revision ${source.revision} is outdated.`}
                  </span>
                </div>
              )}

              {isMissing && (
                <div className="source-missing-banner" data-testid="source-missing-banner">
                  <AlertCircle size={14} />
                  <span>
                    <strong>Source File Unavailable:</strong> {statusMessage || `File ${source.path} not found in workspace.`}
                  </span>
                </div>
              )}

              {isInvalid && (
                <div className="source-invalid-banner" data-testid="source-invalid-banner">
                  <AlertCircle size={14} />
                  <span>
                    <strong>Invalid Evidence:</strong> {statusMessage || 'Source content hash does not match captured file.'}
                  </span>
                </div>
              )}

              <div className="source-code-container">
                <div className="code-header">
                  <span>Range: bytes {source.start} – {source.end}</span>
                  {policy && (
                    <span className="code-policy-notice">Policy: {policy}</span>
                  )}
                </div>
                <pre className="source-code-block" data-testid="source-code-block">
                  <code>
                    {hasHighlight ? (
                      <>
                        {before}
                        <mark
                          className={`source-range-highlight ${isStale ? 'stale-highlight' : ''} ${isBaselineOnly ? 'source-baseline-highlight' : ''}`}
                          data-testid="source-range-highlight"
                        >
                          {highlighted}
                        </mark>
                        {after}
                      </>
                    ) : (
                      `// Source binding: ${source.path}#L${source.line}\n// Range: [${source.start}, ${source.end}]\n// Hash: ${source.hash}\n// Analysis revision: ${source.revision}\n// Status: ${effectiveStatus} (${statusMessage || 'Outdated binding'})\n\n// Content highlight withheld: source file modified or unavailable.\n// Run synchronization to capture fresh evidence for current source.`
                    )}
                  </code>
                </pre>

                {hasHighlight && highlighted && (
                  <div className="source-exact-range-view" data-testid="source-exact-range-view">
                    <div className="exact-range-header">
                      <span>Captured Range Content ({source.symbol || selectedNode.name}):</span>
                    </div>
                    <pre className="source-range-snippet" data-testid="source-range-snippet">
                      <code data-testid="source-range-text">{highlighted}</code>
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="source-unbound-view" data-testid="source-unbound-view">
              <AlertCircle size={24} className="unbound-icon" />
              <h4>No Source Binding</h4>
              <p>
                The selected element <strong>{selectedNode.name}</strong> is an intended architecture specification.
              </p>
              <span className="unbound-hint">
                It has not yet been extracted from or bound to implemented source code on disk.
              </span>
            </div>
          )
        ) : (
          <div className="source-overview" data-testid="source-overview">
            <Folder size={24} className="overview-icon" />
            <h4>Project Source Status</h4>
            <p className="source-project-root">
              <strong>Workspace Root:</strong> <code>{project?.root || 'No project root directory bound'}</code>
            </p>
            {analysisState.analysis ? (
              <div className="analysis-summary-card">
                <div>Eligible files: <strong>{analysisState.analysis.quality.eligibleFiles}</strong></div>
                <div>Analyzed files: <strong>{analysisState.analysis.quality.analyzedFiles}</strong></div>
                <div>Diagnostics: <strong>{analysisState.analysis.quality.diagnostics.length}</strong></div>
                <div>Status: <strong className={`status-badge status-${analysisState.status}`}>{analysisState.status}</strong></div>
              </div>
            ) : (
              <p className="source-tip">
                Select an element with source evidence to view its bound file location and analysis metadata.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
