import { z } from 'zod';
export const nodeKinds = ['system','module','class','interface','function','entity','enum','step'] as const;
export const GRAPH_SCHEMA_VERSION = 1;
export const policies = ['editable','sensitive','frozen-implementation','frozen-contract'] as const;
export const SourceSchema = z.object({
  path: z.string(), symbol: z.string().optional(), start: z.number(), end: z.number(),
  line: z.number(), hash: z.string(), revision: z.string(),
});
export const NodeSchema = z.object({
  id: z.string().min(1), kind: z.enum(nodeKinds), name: z.string().min(1),
  parentId: z.string().min(1).optional(), description: z.string().default(''),
  provenance: z.enum(['human','extracted','ai']).default('human'),
  policy: z.enum(policies).default('editable'), contract: z.string().default(''),
  inputs: z.string().default(''), outputs: z.string().default(''), rules: z.string().default(''),
  errors: z.string().default(''), scenarios: z.array(z.string()).default([]),
  requiredChecks: z.array(z.string()).default([]), instructions: z.string().default(''),
  outputPath: z.string().default(''), source: SourceSchema.optional(),
  fields: z.array(z.object({ name:z.string(), type:z.string(), key:z.string().default(''), optional:z.boolean().default(false), mappedName:z.string().optional() })).default([]),
  stepType: z.enum(['operation','call','condition','loop','try','throw','return','opaque']).optional(),
  baseline: z.object({ text:z.string().optional(), contract:z.string().optional(), source:SourceSchema.optional() }).optional(),
});
export const EdgeSchema = z.object({
  id:z.string().min(1), source:z.string().min(1), target:z.string().min(1),
  kind:z.enum(['depends-on','calls','contains','inherits','implements','relates-to','next','true','false','reads','writes']),
  label:z.string().default(''), provenance:z.enum(['human','extracted','ai']).default('human'),
  uncertain:z.boolean().default(false),
});
export const RequirementSchema = z.object({
  id:z.string().min(1), text:z.string(),
  nodeIds:z.array(z.string().min(1)).default([]), edgeIds:z.array(z.string().min(1)).default([]),
  constraints:z.array(z.string()).default([]), scenarios:z.array(z.string()).default([]),
});
export function validRelationship(kind:ProgramEdge['kind'],source:ProgramNode['kind'],target:ProgramNode['kind']) {
  switch(kind) {
    case 'depends-on': return source!=='step' && target!=='step';
    // The same containment rules apply to edges and parentId; see shared/README.md.
    case 'contains':
      switch(source) {
        case 'system': return target!=='step';
        case 'module': return ['module','class','interface','function','entity','enum'].includes(target);
        case 'class': case 'interface': return ['class','interface','function','enum'].includes(target);
        case 'function': return ['class','interface','function','enum','step'].includes(target);
        case 'step': return target==='step';
        default: return false;
      }
    case 'calls': return ['system','module','class','function','step'].includes(source) && ['function','class'].includes(target);
    case 'inherits': return (source==='class' && target==='class') || (source==='interface' && ['interface','class'].includes(target));
    case 'implements': return source==='class' && ['interface','class'].includes(target);
    case 'relates-to': return source==='entity' && target==='entity';
    case 'next': case 'true': case 'false': return source==='step' && target==='step';
    case 'reads': case 'writes': return ['function','step'].includes(source) && target==='entity';
  }
}
export const GraphSchema = z.object({
  // Existing unversioned graphs are v1; an explicit version must match exactly.
  schemaVersion:z.literal(GRAPH_SCHEMA_VERSION).default(GRAPH_SCHEMA_VERSION),
  nodes:z.array(NodeSchema), edges:z.array(EdgeSchema), requirements:z.array(RequirementSchema).default([]),
}).superRefine((graph,ctx)=>{
  const nodes=new Map<string,ProgramNode>();
  graph.nodes.forEach((n,i)=>{
    if(nodes.has(n.id)) ctx.addIssue({code:'custom',path:['nodes',i,'id'],message:'Duplicate node ID: '+n.id});
    nodes.set(n.id,n);
  });
  const children=new Map(Array.from(nodes.keys(),id=>[id,new Set<string>()]));
  const incoming=new Map(Array.from(nodes.keys(),id=>[id,0]));
  const contain=(parent:string,child:string)=>{
    if(!children.get(parent)!.has(child)) {
      children.get(parent)!.add(child);
      incoming.set(child,incoming.get(child)!+1);
    }
  };
  graph.nodes.forEach((n,i)=>{
    if(n.parentId!==undefined) {
      const parent=nodes.get(n.parentId);
      if(!parent) ctx.addIssue({code:'custom',path:['nodes',i,'parentId'],message:'Missing parent: '+n.parentId});
      else {
        if(!validRelationship('contains',parent.kind,n.kind)) ctx.addIssue({code:'custom',path:['nodes',i,'parentId'],message:'Invalid contains relationship: '+parent.kind+' → '+n.kind});
        contain(n.parentId,n.id);
      }
    }
  });
  const edgeIds=new Set<string>();
  graph.edges.forEach((e,i)=>{
    if(edgeIds.has(e.id)) ctx.addIssue({code:'custom',path:['edges',i,'id'],message:'Duplicate edge ID: '+e.id});
    edgeIds.add(e.id);
    const source=nodes.get(e.source),target=nodes.get(e.target);
    if(!source) ctx.addIssue({code:'custom',path:['edges',i,'source'],message:'Missing edge endpoint: '+e.source});
    if(!target) ctx.addIssue({code:'custom',path:['edges',i,'target'],message:'Missing edge endpoint: '+e.target});
    if(source && target) {
      if(!validRelationship(e.kind,source.kind,target.kind)) ctx.addIssue({code:'custom',path:['edges',i,'kind'],message:'Invalid '+e.kind+' relationship: '+source.kind+' → '+target.kind});
      if(e.kind==='contains') contain(e.source,e.target);
    }
  });
  const requirementIds=new Set<string>();
  graph.requirements.forEach((r,i)=>{
    if(requirementIds.has(r.id)) ctx.addIssue({code:'custom',path:['requirements',i,'id'],message:'Duplicate requirement ID: '+r.id});
    requirementIds.add(r.id);
    r.nodeIds.forEach((id,j)=>{
      if(!nodes.has(id)) ctx.addIssue({code:'custom',path:['requirements',i,'nodeIds',j],message:'Missing requirement node: '+id});
    });
    r.edgeIds.forEach((id,j)=>{
      if(!edgeIds.has(id)) ctx.addIssue({code:'custom',path:['requirements',i,'edgeIds',j],message:'Missing requirement edge: '+id});
    });
  });
  // Only containment participates; calls and workflow loops can legitimately cycle.
  const pending=Array.from(incoming).filter(([,count])=>count===0).map(([id])=>id);
  let visited=0;
  while(pending.length) {
    const id=pending.pop()!;visited++;
    for(const child of children.get(id)!) {
      const count=incoming.get(child)!-1;incoming.set(child,count);
      if(count===0)pending.push(child);
    }
  }
  if(visited!==nodes.size) ctx.addIssue({code:'custom',path:['nodes'],message:'Containment cycle involving: '+Array.from(incoming).filter(([,count])=>count>0).map(([id])=>id).join(', ')});
});
export type ProgramNode=z.infer<typeof NodeSchema>;
export type ProgramEdge=z.infer<typeof EdgeSchema>;
export type Requirement=z.infer<typeof RequirementSchema>;
export type Graph=z.infer<typeof GraphSchema>;
export type GraphInput=z.input<typeof GraphSchema>;
export type Source=z.infer<typeof SourceSchema>;
export const createNodeId=():string=>globalThis.crypto.randomUUID();
// A candidate match key, never an ID: duplicate keys require binding review.
export function sourceIdentityKey(node:Pick<ProgramNode,'kind'|'source'>):string|undefined {
  const source=node.source;
  if(!source?.path || node.kind==='system' || node.kind==='step')return undefined;
  if(node.kind==='module')return JSON.stringify([source.path,node.kind,null]);
  if(!source.symbol)return undefined;
  return JSON.stringify([source.path,node.kind,source.symbol]);
}
export type Diagnostic={severity:'error'|'warning'|'info'; message:string; path?:string; line?:number; code?:string};
export type Quality={
  eligibleFiles:number; analyzedFiles:number; unresolvedReferences:number; unsupportedConstructs:number; inferredItems:number;
  prismaValidation:'passed'|'failed'|'unavailable'|'not-applicable';
  diagnostics:Diagnostic[];
};
export type Analysis={
  revision:string; sequence:number; analyzedAt:string; status:'current'|'partial'|'stale'|'updating';
  graph:Graph; quality:Quality; files:Record<string,{hash:string;text:string}>; durationMs:number;
};
export type Layout=Record<string,{x:number;y:number}>;
export type Project={
  id:string; name:string; description:string; target:string; root:string; managed:boolean; createdAt:string;
  specRevision:number; specification:Graph; layout:Layout; analysis?:Analysis;
  checks:Record<string,{command:string;args:string[]}>;
};
export type ValidationIssue={code:string;message:string;nodeId?:string;path?:string};
export type FileChange={path:string;kind:'added'|'modified'|'deleted';before:string|null;after:string|null;diff:string;encoding?:'utf8'|'base64'};
export type ValidationReport={passed:boolean;issues:ValidationIssue[];warnings:string[];checks:Record<string,{passed:boolean;output:string}>;changes:FileChange[];candidate?:Analysis};
export type DesignProposal={graph:Graph;explanation:string;questions:string[]};
export type AgentJob={
  id:string; projectId:string;kind:'implementation'|'design'|'import';
  status:'preparing'|'running'|'review'|'failed'|'cancelled'|'applied';
  createdAt:string;specRevision:number;sourceHashes:Record<string,string>;task:string;scope:string[];
  workspace:string;events:{time:string;message:string}[];report?:ValidationReport;
  proposal?:DesignProposal;preview?:Analysis;error?:string;
};
export const emptyGraph=():Graph=>({schemaVersion:GRAPH_SCHEMA_VERSION,nodes:[],edges:[],requirements:[]});
export function graphDelta(before:Graph,after:Graph) {
  const oldNodes=new Map(before.nodes.map(n=>[n.id,n]));
  const oldEdges=new Map(before.edges.map(e=>[e.id,e]));
  const oldRequirements=new Map(before.requirements.map(r=>[r.id,r]));
  return {
    changedNodes:after.nodes.filter(n=>JSON.stringify(n)!==JSON.stringify(oldNodes.get(n.id))),
    deletedNodes:before.nodes.filter(n=>!after.nodes.some(a=>a.id===n.id)).map(n=>n.id),
    changedEdges:after.edges.filter(e=>JSON.stringify(e)!==JSON.stringify(oldEdges.get(e.id))),
    deletedEdges:before.edges.filter(e=>!after.edges.some(a=>a.id===e.id)).map(e=>e.id),
    changedRequirements:after.requirements.filter(r=>JSON.stringify(r)!==JSON.stringify(oldRequirements.get(r.id))),
    deletedRequirements:before.requirements.filter(r=>!after.requirements.some(a=>a.id===r.id)).map(r=>r.id),
  };
}
