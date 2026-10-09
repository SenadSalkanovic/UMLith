import React from 'react';
import type { Graph, Project } from '../../shared/model';
import type { AnalysisState, SyncStatus } from '../types';
import {
  CheckSquare,
  Shield,
  Clock,
  CheckCircle2,
  AlertTriangle,
  GitPullRequest,
  RefreshCw,
  FileCode,
} from 'lucide-react';

interface ReviewPanelProps {
  project: Project | null;
  graph: Graph | null;
  analysisState: AnalysisState;
}

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  project,
  graph,
  analysisState,
}) => {
  const nodes = graph?.nodes || [];

  // Tally policies
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
        <span className={`review-status-badge status-${analysisState.status}`}>
          {analysisState.status.toUpperCase()}
        </span>
      </div>

      <div className="panel-content review-content">
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
        </div>

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
          <p className="no-proposals-text">No pending specification or code proposals awaiting review.</p>
        </div>

        {analysisState.analysis && analysisState.analysis.graph.nodes.length > 0 && (
          <div className="review-card" data-testid="imported-structure-card">
            <div className="review-card-header">
              <FileCode size={14} />
              <span>Imported Structure (Implemented Model)</span>
            </div>
            <div className="imported-structure-info">
              <p className="imported-structure-desc">
                Imported code populates the <strong>implemented graph</strong> (<strong data-testid="implemented-count">{analysisState.analysis.graph.nodes.length}</strong> node(s)).
                {' '}{project?.specification.nodes.length
                  ? 'The intended specification is maintained separately'
                  : 'The intended specification remains unadopted'} (Revision {project?.specRevision ?? 0}) under human control (R03).
              </p>
              <div className="imported-node-chips" data-testid="imported-node-chips">
                {analysisState.analysis.graph.nodes.map(node => (
                  <span key={node.id} className="imported-node-chip" title={`${node.kind}: ${node.name}`} data-testid={`imported-node-${node.id}`}>
                    <span className="chip-kind">{node.kind}</span>
                    <span className="chip-name">{node.name}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
