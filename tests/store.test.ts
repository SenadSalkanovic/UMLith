import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {NodeSchema} from '../shared/model';
it('persists graph revisions, keeps layout separate and rejects stale edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-store-'));
 try {
  const store=new ProjectStore(dir);const p=await store.create({name:'Desktop tool',target:'Electron'});
  await store.updateSpec(p.id,0,{nodes:[NodeSchema.parse({id:'root',kind:'system',name:'Tool'})],edges:[]});
  await store.updateLayout(p.id,{root:{x:23,y:47}});
  const reopened=await new ProjectStore(dir).get(p.id);
  expect(reopened.specRevision).toBe(1);expect(reopened.layout.root.x).toBe(23);
  expect(reopened.specification.nodes[0].name).toBe('Tool');
  await expect(store.updateSpec(p.id,0,{nodes:[],edges:[]})).rejects.toThrow('Specification changed');
  expect((await store.history(p.id)).length).toBe(2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
