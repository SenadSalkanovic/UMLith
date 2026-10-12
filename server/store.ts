import {mkdir,readFile,readdir,realpath,stat,copyFile,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {GraphSchema,LayoutSchema,ScopedLayoutsSchema,emptyGraph,type Project,type GraphInput,type Layout,type Analysis,type AgentJob} from '../shared/model';
import {AppError,atomicJson} from './files';
import {AnalysisWorker} from './worker';
const RevisionSchema=z.int().nonnegative();
export class SpecificationConflictError extends AppError {
 constructor(public projectId:string,public expectedRevision:number,public currentRevision:number){
  super(`Specification changed (expected ${expectedRevision}, current ${currentRevision}). Reload project ${projectId} and review your edit.`,409);
 }
}
const ProjectRecordSchema=z.object({
 id:z.string().regex(/^[a-zA-Z0-9-]+$/),name:z.string(),description:z.string(),target:z.string(),root:z.string(),
 managed:z.boolean(),createdAt:z.iso.datetime({offset:true}),specRevision:RevisionSchema,
 // Legacy inline positions accepted extra metadata; normalize it before migrating.
 specification:z.unknown(),layout:z.record(z.string(),z.object({x:z.number().finite(),y:z.number().finite()})).default({}),layoutRevision:RevisionSchema.default(0),scopedLayouts:ScopedLayoutsSchema.default({}),
 checks:z.record(z.string(),z.object({command:z.string(),args:z.array(z.string())})),
}).passthrough();
const RevisionRecordSchema=z.object({
 schemaVersion:z.literal(1).default(1),revision:RevisionSchema,createdAt:z.iso.datetime({offset:true}),graph:z.unknown(),
}).strict();
const LayoutRecordSchema=z.object({
 schemaVersion:z.literal(1),revision:RevisionSchema,layout:LayoutSchema,scopedLayouts:ScopedLayoutsSchema,
}).strict();
function retainLayout(project:Project):Project{
 // Missing IDs in incomplete analysis are not confirmed deletions.
 if(project.analysis&&project.analysis.status!=='current')return project;
 // Filter deleted IDs without coupling graph commits to a layout write.
 const ids=new Set([...project.specification.nodes,...(project.analysis?.graph.nodes??[])].map(node=>node.id));
 const retain=(layout:Layout)=>Object.fromEntries(Object.entries(layout).filter(([id])=>ids.has(id)));
 project.layout=retain(project.layout);
 project.scopedLayouts=Object.fromEntries(Object.entries(project.scopedLayouts??{}).map(([view,layout])=>[view,retain(layout)]));
 return project;
}
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
  const project:Project={id,name:input.name,description:input.description||'',target:input.target||'TypeScript application',root,managed:!input.root,createdAt:new Date().toISOString(),specRevision:0,specification:emptyGraph(),layout:{},layoutRevision:0,scopedLayouts:{},checks:{}};
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
   try{
    const layout=LayoutRecordSchema.parse(await readJson(join(this.projectDir(id),'layout.json'),'project '+id+'/layout.json'));
    project.layout=layout.layout;project.layoutRevision=layout.revision;project.scopedLayouts=layout.scopedLayouts;
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   return retainLayout(project);
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
 private async save(project:Project,semantic=false){
  const {analysis,layout,layoutRevision,scopedLayouts,...specification}=project;
  const path=join(this.projectDir(project.id),'project.json');
  if(!semantic){
   try{const original=JSON.parse(await readFile(path,'utf8'));if((original.specification.schemaVersion??1)===1)specification.specification=original.specification;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  // Commit legacy geometry before removing it from project.json.
  try{await stat(join(this.projectDir(project.id),'layout.json'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await this.saveLayout(project);}
  // Persist legacy inline evidence before removing it from the intended storage.
  if(analysis){
   const analysisPath=join(this.projectDir(project.id),'analysis.json');
   try{await stat(analysisPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await atomicJson(analysisPath,analysis);}
  }
  await atomicJson(join(this.projectDir(project.id),'project.json'),specification);
 }
 private async saveLayout(project:Project){
  await atomicJson(join(this.projectDir(project.id),'layout.json'),LayoutRecordSchema.parse({
   schemaVersion:1,revision:project.layoutRevision??0,layout:project.layout,scopedLayouts:project.scopedLayouts??{},
  }));
 }
 async updateSpec(id:string,expected:number,graph:GraphInput,projectDescription?:string):Promise<Project>{
  if(!RevisionSchema.safeParse(expected).success)throw new AppError('Expected specification revision must be a nonnegative safe integer.');
  return this.transaction(id,async()=>{
   const project=await this.get(id);
   if(project.specRevision!==expected)throw new SpecificationConflictError(id,expected,project.specRevision);
   const parsed=GraphSchema.parse(graph);
   if(projectDescription!==undefined)project.description=z.string().parse(projectDescription);
   const originalPath=join(this.projectDir(id),'project.json');
   const original=JSON.parse(await readFile(originalPath,'utf8'));
   if((original.specification.schemaVersion??1)===1){
    const backup=join(this.projectDir(id),'migration-v1-project.json');
    try{await stat(backup);}catch(error){
     if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
     const temp=backup+'.'+randomUUID()+'.tmp';
     try{await copyFile(originalPath,temp);const file=await open(temp,'r+');try{await file.sync();}finally{await file.close();}await rename(temp,backup);const directory=await open(this.projectDir(id),'r');try{await directory.sync();}finally{await directory.close();}}finally{await rm(temp,{force:true});}
    }
   }
   project.specification=parsed;project.specRevision=RevisionSchema.parse(project.specRevision+1);
   await atomicJson(join(this.projectDir(id),'revisions',project.specRevision+'.json'),{schemaVersion:1,revision:project.specRevision,createdAt:new Date().toISOString(),graph:parsed});
   await this.save(project,true);return retainLayout(project);
  });
 }
 async updateLayout(id:string,layout:Layout,view?:string):Promise<Project>{
  const parsed=LayoutSchema.parse(layout);
  if(view!==undefined)z.string().refine(value=>!!value.trim()).parse(view);
  return this.transaction(id,async()=>{
   const project=await this.get(id);
   if(view===undefined)project.layout=parsed;
   else project.scopedLayouts={...project.scopedLayouts,[view]:parsed};
   project.layoutRevision=RevisionSchema.parse((project.layoutRevision??0)+1);
   retainLayout(project);await this.saveLayout(project);return project;
  });
 }
 async updateAnalysis(id:string,analysis:Analysis) {
  return this.transaction(id,async()=>{
   const p=await this.get(id);p.analysis={...analysis,graph:GraphSchema.parse(analysis.graph)};
   await atomicJson(join(this.projectDir(id),'analysis.json'),p.analysis);return retainLayout(p);
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
  return Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async file=>{
   const job:AgentJob=JSON.parse(await readFile(join(dir,file),'utf8'));
   if(job.preview)job.preview={...job.preview,graph:GraphSchema.parse(job.preview.graph)};
   if(job.report?.candidate)job.report.candidate={...job.report.candidate,graph:GraphSchema.parse(job.report.candidate.graph)};
   if(job.proposal)job.proposal={...job.proposal,graph:GraphSchema.parse(job.proposal.graph)};
   return job;
  }));
 }
}
