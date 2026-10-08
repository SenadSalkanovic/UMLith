import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,rm,symlink,access} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import type {ChildProcess} from 'node:child_process';
import chokidar from 'chokidar';
import {z} from 'zod';
import {GraphSchema,type AgentJob,type Project,type Graph,type DesignProposal} from '../shared/model';
import {ProjectStore} from './store';
import {SyncService} from './sync';
import {bundleFiles} from './export';
import {AppError,copySnapshot,captureFiles,hashes,atomicJson,ignoredDirs,excluded} from './files';
import {validateCandidate,applyReviewed} from './review';
import {runSandbox,sandboxAvailable} from './sandbox';
import {AnalysisWorker} from './worker';
export const SettingsSchema=z.object({provider:z.enum(['hosted','ollama','lmstudio']).default('hosted'),model:z.string().max(2000).optional(),timeoutMinutes:z.number().min(1).max(120).default(30)});
export const TaskSchema=z.object({task:z.string().min(1).max(30000),scope:z.array(z.string().min(1)).min(1),settings:SettingsSchema.default({provider:'hosted',timeoutMinutes:30}),kind:z.enum(['implementation','design']).default('implementation')});
const ProposalSchema=z.object({graph:GraphSchema,explanation:z.string(),questions:z.array(z.string())});
type Runner={executable?:string;prefixArgs?:string[]};
type Active={job:AgentJob;child?:ChildProcess;done:Promise<void>};
export class JobService extends EventEmitter {
 private active=new Map<string,Active>();
 private closed=false;
 constructor(public store:ProjectStore,public sync:SyncService,private runner:Runner={}){super();}
 async get(projectId:string,id:string):Promise<AgentJob>{
  if(!/^[a-zA-Z0-9-]+$/.test(id))throw new AppError('Invalid job ID');
  const active=this.active.get(id);if(active?.job.projectId===projectId)return structuredClone(active.job);
  try{return JSON.parse(await readFile(join(this.store.projectDir(projectId),'jobs',id+'.json'),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('Job not found',404);throw error;}
 }
 private async persist(job:AgentJob){await this.store.saveJob(job);this.emit('notification',job.projectId,{type:'job',jobId:job.id,status:job.status});}
 private event(job:AgentJob,message:string){
  job.events.push({time:new Date().toISOString(),message:message.slice(0,12000)});
  job.events=job.events.slice(-300);
  this.emit('notification',job.projectId,{type:'job-progress',jobId:job.id,message});
 }
 async create(projectId:string,raw:unknown):Promise<AgentJob>{
  if(this.closed)throw new AppError('Agent service is closed.');
  if(Array.from(this.active.values()).some(a=>a.job.projectId===projectId&&['preparing','running'].includes(a.job.status)))throw new AppError('A task is already running for this project.',409);
  const input=TaskSchema.parse(raw);
  for(const scope of input.scope)if(scope!=='.'&&(isAbsolute(scope)||scope.split(/[\\/]/).includes('..')||scope.includes('\0')))throw new AppError('Unsafe task scope');
  if(input.settings.provider!=='hosted'&&!input.settings.model)throw new AppError('Choose an installed local model before starting.');
  if(!await sandboxAvailable())throw new AppError('Bubblewrap is unavailable. Export a package and import results instead.');
  await this.sync.request(projectId);
  const p=await this.store.get(projectId);
  if(p.analysis?.status==='stale')throw new AppError('Fix source analysis errors before starting an agent task.');
  const id=randomUUID();
  const job:AgentJob={id,projectId,kind:input.kind,status:'preparing',createdAt:new Date().toISOString(),specRevision:p.specRevision,sourceHashes:{},task:input.task,scope:input.scope,workspace:join(this.store.projectDir(projectId),'runs',id,'source'),events:[]};
  await this.persist(job);
  const active:Active={job,done:Promise.resolve()};this.active.set(id,active);
  active.done=this.execute(p,job,input.settings,active).catch(async error=>{
   if(job.status!=='cancelled'){job.status='failed';job.error=(error as Error).message;this.event(job,job.error);await this.persist(job);}
  });
  return structuredClone(job);
 }
 private async prepare(p:Project,job:AgentJob){
  job.sourceHashes=await copySnapshot(p.root,job.workspace);
  try{await access(join(p.root,'node_modules'));await symlink(join(p.root,'node_modules'),join(job.workspace,'node_modules'),'dir');}catch{}
  const bundle=join(job.workspace,'_architect');await mkdir(bundle,{recursive:true});
  for(const [path,text]of Object.entries(bundleFiles(p,job.task,job.scope)))await writeFile(join(bundle,path),text,{mode:0o600});
  return bundle;
 }
 private async execute(p:Project,job:AgentJob,settings:z.infer<typeof SettingsSchema>,active:Active){
  const bundle=await this.prepare(p,job);
  if(job.status==='cancelled')return;
  const state=join(dirname(job.workspace),'agent-state');await mkdir(state,{recursive:true});
  const codexHome=process.env.CODEX_HOME||join(homedir(),'.codex');
  try{await copyFile(join(codexHome,'auth.json'),join(state,'auth.json'));}catch{}
  const worker=new AnalysisWorker();
  let previewGeneration=0;let previewTimer:ReturnType<typeof setTimeout>|undefined;
  const watcher=chokidar.watch(job.workspace,{ignoreInitial:true,ignored:(path)=>path.split('/').some(part=>ignoredDirs.has(part)||excluded(part)),awaitWriteFinish:{stabilityThreshold:150,pollInterval:50}});
  const preview=async()=>{
   const generation=++previewGeneration;
   try{const analysis=await worker.analyze(job.workspace);if(generation===previewGeneration&&job.status==='running'){job.preview=analysis;this.emit('notification',job.projectId,{type:'preview',jobId:job.id});}}
   catch(error){this.event(job,'Preview analysis: '+(error as Error).message);}
  };
  watcher.on('all',()=>{clearTimeout(previewTimer);previewTimer=setTimeout(()=>void preview(),300);});
  watcher.on('error',error=>this.event(job,'Preview watcher: '+String(error)));
  try{
   const args=[...(this.runner.prefixArgs||[]),'-a','never','exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','-C',job.workspace,'-s',job.kind==='design'?'read-only':'workspace-write'];
   if(settings.model)args.push('-m',settings.model);
   if(settings.provider!=='hosted')args.push('--oss','--local-provider',settings.provider);
   let task=await readFile(join(bundle,'AGENT_TASK.md'),'utf8');
   if(job.kind==='design'){
    const schemaPath=join(bundle,'proposal-schema.json');
    const schema={type:'object',additionalProperties:false,required:['graph','explanation','questions'],properties:{graph:z.toJSONSchema(GraphSchema,{unrepresentable:'any'}),explanation:{type:'string'},questions:{type:'array',items:{type:'string'}}}};
    await atomicJson(schemaPath,schema);
    args.push('--output-schema',schemaPath,'-o',join(bundle,'proposal.json'));
    task='Propose a revised specification for this request: '+job.task+'\nRead _architect/specification.json. Return a complete proposed graph with explanation and questions. Preserve all policies, protection baselines, source bindings, and protected specification nodes. Do not modify project code.';
   }
   args.push('-');
   job.status='running';await this.persist(job);
   const result=await runSandbox(this.runner.executable||'codex',args,job.workspace,{writable:true,network:true,input:task,timeoutMs:settings.timeoutMinutes*60000,
    env:{...process.env,CODEX_HOME:state,TMPDIR:'/tmp'},
    onProcess:child=>{active.child=child;},
    onOutput:text=>this.event(job,text),
   });
   if(active.job.status==='cancelled')return;
   if(result.code!==0)throw new Error('Agent exited with status '+result.code+'. '+result.output.slice(-3000));
   clearTimeout(previewTimer);await watcher.close();
   if(job.kind==='design'){
    const proposal=ProposalSchema.parse(JSON.parse(await readFile(join(bundle,'proposal.json'),'utf8')));
    this.checkProposal(p,proposal.graph);
    job.proposal=proposal;job.status='review';
   }else{
    await this.validate(p,job,worker);job.status='review';
   }
   await this.persist(job);
  }finally{clearTimeout(previewTimer);await watcher.close();await worker.close();await rm(state,{recursive:true,force:true});active.child=undefined;}
 }
 private checkProposal(p:Project,graph:Graph){
  for(const node of p.specification.nodes){
   const next=graph.nodes.find(n=>n.id===node.id);
   if(node.policy.startsWith('frozen')&&JSON.stringify(node)!==JSON.stringify(next))throw new AppError('AI proposal changes a protected specification item: '+node.name);
   if(next&&(next.policy!==node.policy||JSON.stringify(next.baseline)!==JSON.stringify(node.baseline)||JSON.stringify(next.source)!==JSON.stringify(node.source)))throw new AppError('AI proposal changes policies, baselines, or source bindings: '+node.name);
  }
  for(const node of graph.nodes)if(!p.specification.nodes.some(n=>n.id===node.id)&&(node.policy!=='editable'||node.baseline||node.source))throw new AppError('New AI nodes cannot establish protection baselines or source evidence.');
 }
 async acceptProposal(projectId:string,id:string){
  const job=await this.get(projectId,id);const p=await this.store.get(projectId);
  if(job.status!=='review'||!job.proposal)throw new AppError('No design proposal is ready for review.');
  if(p.specRevision!==job.specRevision)throw new AppError('Specification changed. Request a fresh proposal.',409);
  this.checkProposal(p,job.proposal.graph);
  const graph=structuredClone(job.proposal.graph);
  for(const node of graph.nodes){const old=p.specification.nodes.find(n=>n.id===node.id);if(JSON.stringify(node)!==JSON.stringify(old))node.provenance='ai';}
  const updated=await this.store.updateSpec(projectId,job.specRevision,graph);
  job.status='applied';await this.persist(job);return updated;
 }
 private async validate(p:Project,job:AgentJob,worker:AnalysisWorker){
  const report=await validateCandidate(p,job);
  const startHashes=hashes(await captureFiles(job.workspace));
  const required=new Set(p.specification.nodes.flatMap(n=>n.requiredChecks));
  for(const id of required){
   const check=p.checks[id];if(!check)continue;
   try{
    const result=await runSandbox(check.command,check.args,job.workspace,{writable:true,network:false,timeoutMs:120000,env:{PATH:process.env.PATH,HOME:dirname(job.workspace),LANG:'C.UTF-8',TMPDIR:'/tmp',CI:'1',NODE_ENV:'test'}});
    report.checks[id]={passed:result.code===0,output:result.output};
    if(result.code!==0)report.issues.push({code:'required-check',message:'Required check failed: '+id});
   }catch(error){report.checks[id]={passed:false,output:(error as Error).message};report.issues.push({code:'required-check',message:'Required check could not run: '+id});}
  }
  if(JSON.stringify(startHashes)!==JSON.stringify(hashes(await captureFiles(job.workspace))))report.issues.push({code:'check-mutated-source',message:'Validation checks changed included project files. Review a new result.'});
  if(report.candidate?.quality.prismaValidation==='unavailable'){
   const command=join(job.workspace,'node_modules','.bin','prisma');
   try{
    await access(command);
    const result=await runSandbox(command,['validate'],job.workspace,{writable:true,network:false,timeoutMs:30000,env:{PATH:process.env.PATH,HOME:dirname(job.workspace),TMPDIR:'/tmp',CI:'1'}});
    report.candidate.quality.prismaValidation=result.code===0?'passed':'failed';
    report.checks['prisma-schema']={passed:result.code===0,output:result.output};
    if(result.code!==0)report.issues.push({code:'prisma-validation',message:'Project-version Prisma validation failed.'});
   }catch{this.event(job,'Project-version Prisma validation is unavailable.');}
  }
  report.passed=report.issues.length===0;
  job.report=report;job.preview=report.candidate;
 }
 async importResult(projectId:string,path:string,scope:string[],task='Review imported agent results'){
  const p=await this.store.get(projectId);const id=randomUUID();
  const job:AgentJob={id,projectId,kind:'import',status:'preparing',createdAt:new Date().toISOString(),specRevision:p.specRevision,sourceHashes:hashes(await captureFiles(p.root)),task,scope,workspace:join(this.store.projectDir(projectId),'runs',id,'source'),events:[]};
  await copySnapshot(resolve(path),job.workspace);
  try{await access(join(p.root,'node_modules'));await symlink(join(p.root,'node_modules'),join(job.workspace,'node_modules'),'dir');}catch{}
  const worker=new AnalysisWorker();
  try{await this.validate(p,job,worker);job.status='review';await this.persist(job);return job;}
  finally{await worker.close();}
 }
 async apply(projectId:string,id:string){
  const job=await this.get(projectId,id);await applyReviewed(this.store,job);
  const active=this.active.get(id);if(active)active.job=job;
  this.emit('notification',projectId,{type:'job',jobId:id,status:'applied'});await this.sync.request(projectId);return job;
 }
 async cancel(projectId:string,id:string){
  const job=await this.get(projectId,id);
  if(job.status==='applied')throw new AppError('Applied jobs cannot be cancelled.');
  const active=this.active.get(id);if(active?.child?.pid)try{process.kill(-active.child.pid,'SIGTERM');}catch{}
  job.status='cancelled';if(active)active.job.status='cancelled';await this.persist(job);return job;
 }
 async close(){
  this.closed=true;
  for(const active of this.active.values())if(['preparing','running'].includes(active.job.status))await this.cancel(active.job.projectId,active.job.id);
  await Promise.allSettled(Array.from(this.active.values()).map(a=>a.done));this.active.clear();
 }
}
