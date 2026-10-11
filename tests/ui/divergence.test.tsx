import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DivergencePanel } from '../../src/components/DivergencePanel';
import { ReviewPanel } from '../../src/components/ReviewPanel';
import {
  NodeSchema,
  type DivergenceReport,
  type Project,
} from '../../shared/model';

function createSampleDivergenceReport(overrides?: Partial<DivergenceReport>): DivergenceReport {
  return {
    projectId: 'test-project',
    revision: 'rev_1234567890abcdef',
    sequence: 5,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    items: [
      {
        id: 'div-viol-1',
        nodeId: 'node-auth',
        nodeName: 'authenticate',
        nodeKind: 'function',
        policy: 'frozen-implementation',
        kind: 'frozen-implementation-violation',
        category: 'protection-violation',
        isDeterministicDefect: true,
        message: "Frozen implementation changed for 'authenticate'",
        details: 'External edit modified source code inside frozen implementation boundary without authorization.',
        evidence: {
          path: 'src/auth.ts',
          line: 12,
          start: 200,
          end: 280,
          hash: 'hash_auth_new',
          revision: 'rev_1234567890abcdef',
          symbol: 'authenticate',
          expectedText: 'export function authenticate() { return false; }',
          actualText: 'export function authenticate() { return true; }',
          snippet: 'export function authenticate() { return true; }',
        },
      },
      {
        id: 'div-drift-2',
        nodeId: 'node-tax',
        nodeName: 'calculateTax',
        nodeKind: 'function',
        policy: 'editable',
        kind: 'contract-drift',
        category: 'structural-drift',
        isDeterministicDefect: false,
        message: "Implemented contract for 'calculateTax' drifted from intended specification",
        details: 'Source code declaration differs from human specification contract.',
        evidence: {
          path: 'src/tax.ts',
          line: 45,
          expectedContract: 'calculateTax(amount: number): number',
          actualContract: 'calculateTax(amount: number, state?: string): number',
        },
      },
      {
        id: 'div-uncertain-3',
        kind: 'uncertain-intent',
        category: 'uncertainty',
        isDeterministicDefect: false,
        message: '2 call targets retain runtime uncertainty',
        details: 'Static compiler analysis could not resolve all call targets.',
      },
    ],
    summary: {
      totalDrift: 3,
      protectionViolations: 1,
      structuralDriftCount: 1,
      uncertainCount: 1,
      hasBlockingViolations: true,
    },
    ...overrides,
  };
}

function createCleanDivergenceReport(): DivergenceReport {
  return {
    projectId: 'test-project',
    revision: 'rev_clean_123',
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    items: [],
    summary: {
      totalDrift: 0,
      protectionViolations: 0,
      structuralDriftCount: 0,
      uncertainCount: 0,
      hasBlockingViolations: false,
    },
  };
}

function createMockProject(): Project {
  const source = {
    path: 'src/auth.ts',
    symbol: 'authenticate',
    start: 0,
    end: 45,
    line: 1,
    hash: 'hash_auth_init',
    revision: 'rev_init',
  };
  return {
    id: 'test-project',
    name: 'DivergenceTestProject',
    description: 'Test project for divergence UI',
    target: 'TypeScript application',
    root: '/tmp/test-project',
    managed: false,
    createdAt: new Date().toISOString(),
    specRevision: 3,
    specification: {
      schemaVersion: 1,
      nodes: [
        NodeSchema.parse({
          id: 'node-auth',
          kind: 'function',
          name: 'authenticate',
          policy: 'frozen-implementation',
          contract: 'authenticate(): boolean',
          source,
          baseline: {
            text: 'export function authenticate() { return false; }',
            source,
          },
        }),
      ],
      edges: [],
      requirements: [],
    },
    layout: {},
    checks: {},
  };
}

describe('DivergencePanel UI Component', () => {
  it('renders status badges, revision info, and baseline preservation notice', () => {
    const report = createSampleDivergenceReport();
    const html = renderToString(<DivergencePanel report={report} />);

    expect(html).toContain('data-testid="divergence-panel"');
    expect(html).toContain('data-testid="divergence-revision-badge"');
    expect(html).toContain('rev_123456');
    expect(html).toContain('Sequence: #5');
    expect(html).toContain('data-testid="divergence-status-badge"');
    expect(html).toContain('CURRENT');
    expect(html).toContain('data-testid="baseline-retention-notice"');
    expect(html).toContain('Baseline Integrity Preserved');
  });

  it('renders blocking violations banner and summary metric counts', () => {
    const report = createSampleDivergenceReport();
    const html = renderToString(<DivergencePanel report={report} />);

    expect(html).toContain('data-testid="blocking-violations-banner"');
    expect(html).toContain('Blocking Protection Violations Detected');

    expect(html).toContain('data-testid="divergence-total-count"');
    expect(html).toContain('>3<');
    expect(html).toContain('data-testid="divergence-violations-count"');
    expect(html).toContain('>1<');
    expect(html).toContain('data-testid="divergence-structural-count"');
    expect(html).toContain('data-testid="divergence-uncertain-count"');
  });

  it('clearly separates deterministic protection defects from non-defect drift and uncertainty', () => {
    const report = createSampleDivergenceReport();
    const html = renderToString(<DivergencePanel report={report} />);

    // Violation item: Deterministic defect badge
    expect(html).toContain('data-testid="divergence-item-div-viol-1"');
    expect(html).toContain('data-testid="badge-defect-div-viol-1"');
    expect(html).toContain('Deterministic Protection Defect');

    // Structural drift item: Non-defect badge
    expect(html).toContain('data-testid="divergence-item-div-drift-2"');
    expect(html).toContain('data-testid="badge-defect-div-drift-2"');
    expect(html).toContain('Non-Defect Drift / Intent Observation');

    // Uncertain item
    expect(html).toContain('data-testid="divergence-item-div-uncertain-3"');
    expect(html).toContain('data-testid="badge-defect-div-uncertain-3"');
  });

  it('renders evidence details and expected vs actual diff previews', () => {
    const report = createSampleDivergenceReport();
    const html = renderToString(<DivergencePanel report={report} />);

    expect(html).toContain('data-testid="evidence-div-viol-1"');
    expect(html).toContain('src/auth.ts');
    expect(html).toContain('data-testid="evidence-expected-div-viol-1"');
    expect(html).toContain('return false;');
    expect(html).toContain('data-testid="evidence-actual-div-viol-1"');
    expect(html).toContain('return true;');
  });

  it('renders clean empty state when no divergence exists', () => {
    const report = createCleanDivergenceReport();
    const html = renderToString(<DivergencePanel report={report} />);

    expect(html).toContain('data-testid="divergence-empty-state"');
    expect(html).toContain('No Divergence Detected');
    expect(html).not.toContain('data-testid="blocking-violations-banner"');
  });
});

describe('ReviewPanel Divergence Tab Integration', () => {
  it('renders Divergence tab button with total count in ReviewPanel navigation', () => {
    const project = createMockProject();
    const report = createSampleDivergenceReport();
    const html = renderToString(
      <ReviewPanel
        project={project}
        graph={project.specification}
        analysisState={{ status: 'current', analysis: null, lastChecked: Date.now() }}
        divergenceReport={report}
      />
    );

    expect(html).toContain('data-testid="tab-divergence"');
    expect(html).toContain('Divergence (3)');
  });

  it('renders Overview divergence banner when divergence exists and allows opening details', () => {
    const project = createMockProject();
    const report = createSampleDivergenceReport();
    const html = renderToString(
      <ReviewPanel
        project={project}
        graph={project.specification}
        analysisState={{ status: 'current', analysis: null, lastChecked: Date.now() }}
        divergenceReport={report}
        initialTab="overview"
      />
    );

    expect(html).toContain('data-testid="overview-divergence-banner"');
    expect(html).toContain('data-testid="btn-overview-open-divergence"');
    expect(html).toContain('View Details (3)');
    expect(html).toContain('blocking protection violation(s) detected');
  });

  it('renders DivergencePanel inside review-divergence-container when activeTab is divergence', () => {
    const project = createMockProject();
    const report = createSampleDivergenceReport();
    const html = renderToString(
      <ReviewPanel
        project={project}
        graph={project.specification}
        analysisState={{ status: 'current', analysis: null, lastChecked: Date.now() }}
        divergenceReport={report}
        initialTab="divergence"
      />
    );

    expect(html).toContain('data-testid="review-divergence-container"');
    expect(html).toContain('data-testid="divergence-panel"');
    expect(html).toContain('data-testid="divergence-items-list"');
  });
});
