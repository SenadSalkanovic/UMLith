import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { BindingReview } from '../../src/components/BindingReview';
import { ReviewPanel } from '../../src/components/ReviewPanel';
import {
  NodeSchema,
  type BindingReviewRecord,
  type Project,
  type Source,
} from '../../shared/model';

function mockSource(path: string, line = 1, start = 0, end = 50, symbol?: string): Source {
  return {
    path,
    symbol,
    start,
    end,
    line,
    hash: 'hash_' + path.replace(/[^a-zA-Z0-9]/g, '_'),
    revision: 'r1',
  };
}

function createMockProject(): Project {
  return {
    id: 'proj-binding-test',
    name: 'BindingTestProject',
    description: 'Test project for binding review UI',
    target: 'TypeScript application',
    root: '/tmp/proj-binding-test',
    managed: false,
    createdAt: new Date().toISOString(),
    specRevision: 2,
    specification: {
      schemaVersion: 1,
      nodes: [
        NodeSchema.parse({
          id: 'fn-auth-1',
          kind: 'function',
          name: 'authenticateUser',
          policy: 'frozen-implementation',
          contract: '(user: string) => boolean',
          baseline: {
            text: 'export function authenticateUser(user: string): boolean { return user === "admin"; }',
            source: mockSource('src/legacy-auth.ts', 10, 200, 280, 'authenticateUser'),
          },
          source: mockSource('src/legacy-auth.ts', 10, 200, 280, 'authenticateUser'),
        }),
      ],
      edges: [],
      requirements: [],
    },
    layout: {},
    layoutRevision: 0,
    scopedLayouts: {},
    checks: {},
  };
}

describe('BindingReview Component', () => {
  const sampleAmbiguousRecord: BindingReviewRecord = {
    nodeId: 'fn-auth-1',
    nodeName: 'authenticateUser',
    kind: 'function',
    policy: 'frozen-implementation',
    status: 'ambiguous',
    contract: '(user: string) => boolean',
    reason: 'Ambiguous move/rename detected for protected item: 2 matching candidate declarations found across the codebase.',
    currentBinding: mockSource('src/legacy-auth.ts', 10, 200, 280, 'authenticateUser'),
    baseline: {
      text: 'export function authenticateUser(user: string): boolean { return user === "admin"; }',
      source: mockSource('src/legacy-auth.ts', 10, 200, 280),
    },
    candidates: [
      {
        id: 'cand-v1',
        name: 'authenticateUser',
        kind: 'function',
        source: mockSource('src/v1/auth.ts', 25, 500, 585),
        contract: '(user: string) => boolean',
        evidenceText: 'export function authenticateUser(user: string): boolean {\n  return user === "admin";\n}',
        matchReason: 'Identical function signature and exact symbol match in src/v1/auth.ts',
      },
      {
        id: 'cand-v2',
        name: 'authenticateUser',
        kind: 'function',
        source: mockSource('src/v2/auth.ts', 40, 900, 990),
        contract: '(user: string) => boolean',
        evidenceText: 'export function authenticateUser(user: string): boolean {\n  return checkUserRole(user);\n}',
        matchReason: 'Identical function signature and exact symbol match in src/v2/auth.ts',
      },
    ],
  };

  const sampleUnresolvedRecord: BindingReviewRecord = {
    nodeId: 'fn-gate-2',
    nodeName: 'verifySecurityGate',
    kind: 'function',
    policy: 'frozen-contract',
    status: 'unresolved',
    contract: 'verifySecurityGate(gateId: string): boolean',
    reason: 'Protected item cannot be resolved: symbol "verifySecurityGate" was not found in analyzed files.',
    currentBinding: mockSource('src/gate.ts', 5, 100, 150, 'verifySecurityGate'),
    baseline: {
      contract: 'verifySecurityGate(gateId: string): boolean',
    },
    candidates: [],
  };

  it('renders metrics summary bar with accurate status counts', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord, sampleUnresolvedRecord]}
      />
    );

    expect(html).toContain('data-testid="binding-review-metrics"');
    expect(html).toContain('data-testid="count-total"');
    expect(html).toContain('>2<'); // total = 2
    expect(html).toContain('data-testid="count-ambiguous"');
    expect(html).toContain('>1<'); // ambiguous = 1
    expect(html).toContain('data-testid="count-unresolved"');
    expect(html).toContain('>1<'); // unresolved = 1
  });

  it('renders blocking alert when protected items have ambiguous or unresolved bindings', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord, sampleUnresolvedRecord]}
      />
    );

    expect(html).toContain('data-testid="unresolved-protection-warning"');
    expect(html).toContain('Unresolved protection blocks verification');
    expect(html).toContain('Automatic sync will never reset baseline content');
  });

  it('renders old binding details including path, line number, range, and hash', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord]}
        selectedNodeId="fn-auth-1"
      />
    );

    expect(html).toContain('data-testid="old-binding-section"');
    expect(html).toContain('data-testid="old-binding-path"');
    expect(html).toContain('src/legacy-auth.ts');
    expect(html).toContain('data-testid="old-binding-line"');
    expect(html).toContain('Line 10');
    expect(html).toContain('data-testid="old-binding-range"');
    expect(html).toContain('Line 10 (chars 200..280)');
    expect(html).toContain('data-testid="old-binding-symbol"');
    expect(html).toContain('authenticateUser');
  });

  it('renders protected baseline section with explicit baseline retention notice', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord]}
        selectedNodeId="fn-auth-1"
      />
    );

    expect(html).toContain('data-testid="protected-baseline-section"');
    expect(html).toContain('data-testid="baseline-retention-notice"');
    expect(html).toContain('Baseline Retention Policy: Accepting a candidate rebinding strictly retains this original baseline');
    expect(html).toContain('data-testid="baseline-content"');
    expect(html).toContain('export function authenticateUser(user: string): boolean { return user === &quot;admin&quot;; }');
  });

  it('renders candidate declarations list with paths, lines, evidence snippet, and accept button', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord]}
        selectedNodeId="fn-auth-1"
      />
    );

    expect(html).toContain('data-testid="candidates-section"');
    expect(html).toContain('Candidate Declarations');
    expect(html).toContain('data-testid="candidate-item-cand-v1"');
    expect(html).toContain('data-testid="candidate-path-cand-v1"');
    expect(html).toContain('src/v1/auth.ts');
    expect(html).toContain('data-testid="candidate-range-cand-v1"');
    expect(html).toContain('Line 25 (chars 500..585)');
    expect(html).toContain('data-testid="candidate-evidence-cand-v1"');
    expect(html).toContain('export function authenticateUser(user: string): boolean');
    expect(html).toContain('data-testid="accept-binding-btn-cand-v1"');
    expect(html).toContain('Accept Binding (Keep Baseline)');

    expect(html).toContain('data-testid="candidate-item-cand-v2"');
    expect(html).toContain('src/v2/auth.ts');
    expect(html).toContain('Line 40 (chars 900..990)');
  });

  it('disables accept buttons when readOnly is true', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleAmbiguousRecord]}
        selectedNodeId="fn-auth-1"
        readOnly={true}
      />
    );

    expect(html).toContain('disabled="" data-testid="accept-binding-btn-cand-v1"');
    expect(html).toContain('disabled="" data-testid="accept-binding-btn-cand-v2"');
  });

  it('renders unresolved item with empty candidate list and unresolved declaration explanation', () => {
    const html = renderToString(
      <BindingReview
        bindingReviews={[sampleUnresolvedRecord]}
        selectedNodeId="fn-gate-2"
      />
    );

    expect(html).toContain('data-testid="no-candidates-message"');
    expect(html).toContain('Declaration not found in analyzed source');
    expect(html).toContain('Unresolved protected items remain unverified until the declaration is restored or explicitly updated');
  });
});

describe('ReviewPanel Bindings Tab Integration', () => {
  it('displays tab-bindings button with count badge and ambiguous alert banner', () => {
    const project = createMockProject();
    const records: BindingReviewRecord[] = [
      {
        nodeId: 'fn-auth-1',
        nodeName: 'authenticateUser',
        kind: 'function',
        policy: 'frozen-implementation',
        status: 'ambiguous',
        contract: '',
        reason: 'Ambiguous move',
        currentBinding: mockSource('src/old.ts', 1, 0, 50),
        candidates: [],
      },
    ];

    const html = renderToString(
      <ReviewPanel
        project={project}
        graph={project.specification}
        analysisState={{ status: 'current', analysis: null, lastChecked: Date.now() }}
        bindingReviews={records}
        initialTab="overview"
      />
    );

    expect(html).toContain('data-testid="tab-bindings"');
    expect(html).toContain('Bindings (1)');
    expect(html).toContain('data-testid="ambiguous-bindings-alert"');
    expect(html).toContain('Source Binding Reviews');
    expect(html).toContain('Ambiguous renames or moves require binding review before changes can apply. Baselines are preserved.');
  });

  it('embeds BindingReview component when initialTab is bindings', () => {
    const project = createMockProject();
    const records: BindingReviewRecord[] = [
      {
        nodeId: 'fn-auth-1',
        nodeName: 'authenticateUser',
        kind: 'function',
        policy: 'frozen-implementation',
        status: 'ambiguous',
        contract: '',
        reason: 'Ambiguous move',
        currentBinding: mockSource('src/old.ts', 1, 0, 50),
        candidates: [],
      },
    ];

    const html = renderToString(
      <ReviewPanel
        project={project}
        graph={project.specification}
        analysisState={{ status: 'current', analysis: null, lastChecked: Date.now() }}
        bindingReviews={records}
        initialTab="bindings"
      />
    );

    expect(html).toContain('data-testid="binding-review-panel"');
    expect(html).toContain('Source Binding Review');
  });
});
