import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let supported:Promise<void>|undefined;
export function verifyCodex(){
 return supported??=exec('codex',['exec','--help'],{timeout:5000}).then(({stdout})=>{
  for(const flag of ['--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--output-schema','--local-provider','--oss','--sandbox'])if(!stdout.includes(flag))throw new Error('Installed Codex does not support '+flag+'. Update the CLI or use export/import.');
 });
}
export class CodexProgress {
 private pending='';
 error:string|undefined;
 constructor(private emit:(message:string,type:string,data?:unknown)=>void){}
 push(text:string){
  this.pending+=text;
  if(this.pending.length>256000){this.emit(this.pending.slice(0,12000),'output');this.pending='';return;}
  let end:number;
  while((end=this.pending.indexOf('\n'))>=0){this.line(this.pending.slice(0,end));this.pending=this.pending.slice(end+1);}
 }
 finish(){if(this.pending)this.line(this.pending);this.pending='';}
 private line(line:string){
  if(!line.trim())return;
  let event:any;
  try{event=JSON.parse(line);}catch{this.emit(line,'output');return;}
  if(!event||typeof event!=='object'||typeof event.type!=='string'){this.emit(line,'output');return;}
  if(event.type==='error'||event.type==='turn.failed'||event.type==='thread.failed'||event.item?.type==='error')this.error=event.error?.message||event.message||event.item?.message||'Codex reported '+event.type;
  this.emit(line,event.type,event);
 }
}
