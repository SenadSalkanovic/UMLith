import {Worker} from 'node:worker_threads';
import type {Analysis} from '../shared/model';
import type {ImportQualityReport} from './analyzer';
import {AppError} from './files';

export class AnalysisWorker {
 // The worker registers its own loader; parent CLI hooks/flags must not leak in.
 private worker=new Worker(new URL('./analysis-worker.mjs',import.meta.url),{execArgv:[]});
 private pending=new Map<number,{resolve:(a:any)=>void;reject:(e:Error)=>void}>();
 private next=0;
 constructor(){
  this.worker.on('message',({id,result,error,statusCode})=>{
   const task=this.pending.get(id);
   if(!task)return;
   this.pending.delete(id);
   if(error){
    const err = typeof statusCode === 'number' ? new AppError(error, statusCode) : new Error(error);
    task.reject(err);
   }else{
    task.resolve(result);
   }
  });
  this.worker.on('error',error=>{for(const task of this.pending.values())task.reject(error);this.pending.clear();});
 }
 analyze(root:string,options?:any):Promise<Analysis>{
  return new Promise((resolve,reject)=>{const id=++this.next;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,root,options});});
 }
 analyzeAndReport(root:string,options?:any):Promise<{analysis:Analysis;report:ImportQualityReport}>{
  return new Promise((resolve,reject)=>{const id=++this.next;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,action:'analyzeAndReport',root,options});});
 }
 invalidate(reason?:string,paths?:string[]):Promise<void>{
  return new Promise((resolve,reject)=>{const id=++this.next;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,action:'invalidate',reason,paths});});
 }
 async close(){for(const t of this.pending.values())t.reject(new Error('Analysis closed'));this.pending.clear();await this.worker.terminate();}
}
