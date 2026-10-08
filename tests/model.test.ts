import {describe,it,expect} from 'vitest';
import {GraphSchema,NodeSchema,graphDelta,emptyGraph,createNodeId,sourceIdentityKey,validRelationship,type Layout} from '../shared/model';
describe('program graph',()=>{
 it('rejects cycles, duplicates and dangling relationships',()=>{
  const a=NodeSchema.parse({id:'a',kind:'module',name:'A',parentId:'b'});
  const b=NodeSchema.parse({id:'b',kind:'module',name:'B',parentId:'a'});
  expect(GraphSchema.safeParse({nodes:[a,b],edges:[]}).success).toBe(false);
  expect(GraphSchema.safeParse({nodes:[{...a,parentId:undefined}, {...a,parentId:undefined}],edges:[]}).success).toBe(false);
  expect(GraphSchema.safeParse({nodes:[],edges:[{id:'e',source:'a',target:'b',kind:'calls'}]}).success).toBe(false);
 });
 it('reports changed and removed nodes instead of a whole replacement',()=>{
  const a=NodeSchema.parse({id:'a',kind:'function',name:'Old'});
  const b=NodeSchema.parse({id:'b',kind:'function',name:'Removed'});
  expect(graphDelta({...emptyGraph(),nodes:[a,b]},{...emptyGraph(),nodes:[{...a,name:'New'}]})).toMatchObject({changedNodes:[{id:'a',name:'New'}],deletedNodes:['b']});
 });

 it('allocates distinct identities for human functions with identical names',()=>{
  const graph=GraphSchema.parse({nodes:[
   {id:createNodeId(),kind:'function',name:'save'},
   {id:createNodeId(),kind:'function',name:'save'},
  ],edges:[]});
  expect(graph.nodes[0].id).not.toBe(graph.nodes[1].id);
  expect(graph.nodes.map(n=>n.provenance)).toEqual(['human','human']);
 });

 it('retains a human function identity and references after rename and reposition',()=>{
  const id=createNodeId();
  const before=GraphSchema.parse({nodes:[
   {id:'module',kind:'module',name:'Orders'},
   {id,kind:'function',name:'save',parentId:'module'},
  ],edges:[{id:'owns',kind:'contains',source:'module',target:id}]});
  const selectedId=id;
  const layout:Layout={[id]:{x:10,y:20}};
  const renamed=GraphSchema.parse({...before,nodes:before.nodes.map(n=>n.id===id?{...n,name:'saveOrder'}:n)});
  layout[id]={x:300,y:150};
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(renamed)));
  expect(restored.nodes.find(n=>n.id===selectedId)).toMatchObject({id,name:'saveOrder',parentId:'module'});
  expect(restored.edges[0]).toMatchObject({id:'owns',target:id});
  expect(layout[selectedId]).toEqual({x:300,y:150});
  expect(graphDelta(before,restored)).toMatchObject({changedNodes:[{id,name:'saveOrder'}],deletedNodes:[],changedEdges:[],deletedEdges:[]});
  expect(graphDelta(renamed,restored).changedNodes).toEqual([]);
 });

 it('keys extracted declarations by source scope without using labels, offsets or content revisions',()=>{
  const original=NodeSchema.parse({id:'original',kind:'function',name:'Save order',provenance:'extracted',
   source:{path:'orders.ts',symbol:'Order.save',start:10,end:100,line:2,hash:'before',revision:'r1'}});
  const edited=NodeSchema.parse({...original,id:'fresh',name:'New display label',parentId:'new-parent',
   source:{...original.source!,start:50,end:200,line:7,hash:'after',revision:'r2'}});
  expect(sourceIdentityKey(original)).toBe('["orders.ts","function","Order.save"]');
  expect(sourceIdentityKey(edited)).toBe('["orders.ts","function","Order.save"]');
  expect(edited.id).toBe('fresh');
  for(const node of [
   {...original,kind:'class' as const},
   {...original,source:{...original.source!,path:'archive/orders.ts'}},
   {...original,source:{...original.source!,symbol:'Other.save'}},
  ])expect(sourceIdentityKey(node)).not.toBe(sourceIdentityKey(original));
 });

 it('uses a path-only source scope for modules and does not guess missing declaration evidence',()=>{
  const source={path:'orders.ts',start:0,end:100,line:1,hash:'content',revision:'r1'};
  expect(sourceIdentityKey({kind:'module',source})).toBe('["orders.ts","module",null]');
  expect(sourceIdentityKey({kind:'module',source:{...source,symbol:'display'}})).toBe('["orders.ts","module",null]');
  expect(sourceIdentityKey({kind:'function',source})).toBeUndefined();
  expect(sourceIdentityKey({kind:'function',source:{...source,symbol:''}})).toBeUndefined();
  expect(sourceIdentityKey({kind:'function',source:{...source,path:'',symbol:'save'}})).toBeUndefined();
  expect(sourceIdentityKey({kind:'function'})).toBeUndefined();
  expect(sourceIdentityKey({kind:'step',source:{...source,symbol:'save'}})).toBeUndefined();
  expect(sourceIdentityKey({kind:'system',source:{...source,symbol:'project'}})).toBeUndefined();
 });

 it('keeps delimiter-containing source scopes distinct',()=>{
  const source={path:'a:function:b',symbol:'c',start:0,end:1,line:1,hash:'h',revision:'r'};
  const first=sourceIdentityKey({kind:'function',source});
  const second=sourceIdentityKey({kind:'function',source:{...source,path:'a',symbol:'b:function:c'}});
  expect(first).toBe('["a:function:b","function","c"]');
  expect(second).toBe('["a","function","b:function:c"]');
  expect(first).not.toBe(second);
 });

 it.each(['true','false'] as const)('rejects a %s workflow branch between unrelated entities',kind=>{
  expect(validRelationship(kind,'entity','entity')).toBe(false);
  const result=GraphSchema.safeParse({nodes:[
   {id:'order',kind:'entity',name:'Order'},
   {id:'user',kind:'entity',name:'User'},
  ],edges:[{id:'branch',source:'order',target:'user',kind}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['edges',0,'kind']}));
 });

 it('round-trips architecture, ER and workflow entities in one versioned graph',()=>{
  const graph=GraphSchema.parse({schemaVersion:1,nodes:[
   {id:'module',kind:'module',name:'Orders'},
   {id:'function',kind:'function',name:'saveOrder',parentId:'module',description:'Save an order',
    rules:'Never lose an order',scenarios:['A saved order can be read'],policy:'sensitive',provenance:'extracted',
    source:{path:'orders.ts',symbol:'saveOrder',start:0,end:120,line:1,hash:'content-hash',revision:'source-revision'}},
   {id:'entity',kind:'entity',name:'Order',parentId:'module',fields:[{name:'id',type:'Int',key:'PK'}]},
   {id:'step',kind:'step',name:'Write order',parentId:'function',stepType:'operation'},
  ],edges:[{id:'write',source:'step',target:'entity',kind:'writes'}]});
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  expect(restored).toEqual(graph);
  expect(restored.schemaVersion).toBe(1);
  const architecture=restored.nodes.filter(n=>n.kind==='module'||n.kind==='function');
  const er=restored.nodes.filter(n=>n.kind==='entity');
  const workflow=restored.nodes.filter(n=>n.kind==='step');
  expect(architecture.map(n=>n.id)).toEqual(['module','function']);
  expect(er[0]).toBe(restored.nodes[2]);
  expect(workflow[0].parentId).toBe(architecture[1].id);
  expect(restored.edges[0]).toMatchObject({source:workflow[0].id,target:er[0].id});
  expect(restored.nodes[1]).toMatchObject({rules:'Never lose an order',scenarios:['A saved order can be read'],
   policy:'sensitive',provenance:'extracted',source:{path:'orders.ts',hash:'content-hash',revision:'source-revision'}});
 });

 it('normalizes existing unversioned graphs to v1 without losing their entities',()=>{
  const parsed=GraphSchema.parse({nodes:[{id:'legacy',kind:'module',name:'Existing'}],edges:[]});
  expect(parsed).toMatchObject({schemaVersion:1,nodes:[{id:'legacy',name:'Existing'}]});
  expect(emptyGraph()).toEqual({schemaVersion:1,nodes:[],edges:[]});
 });

 it.each([0,2,-1,1.5,'1',null])('rejects unsupported schema version %s',schemaVersion=>{
  const result=GraphSchema.safeParse({schemaVersion,nodes:[],edges:[]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['schemaVersion']}));
 });

 it.each([
  ['duplicate node IDs',{nodes:[{id:'a',kind:'module',name:'A'},{id:'a',kind:'module',name:'B'}],edges:[]},['nodes',1,'id'],/duplicate node/i],
  ['duplicate edge IDs',{nodes:[{id:'a',kind:'function',name:'A'}],edges:[{id:'e',source:'a',target:'a',kind:'calls'},{id:'e',source:'a',target:'a',kind:'calls'}]},['edges',1,'id'],/duplicate edge/i],
  ['missing parent',{nodes:[{id:'a',kind:'module',name:'A',parentId:'absent'}],edges:[]},['nodes',0,'parentId'],/missing parent/i],
  ['missing source',{nodes:[{id:'a',kind:'function',name:'A'}],edges:[{id:'e',source:'absent',target:'a',kind:'calls'}]},['edges',0,'source'],/missing.*endpoint/i],
  ['missing target',{nodes:[{id:'a',kind:'function',name:'A'}],edges:[{id:'e',source:'a',target:'absent',kind:'calls'}]},['edges',0,'target'],/missing.*endpoint/i],
 ] as const)('reports an explicit error for %s',(_name,input,path,message)=>{
  const result=GraphSchema.safeParse(input);
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:[...path],message:expect.stringMatching(message)}));
 });

 it.each(['id','source','target'] as const)('rejects empty edge %s',field=>{
  expect(GraphSchema.safeParse({nodes:[{id:'a',kind:'function',name:'A'}],edges:[{id:'e',source:'a',target:'a',kind:'calls',[field]:''}]}).success).toBe(false);
 });

 it('rejects an empty parent reference instead of treating it as no parent',()=>{
  expect(GraphSchema.safeParse({nodes:[{id:'a',kind:'module',name:'A',parentId:''}],edges:[]}).success).toBe(false);
 });

 it('checks containment types consistently for parents and contains edges',()=>{
  const nodes=[{id:'entity',kind:'entity',name:'Order'},{id:'function',kind:'function',name:'save'}];
  const parent=GraphSchema.safeParse({nodes:[nodes[0],{...nodes[1],parentId:'entity'}],edges:[]});
  expect(parent.success).toBe(false);
  if(!parent.success)expect(parent.error.issues).toContainEqual(expect.objectContaining({path:['nodes',1,'parentId'],message:expect.stringMatching(/invalid contains relationship/i)}));
  expect(GraphSchema.safeParse({nodes,edges:[{id:'contains',source:'entity',target:'function',kind:'contains'}]}).success).toBe(false);
 });

 it.each([
  ['system','system',true],['system','module',true],['system','entity',true],
  ['module','module',true],['module','entity',true],['module','enum',true],
  ['class','function',true],['interface','function',true],
  ['function','class',true],['function','interface',true],['function','enum',true],
  ['function','function',true],['function','step',true],['step','step',true],
  ['module','system',false],['class','module',false],['interface','entity',false],
  ['function','system',false],['function','module',false],['function','entity',false],
  ['step','system',false],['step','function',false],['step','entity',false],
  ['system','step',false],['module','step',false],['class','step',false],['interface','step',false],
  ['entity','function',false],['enum','enum',false],
 ] as const)('validates containment from %s to %s as %s for both representations',(sourceKind,targetKind,valid)=>{
  const parent={id:'parent',kind:sourceKind,name:'Parent'},child={id:'child',kind:targetKind,name:'Child'};
  for(const [input,path] of [
   [{nodes:[parent,{...child,parentId:'parent'}],edges:[]},['nodes',1,'parentId']],
   [{nodes:[parent,child],edges:[{id:'contains',source:'parent',target:'child',kind:'contains'}]},['edges',0,'kind']],
  ] as const){
   const result=GraphSchema.safeParse(input);
   expect(result.success).toBe(valid);
   if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:[...path],message:expect.stringMatching(/invalid contains relationship/i)}));
  }
 });

 it.each([
  ['parent cycle',[{id:'a',kind:'module',name:'A',parentId:'b'},{id:'b',kind:'module',name:'B',parentId:'a'}],[]],
  ['self-parent',[{id:'a',kind:'module',name:'A',parentId:'a'}],[]],
  ['contains cycle',[{id:'a',kind:'module',name:'A'},{id:'b',kind:'module',name:'B'}],[{id:'ab',source:'a',target:'b',kind:'contains'},{id:'ba',source:'b',target:'a',kind:'contains'}]],
  ['mixed containment cycle',[{id:'a',kind:'module',name:'A'},{id:'b',kind:'module',name:'B',parentId:'a'}],[{id:'ba',source:'b',target:'a',kind:'contains'}]],
  ['self-containment',[{id:'a',kind:'module',name:'A'}],[{id:'aa',source:'a',target:'a',kind:'contains'}]],
 ] as const)('rejects %s with an explicit containment error',(_name,nodes,edges)=>{
  const result=GraphSchema.safeParse({nodes,edges});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({message:expect.stringMatching(/(?:parent|containment) cycle/i)}));
 });

 it.each([
  ['depends-on','module','module'],['contains','module','function'],['inherits','class','class'],
  ['inherits','interface','interface'],['inherits','interface','class'],['implements','class','interface'],['implements','class','class'],['calls','function','function'],
  ['calls','module','class'],['calls','step','function'],['relates-to','entity','entity'],
  ['next','step','step'],['true','step','step'],['false','step','step'],
  ['reads','function','entity'],['writes','step','entity'],
 ] as const)('accepts %s from %s to %s',(kind,sourceKind,targetKind)=>{
  expect(GraphSchema.safeParse({nodes:[{id:'a',kind:sourceKind,name:'A'},{id:'b',kind:targetKind,name:'B'}],edges:[{id:'e',source:'a',target:'b',kind}]}).success).toBe(true);
 });

 it.each([
  ['depends-on','step','entity'],['contains','entity','function'],['inherits','function','entity'],
  ['inherits','class','interface'],['implements','interface','class'],['calls','entity','module'],
  ['relates-to','function','entity'],['next','function','step'],['true','entity','entity'],
  ['false','step','entity'],['reads','entity','function'],['writes','function','module'],
 ] as const)('rejects %s from %s to %s',(kind,sourceKind,targetKind)=>{
  const result=GraphSchema.safeParse({nodes:[{id:'a',kind:sourceKind,name:'A'},{id:'b',kind:targetKind,name:'B'}],edges:[{id:'e',source:'a',target:'b',kind}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['edges',0,'kind'],message:expect.stringMatching(/invalid.*relationship/i)}));
 });

 it('permits call recursion and workflow loops while checking only containment cycles',()=>{
  expect(GraphSchema.safeParse({nodes:[
   {id:'f',kind:'function',name:'Run'},
   {id:'a',kind:'step',name:'Loop',stepType:'loop',parentId:'f'},
   {id:'b',kind:'step',name:'Work',stepType:'operation',parentId:'f'},
  ],edges:[
   {id:'recursive',source:'f',target:'f',kind:'calls'},
   {id:'ab',source:'a',target:'b',kind:'true'},
   {id:'ba',source:'b',target:'a',kind:'next'},
   {id:'contains',source:'f',target:'a',kind:'contains'},
  ]}).success).toBe(true);
 });
});
