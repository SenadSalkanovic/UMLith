import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  AnalysisStatus,
  isFirstImportFailure,
  getAnalysisLifecycleState,
  getOutdatedPortions,
} from '../../src/components/AnalysisStatus';
import { Header } from '../../src/components/Header';
import { App } from '../../src/App';
import {
  emptyGraph,
  type Analysis,
  type Project,
  type Diagnostic,
  type StaleEvidence,
} from '../../shared/model';

function createMockAnalysis(params: {
  revision?: string;
  sequence?: number;
  status: 'updating' | 'current' | 'partial' | 'stale';
  staleEvidence?: StaleEvidence;
  diagnostics?: Diagnostic[];
  durationMs?: number;
}): Analysis {
  const isStale = params.status === 'stale';
  const defaultStaleEvidence: StaleEvidence | undefined = isStale
    ? { scope: 'all', paths: [], reason: 'Analysis failed on syntax error' }
    : undefined;

  return {
    revision: params.revision !== undefined ? params.revision : (params.status === 'stale' && params.sequence === 0 ? '' : 'rev-valid-12345678'),
    sequence: params.sequence !== undefined ? params.sequence : (params.status === 'stale' && params.revision === '' ? 0 : 1),
    analyzedAt: new Date('2026-10-10T20:00:00.000Z').toISOString(),
    durationMs: params.durationMs ?? 42,
    status: params.status,
    graph: emptyGraph(),
    files: {},
    staleEvidence: params.staleEvidence ?? defaultStaleEvidence,
    quality: {
      eligibleFiles: 5,
      analyzedFiles: 5,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'passed',
      diagnostics: params.diagnostics || [],
    },
  };
}

function createMockProject(analysis?: Analysis): Project {
  return {
    id: 'proj-t058',
    name: 'T058 Project',
    description: 'Testing lifecycle states',
    target: 'TypeScript application',
    root: '/workspace/test',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 1,
    specification: emptyGraph(),
    layout: {},
    layoutRevision: 0,
    scopedLayouts: {},
    analysis,
    checks: {
      test: { command: 'npm', args: ['test'] },
    },
  };
}

describe('T058: Show updating, current, partial, and stale analysis states UI', () => {
  describe('Lifecycle State Badges and Narratives', () => {
    it('renders "updating" state visibly in progress with spinner and progress narrative', () => {
      const analysis = createMockAnalysis({ status: 'updating' });
      const html = renderToString(
        <AnalysisStatus status="updating" analysis={analysis} isUpdating={true} />
      );

      expect(html).toContain('data-testid="status-updating"');
      expect(html).toContain('Updating…');
      expect(html).toContain('data-testid="updating-indicator"');
      expect(html).toContain('Larger analyses remain visibly in progress');
      expect(html).toContain('data-testid="retained-during-updating"');
    });

    it('renders "current" state with clean check indicator, revision, sequence, and timing', () => {
      const analysis = createMockAnalysis({
        status: 'current',
        revision: 'rev-abcdef123456',
        sequence: 3,
        durationMs: 85,
      });
      const html = renderToString(
        <AnalysisStatus status="current" analysis={analysis} />
      );

      expect(html).toContain('data-testid="status-current"');
      expect(html).toContain('Current');
      expect(html).toContain('data-testid="current-indicator"');
      expect(html).toContain('All eligible files have been analyzed successfully');
      expect(html).toContain('data-testid="analysis-revision"');
      expect(html).toContain('rev-abcdef');
      expect(html).toContain('data-testid="analysis-sequence"');
      expect(html).toContain('3');
      expect(html).toContain('data-testid="analysis-duration"');
      expect(html).toContain('85');
      expect(html).toContain('ms');
    });

    it('renders "partial" state with warning indicator and notes that valid neighboring findings are retained', () => {
      const analysis = createMockAnalysis({
        status: 'partial',
        staleEvidence: {
          scope: 'paths',
          paths: ['schema2.prisma'],
          reason: 'Prisma parse error in schema2.prisma',
        },
        diagnostics: [
          {
            severity: 'error',
            code: 'prisma-parse-error',
            message: 'Unexpected token at line 3',
            path: 'schema2.prisma',
            line: 3,
          },
        ],
      });
      const html = renderToString(
        <AnalysisStatus status="partial" analysis={analysis} />
      );

      expect(html).toContain('data-testid="status-partial"');
      expect(html).toContain('Partial');
      expect(html).toContain('data-testid="partial-indicator"');
      expect(html).toContain('data-testid="retained-findings-note"');
      expect(html).toContain('Valid findings from neighboring files are preserved in the graph');

      // Outdated portions section
      expect(html).toContain('data-testid="outdated-portions"');
      expect(html).toContain('schema2.prisma');
      expect(html).toContain('Prisma parse error in schema2.prisma');
    });

    it('renders "stale" state retaining last valid model and original evidence on failure', () => {
      const analysis = createMockAnalysis({
        status: 'stale',
        revision: 'rev-prev-valid-999',
        sequence: 4,
        staleEvidence: {
          scope: 'all',
          paths: [],
          reason: 'Syntax error in main.ts: Unexpected token',
        },
        diagnostics: [
          {
            severity: 'error',
            code: 'analysis-failure',
            message: 'Syntax error in main.ts: Unexpected token',
            path: 'main.ts',
            line: 12,
          },
        ],
      });
      const html = renderToString(
        <AnalysisStatus status="stale" analysis={analysis} />
      );

      expect(html).toContain('data-testid="status-stale"');
      expect(html).toContain('Stale');
      expect(html).toContain('data-testid="stale-indicator"');

      // AC 1 & 2: Retains last valid model and original evidence
      expect(html).toContain('data-testid="retained-model-info"');
      expect(html).toContain('rev-prev-v');
      expect(html).toContain('Sequence');
      expect(html).toContain('4');
      expect(html).toContain('data-testid="evidence-preservation-note"');
      expect(html).toContain('Source bindings, content hashes, and ranges remain tied to the last valid capture');

      // Identifies outdated portions
      expect(html).toContain('data-testid="outdated-portions"');
      expect(html).toContain('All portions of the model are outdated due to analysis failure');
      expect(html).toContain('Syntax error in main.ts: Unexpected token');
    });
  });

  describe('Acceptance Criteria Verification', () => {
    it('Acceptance Criterion 1: Failed analysis does not masquerade as fresh empty success', () => {
      const failedAnalysis = createMockAnalysis({
        status: 'stale',
        revision: 'rev-old',
        sequence: 2,
        diagnostics: [{ severity: 'error', code: 'analysis-failure', message: 'Compilation failed' }],
      });
      const html = renderToString(
        <AnalysisStatus status="stale" analysis={failedAnalysis} />
      );

      expect(html).toContain('data-testid="status-stale"');
      expect(html).not.toContain('data-testid="status-current"');
      expect(html).not.toContain('Analysis Up to Date');
    });

    it('Acceptance Criterion 2: Old hashes/ranges remain tied to original evidence', () => {
      const retainedAnalysis = createMockAnalysis({
        status: 'stale',
        revision: 'rev-last-evidence-hash',
        sequence: 5,
        staleEvidence: {
          scope: 'all',
          paths: [],
          reason: 'Syntax error on edit',
        },
      });
      const html = renderToString(
        <AnalysisStatus status="stale" analysis={retainedAnalysis} />
      );

      expect(html).toContain('data-testid="evidence-preservation-note"');
      expect(html).toContain('tied to the last valid capture');
      expect(html).toContain('rev-last-e');
    });

    it('Acceptance Criterion 3: First-import failure has an honest empty/error state', () => {
      const initialFailAnalysis = createMockAnalysis({
        status: 'stale',
        revision: '',
        sequence: 0,
        staleEvidence: {
          scope: 'all',
          paths: [],
          reason: 'Initial import parse error in main.ts',
        },
        diagnostics: [
          {
            severity: 'error',
            code: 'analysis-failure',
            message: 'Failed to parse entrypoint main.ts on first import',
          },
        ],
      });

      expect(isFirstImportFailure(initialFailAnalysis)).toBe(true);

      const html = renderToString(
        <AnalysisStatus status="stale" analysis={initialFailAnalysis} />
      );

      // Honest empty/error state
      expect(html).toContain('data-testid="first-import-failure"');
      expect(html).toContain('No Valid Model Extracted');
      expect(html).toContain('Workspace has no valid evidence');
      expect(html).not.toContain('data-testid="retained-model-info"');
      expect(html).not.toContain('data-testid="status-current"');
    });
  });

  describe('Diagnostic Reasons Breakdown', () => {
    it('renders structured diagnostic items with severity, code, location, and message', () => {
      const diagnostics: Diagnostic[] = [
        {
          severity: 'error',
          code: 'analysis-failure',
          message: 'Cannot find module ./missing',
          path: 'src/index.ts',
          line: 4,
        },
        {
          severity: 'warning',
          code: 'unconfigured-analysis',
          message: 'Files outside tsconfig analyzed with fallback options',
        },
      ];

      const analysis = createMockAnalysis({
        status: 'stale',
        diagnostics,
      });

      const html = renderToString(
        <AnalysisStatus status="stale" analysis={analysis} />
      );

      expect(html).toContain('data-testid="analysis-diagnostics"');
      expect(html).toContain('Diagnostic Reasons');
      expect(html).toContain('2');
      expect(html).toContain('badge-error');
      expect(html).toContain('data-testid="diagnostic-code"');
      expect(html).toContain('analysis-failure');
      expect(html).toContain('src/index.ts');
      expect(html).toContain(':4');
      expect(html).toContain('Cannot find module ./missing');
      expect(html).toContain('badge-warning');
      expect(html).toContain('unconfigured-analysis');
    });
  });

  describe('Compact Mode and UI Integration', () => {
    it('renders compact status badge suitable for Header toolbar embedding', () => {
      const analysisUpdating = createMockAnalysis({ status: 'updating' });
      const htmlUpdating = renderToString(
        <AnalysisStatus status="updating" analysis={analysisUpdating} compact={true} />
      );
      expect(htmlUpdating).toContain('data-testid="status-updating"');
      expect(htmlUpdating).toContain('Updating…');
      expect(htmlUpdating).not.toContain('data-testid="updating-indicator"');

      const analysisCurrent = createMockAnalysis({ status: 'current' });
      const htmlCurrent = renderToString(
        <AnalysisStatus status="current" analysis={analysisCurrent} compact={true} />
      );
      expect(htmlCurrent).toContain('data-testid="status-current"');
      expect(htmlCurrent).toContain('Current');

      const analysisPartial = createMockAnalysis({ status: 'partial' });
      const htmlPartial = renderToString(
        <AnalysisStatus status="partial" analysis={analysisPartial} compact={true} />
      );
      expect(htmlPartial).toContain('data-testid="status-partial"');
      expect(htmlPartial).toContain('Partial');

      const analysisStale = createMockAnalysis({ status: 'stale' });
      const htmlStale = renderToString(
        <AnalysisStatus status="stale" analysis={analysisStale} compact={true} />
      );
      expect(htmlStale).toContain('data-testid="status-stale"');
      expect(htmlStale).toContain('Stale');
    });

    it('Header component renders AnalysisStatus badge with active project', () => {
      const analysis = createMockAnalysis({ status: 'current' });
      const project = createMockProject(analysis);

      const html = renderToString(
        <Header
          project={project}
          syncStatus="current"
          analysis={analysis}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onTogglePanel={() => {}}
          onOpenNewProject={() => {}}
          onOpenProjectPicker={() => {}}
        />
      );

      expect(html).toContain('data-testid="analysis-status-badge"');
      expect(html).toContain('data-testid="status-current"');
      expect(html).toContain('Current');
    });

    it('App component renders AnalysisStatus alert banner when analysis status is stale or partial', () => {
      const staleAnalysis = createMockAnalysis({
        status: 'stale',
        staleEvidence: { scope: 'all', paths: [], reason: 'Disk change with syntax error' },
      });
      const project = createMockProject(staleAnalysis);

      const html = renderToString(
        <App initialProject={project} autoLoad={false} />
      );

      expect(html).toContain('data-testid="workspace-analysis-banner"');
      expect(html).toContain('data-testid="analysis-status-card"');
      expect(html).toContain('data-testid="status-stale"');
      expect(html).toContain('data-testid="retained-model-info"');
    });
  });

  describe('Helper Functions', () => {
    it('getAnalysisLifecycleState handles isUpdating, analysis status, and null fallbacks', () => {
      expect(getAnalysisLifecycleState(null, true)).toBe('updating');
      expect(getAnalysisLifecycleState(null, false)).toBe('current');
      expect(getAnalysisLifecycleState(createMockAnalysis({ status: 'partial' }))).toBe('partial');
      expect(getAnalysisLifecycleState(createMockAnalysis({ status: 'stale' }))).toBe('stale');
    });

    it('getOutdatedPortions accurately extracts scope, paths, and reasons', () => {
      const partialAnalysis = createMockAnalysis({
        status: 'partial',
        staleEvidence: {
          scope: 'paths',
          paths: ['fileA.ts', 'fileB.ts'],
          reason: 'Type errors in dependencies',
        },
      });

      const portions = getOutdatedPortions(partialAnalysis);
      expect(portions).toEqual({
        scope: 'paths',
        paths: ['fileA.ts', 'fileB.ts'],
        reason: 'Type errors in dependencies',
      });

      const currentAnalysis = createMockAnalysis({ status: 'current' });
      expect(getOutdatedPortions(currentAnalysis)).toBeNull();
    });

    it('renders distinct incremental refresh and manual full rescan actions when provided', () => {
      const currentAnalysis = createMockAnalysis({ status: 'current' });

      // Both onRefresh and onRescan provided: both distinct buttons render
      const htmlBoth = renderToString(
        <AnalysisStatus
          status="current"
          analysis={currentAnalysis}
          onRefresh={() => {}}
          onRescan={() => {}}
        />
      );
      expect(htmlBoth).toContain('data-testid="analysis-refresh-btn"');
      expect(htmlBoth).toContain('Refresh');
      expect(htmlBoth).toContain('data-testid="analysis-rescan-btn"');
      expect(htmlBoth).toContain('Full Rescan');

      // Only onRefresh provided: renders refresh button
      const htmlRefreshOnly = renderToString(
        <AnalysisStatus
          status="current"
          analysis={currentAnalysis}
          onRefresh={() => {}}
        />
      );
      expect(htmlRefreshOnly).toContain('data-testid="analysis-refresh-btn"');
      expect(htmlRefreshOnly).not.toContain('data-testid="analysis-rescan-btn"');

      // Only onRescan provided: renders rescan button
      const htmlRescanOnly = renderToString(
        <AnalysisStatus
          status="current"
          analysis={currentAnalysis}
          onRescan={() => {}}
        />
      );
      expect(htmlRescanOnly).toContain('data-testid="analysis-rescan-btn"');
      expect(htmlRescanOnly).toContain('Full Rescan');
    });
  });
});
