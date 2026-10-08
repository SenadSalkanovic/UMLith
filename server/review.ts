import ts from 'typescript';
import {createTwoFilesPatch} from 'diff';
import {readFile,writeFile,mkdir,rename,rm,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NodeSchema,resolveSourceEvidence,type Project,type ProgramNode,type Analysis,type AgentJob,type ValidationReport,type ValidationIssue,type FileChange} from '../shared/model';
import {Analyzer} from './analyzer';
import {AppError,atomicJson,captureFiles,hashes,hash,safePath} from './files';
import {ProjectStore} from './store';
export function normalizeContract(text:string){
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,text.replace(/^(export\s+|declare\s+|async\s+|function\s+)*/,''));
 const tokens:string[]=[];while(scanner.scan()!==ts.SyntaxKind.EndOfFileToken)tokens.push(scanner.getTokenText());return tokens.join('|');
}
export function freezeNode(node:ProgramNode,policy:ProgramNode['policy'],analysis?:Analysis):ProgramNode{
 if(policy==='editable'||policy==='sensitive')return NodeSchema.parse({...node,policy,baseline:undefined});
 if(policy==='frozen-implementation'){
  const evidence=resolveSourceEvidence(node.source,analysis,analysis?.revision);
  if(evidence.status!=='current')throw new AppError('Freeze implementation requires valid, current source evidence. '+('message' in evidence?evidence.message:'Source binding is stale.'));
  return NodeSchema.parse({...node,policy,baseline:{source:evidence.source,text:evidence.text}});
 }
 let contract=node.contract;
 if(!contract.trim()){
  const evidence=resolveSourceEvidence(node.source,analysis,analysis?.revision);
  if(evidence.status!=='current')throw new AppError('Freeze contract requires an explicit interface or valid, current source evidence.');
  const matches=analysis!.graph.nodes.filter(n=>n.kind===node.kind && n.source?.path===evidence.source.path &&
   n.source.start===evidence.source.start && n.source.end===evidence.source.end && n.source.symbol===evidence.source.symbol &&
   n.source.hash===evidence.source.hash && n.source.revision===evidence.source.revision);
  if(matches.length!==1 || !matches[0].contract.trim())throw new AppError('Freeze contract requires an unambiguous declared interface.');
  contract=matches[0].contract;
 }
 return NodeSchema.parse({...node,policy,baseline:{source:node.source,contract}});
}
export function resolveBinding(node:ProgramNode,analysis:Analysis):ProgramNode|undefined {
 if(node.source)return analysis.graph.nodes.find(n=>n.kind===node.kind&&n.source?.path===node.source?.path&&(node.source?.symbol?n.source?.symbol===node.source.symbol:n.kind==='module'));
 const matches=analysis.graph.nodes.filter(n=>n.kind===node.kind&&n.name===node.name&&(!node.outputPath||n.source?.path===node.outputPath));
 return matches.length===1?matches[0]:undefined;
}
export function protectionIssues(project:Project,analysis:Analysis):ValidationIssue[]{
 const issues:ValidationIssue[]=[];
 for(const node of project.specification.nodes){
  if(node.policy!=='frozen-implementation'&&node.policy!=='frozen-contract')continue;
  const actual=resolveBinding(node,analysis);
  if(!actual?.source){issues.push({code:'binding',message:'Protected item cannot be resolved: '+node.name,nodeId:node.id});continue;}
  const evidence=resolveSourceEvidence(actual.source,analysis,analysis.revision);
  if(evidence.status!=='current'){
   issues.push({code:'binding',message:'Protected source evidence is '+evidence.status+': '+('message' in evidence?evidence.message:node.name),nodeId:node.id,path:actual.source.path});continue;
  }
  if(node.policy==='frozen-implementation'){
   if(node.baseline?.text===undefined){issues.push({code:'baseline',message:'Missing implementation baseline: '+node.name,nodeId:node.id});continue;}
   if(evidence.text!==node.baseline.text)issues.push({code:'frozen-implementation',message:'Frozen implementation changed: '+node.name,nodeId:node.id,path:actual.source.path});
  }else{
   const expected=node.baseline?.contract||node.contract;
   if(!expected||normalizeContract(actual.contract)!==normalizeContract(expected))issues.push({code:'frozen-contract',message:'Frozen interface changed: '+node.name,nodeId:node.id,path:actual.source.path});
   if(analysis.quality.diagnostics.some(d=>d.severity==='error'&&(!d.path||d.path===actual.source?.path)))issues.push({code:'unverified-contract',message:'Compiler/schema errors prevent verifying the protected interface: '+node.name,nodeId:node.id});
  }
 }
 return issues;
}
export function inScope(path:string,scope:string[]){
 return scope.some(prefix=>prefix==='.'||path===prefix||(prefix.endsWith('/')&&path.startsWith(prefix)));
}
export async function validateCandidate(project:Project,job:AgentJob):Promise<ValidationReport>{
 const before=await captureFiles(project.root);const after=await captureFiles(job.workspace);
 const issues:ValidationIssue[]=[];const warnings:string[]=[];
 const changes:FileChange[]=[];
 for(const path of Array.from(new Set([...Object.keys(before),...Object.keys(after)])).sort()){
  if(before[path]&&after[path]&&before[path].equals(after[path]))continue;
  const binary=(before[path]?.includes(0)||after[path]?.includes(0))??false;
  const encoding=binary?'base64':'utf8';
  const oldText=before[path]?.toString(encoding)??null;const newText=after[path]?.toString(encoding)??null;
  changes.push({path,kind:!before[path]?'added':!after[path]?'deleted':'modified',before:oldText,after:newText,encoding,diff:binary?'Binary file change':createTwoFilesPatch('before/'+path,'after/'+path,oldText||'',newText||'')});
  if(!inScope(path,job.scope))issues.push({code:'scope',message:'Change is outside the approved scope: '+path,path});
 }
 if(project.specRevision!==job.specRevision)issues.push({code:'stale-spec',message:'Specification changed after this task started.'});
 if(JSON.stringify(hashes(before))!==JSON.stringify(job.sourceHashes))issues.push({code:'stale-source',message:'Source changed after this task started.'});
 let candidate:Analysis|undefined;
 try{candidate=await new Analyzer().analyze(job.workspace);}
 catch(error){issues.push({code:'analysis',message:(error as Error).message});}
 if(candidate){
  issues.push(...protectionIssues(project,candidate));
  const baselineErrors=new Set(project.analysis?.quality.diagnostics.filter(d=>d.severity==='error').map(d=>d.path+':'+d.code+':'+d.message)||[]);
  for(const d of candidate.quality.diagnostics)if(d.severity==='error'&&!baselineErrors.has(d.path+':'+d.code+':'+d.message))issues.push({code:'diagnostic',message:d.message,path:d.path});
  if(candidate.quality.unresolvedReferences)warnings.push(candidate.quality.unresolvedReferences+' call targets remain unresolved.');
  if(candidate.quality.unsupportedConstructs)warnings.push(candidate.quality.unsupportedConstructs+' workflow blocks have incomplete execution-path analysis.');
  if(candidate.quality.prismaValidation==='unavailable')warnings.push('Prisma schema parsed; project-version semantic validation is not yet available.');
  const mapped=new Map<string,ProgramNode>();
  for(const node of project.specification.nodes){const actual=resolveBinding(node,candidate);if(actual)mapped.set(node.id,actual);}
  for(const node of project.specification.nodes){
   if(node.kind==='function'||node.kind==='class'||node.kind==='interface'||node.kind==='entity'){
    const actual=mapped.get(node.id);
    const relevant=node.source&&changes.some(c=>c.path===node.source?.path)||!node.source;
    if(relevant&&(!actual||node.contract.trim()&&normalizeContract(actual.contract)!==normalizeContract(node.contract)))issues.push({code:'specification',message:!actual?'Required item is missing or has an ambiguous binding: '+node.name:'Declared interface/model differs: '+node.name,nodeId:node.id});
   }
  }
  for(const kind of ['depends-on','calls'] as const){
   const declared=project.specification.edges.filter(e=>e.kind===kind);
   const constrained=new Set(declared.map(e=>e.source));
   for(const nodeId of constrained){
    const actual=mapped.get(nodeId);if(!actual)continue;
    const allowed=new Set(declared.filter(e=>e.source===nodeId).map(e=>mapped.get(e.target)?.id).filter(Boolean));
    for(const edge of candidate.graph.edges.filter(e=>e.kind===kind&&e.source===actual.id)){
     if(edge.uncertain){warnings.push('Dependency cannot be resolved for '+actual.name);continue;}
     if(!allowed.has(edge.target))issues.push({code:'dependency',message:'Undeclared '+kind+' relationship from '+actual.name,nodeId});
    }
   }
  }
 }
 const required=new Set(project.specification.nodes.flatMap(n=>n.requiredChecks));
 for(const id of required)if(!project.checks[id])issues.push({code:'required-check',message:'Required check is not configured: '+id});
 return {passed:issues.length===0,issues,warnings,checks:{},changes,candidate};
}
type Journal={state:'applying'|'committed'|'rolled-back'|'conflict';root:string;changes:FileChange[];jobId:string};
async function writeChange(root:string,change:FileChange,side:'before'|'after'){
 const target=await safePath(root,change.path);const content=change[side];
 if(content===null){await rm(target,{force:true});return;}
 await mkdir(dirname(target),{recursive:true});
 const temp=target+'.architect-'+randomUUID()+'.tmp';
 await writeFile(temp,Buffer.from(content,change.encoding||'utf8'));
 await rename(temp,target);
}
async function rollback(journal:Journal){
 let conflict=false;
 for(const change of [...journal.changes].reverse()){
  const target=await safePath(journal.root,change.path);
  let current:Buffer|null=null;try{current=await readFile(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const expected=change.after===null?null:Buffer.from(change.after,change.encoding||'utf8');
  const old=change.before===null?null:Buffer.from(change.before,change.encoding||'utf8');
  if(current===null&&old===null||current&&old&&current.equals(old))continue;
  if(current===null&&expected===null||current&&expected&&current.equals(expected))await writeChange(journal.root,change,'before');
  else conflict=true;
 }journal.state=conflict?'conflict':'rolled-back';
}
export async function applyReviewed(store:ProjectStore,job:AgentJob){
 return store.transaction(job.projectId,async()=>{
  const p=await store.get(job.projectId);
  if(JSON.stringify(hashes(await captureFiles(p.root)))!==JSON.stringify(job.sourceHashes))throw new AppError('Source changed. Generate or import a new candidate.',409);
  if(p.specRevision!==job.specRevision)throw new AppError('Specification changed. Generate a new candidate.',409);
  if(job.status!=='review'||!job.report?.passed)throw new AppError('This candidate has not passed review validation.');
  const fresh=await validateCandidate(p,job);
  if(!fresh.passed)throw new AppError('Candidate no longer passes validation.');
  if(JSON.stringify(fresh.changes)!==JSON.stringify(job.report.changes))throw new AppError('Candidate changed after validation. Revalidate and review it again.',409);
  for(const id of new Set(p.specification.nodes.flatMap(n=>n.requiredChecks)))if(!job.report.checks[id]?.passed)throw new AppError('Required check did not pass: '+id);
  const path=join(store.projectDir(p.id),'recovery',job.id+'.json');
  const journal:Journal={state:'applying',root:p.root,changes:fresh.changes,jobId:job.id};await atomicJson(path,journal);
  try{
   for(const change of fresh.changes){
    const target=await safePath(p.root,change.path);
    let current:string|null=null;try{current=(await readFile(target)).toString(change.encoding||'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(current!==change.before)throw new AppError('Source changed during application: '+change.path,409);
    await writeChange(p.root,change,'after');
   }
   journal.state='committed';await atomicJson(path,journal);
   job.status='applied';await store.saveJob(job);
  }catch(error){await rollback(journal);await atomicJson(path,journal);throw error;}
 });
}
export async function recoverPending(store:ProjectStore){
 const conflicts:string[]=[];
 for(const p of await store.list()){
  const dir=join(store.projectDir(p.id),'recovery');let entries:string[]=[];
  try{entries=await readdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const file of entries.filter(n=>n.endsWith('.json'))){
   const path=join(dir,file);const journal:Journal=JSON.parse(await readFile(path,'utf8'));
   if(journal.state==='applying'){await rollback(journal);await atomicJson(path,journal);}
   if(journal.state==='conflict')conflicts.push(p.name+': '+journal.jobId);
  }
 }return conflicts;
}
