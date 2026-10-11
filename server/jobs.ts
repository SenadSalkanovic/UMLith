import {EventEmitter} from 'node:events';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,rm,symlink,access,realpath,chmod} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import type {ChildProcess} from 'node:child_process';
import chokidar from 'chokidar';
import {z} from 'zod';
import {GraphSchema,DesignProposalSchema,getProposalBaseRevision,type AgentJob,type Project,type Graph,type DesignProposal} from '../shared/model';
import {validateProposal,computeSpecificationDiff} from './proposals';
import {ProposalReviewResponseSchema,type ProposalReviewResponse} from '../shared/api';
import {ProjectStore,SpecificationConflictError} from './store';
import {SyncService} from './sync';
import {bundleFiles} from './export';
import {AppError,captureFiles,captureSourceRevision,hashes,fileModes,atomicJson,ignoredDirs,excluded,isPathExcluded,safePath} from './files';
import {validateCandidate,applyReviewed,inScope} from './review';
import {runSandbox,sandboxAvailable,stopSandbox} from './sandbox';
import {AnalysisWorker} from './worker';
import {CodexProgress,verifyCodex} from './agents/codex';
export {validateProposal};
export const SettingsSchema=z.object({provider:z.enum(['hosted','ollama','lmstudio']).default('hosted'),model:z.string().min(1).max(2000).refine(value=>!!value.trim()).optional(),timeoutMinutes:z.number().min(1).max(120).default(30)}).strict();
const ProjectPath=z.string().min(1).max(4096).refine(path=>!isAbsolute(path)&&!path.includes('\\')&&!path.includes('\0')&&!/^[a-z]:/i.test(path)&&path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!isPathExcluded(path),'Unsafe or excluded project path');
const Scope=z.array(z.string().refine(path=>path==='.'||ProjectPath.safeParse(path.endsWith('/')?path.slice(0,-1):path).success,'Unsafe task scope')).min(1).max(20000);
export const TaskSchema=z.object({task:z.string().min(1).max(30000).refine(value=>!!value.trim()),scope:Scope,settings:SettingsSchema.default({provider:'hosted',timeoutMinutes:30}),kind:z.enum(['implementation','design']).default('implementation')}).strict();
export const ResultImportSchema=z.object({schemaVersion:z.literal(1),handoffId:z.uuid(),projectId:z.string().regex(/^[a-zA-Z0-9-]+$/),specRevision:z.int().nonnegative(),sourceHashes:z.record(ProjectPath,z.string().regex(/^[a-f0-9]{64}$/)),task:TaskSchema.shape.task,scope:Scope,files:z.record(ProjectPath,z.string().max(20*1024*1024).nullable())}).strict();
const TrustedHandoffSchema=ResultImportSchema.omit({schemaVersion:true,files:true});
export const ProposalSchema=DesignProposalSchema;
type Runner={executable?:string;prefixArgs?:string[]};
type Active={job:AgentJob;child?:ChildProcess;done:Promise<void>;abort:AbortController};
export class JobService extends EventEmitter {
 private active=new Map<string,Active>();
 private decisions=new Map<string,Promise<unknown>>();
 private closed=false;
 private writes=new Map<string,Promise<void>>();
 constructor(public store:ProjectStore,public sync:SyncService,private runner:Runner={}){super();}
 async capabilities(){
  const providers=['hosted','ollama','lmstudio'] as const;
  if(!await sandboxAvailable())return {available:false,reason:'Usable Linux Bubblewrap isolation is unavailable. Export a package and import results instead.',providers};
  try{if(!this.runner.executable)await verifyCodex();return {available:true,reason:null,providers};}
  catch(error){return {available:false,reason:(error as Error).message,providers};}
 }
 async list(projectId:string){return (await this.store.jobs(projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async recover(){
  for(const project of await this.store.list())for(const job of await this.store.jobs(project.id))if(job.status==='preparing'||job.status==='running'){
   job.status='failed';job.error='Service restarted before this job completed. Original files were not applied.';this.event(job,job.error,'recovery');await this.persist(job);
  }
 }
 async get(projectId:string,id:string):Promise<AgentJob>{
  if(!/^[a-zA-Z0-9-]+$/.test(id))throw new AppError('Invalid job ID');
  const active=this.active.get(id);if(active?.job.projectId===projectId)return structuredClone(active.job);
  try{const job=JSON.parse(await readFile(join(this.store.projectDir(projectId),'jobs',id+'.json'),'utf8')) as AgentJob;
   if(job.id!==id||job.projectId!==projectId||!['implementation','design','import'].includes(job.kind)||!['preparing','running','review','failed','cancelled','applied'].includes(job.status)||resolve(job.workspace)!==resolve(this.store.projectDir(projectId),'runs',id,'source')||job.baseline&&resolve(job.baseline)!==resolve(this.store.projectDir(projectId),'runs',id,'baseline'))throw new AppError('Invalid persisted job record.',500);
   return job;
  }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('Job not found',404);throw error;}
 }
 private async persist(job:AgentJob){
  const snapshot=structuredClone(job);const previous=this.writes.get(job.id)||Promise.resolve();
  const write=previous.catch(()=>{}).then(()=>this.store.saveJob(snapshot));this.writes.set(job.id,write);
  try{await write;this.emit('notification',job.projectId,{type:'job',jobId:job.id,status:snapshot.status});}finally{if(this.writes.get(job.id)===write)this.writes.delete(job.id);}
 }
 private event(job:AgentJob,message:string,type='progress',data?:unknown,stream?:'stdout'|'stderr'){
  job.events.push({time:new Date().toISOString(),message:message.slice(0,12000),type,data,stream});
  job.events=job.events.slice(-300);
  this.emit('notification',job.projectId,{type:'job-progress',jobId:job.id,message:message.slice(0,12000),event:job.events.at(-1)});
  void this.persist(job).catch(error=>{job.error='Progress persistence failed: '+(error as Error).message;});
 }
 async create(projectId:string,raw:unknown):Promise<AgentJob>{
  return this.decide(projectId,()=>this.createJob(projectId,raw));
 }
 private async createJob(projectId:string,raw:unknown):Promise<AgentJob>{
  if(this.closed)throw new AppError('Agent service is closed.');
  if(Array.from(this.active.values()).some(a=>a.job.projectId===projectId&&['preparing','running'].includes(a.job.status)))throw new AppError('A task is already running for this project.',409);
  const input=TaskSchema.parse(raw);
  if(input.settings.provider!=='hosted'&&!input.settings.model)throw new AppError('Choose an installed local model before starting.');
  const capabilities=await this.capabilities();if(!capabilities.available)throw new AppError(capabilities.reason!);
  await this.sync.request(projectId);
  const p=await this.store.get(projectId);
  if(p.analysis?.status==='stale')throw new AppError('Fix source analysis errors before starting an agent task.');
  const captured=await captureSourceRevision(p.root);
  if(captured.incomplete)throw new AppError('Source changed while fixing the task baseline. Try again.',409);
  if(p.analysis?.revision&&p.analysis.revision!==captured.revision)throw new AppError('Source changed since analysis. Rescan before starting this task.',409);
  const id=randomUUID();
  const run=join(this.store.projectDir(projectId),'runs',id);
  if(this.closed)throw new AppError('Agent service is closed.');
  const job:AgentJob={id,projectId,kind:input.kind,status:'preparing',createdAt:new Date().toISOString(),specRevision:p.specRevision,sourceRevision:p.analysis?.revision,sourceHashes:{...captured.hashes},sourceModes:{...fileModes(captured.files)},checkDefinitions:structuredClone(p.checks),settings:input.settings,task:input.task,scope:input.scope,workspace:join(run,'source'),baseline:join(run,'baseline'),events:[]};
  await this.persist(job);
  if(this.closed){job.status='cancelled';this.event(job,'Service shut down before execution started.','cancelled');await this.persist(job);throw new AppError('Agent service is closed.');}
  const active:Active={job,done:Promise.resolve(),abort:new AbortController()};this.active.set(id,active);
  active.done=this.execute(p,job,input.settings,active).catch(async error=>{
   if(job.status!=='cancelled'){job.status='failed';job.error=(error as Error).message;this.event(job,job.error);await this.persist(job);}
  }).finally(()=>this.active.delete(id));
  return structuredClone(job);
 }
 private async prepare(p:Project,job:AgentJob){
  const captured=await captureSourceRevision(p.root);
  if(captured.incomplete)throw new AppError('Source changed while capturing this task. Try again.',409);
  if(!isDeepStrictEqual({...captured.hashes},job.sourceHashes))throw new AppError('Task source hashes no longer match the original files.',409);
  const modes={...fileModes(captured.files)};
  if(job.sourceModes&&!isDeepStrictEqual(modes,job.sourceModes))throw new AppError('Original file permissions changed before snapshot preparation.',409);
  job.sourceHashes={...captured.hashes};
  job.sourceModes=modes;
  await mkdir(job.workspace,{recursive:true,mode:0o700});await mkdir(job.baseline!,{recursive:true,mode:0o700});
  for(const [path,content] of Object.entries(captured.files))for(const root of [job.baseline!,job.workspace]){
   if(job.status==='cancelled')throw new AppError('Snapshot preparation cancelled.');
   const target=await safePath(root,path);await mkdir(dirname(target),{recursive:true});const mode=modes[path]&0o777;await writeFile(target,content,{mode});await chmod(target,mode);
  }
  const fresh=await this.store.get(p.id);
  const latest=await captureSourceRevision(p.root);
  if(latest.incomplete||fresh.specRevision!==job.specRevision||!isDeepStrictEqual({...latest.hashes},job.sourceHashes)||!isDeepStrictEqual({...fileModes(latest.files)},modes))throw new AppError('Source, permissions, or specification changed during snapshot preparation. Try again.',409);
  try{await access(join(p.root,'node_modules'));await symlink(join(p.root,'node_modules'),join(job.workspace,'node_modules'),'dir');}catch{}
  const bundle=join(job.workspace,'_architect');await mkdir(bundle,{recursive:true});
  for(const [path,text]of Object.entries(bundleFiles(p,job.task,job.scope)))await writeFile(join(bundle,path),text,{mode:0o600});
  this.event(job,'Captured original source and separate writable candidate.','prepared');await this.persist(job);
  return bundle;
 }
 private async execute(p:Project,job:AgentJob,settings:z.infer<typeof SettingsSchema>,active:Active){
  const bundle=await this.prepare(p,job);
  if(job.status==='cancelled')return;
  const state=join(dirname(job.workspace),'agent-state');await mkdir(state,{recursive:true,mode:0o700});
  const codexHome=process.env.CODEX_HOME||join(homedir(),'.codex');
  if(settings.provider==='hosted')try{await copyFile(join(codexHome,'auth.json'),join(state,'auth.json'));await chmod(join(state,'auth.json'),0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){await rm(state,{recursive:true,force:true});throw error;}}
  const worker=new AnalysisWorker();
  let previewGeneration=0;let previewTimer:ReturnType<typeof setTimeout>|undefined;
  const watcher=chokidar.watch(job.workspace,{ignoreInitial:true,ignored:(path)=>path.split('/').some(part=>ignoredDirs.has(part)||excluded(part)),awaitWriteFinish:{stabilityThreshold:150,pollInterval:50}});
  const preview=async()=>{
   const generation=++previewGeneration;
   try{const analysis=await worker.analyze(job.workspace);if(generation===previewGeneration&&job.status==='running'){job.preview=analysis;await this.persist(job);this.emit('notification',job.projectId,{type:'preview',jobId:job.id});}}
   catch(error){if(generation!==previewGeneration||job.status!=='running')return;if(job.preview)job.preview={...job.preview,status:'stale',staleEvidence:{scope:'all',paths:[],reason:'Preview analysis failed: '+(error as Error).message}};this.event(job,'Preview analysis: '+(error as Error).message,'preview-error');}
  };
  watcher.on('all',()=>{++previewGeneration;if(job.preview)job.preview={...job.preview,status:'updating'};clearTimeout(previewTimer);previewTimer=setTimeout(()=>void preview(),300);});
  watcher.on('error',error=>this.event(job,'Preview watcher: '+String(error)));
  try{
   const args=[...(this.runner.prefixArgs||[]),'-a','never','exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','-C',job.workspace,'-s',job.kind==='design'?'read-only':'workspace-write'];
   if(settings.model)args.push('-m',settings.model);
   if(settings.provider!=='hosted')args.push('--oss','--local-provider',settings.provider);
   let task=await readFile(join(bundle,'AGENT_TASK.md'),'utf8');
   if(job.kind==='design'){
    const schemaPath=join(bundle,'proposal-schema.json');
    const schema={type:'object',additionalProperties:false,required:['graph','explanation','questions'],properties:{schemaVersion:{type:'integer'},graph:z.toJSONSchema(GraphSchema,{unrepresentable:'any'}),explanation:{type:'string'},questions:{type:'array',items:{type:'string'}},sourceRevision:{type:'string'},baseRevision:{type:'integer'},intendedBaseRevision:{type:'integer'}}};
    await atomicJson(schemaPath,schema);
    args.push('--output-schema',schemaPath,'-o',join(bundle,'proposal.json'));
    task='Propose a revised specification for this request: '+job.task+'\nRead _architect/specification.json. Return a complete proposed graph with explanation, questions, and baseRevision matching the specification revision ('+p.specRevision+'). Preserve all policies, protection baselines, source bindings, and protected specification nodes. Do not modify project code.';
   }
   args.push('-');
   if(active.abort.signal.aborted)return;
   const progress=new CodexProgress((message,type,data)=>this.event(job,message,type,data,'stdout'));
   job.status='running';await this.persist(job);
   const result=await runSandbox(this.runner.executable||'codex',args,job.workspace,{writable:true,network:true,input:task,timeoutMs:settings.timeoutMinutes*60000,
    env:{PATH:process.env.PATH,LANG:'C.UTF-8',CODEX_HOME:'/tmp/codex-home',TMPDIR:'/tmp'},state,hiddenPaths:[p.root,this.store.dir],dependencyRoot:join(p.root,'node_modules'),readonlyFiles:(this.runner.prefixArgs||[]).filter(arg=>isAbsolute(arg)),signal:active.abort.signal,
    onProcess:child=>{active.child=child;},
    onOutput:(text,stream)=>stream==='stderr'?this.event(job,text,'stderr',undefined,'stderr'):progress.push(text),
   });
   progress.finish();if(active.job.status==='cancelled')return;
   if(result.code!==0)throw new Error('Agent exited with status '+result.code+'. '+result.output.slice(-3000));
   if(progress.error)throw new Error(progress.error);
   clearTimeout(previewTimer);await watcher.close();
   if(job.kind==='design'){
    let raw: unknown;
    try {
     raw = JSON.parse(await readFile(join(bundle,'proposal.json'),'utf8'));
    } catch (err) {
     throw new AppError('Malformed proposal JSON: ' + (err as Error).message);
    }
    const report = validateProposal(p, raw, { scope: job.scope, specRevision: job.specRevision });
    if (!report.valid) {
     const firstError = report.diagnostics.find(d => d.severity === 'error')?.message || 'Proposal validation failed';
     throw new AppError(firstError);
    }
    job.proposal = report.proposal!;
    job.status = 'review';
   }else{
    await this.validate(p,job,active);if(active.abort.signal.aborted)return;job.status='review';
   }
   await this.persist(job);
  }finally{clearTimeout(previewTimer);await watcher.close();await worker.close();await rm(state,{recursive:true,force:true});active.child=undefined;}
 }
 async getProposalReview(projectId:string,id:string):Promise<ProposalReviewResponse>{
  const job=await this.get(projectId,id);const p=await this.store.get(projectId);
  if(job.kind!=='design'||!job.proposal)throw new AppError('Design proposal not found',404);
  const proposal=DesignProposalSchema.parse(job.proposal);
  const report=validateProposal(p,proposal,{scope:job.scope,specRevision:job.specRevision});
  // Preview exactly the AI attribution that acceptance will persist.
  for(const node of proposal.graph.nodes)if(!isDeepStrictEqual(node,p.specification.nodes.find(n=>n.id===node.id)))node.provenance='ai';
  for(const edge of proposal.graph.edges)if(!isDeepStrictEqual(edge,p.specification.edges.find(e=>e.id===edge.id))){edge.provenance='ai';edge.uncertain=true;}
  return ProposalReviewResponseSchema.parse({id:job.id,task:job.task,createdAt:job.createdAt,status:job.status,specRevision:job.specRevision,
   proposal,diff:computeSpecificationDiff(p.specification,proposal.graph,{explanation:proposal.explanation}),valid:report.valid,diagnostics:report.diagnostics});
 }
 private async decide<T>(projectId:string,fn:()=>Promise<T>):Promise<T>{
  const previous=this.decisions.get(projectId)||Promise.resolve();
  const decision=previous.catch(()=>{}).then(fn);this.decisions.set(projectId,decision);
  try{return await decision;}finally{if(this.decisions.get(projectId)===decision)this.decisions.delete(projectId);}
 }
 async acceptProposal(projectId:string,id:string,expectedRevision?:number){
  return this.decide(projectId,async()=>{
  const job=await this.get(projectId,id);const p=await this.store.get(projectId);
  if(job.kind!=='design'||job.status!=='review'||!job.proposal)throw new AppError('No design proposal is ready for review.',409);
  const expected=expectedRevision??job.specRevision;
  const baseRev = getProposalBaseRevision(job.proposal);
  if(expected!==p.specRevision||expected!==job.specRevision||(baseRev!==undefined&&baseRev!==p.specRevision)){
   const conflict=new SpecificationConflictError(projectId,expected,p.specRevision);
   conflict.message='Specification changed. Request a fresh proposal. '+conflict.message;
   throw conflict;
  }
  const review=await this.getProposalReview(projectId,id);
  if(!review.valid)throw new AppError(review.diagnostics.find(d=>d.severity==='error')?.message||'Proposal validation failed');
  const updated=await this.store.updateSpec(projectId,expected,review.proposal.graph);
  job.status='applied';
  this.event(job,`Human accepted proposal: specification revision ${expected} → ${updated.specRevision}.`);
  const active=this.active.get(id);if(active)active.job=job;
  await this.persist(job);return updated;
  });
 }
 async rejectProposal(projectId:string,id:string){
  return this.decide(projectId,async()=>{
   const job=await this.get(projectId,id);
   if(job.kind!=='design'||job.status!=='review'||!job.proposal)throw new AppError('No design proposal is ready for review.',409);
   job.status='cancelled';this.event(job,'Human rejected proposal without changing the specification.');
   const active=this.active.get(id);if(active)active.job=job;
   await this.persist(job);
  });
 }
 private async validate(p:Project,job:AgentJob,active?:Active){
  const startingRevision=await captureSourceRevision(job.workspace);
  const startHashes={...startingRevision.hashes};
  const startModes={...fileModes(startingRevision.files)};
  const report=await validateCandidate(p,job,{signal:active?.abort.signal,onProcess:(child:ChildProcess)=>{if(active)active.child=child;}});
  job.checkDefinitions=structuredClone(p.checks);
  const required=new Set([...Object.keys(p.checks),...p.specification.nodes.flatMap(n=>n.requiredChecks)]);
  for(const id of required){
   const check=p.checks[id];if(!check)continue;
   if(active?.abort.signal.aborted)throw new AppError('Validation cancelled.');
   this.event(job,'Running required check: '+id,'check-started');
   let candidateRevision=startingRevision.revision;
   try{
    const invocation=await captureSourceRevision(job.workspace);if(invocation.incomplete)throw new AppError('Candidate changed while preparing required check: '+id);candidateRevision=invocation.revision;
    const result=await runSandbox(check.command,check.args,job.workspace,{writable:true,network:false,timeoutMs:120000,hiddenPaths:[p.root,this.store.dir],dependencyRoot:join(p.root,'node_modules'),signal:active?.abort.signal,
     env:{PATH:process.env.PATH,LANG:'C.UTF-8',CI:'1',NODE_ENV:'test'},onProcess:child=>{if(active)active.child=child;},onOutput:(text,stream)=>this.event(job,text,'check-output',{checkId:id},stream)});
    report.checks[id]={passed:result.code===0,output:result.output,command:check.command,args:[...check.args],candidateRevision};
    if(result.code!==0)report.issues.push({code:'required-check',message:'Required check failed: '+id});
   }catch(error){report.checks[id]={passed:false,output:(error as Error).message,command:check.command,args:[...check.args],candidateRevision};report.issues.push({code:'required-check',message:'Required check could not run: '+id});}
   this.event(job,'Required check '+id+': '+(report.checks[id].passed?'passed':'failed'),'check-completed',{checkId:id,passed:report.checks[id].passed});
  }
  const endFiles=await captureFiles(job.workspace);const endHashes=hashes(endFiles);const endModes={...fileModes(endFiles)};
  if(!isDeepStrictEqual(startHashes,endHashes)||!isDeepStrictEqual(startModes,endModes))report.issues.push({code:'check-mutated-source',message:'Analysis or required checks changed included candidate files or permissions. Revalidate and review the new result.'});
  const changedPrisma=report.changes.some(change=>change.path.endsWith('.prisma')||/(^|\/)prisma\.config\.[^/]+$/.test(change.path));
  if(changedPrisma&&report.candidate?.quality.prismaValidation!=='passed')report.issues.push({code:'prisma-validation',message:'Changed Prisma definitions require successful isolated project-version semantic validation.'});
  report.candidateHashes=endHashes;report.candidateModes=endModes;report.passed=report.issues.length===0;
  job.report=report;job.preview=report.candidate;
 }
 async importResult(projectId:string,raw:unknown){
  return this.decide(projectId,async()=>{
   if(this.closed)throw new AppError('Agent service is closed.');
   const input=ResultImportSchema.parse(raw);
   if(input.projectId!==projectId)throw new AppError('Result belongs to a different project.');
   let trusted:z.infer<typeof TrustedHandoffSchema>;
   try{trusted=TrustedHandoffSchema.parse(JSON.parse(await readFile(join(this.store.projectDir(projectId),'handoffs',input.handoffId+'.json'),'utf8')));}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('Unknown handoff ID. Export an approved handoff before importing results.');throw new AppError('The saved handoff record is invalid.',500);}
   const {schemaVersion:_,files:__,...metadata}=input;
   if(!isDeepStrictEqual(metadata,trusted))throw new AppError('Result metadata or scope differs from the approved handoff.',409);
   if(Object.keys(input.files).length>20000||Object.keys(input.sourceHashes).length>20000)throw new AppError('Result exceeds 20,000 included files.');
   const p=await this.store.get(projectId);
   if(p.specRevision!==input.specRevision)throw new AppError('Specification changed since this result was exported.',409);
   const baseline=await captureSourceRevision(p.root);
   if(baseline.incomplete||!isDeepStrictEqual({...baseline.hashes},input.sourceHashes))throw new AppError('Original source differs from the exported result baseline.',409);
   for(const path of Object.keys(input.files)){
    if(!inScope(path,trusted.scope))throw new AppError('Imported file is outside the approved scope: '+path);
    if(input.files[path]!==null&&Buffer.byteLength(input.files[path]!)>20*1024*1024)throw new AppError('Imported file exceeds 20 MB: '+path);
    await safePath(p.root,path);
   }
   const id=randomUUID();const run=join(this.store.projectDir(projectId),'runs',id);
   if(this.closed)throw new AppError('Agent service is closed.');
   const job:AgentJob={id,projectId,kind:'import',status:'preparing',createdAt:new Date().toISOString(),specRevision:trusted.specRevision,sourceRevision:p.analysis?.revision,sourceHashes:trusted.sourceHashes,sourceModes:{...fileModes(baseline.files)},checkDefinitions:structuredClone(p.checks),task:trusted.task,scope:trusted.scope,workspace:join(run,'source'),baseline:join(run,'baseline'),events:[]};
   const active:Active={job,done:Promise.resolve(),abort:new AbortController()};this.active.set(id,active);await this.persist(job);
   const operation=async()=>{
    try{
     await this.prepare(p,job);
     for(const [path,text] of Object.entries(input.files)){
      if(active.abort.signal.aborted)throw new AppError('Import cancelled.');
      const target=await safePath(job.workspace,path);if(text===null)await rm(target,{force:true});else{await mkdir(dirname(target),{recursive:true});await writeFile(target,text,{mode:0o600});}
     }
     await this.validate(p,job,active);
     if(active.abort.signal.aborted)throw new AppError('Import cancelled.');
     job.status='review';this.event(job,'Imported candidate ready for human review.','review-ready');await this.persist(job);return structuredClone(job);
    }catch(error){if(job.status!=='cancelled'){job.status='failed';job.error=(error as Error).message;this.event(job,job.error,'failed');await this.persist(job);}throw error;}
    finally{this.active.delete(id);}
   };
   const pending=operation();active.done=pending.then(()=>{},()=>{});return pending;
  });
 }
 async revalidate(projectId:string,id:string){
  return this.decide(projectId,async()=>{
   const job=await this.get(projectId,id);
   if(job.status!=='review'||job.kind==='design')throw new AppError('Only a candidate awaiting review can be revalidated.',409);
   const p=await this.store.get(projectId);if(this.closed)throw new AppError('Agent service is closed.');const active:Active={job,done:Promise.resolve(),abort:new AbortController()};this.active.set(id,active);
   const pending=(async()=>{try{await this.validate(p,job,active);await this.persist(job);return structuredClone(job);}finally{this.active.delete(id);}})();
   active.done=pending.then(()=>{},()=>{});return pending;
  });
 }
 async apply(projectId:string,id:string){
  return this.decide(projectId,async()=>{
   const job=await this.get(projectId,id);await applyReviewed(this.store,job);
   this.emit('notification',projectId,{type:'job',jobId:id,status:'applied'});await this.sync.request(projectId);return job;
  });
 }
 async cancel(projectId:string,id:string){
  const cancel=async()=>{
   const job=await this.get(projectId,id);
   if(!['preparing','running','review'].includes(job.status))throw new AppError('This job cannot be cancelled from its current state.',409);
   const active=this.active.get(id);active?.abort.abort();if(active?.child)stopSandbox(active.child);
   job.status='cancelled';if(active)active.job.status='cancelled';this.event(job,'Human cancelled or rejected this job.','cancelled');await this.persist(job);return job;
  };
  // Active validation must be interruptible while its decision owns the queue.
  return this.active.has(id)?cancel():this.decide(projectId,cancel);
 }
 async close(){
  this.closed=true;
  for(const active of this.active.values())if(['preparing','running','review'].includes(active.job.status))await this.cancel(active.job.projectId,active.job.id);
  await Promise.allSettled(Array.from(this.active.values()).map(a=>a.done));await Promise.allSettled(this.decisions.values());await Promise.allSettled(this.writes.values());this.active.clear();
 }
}
