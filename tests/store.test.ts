import {it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer} from '../server/analyzer';
import {GraphSchema,NodeSchema,type Analysis} from '../shared/model';
const analysisMetadata:Omit<Analysis,'graph'>={revision:'source-1',sequence:1,analyzedAt:'2026-10-08T00:00:00Z',status:'current',files:{},durationMs:0,
 quality:{eligibleFiles:0,analyzedFiles:0,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
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
