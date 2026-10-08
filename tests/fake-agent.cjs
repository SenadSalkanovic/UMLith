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
  const proposal=JSON.parse(fs.readFileSync('_architect/specification.json','utf8')).graph;
  proposal.nodes[0].description='Proposed description';
  const output=args[args.indexOf('-o')+1];
  fs.writeFileSync(output,JSON.stringify({graph:proposal,explanation:'Clarifies purpose',questions:[]}));
 }else{
  fs.writeFileSync('main.ts','export function value(): number { return 2; }\n');
  if(config.mode==='scope')fs.writeFileSync('outside.ts','export const outside = true;');
 }
 output(JSON.stringify({type:'turn.completed'})+'\n');
});
