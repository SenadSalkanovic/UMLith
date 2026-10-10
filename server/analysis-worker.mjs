import {parentPort} from 'node:worker_threads';
import {register} from 'tsx/esm/api';
register();
const {Analyzer}=await import('./analyzer.ts');
const analyzer=new Analyzer();
parentPort.on('message',async({id,root,options})=>{
 try{parentPort.postMessage({id,result:await analyzer.analyze(root,options)});}
 catch(error){parentPort.postMessage({id,error:error.message});}
});
