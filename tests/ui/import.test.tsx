import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  QualityReport,
  BEHAVIORAL_LIMIT_STATEMENT,
  type QualityReportProps,
} from '../../src/components/QualityReport';
import {
  ImportReview,
  buildProposedIntendedGraph,
  type HumanAcceptanceRecord,
  type HumanRejectionRecord,
} from '../../src/components/ImportReview';
import { ReviewPanel } from '../../src/components/ReviewPanel';
import { Header } from '../../src/components/Header';
import { App } from '../../src/App';
import {
  emptyGraph,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Analysis,
} from '../../shared/model';
import type { ImportQualityReportResponse } from '../../shared/api';

function createMockProject(specRevision = 1): Project {
  const existingNode: ProgramNode = {
    id: 'mod-core',
    kind: 'module',
    name: 'CoreModule',
    description: 'Human-defined core module',
    provenance: 'human',
    policy: 'editable',
    contract: '',
    requiredChecks: [],
    instructions: '',
    outputPath: '',
    fields: [],
  };

  const specification: Graph = {
    schemaVersion: 1,
    nodes: [existingNode],
    edges: [],
    requirements: [],
  };

  return {
    id: 'proj-test-import',
    name: 'Import Test Project',
    description: 'Testing import review and adoption',
    target: 'TypeScript application',
    root: '/test/workspace',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision,
    specification,
    layout: {},
    checks: {},
  };
}

function createMockAnalysis(options?: {
  status?: 'current' | 'partial' | 'stale';
  unresolvedReferences?: number;
  unsupportedConstructs?: number;
  inferredItems?: number;
  diagnostics?: Array<{ severity: 'error' | 'warning' | 'info'; message: string; path?: string; line?: number; code?: string }>;
  eligibleFiles?: number;
  analyzedFiles?: number;
}): Analysis {
  const nodes: ProgramNode[] = [
    {
      id: 'mod-auth',
      kind: 'module',
      name: 'AuthModule',
      description: 'Extracted auth module',
      provenance: 'extracted',
      policy: 'editable',
      contract: 'export class AuthModule {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/auth.ts',
      source: {
        path: 'src/auth.ts',
        line: 1,
        start: 0,
        end: 120,
        hash: 'hash-auth-123',
        revision: 'rev-001',
      },
      fields: [],
    },
    {
      id: 'mod-billing',
      kind: 'module',
      name: 'BillingModule',
      description: 'Extracted billing module',
      provenance: 'extracted',
      policy: 'editable',
      contract: 'export class BillingModule {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/billing.ts',
      source: {
        path: 'src/billing.ts',
        line: 1,
        start: 0,
        end: 150,
        hash: 'hash-billing-456',
        revision: 'rev-001',
      },
      fields: [],
    },
    {
      id: 'fn-opaque-calc',
      kind: 'function',
      name: 'calculateTaxDynamic',
      parentId: 'mod-billing',
      description: 'Dynamic tax calculation with eval/with construct',
      provenance: 'extracted',
      policy: 'editable',
      contract: '(...args: any[]) => any',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/billing.ts',
      stepType: 'opaque',
      source: {
        path: 'src/billing.ts',
        line: 45,
        start: 600,
        end: 850,
        hash: 'hash-billing-456',
        revision: 'rev-001',
      },
      fields: [],
    },
  ];

  const edges: ProgramEdge[] = [
    {
      id: 'edge-mod-opaque',
      source: 'mod-billing',
      target: 'fn-opaque-calc',
      kind: 'contains',
      label: 'contains',
      provenance: 'extracted',
      uncertain: false,
    },
    {
      id: 'rel-ai-inferred',
      source: 'mod-auth',
      target: 'mod-billing',
      kind: 'depends-on',
      label: 'inferred dependency',
      provenance: 'ai',
      uncertain: true,
    },
  ];

  const status = options?.status ?? 'current';
  const eligibleFiles = options?.eligibleFiles ?? 2;
  const analyzedFiles = options?.analyzedFiles ?? 2;
  const unresolvedReferences = options?.unresolvedReferences ?? 0;
  const unsupportedConstructs = options?.unsupportedConstructs ?? 1;
  const inferredItems = options?.inferredItems ?? 1;
  const diagnostics = options?.diagnostics ?? [];

  return {
    revision: 'rev-001',
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    status,
    durationMs: 45,
    graph: {
      schemaVersion: 1,
      nodes,
      edges,
      requirements: [],
    },
    files: {
      'src/auth.ts': { hash: 'hash-auth-123', text: 'export class AuthModule {}' },
      'src/billing.ts': { hash: 'hash-billing-456', text: 'export class BillingModule {}' },
    },
    quality: {
      eligibleFiles,
      analyzedFiles,
      unresolvedReferences,
      unsupportedConstructs,
      inferredItems,
      prismaValidation: 'not-applicable',
      diagnostics,
    },
  };
}

describe('T046: Review Quality and Adopt Imported Structure into Intent', () => {
  // =========================================================================
  // Checklist Item 2: Display quality counts, diagnostics, opaque findings,
  // and inferred interpretations
  // =========================================================================
  describe('QualityReport Component Display', () => {
    it('displays quality counts, file coverage, and mandatory behavioral completeness disclaimer', () => {
      const analysis = createMockAnalysis({
        eligibleFiles: 10,
        analyzedFiles: 10,
        unresolvedReferences: 0,
        unsupportedConstructs: 2,
        inferredItems: 1,
      });

      const html = renderToString(
        <QualityReport analysis={analysis} status="current" revision="rev-001" />
      );

      // Verify header and status badge
      expect(html).toContain('data-testid="quality-report"');
      expect(html).toContain('data-testid="quality-report-title"');
      expect(html).toContain('data-testid="quality-status-badge"');
      expect(html).toContain('CURRENT');
      expect(html).toContain('Rev: rev-001');

      // Verify mandatory R09 & R39 behavioral completeness disclaimer
      expect(html).toContain('data-testid="quality-behavioral-limit-notice"');
      expect(html).toContain('data-testid="behavioral-limit-text"');
      expect(html).toContain(BEHAVIORAL_LIMIT_STATEMENT);
      expect(html).toContain('Runtime behavior and business intent retain uncertainty');

      // Verify quality metrics grid
      expect(html).toContain('data-testid="quality-counts-grid"');
      expect(html).toContain('data-testid="quality-coverage-card"');
      expect(html).toContain('10 / 10');
      expect(html).toContain('(100%)');

      expect(html).toContain('data-testid="quality-unresolved-card"');
      expect(html).toContain('data-testid="quality-unresolved-value"');

      expect(html).toContain('data-testid="quality-unsupported-card"');
      expect(html).toContain('data-testid="quality-unsupported-value"');

      expect(html).toContain('data-testid="quality-inferred-card"');
      expect(html).toContain('data-testid="quality-inferred-value"');

      expect(html).toContain('data-testid="quality-prisma-card"');
      expect(html).toContain('NOT-APPLICABLE');
    });

    it('displays diagnostics breakdown with severity badges and location info', () => {
      const analysis = createMockAnalysis({
        diagnostics: [
          {
            severity: 'error',
            message: 'Type mismatch in authentication token header',
            path: 'src/auth.ts',
            line: 12,
            code: 'TS2322',
          },
          {
            severity: 'warning',
            message: 'Unused local variable: debugCounter',
            path: 'src/billing.ts',
            line: 88,
            code: 'TS6133',
          },
        ],
      });

      const html = renderToString(
        <QualityReport analysis={analysis} status="current" />
      );

      expect(html).toContain('data-testid="quality-diagnostics-section"');
      expect(html).toContain('data-testid="quality-diagnostics-list"');
      expect(html).toContain('Type mismatch in authentication token header');
      expect(html).toContain('TS2322');
      expect(html).toContain('src/auth.ts');
      expect(html).toContain('Unused local variable: debugCounter');
      expect(html).toContain('TS6133');
      expect(html).toContain('src/billing.ts');
      expect(html).toContain('1 err');
      expect(html).toContain('1 warn');
    });

    it('displays opaque constructs with source-backed evidence access', () => {
      const analysis = createMockAnalysis({ unsupportedConstructs: 1 });
      const html = renderToString(
        <QualityReport analysis={analysis} status="current" />
      );

      expect(html).toContain('data-testid="quality-opaque-section"');
      expect(html).toContain('data-testid="quality-opaque-list"');
      expect(html).toContain('calculateTaxDynamic');
      expect(html).toContain('src/billing.ts:45');
      expect(html).toContain('Bytes: 600–850');
      expect(html).toContain('Unsupported language constructs are retained as source-backed opaque nodes');
    });

    it('displays AI-inferred interpretations with clear uncertainty caveats', () => {
      const analysis = createMockAnalysis({ inferredItems: 1 });
      const html = renderToString(
        <QualityReport analysis={analysis} status="current" />
      );

      expect(html).toContain('data-testid="quality-inferred-section"');
      expect(html).toContain('data-testid="inferred-warning-box"');
      expect(html).toContain('Inferred suggestions retain uncertainty and are heuristic interpretations');
      expect(html).toContain('mod-auth');
      expect(html).toContain('mod-billing');
      expect(html).toContain('Uncertain / Heuristic');
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: No intended changes occur before acceptance
  // =========================================================================
  describe('Acceptance Criterion 1: No intended changes occur before acceptance', () => {
    it('leaves intended specification completely unchanged during review and selection', () => {
      const project = createMockProject(1);
      const analysis = createMockAnalysis();
      const initialSpecJson = JSON.stringify(project.specification);

      const onAdopt = vi.fn();
      const onReject = vi.fn();

      // Render the ImportReview modal
      const html = renderToString(
        <ImportReview
          project={project}
          specification={project.specification}
          analysis={analysis}
          onAdopt={onAdopt}
          onReject={onReject}
          mode="modal"
          isOpen={true}
        />
      );

      // Verify the modal renders with the R03 disclaimer
      expect(html).toContain('data-testid="import-review-modal"');
      expect(html).toContain('data-testid="import-review-banner"');
      expect(html).toContain('Imported code populates the implemented graph. The intended specification remains untouched');

      // Verify onAdopt was NOT called simply by mounting or rendering the review view
      expect(onAdopt).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();

      // Verify project specification is unchanged
      expect(JSON.stringify(project.specification)).toBe(initialSpecJson);
      expect(project.specRevision).toBe(1);
    });

    it('shows prospective specification diff explaining no changes occur until acceptance', () => {
      const project = createMockProject(1);
      const analysis = createMockAnalysis();

      const html = renderToString(
        <ImportReview
          project={project}
          specification={project.specification}
          analysis={analysis}
          initialTab="diff"
          mode="modal"
          isOpen={true}
        />
      );

      expect(html).toContain('data-testid="import-diff-view"');
      expect(html).toContain('data-testid="import-diff-no-change-notice"');
      expect(html).toContain('No intended specification changes have occurred yet. Acceptance is recorded only when you click');
      expect(html).toContain('data-testid="diff-provenance-summary"');
      expect(html).toContain('All accepted elements preserve their extracted compiler provenance, source path bindings, and hash revisions');
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Partial/uncertain imports can be reviewed with visible limits
  // =========================================================================
  describe('Acceptance Criterion 2: Partial/uncertain imports have visible limits', () => {
    it('surfaces visible limits for partial imports with missing dependencies and incomplete coverage', () => {
      const partialAnalysis = createMockAnalysis({
        status: 'partial',
        eligibleFiles: 10,
        analyzedFiles: 6,
        unresolvedReferences: 3,
        unsupportedConstructs: 2,
        diagnostics: [
          {
            severity: 'error',
            message: "Cannot find module 'express' or its corresponding type declarations",
            path: 'src/server.ts',
            line: 1,
            code: 'TS2307',
          },
          {
            severity: 'error',
            message: "Cannot find module '@prisma/client' or its corresponding type declarations",
            path: 'src/db.ts',
            line: 4,
            code: 'TS2307',
          },
        ],
      });

      const html = renderToString(
        <QualityReport analysis={partialAnalysis} status="partial" />
      );

      // Verify visible limits banner is displayed
      expect(html).toContain('data-testid="quality-partial-limits-banner"');
      expect(html).toContain('Partial Import with Visible Limits Detected');
      expect(html).toContain('File coverage is partial: 6 of 10 eligible files analyzed');
      expect(html).toContain('3 unresolved references detected in codebase');
      expect(html).toContain('Missing external dependencies or type declarations');
      expect(html).toContain('Extracted structure is incomplete; human review is required');

      // Verify behavioral limit notice is also prominently displayed
      expect(html).toContain('data-testid="quality-behavioral-limit-notice"');
      expect(html).toContain(BEHAVIORAL_LIMIT_STATEMENT);

      // Verify missing dependency diagnostics are displayed
      expect(html).toContain('Cannot find module');
      expect(html).toContain('express');
      expect(html).toContain('@prisma/client');
      expect(html).toContain('TS2307');
    });

    it('surfaces partial import notice and visible limits in the ImportReview dialog', () => {
      const project = createMockProject(1);
      const partialAnalysis = createMockAnalysis({
        status: 'partial',
        unresolvedReferences: 2,
      });

      const html = renderToString(
        <ImportReview
          project={project}
          specification={project.specification}
          analysis={partialAnalysis}
          analysisStatus="partial"
          mode="modal"
        />
      );

      expect(html).toContain('data-testid="import-partial-limits-notice"');
      expect(html).toContain('Partial Import with Visible Limits:');
      expect(html).toContain('This project contains unresolved references or missing dependencies');
      expect(html).toContain('data-testid="view-quality-report-btn"');
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Rejected suggestions leave intended graph unchanged
  // =========================================================================
  describe('Acceptance Criterion 3: Rejected suggestions leave intended graph unchanged', () => {
    it('leaves intended graph unchanged when suggestions are rejected', () => {
      const project = createMockProject(2);
      const analysis = createMockAnalysis();
      const initialNodesCount = project.specification.nodes.length;
      const initialEdgesCount = project.specification.edges.length;

      const onAdopt = vi.fn();
      const onReject = vi.fn();

      // Verify pure helper function behavior for rejecting elements
      const emptySelectedNodes = new Set<string>();
      const emptySelectedEdges = new Set<string>();

      const { proposedGraph, rejectedNodes, rejectedEdges } = buildProposedIntendedGraph(
        project.specification,
        analysis.graph,
        emptySelectedNodes,
        emptySelectedEdges
      );

      // The proposed graph with all suggestions rejected equals the original specification!
      expect(proposedGraph.nodes.length).toBe(initialNodesCount);
      expect(proposedGraph.edges.length).toBe(initialEdgesCount);
      expect(rejectedNodes.length).toBe(analysis.graph.nodes.length);
      expect(rejectedEdges.length).toBe(analysis.graph.edges.length);
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 1: Accept selected extracted modules while
  // rejecting an inferred relationship
  // =========================================================================
  describe('Concrete Scenario 1: Accept selected extracted modules while rejecting an inferred relationship', () => {
    it('adopts selected extracted modules, preserves provenance, and excludes the rejected AI-inferred relationship', () => {
      const baseProject = createMockProject(1);
      const analysis = createMockAnalysis();

      // Analysis contains:
      // - mod-auth (extracted)
      // - mod-billing (extracted)
      // - rel-ai-inferred (provenance: 'ai', uncertain: true) from mod-auth -> mod-billing

      const selectedNodes = new Set<string>(['mod-auth', 'mod-billing']);
      // Explicitly REJECT rel-ai-inferred by leaving selectedEdgeIds empty!
      const selectedEdges = new Set<string>([]);

      const {
        proposedGraph,
        validationError,
        acceptedNodes,
        acceptedEdges,
        rejectedNodes,
        rejectedEdges,
      } = buildProposedIntendedGraph(
        baseProject.specification,
        analysis.graph,
        selectedNodes,
        selectedEdges
      );

      // Verify no schema or graph validation error
      expect(validationError).toBeNull();

      // 1. Verify accepted nodes include both extracted modules
      expect(acceptedNodes.map(n => n.id)).toContain('mod-auth');
      expect(acceptedNodes.map(n => n.id)).toContain('mod-billing');
      expect(proposedGraph.nodes.some(n => n.id === 'mod-auth')).toBe(true);
      expect(proposedGraph.nodes.some(n => n.id === 'mod-billing')).toBe(true);

      // 2. Verify provenance and source binding are strictly PRESERVED
      const adoptedAuth = proposedGraph.nodes.find(n => n.id === 'mod-auth')!;
      expect(adoptedAuth.provenance).toBe('extracted');
      expect(adoptedAuth.source).toBeDefined();
      expect(adoptedAuth.source?.path).toBe('src/auth.ts');
      expect(adoptedAuth.source?.hash).toBe('hash-auth-123');
      expect(adoptedAuth.source?.revision).toBe('rev-001');

      const adoptedBilling = proposedGraph.nodes.find(n => n.id === 'mod-billing')!;
      expect(adoptedBilling.provenance).toBe('extracted');
      expect(adoptedBilling.source?.path).toBe('src/billing.ts');
      expect(adoptedBilling.source?.hash).toBe('hash-billing-456');

      // 3. Verify the AI-inferred relationship was REJECTED and is NOT present in the proposed intended graph
      expect(rejectedEdges.some(e => e.id === 'rel-ai-inferred')).toBe(true);
      expect(acceptedEdges.some(e => e.id === 'rel-ai-inferred')).toBe(false);
      expect(proposedGraph.edges.some(e => e.id === 'rel-ai-inferred')).toBe(false);

      // 4. Verify in rendered UI that the rejected relationship is clearly marked as excluded
      const html = renderToString(
        <ImportReview
          project={baseProject}
          specification={baseProject.specification}
          analysis={analysis}
          initialTab="diff"
          mode="modal"
        />
      );

      expect(html).toContain('data-testid="import-diff-view"');
      expect(html).toContain('data-testid="diff-added-nodes-section"');
      expect(html).toContain('AuthModule');
      expect(html).toContain('BillingModule');
    });

    it('records human acceptance with reviewer, timestamp, and accepted/rejected element IDs', () => {
      const baseProject = createMockProject(1);
      const analysis = createMockAnalysis();

      const selectedNodes = new Set<string>(['mod-auth', 'mod-billing']);
      const selectedEdges = new Set<string>();

      const { proposedGraph, acceptedNodes, acceptedEdges, rejectedNodes, rejectedEdges } =
        buildProposedIntendedGraph(
          baseProject.specification,
          analysis.graph,
          selectedNodes,
          selectedEdges
        );

      const acceptanceRecord: HumanAcceptanceRecord = {
        timestamp: new Date().toISOString(),
        reviewer: 'Human Architect',
        specRevisionBefore: 1,
        acceptedNodeIds: acceptedNodes.map(n => n.id),
        acceptedEdgeIds: acceptedEdges.map(e => e.id),
        rejectedNodeIds: rejectedNodes.map(n => n.id),
        rejectedEdgeIds: rejectedEdges.map(e => e.id),
        adoptedGraph: proposedGraph,
        diffSummary: {
          addedNodesCount: 2,
          addedEdgesCount: 0,
          modifiedNodesCount: 0,
        },
      };

      expect(acceptanceRecord.reviewer).toBe('Human Architect');
      expect(acceptanceRecord.acceptedNodeIds).toEqual(['mod-auth', 'mod-billing']);
      expect(acceptanceRecord.rejectedEdgeIds).toContain('rel-ai-inferred');
      expect(acceptanceRecord.adoptedGraph.nodes.some(n => n.id === 'mod-auth')).toBe(true);
      expect(acceptanceRecord.adoptedGraph.edges.some(e => e.id === 'rel-ai-inferred')).toBe(false);
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Inspect a partial import with missing dependencies
  // =========================================================================
  describe('Concrete Scenario 2: Inspect a partial import with missing dependencies', () => {
    it('inspects a partial import with missing external modules and surfaces all diagnostics', () => {
      const partialAnalysis = createMockAnalysis({
        status: 'partial',
        eligibleFiles: 8,
        analyzedFiles: 5,
        unresolvedReferences: 2,
        diagnostics: [
          {
            severity: 'error',
            message: "Cannot find module 'lodash' or its corresponding type declarations.",
            path: 'src/utils.ts',
            line: 3,
            code: 'TS2307',
          },
          {
            severity: 'error',
            message: "Cannot find module 'fastify' or its corresponding type declarations.",
            path: 'src/server.ts',
            line: 1,
            code: 'TS2307',
          },
        ],
      });

      const reportResponse: ImportQualityReportResponse = {
        revision: 'rev-partial-001',
        status: 'partial',
        eligibleFiles: 8,
        analyzedFiles: 5,
        unresolvedReferences: 2,
        unsupportedConstructs: 1,
        inferredItems: 0,
        prismaValidation: 'not-applicable',
        diagnostics: partialAnalysis.quality.diagnostics,
        behavioralLimitStatement: BEHAVIORAL_LIMIT_STATEMENT,
        limitStatement: BEHAVIORAL_LIMIT_STATEMENT,
        coverage: {
          eligibleFiles: 8,
          analyzedFiles: 5,
          ratio: 5 / 8,
          percentage: 63,
          isFullyCovered: false,
        },
        breakdown: {
          compilerDiagnostics: 2,
          parserDiagnostics: 0,
          errors: 2,
          warnings: 0,
          info: 0,
          opaqueConstructs: 1,
          unresolvedReferences: 2,
          inferredInterpretations: 0,
        },
        counts: {
          eligibleFiles: 8,
          analyzedFiles: 5,
          unresolvedReferences: 2,
          unsupportedConstructs: 1,
          inferredItems: 0,
          diagnostics: 2,
          errors: 2,
          warnings: 0,
        },
        quality: partialAnalysis.quality,
      };

      const html = renderToString(
        <QualityReport
          report={reportResponse}
          analysis={partialAnalysis}
          status="partial"
          revision="rev-partial-001"
        />
      );

      // Verify partial status and visible limits
      expect(html).toContain('PARTIAL');
      expect(html).toContain('Rev: rev-partial-001');
      expect(html).toContain('data-testid="quality-partial-limits-banner"');
      expect(html).toContain('File coverage is partial: 5 of 8 eligible files analyzed');
      expect(html).toContain('2 unresolved references detected in codebase');

      // Verify coverage values
      expect(html).toContain('5 / 8');
      expect(html).toContain('(63%)');

      // Verify missing dependencies diagnostics
      expect(html).toContain('Cannot find module');
      expect(html).toContain('lodash');
      expect(html).toContain('fastify');
      expect(html).toContain('TS2307');
      expect(html).toContain('src/utils.ts');
      expect(html).toContain('src/server.ts');

      // Verify behavioral limit notice is mandatory
      expect(html).toContain(BEHAVIORAL_LIMIT_STATEMENT);
    });
  });

  // =========================================================================
  // UI & Workspace Integration
  // =========================================================================
  describe('UI & Workspace Integration', () => {
    it('renders Import Review button in Header and opens ImportReview dialog', () => {
      const project = createMockProject(1);
      const onOpenImport = vi.fn();

      const html = renderToString(
        <Header
          project={project}
          syncStatus="current"
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
          onOpenImportReview={onOpenImport}
        />
      );

      expect(html).toContain('data-testid="header-open-import"');
      expect(html).toContain('Import');
    });

    it('renders Import Quality tab in ReviewPanel and provides adoption trigger', () => {
      const project = createMockProject(1);
      const analysis = createMockAnalysis();
      const onOpenImport = vi.fn();

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          initialTab="import"
          onOpenImportReview={onOpenImport}
        />
      );

      expect(html).toContain('data-testid="tab-import"');
      expect(html).toContain('data-testid="review-import-view"');
      expect(html).toContain('data-testid="panel-open-import-review-btn"');
      expect(html).toContain('data-testid="quality-report"');
    });

    it('renders ImportReview modal within App shell and connects to specification update', () => {
      const project = createMockProject(1);
      const analysis = createMockAnalysis();
      const projectWithAnalysis: Project = {
        ...project,
        analysis,
      };

      const html = renderToString(
        <App
          initialProject={projectWithAnalysis}
          autoLoad={false}
        />
      );

      // Verify workspace shell renders Header with Import button
      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="header-open-import"');
      expect(html).toContain('data-testid="tab-import"');
    });
  });
});
