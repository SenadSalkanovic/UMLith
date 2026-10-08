import {EventEmitter} from 'node:events';
import chokidar,{type FSWatcher} from 'chokidar';
import {join,basename} from 'node:path';
import type {Analysis} from '../shared/model';
import {graphDelta,emptyGraph} from '../shared/model';
import {AnalysisWorker} from './worker';
import {ProjectStore} from './store';
import {captureFiles,hashes,ignoredDirs,excluded} from './files';
type Session={worker:AnalysisWorker;watcher?:FSWatcher;generation:number;running?:Promise<void>;debounce?:ReturnType<typeof setTimeout>;timer?:ReturnType<typeof setInterval>;closed:boolean};
export class SyncService extends EventEmitter {
 private sessions=new Map<string,Session>();
 constructor(public store:ProjectStore,private options:{watch?:boolean}={}){super();}
 async start(id:string){
  if(this.sessions.has(id))return this.request(id);
  const project=await this.store.get(id);
  const session:Session={worker:new AnalysisWorker(),generation:0,closed:false};this.sessions.set(id,session);
  if(this.options.watch!==false){
   session.watcher=chokidar.watch(project.root,{ignoreInitial:true,awaitWriteFinish:{stabilityThreshold:150,pollInterval:50},atomic:true,
    ignored:(path,stats)=>path!==project.root&&(ignoredDirs.has(basename(path))||excluded(basename(path)))});
   const schedule=()=>{
    clearTimeout(session.debounce);
    session.debounce=setTimeout(()=>void this.request(id).catch(error=>this.emit('notification',id,{type:'error',message:error.message})),300);
   };
   session.watcher.on('all',schedule);
   session.watcher.on('error',()=>void this.reconcile(id).catch(error=>this.emit('notification',id,{type:'error',message:error.message})));
   session.timer=setInterval(()=>void this.reconcile(id).catch(error=>this.emit('notification',id,{type:'error',message:error.message})),60000);
   session.timer.unref();
  }
  return this.request(id);
 }
 async reconcile(id:string){
  const p=await this.store.get(id);
  const current=hashes(await captureFiles(p.root));
  const previous=p.analysis?hashes(p.analysis.files):{};
  if(JSON.stringify(current)!==JSON.stringify(previous)||p.analysis?.status==='stale')await this.request(id);
 }
 request(id:string):Promise<void>{
  const session=this.sessions.get(id);
  if(!session)return this.start(id);
  session.generation++;
  if(!session.running){
   session.running=this.run(id,session).finally(()=>{session.running=undefined;});
  }
  return session.running;
 }
 private async run(id:string,session:Session){
  let finished=0;
  while(!session.closed&&finished!==session.generation){
   const generation=session.generation;
   const p=await this.store.get(id);const before=p.analysis;
   this.emit('notification',id,{type:'status',status:'updating',sequence:before?.sequence||0});
   try{
    const result=await session.worker.analyze(p.root);
    if(generation!==session.generation){continue;}
    if(session.closed)return;
    result.sequence=(before?.sequence||0)+1;
    await this.store.updateAnalysis(id,result);
    this.emit('notification',id,{type:'analysis',baseSequence:before?.sequence||0,sequence:result.sequence,revision:result.revision,status:result.status,quality:result.quality,delta:graphDelta(before?.graph||emptyGraph(),result.graph)});
   }catch(error){
    if(generation!==session.generation)continue;
    const stale:Analysis=before?{...before,status:'stale',quality:{...before.quality,diagnostics:[...before.quality.diagnostics.filter(d=>d.code!=='analysis-failure'),{severity:'error',code:'analysis-failure',message:(error as Error).message}]}}:
     {revision:'',sequence:0,analyzedAt:new Date().toISOString(),status:'stale',graph:emptyGraph(),files:{},durationMs:0,quality:{eligibleFiles:0,analyzedFiles:0,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'unavailable',diagnostics:[{severity:'error',code:'analysis-failure',message:(error as Error).message}]}};
    if(!session.closed){await this.store.updateAnalysis(id,stale);this.emit('notification',id,{type:'status',status:'stale',message:(error as Error).message});}
   }
   finished=generation;
  }
 }
 async close(){
  for(const session of this.sessions.values()){
   session.closed=true;clearTimeout(session.debounce);clearInterval(session.timer);
   await session.watcher?.close();await session.worker.close();
  }this.sessions.clear();
 }
}
