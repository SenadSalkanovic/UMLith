import {Worker} from 'node:worker_threads';
import type {Analysis} from '../shared/model';
export class AnalysisWorker {
 // The worker registers its own loader; parent CLI hooks/flags must not leak in.
 private worker=new Worker(new URL('./analysis-worker.mjs',import.meta.url),{execArgv:[]});
 private pending=new Map<number,{resolve:(a:Analysis)=>void;reject:(e:Error)=>void}>();
 private next=0;
 constructor(){
  this.worker.on('message',({id,result,error})=>{const task=this.pending.get(id);if(!task)return;this.pending.delete(id);error?task.reject(new Error(error)):task.resolve(result);});
  this.worker.on('error',error=>{for(const task of this.pending.values())task.reject(error);this.pending.clear();});
 }
 analyze(root:string,options?:any):Promise<Analysis>{
  return new Promise((resolve,reject)=>{const id=++this.next;this.pending.set(id,{resolve,reject});this.worker.postMessage({id,root,options});});
 }
 async close(){for(const t of this.pending.values())t.reject(new Error('Analysis closed'));this.pending.clear();await this.worker.terminate();}
}
