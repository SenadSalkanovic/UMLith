import {parentPort} from 'node:worker_threads';
import {register} from 'tsx/esm/api';
register();
const {Analyzer}=await import('./analyzer.ts');
const analyzer=new Analyzer();
parentPort.on('message',async({id,root})=>{
 try{parentPort.postMessage({id,result:await analyzer.analyze(root)});}
 catch(error){parentPort.postMessage({id,error:error.message});}
});
