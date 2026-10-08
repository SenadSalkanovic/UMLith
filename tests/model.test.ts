import {describe,it,expect} from 'vitest';
import {GraphSchema,NodeSchema,graphDelta,emptyGraph,createNodeId,sourceIdentityKey,validRelationship,type Layout,type GraphInput} from '../shared/model';

describe('optional function control flow',()=>{
 const evidence={path:'src/run.ts',start:10,end:40,line:2,hash:'content-hash',revision:'source-1'};
 const loop:GraphInput={nodes:[
  {id:'run',kind:'function',name:'Run'},
  {id:'callee',kind:'function',name:'Work'},
  {id:'loop',kind:'step',name:'For each item',parentId:'run',stepType:'loop'},
  {id:'condition',kind:'step',name:'Item is ready',parentId:'loop',stepType:'condition'},
  {id:'call',kind:'step',name:'Work on item',parentId:'condition',stepType:'call'},
  {id:'return',kind:'step',name:'Done',parentId:'run',stepType:'return'},
 ],edges:[
  {id:'body',source:'loop',target:'condition',kind:'true'},
  {id:'ready',source:'condition',target:'call',kind:'true'},
  {id:'skip',source:'condition',target:'loop',kind:'false'},
  {id:'repeat',source:'call',target:'loop',kind:'next'},
  {id:'done',source:'loop',target:'return',kind:'false'},
  {id:'invoke',source:'call',target:'callee',kind:'calls'},
 ]};

 it('round-trips a nested loop, condition and call with branch cycles and a callable target',()=>{
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(GraphSchema.parse(loop))));
  expect(restored.nodes.map(n=>[n.id,n.parentId,n.stepType])).toEqual([
   ['run',undefined,undefined],['callee',undefined,undefined],['loop','run','loop'],
   ['condition','loop','condition'],['call','condition','call'],['return','run','return'],
  ]);
  expect(restored.edges.map(e=>[e.source,e.target,e.kind])).toEqual([
   ['loop','condition','true'],['condition','call','true'],['condition','loop','false'],
   ['call','loop','next'],['loop','return','false'],['call','callee','calls'],
  ]);
 });

 it('represents try, throw, handled return and source-backed opaque logic without inventing execution evidence',()=>{
  const input:GraphInput={nodes:[
   {id:'run',kind:'function',name:'Run'},
   {id:'try',kind:'step',name:'Try work',parentId:'run',stepType:'try'},
   {id:'opaque',kind:'step',name:'Unsupported block',parentId:'try',stepType:'opaque',provenance:'extracted',source:evidence},
   {id:'throw',kind:'step',name:'Throw failure',parentId:'try',stepType:'throw'},
   {id:'handler',kind:'step',name:'Handle failure',parentId:'run',stepType:'operation'},
   {id:'return',kind:'step',name:'Return recovery',parentId:'run',stepType:'return'},
  ],edges:[
   {id:'start',source:'try',target:'opaque',kind:'next'},
   {id:'fail',source:'opaque',target:'throw',kind:'next'},
   {id:'caught',source:'throw',target:'handler',kind:'exception',label:'Failure'},
   {id:'recover',source:'handler',target:'return',kind:'next'},
  ]};
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(GraphSchema.parse(input))));
  expect(restored.nodes.map(n=>n.stepType)).toEqual([undefined,'try','opaque','throw','operation','return']);
  expect(restored.nodes[2]).toMatchObject({provenance:'extracted',source:evidence});
  expect(restored.edges[2]).toMatchObject({source:'throw',target:'handler',kind:'exception',label:'Failure'});
  expect(restored.nodes[0].source).toBeUndefined();
  expect(restored.nodes[0].scenarios).toBeUndefined();
 });

 it('derives nesting and function ownership from mixed containment representations in any node order',()=>{
  const input:GraphInput={nodes:[
   {id:'work',kind:'step',name:'Work',parentId:'loop',stepType:'operation'},
   {id:'loop',kind:'step',name:'Loop',stepType:'loop'},
   {id:'run',kind:'function',name:'Run',parentId:'outer'},
   {id:'outer',kind:'function',name:'Outer'},
  ],edges:[
   {id:'owns',source:'run',target:'loop',kind:'contains'},
   {id:'nested',source:'loop',target:'work',kind:'contains'},
   {id:'body',source:'loop',target:'work',kind:'true'},
   {id:'repeat',source:'work',target:'loop',kind:'next'},
  ]};
  expect(GraphSchema.safeParse(input).success).toBe(true);
 });

 it.each(['next','true','false','exception'] as const)('rejects %s between different owning functions',kind=>{
  const result=GraphSchema.safeParse({nodes:[
   {id:'f',kind:'function',name:'F'}, {id:'g',kind:'function',name:'G'},
   {id:'a',kind:'step',name:'A',parentId:'f',stepType:'condition'},
   {id:'b',kind:'step',name:'B',parentId:'g',stepType:'operation'},
  ],edges:[{id:'flow',source:'a',target:'b',kind}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['edges',0,'target'],message:expect.stringMatching(/same owning function/i)}));
 });

 it('keeps nested functions in separate workflows',()=>{
  expect(GraphSchema.safeParse({...loop,nodes:loop.nodes.map(n=>n.id==='callee'?{...n,parentId:'run'}:n).concat([
   {id:'inner',kind:'step',name:'Inner work',parentId:'callee',stepType:'operation'},
  ]),edges:[{id:'cross',source:'call',target:'inner',kind:'next'}]}).success).toBe(false);
 });

 it('allows a self-loop and a partial workflow beside a description-only function',()=>{
  const graph=GraphSchema.parse({...loop,nodes:loop.nodes.concat([
   {id:'draft',kind:'function',name:'Draft',description:'Specify this later'},
  ]),edges:[{id:'repeat',source:'loop',target:'loop',kind:'true'}]});
  expect(graph.edges).toHaveLength(1);
  expect(graph.nodes.at(-1)).toMatchObject({id:'draft',description:'Specify this later'});
  expect(graph.nodes.at(-1)?.stepType).toBeUndefined();
 });

 it.each(['true','false'] as const)('rejects a %s branch from a non-decision step',kind=>{
  const result=GraphSchema.safeParse({...loop,edges:[{id:'branch',source:'call',target:'return',kind}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['edges',0,'kind'],message:expect.stringMatching(/condition or loop/i)}));
 });

 it.each(['true','false'] as const)('rejects competing %s branch destinations',kind=>{
  const result=GraphSchema.safeParse({...loop,edges:[
   {id:'first',source:'condition',target:'call',kind},
   {id:'second',source:'condition',target:'return',kind},
  ]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['edges',1,'kind'],message:expect.stringMatching(/duplicate.*branch/i)}));
 });

 it.each(['return','throw'] as const)('rejects normal continuation after %s',stepType=>{
  expect(GraphSchema.safeParse({...loop,nodes:loop.nodes.map(n=>n.id==='call'?{...n,stepType}:n),
   edges:[{id:'continue',source:'call',target:'return',kind:'next'}]}).success).toBe(false);
 });

 it('rejects missing step kinds and step kinds on declarations',()=>{
  const result=GraphSchema.safeParse({nodes:[{id:'f',kind:'function',name:'F',stepType:'call'},
   {id:'s',kind:'step',name:'S',parentId:'f'}],edges:[]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toEqual(expect.arrayContaining([
   expect.objectContaining({path:['nodes',0,'stepType']}),expect.objectContaining({path:['nodes',1,'stepType']}),
  ]));
 });

 it('rejects orphan steps and nested steps with no function ancestor',()=>{
  const result=GraphSchema.safeParse({nodes:[{id:'s',kind:'step',name:'S',stepType:'loop'},
   {id:'nested',kind:'step',name:'Nested',parentId:'s',stepType:'operation'}],edges:[]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toEqual(expect.arrayContaining([
   expect.objectContaining({path:['nodes',0,'parentId']}),expect.objectContaining({path:['nodes',1,'parentId']}),
  ]));
 });

 it.each(['different function','different nesting'] as const)('rejects multiple containment parents: %s',variant=>{
  const result=GraphSchema.safeParse({...loop,edges:[...loop.edges,{id:'other-parent',source:variant==='different function'?'callee':'loop',target:'call',kind:'contains'}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['nodes',4,'parentId'],message:expect.stringMatching(/one containment parent/i)}));
 });

 it.each([
  undefined,{...evidence,path:''},{...evidence,hash:''},{...evidence,revision:''},
  {...evidence,start:-1},{...evidence,start:1.5},{...evidence,end:9},{...evidence,end:40.5},{...evidence,line:0},
 ] as const)('rejects opaque steps without usable source evidence (%j)',source=>{
  const result=GraphSchema.safeParse({nodes:[{id:'f',kind:'function',name:'F'},
   {id:'s',kind:'step',name:'Unsupported',parentId:'f',stepType:'opaque',source}],edges:[]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues.some(issue=>issue.path[0]==='nodes'&&issue.path[1]===1&&issue.path[2]==='source')).toBe(true);
 });

 it('still rejects mixed containment cycles inside a function workflow',()=>{
  const result=GraphSchema.safeParse({...loop,edges:[...loop.edges,{id:'cycle',source:'call',target:'loop',kind:'contains'}]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({message:expect.stringMatching(/containment cycle/i)}));
 });
});
describe('program graph',()=>{
 it('keeps description-only function details unknown without inventing workflow or implementation evidence',()=>{
  const graph=GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'save',description:'Save a document'}],edges:[]});
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  expect(restored.nodes).toHaveLength(1);
  expect(restored.edges).toEqual([]);
  expect(restored.nodes[0]).toMatchObject({id:'save',description:'Save a document',provenance:'human'});
  for(const field of ['inputs','outputs','rules','errors','scenarios','source','stepType'] as const)
   expect(restored.nodes[0][field]).toBeUndefined();
 });

 it('retains every detailed function field losslessly without requiring a workflow',()=>{
  const detail={description:'  Save a document\r\nKeep Unicode ✓\n',inputs:'document: Document\n  destination: string ',
   outputs:'Promise<void>\r\n',rules:'Keep original until success\n',errors:'DiskFull\n  PermissionDenied ',
   scenarios:['Given a document\nWhen saved\nThen reopen it\n','When interrupted\r\nThen retain the original','When interrupted\r\nThen retain the original']};
  const graph=GraphSchema.parse({nodes:[{id:'save',kind:'function',name:'save',...detail}],edges:[]});
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  expect(restored.nodes[0]).toMatchObject(detail);
  expect(restored.nodes[0].provenance).toBe('human');
  expect(restored.nodes[0].source).toBeUndefined();
  expect(restored.nodes[0].stepType).toBeUndefined();
  expect(restored.edges).toEqual([]);
 });

 it('enriches an existing function without changing its identity, requirement links or relationships',()=>{
  const before=GraphSchema.parse({nodes:[{id:'module',kind:'module',name:'Documents'},
   {id:'save',kind:'function',name:'save',parentId:'module',description:'Save a document'}],
   edges:[{id:'owns',source:'module',target:'save',kind:'contains'}],requirements:[{id:'safety',text:'Never lose text',nodeIds:['save']}]});
  const after=GraphSchema.parse({...before,nodes:before.nodes.map(n=>n.id==='save'?{...n,inputs:'Document',outputs:'void',
   rules:'Atomic write',errors:'DiskFull',scenarios:['Reopen saved text']}:n)});
  expect(after.nodes[1]).toMatchObject({id:'save',description:'Save a document',inputs:'Document',outputs:'void',rules:'Atomic write',errors:'DiskFull',scenarios:['Reopen saved text']});
  expect(after.edges).toEqual(before.edges);
  expect(after.requirements[0].nodeIds).toEqual(['save']);
  expect(graphDelta(before,after)).toMatchObject({changedNodes:[{id:'save'}],deletedNodes:[],changedEdges:[],deletedEdges:[],changedRequirements:[]});
 });

 it('preserves explicit empty detail values from legacy graphs instead of treating them as unspecified',()=>{
  const graph=GraphSchema.parse({nodes:[{id:'empty',kind:'function',name:'empty',inputs:'',outputs:'',rules:'',errors:'',scenarios:[]}],edges:[]});
  expect(GraphSchema.parse(JSON.parse(JSON.stringify(graph))).nodes[0]).toMatchObject({inputs:'',outputs:'',rules:'',errors:'',scenarios:[]});
 });

 it.each([
  ['description',null],['description',42],['inputs',null],['inputs',[]],['outputs',null],['outputs',42],
  ['rules',null],['rules',{}],['errors',null],['errors',false],['scenarios',null],['scenarios','Scenario'],['scenarios',[42]],
 ])('rejects malformed function detail %s: %j',(field,value)=>{
  const result=GraphSchema.safeParse({nodes:[{id:'save',kind:'function',name:'save',[field]:value}],edges:[]});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:['nodes',0,field,...(field==='scenarios'&&Array.isArray(value)?[0]:[])]}));
 });

 it('round-trips ordered project and function requirements and multiline scenarios without changing text',()=>{
  const requirements=[
   {id:'project-safety',text:'  Preserve documents.\r\nKeep Unicode: č, ✓\n',nodeIds:[],edgeIds:[],constraints:['  Offline only\nNo network  '],scenarios:['Given a document\nWhen reopened\nThen text is unchanged\n']},
   {id:'save-safety',text:'Save safely\nEven when interrupted',nodeIds:['save','document'],edgeIds:['write'],constraints:[],scenarios:['First scenario\n  with indentation','Second scenario\r\n']},
  ];
  const input={nodes:[{id:'save',kind:'function',name:'save',scenarios:['  Function scenario\nThen return ✓\n']},{id:'document',kind:'entity',name:'Document'}],
   edges:[{id:'write',source:'save',target:'document',kind:'writes'}],requirements};
  const graph=GraphSchema.parse(input);
  const restored=GraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  expect(restored).toMatchObject({requirements,nodes:[{scenarios:['  Function scenario\nThen return ✓\n']},{}]});
  const edited=GraphSchema.parse({...restored,nodes:restored.nodes.map(n=>({...n,name:n.name+' renamed'})),
   requirements:requirements.map(r=>({...r,text:r.text+'Updated\n'}))});
  expect(edited.requirements.map(r=>r.id)).toEqual(['project-safety','save-safety']);
  expect(edited.requirements[1]).toMatchObject({nodeIds:['save','document'],edgeIds:['write'],text:'Save safely\nEven when interruptedUpdated\n'});
 });

 it('normalizes legacy graphs and omitted requirement details without inventing proof or references',()=>{
  expect(GraphSchema.parse({nodes:[],edges:[]}).requirements).toEqual([]);
  expect(GraphSchema.parse({nodes:[],edges:[],requirements:[{id:'project',text:'Keep data'}]}).requirements)
   .toEqual([{id:'project',text:'Keep data',nodeIds:[],edgeIds:[],constraints:[],scenarios:[]}]);
 });

 it.each([
  ['duplicate identifiers',[{id:'r',text:'One'},{id:'r',text:'Two'}],['requirements',1,'id'],/duplicate requirement/i],
  ['deleted function',[{id:'r',text:'Save',nodeIds:['deleted']}],['requirements',0,'nodeIds',0],/missing requirement node.*deleted/i],
  ['deleted relationship',[{id:'r',text:'Write',edgeIds:['deleted']}],['requirements',0,'edgeIds',0],/missing requirement edge.*deleted/i],
 ] as const)('reports an explicit requirement error for %s',(_name,requirements,path,message)=>{
  const result=GraphSchema.safeParse({nodes:[],edges:[],requirements});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({path:[...path],message:expect.stringMatching(message)}));
 });

 it.each([
  {id:'',text:'Save'}, {id:'r'}, {id:'r',text:42}, {id:'r',text:'Save',nodeIds:['']},
  {id:'r',text:'Save',edgeIds:['']}, {id:'r',text:'Save',scenarios:[42]}, {id:'r',text:'Save',constraints:[false]},
 ])('rejects malformed requirement records: %j',requirement=>{
  expect(GraphSchema.safeParse({nodes:[],edges:[],requirements:[requirement]}).success).toBe(false);
 });

 it('reports requirement edits and deletions in graph deltas',()=>{
  const before=GraphSchema.parse({nodes:[],edges:[],requirements:[{id:'keep',text:'Old'},{id:'remove',text:'Removed'}]});
  const after=GraphSchema.parse({...before,requirements:[{...before.requirements[0],text:'New'},{id:'add',text:'Added'}]});
  expect(graphDelta(before,after)).toMatchObject({changedRequirements:[{id:'keep',text:'New'},{id:'add',text:'Added'}],deletedRequirements:['remove'],changedNodes:[],deletedNodes:[]});
  expect(graphDelta(after,GraphSchema.parse(JSON.parse(JSON.stringify(after))))).toMatchObject({changedRequirements:[],deletedRequirements:[]});
 });

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
  expect(emptyGraph()).toEqual({schemaVersion:1,nodes:[],edges:[],requirements:[]});
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
  const owner={id:'owner',kind:'function' as const,name:'Owner'};
  const parent={id:'parent',kind:sourceKind,name:'Parent',...(sourceKind==='step'?{stepType:'operation' as const,parentId:'owner'}:{})};
  const child={id:'child',kind:targetKind,name:'Child',...(targetKind==='step'?{stepType:'operation' as const}:{})};
  for(const [input,path] of [
   [{nodes:[parent,{...child,parentId:'parent'},owner],edges:[]},['nodes',1,'parentId']],
   [{nodes:[parent,child,owner],edges:[{id:'contains',source:'parent',target:'child',kind:'contains'}]},['edges',0,'kind']],
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
  ['next','step','step'],['true','step','step'],['false','step','step'],['exception','step','step'],
  ['reads','function','entity'],['writes','step','entity'],
 ] as const)('accepts %s from %s to %s',(kind,sourceKind,targetKind)=>{
  expect(GraphSchema.safeParse({nodes:[
   {id:'a',kind:sourceKind,name:'A',...(sourceKind==='step'?{parentId:'owner',stepType:kind==='true'||kind==='false'?'condition':'operation'}:{})},
   {id:'b',kind:targetKind,name:'B',...(targetKind==='step'?{parentId:'owner',stepType:'operation'}:{})},
   {id:'owner',kind:'function',name:'Owner'},
  ],edges:[{id:'e',source:'a',target:'b',kind}]}).success).toBe(true);
 });

 it.each([
  ['depends-on','step','entity'],['contains','entity','function'],['inherits','function','entity'],
  ['inherits','class','interface'],['implements','interface','class'],['calls','entity','module'],
  ['relates-to','function','entity'],['next','function','step'],['true','entity','entity'],
  ['false','step','entity'],['exception','function','step'],['reads','entity','function'],['writes','function','module'],
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
