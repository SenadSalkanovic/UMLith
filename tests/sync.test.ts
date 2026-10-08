import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {SyncService} from '../server/sync';
import {AnalysisSchema,GraphUpdateSchema,applyGraphUpdate} from '../shared/model';
it('updates the implemented graph while preserving human intent and retains a stale model on invalid saves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sync-'));
 const store=new ProjectStore(dir);const p=await store.create({name:'Live'});
 const sync=new SyncService(store,{watch:false});
 const updates:unknown[]=[];
 sync.on('notification',(_id,event)=>{if(event.type==='analysis')updates.push(event);});
 try{
  await writeFile(join(p.root,'main.ts'),'export function original() { return 1; }');
  await sync.start(p.id);
  const before=await store.get(p.id);
  expect(before.analysis?.graph.nodes.some(n=>n.name==='original')).toBe(true);
  expect(AnalysisSchema.safeParse(before.analysis).success).toBe(true);
  const initial=GraphUpdateSchema.parse(updates[0]);
  expect(initial).toMatchObject({baseRevision:null,baseSequence:0,sequence:1,revision:before.analysis!.revision});
  expect(applyGraphUpdate(undefined,initial)).toEqual(before.analysis!.graph);
  await store.updateSpec(p.id,0,{nodes:[{...before.analysis!.graph.nodes.find(n=>n.name==='original')!,parentId:undefined,description:'Human-owned rule'}],edges:[]});
  await writeFile(join(p.root,'main.ts'),'export function changed() { return 2; }');
  await sync.request(p.id);
  const changed=await store.get(p.id);
  expect(changed.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(changed.specification.nodes[0].description).toBe('Human-owned rule');
  const update=GraphUpdateSchema.parse(updates[1]);
  expect(update).toMatchObject({baseRevision:before.analysis!.revision,baseSequence:1,sequence:2,revision:changed.analysis!.revision});
  expect(applyGraphUpdate(before.analysis,update)).toEqual(changed.analysis!.graph);
  expect(()=>applyGraphUpdate(changed.analysis,update)).toThrow(/revision|sequence/i);
  await writeFile(join(p.root,'main.ts'),'export function changed( {');
  await sync.request(p.id);
  const invalid=await store.get(p.id);
  expect(invalid.analysis?.status).toBe('stale');
  expect(invalid.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(invalid.analysis?.files['main.ts'].text).toContain('return 2');
  expect(AnalysisSchema.safeParse(invalid.analysis).success).toBe(true);
  expect(invalid.analysis?.staleEvidence).toMatchObject({scope:'all',reason:expect.stringMatching(/invalid TypeScript syntax/i)});
  expect(invalid.analysis?.revision).toBe(changed.analysis?.revision);
  expect(invalid.analysis?.graph).toEqual(changed.analysis?.graph);
  expect(invalid.analysis?.files).toEqual(changed.analysis?.files);
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});

it('labels the whole model outdated when the first analysis fails without inventing evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sync-initial-failure-'));
 const store=new ProjectStore(dir),p=await store.create({name:'Broken'}),sync=new SyncService(store,{watch:false});
 try{
  await writeFile(join(p.root,'main.ts'),'export function broken( {');
  await sync.start(p.id);
  const {analysis}=await store.get(p.id);
  expect(AnalysisSchema.safeParse(analysis).success).toBe(true);
  expect(analysis).toMatchObject({revision:'',sequence:0,status:'stale',files:{},graph:{nodes:[],edges:[]},
   staleEvidence:{scope:'all'},quality:{diagnostics:[{severity:'error',code:'analysis-failure'}]}});
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});
