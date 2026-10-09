import React from 'react';
import type { Graph, Project } from '../../shared/model';
import type { AnalysisState, ViewState } from '../types';
import { FileCode, Hash, GitBranch, MapPin, AlertCircle, Folder } from 'lucide-react';

interface SourceViewerProps {
  project: Project | null;
  graph: Graph | null;
  analysisState: AnalysisState;
  viewState: ViewState;
}

export const SourceViewer: React.FC<SourceViewerProps> = ({
  project,
  graph,
  analysisState,
  viewState,
}) => {
  const selectedNode = viewState.selectedId
    ? graph?.nodes.find(n => n.id === viewState.selectedId) || null
    : null;

  const source = selectedNode?.source;
  const baseline = selectedNode?.baseline;

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
          {source && <span className="source-file-badge">{source.path}</span>}
        </div>
      </div>

      <div className="panel-content source-content">
        {selectedNode ? (
          source ? (
            <div className="source-bound-view" data-testid="source-bound-view">
              <div className="source-meta-bar">
                <div className="source-meta-item">
                  <MapPin size={14} />
                  <span>
                    <strong>File:</strong> {`${source.path} : line ${source.line}`}
                  </span>
                </div>
                {source.symbol && (
                  <div className="source-meta-item">
                    <span>
                      <strong>Symbol:</strong> <code>{source.symbol}</code>
                    </span>
                  </div>
                )}
                <div className="source-meta-item">
                  <Hash size={14} />
                  <span>
                    <strong>Hash:</strong> <code title={source.hash}>{source.hash.slice(0, 10)}…</code>
                  </span>
                </div>
                <div className="source-meta-item">
                  <GitBranch size={14} />
                  <span>
                    <strong>Revision:</strong> {source.revision}
                  </span>
                </div>
              </div>

              <div className="source-code-container">
                <div className="code-header">
                  <span>Range: bytes {source.start} – {source.end}</span>
                  {selectedNode.policy && (
                    <span className="code-policy-notice">Policy: {selectedNode.policy}</span>
                  )}
                </div>
                <pre className="source-code-block" data-testid="source-code-block">
                  <code>
                    {baseline?.text
                      ? baseline.text
                      : `// Source binding: ${source.path}#L${source.line}\n// Range: [${source.start}, ${source.end}]\n// Hash: ${source.hash}\n// Analysis revision: ${source.revision}\n\n// Intended symbol '${source.symbol || selectedNode.name}' extracted from source.`}
                  </code>
                </pre>
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
