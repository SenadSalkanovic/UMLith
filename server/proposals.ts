import { isDeepStrictEqual } from 'node:util';
import {
  GraphSchema,
  DesignProposalSchema,
  getProposalBaseRevision,
  type Project,
  type ProgramNode,
  type Graph,
  type Layout,
  type DesignProposal,
  type ProposalDiagnostic,
  type ProposalValidationReport,
  type SpecificationDiff,
} from '../shared/model';
import { inScope } from './review';

export interface ValidateProposalOptions {
  scope?: string[];
  specRevision?: number;
  sourceRevision?: string | null;
}

function isNodeInScope(node: ProgramNode, graph: Graph, scope: string[]): boolean {
  if (scope.includes('.')) return true;
  if (scope.includes(node.id) || scope.includes(node.name)) return true;
  if (node.source?.path && inScope(node.source.path, scope)) return true;
  if (node.outputPath && inScope(node.outputPath, scope)) return true;
  // Walk ancestor hierarchy
  let current = node;
  const visited = new Set<string>();
  while (current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = graph.nodes.find(n => n.id === current.parentId);
    if (!parent) break;
    if (scope.includes(parent.id) || scope.includes(parent.name)) return true;
    if (parent.source?.path && inScope(parent.source.path, scope)) return true;
    if (parent.outputPath && inScope(parent.outputPath, scope)) return true;
    current = parent;
  }
  return false;
}

export function validateProposal(
  project: Project,
  raw: unknown,
  options?: ValidateProposalOptions
): ProposalValidationReport {
  const diagnostics: ProposalDiagnostic[] = [];

  // 1. Schema and payload validation
  const parsed = DesignProposalSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.join('.');
      let code: ProposalDiagnostic['code'] = 'schema';
      let nodeId: string | undefined;
      let edgeId: string | undefined;

      // Extract specific node or edge if present in path
      if (issue.path[0] === 'graph' && issue.path[1] === 'nodes' && typeof issue.path[2] === 'number') {
        const rawObj = raw as any;
        const node = rawObj?.graph?.nodes?.[issue.path[2]];
        if (node?.id) nodeId = String(node.id);
        const subProp = issue.path[3];
        if (subProp === 'parentId') code = 'containment';
        else if (subProp === 'stepType') code = 'workflow';
        else if (subProp === 'source') code = 'provenance';
      } else if (issue.path[0] === 'graph' && issue.path[1] === 'edges' && typeof issue.path[2] === 'number') {
        const rawObj = raw as any;
        const edge = rawObj?.graph?.edges?.[issue.path[2]];
        if (edge?.id) edgeId = String(edge.id);
        const subProp = issue.path[3];
        if (subProp === 'source' || subProp === 'target') code = 'reference';
        else if (subProp === 'kind') code = 'workflow';
      } else if (issue.path[0] === 'graph' && issue.path[1] === 'nodes' && issue.path.length === 2) {
        code = 'containment';
      }

      diagnostics.push({
        severity: 'error',
        code,
        message: issue.message || `Malformed proposal payload at ${pathStr}`,
        path: pathStr || undefined,
        nodeId,
        edgeId,
      });
    }

    return {
      valid: false,
      diagnostics,
    };
  }

  const proposal = parsed.data;

  // 2. Base specification revision check
  const proposalBaseRev = getProposalBaseRevision(proposal);
  if (proposalBaseRev !== undefined && proposalBaseRev !== project.specRevision) {
    diagnostics.push({
      severity: 'error',
      code: 'stale-spec',
      message: `Proposal is based on stale specification revision ${proposalBaseRev}; current revision is ${project.specRevision}.`,
    });
  }

  if (options?.specRevision !== undefined && options.specRevision !== project.specRevision) {
    diagnostics.push({
      severity: 'error',
      code: 'stale-spec',
      message: `Task started at specification revision ${options.specRevision}; current revision is ${project.specRevision}.`,
    });
  }

  // 3. Source revision check
  if (proposal.sourceRevision && project.analysis?.revision && project.analysis.revision !== '') {
    if (proposal.sourceRevision !== project.analysis.revision) {
      diagnostics.push({
        severity: 'warning',
        code: 'stale-source',
        message: `Proposal was prepared against source revision ${proposal.sourceRevision}, but current project analysis revision is ${project.analysis.revision}.`,
      });
    }
  }
  if (project.analysis?.status === 'stale') {
    diagnostics.push({
      severity: 'warning',
      code: 'stale-source',
      message: 'Project source analysis is currently stale. Proposal should be verified against fresh source.',
    });
  }

  // 4. Policy and protection baselines for existing nodes
  for (const originalNode of project.specification.nodes) {
    const proposedNode = proposal.graph.nodes.find(n => n.id === originalNode.id);

    // Check frozen nodes
    if (originalNode.policy.startsWith('frozen')) {
      if (!proposedNode) {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: originalNode.id,
          message: `Proposal deletes a protected ${originalNode.policy} item: ${originalNode.name}`,
        });
        continue;
      }

      if (originalNode.policy === 'frozen-implementation') {
        if (JSON.stringify(originalNode) !== JSON.stringify(proposedNode)) {
          diagnostics.push({
            severity: 'error',
            code: 'policy',
            nodeId: originalNode.id,
            message: `Proposal modifies a frozen implementation item: ${originalNode.name}`,
          });
        }
      } else if (originalNode.policy === 'frozen-contract') {
        if (
          originalNode.contract !== proposedNode.contract ||
          originalNode.policy !== proposedNode.policy ||
          originalNode.name !== proposedNode.name ||
          originalNode.kind !== proposedNode.kind ||
          ['visibility','isStatic','isAbstract','signature','fields'].some(key=>!isDeepStrictEqual(originalNode[key as keyof ProgramNode],proposedNode[key as keyof ProgramNode])) ||
          JSON.stringify(originalNode.baseline) !== JSON.stringify(proposedNode.baseline) ||
          JSON.stringify(originalNode.source) !== JSON.stringify(proposedNode.source)
        ) {
          diagnostics.push({
            severity: 'error',
            code: 'policy',
            nodeId: originalNode.id,
            message: `Proposal modifies a frozen contract item: ${originalNode.name}`,
          });
        }
      }
    }

    // AI proposals cannot alter policy, baseline, or source of any existing node
    if (proposedNode) {
      if (proposedNode.policy !== originalNode.policy) {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: originalNode.id,
          message: `Proposal changes policy of "${originalNode.name}" from "${originalNode.policy}" to "${proposedNode.policy}".`,
        });
      }
      if (JSON.stringify(proposedNode.baseline) !== JSON.stringify(originalNode.baseline)) {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: originalNode.id,
          message: `Proposal modifies protection baseline of "${originalNode.name}".`,
        });
      }
      if (JSON.stringify(proposedNode.source) !== JSON.stringify(originalNode.source)) {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: originalNode.id,
          message: `Proposal modifies source binding of "${originalNode.name}".`,
        });
      }
    }
  }

  // 5. Check newly added nodes and modified nodes (provenance, policies, source evidence separation)
  for (const proposedNode of proposal.graph.nodes) {
    const existingNode = project.specification.nodes.find(n => n.id === proposedNode.id);

    if (!existingNode) {
      // New AI node
      if (proposedNode.policy !== 'editable') {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: proposedNode.id,
          message: `New AI-proposed node "${proposedNode.name}" cannot establish protection policy "${proposedNode.policy}". New nodes must be editable.`,
        });
      }
      if (proposedNode.baseline) {
        diagnostics.push({
          severity: 'error',
          code: 'policy',
          nodeId: proposedNode.id,
          message: `New AI-proposed node "${proposedNode.name}" cannot establish a protection baseline.`,
        });
      }
      if (proposedNode.source) {
        diagnostics.push({
          severity: 'error',
          code: 'provenance',
          nodeId: proposedNode.id,
          message: `New AI-proposed node "${proposedNode.name}" cannot invent source evidence. Source evidence requires compiler/analyzer extraction.`,
        });
      }
      if (proposedNode.provenance === 'extracted') {
        diagnostics.push({
          severity: 'error',
          code: 'provenance',
          nodeId: proposedNode.id,
          message: `New AI-proposed node "${proposedNode.name}" cannot claim compiler-extracted provenance.`,
        });
      }
    } else {
      // Modified node
      if (JSON.stringify(existingNode) !== JSON.stringify(proposedNode)) {
        if (proposedNode.provenance === 'extracted') {
          diagnostics.push({
            severity: 'error',
            code: 'provenance',
            nodeId: proposedNode.id,
            message: `Modified node "${proposedNode.name}" cannot claim compiler-extracted provenance for AI modifications.`,
          });
        }
      }
    }
  }

  // 6. Check edges for provenance
  for (const edge of proposal.graph.edges) {
    const existingEdge = project.specification.edges.find(e => e.id === edge.id);
    if (!existingEdge && edge.provenance === 'extracted') {
      diagnostics.push({
        severity: 'error',
        code: 'provenance',
        edgeId: edge.id,
        message: `New AI-proposed relationship "${edge.kind}" cannot claim compiler-extracted provenance.`,
      });
    }
  }

  // 7. Change scope validation
  if (options?.scope && options.scope.length > 0 && !options.scope.includes('.')) {
    // Check modified or deleted nodes
    for (const originalNode of project.specification.nodes) {
      const proposedNode = proposal.graph.nodes.find(n => n.id === originalNode.id);
      const isModified = proposedNode && JSON.stringify(originalNode) !== JSON.stringify(proposedNode);
      const isDeleted = !proposedNode;
      if (isModified || isDeleted) {
        if (!isNodeInScope(originalNode, project.specification, options.scope)) {
          diagnostics.push({
            severity: 'error',
            code: 'scope',
            nodeId: originalNode.id,
            message: `Change to "${originalNode.name}" is outside the approved task scope: ${options.scope.join(', ')}`,
          });
        }
      }
    }

    // Check newly added nodes
    for (const proposedNode of proposal.graph.nodes) {
      const existingNode = project.specification.nodes.find(n => n.id === proposedNode.id);
      if (!existingNode) {
        if (!isNodeInScope(proposedNode, proposal.graph, options.scope)) {
          diagnostics.push({
            severity: 'error',
            code: 'scope',
            nodeId: proposedNode.id,
            message: `Added node "${proposedNode.name}" is outside the approved task scope: ${options.scope.join(', ')}`,
          });
        }
      }
    }
  }

  const errors = diagnostics.filter(d => d.severity === 'error');
  return {
    valid: errors.length === 0,
    diagnostics,
    proposal: errors.length === 0 ? proposal : undefined,
  };
}

// Layout is stored independently; legacy inline geometry also carries no instructions.
const LAYOUT_PROPERTIES = new Set(['x', 'y', 'width', 'height', 'position']);
const POLICY_PROPERTIES = new Set(['policy', 'instructions', 'requiredChecks', 'baseline']);

function displayValue(value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function diffItems<T extends { id: string }, R>(
  before: T[], after: T[],
  describe: (item: T, previous: T | undefined, next: T | undefined,
    action: 'added' | 'modified' | 'deleted', changes: SpecificationDiff['nodes'][number]['changes']) => R,
  ignored = new Set<string>(),
): R[] {
  const oldItems = new Map(before.map(item => [item.id, item]));
  const newItems = new Map(after.map(item => [item.id, item]));
  const entries: R[] = [];
  for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
    const previous = oldItems.get(id), next = newItems.get(id);
    const oldValues: Record<string, unknown> = previous ?? {};
    const newValues: Record<string, unknown> = next ?? {};
    const changes = [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])]
      .filter(property => !ignored.has(property) && !isDeepStrictEqual(oldValues[property], newValues[property]))
      .map(property => ({ property, before: displayValue(oldValues[property]), after: displayValue(newValues[property]) }));
    if (!changes.length) continue;
    const action = !previous ? 'added' : !next ? 'deleted' : 'modified';
    entries.push(describe(next ?? previous!, previous, next, action, changes));
  }
  return entries;
}

function protectionFlags(nodes: (ProgramNode | undefined)[]) {
  return {
    isProtected: nodes.some(node => node?.policy === 'frozen-implementation' || node?.policy === 'frozen-contract'),
    isSensitive: nodes.some(node => node?.policy === 'sensitive'),
  };
}

function explainChange(action: 'added' | 'modified' | 'deleted', item: string,
  changes: SpecificationDiff['nodes'][number]['changes'], flags: ReturnType<typeof protectionFlags>): string {
  const verb = { added: 'Added', modified: 'Modified', deleted: 'Deleted' }[action];
  return `${verb} ${item}${flags.isProtected ? ' [PROTECTED]' : ''}${flags.isSensitive ? ' [SENSITIVE]' : ''}`
    + ` — changed properties: ${changes.map(change => change.property).join(', ')}`;
}

/** Compare validated graphs by stable ID, preserving semantic details for human review. */
export function computeSpecificationDiff(
  before: Graph, after: Graph,
  options?: { explanation?: string; beforeLayout?: Layout; afterLayout?: Layout },
): SpecificationDiff {
  before=GraphSchema.parse(before);after=GraphSchema.parse(after);
  const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
  const newNodes = new Map(after.nodes.map(node => [node.id, node]));
  const oldEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  const newEdges = new Map(after.edges.map(edge => [edge.id, edge]));
  const affectedNodes = (ids: string[]) => ids.flatMap(id => [oldNodes.get(id), newNodes.get(id)]);

  const nodes = diffItems(before.nodes, after.nodes, (node, previous, next, action, changes) => {
    const flags = protectionFlags([previous, next]);
    const policyChanged = action === 'modified' && changes.some(change => POLICY_PROPERTIES.has(change.property));
    const provenanceChanged = changes.some(change => change.property === 'provenance' || change.property === 'source');
    const contractChanged = changes.some(change => change.property === 'contract');
    const policyExplanation = policyChanged ? ` [POLICY CHANGED: ${previous!.policy} → ${node.policy}]` : '';
    return {
      nodeId: node.id, name: node.name, kind: node.kind, action, policy: node.policy,
      previousPolicy: policyChanged ? previous!.policy : undefined,
      ...flags, policyChanged, provenanceChanged, contractChanged, changes,
      explanation: explainChange(action, `${node.kind} "${node.name}"`, changes, flags) + policyExplanation
        + (contractChanged ? ' [CONTRACT CHANGED]' : '') + (provenanceChanged ? ' [PROVENANCE CHANGED]' : ''),
    };
  }, LAYOUT_PROPERTIES);

  const edges = diffItems(before.edges, after.edges, (edge, previous, next, action, changes) => {
    const flags = protectionFlags(affectedNodes([previous?.source, previous?.target, next?.source, next?.target]
      .filter((id): id is string => id !== undefined)));
    const nodeMap = action === 'deleted' ? oldNodes : newNodes;
    const sourceNodeName = nodeMap.get(edge.source)?.name ?? edge.source;
    const targetNodeName = nodeMap.get(edge.target)?.name ?? edge.target;
    return {
      edgeId: edge.id, action, kind: edge.kind, sourceNodeName, targetNodeName, label: edge.label,
      ...flags, changes,
      explanation: explainChange(action, `${edge.kind} relationship: ${sourceNodeName} → ${targetNodeName}`, changes, flags),
    };
  });

  const requirements = diffItems(before.requirements, after.requirements, (requirement, previous, next, action, changes) => {
    const ids = [...(previous?.nodeIds ?? []), ...(next?.nodeIds ?? [])];
    for (const edgeId of [...(previous?.edgeIds ?? []), ...(next?.edgeIds ?? [])]) {
      for (const edge of [oldEdges.get(edgeId), newEdges.get(edgeId)]) {
        if (edge) ids.push(edge.source, edge.target);
      }
    }
    const flags = protectionFlags(affectedNodes(ids));
    return {
      requirementId: requirement.id, action, text: requirement.text, ...flags, changes,
      explanation: explainChange(action, `requirement "${requirement.id}": ${requirement.text}`, changes, flags),
    };
  });

  const entries = [...nodes, ...edges, ...requirements];
  return {
    nodes, edges, requirements, explanation: options?.explanation,
    summary: {
      totalChanges: entries.length,
      additions: entries.filter(entry => entry.action === 'added').length,
      modifications: entries.filter(entry => entry.action === 'modified').length,
      deletions: entries.filter(entry => entry.action === 'deleted').length,
      policyChanges: nodes.filter(node => node.policyChanged).length,
      protectedItemChanges: entries.filter(entry => entry.isProtected).length,
      sensitiveItemChanges: entries.filter(entry => entry.isSensitive).length,
    },
  };
}
