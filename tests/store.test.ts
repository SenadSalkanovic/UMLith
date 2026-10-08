import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectStore} from '../server/store';
import {AppError} from '../server/files';
import {Analyzer} from '../server/analyzer';
import {freezeNode} from '../server/review';
import {GraphSchema,NodeSchema,type Analysis} from '../shared/model';
const analysisMetadata:Omit<Analysis,'graph'>={revision:'source-1',sequence:1,analyzedAt:'2026-10-08T00:00:00Z',status:'current',files:{},durationMs:0,
 quality:{eligibleFiles:0,analyzedFiles:0,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};

vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,rename:vi.fn(actual.rename),writeFile:vi.fn(actual.writeFile)};
});

it('accepts only one racing specification edit and provides conflict details for reload and retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-spec-race-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Concurrent edits'});
  const initial=await readFile(join(store.projectDir(p.id),'revisions','0.json'),'utf8');
  const edits=['First intent','Second intent'].map(name=>({nodes:[{id:'save',kind:'function' as const,name}],edges:[]}));
  const results=await Promise.allSettled(edits.map(graph=>store.updateSpec(p.id,0,graph)));
  expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
  const conflict=(results[1] as PromiseRejectedResult).reason;
  expect(conflict).toBeInstanceOf(AppError);
  expect(conflict).toMatchObject({statusCode:409,projectId:p.id,expectedRevision:0,currentRevision:1});
  expect(conflict.message).toMatch(/reload/i);
  const reloaded=await new ProjectStore(dir).get(conflict.projectId);
  expect(reloaded.specRevision).toBe(conflict.currentRevision);
  expect(reloaded.specification.nodes[0].name).toBe('First intent');
  expect((await store.history(p.id)).map(r=>({revision:r.revision,names:r.graph.nodes.map(n=>n.name)}))).toEqual([
   {revision:0,names:[]},{revision:1,names:['First intent']},
  ]);
  expect(await readFile(join(store.projectDir(p.id),'revisions','0.json'),'utf8')).toBe(initial);
  expect((await readdir(join(store.projectDir(p.id),'revisions'))).sort()).toEqual(['0.json','1.json']);
  const retried=await store.updateSpec(conflict.projectId,reloaded.specRevision,edits[1]);
  expect(retried.specRevision).toBe(2);
  expect(retried.specification.nodes[0].name).toBe('Second intent');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([undefined,null,'0',false,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('rejects invalid expected revision %s without writing',async(expected)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-expected-revision-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Revision validation'});
  const base=store.projectDir(p.id),before=await readFile(join(base,'project.json'),'utf8');
  const initial=await readFile(join(base,'revisions','0.json'),'utf8');
  await expect(store.updateSpec(p.id,expected as number,{nodes:[],edges:[]})).rejects.toMatchObject({statusCode:400});
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(before);
  expect(await readFile(join(base,'revisions','0.json'),'utf8')).toBe(initial);
  expect(await readdir(join(base,'revisions'))).toEqual(['0.json']);
  expect((await store.updateSpec(p.id,0,{nodes:[],edges:[]})).specRevision).toBe(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([
 ['specification','layout','analysis'],['specification','analysis','layout'],
 ['layout','specification','analysis'],['layout','analysis','specification'],
 ['analysis','specification','layout'],['analysis','layout','specification'],
] as const)('preserves concurrent mutations queued as %s, %s, %s',async(...order)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-mixed-race-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Independent state'});
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Old intent'}],edges:[]});
  await store.updateAnalysis(p.id,{...analysisMetadata,graph:GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'Old implementation'}],edges:[]})});
  const base=store.projectDir(p.id),committed=await Promise.all([0,1].map(r=>readFile(join(base,'revisions',r+'.json'),'utf8')));
  const layout={save:{x:23,y:47}};
  const analysis={...analysisMetadata,sequence:2,revision:'source-2',graph:GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'New implementation'}],edges:[]})};
  const mutations={
   specification:()=>store.updateSpec(p.id,1,{nodes:[{id:'save',kind:'function',name:'New human intent'}],edges:[]}),
   layout:()=>store.updateLayout(p.id,layout),
   analysis:()=>store.updateAnalysis(p.id,analysis),
  };
  await Promise.all(order.map(key=>mutations[key]()));
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specRevision).toBe(2);
  expect(reopened.specification.nodes[0].name).toBe('New human intent');
  expect(reopened.layout).toEqual(layout);
  expect(reopened.analysis).toEqual(analysis);
  expect(JSON.parse(await readFile(join(base,'project.json'),'utf8'))).toMatchObject({specRevision:2,specification:{nodes:[{name:'New human intent'}]},layout});
  expect((await store.history(p.id)).map(r=>({revision:r.revision,names:r.graph.nodes.map(n=>n.name)}))).toEqual([
   {revision:0,names:[]},{revision:1,names:['Old intent']},{revision:2,names:['New human intent']},
  ]);
  expect(await Promise.all([0,1].map(r=>readFile(join(base,'revisions',r+'.json'),'utf8')))).toEqual(committed);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['history write','history rename','project rename'] as const)('recovers committed intent and immutable history after a failed %s',async(stage)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-failed-spec-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Recoverable'});
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'save',description:'Keep text ✓\r\n'}],edges:[]});
  const base=store.projectDir(p.id),before=await readFile(join(base,'project.json'),'utf8');
  const committed=await Promise.all([0,1].map(r=>readFile(join(base,'revisions',r+'.json'),'utf8')));
  const failure=Object.assign(new Error('Injected disk failure'),{code:'ENOSPC'});
  if(stage==='history write'){
   const actual=vi.mocked(writeFile).getMockImplementation()!;
   vi.mocked(writeFile).mockImplementationOnce(async(path)=>{await actual(path,'{partial');throw failure;});
  }
  else{
   const actual=vi.mocked(rename).getMockImplementation()!;
   vi.mocked(rename).mockImplementation(async(from,to)=>{
    if(String(to)===(stage==='history rename'?join(base,'revisions','2.json'):join(base,'project.json')))throw failure;
    return actual(from,to);
   });
  }
  await expect(store.updateSpec(p.id,1,{nodes:[{id:'failed',kind:'function',name:'Uncommitted'}],edges:[]})).rejects.toThrow('Injected disk failure');
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(before);
  const restarted=new ProjectStore(dir);
  expect((await restarted.get(p.id)).specification.nodes[0]).toMatchObject({id:'save',description:'Keep text ✓\r\n'});
  expect((await restarted.history(p.id)).map(r=>r.revision)).toEqual([0,1]);
  for(const subdir of [base,join(base,'revisions')])expect((await readdir(subdir)).filter(f=>f.endsWith('.tmp'))).toEqual([]);
  await restarted.updateSpec(p.id,1,{nodes:[{id:'retry',kind:'function',name:'Accepted retry'}],edges:[]});
  expect((await restarted.history(p.id)).map(r=>r.revision)).toEqual([0,1,2]);
  expect((await restarted.history(p.id))[2].graph.nodes[0].id).toBe('retry');
  for(const [i,text] of committed.entries())expect(await readFile(join(base,'revisions',i+'.json'),'utf8')).toBe(text);
 }finally{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);vi.mocked(writeFile).mockImplementation(actual.writeFile);
  await rm(dir,{recursive:true,force:true});
 }
});

it('ignores interrupted uncommitted records and temporary files on restart and safely retries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-interrupted-spec-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Interrupted'}),base=store.projectDir(p.id);
  await writeFile(join(base,'revisions','1.json'),'{uncommitted');
  await writeFile(join(base,'project.json.interrupted.tmp'),'{partial');
  const restarted=new ProjectStore(dir);
  expect((await restarted.get(p.id)).specRevision).toBe(0);
  expect((await restarted.history(p.id)).map(r=>r.revision)).toEqual([0]);
  await restarted.updateSpec(p.id,0,{nodes:[],edges:[]});
  expect((await restarted.history(p.id)).map(r=>r.revision)).toEqual([0,1]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['project','history'] as const)('reports the corrupt %s JSON record explicitly',async(record)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-corrupt-spec-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Corrupt'}),base=store.projectDir(p.id);
  await writeFile(join(base,record==='project'?'project.json':'revisions/0.json'),'{broken');
  await expect(record==='project'?store.get(p.id):store.history(p.id)).rejects.toThrow(record==='project'?/invalid JSON.*project.json/i:/invalid JSON.*0.json/i);
  if(record==='project')await expect(store.list()).rejects.toThrow(/invalid JSON.*project.json/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('does not publish a new project if its initial history cannot be saved',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-failed-create-'));
 try{
  const store=new ProjectStore(dir),actual=vi.mocked(rename).getMockImplementation()!;
  vi.mocked(rename).mockImplementation(async(from,to)=>{
   if(String(to).endsWith('/revisions/0.json'))throw new Error('Injected initial history failure');
   return actual(from,to);
  });
  await expect(store.create({name:'Uncommitted project'})).rejects.toThrow('Injected initial history failure');
  expect(await new ProjectStore(dir).list()).toEqual([]);
 }finally{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);
  await rm(dir,{recursive:true,force:true});
 }
});

it.each(['missing revision','wrong filename','duplicate revision filename'] as const)('reports %s rather than returning incomplete or ambiguous history',async(problem)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-incomplete-history-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'History validation'}),base=join(store.projectDir(p.id),'revisions');
  await store.updateSpec(p.id,0,{nodes:[],edges:[]});
  if(problem==='missing revision')await rm(join(base,'0.json'));
  else await writeFile(join(base,problem==='wrong filename'?'bad.json':'00.json'),await readFile(join(base,'0.json')));
  await expect(new ProjectStore(dir).history(p.id)).rejects.toThrow(/specification history/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([
 ['unsupported record version',{schemaVersion:2}],
 ['negative revision',{revision:-1}],
 ['wrong revision',{revision:7}],
 ['invalid timestamp',{createdAt:'yesterday'}],
 ['missing graph',{graph:null}],
])('rejects history with %s',async(_label,change)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-history-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Invalid history'}),file=join(store.projectDir(p.id),'revisions','0.json');
  const record=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...record,...change}));
  await expect(store.history(p.id)).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1])('rejects a corrupt current specification revision %s before it can overwrite history',async(specRevision)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-revision-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Invalid revision'}),file=join(store.projectDir(p.id),'project.json');
  await writeFile(file,JSON.stringify({...p,specRevision}));
  const before=await readFile(join(store.projectDir(p.id),'revisions','0.json'),'utf8');
  await expect(store.get(p.id)).rejects.toThrow();
  await expect(store.updateSpec(p.id,specRevision as number,{nodes:[],edges:[]})).rejects.toThrow();
  expect(await readFile(join(store.projectDir(p.id),'revisions','0.json'),'utf8')).toBe(before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('retains sensitive specification and both frozen baselines until an explicit specification edit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-policy-baselines-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Policies'});
  const source={path:'run.ts',symbol:'run',start:0,end:3,line:1,hash:'old-hash',revision:'source-1'};
  const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',source,contract:'run(): number'});
  const old:Analysis={...analysisMetadata,graph:GraphSchema.parse({nodes:[node],edges:[]}),files:{'run.ts':{hash:'old-hash',text:'old'}}};
  const implementation=freezeNode(node,'frozen-implementation',old);
  const contract={...freezeNode(node,'frozen-contract'),id:'interface'};
  const sensitive=NodeSchema.parse({id:'care',kind:'function',name:'Care',policy:'sensitive',
   instructions:'  Preserve text ✓\r\n',requiredChecks:['unit','typecheck']});
  await store.updateSpec(p.id,0,{nodes:[implementation,contract,sensitive],edges:[]});
  const updatedSource={...source,hash:'new-hash',revision:'source-2'};
  const actual={...node,source:updatedSource,contract:'run(): string'};
  await store.updateAnalysis(p.id,{...old,revision:'source-2',sequence:2,
   graph:GraphSchema.parse({nodes:[actual],edges:[]}),files:{'run.ts':{hash:'new-hash',text:'new'}}});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specRevision).toBe(1);
  expect(reopened.specification.nodes[0].baseline).toEqual({source,text:'old'});
  expect(reopened.specification.nodes[1].baseline).toEqual({source,contract:'run(): number'});
  expect(reopened.specification.nodes[2]).toMatchObject({policy:'sensitive',instructions:'  Preserve text ✓\r\n',requiredChecks:['unit','typecheck']});
  expect(reopened.analysis?.graph.nodes[0]).toMatchObject({contract:'run(): string',source:updatedSource});
  const refrozen=freezeNode(actual,'frozen-implementation',reopened.analysis);
  const accepted=await store.updateSpec(p.id,1,{...reopened.specification,nodes:[refrozen,contract,sensitive]});
  expect(accepted.specRevision).toBe(2);
  expect(accepted.specification.nodes[0].baseline).toEqual({source:updatedSource,text:'new'});
  const history=await store.history(p.id);
  expect(history[1].graph.nodes[0].baseline).toEqual({source,text:'old'});
  expect(history[2].graph.nodes[0].baseline).toEqual({source:updatedSource,text:'new'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('creates new and imported projects in the Node/tsx runtime and releases the import worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-runtime-import-'));
 try{
  const root=join(dir,'existing');await mkdir(root);
  await writeFile(join(root,'main.ts'),'export function imported() { return 1; }');
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`
   import assert from 'node:assert/strict';
   const {ProjectStore}=await import('./server/store.ts');
   const store=new ProjectStore(process.argv[1]);
   const created=await store.create({name:'New'});
   assert.equal(created.specRevision,0);
   assert.equal(created.analysis,undefined);
   const imported=await store.create({name:'Imported',root:process.argv[2]});
   assert.equal(imported.specRevision,0);
   assert.deepEqual(imported.specification,{schemaVersion:1,nodes:[],edges:[],requirements:[]});
   assert.ok(imported.analysis.graph.nodes.some(n=>n.kind==='function'&&n.name==='imported'));
   assert.equal(JSON.stringify((await store.get(imported.id)).analysis),JSON.stringify(imported.analysis));
  `,dir,root],{timeout:10000});
  const projects=await new ProjectStore(dir).list();
  expect(projects).toHaveLength(2);
  const imported=projects.find(p=>p.name==='Imported')!,created=projects.find(p=>p.name==='New')!;
  for(const p of projects){
   expect(p.specRevision).toBe(0);
   expect(p.specification).toEqual({schemaVersion:1,nodes:[],edges:[],requirements:[]});
  }
  expect(created.analysis).toBeUndefined();
  expect(imported.analysis?.graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({kind:'function',name:'imported'})]));
  expect(imported.analysis?.files['main.ts'].text).toBe('export function imported() { return 1; }');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('creates new projects with empty intent and imports code only into an unadopted implemented snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-import-'));
 try{
  const store=new ProjectStore(dir),created=await store.create({name:'New tool',target:'Desktop'});
  expect(created.managed).toBe(true);
  expect(created.target).toBe('Desktop');
  expect(created.specRevision).toBe(0);
  expect(created.specification).toEqual({schemaVersion:1,nodes:[],edges:[],requirements:[]});
  expect(created.analysis).toBeUndefined();
  const root=join(dir,'existing');await mkdir(root);
  await writeFile(join(root,'main.ts'),'export function imported() { return 1; }');
  const imported=await store.create({name:'Imported tool',target:'Other target',root});
  expect(imported.managed).toBe(false);
  expect(imported.target).toBe('Other target');
  expect(imported.specRevision).toBe(0);
  expect(imported.specification).toEqual({schemaVersion:1,nodes:[],edges:[],requirements:[]});
  expect(imported.analysis?.graph.nodes).toEqual(expect.arrayContaining([
   expect.objectContaining({kind:'function',name:'imported',provenance:'extracted'}),
  ]));
  expect(imported.analysis?.files['main.ts'].text).toBe('export function imported() { return 1; }');
  expect(await readFile(join(root,'main.ts'),'utf8')).toBe('export function imported() { return 1; }');
  expect(await new ProjectStore(dir).get(imported.id)).toEqual(imported);
  expect((await store.history(imported.id)).map(r=>({revision:r.revision,graph:r.graph}))).toEqual([
   {revision:0,graph:{schemaVersion:1,nodes:[],edges:[],requirements:[]}},
  ]);
  const adopted=await store.updateSpec(imported.id,0,imported.analysis!.graph);
  expect(adopted.specRevision).toBe(1);
  expect(adopted.specification).toEqual(imported.analysis!.graph);
  expect(adopted.analysis).toEqual(imported.analysis);
  expect((await store.history(imported.id)).map(r=>r.revision)).toEqual([0,1]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([
 ['invalid syntax','export function broken( {',/invalid TypeScript syntax/i],
 ['invalid extracted graph',"function getKey(): 'a' { return 'a'; } export interface Foo { [getKey()]: string; }",/invalid calls relationship/i],
])('surfaces %s during import without publishing an unreadable project or changing source',async(_label,text,error)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-import-'));
 try{
  const root=join(dir,'existing');await mkdir(root);
  const source=join(root,'main.ts');await writeFile(source,text);
  const store=new ProjectStore(dir);
  await expect(store.create({name:'Invalid import',root})).rejects.toThrow(error);
  expect(await store.list()).toEqual([]);
  expect(await readFile(source,'utf8')).toBe(text);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('repeated analysis updates leave intended JSON, revision history and protected baselines untouched',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-independent-analysis-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Human intent'});
  const source={path:'main.ts',symbol:'save',start:0,end:10,line:1,hash:'protected-hash',revision:'protected-source'};
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'save',description:'  Human rule\r\n',
   policy:'frozen-implementation',source,baseline:{text:'exact text\r\n',source}}],edges:[],
   requirements:[{id:'save-rule',text:'Keep documents',nodeIds:['save'],scenarios:['Reopen saved text']}]});
  await store.updateLayout(p.id,{save:{x:23,y:47}});
  await store.updateChecks(p.id,{verify:{command:'node',args:['--version']}});
  const file=join(store.projectDir(p.id),'project.json'),before=await readFile(file,'utf8');
  const intended=(await store.get(p.id)).specification;
  const history=await store.history(p.id);
  const revisionFiles=await Promise.all([0,1].map(r=>readFile(join(store.projectDir(p.id),'revisions',r+'.json'),'utf8')));
  for(const [i,status] of (['current','partial','stale'] as const).entries()){
   const graph=GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'changed'+i,provenance:'extracted'}],edges:[]});
   const analysis={...analysisMetadata,revision:'source-'+(i+1),sequence:i+1,status,graph};
   const updated=await store.updateAnalysis(p.id,analysis);
   expect(updated.analysis).toEqual(analysis);
   expect(await readFile(file,'utf8')).toBe(before);
   expect(updated.specRevision).toBe(1);
   expect(updated.specification).toEqual(intended);
   expect(await store.history(p.id)).toEqual(history);
   expect(await Promise.all([0,1].map(r=>readFile(join(store.projectDir(p.id),'revisions',r+'.json'),'utf8')))).toEqual(revisionFiles);
   expect((await new ProjectStore(dir).get(p.id)).analysis).toEqual(analysis);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('analysis updates preserve legacy intended JSON verbatim and supersede inline analysis without rewriting it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-legacy-intent-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Legacy'});
  const legacyGraph={nodes:[{id:'original',kind:'function',name:'Original intent'}],edges:[]};
  const oldAnalysis={...analysisMetadata,graph:GraphSchema.parse({nodes:[],edges:[]})};
  const file=join(store.projectDir(p.id),'project.json');
  const text=JSON.stringify({...p,specification:legacyGraph,analysis:oldAnalysis});
  await writeFile(file,text);
  expect((await store.get(p.id)).analysis).toEqual(oldAnalysis);
  for(const sequence of [2,3]){
   const analysis={...oldAnalysis,revision:'source-'+sequence,sequence};
   await store.updateAnalysis(p.id,analysis);
   expect(await readFile(file,'utf8')).toBe(text);
   const reopened=await new ProjectStore(dir).get(p.id);
   expect(reopened.specRevision).toBe(0);
   expect(reopened.specification.nodes[0].name).toBe('Original intent');
   expect(reopened.analysis).toEqual(analysis);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['specification','layout','checks'] as const)('preserves legacy inline analysis when saving %s to separate storage',async(change)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-legacy-analysis-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Legacy'});
  const analysis={...analysisMetadata,graph:GraphSchema.parse({nodes:[{id:'old',kind:'function',name:'Analyzed'}],edges:[]})};
  const file=join(store.projectDir(p.id),'project.json');
  await writeFile(file,JSON.stringify({...p,analysis}));
  if(change==='specification')await store.updateSpec(p.id,0,{nodes:[],edges:[]});
  else if(change==='layout')await store.updateLayout(p.id,{old:{x:1,y:2}});
  else await store.updateChecks(p.id,{verify:{command:'node',args:[]}});
  expect(JSON.parse(await readFile(file,'utf8')).analysis).toBeUndefined();
  expect(JSON.parse(await readFile(join(store.projectDir(p.id),'analysis.json'),'utf8'))).toEqual(analysis);
  expect((await new ProjectStore(dir).get(p.id)).analysis).toEqual(analysis);
  expect((await store.get(p.id)).specRevision).toBe(change==='specification'?1:0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['unsupported graph','malformed JSON','null snapshot'] as const)('rejects %s in separate analysis storage rather than falling back to obsolete inline evidence',async(invalid)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-snapshot-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Invalid snapshot'});
  const analysis={...analysisMetadata,graph:GraphSchema.parse({nodes:[],edges:[]})};
  await writeFile(join(store.projectDir(p.id),'project.json'),JSON.stringify({...p,analysis}));
  await writeFile(join(store.projectDir(p.id),'analysis.json'),invalid==='null snapshot'?'null':invalid==='malformed JSON'?'{':
   JSON.stringify({...analysis,graph:{schemaVersion:2,nodes:[],edges:[]}}));
  if(invalid==='malformed JSON')await expect(store.get(p.id)).rejects.toBeInstanceOf(SyntaxError);
  else if(invalid==='null snapshot')await expect(store.get(p.id)).rejects.toThrow();
  else await expect(store.get(p.id)).rejects.toMatchObject({issues:expect.arrayContaining([expect.objectContaining({path:['schemaVersion']})])});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('saves mixed-detail functions and enriches the same ID while preserving earlier revisions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-function-details-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Documents'});
  const detailed={id:'load',kind:'function' as const,name:'load',description:'  Load text\r\n',inputs:'path: string\n',outputs:'Document ✓\n',
   rules:'Preserve whitespace\n',errors:'NotFound\r\n',scenarios:['Given saved text\nThen read the same text\n']};
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'save',description:'Save text'},detailed],edges:[]});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specification.nodes[0]).toMatchObject({id:'save',description:'Save text',provenance:'human'});
  for(const field of ['inputs','outputs','rules','errors','scenarios'] as const)expect(reopened.specification.nodes[0][field]).toBeUndefined();
  expect(reopened.specification.nodes[1]).toMatchObject(detailed);
  expect(reopened.specification.edges).toEqual([]);
  expect(reopened.analysis).toBeUndefined();
  const enrichment={inputs:'Document',outputs:'void',rules:'Atomic write',errors:'DiskFull',scenarios:['Reopen saved text']};
  await store.updateSpec(p.id,1,{...reopened.specification,nodes:[{...reopened.specification.nodes[0],...enrichment},reopened.specification.nodes[1]]});
  const updated=await new ProjectStore(dir).get(p.id),history=await store.history(p.id);
  expect(history.map(r=>({schemaVersion:r.schemaVersion,revision:r.revision}))).toEqual([
   {schemaVersion:1,revision:0},{schemaVersion:1,revision:1},{schemaVersion:1,revision:2},
  ]);
  for(const revision of [0,1,2])expect(JSON.parse(await readFile(join(store.projectDir(p.id),'revisions',revision+'.json'),'utf8'))).toMatchObject({schemaVersion:1,revision});
  expect(updated.specification.nodes[0]).toMatchObject({id:'save',description:'Save text',...enrichment});
  expect(updated.specification.nodes[1]).toMatchObject(detailed);
  expect(updated.analysis).toBeUndefined();
  expect(history[1].graph.nodes[0].inputs).toBeUndefined();
  expect(history[1].graph.nodes[1]).toMatchObject(detailed);
  expect(history[2].graph.nodes[0]).toMatchObject({id:'save',...enrichment});
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('preserves requirements through edits and history and rejects deleted-function references before writing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-requirements-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Requirements'});
  const requirements=[
   {id:'project',text:'  Keep all documents\r\nOffline ✓\n',nodeIds:[],edgeIds:[],constraints:['No data loss\nEven on failure'],scenarios:['Given a document\nThen retain it\n']},
   {id:'save-rule',text:'Save atomically\n',nodeIds:['save'],edgeIds:[],constraints:[],scenarios:['When saving\nThen return success']},
  ];
  const graph=GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'save',scenarios:['Function scenario\n  Preserve spaces']}],edges:[],requirements});
  const first=await store.updateSpec(p.id,0,graph);
  expect(first.specification.requirements).toEqual(requirements);
  const edited=await store.updateSpec(p.id,1,{...first.specification,nodes:[{...first.specification.nodes[0],name:'saveDocument'}],
   requirements:first.specification.requirements.map(r=>r.id==='save-rule'?{...r,text:'Save edited text\n'}:r)});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specification.requirements).toEqual([requirements[0],{...requirements[1],text:'Save edited text\n'}]);
  expect(reopened.specification.nodes[0].scenarios).toEqual(['Function scenario\n  Preserve spaces']);
  const history=await store.history(p.id);
  expect(history[1].graph.requirements).toEqual(requirements);
  expect(history[2].graph.requirements).toEqual([requirements[0],{...requirements[1],text:'Save edited text\n'}]);
  const file=join(store.projectDir(p.id),'project.json'),before=await readFile(file,'utf8');
  await expect(store.updateSpec(p.id,2,{...edited.specification,nodes:[]})).rejects.toMatchObject({issues:expect.arrayContaining([
   expect.objectContaining({path:['requirements',1,'nodeIds',0],message:expect.stringMatching(/missing requirement node.*save/i)}),
  ])});
  expect(await readFile(file,'utf8')).toBe(before);
  expect((await store.history(p.id)).length).toBe(3);
  expect((await store.get(p.id)).specRevision).toBe(2);
  const removed=await store.updateSpec(p.id,2,{...edited.specification,nodes:[],requirements:[requirements[0]]});
  expect(removed.specification.requirements).toEqual([requirements[0]]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('persists graph revisions, keeps layout separate and rejects stale edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-store-'));
 try {
  const store=new ProjectStore(dir);const p=await store.create({name:'Desktop tool',target:'Electron'});
  await store.updateSpec(p.id,0,{nodes:[NodeSchema.parse({id:'root',kind:'system',name:'Tool'})],edges:[]});
  await store.updateLayout(p.id,{root:{x:23,y:47}});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specification.schemaVersion).toBe(1);
  expect(reopened.specRevision).toBe(1);expect(reopened.layout.root.x).toBe(23);
  expect(reopened.specification.nodes[0].name).toBe('Tool');
  await expect(store.updateSpec(p.id,0,{nodes:[],edges:[]})).rejects.toThrow('Specification changed');
  expect((await store.history(p.id)).length).toBe(2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['specification','analysis'] as const)('normalizes a persisted legacy %s graph without rewriting the file',async(location)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-legacy-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Existing'});
  const graph={nodes:[{id:'legacy',kind:'module',name:'Existing module'}],edges:[]};
  const persisted=location==='specification'?{...p,specification:graph}:{...p,analysis:{...analysisMetadata,graph}};
  const file=join(store.projectDir(p.id),'project.json'),text=JSON.stringify(persisted);
  await writeFile(file,text);
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(location==='specification'?reopened.specification:reopened.analysis?.graph).toMatchObject({schemaVersion:1,nodes:[{id:'legacy',name:'Existing module'}]});
  expect(await readFile(file,'utf8')).toBe(text);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['specification','analysis'] as const)('rejects an unsupported persisted %s graph version',async(location)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-unsupported-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Future'});
  const graph={schemaVersion:2,nodes:[],edges:[]};
  const persisted=location==='specification'?{...p,specification:graph}:{...p,analysis:{...analysisMetadata,graph}};
  await writeFile(join(store.projectDir(p.id),'project.json'),JSON.stringify(persisted));
  await expect(new ProjectStore(dir).get(p.id)).rejects.toMatchObject({issues:expect.arrayContaining([expect.objectContaining({path:['schemaVersion']})])});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('normalizes legacy revision graphs and rejects unsupported history versions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-history-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'History'});
  const file=join(store.projectDir(p.id),'revisions','0.json');
  const legacy={revision:0,createdAt:p.createdAt,graph:{nodes:[{id:'root',kind:'system',name:'Existing'}],edges:[]}};
  await writeFile(file,JSON.stringify(legacy));
  expect(await store.history(p.id)).toMatchObject([{revision:0,graph:{schemaVersion:1,nodes:[{id:'root',name:'Existing'}]}}]);
  await writeFile(file,JSON.stringify({...legacy,graph:{...legacy.graph,schemaVersion:2}}));
  await expect(store.history(p.id)).rejects.toMatchObject({issues:expect.arrayContaining([expect.objectContaining({path:['schemaVersion']})])});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('rejects an invalid analysis graph before saving and keeps the project readable for recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-analysis-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Recoverable'});
  const source=join(p.root,'model.ts');
  await writeFile(source,'export function getKey(): number { return 1; }');
  const analyzer=new Analyzer(),valid=await analyzer.analyze(p.root);
  await store.updateAnalysis(p.id,valid);
  const file=join(store.projectDir(p.id),'project.json'),before=await readFile(file,'utf8');
  await writeFile(source,"function getKey(): 'a' { return 'a'; } export interface Foo { [getKey()]: string; }");
  const invalid=await analyzer.analyze(p.root);
  expect(invalid.status).toBe('partial');
  await expect(store.updateAnalysis(p.id,invalid)).rejects.toThrow(/invalid calls relationship/i);
  expect(await readFile(file,'utf8')).toBe(before);
  expect((await store.get(p.id)).analysis).toEqual(valid);
  await writeFile(source,'export function getKey(): number { return 2; }');
  const recovered=await analyzer.analyze(p.root);
  await store.updateAnalysis(p.id,recovered);
  expect((await store.get(p.id)).analysis).toEqual(recovered);
 }finally{await rm(dir,{recursive:true,force:true});}
});
