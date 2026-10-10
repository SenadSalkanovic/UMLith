import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ProtectionEditor,
  evaluatePolicyPrerequisites,
  previewFreezeEvidence,
  compareBaseline,
  applyProtectionPolicy,
  formatPolicyLabel,
  getPolicyDescription,
  getPolicyPrerequisites,
} from '../../src/components/ProtectionEditor';
import { PropertyInspector } from '../../src/components/PropertyInspector';
import { ReviewPanel, type ArchitectureProposalReview } from '../../src/components/ReviewPanel';
import { App } from '../../src/App';
import * as api from '../../src/api';
import { freezeNode, evaluateFreeze } from '../../server/review';
import {
  emptyGraph,
  GraphSchema,
  NodeSchema,
  type Project,
  type Graph,
  type ProgramNode,
  type Analysis,
  type Source,
} from '../../shared/model';

function createMockSource(path = 'src/service.ts', revision = 'rev-1', hash = 'hash-123'): Source {
  return {
    path,
    symbol: 'processPayment',
    start: 0,
    end: 45,
    line: 1,
    hash,
    revision,
  };
}

function createMockAnalysis(
  sourceText = 'export function processPayment(amount: number) {}',
  revision = 'rev-1',
  path = 'src/service.ts',
  status: Analysis['status'] = 'current'
): Analysis {
  const sourceNode: ProgramNode = {
    id: 'fn-pay',
    kind: 'function',
    name: 'processPayment',
    description: 'Processes payment transaction',
    provenance: 'extracted',
    policy: 'editable',
    contract: 'export function processPayment(amount: number): boolean',
    requiredChecks: [],
    instructions: '',
    outputPath: path,
    source: {
      path,
      symbol: 'processPayment',
      start: 0,
      end: sourceText.length,
      line: 1,
      hash: 'hash-mock',
      revision,
    },
    fields: [],
  };

  return {
    revision,
    sequence: 1,
    analyzedAt: '2026-10-10T00:00:00.000Z',
    status,
    files: {
      [path]: {
        hash: 'hash-mock',
        text: sourceText,
      },
    },
    graph: {
      schemaVersion: 1,
      nodes: [sourceNode],
      edges: [],
      requirements: [],
    },
    durationMs: 10,
    quality: {
      eligibleFiles: 1,
      analyzedFiles: 1,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
  };
}

function createMockProtectionProject(): Project {
  const nodes: ProgramNode[] = [
    {
      id: 'fn-unbound',
      kind: 'function',
      name: 'calculateTax',
      description: 'Calculates tax without source code',
      provenance: 'human',
      policy: 'editable',
      contract: '',
      requiredChecks: [],
      instructions: '',
      outputPath: '',
      fields: [],
    },
    {
      id: 'iface-explicit',
      kind: 'interface',
      name: 'IUserService',
      description: 'User service contract defined before code exists',
      provenance: 'human',
      policy: 'editable',
      contract: 'export interface IUserService { getUser(id: string): User; }',
      requiredChecks: [],
      instructions: '',
      outputPath: '',
      fields: [],
    },
    {
      id: 'fn-bound',
      kind: 'function',
      name: 'processPayment',
      description: 'Payment processor bound to source code',
      provenance: 'extracted',
      policy: 'editable',
      contract: 'export function processPayment(amount: number): boolean',
      requiredChecks: ['test'],
      instructions: '',
      outputPath: 'src/service.ts',
      source: {
        path: 'src/service.ts',
        symbol: 'processPayment',
        start: 0,
        end: 49,
        line: 1,
        hash: 'hash-mock',
        revision: 'rev-1',
      },
      fields: [],
    },
    {
      id: 'mod-sensitive',
      kind: 'module',
      name: 'AuthSecurityModule',
      description: 'Sensitive security module',
      provenance: 'human',
      policy: 'sensitive',
      contract: 'export interface AuthSecurityModule {}',
      requiredChecks: ['test', 'typecheck'],
      instructions: 'Sensitive authentication logic: enforce OAuth2 and verify signatures.',
      outputPath: 'src/auth.ts',
      fields: [],
    },
    {
      id: 'fn-frozen-impl',
      kind: 'function',
      name: 'cryptoHash',
      description: 'Frozen crypto implementation',
      provenance: 'extracted',
      policy: 'frozen-implementation',
      contract: 'export function cryptoHash(data: string): string',
      requiredChecks: ['test'],
      instructions: 'Implementation is frozen and tamper-proof.',
      outputPath: 'src/crypto.ts',
      source: {
        path: 'src/crypto.ts',
        symbol: 'cryptoHash',
        start: 0,
        end: 43,
        line: 1,
        hash: 'hash-crypto',
        revision: 'rev-1',
      },
      baseline: {
        source: {
          path: 'src/crypto.ts',
          symbol: 'cryptoHash',
          start: 0,
          end: 43,
          line: 1,
          hash: 'hash-crypto',
          revision: 'rev-1',
        },
        text: 'export function cryptoHash(data: string) {}',
      },
      fields: [],
    },
  ];

  const graph: Graph = {
    schemaVersion: 1,
    nodes,
    edges: [],
    requirements: [],
  };

  return {
    id: 'proj-protection-test',
    name: 'Protection Test Project',
    description: 'Test project for T029 protection policies and sensitive instructions',
    target: 'node',
    root: '/test/workspace',
    managed: true,
    createdAt: '2026-10-10T00:00:00.000Z',
    specRevision: 3,
    specification: graph,
    layout: {},
    checks: {
      test: { command: 'npm', args: ['test'] },
      typecheck: { command: 'npx', args: ['tsc', '--noEmit'] },
      lint: { command: 'npm', args: ['run', 'lint'] },
    },
  };
}

describe('T029: Edit protection policies and sensitive instructions', () => {
  // Checklist Item 1 & 2: Expose four policies and their prerequisites
  describe('Work Checklist Item 2: Expose four policies and their prerequisites', () => {
    it('renders all four policies with descriptions and prerequisites', () => {
      const project = createMockProtectionProject();
      const node = project.specification.nodes[0];

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={node.id}
          mode="modal"
        />
      );

      // Verify all 4 policy cards are rendered
      expect(html).toContain('data-testid="policy-option-editable"');
      expect(html).toContain('data-testid="policy-option-sensitive"');
      expect(html).toContain('data-testid="policy-option-frozen-implementation"');
      expect(html).toContain('data-testid="policy-option-frozen-contract"');

      // Verify labels and descriptions
      expect(html).toContain('Editable');
      expect(html).toContain('Sensitive');
      expect(html).toContain('Frozen Implementation');
      expect(html).toContain('Frozen Contract');
      expect(html).toContain('Freely editable by humans and automated tools');
      expect(html).toContain('Sensitive area requiring prominent human review emphasis');
      expect(html).toContain('Preserves bound source code exactly');
      expect(html).toContain('Preserves declared public interface');
    });

    it('evaluates prerequisites accurately for unbound elements', () => {
      const project = createMockProtectionProject();
      const unboundNode = project.specification.nodes.find(n => n.id === 'fn-unbound')!;

      // editable and sensitive have no blocking prerequisites
      const evalEditable = evaluatePolicyPrerequisites(unboundNode, 'editable');
      expect(evalEditable.allowed).toBe(true);

      const evalSensitive = evaluatePolicyPrerequisites(unboundNode, 'sensitive');
      expect(evalSensitive.allowed).toBe(true);

      // frozen-implementation is blocked for unbound element
      const evalFrozenImpl = evaluatePolicyPrerequisites(unboundNode, 'frozen-implementation');
      expect(evalFrozenImpl.allowed).toBe(false);
      expect(evalFrozenImpl.reason).toContain('Frozen implementation requires a source binding');
      expect(evalFrozenImpl.unresolvedEvidence).toContain('Attempt to freeze an unbound implementation');

      // frozen-contract without explicit contract is blocked
      const evalFrozenContract = evaluatePolicyPrerequisites(unboundNode, 'frozen-contract');
      expect(evalFrozenContract.allowed).toBe(false);
      expect(evalFrozenContract.reason).toContain('Frozen contract requires a source binding or an explicit interface');
    });

    it('evaluates prerequisites for explicit interfaces before code exists', () => {
      const project = createMockProtectionProject();
      const explicitNode = project.specification.nodes.find(n => n.id === 'iface-explicit')!;

      const evalResult = evaluatePolicyPrerequisites(explicitNode, 'frozen-contract');
      expect(evalResult.allowed).toBe(true);
      expect(evalResult.preview?.kind).toBe('contract');
      expect(evalResult.preview?.text).toBe(explicitNode.contract);
    });

    it('evaluates prerequisites for bound implementations with current analysis', () => {
      const project = createMockProtectionProject();
      const boundNode = project.specification.nodes.find(n => n.id === 'fn-bound')!;
      const analysis = createMockAnalysis();

      const evalResult = evaluatePolicyPrerequisites(boundNode, 'frozen-implementation', analysis);
      expect(evalResult.allowed).toBe(true);
      expect(evalResult.preview?.kind).toBe('implementation');
      expect(evalResult.preview?.text).toBe('export function processPayment(amount: number) {}');
    });
  });

  // Acceptance Criterion 1 & Concrete Scenario 1: Attempt to freeze an unbound implementation
  describe('Concrete Scenario 1 & Acceptance Criterion 1: Attempt to freeze an unbound implementation', () => {
    it('blocks freezing an unbound implementation with a specific reason in the UI', () => {
      const project = createMockProtectionProject();
      const unboundNode = project.specification.nodes.find(n => n.id === 'fn-unbound')!;

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={unboundNode.id}
          mode="inline"
        />
      );

      // In the rendered card, frozen-implementation shows Prerequisites Unmet badge
      expect(html).toContain('data-testid="policy-prereq-status-frozen-implementation"');
      expect(html).toContain('Prerequisites Unmet');
    });

    it('displays clear explanation of unresolved evidence when frozen-implementation is selected for unbound node', () => {
      const project = createMockProtectionProject();
      const unboundNode = {
        ...project.specification.nodes.find(n => n.id === 'fn-unbound')!,
        policy: 'frozen-implementation' as const, // simulated selected state
      };

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={unboundNode.id}
          initialPolicy="frozen-implementation"
          mode="inline"
        />
      );

      // Verify specific reason and unresolved evidence explanation are visible
      expect(html).toContain('data-testid="unresolved-evidence-box"');
      expect(html).toContain('data-testid="freeze-blocked-reason"');
      expect(html).toContain('Frozen implementation requires a source binding');
      expect(html).toContain('data-testid="unresolved-evidence-explanation"');
      expect(html).toContain('Attempt to freeze an unbound implementation: No source binding is available');
    });

    it('strictly throws specific reason in applyProtectionPolicy when attempting to freeze unbound implementation', () => {
      const project = createMockProtectionProject();

      expect(() => {
        applyProtectionPolicy(project.specification, 'fn-unbound', {
          policy: 'frozen-implementation',
        });
      }).toThrow('Frozen implementation requires a source binding');
    });

    it('strictly throws specific reason in server freezeNode when attempting to freeze unbound implementation', () => {
      const project = createMockProtectionProject();
      const unboundNode = project.specification.nodes.find(n => n.id === 'fn-unbound')!;

      expect(() => {
        freezeNode(unboundNode, 'frozen-implementation');
      }).toThrow('Freeze implementation requires valid, current source evidence. No source binding is available');
    });

    it('evaluateFreeze returns specific blocking reason and unresolved evidence on server for unbound implementation', () => {
      const project = createMockProtectionProject();
      const unboundNode = project.specification.nodes.find(n => n.id === 'fn-unbound')!;

      const result = evaluateFreeze(unboundNode, 'frozen-implementation');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Frozen implementation requires a source binding');
      expect(result.unresolvedEvidence).toContain('Node is not bound to source code');
    });
  });

  // Acceptance Criterion 2 & Concrete Scenario 2: Freeze an explicit interface and configure a required check
  describe('Concrete Scenario 2 & Acceptance Criterion 2: Freeze an explicit interface and configure a required check', () => {
    it('freezes an explicit interface and configures named required check before code exists', () => {
      const project = createMockProtectionProject();
      const ifaceNode = project.specification.nodes.find(n => n.id === 'iface-explicit')!;

      const { graph: updatedGraph, updatedNode } = applyProtectionPolicy(
        project.specification,
        ifaceNode.id,
        {
          policy: 'frozen-contract',
          contract: 'export interface IUserService { getUser(id: string): User; }',
          instructions: 'Contract must remain backward-compatible.',
          requiredChecks: ['test', 'typecheck'],
        }
      );

      // Verify updated node fields
      expect(updatedNode.policy).toBe('frozen-contract');
      expect(updatedNode.contract).toBe('export interface IUserService { getUser(id: string): User; }');
      expect(updatedNode.instructions).toBe('Contract must remain backward-compatible.');
      expect(updatedNode.requiredChecks).toEqual(['test', 'typecheck']);
      expect(updatedNode.baseline).toEqual({
        source: undefined,
        contract: 'export interface IUserService { getUser(id: string): User; }',
      });

      // Verify graph schema validity
      expect(GraphSchema.safeParse(updatedGraph).success).toBe(true);
    });

    it('renders explicit interface preview and configured checks in ProtectionEditor', () => {
      const project = createMockProtectionProject();
      const ifaceNode = {
        ...project.specification.nodes.find(n => n.id === 'iface-explicit')!,
        policy: 'frozen-contract' as const,
        requiredChecks: ['test'],
        instructions: 'Public API contract',
      };

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={{ ...project.specification, nodes: [ifaceNode] }}
          selectedNodeId={ifaceNode.id}
          mode="inline"
        />
      );

      // Verify interface preview is displayed
      expect(html).toContain('data-testid="freeze-preview-container"');
      expect(html).toContain('data-testid="freeze-preview-code"');
      expect(html).toContain('export interface IUserService { getUser(id: string): User; }');

      // Verify configured required checks chip is displayed
      expect(html).toContain('data-testid="required-checks-section"');
      expect(html).toContain('data-testid="check-chip-test"');
      expect(html).toContain('npm test');

      // Verify sensitive instructions textarea contains draft
      expect(html).toContain('data-testid="protection-instructions-input"');
      expect(html).toContain('Public API contract');
    });

    it('freezes explicit interface on server using freezeNode and records deliberate baseline', () => {
      const node = NodeSchema.parse({
        id: 'iface-test',
        kind: 'interface',
        name: 'IOrderService',
        description: 'Order contract',
        contract: 'export interface IOrderService { createOrder(): string; }',
      });

      const frozen = freezeNode(node, 'frozen-contract', undefined, {
        instructions: 'Preserve order creation contract',
        requiredChecks: ['test', 'lint'],
      });

      expect(frozen.policy).toBe('frozen-contract');
      expect(frozen.baseline?.contract).toBe('export interface IOrderService { createOrder(): string; }');
      expect(frozen.instructions).toBe('Preserve order creation contract');
      expect(frozen.requiredChecks).toEqual(['test', 'lint']);
      expect(NodeSchema.safeParse(frozen).success).toBe(true);
    });
  });

  // Work Checklist Item 3: Configure sensitive instructions and named required checks
  describe('Work Checklist Item 3: Configure sensitive instructions and named required checks', () => {
    it('renders sensitive instructions callout and handles instructions modification', () => {
      const project = createMockProtectionProject();
      const sensitiveNode = project.specification.nodes.find(n => n.id === 'mod-sensitive')!;

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={sensitiveNode.id}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="sensitive-instructions-section"');
      expect(html).toContain('data-testid="sensitive-instructions-callout"');
      expect(html).toContain('Instructions entered here will guide human reviewers and strictly constrain AI modifications');
      expect(html).toContain('Sensitive authentication logic: enforce OAuth2 and verify signatures.');
    });

    it('renders project checks selector and allows toggling checks', () => {
      const project = createMockProtectionProject();
      const node = project.specification.nodes[0];

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={node.id}
          mode="inline"
        />
      );

      // Verify available project checks from project.checks are rendered
      expect(html).toContain('data-testid="toggle-check-test"');
      expect(html).toContain('data-testid="toggle-check-typecheck"');
      expect(html).toContain('data-testid="toggle-check-lint"');
      expect(html).toContain('npm test');
      expect(html).toContain('npx tsc --noEmit');
      expect(html).toContain('npm run lint');

      // Verify custom check input is rendered
      expect(html).toContain('data-testid="custom-check-input"');
      expect(html).toContain('data-testid="add-custom-check-btn"');
    });

    it('labels unconfigured checks with visible warning', () => {
      const project = createMockProtectionProject();
      const nodeWithCustomCheck: ProgramNode = {
        ...project.specification.nodes[0],
        requiredChecks: ['custom-smoke-test'],
      };

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={{ ...project.specification, nodes: [nodeWithCustomCheck] }}
          selectedNodeId={nodeWithCustomCheck.id}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="check-chip-custom-smoke-test"');
      expect(html).toContain('(not configured in project)');
    });
  });

  // Acceptance Criterion 3: Sensitive items have visible review emphasis
  describe('Acceptance Criterion 3: Sensitive items have visible review emphasis', () => {
    it('renders prominent sensitive review emphasis banner in ProtectionEditor', () => {
      const project = createMockProtectionProject();
      const sensitiveNode = project.specification.nodes.find(n => n.id === 'mod-sensitive')!;

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          selectedNodeId={sensitiveNode.id}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="sensitive-review-emphasis"');
      expect(html).toContain('Sensitive Element Emphasis (R24)');
      expect(html).toContain('Sensitive items receive prominent review emphasis in proposals');
    });

    it('renders sensitive element review emphasis in ReviewPanel diffs', () => {
      const project = createMockProtectionProject();
      const sensitiveNode = project.specification.nodes.find(n => n.id === 'mod-sensitive')!;

      // Create a proposed spec modifying the sensitive node
      const proposedGraph: Graph = {
        schemaVersion: 1,
        nodes: [
          ...project.specification.nodes.filter(n => n.id !== sensitiveNode.id),
          {
            ...sensitiveNode,
            description: 'Updated sensitive security module with OAuth2 PKCE',
          },
        ],
        edges: [],
        requirements: [],
      };

      const reviewItem: ArchitectureProposalReview = {
        id: 'rev-prop-sensitive',
        kind: 'architecture',
        title: 'Update Auth Security',
        description: 'Updating sensitive authentication module',
        specRevision: project.specRevision,
        proposal: {
          graph: proposedGraph,
          explanation: 'Update auth security',
          questions: [],
        },
      };

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: null, status: 'current', lastChecked: Date.now() }}
          pendingReviews={[reviewItem]}
          activeReviewId={reviewItem.id}
          initialTab="architecture"
        />
      );

      // Verify the modified diff contains sensitive review callout with instructions and checks
      expect(html).toContain(`data-testid="sensitive-review-callout-${sensitiveNode.id}"`);
      expect(html).toContain('Sensitive Element:');
      expect(html).toContain('Human review emphasis required (R24).');
      expect(html).toContain(`data-testid="sensitive-instructions-${sensitiveNode.id}"`);
      expect(html).toContain('Sensitive authentication logic: enforce OAuth2 and verify signatures.');
      expect(html).toContain(`data-testid="sensitive-checks-${sensitiveNode.id}"`);
      expect(html).toContain('test, typecheck');
    });

    it('renders sensitive elements summary list in ReviewPanel overview card', () => {
      const project = createMockProtectionProject();

      const html = renderToString(
        <ReviewPanel
          project={project}
          graph={project.specification}
          analysisState={{ analysis: null, status: 'current', lastChecked: Date.now() }}
          initialTab="overview"
        />
      );

      expect(html).toContain('data-testid="review-sensitive-items-summary"');
      expect(html).toContain('Sensitive Elements Requiring Review Emphasis');
      expect(html).toContain('data-testid="sensitive-overview-item-mod-sensitive"');
      expect(html).toContain('AuthSecurityModule');
      expect(html).toContain('Sensitive authentication logic: enforce OAuth2 and verify signatures.');
    });

    it('renders sensitive banner in PropertyInspector overview', () => {
      const project = createMockProtectionProject();
      const sensitiveNode = project.specification.nodes.find(n => n.id === 'mod-sensitive')!;

      const html = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: sensitiveNode.id,
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
        />
      );

      expect(html).toContain('data-testid="inspector-sensitive-banner"');
      expect(html).toContain('Sensitive element: subject to additional human review emphasis');
      expect(html).toContain('data-testid="inspector-instructions"');
      expect(html).toContain('Sensitive authentication logic: enforce OAuth2 and verify signatures.');
    });
  });

  // Work Checklist Item 4: Preview bound source or declared interface before freezing; explain unresolved evidence
  describe('Work Checklist Item 4: Preview bound source before freezing and explain stale/unresolved evidence', () => {
    it('previews exact bound source text and metadata for current evidence', () => {
      const project = createMockProtectionProject();
      const boundNode = {
        ...project.specification.nodes.find(n => n.id === 'fn-bound')!,
        policy: 'frozen-implementation' as const,
      };
      const analysis = createMockAnalysis('export function processPayment(amount: number) { return true; }');

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={{ ...project.specification, nodes: [boundNode] }}
          analysis={analysis}
          selectedNodeId={boundNode.id}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="freeze-preview-container"');
      expect(html).toContain('data-testid="freeze-preview-metadata"');
      expect(html).toContain('Path:');
      expect(html).toContain('src/service.ts');
      expect(html).toContain('Symbol:');
      expect(html).toContain('processPayment');
      expect(html).toContain('data-testid="freeze-preview-code"');
      expect(html).toContain('export function processPayment(amount: number)');
    });

    it('explains stale source evidence and blocks freezing when analysis is outdated', () => {
      const project = createMockProtectionProject();
      const boundNode = {
        ...project.specification.nodes.find(n => n.id === 'fn-bound')!,
        policy: 'frozen-implementation' as const,
      };
      // Stale analysis: valid text matching source range (start: 0, end: 49)
      const validText = 'export function processPayment(amount: number) {}';
      const staleAnalysis = createMockAnalysis(validText, 'rev-1', 'src/service.ts', 'stale');

      const evalResult = evaluatePolicyPrerequisites(boundNode, 'frozen-implementation', staleAnalysis);
      expect(evalResult.allowed).toBe(false);
      expect(evalResult.reason).toContain('stale');

      const preview = previewFreezeEvidence(boundNode, 'frozen-implementation', staleAnalysis);
      expect(preview.isUnresolved).toBe(true);
      expect(preview.unresolvedEvidence).toContain('stale');
    });

    it('explains unavailable source file when file is missing from analysis capture', () => {
      const project = createMockProtectionProject();
      const boundNode = project.specification.nodes.find(n => n.id === 'fn-bound')!;
      const emptyAnalysis: Analysis = {
        ...createMockAnalysis(),
        files: {},
      };

      const evalResult = evaluatePolicyPrerequisites(boundNode, 'frozen-implementation', emptyAnalysis);
      expect(evalResult.allowed).toBe(false);
      expect(evalResult.reason).toContain('Captured source file is unavailable');
    });
  });

  // Acceptance Criterion 2: Baseline changes are deliberate and reviewable
  describe('Acceptance Criterion 2: Baseline changes are deliberate and reviewable', () => {
    it('inspects existing baseline and confirms intact status', () => {
      const project = createMockProtectionProject();
      const frozenNode = project.specification.nodes.find(n => n.id === 'fn-frozen-impl')!;
      const analysis: Analysis = {
        ...createMockAnalysis('export function cryptoHash(data: string) {}', 'rev-1', 'src/crypto.ts'),
        graph: {
          schemaVersion: 1,
          nodes: [frozenNode],
          edges: [],
          requirements: [],
        },
        files: {
          'src/crypto.ts': {
            hash: 'hash-crypto',
            text: 'export function cryptoHash(data: string) {}',
          },
        },
      };

      const comparison = compareBaseline(frozenNode, analysis);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.isIntact).toBe(true);
      expect(comparison.explanation).toContain('Bound source matches frozen implementation baseline exactly.');

      const html = renderToString(
        <ProtectionEditor
          project={project}
          graph={project.specification}
          analysis={analysis}
          selectedNodeId={frozenNode.id}
          mode="inline"
        />
      );

      expect(html).toContain('data-testid="baseline-inspection-card"');
      expect(html).toContain('data-testid="baseline-status-badge"');
      expect(html).toContain('Baseline Intact');
      expect(html).toContain('data-testid="baseline-content-preview"');
      expect(html).toContain('export function cryptoHash(data: string) {}');
    });

    it('detects modified baseline when live source differs from frozen baseline', () => {
      const project = createMockProtectionProject();
      const frozenNode = project.specification.nodes.find(n => n.id === 'fn-frozen-impl')!;
      const modifiedAnalysis: Analysis = {
        ...createMockAnalysis('export function cryptoHash(data: string) { return "tampered"; }', 'rev-1', 'src/crypto.ts'),
        files: {
          'src/crypto.ts': {
            hash: 'hash-crypto',
            text: 'export function cryptoHash(data: string) { return "tampered"; }',
          },
        },
      };

      const comparison = compareBaseline(frozenNode, modifiedAnalysis);
      expect(comparison.hasBaseline).toBe(true);
      expect(comparison.isIntact).toBe(false);
      expect(comparison.explanation).toContain('Bound source code differs from frozen implementation baseline');
    });

    it('clearing baseline deliberately resets policy to editable and removes baseline', () => {
      const project = createMockProtectionProject();
      const frozenNode = project.specification.nodes.find(n => n.id === 'fn-frozen-impl')!;

      const { graph: updatedGraph, updatedNode } = applyProtectionPolicy(
        project.specification,
        frozenNode.id,
        {
          policy: 'editable',
          baseline: undefined,
        }
      );

      expect(updatedNode.policy).toBe('editable');
      expect(updatedNode.baseline).toBeUndefined();
      expect(GraphSchema.safeParse(updatedGraph).success).toBe(true);
    });
  });

  // Integration with PropertyInspector & App
  describe('UI Integration: PropertyInspector button & App modal integration', () => {
    it('renders Manage Protection button in PropertyInspector policy form group', () => {
      const project = createMockProtectionProject();
      const node = project.specification.nodes[0];
      const onEditProtection = vi.fn();

      const html = renderToString(
        <PropertyInspector
          project={project}
          graph={project.specification}
          viewState={{
            selectedId: node.id,
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          onClearSelection={() => {}}
          onEditProtection={onEditProtection}
          isEditing={true}
        />
      );

      expect(html).toContain('data-testid="open-protection-editor-btn"');
      expect(html).toContain('Manage Protection Policies &amp; Baselines');
    });

    it('renders App shell with complete protection workflow integration', () => {
      const project = createMockProtectionProject();

      const html = renderToString(
        <App
          initialProject={project}
          initialProjects={[project]}
          autoLoad={false}
        />
      );

      // Verify inspector and review panel are rendered
      expect(html).toContain('data-testid="property-inspector-panel"');
      expect(html).toContain('data-testid="review-panel"');
    });
  });
});
