import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile, stat} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {z} from 'zod';
import {atomicJson,AppError} from './files';
import {bundleFiles} from './export';
import {HandoffPackageSchema, type PreparedHandoff} from '../shared/export';
import type {Project} from '../shared/model';

export const HandoffId=z.uuid();
export const ProjectId=z.string().max(128).regex(/^[a-zA-Z0-9-]+$/);
export const MAX_HANDOFF_BYTES=32*1024*1024;
export type {PreparedHandoff} from '../shared/export';
const digest=(files:Record<string,string>)=>createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');

function handoffLaunch(projectDir:string,id:string){
 HandoffId.parse(id);
 const moduleDir=dirname(fileURLToPath(import.meta.url));
 return {command:process.execPath,args:['--import',createRequire(import.meta.url).resolve('tsx'),join(moduleDir,'mcp.ts'),resolve(projectDir),id]};
}
export async function prepareHandoff(project:Project,task:string,scope:string[],sourceHashes:Record<string,string>,projectDir:string):Promise<PreparedHandoff>{
 const handoffId=randomUUID(),files=bundleFiles(project,task,scope);
 const baseManifest={...JSON.parse(files['manifest.json']),handoffId,sourceHashes,scope};
 files['manifest.json']=JSON.stringify(baseManifest,null,2);
 const contentDigest=digest(files);
 const manifest={...baseManifest,digest:contentDigest,digestAlgorithm:'sha256-package-files-before-digest'};
 files['manifest.json']=JSON.stringify(manifest,null,2);
 const handoff=HandoffPackageSchema.parse({manifest:manifest,specification:JSON.parse(files['specification.json']),architecture:files['ARCHITECTURE.md'],task:files['AGENT_TASK.md'],importReport:JSON.parse(files['IMPORT_REPORT.json'])});
 const result:PreparedHandoff={...handoff,manifest,handoffId,specRevision:project.specRevision,sourceHashes,digest:contentDigest,createdAt:new Date().toISOString(),files,launch:handoffLaunch(projectDir,handoffId)};
 if(Buffer.byteLength(JSON.stringify(result))>MAX_HANDOFF_BYTES)throw new AppError('Handoff exceeds 32 MiB; reduce included source baselines.',413);
 await atomicJson(join(projectDir,'handoffs',handoffId+'.snapshot.json'),result);
 // Preserve the existing strict external-result baseline record.
 await atomicJson(join(projectDir,'handoffs',handoffId+'.json'),{handoffId,projectId:project.id,specRevision:project.specRevision,sourceHashes,task,scope});
 return result;
}
export async function readHandoff(projectDir:string,id:string):Promise<PreparedHandoff>{
 HandoffId.parse(id);
 const path=join(projectDir,'handoffs',id+'.snapshot.json');
 try{
  if((await stat(path)).size>MAX_HANDOFF_BYTES)throw new AppError('Handoff exceeds size limit',413);
  const captured=JSON.parse(await readFile(path,'utf8')) as PreparedHandoff;
  const files=z.record(z.string(),z.string()).parse(captured.files);
  const manifest=JSON.parse(files['manifest.json']);
  if(manifest.handoffId!==id)throw new AppError('Handoff identity mismatch',409);
  const {digest:storedDigest,digestAlgorithm,...baseManifest}=manifest;
  const originalFiles={...files,'manifest.json':JSON.stringify(baseManifest,null,2)};
  if(digest(originalFiles)!==storedDigest)throw new AppError('Handoff digest mismatch',409);
  const handoff=HandoffPackageSchema.parse({manifest,specification:JSON.parse(files['specification.json']),architecture:files['ARCHITECTURE.md'],task:files['AGENT_TASK.md'],importReport:JSON.parse(files['IMPORT_REPORT.json'])});
  return {...handoff,handoffId:id,specRevision:handoff.specification.revision,sourceHashes:manifest.sourceHashes??{},digest:storedDigest,createdAt:captured.createdAt,files,launch:handoffLaunch(projectDir,id)};
 }
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('Prepared handoff not found',404);throw error;}
}
export function handoffArchive(handoff:PreparedHandoff){return zipSync(Object.fromEntries(Object.entries(handoff.files).map(([name,text])=>[name,strToU8(text)])));}
export function nodeContext(handoff:PreparedHandoff,id:string){
 const graph=handoff.specification.graph,node=graph.nodes.find(n=>n.id===id);
 if(!node)throw new AppError('Design item not found',404);
 const descendants=new Set([id]);
 for(let size=-1;size!==descendants.size;){size=descendants.size;for(const n of graph.nodes)if((n.parentId&&descendants.has(n.parentId))||graph.edges.some(e=>e.kind==='contains'&&descendants.has(e.source)&&e.target===n.id))descendants.add(n.id);}
 const children=graph.nodes.filter(n=>n.id!==id&&descendants.has(n.id));
 return {handoffId:handoff.handoffId,revision:handoff.specRevision,digest:handoff.digest,node,owner:graph.nodes.find(n=>n.id===node.parentId)??graph.nodes.find(n=>graph.edges.some(e=>e.kind==='contains'&&e.source===n.id&&e.target===id))??null,children,relationships:graph.edges.filter(e=>e.source===id||e.target===id||children.some(n=>n.id===e.source||n.id===e.target)),requirements:graph.requirements,projectProtections:graph.nodes.filter(n=>n.policy!=='editable'),checks:handoff.specification.checks,scope:handoff.specification.scope};
}

export async function checkHandoffConnection(snapshot:PreparedHandoff,projectDir:string){
 const client=new Client({name:'umlith-connection-check',version:'1.0.0'});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([client.connect(new StdioClientTransport({...handoffLaunch(projectDir,snapshot.handoffId),stderr:'pipe'})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('MCP connection timed out',504)),10000);})]);
  const tools=(await client.listTools()).tools.map(tool=>tool.name);
  const resources=await client.listResources();
  const manifest=await client.readResource({uri:'umlith://handoffs/'+snapshot.handoffId+'/manifest'});
  if(JSON.parse((manifest.contents[0] as {text:string}).text).digest!==snapshot.digest)throw new AppError('MCP snapshot does not match the prepared digest',409);
  const method=snapshot.specification.graph.nodes.find(node=>node.kind==='function');
  if(method){const result=await client.callTool({name:'get_method_specification',arguments:{nodeId:method.id}});if(result.isError)throw new AppError('MCP method read failed: '+JSON.stringify(result.content),409);}
  return {connected:true,client:'Official TypeScript SDK Client 1.32.1',transport:'stdio',tools,resourceCount:resources.resources.length,digest:snapshot.digest};
 }finally{clearTimeout(timer);await client.close();}
}
