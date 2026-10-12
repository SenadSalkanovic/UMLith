import {graphToPlantUml} from '../shared/plantuml';
import {zipSync,strToU8} from 'fflate';
import type {Project,Source} from '../shared/model';
import {HANDOFF_FILES,HANDOFF_SCHEMA_VERSION,HandoffPackageSchema,HandoffSpecificationSchema} from '../shared/export';

function sourceText(source:Source){
 return source.path+(source.symbol?' :: '+source.symbol:'')+'; offsets ['+source.start+', '+source.end+'); line '+source.line+'; hash '+source.hash+'; revision '+source.revision;
}
function codeBlock(text:string){
 // Baselines can contain Markdown fences; preserve their text inside a longer fence.
 let fence='```';
 for(const match of text.matchAll(/`+/g))if(match[0].length>=fence.length)fence=match[0]+'`';
 return fence+'\n'+text+'\n'+fence;
}
export function bundleFiles(project:Project,task:string,scope:string[]){
 const blueprint=HandoffSpecificationSchema.parse({schemaVersion:HANDOFF_SCHEMA_VERSION,project:{id:project.id,name:project.name,target:project.target,description:project.description},revision:project.specRevision,graph:project.specification,
  task,scope,checks:project.checks,sourceRevision:project.analysis?.revision||null,analysisStatus:project.analysis?.status??null,staleEvidence:project.analysis?.staleEvidence});
 const graph=blueprint.graph;
 const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
 const parents=new Map(graph.nodes.map(n=>[n.id,new Set(n.parentId?[n.parentId]:[])]));
 const children=new Map(graph.nodes.map(n=>[n.id,new Set<string>()]));
 for(const e of graph.edges)if(e.kind==='contains')parents.get(e.target)!.add(e.source);
 for(const [child,ids] of parents)for(const parent of ids)children.get(parent)!.add(child);
 const nodeText=(id:string)=>nodes.get(id)!.name+' ['+id+']';
 const scopeText='Allowed changes: '+blueprint.scope.join(', ')+'. A trailing slash denotes a directory prefix; "." denotes the complete included project.';
 const protectionText=[
  'Editable items may change only within the allowed scope. Output boundaries do not expand task scope.',
  'Preserve frozen implementations exactly and frozen interfaces structurally. Frozen contracts permit internal changes only while preserving their declared interfaces.',
  'Follow sensitive-area instructions and acceptance scenarios. Sensitive items require highlighted human review.',
  'Do not edit the specification, protection baselines, or task scope. If they prevent the task, explain the conflict and stop.',
  'Required but unavailable evidence or checks block application. Missing check definitions are not a pass.',
 ].join('\n\n');
 const uncertaintyText=[
  'Missing function details and workflows are unspecified; supplied details and scenarios do not prove implementation completeness.',
  'Runtime behavior and business intent remain uncertain; tests and human review complement structural analysis.',
  'AI-inferred items and uncertain relationships are unverified interpretations. Opaque steps retain source evidence for unsupported logic.',
  'Source bindings and protected baselines refer to their recorded revisions; they are not refreshed by export. See IMPORT_REPORT.json for analysis quality and diagnostics; coverage does not prove behavior.',
 ].join('\n\n');
 const checksText='## Configured checks\n\nCommands are argument arrays, not shell strings or execution results. Run required checks and report their results.\n\n'+
  (Object.entries(blueprint.checks).map(([name,check])=>'- '+name+': '+JSON.stringify([check.command,...check.args])).join('\n')||'No checks configured.');
 const sections=graph.nodes.map(n=>[
  '## '+n.name+' ('+n.kind+')',
  'Node ID: '+n.id,
  'Parents: '+(Array.from(parents.get(n.id)!,nodeText).join(', ')||'none (root)'),
  children.get(n.id)!.size?'Children: '+Array.from(children.get(n.id)!,nodeText).join(', '):'',
  n.description||'Description has not been specified.',
  'Provenance: '+n.provenance+(n.provenance==='ai'?' (inferred; unverified)':''),
  'Policy: '+n.policy,
  n.visibility!==undefined?'Visibility: '+n.visibility:'',
  n.isStatic!==undefined?'Static: '+n.isStatic:'',n.isAbstract!==undefined?'Abstract: '+n.isAbstract:'',
  n.moduleRole?'Module role: '+n.moduleRole:'',
  n.signature?'Signature: '+n.name+'('+n.signature.parameters.map(p=>p.name+(p.optional?'?':'')+': '+(p.type??'unknown')).join(', ')+'): '+(n.signature.returnType??'unknown'):'',
  n.contract?'Interface:\n\n'+codeBlock(n.contract):'',
  n.kind==='function'?'Workflow: '+(Array.from(children.get(n.id)!).some(id=>nodes.get(id)!.kind==='step')?'see contained steps and relationships':'unspecified; use the description and any supplied details without assuming a control flow.'):'',
  n.stepType?'Step type: '+n.stepType:'',
  n.inputs?'Inputs: '+n.inputs:'',n.outputs?'Outputs: '+n.outputs:'',
  n.rules?'Rules: '+n.rules:'',n.errors?'Errors: '+n.errors:'',
  n.instructions?'Care instructions: '+n.instructions:'',
  n.mappedName!==undefined?'Mapped name: '+n.mappedName:'',
  n.fields.length?'Fields:\n'+n.fields.map(f=>[
   '- '+f.name+': '+f.type+(f.optional?' (optional)':'')+(f.key?' ['+f.key+']':''),
   f.visibility!==undefined?'  Visibility: '+f.visibility:'',f.isStatic!==undefined?'  Static: '+f.isStatic:'',
   f.mappedName!==undefined?'  Mapped name: '+f.mappedName:'',
   f.defaultValue!==undefined?'  Default: '+f.defaultValue:'',
   f.source?'  Source binding: '+sourceText(f.source):'',
  ].filter(Boolean).join('\n')).join('\n'):'',
  ...( [['Composite keys',n.compositeKeys],['Indexes',n.indexes]] as const).map(([label,keys])=>keys?.length?label+':\n'+keys.map(k=>
   '- '+k.type+' ('+k.fields.join(', ')+')'+(k.name!==undefined?'; Name: '+k.name:'')+(k.mappedName!==undefined?'; Mapped name: '+k.mappedName:'')).join('\n'):''),
  n.scenarios?.length?'Acceptance scenarios:\n'+n.scenarios.map(s=>'- '+s).join('\n'):'',
  n.requiredChecks.length?'Required checks: '+n.requiredChecks.join(', '):'',
  ...n.requiredChecks.filter(name=>!Object.hasOwn(blueprint.checks,name)).map(name=>'Unavailable required check: '+name+'; application is blocked until configured and passed.'),
  n.outputPath?'Output boundary: '+n.outputPath:'',
  n.source?'Source binding: '+sourceText(n.source):'',
  n.baseline?.text!==undefined?'Frozen implementation baseline:\n\n'+codeBlock(n.baseline.text):'',
  n.baseline?.contract!==undefined?'Frozen contract baseline:\n\n'+codeBlock(n.baseline.contract):'',
  n.baseline?.source?'Baseline source: '+sourceText(n.baseline.source):'',
 ].filter(Boolean).join('\n\n'));
 const requirements=graph.requirements.map(r=>[
  '### '+r.id, r.text,
  r.nodeIds.length?'Graph nodes: '+r.nodeIds.join(', '):'',
  r.edgeIds.length?'Graph relationships: '+r.edgeIds.join(', '):'',
  r.constraints.length?'Constraints:\n'+r.constraints.map(s=>'- '+s).join('\n'):'',
  r.scenarios.length?'Acceptance scenarios:\n'+r.scenarios.map(s=>'- '+s).join('\n'):'',
 ].filter(s=>s!=='').join('\n\n'));
 const taskText=[
 '# Coding-agent task',task,
 'Read specification.json and ARCHITECTURE.md. The human-owned specification is authoritative.',
 'Target: '+blueprint.project.target+'. No generation template is implied by the target.',
 scopeText,
 'Implement in this workspace.',protectionText,checksText,
 'Preserve existing repository instructions. Add tests for required behavior. Do not claim that tests prove every prose requirement.',
 uncertaintyText,
 'Return a concise implementation summary and any unresolved requirements. Code will be independently analyzed and reviewed before application.',
 ].join('\n\n');
 const bundle=HandoffPackageSchema.parse({manifest:{schemaVersion:HANDOFF_SCHEMA_VERSION,projectId:blueprint.project.id,revision:blueprint.revision,sourceRevision:blueprint.sourceRevision,files:HANDOFF_FILES},specification:blueprint,
  architecture:['# '+blueprint.project.name,'Target: '+blueprint.project.target,blueprint.project.description,
   'Handoff format version: '+blueprint.schemaVersion,'Graph schema version: '+graph.schemaVersion,'## Task',blueprint.task,
   'No generation template is implied by the target.',
   'Specification revision: '+blueprint.revision,'Source revision: '+(blueprint.sourceRevision??'none captured'),
   'Analysis status: '+(blueprint.analysisStatus??'no source analyzed'),
   ...(blueprint.staleEvidence?['Stale evidence scope: '+blueprint.staleEvidence.scope,'Stale paths: '+(blueprint.staleEvidence.paths.join(', ')||'none specified'),blueprint.staleEvidence.reason]:[]),
   '## Scope and protection',scopeText,protectionText,checksText,'## Uncertainty',uncertaintyText,
   ...sections,...(requirements.length?['## Requirements',...requirements]:[]),'## Relationships',
   ...graph.edges.map(e=>'- '+e.id+': '+nodeText(e.source)+' '+e.kind+' '+nodeText(e.target)+(e.label?' ('+e.label+')':'')+(e.sourceEndpoint?'; source endpoint: '+JSON.stringify(e.sourceEndpoint):'')+(e.targetEndpoint?'; target endpoint: '+JSON.stringify(e.targetEndpoint):'')+(e.sourceFields?'; source fields: '+e.sourceFields.join(', '):'')+(e.targetFields?'; target fields: '+e.targetFields.join(', '):'')+'; provenance: '+e.provenance+'; uncertain: '+e.uncertain),
  ].join('\n\n'),
  task:taskText,importReport:project.analysis?.quality??{message:'No source has been analyzed.'}});
 const diagrams:Record<string,string>={overview:'diagrams/overview.puml',classes:'diagrams/classes.puml',database:'diagrams/database.puml'};
 const diagramFiles:Record<string,string>={};
 for(const view of ['overview','classes','database'] as const)diagramFiles[diagrams[view]]=graphToPlantUml({graph,view});
 graph.nodes.filter(node=>node.kind==='function').forEach((node,index)=>{const key='method:'+node.id,path=`diagrams/method-${index}.puml`;diagrams[key]=path;diagramFiles[path]=graphToPlantUml({graph,view:'classes',functionId:node.id});});
 return {[HANDOFF_FILES.manifest]:JSON.stringify({...bundle.manifest,diagrams},null,2),[HANDOFF_FILES.specification]:JSON.stringify(bundle.specification,null,2),[HANDOFF_FILES.architecture]:bundle.architecture+'\n\n## PlantUML diagrams\n\nCanonical diagram sources for this same revision: '+Object.values(diagrams).join(', ')+'. The graph and method IDs remain authoritative.\n',[HANDOFF_FILES.task]:bundle.task,[HANDOFF_FILES.importReport]:JSON.stringify(bundle.importReport,null,2),...diagramFiles};
}
export function exportBundle(project:Project,task:string,scope:string[]){
 return zipSync(Object.fromEntries(Object.entries(bundleFiles(project,task,scope)).map(([path,text])=>[path,strToU8(text)])));
}
