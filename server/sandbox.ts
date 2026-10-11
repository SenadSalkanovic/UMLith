import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
const exec=promisify(execFile);
let availability:Promise<boolean>|undefined;
export type SandboxOptions={writable:boolean;network:boolean;input?:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;hiddenPaths?:string[];readonlyFiles?:string[];dependencyRoot?:string;state?:string;signal?:AbortSignal;onOutput?:(text:string,stream?:'stdout'|'stderr')=>void;onProcess?:(child:ChildProcess)=>void};
export type SandboxExecutor=(command:string,args:string[],cwd:string,options:SandboxOptions)=>Promise<{code:number;output:string}>;
let customExecutor:SandboxExecutor|undefined;
let customAvailability:boolean|undefined;
export function setSandboxExecutorForTesting(executor?:SandboxExecutor|null){customExecutor=executor||undefined;}
export function setSandboxAvailabilityForTesting(available?:boolean|null){customAvailability=available??undefined;}
export function resetSandboxForTesting(){customExecutor=undefined;customAvailability=undefined;availability=undefined;}
export function sandboxAvailable(){
 if(customAvailability!==undefined)return Promise.resolve(customAvailability);
 if(customExecutor!==undefined)return Promise.resolve(true);
 if(!availability)availability=process.platform==='linux'?exec('bwrap',['--ro-bind','/','/','--unshare-pid','--proc','/proc','--dev','/dev','--die-with-parent','/bin/true'],{timeout:5000}).then(()=>true,()=>false):Promise.resolve(false);
 return availability;
}
export function stopSandbox(child:ChildProcess){
 const kill=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{}};
 kill('SIGTERM');const timer=setTimeout(()=>kill('SIGKILL'),1000);timer.unref();
 child.once('close',()=>clearTimeout(timer));
}
export async function runSandbox(command:string,args:string[],cwd:string,options:SandboxOptions){
 if(!await sandboxAvailable())throw new Error('Bubblewrap isolation is unavailable. Export the package and import agent results instead.');
 if(options.signal?.aborted)throw new Error('Execution cancelled.');
 if(customExecutor)return customExecutor(command,args,cwd,options);
 cwd=await realpath(cwd);
 const sandboxArgs=['--ro-bind','/','/','--tmpfs','/tmp','--dir','/tmp/home','--unshare-pid','--unshare-ipc','--proc','/proc','--dev','/dev','--die-with-parent'];
 // Host homes and original/private storage are absent; only the candidate is writable.
 for(const path of new Set(['/home','/root',homedir(),...(options.hiddenPaths||[])])){
  try{if((await lstat(path)).isDirectory())sandboxArgs.push('--tmpfs',resolve(path));else sandboxArgs.push('--ro-bind','/dev/null',resolve(path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 sandboxArgs.push(options.writable?'--bind':'--ro-bind',cwd,cwd);
 for(const path of options.readonlyFiles||[])sandboxArgs.push('--ro-bind',await realpath(path),path);
 // Dependencies are mounted read-only even when their original home was hidden.
 try{
  const deps=await realpath(join(cwd,'node_modules'));const rel=relative(cwd,deps);
  const internal=!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);
  if(!internal&&options.dependencyRoot&&deps!==await realpath(options.dependencyRoot))throw new Error('Candidate dependencies changed outside the captured project boundary.');
  if(!internal&&!options.dependencyRoot&&!deps.endsWith(sep+'node_modules'))throw new Error('External dependencies must be a node_modules directory.');
  sandboxArgs.push('--ro-bind',deps,deps);
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(options.state)sandboxArgs.push('--bind',await realpath(options.state),'/tmp/codex-home');
 if(!options.network)sandboxArgs.push('--unshare-net');
 sandboxArgs.push('--chdir',cwd,'--',command,...args);
 return new Promise<{code:number;output:string}>((resolve,reject)=>{
  const child=spawn('bwrap',sandboxArgs,{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8',...options.env,HOME:'/tmp/home',TMPDIR:'/tmp'},stdio:['pipe','pipe','pipe'],detached:true});
  options.onProcess?.(child);child.stdin.on('error',()=>{});child.stdin.end(options.input||'');
  let output='';let completed=false;let timedOut=false;
  const abort=()=>stopSandbox(child);options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)abort();
  const timeout=setTimeout(()=>{timedOut=true;stopSandbox(child);},options.timeoutMs||30*60*1000);timeout.unref();
  for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']] as const)stream.on('data',(chunk:Buffer)=>{const text=chunk.toString();output=(output+text).slice(-256000);options.onOutput?.(text,name);});
  const clean=()=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);};
  child.on('error',error=>{clean();if(!completed){completed=true;reject(error);}});
  child.on('close',code=>{clean();if(!completed){completed=true;resolve({code:timedOut||options.signal?.aborted?-1:code??-1,output:output+(timedOut?'\nExecution timed out.':'')});}});
 });
}
