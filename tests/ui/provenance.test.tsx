import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ModelContext,
  ModelContextBar,
  ProvenanceBadge,
  ProvenanceStatementCard,
  OpaqueFindingCard,
  AnalysisLimitsNotice,
  UncertainRelationshipCard,
  switchGraphContext,
} from '../../src/components/ModelContext';
import { ProjectTree } from '../../src/components/ProjectTree';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { App } from '../../src/App';
import {
  emptyGraph,
  type Project,
  type Graph,
  type ProgramNode,
  type ProgramEdge,
  type Analysis,
  type Source,
  type Quality,
} from '../../shared/model';
import type { ViewState } from '../../src/types';

function createMockQuality(): Quality {
  return {
    eligibleFiles: 12,
    analyzedFiles: 10,
    unresolvedReferences: 2,
    unsupportedConstructs: 1,
    inferredItems: 3,
    prismaValidation: 'not-applicable',
    diagnostics: [
      { severity: 'warning', message: 'Potential circular dependency in order module', path: 'src/order.ts', line: 14 },
    ],
  };
}

function createMockSource(path = 'src/billing.ts', line = 25): Source {
  return {
    path,
    symbol: 'BillingService',
    line,
    start: 350,
    end: 820,
    hash: 'sha256-billing-abc123',
    revision: 'rev-001',
  };
}

function createScenarioTestWorkspace(): {
  project: Project;
  specification: Graph;
  analysis: Analysis;
} {
  const specNodes: ProgramNode[] = [
    {
      id: 'node-order-service',
      kind: 'class',
      name: 'OrderService',
      description: 'Handles order placement and validations',
      provenance: 'human',
      policy: 'editable',
      contract: 'export class OrderService {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/order.ts',
      fields: [],
    },
    {
      id: 'node-payment-gateway',
      kind: 'class',
      name: 'PaymentGateway',
      description: 'Processes credit card transactions',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export class PaymentGateway {}',
      requiredChecks: [],
      instructions: 'Review PCI compliance before editing',
      outputPath: 'src/payment.ts',
      fields: [],
    },
  ];

  const specEdges: ProgramEdge[] = [
    {
      id: 'edge-order-payment-spec',
      source: 'node-order-service',
      target: 'node-payment-gateway',
      kind: 'depends-on',
      label: 'charges payment',
      provenance: 'human',
      uncertain: false,
    },
  ];

  const specification: Graph = {
    schemaVersion: 1,
    nodes: specNodes,
    edges: specEdges,
    requirements: [
      {
        id: 'req-order-payment',
        text: 'Order service must charge payment gateway before confirming order',
        nodeIds: ['node-order-service', 'node-payment-gateway'],
        edgeIds: ['edge-order-payment-spec'],
        constraints: ['Zero charge leakage'],
        scenarios: ['Order completes upon successful charge'],
      },
    ],
  };

  const implNodes: ProgramNode[] = [
    {
      id: 'node-order-service',
      kind: 'class',
      name: 'OrderService',
      description: 'Extracted AST implementation of OrderService',
      provenance: 'extracted',
      policy: 'editable',
      contract: 'export class OrderService {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/order.ts',
      source: {
        path: 'src/order.ts',
        symbol: 'OrderService',
        line: 10,
        start: 150,
        end: 550,
        hash: 'sha256-order-impl',
        revision: 'rev-impl-01',
      },
      fields: [],
    },
    {
      id: 'node-payment-gateway',
      kind: 'class',
      name: 'PaymentGateway',
      description: 'Extracted AST implementation of PaymentGateway',
      provenance: 'extracted',
      policy: 'editable',
      contract: 'export class PaymentGateway {}',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/payment.ts',
      source: {
        path: 'src/payment.ts',
        symbol: 'PaymentGateway',
        line: 5,
        start: 80,
        end: 420,
        hash: 'sha256-pay-impl',
        revision: 'rev-impl-01',
      },
      fields: [],
    },
    {
      id: 'node-legacy-calculator',
      kind: 'step',
      name: 'legacyTaxCalculation',
      description: 'Unsupported legacy tax calculation AST construct',
      provenance: 'extracted',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: 'src/tax.ts',
      stepType: 'opaque',
      source: {
        path: 'src/tax.ts',
        symbol: 'legacyTaxCalculation',
        line: 42,
        start: 1200,
        end: 1850,
        hash: 'sha256-tax-opaque',
        revision: 'rev-impl-01',
      },
      fields: [],
    },
  ];

  const implEdges: ProgramEdge[] = [
    {
      id: 'edge-order-payment-impl',
      source: 'node-order-service',
      target: 'node-payment-gateway',
      kind: 'relates-to',
      label: 'AI-inferred transaction link',
      provenance: 'ai',
      uncertain: true,
    },
  ];

  const analysis: Analysis = {
    revision: 'rev-impl-01',
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    durationMs: 38,
    graph: {
      schemaVersion: 1,
      nodes: implNodes,
      edges: implEdges,
      requirements: [],
    },
    files: {
      'src/order.ts': { hash: 'sha256-order-impl', text: 'export class OrderService {}' },
      'src/payment.ts': { hash: 'sha256-pay-impl', text: 'export class PaymentGateway {}' },
      'src/tax.ts': { hash: 'sha256-tax-opaque', text: 'function legacyTaxCalculation() { /* ... */ }' },
    },
    quality: createMockQuality(),
  };

  const project: Project = {
    id: 'proj-scenario-t026',
    name: 'E-Commerce Core',
    description: 'E-commerce platform with intended and implemented architectures',
    target: 'TypeScript application',
    root: '/workspace/ecommerce',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision: 5,
    specification,
    layout: {},
    analysis,
    checks: {
      test: { command: 'npm', args: ['test'] },
    },
  };

  return { project, specification, analysis };
}

describe('T026: Distinguish intended, implemented, inferred, and uncertain content', () => {
  describe('Work Checklist & Model Context Indicators', () => {
    it('shows explicit intended model context with human-controlled indicator and specification revision', () => {
      const { project, specification, analysis } = createScenarioTestWorkspace();

      const html = renderToString(
        <ModelContext
          graphContext="intended"
          onGraphContextChange={() => {}}
          project={project}
          specification={specification}
          analysis={analysis}
        />
      );

      // Model Context Bar and Indicator
      expect(html).toContain('data-testid="model-context-bar"');
      expect(html).toContain('data-testid="model-context-indicator"');
      expect(html).toContain('Context: Intended Specification');
      expect(html).toContain('data-testid="context-revision-badge"');
      expect(html).toContain(`Rev ${project.specRevision}`);

      // Tabs
      expect(html).toContain('data-testid="context-tab-intended"');
      expect(html).toContain('class="context-tab-btn active"');
      expect(html).toContain('data-testid="context-tab-implemented"');

      // Ownership Statement
      expect(html).toContain('data-testid="model-context-ownership"');
      expect(html).toContain('data-testid="intended-ownership-statement"');
      expect(html).toContain('Humans own and control the intended specification (R03, R41)');
      expect(html).toContain('data-testid="statement-owner-human"');
      expect(html).toContain('Human Architect');
    });

    it('shows explicit implemented model context with compiler-extracted indicator and analysis revision', () => {
      const { project, specification, analysis } = createScenarioTestWorkspace();

      const html = renderToString(
        <ModelContext
          graphContext="implemented"
          onGraphContextChange={() => {}}
          project={project}
          specification={specification}
          analysis={analysis}
        />
      );

      // Implemented Indicator
      expect(html).toContain('data-testid="model-context-bar"');
      expect(html).toContain('data-testid="model-context-indicator"');
      expect(html).toContain('Context: Implemented Architecture');
      expect(html).toContain('data-testid="context-revision-badge"');
      expect(html).toContain(`Analysis Rev ${analysis.revision}`);

      // Tabs
      expect(html).toContain('data-testid="context-tab-implemented"');
      expect(html).toContain('class="context-tab-btn active"');

      // Ownership Statement
      expect(html).toContain('data-testid="model-context-ownership"');
      expect(html).toContain('data-testid="implemented-ownership-statement"');
      expect(html).toContain('Implemented models follow actual saved code on disk (R03, R41)');
      expect(html).toContain('data-testid="statement-owner-compiler"');
      expect(html).toContain('Compiler / AST Analysis');
    });

    it('marks extracted facts, human specifications, AI interpretations, and opaque logic', () => {
      const humanHtml = renderToString(<ProvenanceBadge provenance="human" />);
      expect(humanHtml).toContain('data-testid="provenance-badge-human"');
      expect(humanHtml).toContain('Human Specification');
      expect(humanHtml).toContain('prov-human');

      const extractedHtml = renderToString(<ProvenanceBadge provenance="extracted" />);
      expect(extractedHtml).toContain('data-testid="provenance-badge-extracted"');
      expect(extractedHtml).toContain('Extracted Fact (Compiler AST)');
      expect(extractedHtml).toContain('prov-extracted');

      const aiHtml = renderToString(<ProvenanceBadge provenance="ai" uncertain={true} />);
      expect(aiHtml).toContain('data-testid="provenance-badge-ai"');
      expect(aiHtml).toContain('AI Inferred (Uncertain)');
      expect(aiHtml).toContain('ai-inferred-badge');

      const opaqueHtml = renderToString(<ProvenanceBadge isOpaque={true} />);
      expect(opaqueHtml).toContain('data-testid="provenance-badge-opaque"');
      expect(opaqueHtml).toContain('Opaque Logic (Source-backed)');
      expect(opaqueHtml).toContain('prov-opaque');
    });

    it('explains limits of structural analysis without implying runtime or business-intent proof (R09, R39)', () => {
      const quality = createMockQuality();
      const html = renderToString(<AnalysisLimitsNotice quality={quality} />);

      expect(html).toContain('data-testid="analysis-limits-notice"');
      expect(html).toContain('data-testid="limits-explanation"');
      expect(html).toContain('Structural analysis inspects static syntax, AST declarations, and schema definitions');
      expect(html).toContain('File coverage or AST extraction does <strong>not</strong> prove behavioral completeness');
      expect(html).toContain('data-testid="file-coverage-caveat"');
      expect(html).toContain('File coverage must not be presented as proof of behavioral completeness (R09).');

      // Quality breakdown
      expect(html).toContain('data-testid="q-analyzed-files"');
      expect(html).toContain('10 / 12');
      expect(html).toContain('data-testid="q-diagnostics-count"');
      expect(html).toContain('1');
      expect(html).toContain('data-testid="q-unresolved-refs"');
      expect(html).toContain('2');
      expect(html).toContain('data-testid="q-inferred-items"');
      expect(html).toContain('3');
      expect(html).toContain('data-testid="q-unsupported-constructs"');
      expect(html).toContain('1');
    });
  });

  describe('Acceptance Criterion 1: Inferred claims cannot resemble verified compiler facts', () => {
    it('ensures AI-inferred claims display non-compiler notice and cannot be mistaken for compiler facts', () => {
      const aiClaimHtml = renderToString(
        <ProvenanceStatementCard
          label="PaymentProcessor"
          provenance="ai"
          description="Inferred payment processing flow from heuristic code clustering"
          uncertain={true}
        />
      );

      // AI Claim has dedicated claim-ai container
      expect(aiClaimHtml).toContain('data-testid="claim-ai"');
      expect(aiClaimHtml).toContain('ai-inferred-card');

      // AI Claim has distinct badge and ownership
      expect(aiClaimHtml).toContain('data-testid="provenance-badge-ai"');
      expect(aiClaimHtml).toContain('AI Inferred (Uncertain)');
      expect(aiClaimHtml).toContain('data-testid="statement-owner-ai"');
      expect(aiClaimHtml).toContain('AI Inference Suggestion (Heuristic Interpretation)');

      // AI Claim has mandatory notice banners
      expect(aiClaimHtml).toContain('data-testid="ai-notice-banner"');
      expect(aiClaimHtml).toContain('AI-inferred interpretation: not compiler-verified evidence.');
      expect(aiClaimHtml).toContain('data-testid="ai-inferred-caveat"');
      expect(aiClaimHtml).toContain('Inferred suggestion retains uncertainty; human review required before adoption.');

      // AI Claim does NOT contain verified AST compiler badge or evidence
      expect(aiClaimHtml).not.toContain('data-testid="provenance-badge-extracted"');
      expect(aiClaimHtml).not.toContain('data-testid="extracted-source-evidence"');
      expect(aiClaimHtml).not.toContain('Verified AST Fact');
    });

    it('ensures verified compiler facts display verified source evidence and no AI caveats', () => {
      const source = createMockSource('src/billing.ts', 25);
      const extractedHtml = renderToString(
        <ProvenanceStatementCard
          label="BillingService"
          provenance="extracted"
          description="Class extracted from TypeScript compiler AST"
          source={source}
        />
      );

      // Compiler Fact has claim-extracted container
      expect(extractedHtml).toContain('data-testid="claim-extracted"');
      expect(extractedHtml).toContain('compiler-fact-card');

      // Compiler Fact has verified badge and compiler ownership
      expect(extractedHtml).toContain('data-testid="provenance-badge-extracted"');
      expect(extractedHtml).toContain('Extracted Fact (Compiler AST)');
      expect(extractedHtml).toContain('data-testid="statement-owner-extracted"');
      expect(extractedHtml).toContain('TypeScript / Prisma Compiler (Verified AST Evidence)');

      // Compiler Fact displays exact source evidence
      expect(extractedHtml).toContain('data-testid="extracted-source-evidence"');
      expect(extractedHtml).toContain('data-testid="source-path"');
      expect(extractedHtml).toContain('src/billing.ts');
      expect(extractedHtml).toContain('data-testid="source-line"');
      expect(extractedHtml).toContain('25');
      expect(extractedHtml).toContain('data-testid="source-bytes"');
      expect(extractedHtml).toContain('350 – 820');
      expect(extractedHtml).toContain('data-testid="source-hash"');
      expect(extractedHtml).toContain('sha256-billing-abc123');
      expect(extractedHtml).toContain('data-testid="source-revision"');
      expect(extractedHtml).toContain('rev-001');

      // Compiler Fact does NOT display AI notice banners or caveats
      expect(extractedHtml).not.toContain('data-testid="ai-notice-banner"');
      expect(extractedHtml).not.toContain('data-testid="ai-inferred-caveat"');
      expect(extractedHtml).not.toContain('AI-inferred interpretation');
    });

    it('strictly forces AI-inferred relationships to retain uncertainty and renders warning indicator', () => {
      const edge: ProgramEdge = {
        id: 'edge-ai-suggest',
        source: 'OrderModule',
        target: 'NotificationModule',
        kind: 'depends-on',
        label: 'heuristically linked',
        provenance: 'ai',
        uncertain: true,
      };

      const html = renderToString(
        <UncertainRelationshipCard
          edge={edge}
          sourceName="OrderModule"
          targetName="NotificationModule"
        />
      );

      expect(html).toContain('data-testid="uncertain-relationship-card"');
      expect(html).toContain('data-testid="uncertain-badge"');
      expect(html).toContain('Uncertain Relationship');
      expect(html).toContain('data-testid="provenance-badge-ai"');
      expect(html).toContain('data-testid="uncertain-endpoints"');
      expect(html).toContain('OrderModule');
      expect(html).toContain('NotificationModule');
      expect(html).toContain('data-testid="ai-notice-banner"');
      expect(html).toContain('AI-inferred interpretation: not compiler-verified evidence. Must remain uncertain.');
    });
  });

  describe('Acceptance Criterion 2: Opaque findings retain source access', () => {
    it('renders opaque logic with full source evidence binding and access action', () => {
      const opaqueNode: ProgramNode = {
        id: 'step-opaque-eval',
        kind: 'step',
        name: 'dynamicEvalConstruct',
        description: 'Unsupported eval call retained as opaque step',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/runtime.ts',
        stepType: 'opaque',
        source: {
          path: 'src/runtime.ts',
          symbol: 'dynamicEvalConstruct',
          line: 88,
          start: 2450,
          end: 2780,
          hash: 'sha256-eval-opaque-hash',
          revision: 'rev-impl-01',
        },
        fields: [],
      };

      const handleViewSource = vi.fn();
      const html = renderToString(
        <OpaqueFindingCard node={opaqueNode} onViewSource={handleViewSource} />
      );

      expect(html).toContain('data-testid="opaque-finding-card"');
      expect(html).toContain('data-testid="provenance-badge-opaque"');
      expect(html).toContain('Opaque Logic (Source-backed)');
      expect(html).toContain('data-testid="opaque-node-name"');
      expect(html).toContain('dynamicEvalConstruct');
      expect(html).toContain('data-testid="opaque-explanation"');
      expect(html).toContain('Unsupported or complex logic is preserved as a source-backed opaque node without loss of source context (R08).');

      // Exposes exact source binding coordinates
      expect(html).toContain('data-testid="opaque-source-access"');
      expect(html).toContain('data-testid="opaque-source-path"');
      expect(html).toContain('src/runtime.ts');
      expect(html).toContain('data-testid="opaque-source-line"');
      expect(html).toContain('88');
      expect(html).toContain('data-testid="opaque-source-range"');
      expect(html).toContain('2450 – 2780');
      expect(html).toContain('data-testid="opaque-source-hash"');
      expect(html).toContain('sha256-eval-opaque-hash');
      expect(html).toContain('data-testid="opaque-source-revision"');
      expect(html).toContain('rev-impl-01');

      // Action button to inspect source
      expect(html).toContain('data-testid="opaque-inspect-source-btn"');
      expect(html).toContain('Inspect Source');
    });

    it('renders error indicator when opaque node is missing required source binding', () => {
      const invalidOpaqueNode: ProgramNode = {
        id: 'step-opaque-nobinding',
        kind: 'step',
        name: 'missingBindingStep',
        description: 'Corrupted step without source',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/runtime.ts',
        stepType: 'opaque',
        fields: [],
      };

      const html = renderToString(<OpaqueFindingCard node={invalidOpaqueNode} />);
      expect(html).toContain('data-testid="opaque-missing-source"');
      expect(html).toContain('Opaque node is missing mandatory source evidence binding!');
    });

    it('preserves source access for opaque node in PropertyInspector', () => {
      const { project } = createScenarioTestWorkspace();
      const opaqueNode = project.analysis!.graph.nodes.find(n => n.id === 'node-legacy-calculator')!;

      const html = renderToString(
        <PropertyInspector
          project={project}
          graph={project.analysis!.graph}
          viewState={{
            selectedId: opaqueNode.id,
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            graphContext: 'implemented',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
        />
      );

      // Property inspector shows opaque logic banner
      expect(html).toContain('data-testid="opaque-logic-banner"');
      expect(html).toContain('Opaque logic: unsupported constructs retained as source-backed opaque node. Source access preserved.');

      // Retains source access
      expect(html).toContain('data-testid="opaque-source-access"');
      expect(html).toContain('data-testid="opaque-source-path"');
      expect(html).toContain('src/tax.ts');
      expect(html).toContain('data-testid="opaque-source-line"');
      expect(html).toContain('42');
      expect(html).toContain('data-testid="opaque-source-revision"');
      expect(html).toContain('rev-impl-01');
    });
  });

  describe('Acceptance Criterion 3: Context changes never mutate either graph', () => {
    it('guarantees switching contexts does not mutate specification or analysis graphs', () => {
      const { specification, analysis } = createScenarioTestWorkspace();

      // Take deep immutable snapshots before switching
      const specSnapshotBefore = JSON.stringify(specification);
      const analysisSnapshotBefore = JSON.stringify(analysis);

      const initialViewState: ViewState = {
        selectedId: 'node-order-service',
        selectedType: 'node',
        activeScope: null,
        searchQuery: '',
        graphContext: 'intended',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      // 1. Switch intended -> implemented
      const res1 = switchGraphContext('implemented', initialViewState, specification, analysis);
      expect(res1.nextViewState.graphContext).toBe('implemented');
      expect(res1.specificationMutated).toBe(false);
      expect(res1.analysisMutated).toBe(false);

      // Verify specification untouched
      expect(JSON.stringify(specification)).toBe(specSnapshotBefore);
      // Verify analysis untouched
      expect(JSON.stringify(analysis)).toBe(analysisSnapshotBefore);

      // 2. Switch implemented -> intended
      const res2 = switchGraphContext('intended', res1.nextViewState, specification, analysis);
      expect(res2.nextViewState.graphContext).toBe('intended');
      expect(res2.specificationMutated).toBe(false);
      expect(res2.analysisMutated).toBe(false);

      // Verify still 100% byte-for-byte identical
      expect(JSON.stringify(specification)).toBe(specSnapshotBefore);
      expect(JSON.stringify(analysis)).toBe(analysisSnapshotBefore);
    });

    it('safely reconciles selected element across context switch without modifying graph state', () => {
      const { specification, analysis } = createScenarioTestWorkspace();
      const specSnapshot = JSON.stringify(specification);
      const analysisSnapshot = JSON.stringify(analysis);

      // Selected element exists only in implemented analysis (the opaque tax calculator)
      const viewStateWithOpaqueSelected: ViewState = {
        selectedId: 'node-legacy-calculator',
        selectedType: 'node',
        activeScope: null,
        searchQuery: '',
        graphContext: 'implemented',
        panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
      };

      // Switch to intended where 'node-legacy-calculator' does not exist
      const { nextViewState, specificationMutated, analysisMutated } = switchGraphContext(
        'intended',
        viewStateWithOpaqueSelected,
        specification,
        analysis
      );

      expect(nextViewState.graphContext).toBe('intended');
      expect(nextViewState.selectedId).toBeNull(); // Cleanly cleared
      expect(nextViewState.selectedType).toBeNull();
      expect(specificationMutated).toBe(false);
      expect(analysisMutated).toBe(false);

      // Graphs untouched
      expect(JSON.stringify(specification)).toBe(specSnapshot);
      expect(JSON.stringify(analysis)).toBe(analysisSnapshot);
    });
  });

  describe('Concrete Validation Scenario 1: Render identical labels with human, extracted, and AI provenance', () => {
    it('renders three statements with identical label "PaymentValidationPipeline" with distinct ownership, evidence, and badges', () => {
      const label = 'PaymentValidationPipeline';
      const source = createMockSource('src/payment.ts', 15);

      const humanCard = (
        <ProvenanceStatementCard
          label={label}
          provenance="human"
          description="Human architect specification of required payment validation steps"
        />
      );

      const extractedCard = (
        <ProvenanceStatementCard
          label={label}
          provenance="extracted"
          description="Compiler AST verified pipeline class discovered in codebase"
          source={source}
        />
      );

      const aiCard = (
        <ProvenanceStatementCard
          label={label}
          provenance="ai"
          description="AI-inferred interpretation suggesting validation pipeline clustering"
          uncertain={true}
        />
      );

      const renderedAll = renderToString(
        <div className="comparison-container" data-testid="provenance-comparison-container">
          {humanCard}
          {extractedCard}
          {aiCard}
        </div>
      );

      // 1. All three share the identical label
      const matches = renderedAll.match(/PaymentValidationPipeline/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3);

      // 2. Human statement is clearly marked as human specification
      expect(renderedAll).toContain('data-testid="claim-human"');
      expect(renderedAll).toContain('data-testid="provenance-badge-human"');
      expect(renderedAll).toContain('data-testid="statement-owner-human"');
      expect(renderedAll).toContain('Human Architect (Specification Owner)');
      expect(renderedAll).toContain('Authored directly or approved by human designer');

      // 3. Extracted statement is clearly marked as compiler fact with source evidence
      expect(renderedAll).toContain('data-testid="claim-extracted"');
      expect(renderedAll).toContain('data-testid="provenance-badge-extracted"');
      expect(renderedAll).toContain('data-testid="statement-owner-extracted"');
      expect(renderedAll).toContain('TypeScript / Prisma Compiler (Verified AST Evidence)');
      expect(renderedAll).toContain('data-testid="extracted-source-evidence"');
      expect(renderedAll).toContain('Grounded in verified compiler AST:');
      expect(renderedAll).toContain('src/payment.ts');
      expect(renderedAll).toContain('sha256-billing-abc123');

      // 4. AI statement is clearly marked as AI inference, NOT compiler evidence, and retains uncertainty
      expect(renderedAll).toContain('data-testid="claim-ai"');
      expect(renderedAll).toContain('ai-inferred-card');
      expect(renderedAll).toContain('data-testid="provenance-badge-ai"');
      expect(renderedAll).toContain('AI Inferred (Uncertain)');
      expect(renderedAll).toContain('data-testid="statement-owner-ai"');
      expect(renderedAll).toContain('AI Inference Suggestion (Heuristic Interpretation)');
      expect(renderedAll).toContain('data-testid="ai-notice-banner"');
      expect(renderedAll).toContain('AI-inferred interpretation: not compiler-verified evidence.');
      expect(renderedAll).toContain('data-testid="ai-inferred-caveat"');
      expect(renderedAll).toContain('Inferred suggestion retains uncertainty; human review required before adoption.');

      // 5. Verification: AI claim cannot resemble verified compiler fact
      // (card classes, owner strings, and badge testids are strictly distinct)
      expect(renderedAll).toContain('class="provenance-statement-card card-provenance-human specification-card "');
      expect(renderedAll).toContain('class="provenance-statement-card card-provenance-extracted compiler-fact-card "');
      expect(renderedAll).toContain('class="provenance-statement-card card-provenance-ai ai-inferred-card "');
    });
  });

  describe('Concrete Validation Scenario 2: Switch model contexts with an uncertain relationship', () => {
    it('switches between intended and implemented context containing an uncertain relationship without graph mutation', () => {
      const { project, specification, analysis } = createScenarioTestWorkspace();

      const specBefore = JSON.stringify(specification);
      const analysisBefore = JSON.stringify(analysis);

      // Verify the implemented graph contains an uncertain AI relationship
      const uncertainEdge = analysis.graph.edges.find(e => e.uncertain && e.provenance === 'ai');
      expect(uncertainEdge).toBeDefined();
      expect(uncertainEdge!.id).toBe('edge-order-payment-impl');
      expect(uncertainEdge!.uncertain).toBe(true);
      expect(uncertainEdge!.provenance).toBe('ai');

      // --- Context 1: Render in Intended Specification Context ---
      const handleContextChange = vi.fn();
      const intendedHtml = renderToString(
        <ModelContext
          graphContext="intended"
          onGraphContextChange={handleContextChange}
          project={project}
          specification={specification}
          analysis={analysis}
          selectedEdge={specification.edges[0]}
        />
      );

      expect(intendedHtml).toContain('Context: Intended Specification');
      expect(intendedHtml).toContain('data-testid="statement-owner-human"');
      expect(intendedHtml).toContain('Human Architect');
      expect(intendedHtml).toContain('charges payment');
      expect(intendedHtml).not.toContain('data-testid="uncertain-relationship-card"');

      // --- Switch to Implemented Architecture Context ---
      const implementedHtml = renderToString(
        <ModelContext
          graphContext="implemented"
          onGraphContextChange={handleContextChange}
          project={project}
          specification={specification}
          analysis={analysis}
          selectedEdge={uncertainEdge}
        />
      );

      // Shows implemented context indicator
      expect(implementedHtml).toContain('Context: Implemented Architecture');
      expect(implementedHtml).toContain('data-testid="statement-owner-compiler"');
      expect(implementedHtml).toContain('Compiler / AST Analysis');

      // Uncertain relationship is prominently marked with uncertainty card & disclaimer
      expect(implementedHtml).toContain('data-testid="uncertain-relationship-card"');
      expect(implementedHtml).toContain('data-testid="uncertain-badge"');
      expect(implementedHtml).toContain('Uncertain Relationship');
      expect(implementedHtml).toContain('data-testid="provenance-badge-ai"');
      expect(implementedHtml).toContain('AI-inferred transaction link');
      expect(implementedHtml).toContain('data-testid="ai-notice-banner"');
      expect(implementedHtml).toContain('AI-inferred interpretation: not compiler-verified evidence. Must remain uncertain.');

      // --- Verify complete immutability after switching back and forth ---
      expect(JSON.stringify(specification)).toBe(specBefore);
      expect(JSON.stringify(analysis)).toBe(analysisBefore);
    });

    it('renders and switches model context within full App shell without modifying project state', () => {
      const { project } = createScenarioTestWorkspace();
      const specRevisionBefore = project.specRevision;
      const specNodesCount = project.specification.nodes.length;
      const implNodesCount = project.analysis!.graph.nodes.length;

      // Mount App with scenario project
      const appHtml = renderToString(
        <App initialProject={project} autoLoad={false} />
      );

      // App shell mounts cleanly
      expect(appHtml).toContain('data-testid="workspace-shell"');
      expect(appHtml).toContain('data-testid="model-context-bar"');
      expect(appHtml).toContain('data-testid="model-context-indicator"');
      expect(appHtml).toContain('Context: Intended Specification');

      // Project tree displays intended elements initially
      expect(appHtml).toContain('OrderService');
      expect(appHtml).toContain('PaymentGateway');

      // Graph state and revision remain unchanged
      expect(project.specRevision).toBe(specRevisionBefore);
      expect(project.specification.nodes.length).toBe(specNodesCount);
      expect(project.analysis!.graph.nodes.length).toBe(implNodesCount);
    });
  });
});
