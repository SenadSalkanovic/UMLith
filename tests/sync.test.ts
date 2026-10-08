import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {SyncService} from '../server/sync';
it('updates the implemented graph while preserving human intent and retains a stale model on invalid saves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sync-'));
 const store=new ProjectStore(dir);const p=await store.create({name:'Live'});
 const sync=new SyncService(store,{watch:false});
 try{
  await writeFile(join(p.root,'main.ts'),'export function original() { return 1; }');
  await sync.start(p.id);
  const before=await store.get(p.id);
  expect(before.analysis?.graph.nodes.some(n=>n.name==='original')).toBe(true);
  await store.updateSpec(p.id,0,{nodes:[{...before.analysis!.graph.nodes.find(n=>n.name==='original')!,parentId:undefined,description:'Human-owned rule'}],edges:[]});
  await writeFile(join(p.root,'main.ts'),'export function changed() { return 2; }');
  await sync.request(p.id);
  const changed=await store.get(p.id);
  expect(changed.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(changed.specification.nodes[0].description).toBe('Human-owned rule');
  await writeFile(join(p.root,'main.ts'),'export function changed( {');
  await sync.request(p.id);
  const invalid=await store.get(p.id);
  expect(invalid.analysis?.status).toBe('stale');
  expect(invalid.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(invalid.analysis?.files['main.ts'].text).toContain('return 2');
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});
