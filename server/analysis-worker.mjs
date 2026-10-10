import {parentPort} from 'node:worker_threads';
import {register} from 'tsx/esm/api';
register();
const {Analyzer}=await import('./analyzer.ts');
const analyzer=new Analyzer();
parentPort.on('message',async({id,action,root,options,reason,paths})=>{
 try{
  if(action==='invalidate'){
   analyzer.invalidate(reason,paths);
   parentPort.postMessage({id,result:true});
  }else if(action==='analyzeAndReport'){
   const result=await analyzer.analyzeAndReport(root,options);
   parentPort.postMessage({id,result});
  }else{
   parentPort.postMessage({id,result:await analyzer.analyze(root,options)});
  }
 }
 catch(error){parentPort.postMessage({id,error:error.message,statusCode:error.statusCode});}
});
