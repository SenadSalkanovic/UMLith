import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readHandoff,nodeContext,HandoffId,type PreparedHandoff} from './handoff';

const MAX_RESPONSE_BYTES=1024*1024;
const NodeId=z.string().min(1).max(4096);
export function createHandoffMcp(handoff:PreparedHandoff){
 const server=new McpServer({name:'umlith-read-only-handoff',version:'1.0.0'});
 const base='umlith://handoffs/'+handoff.handoffId;
 const serialize=(value:unknown)=>{const text=typeof value==='string'?value:JSON.stringify(value,null,2);if(Buffer.byteLength(text)>MAX_RESPONSE_BYTES)throw new Error('Response exceeds 1 MiB. Use paginated get_design_context or a focused node. No rules were truncated.');return text;};
 const resource=(name:string,uri:string,value:()=>unknown,mimeType='application/json')=>server.registerResource(name,uri,{mimeType},async()=>({contents:[{uri,mimeType,text:serialize(value())}]}));
 resource('manifest',base+'/manifest',()=>handoff.manifest);
 resource('specification',base+'/specification',()=>handoff.files['specification.json']);
 resource('architecture',base+'/architecture',()=>handoff.files['ARCHITECTURE.md'],'text/markdown');
 for(const [name,path] of Object.entries(handoff.manifest.diagrams || {}))resource('diagram-'+name,base+'/diagrams/'+encodeURIComponent(name),()=>handoff.files[path],'text/plain');
 for(const node of handoff.specification.graph.nodes)resource('node-'+node.id,base+'/nodes/'+encodeURIComponent(node.id),()=>nodeContext(handoff,node.id));
 const bound={handoffId:HandoffId.optional()};
 const tool=(name:string,schema:Record<string,z.ZodType>,get:(input:any)=>unknown)=>server.registerTool(name,{description:'Read the selected immutable design snapshot. No mutations or command execution.',inputSchema:schema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async(input)=>{
  try{if(input.handoffId!==undefined&&input.handoffId!==handoff.handoffId)throw new Error('Handoff not found: this server is bound to one snapshot');return {content:[{type:'text',text:serialize(get(input))}]};}
  catch(error){return {isError:true,content:[{type:'text',text:(error as Error).message}]};}
 });
 tool('get_design_manifest',bound,()=>handoff.manifest);
 tool('get_method_specification',{...bound,nodeId:NodeId},input=>{const context=nodeContext(handoff,input.nodeId);if(context.node.kind!=='function')throw new Error('Selected item is not a method/function');return context;});
 tool('get_design_context',{...bound,nodeId:NodeId.optional(),offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(25)},input=>{
  if(input.nodeId)return nodeContext(handoff,input.nodeId);
  const spec=handoff.specification,graph=spec.graph;
  const items=[...graph.nodes.map(node=>({type:'node',node})),...graph.edges.map(edge=>({type:'relationship',edge})),...graph.requirements.map(requirement=>({type:'requirement',requirement}))];
  if(input.offset>items.length)throw new Error('Page offset exceeds context size');
  return {handoffId:handoff.handoffId,revision:handoff.specRevision,digest:handoff.digest,project:spec.project,task:spec.task,scope:spec.scope,checks:spec.checks,total:items.length,nextOffset:input.offset+input.limit<items.length?input.offset+input.limit:null,items:items.slice(input.offset,input.offset+input.limit)};
 });
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [projectDir,id]=process.argv.slice(2);if(!projectDir||!id||process.argv.length!==4)throw new Error('Usage: npm run mcp -- <private project artifact directory> <handoff UUID>');const snapshot=await readHandoff(projectDir,id);await createHandoffMcp(snapshot).connect(new StdioServerTransport());}
 catch(error){process.stderr.write((error as Error).message+'\n');process.exitCode=1;}
}
