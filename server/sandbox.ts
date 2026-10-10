import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname} from 'node:path';
const exec=promisify(execFile);
let availability:Promise<boolean>|undefined;
export type SandboxOptions={writable:boolean;network:boolean;input?:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;onOutput?:(text:string)=>void;onProcess?:(child:ChildProcess)=>void};
export type SandboxExecutor=(command:string,args:string[],cwd:string,options:SandboxOptions)=>Promise<{code:number;output:string}>;
let customExecutor:SandboxExecutor|undefined;
let customAvailability:boolean|undefined;
export function setSandboxExecutorForTesting(executor?:SandboxExecutor|null){
 customExecutor=executor||undefined;
}
export function setSandboxAvailabilityForTesting(available?:boolean|null){
 customAvailability=available===null||available===undefined?undefined:available;
}
export function resetSandboxForTesting(){
 customExecutor=undefined;
 customAvailability=undefined;
 availability=undefined;
}
export function sandboxAvailable(){
 if(customAvailability!==undefined)return Promise.resolve(customAvailability);
 if(customExecutor!==undefined)return Promise.resolve(true);
 if(!availability)availability=process.platform==='linux'?exec('bwrap',['--ro-bind','/','/','--unshare-pid','--proc','/proc','--dev','/dev','--die-with-parent','/bin/true'],{timeout:5000}).then(()=>true,()=>false):Promise.resolve(false);
 return availability;
}
export async function runSandbox(command:string,args:string[],cwd:string,options:SandboxOptions){
 if(!await sandboxAvailable())throw new Error('Bubblewrap isolation is unavailable. Export the package and import agent results instead.');
 if(customExecutor)return customExecutor(command,args,cwd,options);
 const sandboxArgs=['--ro-bind','/','/','--tmpfs','/tmp',options.writable?'--bind':'--ro-bind',dirname(cwd),dirname(cwd),'--unshare-pid','--unshare-ipc','--proc','/proc','--dev','/dev','--die-with-parent','--chdir',cwd];
 if(!options.network)sandboxArgs.push('--unshare-net');
 sandboxArgs.push('--',command,...args);
 return new Promise<{code:number;output:string}>((resolve,reject)=>{
  const child=spawn('bwrap',sandboxArgs,{cwd,env:options.env||process.env,stdio:['pipe','pipe','pipe'],detached:true});
  options.onProcess?.(child);
  child.stdin.end(options.input||"");
  let output='';let completed=false;
  const stop=()=>{try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}};
  const timeout=setTimeout(()=>{stop();},options.timeoutMs||30*60*1000);timeout.unref();
  for(const stream of [child.stdout,child.stderr])stream.on('data',(chunk:Buffer)=>{const text=chunk.toString();output=(output+text).slice(-256000);options.onOutput?.(text);});
  child.on('error',error=>{clearTimeout(timeout);if(!completed){completed=true;reject(error);}});
  child.on('close',code=>{clearTimeout(timeout);if(!completed){completed=true;resolve({code:code??-1,output});}});
 });
}
