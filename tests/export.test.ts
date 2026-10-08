import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {unzipSync,strFromU8} from 'fflate';
import {ProjectStore} from '../server/store';
import {GraphSchema,NodeSchema} from '../shared/model';
import {exportBundle} from '../server/export';
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
