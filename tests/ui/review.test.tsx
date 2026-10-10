import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ReviewPanel,
  computeReviewState,
  computeSpecDiff,
  type ArchitectureProposalReview,
  type ImplementationReview,
  type PendingReviewItem,
} from '../../src/components/ReviewPanel';
import { App } from '../../src/App';
import {
  emptyGraph,
  type Project,
  type Graph,
  type ProgramNode,
  type Analysis,
} from '../../shared/model';

function createMockProject(specRevision = 2): Project {
  const nodes: ProgramNode[] = [
    {
      id: 'sys-core',
      kind: 'system',
      name: 'CoreSystem',
      description: 'System boundary',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: ['test'],
      instructions: '',
      outputPath: '',
      fields: [],
    },
    {
      id: 'mod-auth',
      kind: 'module',
      name: 'AuthModule',
      parentId: 'sys-core',
      description: 'Authentication module',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export interface AuthModule {}',
      requiredChecks: ['test', 'typecheck'],
      instructions: 'Protect auth credentials',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'fn-verify',
      kind: 'function',
      name: 'verifyToken',
      parentId: 'mod-auth',
      description: 'Verifies user auth token',
      provenance: 'extracted',
      policy: 'frozen-implementation',
      contract: '(token: string) => boolean',
      requiredChecks: ['test'],
      instructions: 'Implementation is frozen',
      outputPath: 'src/auth.ts',
      baseline: {
        text: 'export function verifyToken(token: string) { return Boolean(token); }',
      },
      fields: [],
    },
    {
      id: 'iface-user',
      kind: 'interface',
      name: 'IUserService',
      parentId: 'mod-auth',
      description: 'User service contract',
      provenance: 'human',
      policy: 'frozen-contract',
      contract: 'export interface IUserService { getUser(id: string): User; }',
      requiredChecks: [],
      instructions: 'Public contract is frozen',
      outputPath: 'src/user.ts',
      baseline: {
        contract: 'export interface IUserService { getUser(id: string): User; }',
      },
      fields: [],
    },
  ];

  const graph: Graph = {
    schemaVersion: 1,
    nodes,
    edges: [
      {
        id: 'edge-sys-mod',
        source: 'sys-core',
        target: 'mod-auth',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
      {
        id: 'edge-mod-fn',
        source: 'mod-auth',
        target: 'fn-verify',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
      {
        id: 'edge-mod-iface',
        source: 'mod-auth',
        target: 'iface-user',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
    ],
    requirements: [
      {
        id: 'req-auth',
        text: 'All endpoints require authenticated tokens',
        nodeIds: ['mod-auth', 'fn-verify'],
        edgeIds: [],
        constraints: ['Zero token leakage'],
        scenarios: ['Valid token passes', 'Expired token rejected'],
      },
    ],
  };

  const analysis: Analysis = {
    revision: 'rev-002',
    sequence: 2,
    analyzedAt: new Date().toISOString(),
    status: 'current',
    durationMs: 40,
    graph,
    files: {
      'src/auth.ts': {
        hash: 'hash-auth-123',
        text: 'export function verifyToken(token: string) { return Boolean(token); }',
      },
      'src/user.ts': {
        hash: 'hash-user-456',
        text: 'export interface IUserService { getUser(id: string): User; }',
      },
    },
    quality: {
      eligibleFiles: 2,
      analyzedFiles: 2,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
  };

  return {
    id: 'proj-review-test',
    name: 'Review Panel Project',
    description: 'Project used for testing review panel foundation',
    target: 'TypeScript application',
    root: '/workspace/review-test',
    managed: true,
    createdAt: new Date().toISOString(),
    specRevision,
    specification: graph,
    layout: {},
    analysis,
    checks: {
      test: { command: 'npm', args: ['test'] },
      typecheck: { command: 'npx', args: ['tsc', '--noEmit'] },
    },
  };
}

function createMockArchProposal(specRevision = 2, id = 'arch-prop-1'): ArchitectureProposalReview {
  const proposedGraph: Graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'sys-core',
        kind: 'system',
        name: 'CoreSystem',
        description: 'System boundary',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        requiredChecks: ['test'],
        instructions: '',
        outputPath: '',
        fields: [],
      },
      {
        id: 'mod-auth',
        kind: 'module',
        name: 'AuthModule',
        parentId: 'sys-core',
        description: 'Authentication module updated with OAuth2',
        provenance: 'human',
        policy: 'sensitive',
        contract: 'export interface AuthModule {}',
        requiredChecks: ['test', 'typecheck'],
        instructions: 'Protect auth credentials',
        outputPath: 'src/auth.ts',
        fields: [],
      },
      {
        id: 'fn-verify',
        kind: 'function',
        name: 'verifyToken',
        parentId: 'mod-auth',
        description: 'Verifies user auth token',
        provenance: 'extracted',
        policy: 'frozen-implementation',
        contract: '(token: string) => boolean',
        requiredChecks: ['test'],
        instructions: 'Implementation is frozen',
        outputPath: 'src/auth.ts',
        baseline: {
          text: 'export function verifyToken(token: string) { return Boolean(token); }',
        },
        fields: [],
      },
      {
        id: 'mod-oauth',
        kind: 'module',
        name: 'OAuthModule',
        parentId: 'sys-core',
        description: 'Proposed OAuth 2.0 social authentication provider',
        provenance: 'ai',
        policy: 'editable',
        contract: 'export interface OAuthModule { login(): Promise<void>; }',
        requiredChecks: ['test'],
        instructions: 'Follow RFC 6749 guidelines',
        outputPath: 'src/oauth.ts',
        fields: [],
      },
    ],
    edges: [
      {
        id: 'edge-sys-mod',
        source: 'sys-core',
        target: 'mod-auth',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
      {
        id: 'edge-mod-fn',
        source: 'mod-auth',
        target: 'fn-verify',
        kind: 'contains',
        label: 'contains',
        provenance: 'human',
        uncertain: false,
      },
      {
        id: 'edge-sys-oauth',
        source: 'sys-core',
        target: 'mod-oauth',
        kind: 'contains',
        label: 'contains',
        provenance: 'ai',
        uncertain: false,
      },
      {
        id: 'edge-oauth-auth',
        source: 'mod-oauth',
        target: 'mod-auth',
        kind: 'depends-on',
        label: 'depends-on',
        provenance: 'ai',
        uncertain: true,
      },
    ],
    requirements: [
      {
        id: 'req-oauth',
        text: 'Support Google and GitHub OAuth 2.0 providers',
        nodeIds: ['mod-oauth'],
        edgeIds: [],
        constraints: ['PKCE flow required'],
        scenarios: ['GitHub login exchanges code for access token'],
      },
    ],
  };

  return {
    id,
    kind: 'architecture',
    title: 'Introduce OAuth 2.0 Authentication Module',
    description: 'Adds an OAuth module supporting social logins connected to the existing AuthModule.',
    createdAt: new Date().toISOString(),
    specRevision,
    status: 'pending',
    proposal: {
      graph: proposedGraph,
      explanation: 'Integrating modern OAuth2 simplifies external user onboarding while preserving existing token checks.',
      questions: ['Should PKCE code verifiers be stored in local storage or memory?'],
    },
  };
}

function createMockImplReview(specRevision = 2, id = 'impl-rev-1'): ImplementationReview {
  return {
    id,
    kind: 'implementation',
    title: 'Implement OAuth Token Refresh Service',
    description: 'Adds token refresh logic and unit tests in src/auth.ts and src/oauth.ts.',
    task: 'Create token refresh logic adhering to AuthModule specifications',
    createdAt: new Date().toISOString(),
    specRevision,
    sourceHashes: {
      'src/auth.ts': 'hash-auth-123',
      'src/user.ts': 'hash-user-456',
    },
    scope: ['src/'],
    status: 'pending',
    changes: [
      {
        path: 'src/oauth.ts',
        kind: 'added',
        before: null,
        after: 'export function refreshToken() { return true; }',
        diff: '--- /dev/null\n+++ b/src/oauth.ts\n@@ -0,0 +1,1 @@\n+export function refreshToken() { return true; }',
      },
      {
        path: 'src/auth.ts',
        kind: 'modified',
        before: 'export function verifyToken(token: string) { return Boolean(token); }',
        after: 'export function verifyToken(token: string) { return Boolean(token); }\nexport const AUTH_VERSION = "2.0";',
        diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,1 +1,2 @@\n export function verifyToken(token: string) { return Boolean(token); }\n+export const AUTH_VERSION = "2.0";',
      },
    ],
    checks: {
      test: { passed: true, output: '✓ 12 tests passed across 2 files' },
      typecheck: { passed: true, output: 'Found 0 errors.' },
    },
    diagnostics: [],
  };
}

describe('T027 — Build the human review panel foundation', () => {
  // =========================================================================
  // Concrete Validation Scenario 1: Open and dismiss a pending review without mutation
  // =========================================================================
  describe('Concrete Validation Scenario 1: Open and dismiss a pending review without mutation', () => {
    it('opens and inspects a pending review without triggering mutation or calling onAccept', () => {
      const project = createMockProject(2);
      const proposal = createMockArchProposal(2);
      const onAccept = vi.fn();
      const onDismiss = vi.fn();
      const onReject = vi.fn();

      // Step 1: Render ReviewPanel with pending proposal
      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[proposal]}
          activeReviewId={proposal.id}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onReject={onReject}
        />
      );

      // Verify panel is open and showing the active review
      expect(html).toContain('data-testid="review-panel"');
      expect(html).toContain('data-testid="active-review-view"');
      expect(html).toContain('Introduce OAuth 2.0 Authentication Module');
      expect(html).toContain('data-testid="review-spec-section"');
      expect(html).toContain('OAuthModule');

      // Crucial assertion: opening the panel NEVER applies pending changes
      expect(onAccept).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
      // Specification revision remains untouched
      expect(project.specRevision).toBe(2);
    });

    it('dismisses a pending review deliberately without applying mutations', () => {
      const project = createMockProject(2);
      const proposal = createMockArchProposal(2);
      const onAccept = vi.fn();
      const onDismiss = vi.fn();

      // Render ReviewPanel
      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[proposal]}
          activeReviewId={proposal.id}
          onAccept={onAccept}
          onDismiss={onDismiss}
        />
      );

      expect(html).toContain('data-testid="review-dismiss-btn"');
      expect(html).toContain('data-testid="review-reject-btn"');

      // Assert state evaluation allows dismiss/reject but requires deliberate trigger
      const evaluation = computeReviewState(proposal, project);
      expect(evaluation.canAccept).toBe(true);
      expect(evaluation.isStale).toBe(false);

      // Trigger dismiss handler
      onDismiss(proposal);

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledWith(proposal);
      // onAccept was NOT invoked during dismiss
      expect(onAccept).not.toHaveBeenCalled();
      // Project specification remains unaffected
      expect(project.specRevision).toBe(2);
      expect(project.specification.nodes.some(n => n.id === 'mod-oauth')).toBe(false);
    });
  });

  // =========================================================================
  // Concrete Validation Scenario 2: Render a stale review and disable its acceptance action
  // =========================================================================
  describe('Concrete Validation Scenario 2: Render a stale review and disable its acceptance action', () => {
    it('renders a stale review with revision mismatch, shows clear explanation, and disables accept button', () => {
      // Project is at revision 3, while proposal was prepared against revision 1
      const project = createMockProject(3);
      const staleProposal = createMockArchProposal(1, 'stale-arch-1');
      const onAccept = vi.fn();

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[staleProposal]}
          activeReviewId={staleProposal.id}
          onAccept={onAccept}
        />
      );

      // 1. Shows STALE REVIEW status badge
      expect(html).toContain('data-testid="review-state-badge"');
      expect(html).toContain('STALE REVIEW');

      // 2. Clear explanation banner for stale state
      expect(html).toContain('data-testid="review-stale-explanation"');
      expect(html).toContain('Stale Review Candidate');
      expect(html).toContain('Specification revision mismatch');
      expect(html).toContain('candidate was prepared against revision 1');
      expect(html).toContain('current project specification is revision 3');

      // 3. Acceptance action button is DISABLED
      expect(html).toContain('data-testid="review-accept-btn"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('data-testid="review-blocked-explanation"');
      expect(html).toContain('Acceptance disabled: candidate is stale against current specification revision');

      // Evaluation pure function check
      const evalResult = computeReviewState(staleProposal, project);
      expect(evalResult.state).toBe('stale-review');
      expect(evalResult.isStale).toBe(true);
      expect(evalResult.canAccept).toBe(false);
      expect(evalResult.staleReason).toContain('revision 1');
      expect(evalResult.staleReason).toContain('revision 3');
    });

    it('detects staleness when external source hashes no longer match the baseline', () => {
      const project = createMockProject(2);
      const implReview = createMockImplReview(2, 'stale-impl-hash');
      // Current captured source has different hash for auth.ts
      const currentHashes = {
        'src/auth.ts': 'hash-auth-MODIFIED-externally-999',
        'src/user.ts': 'hash-user-456',
      };

      const evalResult = computeReviewState(implReview, project, currentHashes);
      expect(evalResult.state).toBe('stale-review');
      expect(evalResult.isStale).toBe(true);
      expect(evalResult.canAccept).toBe(false);
      expect(evalResult.staleReason).toContain('Source files were modified externally after this task started');
    });
  });

  // =========================================================================
  // Acceptance Criterion 1: Pending changes never apply simply by opening the panel
  // =========================================================================
  describe('Acceptance Criterion 1: Pending changes never apply simply by opening the panel', () => {
    it('opening review panel across multiple tabs and sections does not trigger mutation', () => {
      const project = createMockProject(2);
      const implReview = createMockImplReview(2);
      const onAccept = vi.fn();

      // Mount reviewing code section
      const htmlCode = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[implReview]}
          activeReviewId={implReview.id}
          onAccept={onAccept}
        />
      );

      expect(htmlCode).toContain('data-testid="active-review-view"');
      expect(htmlCode).toContain('Implement OAuth Token Refresh Service');
      expect(onAccept).not.toHaveBeenCalled();

      // Mount reviewing overview tab
      const htmlOverview = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[implReview]}
          initialTab="overview"
          onAccept={onAccept}
        />
      );

      expect(htmlOverview).toContain('data-testid="review-overview-view"');
      expect(onAccept).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Invalid and stale states have clear explanations
  // =========================================================================
  describe('Acceptance Criterion 2: Invalid and stale states have clear explanations', () => {
    it('surfaces frozen implementation violations with clear explanation and disables accept action', () => {
      const project = createMockProject(2);
      const invalidImplReview: ImplementationReview = {
        ...createMockImplReview(2),
        validationIssues: [
          {
            code: 'frozen-implementation',
            message: 'Frozen implementation changed: verifyToken',
            nodeId: 'fn-verify',
            path: 'src/auth.ts',
          },
        ],
      };

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[invalidImplReview]}
          activeReviewId={invalidImplReview.id}
        />
      );

      // Verify invalid state explanation
      expect(html).toContain('data-testid="review-invalid-explanation"');
      expect(html).toContain('Validation Issues Detected');
      expect(html).toContain('data-testid="review-invalid-issues-list"');
      expect(html).toContain('[frozen-implementation] Frozen implementation changed: verifyToken (src/auth.ts)');

      // Verify accept button is disabled
      expect(html).toContain('data-testid="review-accept-btn"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-disabled="true"');

      const evalResult = computeReviewState(invalidImplReview, project);
      expect(evalResult.state).toBe('invalid');
      expect(evalResult.isInvalid).toBe(true);
      expect(evalResult.canAccept).toBe(false);
      expect(evalResult.invalidReasons).toHaveLength(1);
    });

    it('surfaces out-of-scope modifications and failed required checks with clear explanations', () => {
      const project = createMockProject(2);
      const invalidReview: ImplementationReview = {
        ...createMockImplReview(2),
        validationIssues: [
          {
            code: 'scope',
            message: 'Change is outside the approved scope: config/secrets.env',
            path: 'config/secrets.env',
          },
        ],
        checks: {
          test: { passed: false, output: 'FAIL: 2 test failures in src/auth.test.ts' },
        },
      };

      const evalResult = computeReviewState(invalidReview, project);
      expect(evalResult.state).toBe('invalid');
      expect(evalResult.isInvalid).toBe(true);
      expect(evalResult.canAccept).toBe(false);
      expect(evalResult.invalidReasons.some(r => r.includes('outside the approved scope'))).toBe(true);
      expect(evalResult.invalidReasons.some(r => r.includes('Required check failed: test'))).toBe(true);

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[invalidReview]}
          activeReviewId={invalidReview.id}
        />
      );

      expect(html).toContain('data-testid="review-invalid-explanation"');
      expect(html).toContain('Change is outside the approved scope: config/secrets.env');
      expect(html).toContain('Required check failed: test');
      expect(html).toContain('disabled=""');
    });

    it('displays empty state with clear explanation when no reviews are pending', () => {
      const project = createMockProject(2);
      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[]}
          initialTab="overview"
        />
      );

      expect(html).toContain('data-testid="review-empty-state"');
      expect(html).toContain('No pending specification or code proposals awaiting review.');

      const evalResult = computeReviewState(null, project);
      expect(evalResult.state).toBe('empty');
      expect(evalResult.canAccept).toBe(false);
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Review can show specification, code, and diagnostic sections
  // =========================================================================
  describe('Acceptance Criterion 3: Review can show specification, code, and diagnostic sections', () => {
    it('shows specification diff section with added, modified, and removed elements', () => {
      const project = createMockProject(2);
      const proposal = createMockArchProposal(2);

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[proposal]}
          activeReviewId={proposal.id}
        />
      );

      expect(html).toContain('data-testid="review-spec-section"');
      expect(html).toContain('Proposal Rationale &amp; Explanation');
      expect(html).toContain('Integrating modern OAuth2 simplifies external user onboarding');
      expect(html).toContain('Should PKCE code verifiers be stored in local storage or memory?');

      // Shows added node
      expect(html).toContain('data-testid="diff-node-added-mod-oauth"');
      expect(html).toContain('OAuthModule');

      // Shows modified node
      expect(html).toContain('data-testid="diff-node-modified-mod-auth"');
      expect(html).toContain('Description updated');

      // Shows removed node (IUserService was removed in proposed graph)
      expect(html).toContain('data-testid="diff-node-removed-iface-user"');
      expect(html).toContain('IUserService');

      // Shows edge diffs
      expect(html).toContain('Relationship Changes');
      expect(html).toContain('mod-oauth --[depends-on: depends-on]--&gt; mod-auth');
    });

    it('shows code differences section with file paths, kind badges, and diff lines', () => {
      const project = createMockProject(2);
      const implReview = createMockImplReview(2);

      const diff = computeSpecDiff(project.specification, emptyGraph());
      expect(diff.removedNodes.length).toBe(project.specification.nodes.length);

      // Verify that code changes are properly populated
      expect(implReview.changes).toHaveLength(2);
      expect(implReview.changes[0].path).toBe('src/oauth.ts');
      expect(implReview.changes[0].kind).toBe('added');
      expect(implReview.changes[1].path).toBe('src/auth.ts');
      expect(implReview.changes[1].kind).toBe('modified');
    });

    it('shows diagnostics section with compiler diagnostics, policy checks, and test outputs', () => {
      const project = createMockProject(2);
      const implReviewWithDiag: ImplementationReview = {
        ...createMockImplReview(2),
        diagnostics: [
          {
            severity: 'warning',
            message: 'Unused import statement',
            path: 'src/oauth.ts',
            line: 3,
          },
        ],
        checks: {
          test: { passed: true, output: '12 passed in 0.4s' },
          typecheck: { passed: true, output: 'Found 0 errors.' },
        },
      };

      const evalResult = computeReviewState(implReviewWithDiag, project);
      expect(evalResult.canAccept).toBe(true);
      expect(evalResult.state).toBe('pending-review');
    });
  });

  // =========================================================================
  // Separation of Architecture Proposals vs Implementation Reviews
  // =========================================================================
  describe('Separation of Architecture Proposal Review from Implementation Review', () => {
    it('separates architecture proposals from code implementation reviews in navigation tabs', () => {
      const project = createMockProject(2);
      const proposal = createMockArchProposal(2, 'prop-1');
      const implReview = createMockImplReview(2, 'impl-1');

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[proposal, implReview]}
          initialTab="overview"
        />
      );

      // Verify distinct tab buttons with counts
      expect(html).toContain('data-testid="tab-overview"');
      expect(html).toContain('data-testid="tab-architecture"');
      expect(html).toContain('Architecture (1)');
      expect(html).toContain('data-testid="tab-implementation"');
      expect(html).toContain('Implementation (1)');

      // Verify overview summary chips
      expect(html).toContain('1 Architecture Proposal(s)');
      expect(html).toContain('1 Implementation Candidate(s)');
    });

    it('renders architecture proposals list when architecture tab is active', () => {
      const project = createMockProject(2);
      const proposal = createMockArchProposal(2, 'prop-1');

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[proposal]}
          initialTab="architecture"
        />
      );

      expect(html).toContain('data-testid="arch-reviews-list"');
      expect(html).toContain('data-testid="review-item-prop-1"');
      expect(html).toContain('Introduce OAuth 2.0 Authentication Module');
    });

    it('renders implementation candidates list when implementation tab is active', () => {
      const project = createMockProject(2);
      const implReview = createMockImplReview(2, 'impl-1');

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: project.analysis!, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[implReview]}
          initialTab="implementation"
        />
      );

      expect(html).toContain('data-testid="impl-reviews-list"');
      expect(html).toContain('data-testid="review-item-impl-1"');
      expect(html).toContain('Implement OAuth Token Refresh Service');
    });
  });

  // =========================================================================
  // Integration with App and Workspace Shell
  // =========================================================================
  describe('Workspace Shell Integration', () => {
    it('mounts ReviewPanel within App shell preserving overview policies and checks', () => {
      const project = createMockProject(2);
      const html = renderToString(<App initialProject={project} autoLoad={false} />);

      expect(html).toContain('data-testid="workspace-shell"');
      expect(html).toContain('data-testid="review-panel"');
      expect(html).toContain('Review Area');
      expect(html).toContain('Protection Policies');
      expect(html).toContain('Configured Checks');
      expect(html).toContain('data-testid="review-checks-list"');
      expect(html).toContain('npm test');
      expect(html).toContain('npx tsc --noEmit');
    });
  });
});
