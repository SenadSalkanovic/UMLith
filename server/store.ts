import {mkdir,readFile,readdir,realpath,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GraphSchema,emptyGraph,type Project,type GraphInput,type Layout,type Analysis,type AgentJob} from '../shared/model';
import {AppError,atomicJson} from './files';
import {AnalysisWorker} from './worker';
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
  await this.save(project);
  await atomicJson(join(dir,'revisions','0.json'),{revision:0,createdAt:new Date().toISOString(),graph:project.specification});
  return project;
 }
 async get(id:string):Promise<Project>{
  try{
   const project:Project=JSON.parse(await readFile(join(this.projectDir(id),'project.json'),'utf8'));
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
  for(const id of entries)if(/^[a-zA-Z0-9-]+$/.test(id)){try{result.push(await this.get(id));}catch{}}
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
   project.specification=parsed;project.specRevision++;
   await atomicJson(join(this.projectDir(id),'revisions',project.specRevision+'.json'),{revision:project.specRevision,createdAt:new Date().toISOString(),graph:parsed});
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
  const dir=join(this.projectDir(id),'revisions');
  return Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).sort((a,b)=>parseInt(a)-parseInt(b)).map(async file=>{
   const revision=JSON.parse(await readFile(join(dir,file),'utf8'));
   revision.graph=GraphSchema.parse(revision.graph);return revision;
  }));
 }
 async saveJob(job:AgentJob){await atomicJson(join(this.projectDir(job.projectId),'jobs',job.id+'.json'),job);}
 async jobs(projectId:string):Promise<AgentJob[]>{
  const dir=join(this.projectDir(projectId),'jobs');await mkdir(dir,{recursive:true});
  return Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async file=>JSON.parse(await readFile(join(dir,file),'utf8'))));
 }
}
