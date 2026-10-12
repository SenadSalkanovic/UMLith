import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {GraphSchema,type AgentJob,type FileChange} from '../shared/model';
import {ProjectStore} from './store';
import {AppError,atomicJson,captureFiles,fileModes,hashes,replaceProjectFile,safePath} from './files';
import {validateCandidate} from './review';

const ChangeSchema=z.object({path:z.string().min(1),kind:z.enum(['added','modified','deleted']),before:z.string().nullable(),after:z.string().nullable(),diff:z.string(),encoding:z.enum(['utf8','base64']).optional(),beforeMode:z.number().int().min(0).max(0o777).nullable().optional(),afterMode:z.number().int().min(0).max(0o777).nullable().optional()}).strict();
const JournalSchema=z.object({schemaVersion:z.literal(1).optional(),state:z.enum(['applying','committed','rolled-back','conflict']),root:z.string(),changes:z.array(ChangeSchema),jobId:z.string().regex(/^[a-zA-Z0-9-]+$/),completed:z.number().int().nonnegative().optional()}).strict();
type Journal=z.infer<typeof JournalSchema>;
const bytes=(change:FileChange,side:'before'|'after')=>change[side]===null?null:Buffer.from(change[side]!,change.encoding||'utf8');

async function journals(store:ProjectStore,projectId:string){
 const directory=join(store.projectDir(projectId),'recovery');
 let entries:string[]=[];
 try{entries=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return entries.filter(file=>file.endsWith('.json')).map(file=>join(directory,file));
}
export async function recoveryStatus(store:ProjectStore,projectId:string){
 const project=await store.get(projectId);const conflicts:string[]=[];
 for(const path of await journals(store,projectId)){
  let journal:Journal;
  try{journal=JournalSchema.parse(JSON.parse(await readFile(path,'utf8')));}catch{conflicts.push('Unreadable recovery journal: '+path.split('/').at(-1));continue;}
  if(journal.root!==project.root)throw new AppError('Recovery root no longer matches the registered project',409);
  if(journal.state==='conflict'||journal.state==='applying')conflicts.push(journal.jobId);
 }
 return conflicts;
}
async function rollback(journal:Journal){
 let conflict=false;
 for(const change of [...journal.changes].reverse()){
  try{
   const path=await safePath(journal.root,change.path);
   let current:Buffer|null=null;let mode:number|null=null;
   try{mode=(await lstat(path)).mode&0o777;current=await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const old=bytes(change,'before'),proposed=bytes(change,'after');
   if(current===null&&old===null||current&&old&&current.equals(old)&&(change.beforeMode==null||mode===change.beforeMode))continue;
   if(current===null&&proposed===null||current&&proposed&&current.equals(proposed)&&(change.afterMode==null||mode===change.afterMode))await replaceProjectFile(journal.root,change.path,old,proposed,change.beforeMode,change.afterMode);
   else conflict=true;
  }catch{conflict=true;}
 }
 journal.state=conflict?'conflict':'rolled-back';
}
export async function applyReviewed(store:ProjectStore,job:AgentJob){
 return store.transaction(job.projectId,async()=>{
  const project=await store.get(job.projectId);
  const persisted=JSON.parse(await readFile(join(store.projectDir(project.id),'jobs',job.id+'.json'),'utf8')) as AgentJob;
  if(persisted.report?.candidate)persisted.report.candidate={...persisted.report.candidate,graph:GraphSchema.parse(persisted.report.candidate.graph)};
  if(persisted.status!=='review'||!isDeepStrictEqual(persisted.report,job.report===undefined?undefined:JSON.parse(JSON.stringify(job.report))))throw new AppError('Candidate review state changed; refresh the review',409);
  if((await recoveryStatus(store,project.id)).length)throw new AppError('Resolve pending application recovery before applying another candidate',409);
  if(job.status!=='review'||!job.report?.passed)throw new AppError('This candidate has not passed review validation');
  if(!isDeepStrictEqual(project.checks,job.checkDefinitions))throw new AppError('Configured checks changed. Revalidate this candidate.',409);
  const reviewedFiles=await captureFiles(job.workspace);
  if(!job.report.candidateHashes||!job.report.candidateModes||!isDeepStrictEqual(hashes(reviewedFiles),job.report.candidateHashes)||!isDeepStrictEqual(fileModes(reviewedFiles),job.report.candidateModes))throw new AppError('Candidate changed after validation. Revalidate and review it again.',409);
  const fresh=await validateCandidate(project,job);
  if(!fresh.passed)throw new AppError('Candidate no longer passes validation: '+fresh.issues.map(i=>i.message).join('; '),409);
  if(!isDeepStrictEqual(fresh.changes,job.report.changes))throw new AppError('Candidate changed after validation',409);
  for(const id of new Set([...Object.keys(project.checks),...project.specification.nodes.flatMap(node=>node.requiredChecks)]))if(!job.report.checks[id]?.passed)throw new AppError('Required check did not pass: '+id);
  if(fresh.changes.some(change=>change.path.endsWith('.prisma'))&&!job.report.checks['prisma-schema']?.passed&&job.report.candidate?.quality.prismaValidation!=='passed')throw new AppError('Project-version Prisma validation must pass before applying schema changes');
  // Validate every target and captured revision before preparing a durable write-ahead backup.
  for(const change of fresh.changes)await safePath(project.root,change.path);
  const current=await store.get(project.id);
  const sourceFiles=await captureFiles(project.root),candidateFiles=await captureFiles(job.workspace);
  if(current.specRevision!==job.specRevision||!isDeepStrictEqual(hashes(sourceFiles),job.sourceHashes)||job.sourceModes&&!isDeepStrictEqual(fileModes(sourceFiles),job.sourceModes)||!isDeepStrictEqual(hashes(candidateFiles),job.report.candidateHashes)||!isDeepStrictEqual(fileModes(candidateFiles),job.report.candidateModes))throw new AppError('Source, specification, or candidate changed during application preflight',409);
  const path=join(store.projectDir(project.id),'recovery',job.id+'.json');
  const journal:Journal={schemaVersion:1,state:'applying',root:project.root,changes:fresh.changes,jobId:job.id,completed:0};
  await atomicJson(path,journal);
  try{
   for(const change of journal.changes){
    await replaceProjectFile(project.root,change.path,bytes(change,'after'),bytes(change,'before'),change.afterMode,change.beforeMode);
    journal.completed!++;await atomicJson(path,journal);
   }
   journal.state='committed';await atomicJson(path,journal);
  }catch(error){await rollback(journal);await atomicJson(path,journal);throw error;}
  job.status='applied';await store.saveJob(job);
 });
}
export async function recoverPending(store:ProjectStore,projectId?:string){
 const projects=projectId?[await store.get(projectId)]:await store.list();const conflicts:string[]=[];
 for(const project of projects)await store.transaction(project.id,async()=>{
  for(const path of await journals(store,project.id)){
   let journal:Journal;
   try{journal=JournalSchema.parse(JSON.parse(await readFile(path,'utf8')));}catch{conflicts.push(project.name+': unreadable recovery journal');continue;}
   if(journal.root!==project.root){conflicts.push(project.name+': '+journal.jobId);continue;}
   if(journal.state==='applying'||journal.state==='conflict'){
    await rollback(journal);await atomicJson(path,journal);
   }
   if(journal.state==='conflict')conflicts.push(project.name+': '+journal.jobId);
   const jobPath=join(store.projectDir(project.id),'jobs',journal.jobId+'.json');
   try{
    const job=JSON.parse(await readFile(jobPath,'utf8')) as AgentJob;
    if(journal.state==='committed')job.status='applied';
    else if(journal.state==='rolled-back'){job.status='failed';job.error='Interrupted application was rolled back; revalidate before applying.';}
    else job.error='Application recovery conflicts with external source edits';
    await store.saveJob(job);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
 });
 return conflicts;
}
