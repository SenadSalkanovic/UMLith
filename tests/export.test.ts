import {it,expect} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unzipSync,strFromU8} from 'fflate';
import {ProjectStore} from '../server/store';
import {GraphSchema,NodeSchema,emptyGraph,type Project} from '../shared/model';
import {HandoffPackageSchema,HandoffSpecificationSchema,type HandoffPackage} from '../shared/export';
import {bundleFiles,exportBundle} from '../server/export';
import {Analyzer} from '../server/analyzer';
import {SyncService} from '../server/sync';
import {freezeNode,inScope} from '../server/review';

const emptyProject:Project={id:'test',name:'Test',target:'Other',description:'',root:'',managed:true,createdAt:'2026-10-11T00:00:00Z',specRevision:0,specification:emptyGraph(),layout:{},checks:{}};

it('renders description-only functions beside nested optional workflows with stable identities and uncertainty',()=>{
 const specification=GraphSchema.parse({nodes:[
  {id:'app',kind:'system',name:'Editor'},
  {id:'documents',kind:'module',name:'Documents',parentId:'app'},
  {id:'describe',kind:'function',name:'save',parentId:'documents',description:'Save text without losing changes'},
  {id:'flow',kind:'function',name:'save',inputs:'text: string',outputs:'Saved document',rules:'Retain original until success',errors:'DiskFull',scenarios:['When interrupted\nThen retain original']},
  {id:'condition',kind:'step',name:'Check destination',parentId:'flow',stepType:'condition'},
  {id:'operation',kind:'step',name:'Write temporary file',parentId:'condition',stepType:'operation'},
  {id:'return',kind:'step',name:'Complete',parentId:'flow',stepType:'return'},
  {id:'loop',kind:'step',name:'Retry',parentId:'flow',stepType:'loop'},
  {id:'call',kind:'step',name:'Call save',parentId:'loop',stepType:'call'},
  {id:'try',kind:'step',name:'Try write',parentId:'flow',stepType:'try'},
  {id:'throw',kind:'step',name:'Disk full',parentId:'flow',stepType:'throw'},
  {id:'opaque',kind:'step',name:'Unsupported expression',parentId:'flow',stepType:'opaque',provenance:'extracted',
   source:{path:'src/save.ts',start:10,end:40,line:3,hash:'opaque-hash',revision:'captured-expression'}},
 ],edges:[
  {id:'ownership',source:'documents',target:'flow',kind:'contains'},
  {id:'valid',source:'condition',target:'operation',kind:'true',label:'Writable'},
  {id:'finish',source:'operation',target:'return',kind:'next',provenance:'ai'},
  {id:'invalid',source:'condition',target:'throw',kind:'false'},
  {id:'retry',source:'loop',target:'call',kind:'true'},
  {id:'repeat',source:'call',target:'loop',kind:'next'},
  {id:'invoke',source:'call',target:'describe',kind:'calls',uncertain:true},
  {id:'failure',source:'try',target:'throw',kind:'exception'},
 ]});
 const before=structuredClone(specification);
 const bundle=readHandoff(unzipSync(exportBundle({...emptyProject,specification},'Implement saving',['src/'])));
 expect(bundle.specification.graph).toEqual(before);
 const text=bundle.architecture;
 for(const line of ['Node ID: describe','Node ID: flow','Save text without losing changes','Parents: Editor [app]',
  'Parents: Documents [documents]','Parents: Check destination [condition]','Step type: condition','Step type: operation','Step type: return',
  'Workflow: unspecified','Workflow: see contained steps and relationships','Inputs: text: string','Outputs: Saved document',
  'Rules: Retain original until success','Errors: DiskFull','When interrupted\nThen retain original',
  'valid: Check destination [condition] true Write temporary file [operation] (Writable)',
  'finish: Write temporary file [operation] next Complete [return]; provenance: ai; uncertain: true',
  'invalid: Check destination [condition] false Disk full [throw]',
  'retry: Retry [loop] true Call save [call]','repeat: Call save [call] next Retry [loop]',
  'invoke: Call save [call] calls save [describe]; provenance: human; uncertain: true',
  'failure: Try write [try] exception Disk full [throw]',
  'Step type: loop','Step type: call','Step type: try','Step type: throw','Step type: opaque','Provenance: extracted',
  'src/save.ts; offsets [10, 40); line 3; hash opaque-hash; revision captured-expression'])expect(text).toContain(line);
 expect(specification).toEqual(before);
});

it.each(['Desktop','Other'])('renders %s target intent and full ER constraints alongside matching JSON',target=>{
 const specification=GraphSchema.parse({nodes:[
  {id:'document',kind:'entity',name:'Document',mappedName:'documents',fields:[
   {name:'id',type:'Int',key:'PK',defaultValue:'autoincrement()'},
   {name:'title',type:'String',optional:true,mappedName:'document_title',defaultValue:'"Untitled"'},
  ],compositeKeys:[{fields:['id','title'],type:'UNIQUE',name:'document_identity',mappedName:'document_identity_db'}],
   indexes:[{fields:['title'],type:'INDEX',name:'title_index',mappedName:'title_index_db'}]},
  {id:'owner',kind:'entity',name:'Owner'},
  {id:'format',kind:'enum',name:'Format',fields:[{name:'TEXT',type:'',mappedName:'plain_text'}]},
  {id:'api',kind:'interface',name:'DocumentAPI',contract:'load(): Document\n  save(text: string): void'},
 ],edges:[{id:'owned-by',source:'document',target:'owner',kind:'relates-to',label:'Many documents per owner'}],requirements:[
  {id:'offline',text:'Read and edit local documents',nodeIds:['document'],edgeIds:['owned-by'],constraints:['No network','Preserve Unicode ✓\r\n  Keep whitespace'],scenarios:['Given offline\nThen save successfully']},
 ]});
 const project={...emptyProject,target,description:'Local document tool; choose the implementation appropriate to the target',specification};
 const bundle=readHandoff(unzipSync(exportBundle(project,'Implement documents',['src/','schema.prisma'])));
 expect(bundle.specification.project).toMatchObject({target,description:project.description});
 expect(bundle.specification.graph).toEqual(specification);
 for(const value of ['Target: '+target,project.description,'Mapped name: documents','id: Int [PK]','Default: autoincrement()',
  'title: String (optional)','Mapped name: document_title','Default: "Untitled"','UNIQUE (id, title)',
  'Name: document_identity','Mapped name: document_identity_db','INDEX (title)','Name: title_index','Mapped name: title_index_db',
  'Mapped name: plain_text','load(): Document\n  save(text: string): void','owned-by: Document [document] relates-to Owner [owner] (Many documents per owner)',
  'offline','Read and edit local documents','No network','Preserve Unicode ✓\r\n  Keep whitespace','Given offline\nThen save successfully'])expect(bundle.architecture).toContain(value);
 expect(bundle.task).toContain('No generation template is implied by the target.');
 expect(bundle.task).toContain('Allowed changes: src/, schema.prisma');
});

it('renders protected evidence, required check commands and unavailable checks without erasing stale uncertainty',()=>{
 const source={path:'src/save.ts',symbol:'save',start:4,end:29,line:2,hash:'original-hash',revision:'original-source'};
 const baselineText='  save();\r\n```\nNever change this text\n';
 const specification=GraphSchema.parse({nodes:[
  {id:'frozen',kind:'function',name:'save',policy:'frozen-implementation',source,baseline:{text:baselineText,source},outputPath:'src/save.ts'},
  {id:'api',kind:'interface',name:'SaveAPI',policy:'frozen-contract',contract:'save(): void',baseline:{contract:'save(): void'}},
  {id:'sensitive',kind:'function',name:'reviewSave',policy:'sensitive',instructions:'Never overwrite a backup\nKeep Unicode ✓',requiredChecks:['unit','missing'],provenance:'ai'},
  {id:'document',kind:'entity',name:'Document',fields:[{name:'id',type:'Int',source:{...source,path:'schema.prisma',symbol:'Document.id'}}]},
 ],edges:[]});
 const analysis:NonNullable<Project['analysis']>={revision:'captured-source',sequence:1,analyzedAt:emptyProject.createdAt,status:'stale',graph:emptyGraph(),files:{},durationMs:0,
  staleEvidence:{scope:'paths',paths:['src/save.ts'],reason:'Saved source changed'},
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
 const project={...emptyProject,specRevision:7,specification,analysis,checks:{unit:{command:'npm',args:['test','--','name with spaces']}}};
 const before=structuredClone(project);
 const bundle=readHandoff(unzipSync(exportBundle(project,'Review saving',['src/save.ts'])));
 expect(bundle.specification).toMatchObject({revision:7,sourceRevision:'captured-source',analysisStatus:'stale',staleEvidence:analysis.staleEvidence,checks:project.checks});
 expect(bundle.specification.graph).toEqual(specification);
 for(const value of ['Specification revision: 7','Source revision: captured-source','Analysis status: stale','Stale evidence scope: paths',
  'Stale paths: src/save.ts','Saved source changed','Node ID: frozen','Policy: frozen-implementation','Output boundary: src/save.ts',
  'Source binding: src/save.ts :: save; offsets [4, 29); line 2; hash original-hash; revision original-source',
  'Baseline source: src/save.ts :: save; offsets [4, 29); line 2; hash original-hash; revision original-source',
  'Frozen implementation baseline:',baselineText,'````\n'+baselineText+'\n````','Frozen contract baseline:','save(): void',
  'Never overwrite a backup\nKeep Unicode ✓','Required checks: unit, missing','Unavailable required check: missing',
  'Provenance: ai (inferred; unverified)','schema.prisma :: Document.id; offsets [4, 29); line 2; hash original-hash; revision original-source'])expect(bundle.architecture).toContain(value);
 for(const text of [bundle.architecture,bundle.task]){
  expect(text).toContain('Allowed changes: src/save.ts');
  expect(text).toContain('unit: ["npm","test","--","name with spaces"]');
  expect(text).toContain('Required but unavailable evidence or checks block application.');
  expect(text).toContain('Runtime behavior and business intent remain uncertain; tests and human review complement structural analysis.');
  expect(text).toContain('Sensitive items require highlighted human review.');
 }
 expect(project).toEqual(before);
});

function readHandoff(files:Record<string,Uint8Array>):HandoffPackage {
 return HandoffPackageSchema.parse({
  manifest:JSON.parse(strFromU8(files['manifest.json'])),specification:JSON.parse(strFromU8(files['specification.json'])),
  architecture:strFromU8(files['ARCHITECTURE.md']),task:strFromU8(files['AGENT_TASK.md']),importReport:JSON.parse(strFromU8(files['IMPORT_REPORT.json'])),
 });
}

it.each([[],[''],[' '],['../outside'],['/outside'],['C:/outside'],['C:outside'],['src\\outside'],['src//'],['./src/'],['src/../'],['src/\0']].map(scope=>({scope})))('rejects ambiguous or unsafe handoff scope $scope',({scope})=>{
 expect(()=>exportBundle(emptyProject,'Implement',scope)).toThrow();
});

it('validates intended graph data before handing it to another agent',()=>{
 const specification={...emptyGraph(),requirements:[{id:'missing',text:'Keep the deleted function',nodeIds:['deleted'],edgeIds:[],constraints:[],scenarios:[]}]};
 expect(()=>exportBundle({...emptyProject,specification},'Implement',['.'])).toThrow();
});

it.each(['','   '])('rejects an unspecified task %j',(task)=>{
 expect(()=>exportBundle(emptyProject,task,['.'])).toThrow();
});

it.each(['schemaVersion','project','revision','graph','task','scope','checks','sourceRevision','analysisStatus'])('requires the machine-readable handoff field %s',(field)=>{
 const spec:Record<string,unknown>=JSON.parse(bundleFiles(emptyProject,'Implement',['.'])['specification.json']);
 delete spec[field];
 expect(HandoffSpecificationSchema.safeParse(spec).success).toBe(false);
});

it.each([
 {part:'manifest',field:'schemaVersion',value:2},
 {part:'specification',field:'schemaVersion',value:2},
 {part:'manifest',field:'projectId',value:'other'},
 {part:'manifest',field:'revision',value:1},
 {part:'manifest',field:'sourceRevision',value:'other-source'},
 {part:'specification',field:'revision',value:-1},
 {part:'specification',field:'revision',value:1.5},
 {part:'specification',field:'sourceRevision',value:'   '},
 {part:'specification',field:'analysisStatus',value:'current'},
 {part:'specification',field:'analysisStatus',value:'stale'},
 {part:'specification',field:'root',value:'local-root'},
] as const)('rejects unsupported or inconsistent $part.$field metadata',({part,field,value})=>{
 const bundle=readHandoff(unzipSync(exportBundle(emptyProject,'Implement',['.'])));
 Object.assign(bundle[part],{[field]:value});
 expect(HandoffPackageSchema.safeParse(bundle).success).toBe(false);
});

it('rejects unsupported graph versions and missing manifest inventory entries',()=>{
 const bundle=readHandoff(unzipSync(exportBundle(emptyProject,'Implement',['.'])));
 expect(HandoffPackageSchema.safeParse({...bundle,specification:{...bundle.specification,graph:{...bundle.specification.graph,schemaVersion:2}}}).success).toBe(false);
 const {schemaVersion,...unversioned}=bundle.specification.graph;
 expect(HandoffPackageSchema.safeParse({...bundle,specification:{...bundle.specification,graph:unversioned}}).success).toBe(false);
 const {task,...missingTask}=bundle.manifest.files;
 expect(HandoffPackageSchema.safeParse({...bundle,manifest:{...bundle.manifest,files:missingTask}}).success).toBe(false);
 expect(HandoffPackageSchema.safeParse({...bundle,manifest:{...bundle.manifest,files:{...bundle.manifest.files,task:'../task.md'}}}).success).toBe(false);
 expect(HandoffPackageSchema.safeParse({...bundle,importReport:{eligibleFiles:0}}).success).toBe(false);
});

it.each([
 {scope:['src/save.ts'],inside:'src/save.ts',outside:'src/save.ts/other.ts'},
 {scope:['src/'],inside:'src/save.ts',outside:'src-other/save.ts'},
 {scope:['.'],inside:'anywhere/save.ts'},
])('preserves scope semantics used by the existing change verifier: $scope',({scope,inside,outside})=>{
 const bundle=readHandoff(unzipSync(exportBundle(emptyProject,'Implement',scope)));
 expect(bundle.specification.scope).toEqual(scope);
 expect(inScope(inside,bundle.specification.scope)).toBe(true);
 if(outside)expect(inScope(outside,bundle.specification.scope)).toBe(false);
});

it('rejects nonportable source, baseline, field, and output paths instead of exporting them',()=>{
 const source={path:'main.ts',start:0,end:1,line:1,hash:'captured-hash',revision:'source-1'};
 for(const node of [
  {id:'n',kind:'function',name:'f',source:{...source,path:'/outside/main.ts'}},
  {id:'n',kind:'function',name:'f',source,policy:'frozen-implementation',baseline:{text:'x',source:{...source,path:'../main.ts'}}},
  {id:'n',kind:'entity',name:'E',fields:[{name:'id',type:'Int',source:{...source,path:'C:\\schema.prisma'}}]},
  {id:'n',kind:'function',name:'f',outputPath:'../outside/'},
 ]) {
  const specification=GraphSchema.parse({nodes:[node],edges:[]});
  expect(()=>exportBundle({...emptyProject,specification},'Implement',['.'])).toThrow();
 }
});

it('retains stale analysis metadata and initial failed-analysis state without claiming evidence is current',()=>{
 const analysis={revision:'older-source',sequence:1,analyzedAt:'2026-10-11T00:00:00Z',status:'stale' as const,graph:emptyGraph(),files:{},durationMs:0,
  staleEvidence:{scope:'paths' as const,paths:['main.ts'],reason:'Saved files changed'},
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable' as const,diagnostics:[]}};
 const bundle=readHandoff(unzipSync(exportBundle({...emptyProject,analysis},'Implement',['.'])));
 expect(bundle.specification).toMatchObject({sourceRevision:'older-source',analysisStatus:'stale',staleEvidence:analysis.staleEvidence});
 expect(bundle.manifest.sourceRevision).toBe('older-source');
 expect(bundle.importReport).toEqual(analysis.quality);
 expect(HandoffPackageSchema.safeParse({...bundle,importReport:{message:'No source has been analyzed.'}}).success).toBe(false);
 const failed=readHandoff(unzipSync(exportBundle({...emptyProject,analysis:{...analysis,revision:'',sequence:0}},'Implement',['.'])));
 expect(failed.specification.sourceRevision).toBeNull();
 expect(failed.specification.analysisStatus).toBe('stale');
 expect(failed.importReport).toEqual(analysis.quality);
});

it.each([false,true])('exports failed analysis without private paths, including retained evidence: %s',async(retainEvidence)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect private handoff '));
 const store=new ProjectStore(dir),p=await store.create({name:'Failed analysis'});
 const sync=new SyncService(store,{watch:false});
 try{
  if(retainEvidence){
   await writeFile(join(p.root,'main.ts'),'export function save() { return 1; }');
   await sync.start(p.id);
  }
  const before=await store.get(p.id);
  await rm(p.root,{recursive:true,force:true});
  if(retainEvidence)await sync.request(p.id);else await sync.start(p.id);
  const failed=await store.get(p.id),original=structuredClone(failed);
  expect(failed.analysis!.status).toBe('stale');
  expect(failed.analysis!.staleEvidence!.reason).toContain(p.root);
  expect(failed.analysis!.quality.diagnostics.find(d=>d.code==='analysis-failure')!.message).toContain(p.root);
  const files=unzipSync(exportBundle(failed,'Implement',['.'])),bundle=readHandoff(files);
  for(const bytes of Object.values(files))expect(strFromU8(bytes)).not.toContain(p.root);
  expect(bundle.specification).toMatchObject({revision:before.specRevision,sourceRevision:before.analysis?.revision??null,
   analysisStatus:'stale',staleEvidence:{scope:'all',paths:[]}});
  expect(bundle.manifest.sourceRevision).toBe(before.analysis?.revision??null);
  expect(bundle.specification.staleEvidence!.reason.trim()).not.toBe('');
  expect(bundle.importReport).toMatchObject({diagnostics:[expect.objectContaining({severity:'error',code:'analysis-failure'})]});
  expect(failed).toEqual(original);
  expect(await store.get(p.id)).toEqual(original);
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});

it('omits nonportable analyzer paths while retaining relative evidence, diagnostics and human text',()=>{
 const root=join(tmpdir(),'private-project'),privatePath=join(root,'main.ts');
 const description='User-authored reference: '+privatePath;
 const project:Project={...emptyProject,root,description,analysis:{revision:'source-1',sequence:1,analyzedAt:emptyProject.createdAt,status:'stale',graph:emptyGraph(),files:{},durationMs:0,
  staleEvidence:{scope:'paths',paths:['main.ts',privatePath],reason:'Unable to read "'+privatePath+'"'},
  quality:{eligibleFiles:1,analyzedFiles:0,unresolvedReferences:1,unsupportedConstructs:0,inferredItems:0,prismaValidation:'unavailable',diagnostics:[
   {severity:'error',code:'analysis-failure',message:'Unable to read "'+privatePath+'"',path:privatePath,line:1},
   {severity:'warning',code:'unresolved',message:'Unresolved import',path:'main.ts',line:2},
  ]}}};
 const bundle=readHandoff(unzipSync(exportBundle(project,'Implement',['.'])));
 expect(bundle.specification.project.description).toBe(description);
 expect(bundle.specification.staleEvidence).toMatchObject({scope:'all',paths:['main.ts']});
 expect(JSON.stringify(bundle.specification.staleEvidence)).not.toContain(root);
 expect(JSON.stringify(bundle.importReport)).not.toContain(root);
 expect(bundle.importReport).toMatchObject({eligibleFiles:1,analyzedFiles:0,unresolvedReferences:1,prismaValidation:'unavailable',diagnostics:[
  {severity:'error',code:'analysis-failure'},
  {severity:'warning',code:'unresolved',message:'Unresolved import',path:'main.ts',line:2},
 ]});
 if('diagnostics' in bundle.importReport){
  expect(bundle.importReport.diagnostics[0]).not.toHaveProperty('path');
  expect(bundle.importReport.diagnostics[0]).not.toHaveProperty('line');
 }
});

it.each(['posix','drive','unc'])('omits %s paths embedded in analyzer messages',(kind)=>{
 const path=join(tmpdir(),'private project','main.ts');
 const privatePath=kind==='posix'?path:(kind==='drive'?'C:':'\\\\host')+path.replaceAll('/','\\');
 const specification=JSON.parse(bundleFiles(emptyProject,'Implement',['.'])['specification.json']);
 const parsed=HandoffSpecificationSchema.parse({...specification,analysisStatus:'stale',
  staleEvidence:{scope:'all',paths:[],reason:'Unable to read "'+privatePath+'"'}});
 expect(parsed.staleEvidence!.reason).not.toContain(privatePath);
 expect(parsed.staleEvidence!.reason.trim()).not.toBe('');
 expect(parsed.analysisStatus).toBe('stale');
});

it('exports a versioned manifest and machine-readable task from a persisted mixed-detail project without execution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-handoff-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Documents',target:'Desktop',description:'Offline editor'});
  await store.updateSpec(p.id,0,{nodes:[
   {id:'save',kind:'function',name:'save',description:'Save text'},
   {id:'load',kind:'function',name:'load',inputs:'path: string',outputs:'Document',rules:'Keep Unicode ✓',errors:'NotFound',scenarios:['Given a saved document\nThen load its text']},
  ],edges:[],requirements:[{id:'offline',text:'Work offline\nKeep user data',constraints:['No network'],scenarios:['When offline\nThen save'],nodeIds:['save']}]});
  await store.updateChecks(p.id,{unit:{command:'npm',args:['test']}});
  await store.updateLayout(p.id,{save:{x:123,y:456}});
  const project=await new ProjectStore(dir).get(p.id),before=structuredClone(project);
  const task='Implement saving\nPreserve all user text',scope=['src/','package.json'];
  const files=unzipSync(exportBundle(project,task,scope));
  const validated=readHandoff(files);
  expect(files['manifest.json']).toBeDefined();
  const manifest=JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest).toMatchObject({schemaVersion:1,projectId:p.id,revision:1,sourceRevision:null,files:{
   specification:'specification.json',architecture:'ARCHITECTURE.md',task:'AGENT_TASK.md',importReport:'IMPORT_REPORT.json',
  }});
  const spec=JSON.parse(strFromU8(files['specification.json']));
  expect(spec).toMatchObject({schemaVersion:1,revision:1,sourceRevision:null,analysisStatus:null,task,scope,checks:{unit:{command:'npm',args:['test']}}});
  expect(spec.graph).toEqual(project.specification);
  expect(validated.specification.graph).toEqual(project.specification);
  expect(spec.graph.nodes[0]).not.toHaveProperty('inputs');
  expect(spec.graph.requirements[0]).toEqual({id:'offline',text:'Work offline\nKeep user data',constraints:['No network'],scenarios:['When offline\nThen save'],nodeIds:['save'],edgeIds:[]});
  expect(Object.keys(files).sort()).toEqual(['AGENT_TASK.md','ARCHITECTURE.md','IMPORT_REPORT.json','manifest.json','specification.json']);
  for(const name of Object.values(manifest.files) as string[])expect(files[name]).toBeDefined();
  for(const bytes of Object.values(files)){
   const text=strFromU8(bytes);
   expect(text).not.toContain(dir);
   expect(text).not.toContain('codex');
   expect(text).not.toContain('bubblewrap');
  }
  expect(spec).not.toHaveProperty('root');
  expect(spec).not.toHaveProperty('layout');
  expect(JSON.parse(strFromU8(files['IMPORT_REPORT.json']))).toEqual({message:'No source has been analyzed.'});
  expect(project).toEqual(before);
  expect(await store.get(p.id)).toEqual(before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('exports bound frozen and sensitive items while retaining historical baselines and current source revision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-protected-handoff-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Protected'});
  const original='export function save(): number { return 1; }\n';
  await writeFile(join(p.root,'main.ts'),original);
  const analyzer=new Analyzer(),analysis=await analyzer.analyze(p.root);
  await store.updateAnalysis(p.id,analysis);
  const bound=NodeSchema.parse({...analysis.graph.nodes.find(n=>n.name==='save'&&n.kind==='function')!,parentId:undefined});
  const frozen=freezeNode(bound,'frozen-implementation',analysis);
  const contract=NodeSchema.parse({id:'api',kind:'interface',name:'DocumentAPI',policy:'frozen-contract',contract:'save(): number',baseline:{contract:'save(): number'}});
  const sensitive=NodeSchema.parse({...bound,id:'sensitive',name:'Careful save',policy:'sensitive',instructions:'Never overwrite a backup\nKeep Unicode ✓',requiredChecks:['unit']});
  await store.updateSpec(p.id,0,{nodes:[frozen,contract,sensitive],edges:[]});
  await store.updateChecks(p.id,{unit:{command:'npm',args:['test']}});
  await writeFile(join(p.root,'main.ts'),original.replace('return 1','return 2'));
  const current=await analyzer.analyze(p.root);
  const project=await store.updateAnalysis(p.id,current);
  const files=unzipSync(exportBundle(project,'Review saving',['main.ts']));
  const validated=readHandoff(files);
  expect(files['manifest.json']).toBeDefined();
  const spec=JSON.parse(strFromU8(files['specification.json']));
  expect(spec.sourceRevision).toBe(current.revision);
  expect(spec.analysisStatus).toBe(current.status);
  expect(spec.graph.nodes).toEqual([frozen,contract,sensitive]);
  expect(validated.specification.graph.nodes).toEqual([frozen,contract,sensitive]);
  expect(spec.graph.nodes[0].baseline).toEqual({text:original.trimEnd(),source:bound.source});
  expect(spec.graph.nodes[0].baseline.source.revision).toBe(analysis.revision);
  expect(spec.graph.nodes[0].baseline.source.revision).not.toBe(spec.sourceRevision);
  expect(spec.graph.nodes[2].source).toEqual(bound.source);
  const architecture=strFromU8(files['ARCHITECTURE.md']),instructions=strFromU8(files['AGENT_TASK.md']);
  expect(architecture).toContain('Policy: frozen-implementation');
  expect(architecture).toContain('Policy: frozen-contract');
  expect(architecture).toContain('Source binding: main.ts');
  expect(architecture).toContain(sensitive.instructions);
  expect(architecture).toContain('Required checks: unit');
  expect(instructions).toContain('Preserve frozen implementations exactly and frozen interfaces structurally');
  expect(JSON.parse(strFromU8(files['IMPORT_REPORT.json']))).toEqual(current.quality);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('exports sensitive instructions and named required checks without losing their specification',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sensitive-export-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Sensitive'});
  const project=await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Save',policy:'sensitive',
   instructions:'  Preserve Unicode ✓\r\nNever overwrite a backup\n',requiredChecks:['unit','typecheck']}],edges:[]});
  const files=unzipSync(exportBundle(project,'Implement saving',['src/']));
  expect(JSON.parse(strFromU8(files['specification.json'])).graph.nodes[0]).toMatchObject({policy:'sensitive',
   instructions:'  Preserve Unicode ✓\r\nNever overwrite a backup\n',requiredChecks:['unit','typecheck']});
  const architecture=strFromU8(files['ARCHITECTURE.md']);
  expect(architecture).toContain('Policy: sensitive');
  expect(architecture).toContain('  Preserve Unicode ✓\r\nNever overwrite a backup\n');
  expect(architecture).toContain('Required checks: unit, typecheck');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('exports mixed-detail functions without replacing unknown details or claiming implementation completeness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-function-export-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Documents'});
  const detailed={id:'load',kind:'function' as const,name:'load',description:'  Load text\r\n',inputs:'path: string\n',outputs:'Document ✓\n',
   rules:'Preserve whitespace\n',errors:'NotFound\r\n',scenarios:['Given saved text\nThen read the same text\n']};
  const project=await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'save',description:'Save text'},detailed],edges:[]});
  const files=unzipSync(exportBundle(project,'Implement documents',['src/']));
  const json=strFromU8(files['specification.json']),blueprint=JSON.parse(json),graph=GraphSchema.parse(blueprint.graph);
  expect(graph.nodes[0]).toMatchObject({id:'save',description:'Save text',provenance:'human'});
  for(const field of ['inputs','outputs','rules','errors','scenarios'] as const)expect(blueprint.graph.nodes[0]).not.toHaveProperty(field);
  expect(graph.nodes[1]).toMatchObject(detailed);
  expect(graph.edges).toEqual([]);
  expect(blueprint.sourceRevision).toBeNull();
  const architecture=strFromU8(files['ARCHITECTURE.md']);
  for(const text of [detailed.description,detailed.inputs,detailed.outputs,detailed.rules,detailed.errors,...detailed.scenarios])expect(architecture).toContain(text);
  expect(strFromU8(files['AGENT_TASK.md'])).toContain('Missing function details and workflows are unspecified; supplied details and scenarios do not prove implementation completeness.');
  expect(json).not.toContain(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('exports a portable specification with optional function details and approved scope',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-export-'));
 try{
  const store=new ProjectStore(dir);const p=await store.create({name:'Desktop',target:'Electron'});
  const f=NodeSchema.parse({id:'save',kind:'function',name:'saveDocument',description:'Save without losing user changes',scenarios:['Existing file is backed up'],outputPath:'src/'});
  const project=await store.updateSpec(p.id,0,{nodes:[f],edges:[]});
  const files=unzipSync(exportBundle(project,'Implement saving',['src/']));
  const spec=JSON.parse(strFromU8(files['specification.json']));
  expect(spec.graph.nodes[0].description).toContain('without losing');
  expect(strFromU8(files['AGENT_TASK.md'])).toContain('src/');
  expect(strFromU8(files['ARCHITECTURE.md'])).toContain('Electron');
  expect(strFromU8(files['specification.json'])).not.toContain(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('hands off lossless project and function requirements, constraints and scenarios in JSON and readable instructions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-requirements-export-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Documents'});
  const requirements=[
   {id:'project',text:'  Offline documents\r\nKeep Unicode ✓\n',nodeIds:[],edgeIds:[],constraints:['No network\nEven during save'],scenarios:['Given offline\nThen open documents\n']},
   {id:'save-rule',text:'Save without loss\n',nodeIds:['save','document'],edgeIds:['write'],constraints:['Keep original until success'],scenarios:['When interrupted\nThen retain original','When complete\nThen read new text']},
  ];
  const project=await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'saveDocument',scenarios:['Node scenario\n  Retain text']},{id:'document',kind:'entity',name:'Document'}],
   edges:[{id:'write',source:'save',target:'document',kind:'writes'}],requirements});
  const files=unzipSync(exportBundle(project,'Implement saving',['src/']));
  const json=strFromU8(files['specification.json']),architecture=strFromU8(files['ARCHITECTURE.md']);
  expect(GraphSchema.parse(JSON.parse(json).graph).requirements).toEqual(requirements);
  for(const r of requirements){
   expect(architecture).toContain(r.id);
   expect(architecture).toContain(r.text);
   for(const text of [...r.constraints,...r.scenarios])expect(architecture).toContain(text);
  }
  expect(architecture.indexOf('Offline documents')).toBeLessThan(architecture.indexOf('Save without loss'));
  expect(architecture).toContain('save, document');
  expect(architecture).toContain('write');
  expect(architecture).toContain('Node scenario\n  Retain text');
  expect(strFromU8(files['AGENT_TASK.md'])).toContain('Do not claim that tests prove every prose requirement.');
  expect(json).not.toContain(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
