const fs=require('node:fs');
// Codex's Linux sandbox can drop asynchronous Node pipe writes on exit.
const output=text=>fs.writeSync(1,text);
let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',async()=>{
 const args=process.argv.slice(2);const modelIndex=args.indexOf('-m');
 const model=modelIndex>=0?args[modelIndex+1]:'{}';
 let config={};try{config=JSON.parse(model);}catch{}
 if(config.original){
  try{fs.writeFileSync(config.original,'forbidden');output('original-write-succeeded\n');}
  catch{
   if(config.fragmentOutput){
    output('original-write-');
    await new Promise(resolve=>setTimeout(resolve,30));
    output('blocked\n');
   }else output('original-write-blocked\n');
  }
 }
 if(config.mode==='fail'){fs.writeSync(2,'fake failure');process.exit(2);}
 if(config.mode==='design'){
  const spec=JSON.parse(fs.readFileSync('_architect/specification.json','utf8'));
  const proposal=spec.graph;
  const output=args[args.indexOf('-o')+1];
  if(config.designMode==='malformed'){
   fs.writeFileSync(output,JSON.stringify({graph:{schemaVersion:1,nodes:[{id:'invalid-node'}],edges:[],requirements:[]},explanation:'Malformed graph',questions:[]}));
  }else if(config.designMode==='stale'){
   if(proposal.nodes.length>0)proposal.nodes[0].description='Proposed description';
   fs.writeFileSync(output,JSON.stringify({graph:proposal,explanation:'Clarifies purpose',questions:[],baseRevision:(spec.revision||1)-1}));
  }else if(config.designMode==='frozen-violation'){
   if(proposal.nodes.length>0)proposal.nodes[0].description='Modified frozen description';
   fs.writeFileSync(output,JSON.stringify({graph:proposal,explanation:'Violates frozen node',questions:[],baseRevision:spec.revision}));
  }else if(config.designMode==='scope-violation'){
   proposal.nodes.push({id:'out-of-scope-1',kind:'module',name:'OutOfScope',policy:'editable',provenance:'ai',outputPath:'outside/unapproved.ts',fields:[],requiredChecks:[],contract:'',description:'',instructions:''});
   fs.writeFileSync(output,JSON.stringify({graph:proposal,explanation:'Scope violation',questions:[],baseRevision:spec.revision}));
  }else{
   if(proposal.nodes.length>0)proposal.nodes[0].description='Proposed description';
   fs.writeFileSync(output,JSON.stringify({graph:proposal,explanation:'Clarifies purpose',questions:[],baseRevision:spec.revision}));
  }
 }else{
  fs.writeFileSync('main.ts','export function value(): number { return 2; }\n');
  if(config.mode==='scope')fs.writeFileSync('outside.ts','export const outside = true;');
 }
 output(JSON.stringify({type:'turn.completed'})+'\n');
});
