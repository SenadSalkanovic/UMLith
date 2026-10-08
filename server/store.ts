import {mkdir,readFile,readdir,realpath,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {GraphSchema,emptyGraph,type Project,type GraphInput,type Layout,type Analysis,type AgentJob} from '../shared/model';
import {AppError,atomicJson} from './files';
import {AnalysisWorker} from './worker';
const RevisionSchema=z.int().nonnegative();
const ProjectRecordSchema=z.object({
 id:z.string().regex(/^[a-zA-Z0-9-]+$/),name:z.string(),description:z.string(),target:z.string(),root:z.string(),
 managed:z.boolean(),createdAt:z.iso.datetime({offset:true}),specRevision:RevisionSchema,
 specification:z.unknown(),layout:z.record(z.string(),z.object({x:z.number().finite(),y:z.number().finite()})),
 checks:z.record(z.string(),z.object({command:z.string(),args:z.array(z.string())})),
}).passthrough();
const RevisionRecordSchema=z.object({
 schemaVersion:z.literal(1).default(1),revision:RevisionSchema,createdAt:z.iso.datetime({offset:true}),graph:z.unknown(),
}).strict();
async function readJson(path:string,record:string):Promise<unknown>{
 const text=await readFile(path,'utf8');
 try{return JSON.parse(text);}
 catch(error){throw new SyntaxError('Invalid JSON in '+record,{cause:error});}
}
export class ProjectStore {
 private locks=new Map<string,Promise<unknown>>();
 constructor(public dir:string){}
 projectDir(id:string) {if(!/^[a-zA-Z0-9-]+$/.test(id))throw new AppError('Invalid project ID');return join(this.dir,'projects',id);}
 async transaction<T>(id:string,fn:()=>Promise<T>):Promise<T> {
  const previous=this.locks.get(id)||Promise.resolve();
  const task=previous.catch(()=>{}).then(fn);this.locks.set(id,task);
  try{return await task;}finally{if(this.locks.get(id)===task)this.locks.delete(id);}
 }
 async create(input:{name:string;description?:string;target?:string;root?:string}):Promise<Project> {
  const id=randomUUID();const dir=this.projectDir(id);await mkdir(dir,{recursive:true});
  const root=input.root?await realpath(input.root):join(dir,'source');
  if(input.root&&!(await stat(root)).isDirectory())throw new AppError('Project root must be a directory');
  await mkdir(root,{recursive:true});
  const project:Project={id,name:input.name,description:input.description||'',target:input.target||'TypeScript application',root,managed:!input.root,createdAt:new Date().toISOString(),specRevision:0,specification:emptyGraph(),layout:{},checks:{}};
  if(input.root){
   const worker=new AnalysisWorker();
   try{
    const analysis=await worker.analyze(root);
    project.analysis={...analysis,graph:GraphSchema.parse(analysis.graph)};
   }finally{await worker.close();}
  }
  await atomicJson(join(dir,'revisions','0.json'),{schemaVersion:1,revision:0,createdAt:project.createdAt,graph:project.specification});
  await this.save(project);
  return project;
 }
 async get(id:string):Promise<Project>{
  try{
   const project=ProjectRecordSchema.parse(await readJson(join(this.projectDir(id),'project.json'),'project '+id+'/project.json')) as Project;
   if(project.id!==id)throw new AppError('Stored project ID does not match '+id,500);
   project.specification=GraphSchema.parse(project.specification);
   try{project.analysis=JSON.parse(await readFile(join(this.projectDir(id),'analysis.json'),'utf8'));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(project.analysis!==undefined)project.analysis.graph=GraphSchema.parse(project.analysis?.graph);
   return project;
  }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('Project not found',404);throw error;}
 }
 async list():Promise<Project[]>{
  await mkdir(join(this.dir,'projects'),{recursive:true});
  const entries=await readdir(join(this.dir,'projects'));const result:Project[]=[];
  for(const id of entries)if(/^[a-zA-Z0-9-]+$/.test(id)){
   try{result.push(await this.get(id));}
   catch(error){if(!(error instanceof AppError&&error.statusCode===404))throw error;}
  }
  return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 }
 private async save(project:Project){
  const {analysis,...specification}=project;
  // Persist legacy inline evidence before removing it from the intended storage.
  if(analysis)await atomicJson(join(this.projectDir(project.id),'analysis.json'),analysis);
  await atomicJson(join(this.projectDir(project.id),'project.json'),specification);
 }
 async updateSpec(id:string,expected:number,graph:GraphInput):Promise<Project>{
  return this.transaction(id,async()=>{
   const project=await this.get(id);
   if(project.specRevision!==expected)throw new AppError('Specification changed. Reload and review your edit.',409);
   const parsed=GraphSchema.parse(graph);
   project.specification=parsed;project.specRevision=RevisionSchema.parse(project.specRevision+1);
   await atomicJson(join(this.projectDir(id),'revisions',project.specRevision+'.json'),{schemaVersion:1,revision:project.specRevision,createdAt:new Date().toISOString(),graph:parsed});
   await this.save(project);return project;
  });
 }
 async updateLayout(id:string,layout:Layout){
  return this.transaction(id,async()=>{const project=await this.get(id);project.layout=layout;await this.save(project);return project;});
 }
 async updateAnalysis(id:string,analysis:Analysis) {
  return this.transaction(id,async()=>{
   const p=await this.get(id);p.analysis={...analysis,graph:GraphSchema.parse(analysis.graph)};
   await atomicJson(join(this.projectDir(id),'analysis.json'),p.analysis);return p;
  });
 }
 async updateChecks(id:string,checks:Project['checks']) {
  return this.transaction(id,async()=>{const p=await this.get(id);p.checks=checks;await this.save(p);return p;});
 }
 async history(id:string) {
  const project=await this.get(id);
  const dir=join(this.projectDir(id),'revisions');
  const files=(await readdir(dir)).filter(n=>n.endsWith('.json'));
  for(const file of files)if(!/^(0|[1-9]\d*)\.json$/.test(file)||!Number.isSafeInteger(parseInt(file)))
   throw new AppError('Invalid specification history filename: '+file,500);
  // project.json is the commit boundary; later records can be abandoned writes.
  const committed=files.filter(n=>parseInt(n)<=project.specRevision).sort((a,b)=>parseInt(a)-parseInt(b));
  if(committed.length!==project.specRevision+1||committed.some((file,i)=>parseInt(file)!==i))
   throw new AppError('Missing committed specification history for project '+id,500);
  return Promise.all(committed.map(async file=>{
   const revision=RevisionRecordSchema.parse(await readJson(join(dir,file),'project '+id+'/revisions/'+file));
   if(revision.revision!==parseInt(file))throw new AppError('Specification revision does not match '+file,500);
   return {...revision,graph:GraphSchema.parse(revision.graph)};
  }));
 }
 async saveJob(job:AgentJob){await atomicJson(join(this.projectDir(job.projectId),'jobs',job.id+'.json'),job);}
 async jobs(projectId:string):Promise<AgentJob[]>{
  const dir=join(this.projectDir(projectId),'jobs');await mkdir(dir,{recursive:true});
  return Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async file=>JSON.parse(await readFile(join(dir,file),'utf8'))));
 }
}
