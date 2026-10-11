import type {SandboxOptions} from './sandbox';
import ts from 'typescript';
import {createTwoFilesPatch} from 'diff';
import {readFile,writeFile,mkdir,rename,rm,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {NodeSchema,GraphSchema,emptyGraph,resolveSourceEvidence,sourceIdentityKey,DivergenceReportSchema,type Project,type ProgramNode,type Analysis,type AgentJob,type ValidationReport,type ValidationIssue,type FileChange,type BindingReviewRecord,type BindingCandidate,type Source,type Graph,type DivergenceReport,type DivergenceItem,type DivergenceEvidence} from '../shared/model';
import {Analyzer,reconcileGraphIdentities,type ReconcileGraphResult} from './analyzer';
import {AppError,atomicJson,captureFiles,fileModes,hashes,hash,safePath,scanProjectDirectory,isRevisionIncomplete} from './files';
import {computeSpecificationDiff} from './proposals';
import {dependencyIssues} from './dependencies';
import {ProjectStore} from './store';
export function normalizeContract(text:string){
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,text.replace(/^(export\s+|declare\s+|async\s+|function\s+)*/,''));
 const tokens:string[]=[];while(scanner.scan()!==ts.SyntaxKind.EndOfFileToken)tokens.push(scanner.getTokenText());return tokens.join('|');
}
export function contractSignature(contract: string | undefined): string {
 if (!contract) return '';
 const parenIdx = contract.indexOf('(');
 if (parenIdx !== -1) {
  return normalizeContract(contract.slice(parenIdx));
 }
 return normalizeContract(contract);
}
export function extractEvidenceText(
  source: Source | undefined,
  files?: Record<string, { text: string }>
): string | undefined {
  if (!source || !files || !files[source.path]) return undefined;
  const file = files[source.path];
  if (typeof source.start === 'number' && typeof source.end === 'number' && source.end >= source.start) {
    return file.text.slice(source.start, source.end);
  }
  return undefined;
}
export interface FreezePreview {
  kind: 'implementation' | 'contract';
  text: string;
  source?: ProgramNode['source'];
}
export interface FreezeEvaluation {
  allowed: boolean;
  policy: ProgramNode['policy'];
  reason?: string;
  unresolvedEvidence?: string;
  preview?: FreezePreview;
}
export function evaluateFreeze(
  node: ProgramNode,
  policy: ProgramNode['policy'],
  analysis?: Analysis
): FreezeEvaluation {
  if (policy === 'editable' || policy === 'sensitive') {
    return { allowed: true, policy };
  }
  if (policy === 'frozen-implementation') {
    if (!node.source) {
      return {
        allowed: false,
        policy,
        reason: 'Frozen implementation requires a source binding. Unbound implementation cannot be frozen.',
        unresolvedEvidence: 'Node is not bound to source code. Source path, range, and content hash are required.',
      };
    }
    const evidence = resolveSourceEvidence(node.source, analysis, analysis?.revision);
    if (evidence.status !== 'current') {
      const msg = 'message' in evidence ? evidence.message : `Source evidence is ${evidence.status}`;
      return {
        allowed: false,
        policy,
        reason: `Freeze implementation requires valid, current source evidence: ${msg}`,
        unresolvedEvidence: msg,
      };
    }
    return {
      allowed: true,
      policy,
      preview: {
        kind: 'implementation',
        text: evidence.text,
        source: evidence.source,
      },
    };
  }
  if (policy === 'frozen-contract') {
    if (node.source && analysis && analysis.quality.diagnostics.some(d => d.severity === 'error' && (!d.path || d.path === node.source?.path))) {
      return {
        allowed: false,
        policy,
        reason: 'Freeze contract cannot be verified due to compiler/type errors: ' + node.name,
        unresolvedEvidence: 'Analysis contains compiler diagnostics preventing contract verification.',
      };
    }
    if (node.contract && node.contract.trim()) {
      return {
        allowed: true,
        policy,
        preview: {
          kind: 'contract',
          text: node.contract,
          source: node.source,
        },
      };
    }
    if (!node.source) {
      return {
        allowed: false,
        policy,
        reason: 'Frozen contract requires a source binding or an explicit interface definition.',
        unresolvedEvidence: 'Node has no explicit declared interface and is not bound to source code.',
      };
    }
    const evidence = resolveSourceEvidence(node.source, analysis, analysis?.revision);
    if (evidence.status !== 'current') {
      const msg = 'message' in evidence ? evidence.message : `Source evidence is ${evidence.status}`;
      return {
        allowed: false,
        policy,
        reason: `Freeze contract requires an explicit interface or valid, current source evidence: ${msg}`,
        unresolvedEvidence: msg,
      };
    }
    if (!analysis) {
      return {
        allowed: false,
        policy,
        reason: 'Freeze contract requires analysis to extract declared interface.',
        unresolvedEvidence: 'Captured analysis is unavailable.',
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
        policy,
        reason: 'Freeze contract requires an unambiguous declared interface.',
        unresolvedEvidence:
          matches.length === 0
            ? 'No matching declaration found in analysis.'
            : matches.length > 1
            ? 'Ambiguous declaration: multiple matches found in analysis.'
            : 'Matching declaration has an empty contract interface.',
      };
    }
    return {
      allowed: true,
      policy,
      preview: {
        kind: 'contract',
        text: matches[0].contract,
        source: node.source,
      },
    };
  }
  return { allowed: false, policy, reason: `Unknown policy: ${policy}` };
}
export function freezeNode(
  node: ProgramNode,
  policy: ProgramNode['policy'],
  analysis?: Analysis,
  options?: { instructions?: string; requiredChecks?: string[] }
): ProgramNode {
  const instructions = options?.instructions !== undefined ? options.instructions : node.instructions;
  const requiredChecks = options?.requiredChecks !== undefined ? options.requiredChecks : node.requiredChecks;
  const target = { ...node, instructions, requiredChecks };

  if (policy === 'editable' || policy === 'sensitive') {
    return NodeSchema.parse({ ...target, policy, baseline: undefined });
  }
  if (policy === 'frozen-implementation') {
    if (!node.source) {
      throw new AppError('Freeze implementation requires valid, current source evidence. No source binding is available');
    }
    const evidence = resolveSourceEvidence(node.source, analysis, analysis?.revision);
    if (evidence.status !== 'current') {
      throw new AppError(
        'Freeze implementation requires valid, current source evidence. ' +
        ('message' in evidence ? evidence.message : 'Source binding is stale.')
      );
    }
    return NodeSchema.parse({
      ...target,
      policy,
      baseline: { source: evidence.source, text: evidence.text },
    });
  }
  let contract = target.contract;
  if (node.source && analysis && analysis.quality.diagnostics.some(d => d.severity === 'error' && (!d.path || d.path === node.source?.path))) {
    throw new AppError('Compiler errors prevent verifying the protected interface: ' + node.name);
  }
  if (!contract.trim()) {
    if (!node.source) {
      throw new AppError('Freeze contract requires an explicit interface or valid, current source evidence.');
    }
    const evidence = resolveSourceEvidence(node.source, analysis, analysis?.revision);
    if (evidence.status !== 'current') {
      throw new AppError('Freeze contract requires an explicit interface or valid, current source evidence.');
    }
    const matches = analysis!.graph.nodes.filter(
      n =>
        n.kind === target.kind &&
        n.source?.path === evidence.source.path &&
        n.source.start === evidence.source.start &&
        n.source.end === evidence.source.end &&
        n.source.symbol === evidence.source.symbol &&
        n.source.hash === evidence.source.hash &&
        n.source.revision === evidence.source.revision
    );
    if (matches.length !== 1 || !matches[0].contract.trim()) {
      throw new AppError('Freeze contract requires an unambiguous declared interface.');
    }
    contract = matches[0].contract;
  }
  return NodeSchema.parse({ ...target, policy, baseline: { source: target.source, contract } });
}

export function resolveBindingRecord(node: ProgramNode, analysis: Analysis): BindingReviewRecord {
 if (node.source) {
  const key = sourceIdentityKey(node);
  const keyMatches = key
   ? analysis.graph.nodes.filter(n => sourceIdentityKey(n) === key)
   : [];
  if (keyMatches.length === 1) {
   const match = keyMatches[0];
   const cand: BindingCandidate = {
    id: match.id,
    name: match.name,
    kind: match.kind,
    source: match.source!,
    contract: match.contract,
    matchReason: 'Exact declaration key match',
    evidenceText: extractEvidenceText(match.source, analysis.files),
   };
   return {
    nodeId: node.id,
    nodeName: node.name,
    kind: node.kind,
    policy: node.policy,
    status: 'unambiguous',
    currentBinding: node.source,
    contract: node.contract,
    baseline: node.baseline,
    candidates: [cand],
    selectedCandidate: cand,
    reason: `Unambiguous match preserved for '${node.name}'`,
   };
  }
  if (keyMatches.length > 1) {
   return {
    nodeId: node.id,
    nodeName: node.name,
    kind: node.kind,
    policy: node.policy,
    status: 'ambiguous',
    currentBinding: node.source,
    contract: node.contract,
    baseline: node.baseline,
    candidates: keyMatches.map(m => ({
     id: m.id,
     name: m.name,
     kind: m.kind,
     source: m.source!,
     contract: m.contract,
     matchReason: 'Duplicate matching key in source',
     evidenceText: extractEvidenceText(m.source, analysis.files),
    })),
    reason: `Ambiguous match: multiple declarations with duplicate key '${key}'`,
   };
  }
 }

 // Not matched by exact key: search for candidate declarations by scoped declaration evidence
 const candidates = analysis.graph.nodes.filter(n => {
  if (n.kind !== node.kind) return false;
  const sameName = n.name === node.name;
  const samePath = Boolean(node.source?.path && n.source?.path && node.source.path === n.source.path);
  const contractsMatch = Boolean(
   node.contract && n.contract &&
   normalizeContract(node.contract) === normalizeContract(n.contract)
  );
  const signaturesMatch = Boolean(
   node.contract && n.contract &&
   contractSignature(node.contract) &&
   contractSignature(node.contract) === contractSignature(n.contract)
  );
  const nameSimilar = Boolean(
   n.name.toLowerCase().includes(node.name.toLowerCase()) ||
   node.name.toLowerCase().includes(n.name.toLowerCase())
  );
  if (sameName && (samePath || contractsMatch || !node.source?.path)) return true;
  if (samePath && contractsMatch) return true;
  if (sameName) return true;
  if (contractsMatch) return true;
  if (signaturesMatch && nameSimilar) return true;
  return false;
 });

 if (candidates.length > 1) {
  return {
   nodeId: node.id,
   nodeName: node.name,
   kind: node.kind,
   policy: node.policy,
   status: 'ambiguous',
   currentBinding: node.source,
   contract: node.contract,
   baseline: node.baseline,
   candidates: candidates.map(c => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    source: c.source!,
    contract: c.contract,
    matchReason: 'Matching candidate declaration',
    evidenceText: extractEvidenceText(c.source, analysis.files),
   })),
   reason: `Ambiguous match: ${candidates.length} candidate declarations match '${node.name}'`,
  };
 }

 if (candidates.length === 1) {
  const single = candidates[0];
  const isProtected = node.policy === 'frozen-implementation' || node.policy === 'frozen-contract' || node.policy === 'sensitive';
  const isMovedOrRenamed = Boolean(node.source && (
   node.source.path !== single.source?.path ||
   (node.source.symbol && single.source?.symbol && node.source.symbol !== single.source.symbol)
  ));

  const cand: BindingCandidate = {
   id: single.id,
   name: single.name,
   kind: single.kind,
   source: single.source!,
   contract: single.contract,
   matchReason: isProtected && isMovedOrRenamed
    ? 'Candidate match requires binding review for protected item'
    : 'Unique candidate match',
   evidenceText: extractEvidenceText(single.source, analysis.files),
  };

  if (isProtected && isMovedOrRenamed) {
   return {
    nodeId: node.id,
    nodeName: node.name,
    kind: node.kind,
    policy: node.policy,
    status: 'ambiguous',
    currentBinding: node.source,
    contract: node.contract,
    baseline: node.baseline,
    candidates: [cand],
    reason: `Protected item '${node.name}' was moved or renamed; requires explicit binding review`,
   };
  }

  return {
   nodeId: node.id,
   nodeName: node.name,
   kind: node.kind,
   policy: node.policy,
   status: 'unambiguous',
   currentBinding: node.source,
   contract: node.contract,
   baseline: node.baseline,
   candidates: [cand],
   selectedCandidate: cand,
   reason: `Unambiguous candidate match found for '${node.name}'`,
  };
 }

 return {
  nodeId: node.id,
  nodeName: node.name,
  kind: node.kind,
  policy: node.policy,
  status: 'unresolved',
  currentBinding: node.source,
  contract: node.contract,
  baseline: node.baseline,
  candidates: [],
  reason: `Declaration '${node.name}' not found in analyzed source`,
 };
}

export function resolveBinding(node: ProgramNode, analysis: Analysis): ProgramNode | undefined {
 const record = resolveBindingRecord(node, analysis);
 if (record.status === 'unambiguous' && record.selectedCandidate) {
  return analysis.graph.nodes.find(n => n.id === record.selectedCandidate?.id);
 }
 return undefined;
}

export function reconcileSourceBindings(
 specification: Graph,
 analysis: Analysis,
 previousAnalysis?: Analysis
): BindingReviewRecord[] {
 const records: BindingReviewRecord[] = [];
 for (const node of specification.nodes) {
  if (node.kind === 'system' || node.kind === 'step') continue;
  if (!node.source && node.policy === 'editable') continue;
  const record = resolveBindingRecord(node, analysis);
  records.push(record);
 }

 // Detect contested candidate declarations across specification nodes
 const candidateClaims = new Map<string, string[]>();
 for (const rec of records) {
  if (rec.selectedCandidate) {
   const list = candidateClaims.get(rec.selectedCandidate.id) || [];
   list.push(rec.nodeId);
   candidateClaims.set(rec.selectedCandidate.id, list);
  }
 }
 for (const rec of records) {
  if (rec.selectedCandidate) {
   const claimants = candidateClaims.get(rec.selectedCandidate.id);
   if (claimants && claimants.length > 1) {
    rec.status = 'ambiguous';
    rec.selectedCandidate = undefined;
    rec.reason = `Ambiguous match: candidate declaration is contested by multiple specification nodes`;
   }
  }
 }

 return records;
}

export {reconcileGraphIdentities, type ReconcileGraphResult};

export interface AcceptBindingOptions {
  preserveBaseline?: boolean;
}

export function acceptBinding(
  node: ProgramNode,
  candidate: BindingCandidate,
  options?: AcceptBindingOptions
): ProgramNode {
  const preserveBaseline = options?.preserveBaseline ?? true;
  const updated: ProgramNode = {
    ...node,
    source: candidate.source,
  };
  if (candidate.name && candidate.name !== node.name) {
    updated.name = candidate.name;
  }
  if (candidate.contract) {
    updated.contract = candidate.contract;
  }
  // Baseline preservation: Retain original baseline unless explicitly instructed otherwise
  if (preserveBaseline && node.baseline) {
    updated.baseline = { ...node.baseline };
  }
  return NodeSchema.parse(updated);
}

export function acceptBindingInGraph(
  specification: Graph,
  nodeId: string,
  candidate: BindingCandidate,
  options?: AcceptBindingOptions
): Graph {
  const nodeIndex = specification.nodes.findIndex(n => n.id === nodeId);
  if (nodeIndex === -1) {
    throw new AppError(`Node with ID '${nodeId}' not found in specification`, 404);
  }
  const targetNode = specification.nodes[nodeIndex];
  const updatedNode = acceptBinding(targetNode, candidate, options);
  const newNodes = [...specification.nodes];
  newNodes[nodeIndex] = updatedNode;

  return GraphSchema.parse({
    ...specification,
    nodes: newNodes,
  });
}

export function acceptBindingCandidate(
  specification: Graph,
  nodeId: string,
  candidateId: string,
  analysis: Analysis,
  options?: AcceptBindingOptions
): { graph: Graph; updatedNode: ProgramNode } {
  const targetNode = specification.nodes.find(n => n.id === nodeId);
  if (!targetNode) {
    throw new AppError(`Node with ID '${nodeId}' not found in specification`, 404);
  }
  const review = resolveBindingRecord(targetNode, analysis);
  let candidate = review.candidates.find(c => c.id === candidateId);
  if (!candidate) {
    const analysisNode = analysis.graph.nodes.find(n => n.id === candidateId);
    if (analysisNode && analysisNode.source) {
      candidate = {
        id: analysisNode.id,
        name: analysisNode.name,
        kind: analysisNode.kind,
        source: analysisNode.source,
        contract: analysisNode.contract,
        matchReason: 'Direct candidate selection from analysis',
        evidenceText: extractEvidenceText(analysisNode.source, analysis.files),
      };
    }
  }

  if (!candidate) {
    throw new AppError(`Candidate '${candidateId}' not found for node '${nodeId}'`, 404);
  }

  const updatedNode = acceptBinding(targetNode, candidate, options);
  const graph = acceptBindingInGraph(specification, nodeId, candidate, options);
  return { graph, updatedNode };
}

export function protectionIssues(project:Project,analysis:Analysis):ValidationIssue[]{
 const issues:ValidationIssue[]=[];
 const reviews = reconcileSourceBindings(project.specification, analysis);
 const reviewMap = new Map(reviews.map(r => [r.nodeId, r]));

 for(const node of project.specification.nodes){
  if(node.policy!=='frozen-implementation'&&node.policy!=='frozen-contract')continue;
  const review = reviewMap.get(node.id) || resolveBindingRecord(node, analysis);
  if (review.status === 'ambiguous') {
   issues.push({
    code: 'binding',
    message: `Protected item has ambiguous binding: ${node.name} (${review.candidates.length} candidates)`,
    nodeId: node.id,
    path: node.source?.path,
   });
   continue;
  }
  if (review.status === 'unresolved') {
   issues.push({
    code: 'binding',
    message: `Protected item cannot be resolved: ${node.name}`,
    nodeId: node.id,
    path: node.source?.path,
   });
   continue;
  }
  const actual = review.selectedCandidate ? analysis.graph.nodes.find(n => n.id === review.selectedCandidate?.id) : undefined;
  if(!actual?.source){
   issues.push({code:'binding',message:'Protected item cannot be resolved: '+node.name,nodeId:node.id,path:node.source?.path});
   continue;
  }
  const evidence=resolveSourceEvidence(actual.source,analysis,analysis.revision);
  if(evidence.status!=='current'){
   issues.push({code:'binding',message:'Protected source evidence is '+evidence.status+': '+('message' in evidence?evidence.message:node.name),nodeId:node.id,path:actual.source.path});continue;
  }
  if(node.policy==='frozen-implementation'){
   if(node.baseline?.text===undefined){issues.push({code:'baseline',message:'Missing implementation baseline: '+node.name,nodeId:node.id});continue;}
   if(evidence.text!==node.baseline.text)issues.push({code:'frozen-implementation',message:'Frozen implementation changed: '+node.name,nodeId:node.id,path:actual.source.path});
  }else{
   const expected=node.baseline?.contract||node.contract;
   if(!expected||normalizeContract(actual.contract)!==normalizeContract(expected))issues.push({code:'frozen-contract',message:'Frozen interface changed: '+node.name,nodeId:node.id,path:actual.source.path});
   if(analysis.quality.diagnostics.some(d=>d.severity==='error'&&(!d.path||d.path===actual.source?.path)))issues.push({code:'unverified-contract',message:'Compiler/schema errors prevent verifying the protected interface: '+node.name,nodeId:node.id});
  }
 }
 return issues;
}

export function computeDivergenceReport(project: Project, analysis: Analysis): DivergenceReport {
  const items: DivergenceItem[] = [];
  const reviews = reconcileSourceBindings(project.specification, analysis);
  const reviewMap = new Map(reviews.map(r => [r.nodeId, r]));

  // 1. Process specification nodes against implemented analysis
  for (const node of project.specification.nodes) {
    if (node.kind === 'system' || node.kind === 'step') continue;
    const review = reviewMap.get(node.id) || resolveBindingRecord(node, analysis);

    // Protected nodes: check deterministic frozen boundary violations
    if (node.policy === 'frozen-implementation' || node.policy === 'frozen-contract') {
      if (review.status === 'ambiguous') {
        items.push({
          id: `divergence-ambiguous-${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          nodeKind: node.kind,
          policy: node.policy,
          kind: 'ambiguous-protected-binding',
          category: 'protection-violation',
          isDeterministicDefect: true,
          message: `Protected item has ambiguous binding: ${node.name} (${review.candidates.length} candidates)`,
          details: `Multiple candidate declarations match this protected symbol. Explicit binding review is required before verification.`,
          evidence: node.source ? {
            path: node.source.path,
            line: node.source.line,
            start: node.source.start,
            end: node.source.end,
            hash: node.source.hash,
            revision: node.source.revision,
            symbol: node.source.symbol,
          } : undefined,
          timestamp: analysis.analyzedAt,
        });
        continue;
      }

      if (review.status === 'unresolved') {
        items.push({
          id: `divergence-unresolved-${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          nodeKind: node.kind,
          policy: node.policy,
          kind: 'unresolved-protected-binding',
          category: 'protection-violation',
          isDeterministicDefect: true,
          message: `Protected item cannot be resolved in source: ${node.name}`,
          details: `The declaration was not found in analyzed source files. Protected boundary cannot be verified.`,
          evidence: node.source ? {
            path: node.source.path,
            line: node.source.line,
            start: node.source.start,
            end: node.source.end,
            hash: node.source.hash,
            revision: node.source.revision,
            symbol: node.source.symbol,
          } : undefined,
          timestamp: analysis.analyzedAt,
        });
        continue;
      }

      const actual = review.selectedCandidate ? analysis.graph.nodes.find(n => n.id === review.selectedCandidate?.id) : undefined;
      if (!actual?.source) {
        items.push({
          id: `divergence-unresolved-${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          nodeKind: node.kind,
          policy: node.policy,
          kind: 'unresolved-protected-binding',
          category: 'protection-violation',
          isDeterministicDefect: true,
          message: `Protected item cannot be resolved in source: ${node.name}`,
          details: `No bound source declaration found for protected item.`,
          evidence: node.source ? {
            path: node.source.path,
            line: node.source.line,
            hash: node.source.hash,
            revision: node.source.revision,
          } : undefined,
          timestamp: analysis.analyzedAt,
        });
        continue;
      }

      const evidence = resolveSourceEvidence(actual.source, analysis, analysis.revision);
      if (evidence.status !== 'current') {
        items.push({
          id: `divergence-stale-evidence-${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          nodeKind: node.kind,
          policy: node.policy,
          kind: 'unresolved-protected-binding',
          category: 'protection-violation',
          isDeterministicDefect: true,
          message: `Protected source evidence is ${evidence.status}: ${'message' in evidence ? evidence.message : node.name}`,
          details: `Captured evidence is ${evidence.status}.`,
          evidence: {
            path: actual.source.path,
            line: actual.source.line,
            hash: actual.source.hash,
            revision: actual.source.revision,
            symbol: actual.source.symbol,
          },
          timestamp: analysis.analyzedAt,
        });
        continue;
      }

      if (node.policy === 'frozen-implementation') {
        if (node.baseline?.text === undefined) {
          items.push({
            id: `divergence-missing-baseline-${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            policy: node.policy,
            kind: 'frozen-implementation-violation',
            category: 'protection-violation',
            isDeterministicDefect: true,
            message: `Missing implementation baseline for '${node.name}'`,
            details: `Frozen implementation requires an exact text baseline.`,
            evidence: {
              path: actual.source.path,
              line: actual.source.line,
              hash: actual.source.hash,
              revision: actual.source.revision,
              symbol: actual.source.symbol,
            },
            timestamp: analysis.analyzedAt,
          });
        } else if (evidence.text !== node.baseline.text) {
          items.push({
            id: `divergence-frozen-impl-${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            policy: node.policy,
            kind: 'frozen-implementation-violation',
            category: 'protection-violation',
            isDeterministicDefect: true,
            message: `Frozen implementation changed for '${node.name}'`,
            details: `External edit modified source code inside frozen implementation boundary without authorization. Protected baseline remains intact.`,
            evidence: {
              path: actual.source.path,
              line: actual.source.line,
              start: actual.source.start,
              end: actual.source.end,
              hash: actual.source.hash,
              revision: actual.source.revision,
              symbol: actual.source.symbol,
              expectedText: node.baseline.text,
              actualText: evidence.text,
              snippet: evidence.text.slice(0, 300),
            },
            timestamp: analysis.analyzedAt,
          });
        }
      } else if (node.policy === 'frozen-contract') {
        const expectedContract = node.baseline?.contract || node.contract;
        if (!expectedContract || normalizeContract(actual.contract) !== normalizeContract(expectedContract)) {
          items.push({
            id: `divergence-frozen-contract-${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            policy: node.policy,
            kind: 'frozen-contract-violation',
            category: 'protection-violation',
            isDeterministicDefect: true,
            message: `Frozen interface contract changed for '${node.name}'`,
            details: `External edit modified declared contract of a frozen boundary. Protected baseline remains intact.`,
            evidence: {
              path: actual.source.path,
              line: actual.source.line,
              start: actual.source.start,
              end: actual.source.end,
              hash: actual.source.hash,
              revision: actual.source.revision,
              symbol: actual.source.symbol,
              expectedContract,
              actualContract: actual.contract,
              snippet: actual.contract,
            },
            timestamp: analysis.analyzedAt,
          });
        }
        if (analysis.quality.diagnostics.some(d => d.severity === 'error' && (!d.path || d.path === actual.source?.path))) {
          items.push({
            id: `divergence-unverified-contract-${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            policy: node.policy,
            kind: 'unverified-contract',
            category: 'protection-violation',
            isDeterministicDefect: true,
            message: `Compiler/schema errors prevent verifying protected interface for '${node.name}'`,
            details: `Diagnostics exist in source file preventing contract verification.`,
            evidence: {
              path: actual.source.path,
              line: actual.source.line,
              symbol: actual.source.symbol,
            },
            timestamp: analysis.analyzedAt,
          });
        }
      }
    } else {
      // Editable or sensitive node: structural drift (not a deterministic defect)
      if (review.status === 'unresolved') {
        items.push({
          id: `divergence-missing-${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          nodeKind: node.kind,
          policy: node.policy,
          kind: 'missing-node',
          category: 'structural-drift',
          isDeterministicDefect: false,
          message: `Intended specification item '${node.name}' is not present in implemented code`,
          details: `Item declared in specification does not exist in analyzed source files. Business intent is pending implementation or was removed; not a deterministic code defect.`,
          evidence: node.source ? {
            path: node.source.path,
            line: node.source.line,
            start: node.source.start,
            end: node.source.end,
            hash: node.source.hash,
            revision: node.source.revision,
            symbol: node.source.symbol,
          } : undefined,
          timestamp: analysis.analyzedAt,
        });
      } else if (review.selectedCandidate) {
        const actual = analysis.graph.nodes.find(n => n.id === review.selectedCandidate?.id);
        if (actual) {
          if (node.contract.trim() && actual.contract.trim() && normalizeContract(node.contract) !== normalizeContract(actual.contract)) {
            items.push({
              id: `divergence-contract-${node.id}`,
              nodeId: node.id,
              nodeName: node.name,
              nodeKind: node.kind,
              policy: node.policy,
              kind: 'contract-drift',
              category: 'structural-drift',
              isDeterministicDefect: false,
              message: `Implemented contract for '${node.name}' drifted from intended specification`,
              details: `Source code declaration differs from human specification contract. Intended: "${node.contract.trim()}", Implemented: "${actual.contract.trim()}". Human review can adopt or align.`,
              evidence: {
                path: actual.source?.path || node.source?.path || '',
                line: actual.source?.line,
                start: actual.source?.start,
                end: actual.source?.end,
                hash: actual.source?.hash,
                revision: actual.source?.revision,
                symbol: actual.source?.symbol,
                expectedContract: node.contract,
                actualContract: actual.contract,
                snippet: actual.contract,
              },
              timestamp: analysis.analyzedAt,
            });
          } else if (node.source && actual.source && node.source.hash !== actual.source.hash) {
            const evidenceText = extractEvidenceText(actual.source, analysis.files);
            items.push({
              id: `divergence-impl-${node.id}`,
              nodeId: node.id,
              nodeName: node.name,
              nodeKind: node.kind,
              policy: node.policy,
              kind: 'implementation-drift',
              category: 'structural-drift',
              isDeterministicDefect: false,
              message: `Implementation updated in source for editable '${node.name}'`,
              details: `External source changes were detected. The intended contract and architecture remain aligned. Unknown business intent is retained without defect.`,
              evidence: {
                path: actual.source.path,
                line: actual.source.line,
                start: actual.source.start,
                end: actual.source.end,
                hash: actual.source.hash,
                revision: actual.source.revision,
                symbol: actual.source.symbol,
                actualContract: actual.contract,
                snippet: evidenceText ? evidenceText.slice(0, 300) : actual.contract,
              },
              timestamp: analysis.analyzedAt,
            });
          }
        }
      }
    }
  }

  // 2. Discover newly added nodes in implemented code (not in specification)
  for (const actualNode of analysis.graph.nodes) {
    if (actualNode.kind === 'system' || actualNode.kind === 'step') continue;
    const isMapped = project.specification.nodes.some(sn => {
      const rev = reviewMap.get(sn.id);
      return (
        rev?.selectedCandidate?.id === actualNode.id ||
        (sn.source && actualNode.source && sn.source.path === actualNode.source.path && sn.name === actualNode.name)
      );
    });
    if (!isMapped) {
      items.push({
        id: `divergence-added-${actualNode.id}`,
        nodeName: actualNode.name,
        nodeKind: actualNode.kind,
        kind: 'added-node',
        category: 'structural-drift',
        isDeterministicDefect: false,
        message: `Implemented code '${actualNode.name}' (${actualNode.kind}) is not yet declared in architecture specification`,
        details: `Newly analyzed code declaration found in ${actualNode.source?.path || 'source'}. Human review can adopt into intended architecture.`,
        evidence: actualNode.source ? {
          path: actualNode.source.path,
          line: actualNode.source.line,
          start: actualNode.source.start,
          end: actualNode.source.end,
          hash: actualNode.source.hash,
          revision: actualNode.source.revision,
          symbol: actualNode.source.symbol,
          actualContract: actualNode.contract,
          snippet: actualNode.contract || extractEvidenceText(actualNode.source, analysis.files),
        } : undefined,
        timestamp: analysis.analyzedAt,
      });
    }
  }

  // 3. Check uncertain relationships and quality indicators (R39)
  for (const edge of analysis.graph.edges) {
    if (edge.uncertain) {
      items.push({
        id: `divergence-uncertain-edge-${edge.id}`,
        kind: 'uncertain-intent',
        category: 'uncertainty',
        isDeterministicDefect: false,
        message: `Inferred relationship (${edge.kind}) retains runtime uncertainty`,
        details: `AI-inferred or dynamic relationship cannot be proved structurally. Tests and human review complement structural analysis.`,
        timestamp: analysis.analyzedAt,
      });
    }
  }

  if (analysis.quality.unresolvedReferences > 0) {
    items.push({
      id: `divergence-unresolved-refs-${analysis.revision || 'init'}`,
      kind: 'uncertain-intent',
      category: 'uncertainty',
      isDeterministicDefect: false,
      message: `${analysis.quality.unresolvedReferences} call targets retain runtime uncertainty`,
      details: `Static compiler analysis could not resolve all call targets. Tests and human review complement structural analysis; not a deterministic code defect.`,
      timestamp: analysis.analyzedAt,
    });
  }

  if (analysis.quality.unsupportedConstructs > 0) {
    items.push({
      id: `divergence-unsupported-constructs-${analysis.revision || 'init'}`,
      kind: 'uncertain-intent',
      category: 'uncertainty',
      isDeterministicDefect: false,
      message: `${analysis.quality.unsupportedConstructs} workflow blocks retain control-flow uncertainty`,
      details: `Unsupported constructs remain visible as source-backed opaque nodes. Runtime behavior retains uncertainty.`,
      timestamp: analysis.analyzedAt,
    });
  }

  const protectionViolations = items.filter(i => i.category === 'protection-violation').length;
  const structuralDriftCount = items.filter(i => i.category === 'structural-drift').length;
  const uncertainCount = items.filter(i => i.category === 'uncertainty').length;

  return DivergenceReportSchema.parse({
    projectId: project.id,
    revision: analysis.revision,
    sequence: analysis.sequence,
    analyzedAt: analysis.analyzedAt,
    status: analysis.status,
    items,
    summary: {
      totalDrift: items.length,
      protectionViolations,
      structuralDriftCount,
      uncertainCount,
      hasBlockingViolations: protectionViolations > 0,
    },
  });
}
export function inScope(path:string,scope:string[]){
 return scope.some(prefix=>prefix==='.'||path===prefix||(prefix.endsWith('/')&&path.startsWith(prefix)));
}
export async function validateCandidate(project:Project,job:AgentJob,options?:Pick<SandboxOptions,'signal'|'onProcess'>):Promise<ValidationReport>{
 options?.signal?.throwIfAborted();
 const before=await captureFiles(job.baseline||project.root);const after=await captureFiles(job.workspace);
 const beforeModes=fileModes(before),afterModes=fileModes(after);
 const issues:ValidationIssue[]=[];const warnings:string[]=[];
 if(isRevisionIncomplete(before)||isRevisionIncomplete(after))issues.push({code:'capture',message:'Files changed while capturing validation evidence'});
 if(!isDeepStrictEqual(hashes(before),job.sourceHashes)||job.sourceModes&&!isDeepStrictEqual(beforeModes,job.sourceModes))issues.push({code:'baseline',message:'The captured job baseline changed'});
 const unsafe=(await scanProjectDirectory(job.workspace)).excludedEntries.filter(entry=>entry.reason==='symlink'&&entry.path!=='node_modules'||entry.reason==='sensitive-file');
 for(const entry of unsafe)issues.push({code:'path',path:entry.path,message:'Unsafe or private candidate entry: '+entry.path});
 const changes:FileChange[]=[];
 issues.push(...dependencyIssues(job.workspace,before,after));
 for(const path of Array.from(new Set([...Object.keys(before),...Object.keys(after)])).sort()){
  if(before[path]&&after[path]&&before[path].equals(after[path])&&beforeModes[path]===afterModes[path])continue;
  const binary=[before[path],after[path]].some(bytes=>bytes&&(bytes.includes(0)||!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes)));
  const encoding=binary?'base64':'utf8';
  const oldText=before[path]?.toString(encoding)??null;const newText=after[path]?.toString(encoding)??null;
  changes.push({path,kind:!before[path]?'added':!after[path]?'deleted':'modified',before:oldText,after:newText,beforeMode:beforeModes[path]??null,afterMode:afterModes[path]??null,encoding,diff:binary?'Binary file change':createTwoFilesPatch('before/'+path,'after/'+path,oldText||'',newText||'')});
  if(!inScope(path,job.scope))issues.push({code:'scope',message:'Change is outside the approved scope: '+path,path});
 }
 if(project.specRevision!==job.specRevision)issues.push({code:'stale-spec',message:'Specification changed after this task started.'});
 const original=await captureFiles(project.root);
 if(isRevisionIncomplete(original)||!isDeepStrictEqual(hashes(original),job.sourceHashes)||job.sourceModes&&!isDeepStrictEqual(fileModes(original),job.sourceModes))issues.push({code:'stale-source',message:'Source changed after this task started.'});
 let candidate:Analysis|undefined;
 try{candidate=await new Analyzer().analyze(job.workspace,{prismaValidationOptions:options});}
 catch(error){options?.signal?.throwIfAborted();issues.push({code:'analysis',message:(error as Error).message});}
 if(candidate){
  issues.push(...protectionIssues(project,candidate));
  const baselineErrors=new Set(project.analysis?.quality.diagnostics.filter(d=>d.severity==='error').map(d=>d.path+':'+d.code+':'+d.message)||[]);
  for(const d of candidate.quality.diagnostics)if(d.severity==='error'&&!baselineErrors.has(d.path+':'+d.code+':'+d.message))issues.push({code:'diagnostic',message:d.message,path:d.path});
  if(candidate.quality.unresolvedReferences)warnings.push(candidate.quality.unresolvedReferences+' call targets remain unresolved.');
  if(candidate.quality.unsupportedConstructs)warnings.push(candidate.quality.unsupportedConstructs+' workflow blocks have incomplete execution-path analysis.');
  if(candidate.quality.prismaValidation==='unavailable')warnings.push('Prisma schema parsed; project-version semantic validation is not yet available.');
  const mapped=new Map<string,ProgramNode>();
  for(const node of project.specification.nodes){const actual=resolveBinding(node,candidate);if(actual)mapped.set(node.id,actual);}
  for(const node of project.specification.nodes){
   if(node.kind==='function'||node.kind==='class'||node.kind==='interface'||node.kind==='entity'){
    const actual=mapped.get(node.id);
    const relevant=node.source&&changes.some(c=>c.path===node.source?.path)||!node.source;
    if(relevant&&(!actual||node.contract.trim()&&normalizeContract(actual.contract)!==normalizeContract(node.contract)))issues.push({code:'specification',message:!actual?'Required item is missing or has an ambiguous binding: '+node.name:'Declared interface/model differs: '+node.name,nodeId:node.id});
    if(relevant&&actual&&node.kind==='entity'){
     for(const field of node.fields){
      const found=actual.fields.find(item=>item.name===field.name);
      if(!found||field.type!==found.type||field.optional!==found.optional||field.key&&field.key!==found.key||field.mappedName!==undefined&&field.mappedName!==found.mappedName||field.defaultValue!==undefined&&field.defaultValue!==found.defaultValue)issues.push({code:'schema',message:'Declared entity field differs: '+node.name+'.'+field.name,nodeId:node.id,path:actual.source?.path});
     }
     if(node.mappedName!==undefined&&node.mappedName!==actual.mappedName)issues.push({code:'schema',message:'Declared database mapping differs: '+node.name,nodeId:node.id,path:actual.source?.path});
    }
   }
  }
  for(const kind of ['depends-on','calls'] as const){
   const declared=project.specification.edges.filter(e=>e.kind===kind);
   const constrained=new Set(declared.map(e=>e.source));
   for(const nodeId of constrained){
    const actual=mapped.get(nodeId);if(!actual)continue;
    const allowed=new Set(declared.filter(e=>e.source===nodeId).map(e=>mapped.get(e.target)?.id).filter(Boolean));
    for(const edge of candidate.graph.edges.filter(e=>e.kind===kind&&e.source===actual.id)){
     if(edge.uncertain){warnings.push('Dependency cannot be resolved for '+actual.name);continue;}
     if(!allowed.has(edge.target))issues.push({code:'dependency',message:'Undeclared '+kind+' relationship from '+actual.name,nodeId});
    }
   }
  }
 }
 const required=new Set(project.specification.nodes.flatMap(n=>n.requiredChecks));
 for(const id of required)if(!project.checks[id])issues.push({code:'required-check',message:'Required check is not configured: '+id});
 for(const change of changes.filter(change=>/(^|\/)(package\.json|(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml))$/.test(change.path)))warnings.push('Dependency manifest/lockfile changed: '+change.path+'. Inspect its file diff and declared dependency constraints.');
 options?.signal?.throwIfAborted();
 const finalFiles=await captureFiles(job.workspace);
 if(isRevisionIncomplete(finalFiles)||!isDeepStrictEqual(hashes(after),hashes(finalFiles))||!isDeepStrictEqual(afterModes,fileModes(finalFiles)))issues.push({code:'candidate-changed',message:'Candidate changed during validation'});
 return {passed:issues.length===0,issues,warnings,checks:{},changes,candidate,candidateHashes:hashes(after),candidateModes:afterModes,
  ...(candidate?{architectureDiff:{implemented:computeSpecificationDiff(project.analysis?.graph||emptyGraph(),candidate.graph),intended:computeSpecificationDiff(project.specification,candidate.graph)}}:{})};
}
export {applyReviewed,recoverPending,recoveryStatus} from './application';
