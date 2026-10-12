import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {graphToPlantUml, type DiagramRequest} from '../shared/plantuml';
import {AppError} from './files';
const jar=fileURLToPath(new URL('../.tools/plantuml-1.2026.8.jar',import.meta.url));
let active=0;
const cache=new Map<string,string>();
export async function renderPlantUml(request:DiagramRequest) {
 const source=graphToPlantUml(request);
 if(Buffer.byteLength(source)>256*1024)throw new AppError('Diagram exceeds 256 KiB. Open a smaller scope.',413);
 const cached=cache.get(source);if(cached)return {source,svg:cached,renderer:'PlantUML 1.2026.8'};
 if(active>=2)throw new AppError('Two diagrams are rendering. Retry in a moment.',429);
 try{await access(jar);}catch{throw new AppError('Install the local renderer with npm run setup:plantuml, then retry.',503);}
 active++;
 try {
  const svg=await new Promise<string>((resolve,reject)=>{
   const child=spawn('java',['-Xmx256m','-Djava.awt.headless=true','-DPLANTUML_SECURITY_PROFILE=SANDBOX','-jar',jar,'-tsvg','-pipe','-charset','UTF-8'],{stdio:['pipe','pipe','pipe']});
   let output='',errors='',settled=false;
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(output);};
   const timer=setTimeout(()=>finish(new AppError('PlantUML rendering timed out. Open a smaller scope.',504)),15000);
   child.on('error',()=>finish(new AppError('Java is unavailable. Install Java 11+ and retry.',503)));
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>8*1024*1024)finish(new AppError('Rendered diagram exceeds 8 MiB. Open a smaller scope.',413));});
   child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{if(errors.length<12000)errors+=chunk;});
   child.stdin.on('error',()=>{});
   child.on('close',code=>finish(code===0&&output.includes('<svg')?undefined:new AppError('PlantUML could not render this diagram: '+errors.slice(0,1000),422)));
   child.stdin.end(source);
  });
  if(cache.size>=24)cache.delete(cache.keys().next().value!);cache.set(source,svg);
  return {source,svg,renderer:'PlantUML 1.2026.8'};
 } finally {active--;}
}
