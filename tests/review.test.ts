import {it,expect} from 'vitest';
import {mkdtemp,writeFile,cp,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer} from '../server/analyzer';
import {validateCandidate,applyReviewed,freezeNode,protectionIssues} from '../server/review';
import {captureFiles,hashes,safePath} from '../server/files';
import {GraphSchema,NodeSchema,emptyGraph,type AgentJob,type Analysis,type Project} from '../shared/model';

it('freezes an explicit interface before code exists and rejects blank interfaces',()=>{
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',contract:'  run(): number\r\n'});
 const frozen=freezeNode(node,'frozen-contract');
 expect(GraphSchema.parse({nodes:[frozen],edges:[]}).nodes[0]).toMatchObject({
  policy:'frozen-contract',contract:'  run(): number\r\n',baseline:{contract:'  run(): number\r\n'},
 });
 expect(frozen.source).toBeUndefined();
 expect(()=>freezeNode({...node,contract:'\r\n '},'frozen-contract')).toThrow();
 expect(()=>freezeNode(node,'frozen-implementation')).toThrow();
});

it('captures a contract from valid source evidence when no explicit interface is supplied',()=>{
 const source={path:'run.ts',symbol:'run',start:0,end:3,line:1,hash:'h',revision:'r1'};
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',source});
 const actual={...node,contract:'run(): number'};
 const analysis:Analysis={revision:'r1',sequence:1,analyzedAt:'',status:'current',graph:{...emptyGraph(),nodes:[actual]},
  files:{'run.ts':{hash:'h',text:'run'}},durationMs:0,
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
 const frozen=freezeNode(node,'frozen-contract',analysis);
 expect(frozen.baseline).toEqual({source,contract:'run(): number'});
 expect(NodeSchema.safeParse(frozen).success).toBe(true);
 for(const candidate of [
  {...analysis,revision:'r2'}, {...analysis,status:'stale' as const}, {...analysis,files:{}},
  {...analysis,files:{'run.ts':{hash:'other',text:'run'}}},
  {...analysis,graph:{...analysis.graph,nodes:[node]}},
  {...analysis,graph:{...analysis.graph,nodes:[actual,{...actual,id:'duplicate'}]}},
 ])expect(()=>freezeNode(node,'frozen-contract',candidate)).toThrow();
 // Source rebinding must not mutate the independently captured protection evidence.
 frozen.source!.hash='new-hash';
 expect(frozen.baseline?.source?.hash).toBe('h');
 expect(node.source?.hash).toBe('h');
});

it('rejects invalid or unavailable evidence before freezing or verifying protected source',()=>{
 const source={path:'run.ts',start:0,end:3,line:1,hash:'h',revision:'r1'};
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',source});
 const analysis:Analysis={revision:'r1',sequence:1,analyzedAt:'',status:'current',graph:{...emptyGraph(),nodes:[node]},
  files:{'run.ts':{hash:'h',text:'run'}},durationMs:0,
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
 const frozen=freezeNode(node,'frozen-implementation',analysis);
 const project={specification:{...emptyGraph(),nodes:[frozen]}} as Project;
 for(const candidate of [
  {...analysis,revision:'r2'}, {...analysis,status:'stale' as const}, {...analysis,status:'updating' as const},
  {...analysis,files:{}}, {...analysis,files:{'run.ts':{hash:'other',text:'run'}}},
  {...analysis,graph:{...analysis.graph,nodes:[{...node,source:{...source,end:4}}]}},
 ]) {
  const actual=candidate.graph.nodes[0];
  expect(()=>freezeNode(actual,'frozen-implementation',candidate)).toThrow();
  expect(protectionIssues(project,candidate)).toContainEqual(expect.objectContaining({code:'binding',nodeId:'run'}));
 }
});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'architect-review-'));const store=new ProjectStore(dir);
 const p=await store.create({name:'Protected'});
 await writeFile(join(p.root,'main.ts'),'export function pay(amount: number): number { return amount * 2; }\n');
 const analysis=await new Analyzer().analyze(p.root);await store.updateAnalysis(p.id,analysis);
 const node=analysis.graph.nodes.find(n=>n.name==='pay')!;
 const candidate=join(dir,'candidate');await cp(p.root,candidate,{recursive:true});
 const job:AgentJob={id:'test',projectId:p.id,kind:'implementation',status:'review',createdAt:'',specRevision:0,sourceHashes:hashes(await captureFiles(p.root)),task:'Update',scope:['main.ts'],workspace:candidate,events:[]};
 return {dir,store,p,node,job,candidate};
}
it('blocks frozen implementation edits but permits internal edits under a frozen contract',async()=>{
 const s=await setup();try{
  const frozen=freezeNode(s.node,'frozen-implementation',s.p.analysis||await new Analyzer().analyze(s.p.root));
  await s.store.updateSpec(s.p.id,0,{nodes:[{...frozen,parentId:undefined}],edges:[]});s.job.specRevision=1;
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  const p=await s.store.get(s.p.id);
  expect((await validateCandidate(p,s.job)).issues.some(i=>i.code==='frozen-implementation')).toBe(true);
  const contract=freezeNode(s.node,'frozen-contract',p.analysis!);
  await s.store.updateSpec(s.p.id,1,{nodes:[{...contract,parentId:undefined}],edges:[]});s.job.specRevision=2;
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).passed).toBe(true);
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: string): string { return amount; }\n');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).issues.some(i=>i.code==='frozen-contract')).toBe(true);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('permits internal edits after freezing a binding with a whitespace-only interface',async()=>{
 const s=await setup();try{
  const p=await s.store.get(s.p.id);
  const frozen=freezeNode({...s.node,contract:' \r\n'},'frozen-contract',p.analysis);
  expect(frozen.baseline?.contract).toBe(s.node.contract);
  await s.store.updateSpec(s.p.id,0,{nodes:[{...frozen,parentId:undefined}],edges:[]});s.job.specRevision=1;
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).passed).toBe(true);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('rejects out-of-scope and stale changes, and only applies reviewed file contents',async()=>{
 const s=await setup();try{
  await writeFile(join(s.candidate,'other.ts'),'export const outside = 1;');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).issues.some(i=>i.code==='scope')).toBe(true);
  await rm(join(s.candidate,'other.ts'));
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  s.job.report=await validateCandidate(await s.store.get(s.p.id),s.job);
  await applyReviewed(s.store,s.job);
  expect(await readFile(join(s.p.root,'main.ts'),'utf8')).toContain('* 3');
  await writeFile(join(s.p.root,'main.ts'),'export const externalEdit = true;');
  await expect(applyReviewed(s.store,{...s.job,status:'review'})).rejects.toThrow('Source changed');
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('rejects path traversal and symbolic links',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-paths-'));try{
  await expect(safePath(dir,'../outside')).rejects.toThrow('Unsafe');
  await symlink(tmpdir(),join(dir,'escape'));
  await expect(safePath(dir,'escape/file.ts')).rejects.toThrow('Symlink');
 }finally{await rm(dir,{recursive:true,force:true});}
});
