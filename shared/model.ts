import { z } from 'zod';
export const nodeKinds = ['system','module','class','interface','function','entity','enum','step'] as const;
export const policies = ['editable','sensitive','frozen-implementation','frozen-contract'] as const;
export const SourceSchema = z.object({
  path: z.string(), symbol: z.string().optional(), start: z.number(), end: z.number(),
  line: z.number(), hash: z.string(), revision: z.string(),
});
export const NodeSchema = z.object({
  id: z.string().min(1), kind: z.enum(nodeKinds), name: z.string().min(1),
  parentId: z.string().optional(), description: z.string().default(''),
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
  id:z.string(), source:z.string(), target:z.string(),
  kind:z.enum(['depends-on','calls','contains','inherits','implements','relates-to','next','true','false','reads','writes']),
  label:z.string().default(''), provenance:z.enum(['human','extracted','ai']).default('human'),
  uncertain:z.boolean().default(false),
});
export const GraphSchema = z.object({ nodes:z.array(NodeSchema), edges:z.array(EdgeSchema) }).superRefine((graph,ctx)=>{
  const ids = new Set<string>();
  for(const n of graph.nodes) {
    if(ids.has(n.id)) ctx.addIssue({code:'custom',message:'Duplicate node ID: '+n.id});
    ids.add(n.id);
  }
  const edgeIds=new Set<string>();
  for(const n of graph.nodes) if(n.parentId && !ids.has(n.parentId)) ctx.addIssue({code:'custom',message:'Missing parent: '+n.parentId});
  for(const e of graph.edges) {
    if(!ids.has(e.source)||!ids.has(e.target)) ctx.addIssue({code:'custom',message:'Missing edge endpoint'});
    if(edgeIds.has(e.id)) ctx.addIssue({code:'custom',message:'Duplicate edge ID'});
    edgeIds.add(e.id);
  }
  const parents=new Map(graph.nodes.map(n=>[n.id,n.parentId]));
  for(const n of graph.nodes) {
    const seen=new Set<string>(); let current:string|undefined=n.id;
    while(current) { if(seen.has(current)){ctx.addIssue({code:'custom',message:'Parent cycle'});break;} seen.add(current); current=parents.get(current); }
  }
});
export type ProgramNode=z.infer<typeof NodeSchema>;
export type ProgramEdge=z.infer<typeof EdgeSchema>;
export type Graph=z.infer<typeof GraphSchema>;
export type Source=z.infer<typeof SourceSchema>;
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
export const emptyGraph=():Graph=>({nodes:[],edges:[]});
export function graphDelta(before:Graph,after:Graph) {
  const oldNodes=new Map(before.nodes.map(n=>[n.id,n]));
  const oldEdges=new Map(before.edges.map(e=>[e.id,e]));
  return {
    changedNodes:after.nodes.filter(n=>JSON.stringify(n)!==JSON.stringify(oldNodes.get(n.id))),
    deletedNodes:before.nodes.filter(n=>!after.nodes.some(a=>a.id===n.id)).map(n=>n.id),
    changedEdges:after.edges.filter(e=>JSON.stringify(e)!==JSON.stringify(oldEdges.get(e.id))),
    deletedEdges:before.edges.filter(e=>!after.edges.some(a=>a.id===e.id)).map(e=>e.id),
  };
}
