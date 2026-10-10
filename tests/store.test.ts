import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,rename,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectStore} from '../server/store';
import {AppError,captureFiles,hashes,hash} from '../server/files';
import {Analyzer} from '../server/analyzer';
import {freezeNode,validateCandidate,applyReviewed} from '../server/review';
import {bundleFiles,exportBundle} from '../server/export';
import {unzipSync,strFromU8} from 'fflate';
import {GraphSchema,NodeSchema,type Analysis,type AgentJob,type Layout} from '../shared/model';
const analysisMetadata:Omit<Analysis,'graph'>={revision:'source-1',sequence:1,analyzedAt:'2026-10-08T00:00:00Z',status:'current',files:{},durationMs:0,
 quality:{eligibleFiles:0,analyzedFiles:0,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};

it('persists node movement separately while a pending implementation remains valid and applicable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-independent-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Pending implementation'});
  await writeFile(join(p.root,'main.ts'),'export function save(): number { return 1; }');
  const analysis=await new Analyzer().analyze(p.root);
  await store.updateAnalysis(p.id,analysis);
  const intended=await store.updateSpec(p.id,0,analysis.graph),node=analysis.graph.nodes.find(n=>n.name==='save')!;
  const workspace=join(dir,'candidate');await cp(p.root,workspace,{recursive:true});
  await writeFile(join(workspace,'main.ts'),'export function save(): number { return 2; }');
  const job:AgentJob={id:'pending',projectId:p.id,kind:'implementation',status:'review',createdAt:p.createdAt,
   specRevision:1,sourceHashes:hashes(await captureFiles(p.root)),task:'Update saving',scope:['main.ts'],workspace,events:[]};
  job.report=await validateCandidate(intended,job);expect(job.report.passed).toBe(true);
  await store.saveJob(job);
  const base=store.projectDir(p.id),file=join(base,'project.json'),before=await readFile(file,'utf8');
  const history=await store.history(p.id),historyBytes=await Promise.all([0,1].map(i=>readFile(join(base,'revisions',i+'.json'),'utf8')));
  const exported=bundleFiles(intended,job.task,job.scope);
  await store.updateLayout(p.id,{[node.id]:{x:123,y:-47}});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.layout[node.id]).toEqual({x:123,y:-47});
  expect(reopened.layoutRevision).toBe(1);expect(reopened.specRevision).toBe(1);
  expect(await readFile(file,'utf8')).toBe(before);expect(hash(await readFile(file))).toBe(hash(before));
  for(const key of ['layout','scopedLayouts','layoutRevision'])expect(JSON.parse(before)).not.toHaveProperty(key);
  expect(JSON.parse(await readFile(join(base,'layout.json'),'utf8'))).toMatchObject({schemaVersion:1,revision:1,layout:{[node.id]:{x:123,y:-47}}});
  expect(await store.history(p.id)).toEqual(history);
  expect(await Promise.all([0,1].map(i=>readFile(join(base,'revisions',i+'.json'),'utf8')))).toEqual(historyBytes);
  expect(bundleFiles(reopened,job.task,job.scope)).toEqual(exported);
  expect((await store.jobs(p.id))[0]).toEqual(job);
  expect((await validateCandidate(reopened,job)).passed).toBe(true);
  await applyReviewed(store,job);
  expect(await readFile(join(p.root,'main.ts'),'utf8')).toContain('return 2');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('persists independent positions for the same stable ID in default and scoped views',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-scoped-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Scoped layout'});
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Save'}],edges:[]});
  await Promise.all([
   store.updateLayout(p.id,{save:{x:1,y:2}}),
   store.updateLayout(p.id,{save:{x:30,y:40}},'architecture:root'),
   store.updateLayout(p.id,{save:{x:-5,y:6}},'function:save'),
  ]);
  const restarted=new ProjectStore(dir),reopened=await restarted.get(p.id);
  expect(reopened.layout).toEqual({save:{x:1,y:2}});
  expect(reopened.scopedLayouts).toEqual({'architecture:root':{save:{x:30,y:40}},'function:save':{save:{x:-5,y:6}}});
  expect(reopened.layoutRevision).toBe(3);expect(reopened.specRevision).toBe(1);
  await restarted.updateLayout(p.id,{},'function:save');
  await restarted.updateChecks(p.id,{verify:{command:'node',args:[]}});
  const updated=await restarted.get(p.id);
  expect(updated.layout).toEqual(reopened.layout);
  expect(updated.scopedLayouts).toEqual({'architecture:root':{save:{x:30,y:40}},'function:save':{}});
  expect(updated.layoutRevision).toBe(4);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['specification','analysis'] as const)('retains surviving IDs across %s replacement and cleans deleted IDs from every view',async(first)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-layout-replacement-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Replacement'});
  const graph=(ids:string[],name='Old')=>GraphSchema.parse({nodes:ids.map(id=>({id,kind:'function',name:name+id})),edges:[]});
  await store.updateSpec(p.id,0,graph(['keep','drop','intent-only']));
  await store.updateAnalysis(p.id,{...analysisMetadata,graph:graph(['keep','drop','source-only'])});
  const positions={keep:{x:11,y:22},drop:{x:33,y:44},'intent-only':{x:55,y:66},'source-only':{x:77,y:88}};
  await store.updateLayout(p.id,positions);
  await store.updateLayout(p.id,positions,'function:keep');
  const replace={
   specification:()=>store.updateSpec(p.id,1,graph(['keep','intent-only'],'Renamed')),
   analysis:()=>store.updateAnalysis(p.id,{...analysisMetadata,sequence:2,revision:'source-2',graph:graph(['keep','source-only'],'Renamed')}),
  };
  // An ID still present in the other graph retains its position.
  expect((await replace[first]()).layout).toEqual(positions);
  const replaced=await replace[first==='specification'?'analysis':'specification']();
  const surviving={keep:{x:11,y:22},'intent-only':{x:55,y:66},'source-only':{x:77,y:88}};
  expect(replaced.layout).toEqual(surviving);
  expect(replaced.scopedLayouts).toEqual({'function:keep':surviving});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.layout).toEqual(surviving);expect(reopened.scopedLayouts).toEqual({'function:keep':surviving});
  expect(reopened.layoutRevision).toBe(2);expect(reopened.specRevision).toBe(2);
  // The next layout commit compacts deleted IDs in every stored view.
  await store.updateLayout(p.id,{...surviving,missing:{x:9,y:9}});
  const record=JSON.parse(await readFile(join(store.projectDir(p.id),'layout.json'),'utf8'));
  expect(record.layout).toEqual(surviving);expect(record.scopedLayouts).toEqual({'function:keep':surviving});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('retains imported positions through a Prisma parse failure, unrelated movement, restart and recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-layout-analysis-recovery-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Analysis recovery'}),analyzer=new Analyzer();
  const schema=join(p.root,'schema.prisma'),valid='model User {\n  id Int @id\n}\n';
  await writeFile(schema,valid);
  await writeFile(join(p.root,'main.ts'),'export function save() { return 1; }');
  const initial=await analyzer.analyze(p.root);
  expect(initial.status).toBe('current');
  await store.updateAnalysis(p.id,initial);
  const entity=initial.graph.nodes.find(n=>n.kind==='entity'&&n.name==='User')!;
  const neighbor=initial.graph.nodes.find(n=>n.kind==='function'&&n.name==='save')!;
  const positions={[entity.id]:{x:11,y:22},[neighbor.id]:{x:33,y:44}};
  const scoped={[entity.id]:{x:-55,y:66},[neighbor.id]:{x:77,y:88}};
  await store.updateLayout(p.id,positions);
  await store.updateLayout(p.id,scoped,'er:root');
  const file=join(store.projectDir(p.id),'project.json'),intended=await readFile(file,'utf8');
  await writeFile(schema,'model User {\n  id\n');
  const partial=await analyzer.analyze(p.root);
  expect(partial.status).toBe('partial');
  expect(partial.quality.diagnostics).toContainEqual(expect.objectContaining({path:'schema.prisma',severity:'error'}));
  expect(partial.graph.nodes.some(n=>n.id===entity.id)).toBe(false);
  const interrupted=await store.updateAnalysis(p.id,partial);
  expect(interrupted.layout).toEqual(positions);
  expect(interrupted.scopedLayouts).toEqual({'er:root':scoped});
  const restarted=new ProjectStore(dir),during=await restarted.get(p.id);
  await restarted.updateLayout(p.id,{...during.layout,[neighbor.id]:{x:99,y:100}});
  await restarted.updateLayout(p.id,{...during.scopedLayouts!['er:root'],[neighbor.id]:{x:101,y:102}},'er:root');
  await writeFile(schema,valid);
  const repaired=await analyzer.analyze(p.root);
  expect(repaired.status).toBe('current');
  expect(repaired.graph.nodes.find(n=>n.kind==='entity'&&n.name==='User')?.id).toBe(entity.id);
  await restarted.updateAnalysis(p.id,repaired);
  const recovered=await new ProjectStore(dir).get(p.id);
  expect(recovered.layout).toEqual({[entity.id]:{x:11,y:22},[neighbor.id]:{x:99,y:100}});
  expect(recovered.scopedLayouts).toEqual({'er:root':{[entity.id]:{x:-55,y:66},[neighbor.id]:{x:101,y:102}}});
  expect(recovered.layoutRevision).toBe(4);expect(recovered.specRevision).toBe(0);
  expect(await readFile(file,'utf8')).toBe(intended);
  // Complete analysis confirms deletion; the neighboring positions still survive.
  await writeFile(schema,'');
  const deleted=await analyzer.analyze(p.root);
  expect(deleted.status).toBe('current');
  await restarted.updateAnalysis(p.id,deleted);
  const cleaned=await restarted.get(p.id);
  expect(cleaned.layout).toEqual({[neighbor.id]:{x:99,y:100}});
  expect(cleaned.scopedLayouts).toEqual({'er:root':{[neighbor.id]:{x:101,y:102}}});
  await restarted.updateLayout(p.id,cleaned.layout);
  const record=JSON.parse(await readFile(join(store.projectDir(p.id),'layout.json'),'utf8'));
  expect(record.layout).toEqual(cleaned.layout);expect(record.scopedLayouts).toEqual(cleaned.scopedLayouts);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['layout','specification','checks'] as const)('preserves legacy inline positions when first saving %s',async(change)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-legacy-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Legacy layout'}),base=store.projectDir(p.id);
  const legacy={...p,specification:GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'Save'}],edges:[]}),
   layout:{save:{x:23,y:47}},layoutRevision:undefined,scopedLayouts:undefined};
  await rm(join(base,'layout.json'),{force:true});
  const before=JSON.stringify(legacy);await writeFile(join(base,'project.json'),before);
  expect((await store.get(p.id)).layout).toEqual({save:{x:23,y:47}});
  expect((await store.get(p.id)).layoutRevision).toBe(0);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(before);
  if(change==='layout')await store.updateLayout(p.id,{save:{x:30,y:40}},'function:save');
  else if(change==='specification')await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Renamed'}],edges:[]});
  else await store.updateChecks(p.id,{verify:{command:'node',args:[]}});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.layout).toEqual({save:{x:23,y:47}});
  const record=JSON.parse(await readFile(join(base,'layout.json'),'utf8'));
  expect(record.layout).toEqual({save:{x:23,y:47}});
  if(change==='layout'){
   expect(await readFile(join(base,'project.json'),'utf8')).toBe(before);
   expect(reopened.scopedLayouts).toEqual({'function:save':{save:{x:30,y:40}}});
   expect(record.revision).toBe(1);
  }else{
   expect(JSON.parse(await readFile(join(base,'project.json'),'utf8'))).not.toHaveProperty('layout');
   expect(record.revision).toBe(0);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([false,true])('normalizes legacy coordinate metadata with an existing layout sidecar: %s',async(sidecar)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-legacy-coordinate-metadata-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Legacy coordinates'}),base=store.projectDir(p.id);
  const project=await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Save'}],edges:[]});
  if(sidecar)await store.updateLayout(p.id,{save:{x:30,y:40}});
  else await rm(join(base,'layout.json'));
  const before=JSON.stringify({...project,layout:{save:{x:1,y:2,width:20}}});
  await writeFile(join(base,'project.json'),before);
  const reopened=await new ProjectStore(dir).get(p.id);
  const expected=sidecar?{save:{x:30,y:40}}:{save:{x:1,y:2}};
  expect(reopened.layout).toEqual(expected);
  expect(reopened.layoutRevision).toBe(sidecar?1:0);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(before);
  await store.updateChecks(p.id,{});
  expect((await new ProjectStore(dir).get(p.id)).layout).toEqual(expected);
  expect(JSON.parse(await readFile(join(base,'layout.json'),'utf8')).layout).toEqual(expected);
  expect(JSON.parse(await readFile(join(base,'project.json'),'utf8'))).not.toHaveProperty('layout');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([{x:NaN,y:0},{x:Infinity,y:0},{x:'1',y:0},{x:1},{x:1,y:2,z:3},{x:1,y:2,width:20}])('rejects invalid positions %j without changing committed layout',async(position)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Invalid layout'});
  const base=store.projectDir(p.id),before=await readFile(join(base,'layout.json'),'utf8');
  const intended=await readFile(join(base,'project.json'),'utf8');
  await expect(store.updateLayout(p.id,{save:position} as Layout)).rejects.toThrow();
  expect(await readFile(join(base,'layout.json'),'utf8')).toBe(before);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(intended);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each(['','   '])('rejects a blank scoped view key %j before writing',async(view)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-invalid-layout-view-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Invalid scope'});
  const file=join(store.projectDir(p.id),'layout.json'),before=await readFile(file,'utf8');
  await expect(store.updateLayout(p.id,{},view)).rejects.toThrow();
  expect(await readFile(file,'utf8')).toBe(before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('retains committed geometry and intent after a failed atomic layout rename and permits retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-failed-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Failed movement'});
  await store.updateSpec(p.id,0,{nodes:[{id:'save',kind:'function',name:'Save'}],edges:[]});
  await store.updateLayout(p.id,{save:{x:1,y:2}});
  const base=store.projectDir(p.id),before=await readFile(join(base,'layout.json'),'utf8');
  const intended=await readFile(join(base,'project.json'),'utf8'),actual=vi.mocked(rename).getMockImplementation()!;
  vi.mocked(rename).mockImplementation(async(from,to)=>{
   if(String(to)===join(base,'layout.json'))throw new Error('Injected layout failure');
   return actual(from,to);
  });
  await expect(store.updateLayout(p.id,{save:{x:3,y:4}})).rejects.toThrow('Injected layout failure');
  expect(await readFile(join(base,'layout.json'),'utf8')).toBe(before);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(intended);
  expect((await new ProjectStore(dir).get(p.id)).layout).toEqual({save:{x:1,y:2}});
  expect((await readdir(base)).filter(n=>n.endsWith('.tmp'))).toEqual([]);
  vi.mocked(rename).mockImplementation(actual);
  expect((await store.updateLayout(p.id,{save:{x:3,y:4}})).layoutRevision).toBe(2);
 }finally{
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);await rm(dir,{recursive:true,force:true});
 }
});

it.each(['JSON','version','revision','positions','scoped positions'] as const)('reports corrupt layout %s instead of falling back to obsolete inline positions',async(problem)=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-corrupt-layout-'));
 try{
  const store=new ProjectStore(dir),p=await store.create({name:'Corrupt layout'}),base=store.projectDir(p.id);
  await writeFile(join(base,'project.json'),JSON.stringify({...p,layout:{save:{x:1,y:2}}}));
  const invalid={schemaVersion:problem==='version'?2:1,revision:problem==='revision'?-1:0,
   layout:problem==='positions'?{save:{x:null,y:0}}:{},scopedLayouts:problem==='scoped positions'?{view:{save:{x:1}}}:{}};
  await writeFile(join(base,'layout.json'),problem==='JSON'?'{broken':JSON.stringify(invalid));
  await expect(new ProjectStore(dir).get(p.id)).rejects.toThrow(problem==='JSON'?/invalid JSON.*layout.json/i:undefined);
  await expect(store.updateLayout(p.id,{})).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});

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
  const record=JSON.parse(await readFile(join(base,'project.json'),'utf8'));
  expect(record).toMatchObject({specRevision:2,specification:{nodes:[{name:'New human intent'}]}});
  expect(record).not.toHaveProperty('layout');
  expect(JSON.parse(await readFile(join(base,'layout.json'),'utf8')).layout).toEqual(layout);
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
  await store.updateLayout(p.id,{save:{x:-11,y:12}},'function:save');
  await store.updateChecks(p.id,{verify:{command:'node',args:['--version']}});
  const file=join(store.projectDir(p.id),'project.json'),before=await readFile(file,'utf8');
  const layoutFile=join(store.projectDir(p.id),'layout.json'),layoutBefore=await readFile(layoutFile,'utf8');
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
   expect(updated.layout).toEqual({save:{x:23,y:47}});
   expect(updated.scopedLayouts).toEqual({'function:save':{save:{x:-11,y:12}}});
   expect(updated.layoutRevision).toBe(2);
   expect(await readFile(layoutFile,'utf8')).toBe(layoutBefore);
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
  const before=JSON.stringify({...p,analysis});await writeFile(file,before);
  if(change==='specification')await store.updateSpec(p.id,0,{nodes:[],edges:[]});
  else if(change==='layout')await store.updateLayout(p.id,{old:{x:1,y:2}});
  else await store.updateChecks(p.id,{verify:{command:'node',args:[]}});
  if(change==='layout'){
   expect(await readFile(file,'utf8')).toBe(before);
   await expect(readFile(join(store.projectDir(p.id),'analysis.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  }else{
   expect(JSON.parse(await readFile(file,'utf8')).analysis).toBeUndefined();
   expect(JSON.parse(await readFile(join(store.projectDir(p.id),'analysis.json'),'utf8'))).toEqual(analysis);
  }
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

it('T030: builds a project with simple and workflow functions, verifies separate layout, and reloads across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-t030-store-'));
 try{
  const store=new ProjectStore(dir);
  const p=await store.create({name:'OrderPlatform',target:'Desktop application'});

  const simpleFn=NodeSchema.parse({
   id:'fn-ping',kind:'function',name:'ping',description:'Simple ping endpoint that returns uptime',
   policy:'editable',contract:'export function ping(): boolean',requiredChecks:[],instructions:'',outputPath:'src/ping.ts',fields:[],
  });

  const detailedFn=NodeSchema.parse({
   id:'fn-order',kind:'function',name:'processOrder',description:'Processes a customer order',
   policy:'sensitive',contract:'export function processOrder(orderId: string, amount: number): Promise<boolean>',
   inputs:'orderId: string\namount: number',outputs:'Promise<boolean>',
   rules:'Amount must be greater than zero\nMust record audit trail',
   errors:'InvalidAmountError: amount <= 0\nPaymentDeclinedError: payment declined',
   scenarios:['Given a valid order, when processed, returns true and confirms order','When payment declines, raises PaymentDeclinedError without committing order'],
   requiredChecks:['npm test'],instructions:'Keep monetary arithmetic exact. Audit all transactions.',outputPath:'src/order.ts',fields:[],
  });

  const stepValidate=NodeSchema.parse({
   id:'step-validate',kind:'step',stepType:'condition',parentId:'fn-order',name:'validateAmount',
   description:'Check amount > 0',policy:'editable',contract:'',requiredChecks:[],instructions:'',outputPath:'',fields:[],
  });

  const stepCharge=NodeSchema.parse({
   id:'step-charge',kind:'step',stepType:'call',parentId:'fn-order',name:'chargeGateway',
   description:'Call payment gateway',policy:'editable',contract:'',requiredChecks:[],instructions:'',outputPath:'',fields:[],
  });

  const stepReturn=NodeSchema.parse({
   id:'step-return',kind:'step',stepType:'return',parentId:'fn-order',name:'returnSuccess',
   description:'Return transaction confirmation',policy:'editable',contract:'',requiredChecks:[],instructions:'',outputPath:'',fields:[],
  });

  const workflowEdges=[
   {id:'e-step-1',source:'step-validate',target:'step-charge',kind:'true' as const,label:'valid'},
   {id:'e-step-2',source:'step-charge',target:'step-return',kind:'next' as const,label:'approved'},
  ];

  const containmentEdges=[
   {id:'c-1',source:'fn-order',target:'step-validate',kind:'contains' as const},
   {id:'c-2',source:'fn-order',target:'step-charge',kind:'contains' as const},
   {id:'c-3',source:'fn-order',target:'step-return',kind:'contains' as const},
  ];

  const requirements=[
   {id:'req-order',text:'Atomic order processing with audit trail',nodeIds:['fn-order'],edgeIds:[],constraints:['Must not drop audit events'],scenarios:['Given order, process atomically']},
  ];

  const graph=GraphSchema.parse({
   nodes:[simpleFn,detailedFn,stepValidate,stepCharge,stepReturn],
   edges:[...containmentEdges,...workflowEdges],
   requirements,
  });

  // Save specification
  const saved=await store.updateSpec(p.id,0,graph);
  expect(saved.specRevision).toBe(1);

  // Save layout: root layout + scoped layout for function workflow
  const rootLayout={'fn-ping':{x:50,y:100},'fn-order':{x:300,y:100}};
  const stepLayout={'step-validate':{x:20,y:20},'step-charge':{x:20,y:120},'step-return':{x:20,y:220}};
  await store.updateLayout(p.id,rootLayout);
  await store.updateLayout(p.id,stepLayout,'function:fn-order');

  // Verify on-disk file separation before restart
  const base=store.projectDir(p.id);
  const projectJsonRaw=await readFile(join(base,'project.json'),'utf8');
  const layoutJsonRaw=await readFile(join(base,'layout.json'),'utf8');
  const projectJson=JSON.parse(projectJsonRaw);
  const layoutJson=JSON.parse(layoutJsonRaw);

  expect(projectJson).not.toHaveProperty('layout');
  expect(projectJson).not.toHaveProperty('scopedLayouts');
  expect(projectJson).not.toHaveProperty('layoutRevision');
  expect(projectJson.specRevision).toBe(1);
  expect(projectJson.name).toBe('OrderPlatform');
  expect(projectJson.target).toBe('Desktop application');
  expect(projectJson.specification.nodes).toHaveLength(5);

  const persistedSimple=projectJson.specification.nodes.find((n:any)=>n.id==='fn-ping');
  expect(persistedSimple.description).toBe('Simple ping endpoint that returns uptime');
  for(const field of ['inputs','outputs','rules','errors','scenarios'])expect(persistedSimple).not.toHaveProperty(field);

  const persistedDetailed=projectJson.specification.nodes.find((n:any)=>n.id==='fn-order');
  expect(persistedDetailed.inputs).toContain('orderId: string');
  expect(persistedDetailed.outputs).toBe('Promise<boolean>');
  expect(persistedDetailed.rules).toContain('Amount must be greater than zero');
  expect(persistedDetailed.errors).toContain('PaymentDeclinedError');
  expect(persistedDetailed.scenarios).toHaveLength(2);
  expect(persistedDetailed.policy).toBe('sensitive');
  expect(persistedDetailed.instructions).toContain('Keep monetary arithmetic exact');

  expect(layoutJson.schemaVersion).toBe(1);
  expect(layoutJson.revision).toBe(2);
  expect(layoutJson.layout['fn-ping']).toEqual({x:50,y:100});
  expect(layoutJson.scopedLayouts['function:fn-order']).toEqual(stepLayout);

  // RESTART: instantiate fresh store instance on same directory
  const restartedStore=new ProjectStore(dir);
  const reloaded=await restartedStore.get(p.id);

  expect(reloaded.id).toBe(p.id);
  expect(reloaded.specRevision).toBe(1);
  expect(reloaded.layoutRevision).toBe(2);
  expect(reloaded.specification.nodes).toHaveLength(5);
  expect(reloaded.specification.edges).toHaveLength(5);
  expect(reloaded.specification.requirements).toHaveLength(1);

  // Both functions survive restart intact
  const reloadedSimple=reloaded.specification.nodes.find(n=>n.id==='fn-ping')!;
  expect(reloadedSimple.name).toBe('ping');
  expect(reloadedSimple.description).toBe('Simple ping endpoint that returns uptime');
  for(const field of ['inputs','outputs','rules','errors','scenarios'] as const)expect(reloadedSimple[field]).toBeUndefined();

  const reloadedDetailed=reloaded.specification.nodes.find(n=>n.id==='fn-order')!;
  expect(reloadedDetailed.name).toBe('processOrder');
  expect(reloadedDetailed.inputs).toBe(detailedFn.inputs);
  expect(reloadedDetailed.outputs).toBe(detailedFn.outputs);
  expect(reloadedDetailed.rules).toBe(detailedFn.rules);
  expect(reloadedDetailed.errors).toBe(detailedFn.errors);
  expect(reloadedDetailed.scenarios).toEqual(detailedFn.scenarios);
  expect(reloadedDetailed.policy).toBe('sensitive');
  expect(reloadedDetailed.instructions).toBe(detailedFn.instructions);

  const reloadedSteps=reloaded.specification.nodes.filter(n=>n.parentId==='fn-order');
  expect(reloadedSteps).toHaveLength(3);

  expect(reloaded.layout['fn-ping']).toEqual({x:50,y:100});
  expect(reloaded.layout['fn-order']).toEqual({x:300,y:100});
  expect(reloaded.scopedLayouts!['function:fn-order']).toEqual(stepLayout);

  // Moving a node increments layoutRevision without incrementing specRevision or modifying project.json
  await restartedStore.updateLayout(p.id,{'fn-ping':{x:75,y:150}});
  const afterMove=await restartedStore.get(p.id);
  expect(afterMove.layoutRevision).toBe(3);
  expect(afterMove.specRevision).toBe(1);
  expect(await readFile(join(base,'project.json'),'utf8')).toBe(projectJsonRaw);

  // Portable export of the reloaded mixed-detail model
  const files=unzipSync(exportBundle(afterMove,'Export mixed project',['src/']));
  const exportJson=JSON.parse(strFromU8(files['specification.json']));
  expect(exportJson.graph.nodes).toHaveLength(5);
  expect(exportJson.graph.nodes.find((n:any)=>n.id==='fn-ping')).not.toHaveProperty('inputs');
  expect(exportJson.graph.nodes.find((n:any)=>n.id==='fn-order')).toHaveProperty('inputs');
  expect(strFromU8(files['specification.json'])).not.toContain(dir);
  expect(strFromU8(files['ARCHITECTURE.md'])).toContain('processOrder');
  expect(strFromU8(files['ARCHITECTURE.md'])).toContain('ping');
  expect(strFromU8(files['AGENT_TASK.md'])).toContain('Missing function details and workflows are unspecified');
 }finally{await rm(dir,{recursive:true,force:true});}
});
