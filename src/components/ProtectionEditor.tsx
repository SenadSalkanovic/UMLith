import React, { useState, useEffect, useMemo } from 'react';
import type { Graph, ProgramNode, Analysis, Project } from '../../shared/model';
import {
  policies,
  resolveSourceEvidence,
  NodeSchema,
  GraphSchema,
} from '../../shared/model';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Unlock,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  FileCode,
  FileText,
  ListPlus,
  Trash2,
  Plus,
  Info,
  X,
  Save,
  RefreshCw,
  ExternalLink,
  Tag,
} from 'lucide-react';

export interface FreezePreview {
  kind: 'implementation' | 'contract';
  text: string;
  source?: ProgramNode['source'];
}

export interface PolicyPrerequisiteResult {
  allowed: boolean;
  policy: ProgramNode['policy'];
  reason?: string;
  unresolvedEvidence?: string;
  preview?: FreezePreview;
}

export interface BaselineComparison {
  hasBaseline: boolean;
  isIntact: boolean;
  explanation: string;
  baselineContent?: string;
  liveContent?: string;
}

/**
 * Returns user-facing label for a policy.
 */
export function formatPolicyLabel(policy: ProgramNode['policy']): string {
  switch (policy) {
    case 'editable':
      return 'Editable';
    case 'sensitive':
      return 'Sensitive';
    case 'frozen-implementation':
      return 'Frozen Implementation';
    case 'frozen-contract':
      return 'Frozen Contract';
    default:
      return policy;
  }
}

/**
 * Returns description of policy behavior.
 */
export function getPolicyDescription(policy: ProgramNode['policy']): string {
  switch (policy) {
    case 'editable':
      return 'Freely editable by humans and automated tools without baseline constraints.';
    case 'sensitive':
      return 'Sensitive area requiring prominent human review emphasis, additional instructions, and configured verification checks.';
    case 'frozen-implementation':
      return 'Preserves bound source code exactly. Edits are strictly blocked unless baseline is deliberately updated.';
    case 'frozen-contract':
      return 'Preserves declared public interface while permitting internal implementation changes.';
    default:
      return '';
  }
}

/**
 * Returns prerequisite requirements for a policy.
 */
export function getPolicyPrerequisites(policy: ProgramNode['policy']): string {
  switch (policy) {
    case 'editable':
      return 'None. Open to modification.';
    case 'sensitive':
      return 'None required; additional instructions and named checks recommended for review enforcement.';
    case 'frozen-implementation':
      return 'Requires valid, current source binding with captured analysis evidence.';
    case 'frozen-contract':
      return 'Requires explicit interface definition OR valid, current source binding with unambiguous declared interface.';
    default:
      return '';
  }
}

/**
 * Pure helper to evaluate policy prerequisites, extract freeze preview, or explain unresolved evidence.
 */
export function evaluatePolicyPrerequisites(
  node: ProgramNode,
  targetPolicy: ProgramNode['policy'],
  analysis?: Analysis | null
): PolicyPrerequisiteResult {
  if (targetPolicy === 'editable' || targetPolicy === 'sensitive') {
    return {
      allowed: true,
      policy: targetPolicy,
    };
  }

  if (targetPolicy === 'frozen-implementation') {
    if (!node.source) {
      return {
        allowed: false,
        policy: targetPolicy,
        reason: 'Frozen implementation requires a source binding',
        unresolvedEvidence:
          'Attempt to freeze an unbound implementation: No source binding is available. File path, range, and content hash are required.',
      };
    }

    if (!analysis) {
      return {
        allowed: false,
        policy: targetPolicy,
        reason: 'Freeze implementation requires captured source evidence',
        unresolvedEvidence: 'No captured analysis is available to verify bound source text.',
      };
    }

    const evidence = resolveSourceEvidence(node.source, analysis, analysis.revision);
    if (evidence.status !== 'current') {
      const msg = 'message' in evidence ? evidence.message : `Source evidence status is ${evidence.status}`;
      return {
        allowed: false,
        policy: targetPolicy,
        reason: `Freeze implementation requires valid, current source evidence: ${msg}`,
        unresolvedEvidence: `Source binding is ${evidence.status}: ${msg}`,
      };
    }

    return {
      allowed: true,
      policy: targetPolicy,
      preview: {
        kind: 'implementation',
        text: evidence.text,
        source: evidence.source,
      },
    };
  }

  if (targetPolicy === 'frozen-contract') {
    // 1. Explicit interface definition provided on the node
    if (node.contract && node.contract.trim()) {
      return {
        allowed: true,
        policy: targetPolicy,
        preview: {
          kind: 'contract',
          text: node.contract,
          source: node.source,
        },
      };
    }

    // 2. Bound source available to extract contract
    if (!node.source) {
      return {
        allowed: false,
        policy: targetPolicy,
        reason: 'Frozen contract requires a source binding or an explicit interface definition',
        unresolvedEvidence:
          'Node has neither an explicit declared interface nor a source binding. Provide an explicit interface or bind to analyzed source code.',
      };
    }

    if (!analysis) {
      return {
        allowed: false,
        policy: targetPolicy,
        reason: 'Freeze contract requires analysis to extract declared interface',
        unresolvedEvidence: 'No captured analysis available to extract interface from source.',
      };
    }

    const evidence = resolveSourceEvidence(node.source, analysis, analysis.revision);
    if (evidence.status !== 'current') {
      const msg = 'message' in evidence ? evidence.message : `Source evidence status is ${evidence.status}`;
      return {
        allowed: false,
        policy: targetPolicy,
        reason: `Freeze contract requires valid, current source evidence: ${msg}`,
        unresolvedEvidence: `Source binding is ${evidence.status}: ${msg}`,
      };
    }

    const matches = analysis.graph.nodes.filter(
      n =>
        n.kind === node.kind &&
        n.source?.path === evidence.source.path &&
        n.source.start === evidence.source.start &&
        n.source.end === evidence.source.end &&
        n.source.symbol === evidence.source.symbol &&
        n.source.hash === evidence.source.hash &&
        n.source.revision === evidence.source.revision
    );

    if (matches.length !== 1 || !matches[0].contract.trim()) {
      return {
        allowed: false,
        policy: targetPolicy,
        reason: 'Freeze contract requires an unambiguous declared interface',
        unresolvedEvidence:
          matches.length === 0
            ? 'No matching declaration found in captured analysis.'
            : matches.length > 1
            ? 'Ambiguous declaration: multiple matches found in captured analysis.'
            : 'Matching declaration has an empty contract interface.',
      };
    }

    return {
      allowed: true,
      policy: targetPolicy,
      preview: {
        kind: 'contract',
        text: matches[0].contract,
        source: node.source,
      },
    };
  }

  return {
    allowed: false,
    policy: targetPolicy,
    reason: `Unknown policy: ${targetPolicy}`,
  };
}

/**
 * Pure helper to preview what will be frozen or explain unresolved evidence.
 */
export function previewFreezeEvidence(
  node: ProgramNode,
  targetPolicy: ProgramNode['policy'],
  analysis?: Analysis | null
): {
  kind: 'implementation' | 'contract' | 'none';
  text: string;
  source?: ProgramNode['source'];
  isUnresolved: boolean;
  reason?: string;
  unresolvedEvidence?: string;
} {
  const evalResult = evaluatePolicyPrerequisites(node, targetPolicy, analysis);
  if (!evalResult.allowed) {
    return {
      kind: 'none',
      text: '',
      isUnresolved: true,
      reason: evalResult.reason,
      unresolvedEvidence: evalResult.unresolvedEvidence,
    };
  }

  if (evalResult.preview) {
    return {
      kind: evalResult.preview.kind,
      text: evalResult.preview.text,
      source: evalResult.preview.source,
      isUnresolved: false,
    };
  }

  return {
    kind: 'none',
    text: '',
    isUnresolved: false,
  };
}

/**
 * Pure helper comparing current baseline to live state.
 */
export function compareBaseline(
  node: ProgramNode,
  analysis?: Analysis | null
): BaselineComparison {
  if (!node.baseline) {
    return {
      hasBaseline: false,
      isIntact: true,
      explanation: 'No baseline recorded for this element.',
    };
  }

  if (node.policy === 'frozen-implementation') {
    const baselineText = node.baseline.text ?? '';
    if (!node.source || !analysis) {
      return {
        hasBaseline: true,
        isIntact: false,
        explanation: 'Source binding or analysis is unavailable to verify baseline.',
        baselineContent: baselineText,
      };
    }

    const evidence = resolveSourceEvidence(node.source, analysis, analysis.revision);
    if (evidence.status !== 'current') {
      const msg = 'message' in evidence ? evidence.message : `Source evidence is ${evidence.status}`;
      return {
        hasBaseline: true,
        isIntact: false,
        explanation: `Source evidence is ${evidence.status}: ${msg}`,
        baselineContent: baselineText,
      };
    }

    const isIntact = evidence.text === baselineText;
    return {
      hasBaseline: true,
      isIntact,
      explanation: isIntact
        ? 'Bound source matches frozen implementation baseline exactly.'
        : 'Bound source code differs from frozen implementation baseline.',
      baselineContent: baselineText,
      liveContent: evidence.text,
    };
  }

  if (node.policy === 'frozen-contract') {
    const baselineContract = node.baseline.contract ?? '';
    let liveContract = node.contract;
    if (!liveContract.trim() && node.source && analysis) {
      const match = analysis.graph.nodes.find(
        n =>
          n.kind === node.kind &&
          n.source?.path === node.source?.path &&
          n.source?.symbol === node.source?.symbol
      );
      if (match?.contract) liveContract = match.contract;
    }

    const isIntact = liveContract.trim() === baselineContract.trim();
    return {
      hasBaseline: true,
      isIntact,
      explanation: isIntact
        ? 'Declared interface matches frozen contract baseline.'
        : 'Declared interface has changed since contract baseline was frozen.',
      baselineContent: baselineContract,
      liveContent: liveContract,
    };
  }

  return {
    hasBaseline: true,
    isIntact: true,
    explanation: 'Baseline recorded.',
  };
}

/**
 * Applies deliberate protection policy updates and returns a validated next graph.
 */
export function applyProtectionPolicy(
  graph: Graph,
  nodeId: string,
  updates: {
    policy: ProgramNode['policy'];
    instructions?: string;
    requiredChecks?: string[];
    contract?: string;
    baseline?: ProgramNode['baseline'];
  },
  analysis?: Analysis | null
): { graph: Graph; updatedNode: ProgramNode } {
  const existing = graph.nodes.find(n => n.id === nodeId);
  if (!existing) throw new Error(`Node not found: ${nodeId}`);

  const candidateContract = updates.contract !== undefined ? updates.contract : existing.contract;
  const candidateNode: ProgramNode = {
    ...existing,
    contract: candidateContract,
    instructions: updates.instructions !== undefined ? updates.instructions.trim() : existing.instructions,
    requiredChecks: updates.requiredChecks !== undefined ? updates.requiredChecks : existing.requiredChecks,
  };

  const evalResult = evaluatePolicyPrerequisites(candidateNode, updates.policy, analysis);
  if (!evalResult.allowed) {
    throw new Error(evalResult.reason || 'Invalid freezing policy prerequisites unmet');
  }

  let nextBaseline = updates.baseline;
  if (updates.policy === 'editable' || updates.policy === 'sensitive') {
    nextBaseline = undefined;
  } else if (!nextBaseline && evalResult.preview) {
    if (evalResult.preview.kind === 'implementation') {
      nextBaseline = {
        source: evalResult.preview.source,
        text: evalResult.preview.text,
      };
    } else {
      nextBaseline = {
        source: existing.source,
        contract: evalResult.preview.text,
      };
    }
  }

  const updatedNode: ProgramNode = {
    ...candidateNode,
    policy: updates.policy,
    baseline: nextBaseline,
  };

  const parsed = NodeSchema.parse(updatedNode);
  const nextGraph: Graph = {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId ? parsed : n)),
  };
  GraphSchema.parse(nextGraph);

  return { graph: nextGraph, updatedNode: parsed };
}

export interface ProtectionEditorProps {
  isOpen?: boolean;
  onClose?: () => void;
  project: Project | null;
  graph: Graph | null;
  analysis?: Analysis | null;
  selectedNodeId?: string | null;
  initialPolicy?: ProgramNode['policy'];
  onSelectNode?: (id: string | null) => void;
  onUpdateSpecification?: (nextGraph: Graph) => void | Promise<void>;
  onUpdateChecks?: (checks: Record<string, { command: string; args: string[] }>) => void | Promise<void>;
  mode?: 'modal' | 'panel' | 'inline';
  readOnly?: boolean;
}

export const ProtectionEditor: React.FC<ProtectionEditorProps> = ({
  isOpen = true,
  onClose,
  project,
  graph,
  analysis,
  selectedNodeId,
  initialPolicy,
  onSelectNode,
  onUpdateSpecification,
  onUpdateChecks,
  mode = 'modal',
  readOnly = false,
}) => {
  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const activeNode = useMemo(() => {
    if (!nodes.length) return null;
    if (selectedNodeId) {
      return nodes.find(n => n.id === selectedNodeId) || nodes[0];
    }
    return nodes[0];
  }, [nodes, selectedNodeId]);

  // Draft state
  const [selectedPolicy, setSelectedPolicy] = useState<ProgramNode['policy']>(
    initialPolicy || activeNode?.policy || 'editable'
  );
  const [draftInstructions, setDraftInstructions] = useState<string>(activeNode?.instructions || '');
  const [draftRequiredChecks, setDraftRequiredChecks] = useState<string[]>(activeNode?.requiredChecks || []);
  const [draftContract, setDraftContract] = useState<string>(activeNode?.contract || '');
  const [newCheckName, setNewCheckName] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Sync draft when activeNode changes
  useEffect(() => {
    if (activeNode) {
      setSelectedPolicy(initialPolicy || activeNode.policy || 'editable');
      setDraftInstructions(activeNode.instructions || '');
      setDraftRequiredChecks(activeNode.requiredChecks || []);
      setDraftContract(activeNode.contract || '');
      setValidationError(null);
      setSuccessMessage(null);
    }
  }, [activeNode?.id, activeNode?.policy, initialPolicy]);

  // Project configured checks
  const projectChecks = useMemo(() => project?.checks || {}, [project]);
  const projectCheckNames = useMemo(() => Object.keys(projectChecks), [projectChecks]);

  // Evaluate prerequisites for current draft policy
  const currentEval = useMemo(() => {
    if (!activeNode) {
      return { allowed: false, policy: selectedPolicy, reason: 'No node selected' };
    }
    return evaluatePolicyPrerequisites(
      {
        ...activeNode,
        contract: draftContract,
      },
      selectedPolicy,
      analysis
    );
  }, [activeNode, selectedPolicy, draftContract, analysis]);

  // Preview evidence
  const previewData = useMemo(() => {
    if (!activeNode) return null;
    return previewFreezeEvidence(
      {
        ...activeNode,
        contract: draftContract,
      },
      selectedPolicy,
      analysis
    );
  }, [activeNode, selectedPolicy, draftContract, analysis]);

  // Current baseline comparison
  const baselineComp = useMemo(() => {
    if (!activeNode) return null;
    return compareBaseline(activeNode, analysis);
  }, [activeNode, analysis]);

  if (!isOpen) return null;

  const handleToggleCheck = (checkName: string) => {
    setValidationError(null);
    setDraftRequiredChecks(prev => {
      if (prev.includes(checkName)) {
        return prev.filter(c => c !== checkName);
      }
      return [...prev, checkName];
    });
  };

  const handleAddCustomCheck = () => {
    const trimmed = newCheckName.trim();
    if (!trimmed) {
      setValidationError('Required check reference must not be blank');
      return;
    }
    if (draftRequiredChecks.includes(trimmed)) {
      setValidationError(`Check '${trimmed}' is already attached`);
      return;
    }
    setDraftRequiredChecks(prev => [...prev, trimmed]);
    setNewCheckName('');
    setValidationError(null);
  };

  const handleRemoveCheck = (checkName: string) => {
    setValidationError(null);
    setDraftRequiredChecks(prev => prev.filter(c => c !== checkName));
  };

  const handleSave = async () => {
    if (!activeNode || !graph) return;
    setValidationError(null);
    setSuccessMessage(null);

    // Enforce prerequisites
    if (!currentEval.allowed) {
      setValidationError(currentEval.reason || 'Cannot set protection policy: prerequisites unmet.');
      return;
    }

    try {
      setIsSaving(true);
      const { graph: nextGraph } = applyProtectionPolicy(
        graph,
        activeNode.id,
        {
          policy: selectedPolicy,
          instructions: draftInstructions,
          requiredChecks: draftRequiredChecks,
          contract: draftContract,
        },
        analysis
      );

      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setSuccessMessage(`Protection policy '${formatPolicyLabel(selectedPolicy)}' saved deliberately.`);
    } catch (err: any) {
      setValidationError(err.message || 'Failed to apply protection policy');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateBaseline = async () => {
    if (!activeNode || !graph) return;
    setValidationError(null);

    if (selectedPolicy !== 'frozen-implementation' && selectedPolicy !== 'frozen-contract') {
      setValidationError('Updating baseline requires a frozen policy.');
      return;
    }

    if (!currentEval.allowed) {
      setValidationError(currentEval.reason || 'Cannot update baseline: prerequisites unmet.');
      return;
    }

    try {
      setIsSaving(true);
      const { graph: nextGraph } = applyProtectionPolicy(
        graph,
        activeNode.id,
        {
          policy: selectedPolicy,
          instructions: draftInstructions,
          requiredChecks: draftRequiredChecks,
          contract: draftContract,
        },
        analysis
      );

      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setSuccessMessage('Baseline updated deliberately to match latest evidence.');
    } catch (err: any) {
      setValidationError(err.message || 'Failed to update baseline');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearBaseline = async () => {
    if (!activeNode || !graph) return;
    setValidationError(null);

    try {
      setIsSaving(true);
      setSelectedPolicy('editable');
      const { graph: nextGraph } = applyProtectionPolicy(
        graph,
        activeNode.id,
        {
          policy: 'editable',
          instructions: draftInstructions,
          requiredChecks: draftRequiredChecks,
          contract: draftContract,
          baseline: undefined,
        },
        analysis
      );

      if (onUpdateSpecification) {
        await onUpdateSpecification(nextGraph);
      }
      setSuccessMessage('Protection baseline removed. Element is now editable.');
    } catch (err: any) {
      setValidationError(err.message || 'Failed to clear baseline');
    } finally {
      setIsSaving(false);
    }
  };

  const content = (
    <div
      className={`protection-editor-container ${mode}`}
      data-testid="protection-editor"
      aria-label="Protection Policy Editor"
    >
      {/* Header */}
      <div className="protection-header">
        <div className="protection-title-group">
          <Shield size={20} className="protection-icon" />
          <div>
            <h3>Protection Policies & Sensitive Instructions</h3>
            <p className="protection-subtext">
              Set valid protection policies (R24, R25), configure instructions and checks, and inspect frozen evidence.
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className="protection-close-btn"
            onClick={onClose}
            aria-label="Close"
            data-testid="close-protection-btn"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Node Switcher */}
      <div className="protection-node-switcher">
        <label htmlFor="protection-node-select">Target Element:</label>
        <select
          id="protection-node-select"
          className="form-select node-select"
          value={activeNode?.id || ''}
          onChange={e => onSelectNode?.(e.target.value)}
          data-testid="protection-node-select"
        >
          {nodes.map(n => (
            <option key={n.id} value={n.id}>
              {`${n.name} (${n.kind}) [${formatPolicyLabel(n.policy)}]`}
            </option>
          ))}
        </select>
        {activeNode && (
          <span className={`policy-badge policy-${activeNode.policy}`}>
            <Shield size={12} /> {activeNode.policy}
          </span>
        )}
      </div>

      {/* Main Body */}
      {activeNode ? (
        <div className="protection-body">
          {/* Notifications */}
          {validationError && (
            <div className="protection-alert alert-error" data-testid="protection-error-alert">
              <AlertCircle size={16} />
              <span>{validationError}</span>
            </div>
          )}
          {successMessage && (
            <div className="protection-alert alert-success" data-testid="protection-success-alert">
              <CheckCircle2 size={16} />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Policy Selection: 4 Policies */}
          <div className="protection-section">
            <h4 className="section-title">
              <ShieldCheck size={16} /> Protection Policy
            </h4>
            <div className="policy-cards-grid">
              {policies.map(p => {
                const evalForP = evaluatePolicyPrerequisites(
                  {
                    ...activeNode,
                    contract: draftContract,
                  },
                  p,
                  analysis
                );
                const isSelected = selectedPolicy === p;

                return (
                  <div
                    key={p}
                    className={`policy-card ${isSelected ? 'selected' : ''} ${!evalForP.allowed ? 'prereq-unmet' : ''}`}
                    onClick={() => {
                      setSelectedPolicy(p);
                      setValidationError(null);
                    }}
                    data-testid={`policy-option-${p}`}
                  >
                    <div className="policy-card-header">
                      <div className="policy-card-title">
                        <input
                          type="radio"
                          name="protection-policy"
                          id={`radio-policy-${p}`}
                          checked={isSelected}
                          onChange={() => {
                            setSelectedPolicy(p);
                            setValidationError(null);
                          }}
                        />
                        <label htmlFor={`radio-policy-${p}`}>{formatPolicyLabel(p)}</label>
                      </div>
                      <span
                        className={`prereq-status-badge ${evalForP.allowed ? 'status-met' : 'status-blocked'}`}
                        data-testid={`policy-prereq-status-${p}`}
                      >
                        {evalForP.allowed ? 'Ready' : 'Prerequisites Unmet'}
                      </span>
                    </div>

                    <p className="policy-card-desc">{getPolicyDescription(p)}</p>

                    <div className="policy-card-prereq">
                      <span className="prereq-label">Prerequisites:</span>
                      <span className="prereq-text">{getPolicyPrerequisites(p)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Prerequisites Alert / Explanation if Unmet */}
          {!currentEval.allowed && (
            <div className="unresolved-evidence-box" data-testid="unresolved-evidence-box">
              <div className="unresolved-header">
                <AlertTriangle size={16} className="text-danger" />
                <strong>Freezing Blocked</strong>
              </div>
              <p className="freeze-blocked-reason" data-testid="freeze-blocked-reason">
                {currentEval.reason}
              </p>
              {currentEval.unresolvedEvidence && (
                <div
                  className="unresolved-explanation"
                  data-testid="unresolved-evidence-explanation"
                >
                  <em>Unresolved evidence explanation:</em> {currentEval.unresolvedEvidence}
                </div>
              )}
            </div>
          )}

          {/* Sensitive Item Review Emphasis (Acceptance Criterion 3) */}
          {selectedPolicy === 'sensitive' && (
            <div className="sensitive-review-callout" data-testid="sensitive-review-emphasis">
              <ShieldAlert size={18} className="sensitive-icon" />
              <div>
                <strong>Sensitive Element Emphasis (R24)</strong>
                <p>
                  Sensitive items receive prominent review emphasis in proposals, and required verification checks
                  block unverified changes. Additional instructions below will accompany prompts and review packages.
                </p>
              </div>
            </div>
          )}

          {/* Explicit Interface definition for Frozen Contract before code exists */}
          {selectedPolicy === 'frozen-contract' && (
            <div className="protection-form-group">
              <label htmlFor="draft-contract-input">
                Declared Interface Contract:
              </label>
              <textarea
                id="draft-contract-input"
                className="form-textarea code-font"
                rows={3}
                placeholder="e.g. export interface IUserService { getUser(id: string): User; }"
                value={draftContract}
                onChange={e => {
                  setDraftContract(e.target.value);
                  setValidationError(null);
                }}
                data-testid="draft-contract-input"
              />
              <span className="form-help">
                Explicit interface definition allows freezing contract before source code exists.
              </span>
            </div>
          )}

          {/* Preview Section */}
          {(selectedPolicy === 'frozen-implementation' || selectedPolicy === 'frozen-contract') && (
            <div className="protection-section" data-testid="freeze-preview-container">
              <h4 className="section-title">
                <FileCode size={16} /> Freeze Evidence Preview
              </h4>

              {previewData && !previewData.isUnresolved ? (
                <div className="freeze-preview-box">
                  <div className="freeze-preview-meta" data-testid="freeze-preview-metadata">
                    <span className="meta-badge">
                      <Tag size={12} /> {previewData.kind === 'implementation' ? 'Bound Source Text' : 'Declared Interface'}
                    </span>
                    {previewData.source?.path && (
                      <span className="meta-badge">
                        Path: <code>{previewData.source.path}</code>
                      </span>
                    )}
                    {previewData.source?.symbol && (
                      <span className="meta-badge">
                        Symbol: <code>{previewData.source.symbol}</code>
                      </span>
                    )}
                    {previewData.source?.revision && (
                      <span className="meta-badge">
                        Revision: <code>{previewData.source.revision}</code>
                      </span>
                    )}
                    {previewData.source?.hash && (
                      <span className="meta-badge">
                        Hash: <code>{previewData.source.hash.slice(0, 8)}...</code>
                      </span>
                    )}
                  </div>

                  <pre className="freeze-preview-code" data-testid="freeze-preview-code">
                    <code>{previewData.text || '// (empty text)'}</code>
                  </pre>
                </div>
              ) : (
                <div className="unresolved-preview-note" data-testid="unresolved-evidence-preview">
                  <Info size={14} />
                  <span>
                    {previewData?.unresolvedEvidence ||
                      'Evidence cannot be previewed until policy prerequisites are satisfied.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Sensitive Instructions */}
          <div className="protection-section" data-testid="sensitive-instructions-section">
            <h4 className="section-title">
              <FileText size={16} /> Sensitive Instructions (R24)
            </h4>
            {selectedPolicy === 'sensitive' && (
              <div className="sensitive-instruction-callout" data-testid="sensitive-instructions-callout">
                <ShieldAlert size={14} />
                <span>
                  Instructions entered here will guide human reviewers and strictly constrain AI modifications.
                </span>
              </div>
            )}
            <textarea
              className="form-textarea"
              rows={3}
              placeholder="e.g. Protect authentication token validation; verify HMAC signature on all incoming requests."
              value={draftInstructions}
              onChange={e => {
                setDraftInstructions(e.target.value);
                setValidationError(null);
              }}
              data-testid="protection-instructions-input"
            />
          </div>

          {/* Named Required Checks */}
          <div className="protection-section" data-testid="required-checks-section">
            <h4 className="section-title">
              <ListPlus size={16} /> Configured Required Checks (R24)
            </h4>
            <p className="section-desc">
              Named verification checks required for this element. Changes will be blocked during review if any
              required check fails.
            </p>

            {/* Currently attached checks */}
            <div className="attached-checks-list">
              {draftRequiredChecks.length === 0 ? (
                <p className="empty-subtext" data-testid="no-checks-attached">
                  No required checks configured for this element.
                </p>
              ) : (
                draftRequiredChecks.map(checkName => {
                  const isConfiguredInProject = Boolean(projectChecks[checkName]);
                  return (
                    <div
                      key={checkName}
                      className={`check-chip ${isConfiguredInProject ? 'configured' : 'unconfigured'}`}
                      data-testid={`check-chip-${checkName}`}
                    >
                      <span className="check-name">
                        <strong>{checkName}</strong>
                        {isConfiguredInProject && (
                          <code className="check-cmd">
                            {` (${projectChecks[checkName].command} ${projectChecks[checkName].args.join(' ')})`}
                          </code>
                        )}
                        {!isConfiguredInProject && (
                          <span className="unconfigured-warning"> (not configured in project)</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="chip-remove-btn"
                        onClick={() => handleRemoveCheck(checkName)}
                        title="Remove check"
                        data-testid={`remove-check-${checkName}`}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Available project checks to toggle */}
            {projectCheckNames.length > 0 && (
              <div className="project-checks-selector">
                <span className="selector-title">Available Project Checks:</span>
                <div className="project-checks-grid">
                  {projectCheckNames.map(name => {
                    const isChecked = draftRequiredChecks.includes(name);
                    const checkDef = projectChecks[name];
                    return (
                      <label
                        key={name}
                        className={`project-check-toggle ${isChecked ? 'active' : ''}`}
                        data-testid={`toggle-check-label-${name}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleCheck(name)}
                          data-testid={`toggle-check-${name}`}
                        />
                        <span className="toggle-name">{name}</span>
                        <code className="toggle-cmd">{`${checkDef.command} ${checkDef.args.join(' ')}`}</code>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Add custom check input */}
            <div className="add-check-input-row">
              <input
                type="text"
                className="form-input"
                placeholder="Add check reference name (e.g. test, lint, typecheck)"
                value={newCheckName}
                onChange={e => setNewCheckName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomCheck();
                  }
                }}
                data-testid="custom-check-input"
              />
              <button
                type="button"
                className="btn-add-check"
                onClick={handleAddCustomCheck}
                data-testid="add-custom-check-btn"
              >
                <Plus size={14} /> Add Check
              </button>
            </div>
          </div>

          {/* Baseline Inspection Card */}
          {activeNode.baseline && (
            <div className="protection-section baseline-card" data-testid="baseline-inspection-card">
              <div className="baseline-card-header">
                <div className="baseline-header-title">
                  <Lock size={16} />
                  <h4>Deliberate Baseline Record</h4>
                </div>
                {baselineComp && (
                  <span
                    className={`baseline-status-badge ${baselineComp.isIntact ? 'intact' : 'modified'}`}
                    data-testid="baseline-status-badge"
                  >
                    {baselineComp.isIntact ? 'Baseline Intact' : 'Baseline Modified'}
                  </span>
                )}
              </div>

              {baselineComp && (
                <p className="baseline-explanation">{baselineComp.explanation}</p>
              )}

              {baselineComp?.baselineContent && (
                <div className="baseline-content-box">
                  <span className="baseline-box-label">Recorded Baseline Content:</span>
                  <pre className="baseline-content-preview" data-testid="baseline-content-preview">
                    <code>{baselineComp.baselineContent}</code>
                  </pre>
                </div>
              )}

              <div className="baseline-actions">
                <button
                  type="button"
                  className="btn-update-baseline"
                  onClick={handleUpdateBaseline}
                  disabled={!currentEval.allowed || isSaving || readOnly}
                  data-testid="update-baseline-btn"
                >
                  <RefreshCw size={14} /> Update Baseline
                </button>
                <button
                  type="button"
                  className="btn-clear-baseline"
                  onClick={handleClearBaseline}
                  disabled={isSaving || readOnly}
                  data-testid="clear-baseline-btn"
                >
                  <Unlock size={14} /> Remove Protection Baseline
                </button>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="protection-footer">
            <div className="footer-left">
              <span className="review-notice">
                Policy changes and baselines are deliberate and reviewable in specification history.
              </span>
            </div>
            <div className="footer-right">
              {onClose && (
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={onClose}
                  data-testid="cancel-protection-btn"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="btn-save-policy"
                onClick={handleSave}
                disabled={isSaving || readOnly}
                data-testid="save-protection-btn"
              >
                <Save size={14} /> {isSaving ? 'Saving...' : 'Save Protection Policy'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="protection-empty" data-testid="protection-empty-state">
          <p>No element selected to edit protection policy.</p>
        </div>
      )}
    </div>
  );

  if (mode === 'modal') {
    return (
      <div
        className="protection-modal-backdrop"
        data-testid="protection-modal-backdrop"
        onClick={onClose}
      >
        <div
          className="protection-modal-dialog"
          onClick={e => e.stopPropagation()}
          data-testid="protection-editor-modal"
        >
          {content}
        </div>
      </div>
    );
  }

  return content;
};
