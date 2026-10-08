import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unzipSync,strFromU8} from 'fflate';
import {ProjectStore} from '../server/store';
import {NodeSchema} from '../shared/model';
import {exportBundle} from '../server/export';
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
