import React, { useMemo } from 'react';
import type {
  Graph,
  ProgramNode,
  ProgramEdge,
  Project,
  Analysis,
  Source,
  Quality,
} from '../../shared/model';
import type { ViewState, SyncStatus } from '../types';
import {
  Layers,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  FileCode,
  User,
  Shield,
  ShieldAlert,
  Info,
  Hash,
  MapPin,
  GitBranch,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

export interface ModelContextProps {
  graphContext: 'intended' | 'implemented';
  onGraphContextChange?: (context: 'intended' | 'implemented') => void;
  project?: Project | null;
  specification?: Graph | null;
  analysis?: Analysis | null;
  analysisStatus?: SyncStatus;
  selectedNode?: ProgramNode | null;
  selectedEdge?: ProgramEdge | null;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  onViewSource?: (source: Source) => void;
  compact?: boolean;
  showLimitsNotice?: boolean;
  showOwnership?: boolean;
  showStats?: boolean;
  className?: string;
}

export interface ModelContextBarProps {
  graphContext: 'intended' | 'implemented';
  onGraphContextChange?: (context: 'intended' | 'implemented') => void;
  project?: Project | null;
  specification?: Graph | null;
  analysis?: Analysis | null;
  analysisStatus?: SyncStatus;
  className?: string;
}

export interface ProvenanceBadgeProps {
  provenance?: 'human' | 'extracted' | 'ai';
  uncertain?: boolean;
  isOpaque?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
}

export interface ProvenanceStatementCardProps {
  label: string;
  provenance: 'human' | 'extracted' | 'ai';
  kind?: string;
  description?: string;
  source?: Source;
  uncertain?: boolean;
  isOpaque?: boolean;
  onViewSource?: (source: Source) => void;
  className?: string;
}

export interface OpaqueFindingCardProps {
  node: ProgramNode;
  onViewSource?: (node: ProgramNode) => void;
  className?: string;
}

export interface AnalysisLimitsNoticeProps {
  quality?: Quality;
  compact?: boolean;
  className?: string;
}

export interface UncertainRelationshipCardProps {
  edge: ProgramEdge;
  sourceName?: string;
  targetName?: string;
  className?: string;
}

/**
 * Pure utility function to switch model contexts while strictly preserving graph immutability.
 * Context changes are strictly view-level transitions and must NEVER mutate specification or analysis.
 */
export function switchGraphContext(
  targetContext: 'intended' | 'implemented',
  prevViewState: ViewState,
  specification: Graph | null,
  analysis: Analysis | null
): {
  nextViewState: ViewState;
  specificationMutated: boolean;
  analysisMutated: boolean;
} {
  const specBeforeJson = specification ? JSON.stringify(specification) : null;
  const analysisBeforeJson = analysis ? JSON.stringify(analysis) : null;

  const targetGraph = targetContext === 'implemented'
    ? (analysis?.graph || null)
    : specification;

  const targetNodes = targetGraph?.nodes || [];
  const targetEdges = targetGraph?.edges || [];

  const selectedNodeStillExists = prevViewState.selectedId
    ? targetNodes.some(n => n.id === prevViewState.selectedId)
    : false;
  const selectedEdgeStillExists = prevViewState.selectedId
    ? targetEdges.some(e => e.id === prevViewState.selectedId)
    : false;
  const selectedStillExists = prevViewState.selectedType === 'node'
    ? selectedNodeStillExists
    : prevViewState.selectedType === 'edge'
    ? selectedEdgeStillExists
    : false;

  const scopeStillExists = prevViewState.activeScope
    ? targetNodes.some(n => n.id === prevViewState.activeScope)
    : false;

  const nextViewState: ViewState = {
    ...prevViewState,
    graphContext: targetContext,
    selectedId: selectedStillExists ? prevViewState.selectedId : null,
    selectedType: selectedStillExists ? prevViewState.selectedType : null,
    activeScope: scopeStillExists ? prevViewState.activeScope : null,
  };

  const specAfterJson = specification ? JSON.stringify(specification) : null;
  const analysisAfterJson = analysis ? JSON.stringify(analysis) : null;

  const specificationMutated = specBeforeJson !== specAfterJson;
  const analysisMutated = analysisBeforeJson !== analysisAfterJson;

  return {
    nextViewState,
    specificationMutated,
    analysisMutated,
  };
}

/**
 * Visual badge distinguishing human, extracted, AI-inferred, and opaque logic.
 * Enforces acceptance criterion: Inferred claims cannot resemble verified compiler facts.
 */
export const ProvenanceBadge: React.FC<ProvenanceBadgeProps> = ({
  provenance = 'human',
  uncertain = false,
  isOpaque = false,
  className = '',
  size = 'md',
  showIcon = true,
}) => {
  if (isOpaque) {
    return (
      <span
        className={`provenance-badge provenance-opaque prov-opaque prov-size-${size} ${className}`}
        data-testid="provenance-badge-opaque"
        title="Opaque logic: unsupported constructs retained with source access"
      >
        {showIcon && <ShieldAlert size={size === 'sm' ? 10 : 12} className="badge-icon" />}
        <span>Opaque Logic (Source-backed)</span>
      </span>
    );
  }

  if (provenance === 'ai') {
    return (
      <span
        className={`provenance-badge provenance-ai prov-ai ai-inferred-badge prov-size-${size} ${uncertain ? 'is-uncertain' : ''} ${className}`}
        data-testid="provenance-badge-ai"
        title="AI-inferred interpretation: unverified suggestion, not compiler evidence"
      >
        {showIcon && <Cpu size={size === 'sm' ? 10 : 12} className="badge-icon icon-ai" />}
        <span>AI Inferred (Uncertain)</span>
      </span>
    );
  }

  if (provenance === 'extracted') {
    return (
      <span
        className={`provenance-badge provenance-extracted prov-extracted prov-size-${size} ${className}`}
        data-testid="provenance-badge-extracted"
        title="Extracted fact: compiler-verified AST structure grounded in source code"
      >
        {showIcon && <CheckCircle2 size={size === 'sm' ? 10 : 12} className="badge-icon icon-extracted" />}
        <span>Extracted Fact (Compiler AST)</span>
      </span>
    );
  }

  return (
    <span
      className={`provenance-badge provenance-human prov-human prov-size-${size} ${className}`}
      data-testid="provenance-badge-human"
      title="Human specification: human-authored and controlled design intent"
    >
      {showIcon && <User size={size === 'sm' ? 10 : 12} className="badge-icon icon-human" />}
      <span>Human Specification</span>
    </span>
  );
};

/**
 * Notice banner explaining limits of structural analysis without implying runtime or business-intent proof.
 * Fulfills R09 and R39.
 */
export const AnalysisLimitsNotice: React.FC<AnalysisLimitsNoticeProps> = ({
  quality,
  compact = false,
  className = '',
}) => {
  return (
    <div
      className={`analysis-limits-notice ${compact ? 'is-compact' : ''} ${className}`}
      data-testid="analysis-limits-notice"
      role="region"
      aria-label="Structural Analysis Limits"
    >
      <div className="limits-header">
        <Info size={14} className="limits-icon" />
        <strong>Limits of Structural Analysis</strong>
      </div>
      <p className="limits-text" data-testid="limits-explanation">
        Structural analysis inspects static syntax, AST declarations, and schema definitions.
        File coverage or AST extraction does <strong>not</strong> prove behavioral completeness,
        runtime correctness, or business intent. Tests and human review are required.
      </p>

      {quality && !compact && (
        <div className="limits-quality-grid" data-testid="limits-quality-grid">
          <div className="quality-item">
            <span className="q-label">Analyzed Files:</span>
            <span className="q-val" data-testid="q-analyzed-files">
              {`${quality.analyzedFiles} / ${quality.eligibleFiles}`}
            </span>
          </div>
          <div className="quality-item">
            <span className="q-label">Diagnostics:</span>
            <span className="q-val" data-testid="q-diagnostics-count">
              {quality.diagnostics.length}
            </span>
          </div>
          <div className="quality-item">
            <span className="q-label">Unresolved References:</span>
            <span className="q-val" data-testid="q-unresolved-refs">
              {quality.unresolvedReferences}
            </span>
          </div>
          <div className="quality-item">
            <span className="q-label">AI Inferred Items:</span>
            <span className="q-val" data-testid="q-inferred-items">
              {quality.inferredItems}
            </span>
          </div>
          <div className="quality-item">
            <span className="q-label">Unsupported Constructs:</span>
            <span className="q-val" data-testid="q-unsupported-constructs">
              {quality.unsupportedConstructs}
            </span>
          </div>
        </div>
      )}

      <div className="file-coverage-caveat" data-testid="file-coverage-caveat">
        <AlertTriangle size={12} />
        <span>File coverage must not be presented as proof of behavioral completeness (R09).</span>
      </div>
    </div>
  );
};

/**
 * Card rendering an opaque node finding while explicitly retaining and exposing source access.
 * Fulfills Acceptance Criterion 2: Opaque findings retain source access.
 */
export const OpaqueFindingCard: React.FC<OpaqueFindingCardProps> = ({
  node,
  onViewSource,
  className = '',
}) => {
  const source = node.source;

  return (
    <div
      className={`opaque-finding-card ${className}`}
      data-testid="opaque-finding-card"
    >
      <div className="opaque-header">
        <div className="opaque-title-row">
          <ProvenanceBadge isOpaque={true} />
          <h4 className="opaque-node-name" data-testid="opaque-node-name">
            {node.name}
          </h4>
        </div>
        <span className="opaque-kind-badge">Kind: {node.kind}</span>
      </div>

      <p className="opaque-explanation" data-testid="opaque-explanation">
        Unsupported or complex logic is preserved as a source-backed opaque node without
        loss of source context (R08).
      </p>

      {source ? (
        <div className="opaque-source-access" data-testid="opaque-source-access">
          <div className="source-meta-row">
            <div className="source-meta-cell">
              <MapPin size={12} />
              <span className="meta-label">Path:</span>
              <code data-testid="opaque-source-path">{source.path}</code>
            </div>
            <div className="source-meta-cell">
              <span className="meta-label">Line:</span>
              <span data-testid="opaque-source-line">{source.line}</span>
            </div>
          </div>
          <div className="source-meta-row">
            <div className="source-meta-cell">
              <span className="meta-label">Byte Range:</span>
              <span data-testid="opaque-source-range">
                {`${source.start} – ${source.end}`}
              </span>
            </div>
            <div className="source-meta-cell">
              <Hash size={12} />
              <span className="meta-label">Hash:</span>
              <code data-testid="opaque-source-hash" title={source.hash}>
                {source.hash}
              </code>
            </div>
            <div className="source-meta-cell">
              <GitBranch size={12} />
              <span className="meta-label">Revision:</span>
              <span data-testid="opaque-source-revision">{source.revision}</span>
            </div>
          </div>

          {onViewSource && (
            <button
              type="button"
              className="btn btn-xs btn-outline opaque-source-btn"
              onClick={() => onViewSource(node)}
              data-testid="opaque-inspect-source-btn"
              title={`Inspect source for ${node.name}`}
            >
              <FileCode size={12} />
              <span>Inspect Source</span>
            </button>
          )}
        </div>
      ) : (
        <div className="alert alert-danger opaque-missing-source" data-testid="opaque-missing-source">
          <AlertTriangle size={12} />
          <span>Opaque node is missing mandatory source evidence binding!</span>
        </div>
      )}
    </div>
  );
};

/**
 * Card representing a statement or finding with clear ownership and provenance.
 * Renders identical labels differently across human, extracted, and AI provenance,
 * enforcing that AI claims never resemble verified compiler facts.
 */
export const ProvenanceStatementCard: React.FC<ProvenanceStatementCardProps> = ({
  label,
  provenance,
  kind = 'concept',
  description,
  source,
  uncertain = false,
  isOpaque = false,
  onViewSource,
  className = '',
}) => {
  const isAi = provenance === 'ai';
  const isExtracted = provenance === 'extracted';
  const isHuman = provenance === 'human';

  const cardTestId = isAi
    ? 'claim-ai'
    : isExtracted
    ? 'claim-extracted'
    : isOpaque
    ? 'claim-opaque'
    : 'claim-human';

  const cardClass = isAi
    ? 'card-provenance-ai ai-inferred-card'
    : isExtracted
    ? 'card-provenance-extracted compiler-fact-card'
    : isOpaque
    ? 'card-provenance-opaque opaque-logic-card'
    : 'card-provenance-human specification-card';

  return (
    <div
      className={`provenance-statement-card ${cardClass} ${className}`}
      data-testid={cardTestId}
    >
      <div className="statement-header">
        <div className="statement-title-group">
          <span className="statement-label" data-testid="statement-label">
            {label}
          </span>
          <span className="statement-kind">({kind})</span>
        </div>
        <ProvenanceBadge
          provenance={provenance}
          uncertain={uncertain || isAi}
          isOpaque={isOpaque}
        />
      </div>

      <div className="statement-owner-row" data-testid={`statement-owner-${provenance}`}>
        <span className="owner-title">Statement Ownership:</span>
        <strong className="owner-name" data-testid={`owner-name-${provenance}`}>
          {isHuman && 'Human Architect (Specification Owner)'}
          {isExtracted && 'TypeScript / Prisma Compiler (Verified AST Evidence)'}
          {isAi && 'AI Inference Suggestion (Heuristic Interpretation)'}
          {isOpaque && 'Source-backed Compiler Finding (Opaque Construct)'}
        </strong>
      </div>

      {description && (
        <p className="statement-desc" data-testid="statement-description">
          {description}
        </p>
      )}

      {/* AI Provenance Notice: Unmistakably distinct from compiler facts */}
      {isAi && (
        <div className="ai-notice-banner" data-testid="ai-notice-banner">
          <Cpu size={14} className="icon-ai" />
          <span>AI-inferred interpretation: not compiler-verified evidence.</span>
        </div>
      )}

      {isAi && (
        <div className="ai-inferred-caveat" data-testid="ai-inferred-caveat">
          <AlertTriangle size={12} />
          <span>Inferred suggestion retains uncertainty; human review required before adoption.</span>
        </div>
      )}

      {/* Extracted Compiler Fact Evidence */}
      {isExtracted && source && (
        <div className="extracted-source-evidence" data-testid="extracted-source-evidence">
          <div className="evidence-header">
            <CheckCircle2 size={12} className="text-success" />
            <span>Grounded in verified compiler AST:</span>
          </div>
          <div className="evidence-details">
            <div>
              <span className="meta-label">Path:</span> <code data-testid="source-path">{source.path}</code>
            </div>
            <div>
              <span className="meta-label">Line:</span> <span data-testid="source-line">{source.line}</span>
            </div>
            <div>
              <span className="meta-label">Bytes:</span>{' '}
              <span data-testid="source-bytes">{`${source.start} – ${source.end}`}</span>
            </div>
            <div>
              <span className="meta-label">Hash:</span> <code data-testid="source-hash">{source.hash}</code>
            </div>
            <div>
              <span className="meta-label">Revision:</span>{' '}
              <span data-testid="source-revision">{source.revision}</span>
            </div>
          </div>
          {onViewSource && (
            <button
              type="button"
              className="btn btn-xs btn-outline mt-1"
              onClick={() => onViewSource(source)}
              data-testid="view-source-evidence-btn"
            >
              <FileCode size={12} />
              <span>View Source Evidence</span>
            </button>
          )}
        </div>
      )}

      {/* Human Specification Statement details */}
      {isHuman && (
        <div className="human-spec-details" data-testid="human-spec-details">
          <div className="spec-basis-row">
            <User size={12} className="text-primary" />
            <span>Authored directly or approved by human designer.</span>
          </div>
          <span className="spec-rule-note">
            Maintains business intent; protected from silent modification by automated code sync.
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Card representing an uncertain relationship between elements.
 */
export const UncertainRelationshipCard: React.FC<UncertainRelationshipCardProps> = ({
  edge,
  sourceName,
  targetName,
  className = '',
}) => {
  return (
    <div
      className={`uncertain-relationship-card ${className}`}
      data-testid="uncertain-relationship-card"
    >
      <div className="uncertain-header">
        <span className="uncertain-badge" data-testid="uncertain-badge">
          <AlertTriangle size={12} />
          <span>Uncertain Relationship</span>
        </span>
        <ProvenanceBadge provenance={edge.provenance} uncertain={true} />
      </div>

      <div className="uncertain-endpoints" data-testid="uncertain-endpoints">
        <span className="endpoint-node">{sourceName || edge.source}</span>
        <ArrowRight size={14} className="dashed-edge-arrow" />
        <span className="relationship-kind">({edge.kind})</span>
        <ArrowRight size={14} className="dashed-edge-arrow" />
        <span className="endpoint-node">{targetName || edge.target}</span>
      </div>

      {edge.label && (
        <div className="uncertain-label">
          <span>Label: {edge.label}</span>
        </div>
      )}

      <div className="ai-notice-banner" data-testid="ai-notice-banner">
        <Cpu size={14} />
        <span>
          {edge.provenance === 'ai'
            ? 'AI-inferred interpretation: not compiler-verified evidence. Must remain uncertain.'
            : 'Relationship is explicitly marked uncertain by human reviewer.'}
        </span>
      </div>
    </div>
  );
};

/**
 * Model Context Bar: The primary toolbar indicator and switcher for Intended vs Implemented context.
 */
export const ModelContextBar: React.FC<ModelContextBarProps> = ({
  graphContext,
  onGraphContextChange,
  project,
  specification,
  analysis,
  analysisStatus,
  className = '',
}) => {
  const currentContext = graphContext;
  const isImplemented = currentContext === 'implemented';

  const revisionLabel = isImplemented
    ? (analysis?.revision ? `Analysis Rev ${analysis.revision}` : 'No captured analysis')
    : `Rev ${project?.specRevision ?? specification?.schemaVersion ?? 0}`;

  return (
    <div
      className={`model-context-bar ${className}`}
      data-testid="model-context-bar"
    >
      <div className="model-context-info">
        <span className={`context-status-dot dot-${currentContext}`} />
        <span className="model-context-indicator" data-testid="model-context-indicator">
          {`Context: ${isImplemented ? 'Implemented Architecture' : 'Intended Specification'}`}
        </span>
        <span className="context-revision-badge" data-testid="context-revision-badge">
          {revisionLabel}
        </span>
      </div>

      <div className="graph-context-actions" data-testid="graph-context-actions">
        <button
          type="button"
          className={`context-tab-btn ${currentContext === 'intended' ? 'active' : ''}`}
          data-testid="context-tab-intended"
          onClick={() => onGraphContextChange?.('intended')}
          title="View intended specification (human-controlled)"
        >
          Intended
        </button>
        <button
          type="button"
          className={`context-tab-btn ${currentContext === 'implemented' ? 'active' : ''}`}
          data-testid="context-tab-implemented"
          onClick={() => onGraphContextChange?.('implemented')}
          title="View implemented analysis (code-extracted)"
        >
          Implemented
        </button>
        <button
          type="button"
          className="btn-switch-context"
          data-testid="switch-graph-context-btn"
          onClick={() => onGraphContextChange?.(currentContext === 'intended' ? 'implemented' : 'intended')}
          title="Switch graph context"
        >
          Switch Context
        </button>
      </div>
    </div>
  );
};

/**
 * Comprehensive Model Context & Provenance Inspector Component.
 * Integrates context switching, statement ownership, provenance marking, opaque node inspection,
 * and structural analysis limits explanation.
 */
export const ModelContext: React.FC<ModelContextProps> = ({
  graphContext,
  onGraphContextChange,
  project,
  specification,
  analysis,
  analysisStatus = 'current',
  selectedNode,
  selectedEdge,
  onSelectNode,
  onSelectEdge,
  onViewSource,
  compact = false,
  showLimitsNotice = true,
  showOwnership = true,
  showStats = true,
  className = '',
}) => {
  const isImplemented = graphContext === 'implemented';
  const activeGraph = isImplemented ? (analysis?.graph || null) : specification;
  const nodes = useMemo(() => activeGraph?.nodes || [], [activeGraph]);
  const edges = useMemo(() => activeGraph?.edges || [], [activeGraph]);

  const stats = useMemo(() => {
    let humanCount = 0;
    let extractedCount = 0;
    let aiCount = 0;
    let opaqueCount = 0;
    let uncertainEdges = 0;

    nodes.forEach(n => {
      if (n.stepType === 'opaque') opaqueCount++;
      if (n.provenance === 'human') humanCount++;
      else if (n.provenance === 'extracted') extractedCount++;
      else if (n.provenance === 'ai') aiCount++;
    });

    edges.forEach(e => {
      if (e.uncertain) uncertainEdges++;
    });

    return {
      nodesTotal: nodes.length,
      edgesTotal: edges.length,
      humanCount,
      extractedCount,
      aiCount,
      opaqueCount,
      uncertainEdges,
    };
  }, [nodes, edges]);

  return (
    <div
      className={`model-context-container ${compact ? 'is-compact' : ''} ${className}`}
      data-testid="model-context-container"
    >
      {/* 1. Context Navigation Bar */}
      <ModelContextBar
        graphContext={graphContext}
        onGraphContextChange={onGraphContextChange}
        project={project}
        specification={specification}
        analysis={analysis}
        analysisStatus={analysisStatus}
      />

      {/* 2. Statement Ownership Declaration */}
      {showOwnership && (
        <div
          className="model-ownership-card"
          data-testid="model-context-ownership"
        >
          <div className="ownership-header">
            {isImplemented ? (
              <FileCode size={14} className="text-success" />
            ) : (
              <User size={14} className="text-primary" />
            )}
            <strong>
              {isImplemented
                ? 'Code Reality (Implemented Architecture)'
                : 'Human Intent (Intended Specification)'}
            </strong>
          </div>
          <p
            className="ownership-statement"
            data-testid={isImplemented ? 'implemented-ownership-statement' : 'intended-ownership-statement'}
          >
            {isImplemented
              ? 'Implemented models follow actual saved code on disk (R03, R41). Populated by TypeScript AST and Prisma schema extraction. Cannot silently alter human intent.'
              : 'Humans own and control the intended specification (R03, R41). Grounded in design decisions and business requirements. Protected from unreviewed code changes.'}
          </p>
          <div className="ownership-meta-row">
            <span>
              Statement Owner:{' '}
              <strong data-testid={isImplemented ? 'statement-owner-compiler' : 'statement-owner-human'}>
                {isImplemented ? 'Compiler / AST Analysis' : 'Human Architect'}
              </strong>
            </span>
          </div>
        </div>
      )}

      {/* 3. Graph Provenance Breakdown Stats */}
      {showStats && !compact && (
        <div className="model-context-stats" data-testid="model-context-stats">
          <div className="stat-pill" data-testid="stat-total-nodes">
            <span className="stat-label">Nodes:</span>
            <span className="stat-val">{stats.nodesTotal}</span>
          </div>
          <div className="stat-pill" data-testid="stat-total-edges">
            <span className="stat-label">Edges:</span>
            <span className="stat-val">{stats.edgesTotal}</span>
          </div>
          <div className="stat-pill prov-stat-human" data-testid="stat-human-nodes">
            <User size={12} />
            <span className="stat-label">Human:</span>
            <span className="stat-val">{stats.humanCount}</span>
          </div>
          <div className="stat-pill prov-stat-extracted" data-testid="stat-extracted-nodes">
            <CheckCircle2 size={12} />
            <span className="stat-label">Extracted:</span>
            <span className="stat-val">{stats.extractedCount}</span>
          </div>
          <div className="stat-pill prov-stat-ai" data-testid="stat-ai-nodes">
            <Cpu size={12} />
            <span className="stat-label">AI Inferred:</span>
            <span className="stat-val">{stats.aiCount}</span>
          </div>
          {stats.opaqueCount > 0 && (
            <div className="stat-pill prov-stat-opaque" data-testid="stat-opaque-nodes">
              <ShieldAlert size={12} />
              <span className="stat-label">Opaque:</span>
              <span className="stat-val">{stats.opaqueCount}</span>
            </div>
          )}
          {stats.uncertainEdges > 0 && (
            <div className="stat-pill stat-uncertain-edges" data-testid="stat-uncertain-edges">
              <AlertTriangle size={12} />
              <span className="stat-label">Uncertain Edges:</span>
              <span className="stat-val">{stats.uncertainEdges}</span>
            </div>
          )}
        </div>
      )}

      {/* 4. Structural Analysis Limits Notice */}
      {showLimitsNotice && (
        <AnalysisLimitsNotice
          quality={analysis?.quality}
          compact={compact}
        />
      )}

      {/* 5. Currently Selected Node Provenance Inspection */}
      {selectedNode && (
        <div className="context-selected-node" data-testid="context-selected-node">
          {selectedNode.stepType === 'opaque' ? (
            <OpaqueFindingCard
              node={selectedNode}
              onViewSource={() => onViewSource && selectedNode.source && onViewSource(selectedNode.source)}
            />
          ) : (
            <ProvenanceStatementCard
              label={selectedNode.name}
              provenance={selectedNode.provenance || 'human'}
              kind={selectedNode.kind}
              description={selectedNode.description}
              source={selectedNode.source}
              onViewSource={onViewSource}
            />
          )}
        </div>
      )}

      {/* 6. Currently Selected Edge Provenance Inspection */}
      {selectedEdge && (
        <div className="context-selected-edge" data-testid="context-selected-edge">
          {selectedEdge.uncertain || selectedEdge.provenance === 'ai' ? (
            <UncertainRelationshipCard
              edge={selectedEdge}
              sourceName={nodes.find(n => n.id === selectedEdge.source)?.name}
              targetName={nodes.find(n => n.id === selectedEdge.target)?.name}
            />
          ) : (
            <ProvenanceStatementCard
              label={selectedEdge.label || selectedEdge.kind}
              provenance={selectedEdge.provenance || 'human'}
              kind={`edge: ${selectedEdge.kind}`}
              uncertain={selectedEdge.uncertain}
            />
          )}
        </div>
      )}
    </div>
  );
};
