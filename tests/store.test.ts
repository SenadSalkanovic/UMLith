import {it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer} from '../server/analyzer';
import {NodeSchema,type Analysis} from '../shared/model';
const analysisMetadata:Omit<Analysis,'graph'>={revision:'source-1',sequence:1,analyzedAt:'2026-10-08T00:00:00Z',status:'current',files:{},durationMs:0,
 quality:{eligibleFiles:0,analyzedFiles:0,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
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
