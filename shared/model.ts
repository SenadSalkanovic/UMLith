import { z } from 'zod';
export const nodeKinds = ['system','module','class','interface','function','entity','enum','step'] as const;
export const GRAPH_SCHEMA_VERSION = 1;
export const policies = ['editable','sensitive','frozen-implementation','frozen-contract'] as const;
export const ProvenanceSchema = z.enum(['human','extracted','ai']);
export const SourceSchema = z.object({
  path: z.string().refine(value=>!!value.trim()), symbol: z.string().optional(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  line: z.number().int().min(1), hash: z.string().refine(value=>!!value.trim()),
  revision: z.string().refine(value=>!!value.trim()),
}).refine(source=>source.end>=source.start,{path:['end'],message:'Source range ends before it starts'});
export const NodeFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  key: z.string().default(''),
  optional: z.boolean().default(false),
  mappedName: z.string().optional(),
  defaultValue: z.string().optional(),
  source: SourceSchema.optional(),
});
export type NodeField = z.infer<typeof NodeFieldSchema>;
export const KeyDefinitionSchema = z.object({
  fields: z.array(z.string()),
  type: z.enum(['PK', 'UNIQUE', 'INDEX']),
  name: z.string().optional(),
  mappedName: z.string().optional(),
});
export type KeyDefinition = z.infer<typeof KeyDefinitionSchema>;
export const NodeSchema = z.object({
  id: z.string().min(1), kind: z.enum(nodeKinds), name: z.string().min(1),
  parentId: z.string().min(1).optional(), description: z.string().default(''),
  provenance: ProvenanceSchema.default('human'),
  policy: z.enum(policies).default('editable'), contract: z.string().default(''),
  // Missing details are unknown, including on source-backed extracted functions.
  inputs: z.string().optional(), outputs: z.string().optional(), rules: z.string().optional(),
  errors: z.string().optional(), scenarios: z.array(z.string()).optional(),
  requiredChecks: z.array(z.string().refine(value=>!!value.trim(),{message:'Required check reference must not be blank'})).default([]), instructions: z.string().default(''),
  outputPath: z.string().default(''), source: SourceSchema.optional(),
  fields: z.array(NodeFieldSchema).default([]),
  stepType: z.enum(['operation','call','condition','loop','try','throw','return','opaque']).optional(),
  baseline: z.object({ text:z.string().optional(), contract:z.string().optional(), source:SourceSchema.optional() }).optional(),
  mappedName: z.string().optional(),
  compositeKeys: z.array(KeyDefinitionSchema).optional(),
  indexes: z.array(KeyDefinitionSchema).optional(),
}).superRefine((node,ctx)=>{
  if(node.policy==='frozen-implementation') {
    if(!node.source)ctx.addIssue({code:'custom',path:['source'],message:'Frozen implementation requires a source binding'});
    if(!node.baseline?.source)ctx.addIssue({code:'custom',path:['baseline','source'],message:'Frozen implementation requires captured source evidence'});
    if(node.baseline?.text===undefined)ctx.addIssue({code:'custom',path:['baseline','text'],message:'Frozen implementation requires an exact text baseline'});
  }
  if(node.policy==='frozen-contract') {
    if(!node.source && !node.contract.trim())ctx.addIssue({code:'custom',path:['contract'],message:'Frozen contract requires a source binding or an explicit interface'});
    if(!node.baseline?.contract?.trim())ctx.addIssue({code:'custom',path:['baseline','contract'],message:'Frozen contract requires a declared interface baseline'});
  }
});
export const EdgeSchema = z.object({
  id:z.string().min(1), source:z.string().min(1), target:z.string().min(1),
  kind:z.enum(['depends-on','calls','contains','inherits','implements','relates-to','next','true','false','exception','reads','writes']),
  label:z.string().default(''), provenance:ProvenanceSchema.default('human'),
  uncertain:z.boolean().optional(),
}).transform(edge=>({...edge,uncertain:edge.uncertain??edge.provenance==='ai'}))
  .refine(edge=>edge.provenance!=='ai'||edge.uncertain,{path:['uncertain'],message:'AI-inferred relationships must remain uncertain'});
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
    case 'next': case 'true': case 'false': case 'exception': return source==='step' && target==='step';
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
  const parents=new Map(Array.from(nodes.keys(),id=>[id,new Set<string>()]));
  const incoming=new Map(Array.from(nodes.keys(),id=>[id,0]));
  const contain=(parent:string,child:string)=>{
    if(!children.get(parent)!.has(child)) {
      children.get(parent)!.add(child);
      parents.get(child)!.add(parent);
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
  const owners=new Map<string,string>();
  let visited=0;
  while(pending.length) {
    const id=pending.pop()!;visited++;
    for(const child of children.get(id)!) {
      if(nodes.get(child)!.kind==='step') {
        const owner=nodes.get(id)!.kind==='function'?id:owners.get(id);
        if(owner)owners.set(child,owner);
      }
      const count=incoming.get(child)!-1;incoming.set(child,count);
      if(count===0)pending.push(child);
    }
  }
  if(visited!==nodes.size) ctx.addIssue({code:'custom',path:['nodes'],message:'Containment cycle involving: '+Array.from(incoming).filter(([,count])=>count>0).map(([id])=>id).join(', ')});
  graph.nodes.forEach((n,i)=>{
    if(n.kind!=='step') {
      if(n.stepType!==undefined)ctx.addIssue({code:'custom',path:['nodes',i,'stepType'],message:'Only workflow steps have a step type'});
      return;
    }
    if(n.stepType===undefined)ctx.addIssue({code:'custom',path:['nodes',i,'stepType'],message:'Workflow steps require an explicit step type'});
    if(parents.get(n.id)!.size!==1)ctx.addIssue({code:'custom',path:['nodes',i,'parentId'],message:'Workflow steps require exactly one containment parent'});
    if(!owners.has(n.id))ctx.addIssue({code:'custom',path:['nodes',i,'parentId'],message:'Workflow steps require an owning function'});
    if(n.stepType==='opaque') {
      if(!n.source)
        ctx.addIssue({code:'custom',path:['nodes',i,'source'],message:'Opaque steps require source evidence with a path, range, line, content hash and analysis revision'});
    }
  });
  const branches=new Map<string,Set<string>>();
  graph.edges.forEach((e,i)=>{
    if(!['next','true','false','exception'].includes(e.kind))return;
    const source=nodes.get(e.source),target=nodes.get(e.target);
    if(source?.kind!=='step' || target?.kind!=='step')return;
    if(!owners.has(source.id) || owners.get(source.id)!==owners.get(target.id))
      ctx.addIssue({code:'custom',path:['edges',i,'target'],message:'Workflow flow must stay within the same owning function'});
    if(e.kind==='true' || e.kind==='false') {
      if(source.stepType!=='condition' && source.stepType!=='loop')
        ctx.addIssue({code:'custom',path:['edges',i,'kind'],message:'A branch must originate at a condition or loop'});
      const kinds=branches.get(source.id)??new Set<string>();
      if(kinds.has(e.kind))ctx.addIssue({code:'custom',path:['edges',i,'kind'],message:'Duplicate '+e.kind+' branch for step: '+source.id});
      kinds.add(e.kind);branches.set(source.id,kinds);
    }
    if(e.kind==='next' && (source.stepType==='return' || source.stepType==='throw'))
      ctx.addIssue({code:'custom',path:['edges',i,'kind'],message:'Return and throw steps cannot continue with next'});
  });
});
export type ProgramNode=z.infer<typeof NodeSchema>;
export type ProgramEdge=z.infer<typeof EdgeSchema>;
export type Requirement=z.infer<typeof RequirementSchema>;
export type Graph=z.infer<typeof GraphSchema>;
export type GraphInput=z.input<typeof GraphSchema>;
export type Source=z.infer<typeof SourceSchema>;
export type SourceEvidence=
  | {status:'current'|'stale';source:Source;text:string}
  | {status:'invalid'|'unavailable';message:string};
// Captures supply trusted hashes; never slice newer content using an older binding.
export function resolveSourceEvidence(source:Source|undefined,capture:Pick<Analysis,'revision'|'status'|'files'|'staleEvidence'>|undefined,currentRevision?:string):SourceEvidence {
  if(!source)return {status:'unavailable',message:'No source binding is available'};
  const parsed=SourceSchema.safeParse(source);
  if(!parsed.success)return {status:'invalid',message:parsed.error.message};
  if(!capture || capture.revision!==source.revision)
    return {status:'unavailable',message:'Captured source revision is unavailable: '+source.revision};
  const file=Object.hasOwn(capture.files,source.path)?capture.files[source.path]:undefined;
  if(!file)return {status:'unavailable',message:'Captured source file is unavailable: '+source.path};
  if(file.hash!==source.hash)return {status:'invalid',message:'Source content hash does not match the captured file'};
  if(source.end>file.text.length)return {status:'invalid',message:'Source range exceeds the captured content'};
  if(source.line!==file.text.slice(0,source.start).split('\n').length)
    return {status:'invalid',message:'Source line does not match the captured range'};
  const outdated=capture.staleEvidence?.scope==='all'||capture.staleEvidence?.paths.includes(source.path);
  const status=!outdated && source.revision===currentRevision && (capture.status==='current'||capture.status==='partial')?'current':'stale';
  return {status,source:parsed.data,text:file.text.slice(source.start,source.end)};
}
export const createNodeId=():string=>globalThis.crypto.randomUUID();
// A candidate match key, never an ID: duplicate keys require binding review.
export function sourceIdentityKey(node:Pick<ProgramNode,'kind'|'source'>):string|undefined {
  const source=node.source;
  if(!source?.path || node.kind==='system' || node.kind==='step')return undefined;
  if(node.kind==='module')return JSON.stringify([source.path,node.kind,null]);
  if(!source.symbol)return undefined;
  return JSON.stringify([source.path,node.kind,source.symbol]);
}
const NonblankSchema=z.string().refine(value=>!!value.trim(),{message:'Must not be blank'});
const CountSchema=z.number().int().nonnegative();
export const AnalysisStatusSchema=z.enum(['updating','current','partial','stale']);
export const DiagnosticSchema=z.object({
  severity:z.enum(['error','warning','info']),message:NonblankSchema,
  path:NonblankSchema.optional(),line:z.number().int().positive().optional(),code:NonblankSchema.optional(),
}).strict();
// These are structural coverage counts, never proof of runtime behavior or intent.
export const QualitySchema=z.object({
  eligibleFiles:CountSchema,analyzedFiles:CountSchema,unresolvedReferences:CountSchema,
  unsupportedConstructs:CountSchema,inferredItems:CountSchema,
  prismaValidation:z.enum(['passed','failed','unavailable','not-applicable']),diagnostics:z.array(DiagnosticSchema),
}).strict().refine(quality=>quality.analyzedFiles<=quality.eligibleFiles,{path:['analyzedFiles'],message:'Analyzed files exceed eligible files'});
export const StaleEvidenceSchema=z.object({
  scope:z.enum(['all','paths']),paths:z.array(NonblankSchema),reason:NonblankSchema,
}).strict().refine(evidence=>evidence.scope==='all'||evidence.paths.length>0,{path:['paths'],message:'Outdated portions require at least one path'});
const AnalysisMetadataSchema=z.object({
  revision:z.string().refine(value=>value===''||!!value.trim()),sequence:CountSchema,
  analyzedAt:z.iso.datetime({offset:true}),status:AnalysisStatusSchema,quality:QualitySchema,
  durationMs:z.number().finite().nonnegative(),staleEvidence:StaleEvidenceSchema.optional(),
});
function validateAnalysisStatus(value:{status:z.infer<typeof AnalysisStatusSchema>;staleEvidence?:z.infer<typeof StaleEvidenceSchema>},ctx:z.RefinementCtx) {
  if(value.status==='stale'&&!value.staleEvidence)
    ctx.addIssue({code:'custom',path:['staleEvidence'],message:'Stale analysis must identify outdated evidence'});
  if(value.status==='current'&&value.staleEvidence)
    ctx.addIssue({code:'custom',path:['staleEvidence'],message:'Current analysis cannot contain outdated evidence'});
}
export const AnalysisSchema=AnalysisMetadataSchema.extend({
  graph:GraphSchema,files:z.record(NonblankSchema,z.object({hash:NonblankSchema,text:z.string()}).strict()),
}).strict().superRefine((analysis,ctx)=>{
  validateAnalysisStatus(analysis,ctx);
  // Existing empty-revision sentinel means the first analysis failed, with no evidence.
  if(analysis.revision===''&&(analysis.status!=='stale'||analysis.sequence!==0||analysis.graph.nodes.length||analysis.graph.edges.length||analysis.graph.requirements.length||Object.keys(analysis.files).length))
    ctx.addIssue({code:'custom',path:['revision'],message:'An empty revision is only valid before any captured evidence'});
  if(analysis.revision!==''&&analysis.sequence===0)
    ctx.addIssue({code:'custom',path:['sequence'],message:'Captured evidence requires a positive publication sequence'});
});
export const GraphDeltaSchema=z.object({
  changedNodes:z.array(NodeSchema),deletedNodes:z.array(NodeSchema.shape.id),
  changedEdges:z.array(EdgeSchema),deletedEdges:z.array(z.string().min(1)),
  changedRequirements:z.array(RequirementSchema),deletedRequirements:z.array(RequirementSchema.shape.id),
}).strict().superRefine((delta,ctx)=>{
  for(const [changedKey,deletedKey] of [['changedNodes','deletedNodes'],['changedEdges','deletedEdges'],['changedRequirements','deletedRequirements']] as const) {
    const changed=new Set<string>(),deleted=new Set<string>();
    delta[changedKey].forEach((item,i)=>{
      if(changed.has(item.id))ctx.addIssue({code:'custom',path:[changedKey,i,'id'],message:'Duplicate changed ID: '+item.id});
      changed.add(item.id);
    });
    delta[deletedKey].forEach((id,i)=>{
      if(deleted.has(id)||changed.has(id))ctx.addIssue({code:'custom',path:[deletedKey,i],message:'Duplicate or changed/deleted ID: '+id});
      deleted.add(id);
    });
  }
});
export const GraphUpdateSchema=AnalysisMetadataSchema.extend({
  type:z.literal('analysis'),schemaVersion:z.literal(GRAPH_SCHEMA_VERSION),
  baseRevision:NonblankSchema.nullable(),baseSequence:CountSchema,delta:GraphDeltaSchema,
}).strict().superRefine((update,ctx)=>{
  validateAnalysisStatus(update,ctx);
  if(!update.revision)ctx.addIssue({code:'custom',path:['revision'],message:'Graph updates require a captured source revision'});
  if((update.baseRevision===null)!==(update.baseSequence===0))
    ctx.addIssue({code:'custom',path:['baseRevision'],message:'Only an empty lineage has a null base revision and zero base sequence'});
  if(update.sequence<=update.baseSequence)
    ctx.addIssue({code:'custom',path:['sequence'],message:'The next sequence must advance the base sequence'});
});
export type Diagnostic=z.infer<typeof DiagnosticSchema>;
export type Quality=z.infer<typeof QualitySchema>;
export type Analysis=z.infer<typeof AnalysisSchema>;
export type GraphDelta=z.infer<typeof GraphDeltaSchema>;
export type GraphUpdate=z.infer<typeof GraphUpdateSchema>;
export const LayoutSchema=z.record(z.string().min(1),z.object({x:z.number().finite(),y:z.number().finite()}).strict());
export const ScopedLayoutsSchema=z.record(z.string().refine(value=>!!value.trim()),LayoutSchema);
export type Layout=z.infer<typeof LayoutSchema>;
export type Project={
  id:string; name:string; description:string; target:string; root:string; managed:boolean; createdAt:string;
  specRevision:number; specification:Graph; layout:Layout; analysis?:Analysis;
  layoutRevision?:number; scopedLayouts?:Record<string,Layout>;
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
export function graphDelta(before:Graph,after:Graph):GraphDelta {
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
// A mismatch requires a fresh snapshot; never apply a delta to an unrelated graph.
export function applyGraphUpdate(before:Pick<Analysis,'revision'|'sequence'|'graph'>|undefined,input:unknown):Graph {
  const update=GraphUpdateSchema.parse(input);
  if((before?.revision||null)!==update.baseRevision)throw new Error('Graph update base revision mismatch; fetch a fresh snapshot');
  if((before?.sequence??0)!==update.baseSequence)throw new Error('Graph update base sequence mismatch; fetch a fresh snapshot');
  const graph=GraphSchema.parse(before?.graph??emptyGraph());
  const merge=<T extends {id:string}>(items:T[],changed:T[],deleted:string[])=>{
    const records=new Map(items.map(item=>[item.id,item]));
    for(const id of deleted)records.delete(id);
    for(const item of changed)records.set(item.id,item);
    return Array.from(records.values()).sort((a,b)=>a.id.localeCompare(b.id));
  };
  return GraphSchema.parse({schemaVersion:update.schemaVersion,
    nodes:merge(graph.nodes,update.delta.changedNodes,update.delta.deletedNodes),
    edges:merge(graph.edges,update.delta.changedEdges,update.delta.deletedEdges),
    requirements:merge(graph.requirements,update.delta.changedRequirements,update.delta.deletedRequirements),
  });
}
