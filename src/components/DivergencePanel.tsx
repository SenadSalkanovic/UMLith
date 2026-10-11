import React, { useState, useMemo } from 'react';
import type {
  DivergenceReport,
  DivergenceItem,
  DivergenceCategory,
  Project,
} from '../../shared/model';
import {
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle2,
  FileCode,
  Layers,
  Code,
  Clock,
  GitCommit,
  Shield,
  Search,
  Filter,
  Eye,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

export interface DivergencePanelProps {
  report: DivergenceReport | null | undefined;
  project?: Project | null;
  onSelectNode?: (nodeId: string) => void;
  onRefresh?: () => void;
}

export const DivergencePanel: React.FC<DivergencePanelProps> = ({
  report,
  project,
  onSelectNode,
  onRefresh,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredItems = useMemo(() => {
    if (!report?.items) return [];
    return report.items.filter(item => {
      if (selectedCategory !== 'all' && item.category !== selectedCategory) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = item.nodeName?.toLowerCase().includes(q) ?? false;
        const matchMsg = item.message.toLowerCase().includes(q);
        const matchPath = item.evidence?.path?.toLowerCase().includes(q) ?? false;
        const matchKind = item.kind.toLowerCase().includes(q);
        return matchName || matchMsg || matchPath || matchKind;
      }
      return true;
    });
  }, [report, selectedCategory, searchQuery]);

  if (!report) {
    return (
      <div className="divergence-panel p-4" data-testid="divergence-panel">
        <div className="divergence-empty-state text-center p-6 bg-card border rounded" data-testid="divergence-empty-state">
          <Clock className="mx-auto mb-2 text-muted" size={24} />
          <h4 className="font-medium text-base mb-1">No Divergence Report Available</h4>
          <p className="text-sm text-muted">
            Run synchronization or start the watcher to continuously report architectural drift and frozen violations.
          </p>
        </div>
      </div>
    );
  }

  const { summary } = report;

  return (
    <div className="divergence-panel flex flex-col gap-4 p-4" data-testid="divergence-panel">
      {/* Header and Revisions Badge */}
      <div className="divergence-header flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Layers size={18} className="text-primary" />
            <span>Architecture & Protection Divergence</span>
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Continuous comparison between human specification intent and captured code structure.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="px-2 py-1 bg-muted rounded font-mono"
            data-testid="divergence-revision-badge"
          >
            {`Revision: ${report.revision ? report.revision.slice(0, 10) : 'none'}`}
          </span>
          <span
            className="px-2 py-1 bg-muted rounded font-mono"
            data-testid="divergence-sequence-badge"
          >
            {`Sequence: #${report.sequence}`}
          </span>
          <span
            className={`px-2 py-1 rounded font-medium ${
              report.status === 'current'
                ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                : report.status === 'stale'
                ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                : 'bg-blue-500/10 text-blue-500 border border-blue-500/20'
            }`}
            data-testid="divergence-status-badge"
          >
            {report.status.toUpperCase()}
          </span>
          {onRefresh && (
            <button
              type="button"
              className="px-2 py-1 bg-card hover:bg-muted border rounded text-xs"
              onClick={onRefresh}
              data-testid="divergence-refresh-btn"
            >
              Refresh
            </button>
          )}
        </div>
      </div>

      {/* Baseline Preservation Alert */}
      <div
        className="baseline-retention-notice p-3 bg-blue-500/5 border border-blue-500/20 rounded flex items-start gap-2 text-xs text-blue-400"
        data-testid="baseline-retention-notice"
      >
        <Shield size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div>
          <strong className="font-semibold">Baseline Integrity Preserved:</strong> Synchronization never resets
          protected baselines or overwrites human-owned specifications. External edits to frozen code raise violations
          while the original baseline remains intact.
        </div>
      </div>

      {/* Blocking Violations Warning Banner */}
      {summary.hasBlockingViolations && (
        <div
          className="blocking-violations-banner p-3 bg-red-500/10 border border-red-500/30 rounded flex items-start gap-2 text-xs text-red-400"
          data-testid="blocking-violations-banner"
        >
          <ShieldAlert size={18} className="shrink-0 text-red-500 mt-0.5" />
          <div>
            <strong className="font-semibold block text-sm mb-0.5">Blocking Protection Violations Detected</strong>
            External edits violate frozen boundaries ({summary.protectionViolations} item{summary.protectionViolations === 1 ? '' : 's'}).
            Proposed task application and candidate verification are blocked until human review resolves or reverts these changes.
          </div>
        </div>
      )}

      {/* Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs" data-testid="divergence-metrics-summary">
        <div className="metric-card p-3 bg-card border rounded flex flex-col">
          <span className="text-muted mb-1">Total Divergence</span>
          <span className="text-xl font-bold" data-testid="divergence-total-count">
            {summary.totalDrift}
          </span>
        </div>

        <div
          className={`metric-card p-3 border rounded flex flex-col ${
            summary.protectionViolations > 0 ? 'bg-red-500/5 border-red-500/30 text-red-400' : 'bg-card'
          }`}
        >
          <span className="text-muted mb-1 flex items-center gap-1">
            <ShieldAlert size={13} className={summary.protectionViolations > 0 ? 'text-red-500' : ''} />
            <span>Protection Violations</span>
          </span>
          <span className="text-xl font-bold" data-testid="divergence-violations-count">
            {summary.protectionViolations}
          </span>
        </div>

        <div className="metric-card p-3 bg-card border rounded flex flex-col">
          <span className="text-muted mb-1 flex items-center gap-1">
            <Code size={13} className="text-blue-400" />
            <span>Structural Drift</span>
          </span>
          <span className="text-xl font-bold" data-testid="divergence-structural-count">
            {summary.structuralDriftCount}
          </span>
        </div>

        <div className="metric-card p-3 bg-card border rounded flex flex-col">
          <span className="text-muted mb-1 flex items-center gap-1">
            <Info size={13} className="text-purple-400" />
            <span>Uncertain Intent</span>
          </span>
          <span className="text-xl font-bold" data-testid="divergence-uncertain-count">
            {summary.uncertainCount}
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-xs" data-testid="divergence-category-filters">
          <button
            type="button"
            className={`px-2.5 py-1 rounded border transition-colors ${
              selectedCategory === 'all'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted hover:text-foreground border-border'
            }`}
            onClick={() => setSelectedCategory('all')}
            data-testid="filter-all"
          >
            All ({summary.totalDrift})
          </button>
          <button
            type="button"
            className={`px-2.5 py-1 rounded border transition-colors ${
              selectedCategory === 'protection-violation'
                ? 'bg-red-600 text-white border-red-600'
                : 'bg-card text-muted hover:text-foreground border-border'
            }`}
            onClick={() => setSelectedCategory('protection-violation')}
            data-testid="filter-violations"
          >
            Violations ({summary.protectionViolations})
          </button>
          <button
            type="button"
            className={`px-2.5 py-1 rounded border transition-colors ${
              selectedCategory === 'structural-drift'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-card text-muted hover:text-foreground border-border'
            }`}
            onClick={() => setSelectedCategory('structural-drift')}
            data-testid="filter-structural"
          >
            Structural Drift ({summary.structuralDriftCount})
          </button>
          <button
            type="button"
            className={`px-2.5 py-1 rounded border transition-colors ${
              selectedCategory === 'uncertainty'
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-card text-muted hover:text-foreground border-border'
            }`}
            onClick={() => setSelectedCategory('uncertainty')}
            data-testid="filter-uncertain"
          >
            Uncertain Intent ({summary.uncertainCount})
          </button>
        </div>

        <div className="relative">
          <input
            type="text"
            className="pl-7 pr-3 py-1 text-xs bg-card border rounded w-48 focus:outline-none focus:border-primary"
            placeholder="Search divergence..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            data-testid="divergence-search-input"
          />
          <Search size={12} className="absolute left-2 top-2 text-muted" />
        </div>
      </div>

      {/* Items List */}
      <div className="divergence-items-list flex flex-col gap-2" data-testid="divergence-items-list">
        {filteredItems.length === 0 ? (
          <div className="divergence-empty-state text-center p-8 bg-card border rounded" data-testid="divergence-empty-state">
            <CheckCircle2 className="mx-auto mb-2 text-emerald-500" size={28} />
            <h4 className="font-medium text-sm mb-1">
              {summary.totalDrift === 0
                ? 'No Divergence Detected'
                : 'No Divergence Items Match Filter'}
            </h4>
            <p className="text-xs text-muted max-w-md mx-auto">
              {summary.totalDrift === 0
                ? 'Implemented structure aligns with intended architecture specification. All frozen baselines are intact.'
                : 'Try selecting a different filter category or clearing search parameters.'}
            </p>
          </div>
        ) : (
          filteredItems.map(item => {
            const isExpanded = expandedItems.has(item.id);
            const isViolation = item.category === 'protection-violation';
            const isUncertain = item.category === 'uncertainty';

            return (
              <div
                key={item.id}
                className={`divergence-item-card border rounded p-3 bg-card transition-all ${
                  isViolation
                    ? 'border-red-500/40 bg-red-500/5'
                    : isUncertain
                    ? 'border-purple-500/30'
                    : 'border-border'
                }`}
                data-testid={`divergence-item-${item.id}`}
              >
                {/* Item Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1">
                    <div className="mt-0.5 shrink-0">
                      {isViolation ? (
                        <ShieldAlert size={16} className="text-red-500" />
                      ) : isUncertain ? (
                        <Info size={16} className="text-purple-400" />
                      ) : (
                        <AlertTriangle size={16} className="text-amber-400" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase ${
                            isViolation
                              ? 'bg-red-500/20 text-red-400'
                              : isUncertain
                              ? 'bg-purple-500/20 text-purple-300'
                              : 'bg-blue-500/20 text-blue-400'
                          }`}
                          data-testid={`badge-kind-${item.id}`}
                        >
                          {item.kind.replace(/-/g, ' ')}
                        </span>

                        {/* Defect Status Indicator */}
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                            item.isDeterministicDefect
                              ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                              : 'bg-muted text-muted-foreground'
                          }`}
                          data-testid={`badge-defect-${item.id}`}
                        >
                          {item.isDeterministicDefect
                            ? 'Deterministic Protection Defect'
                            : 'Non-Defect Drift / Intent Observation'}
                        </span>

                        {item.nodeName && (
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {item.nodeName}
                          </span>
                        )}

                        {item.nodeKind && (
                          <span className="text-[10px] px-1.5 py-0.2 bg-muted/60 text-muted-foreground rounded">
                            {item.nodeKind}
                          </span>
                        )}

                        {item.policy && (
                          <span className="text-[10px] px-1.5 py-0.2 bg-muted/60 text-muted-foreground rounded">
                            {item.policy}
                          </span>
                        )}
                      </div>

                      <p className="text-xs font-medium text-foreground">{item.message}</p>
                      {item.details && (
                        <p className="text-xs text-muted mt-0.5 leading-relaxed">{item.details}</p>
                      )}
                    </div>
                  </div>

                  {/* Actions / Toggle Details */}
                  <div className="flex items-center gap-1 shrink-0">
                    {item.nodeId && onSelectNode && (
                      <button
                        type="button"
                        className="p-1 hover:bg-muted rounded text-muted hover:text-foreground text-xs flex items-center gap-1"
                        onClick={() => onSelectNode(item.nodeId!)}
                        title="Locate specification node"
                      >
                        <Eye size={13} />
                      </button>
                    )}
                    {item.evidence && (
                      <button
                        type="button"
                        className="p-1 hover:bg-muted rounded text-muted hover:text-foreground"
                        onClick={() => toggleExpand(item.id)}
                        data-testid={`btn-toggle-evidence-${item.id}`}
                        title="Toggle evidence preview"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Evidence Section (Expandable or default open for violations) */}
                {item.evidence && (isExpanded || isViolation) && (
                  <div
                    className="evidence-section mt-3 pt-2.5 border-t border-border/60 text-xs bg-muted/20 p-2.5 rounded"
                    data-testid={`evidence-${item.id}`}
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-muted mb-2 font-mono text-[11px]">
                      <div>
                        <strong>File:</strong>{' '}
                        <span className="text-foreground">{item.evidence.path}</span>
                        {item.evidence.line !== undefined && (
                          <span className="ml-1 text-muted">:{item.evidence.line}</span>
                        )}
                      </div>
                      {item.evidence.revision && (
                        <div>
                          <strong>Revision:</strong>{' '}
                          <span className="text-foreground">{item.evidence.revision.slice(0, 10)}</span>
                        </div>
                      )}
                      {item.evidence.hash && (
                        <div>
                          <strong>Hash:</strong>{' '}
                          <span className="text-foreground">{item.evidence.hash.slice(0, 10)}</span>
                        </div>
                      )}
                      {item.evidence.symbol && (
                        <div>
                          <strong>Symbol:</strong>{' '}
                          <span className="text-foreground">{item.evidence.symbol}</span>
                        </div>
                      )}
                    </div>

                    {/* Expected vs Actual Diff Preview */}
                    {(item.evidence.expectedText !== undefined || item.evidence.expectedContract !== undefined) && (
                      <div className="comparison-preview grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                        <div className="expected-pane bg-card border rounded p-2">
                          <span className="text-[10px] font-semibold text-emerald-400 block mb-1">
                            INTENDED BASELINE
                          </span>
                          <pre
                            className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-muted-foreground"
                            data-testid={`evidence-expected-${item.id}`}
                          >
                            {item.evidence.expectedText ?? item.evidence.expectedContract}
                          </pre>
                        </div>
                        <div className="actual-pane bg-card border rounded p-2">
                          <span className="text-[10px] font-semibold text-red-400 block mb-1">
                            IMPLEMENTED SOURCE
                          </span>
                          <pre
                            className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-muted-foreground"
                            data-testid={`evidence-actual-${item.id}`}
                          >
                            {item.evidence.actualText ?? item.evidence.actualContract}
                          </pre>
                        </div>
                      </div>
                    )}

                    {/* Code Snippet */}
                    {item.evidence.snippet && !item.evidence.expectedText && !item.evidence.expectedContract && (
                      <div className="snippet-preview mt-2 bg-card border rounded p-2">
                        <span className="text-[10px] font-semibold text-muted block mb-1">
                          SOURCE EVIDENCE
                        </span>
                        <pre
                          className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-muted-foreground"
                          data-testid={`evidence-snippet-${item.id}`}
                        >
                          {item.evidence.snippet}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
