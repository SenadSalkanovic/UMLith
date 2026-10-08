import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unzipSync,strFromU8} from 'fflate';
import {ProjectStore} from '../server/store';
import {GraphSchema,NodeSchema} from '../shared/model';
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
