import {zipSync,strToU8} from 'fflate';
import type {Project} from '../shared/model';
export function bundleFiles(project:Project,task:string,scope:string[]){
 const graph=structuredClone(project.specification);
 for(const node of graph.nodes){if(node.source)node.source={...node.source,path:node.source.path};}
 const blueprint={schemaVersion:1,project:{id:project.id,name:project.name,target:project.target,description:project.description},revision:project.specRevision,graph,scope,sourceRevision:project.analysis?.revision||null};
 const sections=graph.nodes.map(n=>[
  '## '+n.name+' ('+n.kind+')',
  n.description||'Description has not been specified.',
  'Policy: '+n.policy,
  n.contract?'Interface:\n\n    '+n.contract.replaceAll('\n','\n    '):'',
  n.inputs?'Inputs: '+n.inputs:'',n.outputs?'Outputs: '+n.outputs:'',
  n.rules?'Rules: '+n.rules:'',n.errors?'Errors: '+n.errors:'',
  n.instructions?'Care instructions: '+n.instructions:'',
  n.fields.length?'Fields:\n'+n.fields.map(f=>'- '+f.name+': '+f.type+(f.optional?' (optional)':'')+(f.key?' ['+f.key+']':'')).join('\n'):'',
  n.scenarios?.length?'Acceptance scenarios:\n'+n.scenarios.map(s=>'- '+s).join('\n'):'',
  n.requiredChecks.length?'Required checks: '+n.requiredChecks.join(', '):'',
  n.outputPath?'Output boundary: '+n.outputPath:'',
  n.source?'Source binding: '+n.source.path+(n.source.symbol?' :: '+n.source.symbol:''):'',
 ].filter(Boolean).join('\n\n'));
 const requirements=graph.requirements.map(r=>[
  '### '+r.id, r.text,
  r.nodeIds.length?'Graph nodes: '+r.nodeIds.join(', '):'',
  r.edgeIds.length?'Graph relationships: '+r.edgeIds.join(', '):'',
  r.constraints.length?'Constraints:\n'+r.constraints.map(s=>'- '+s).join('\n'):'',
  r.scenarios.length?'Acceptance scenarios:\n'+r.scenarios.map(s=>'- '+s).join('\n'):'',
 ].filter(s=>s!=='').join('\n\n'));
 const taskText=[
 '# Coding-agent task',task,
 'Read specification.json and ARCHITECTURE.md. The human-owned specification is authoritative.',
 'Target: '+project.target,
 'Allowed changes: '+scope.join(', ')+'. A trailing slash denotes a directory prefix; "." denotes the complete included project.',
 'Implement in this workspace. Preserve frozen implementations exactly and frozen interfaces structurally. Follow sensitive-area instructions and acceptance scenarios.',
 'Do not edit the specification, protection baselines, or task scope. If they prevent the task, explain the conflict and stop.',
 'Preserve existing repository instructions. Add tests for required behavior. Do not claim that tests prove every prose requirement.',
 'Missing function details and workflows are unspecified; supplied details and scenarios do not prove implementation completeness.',
 'Return a concise implementation summary and any unresolved requirements. Code will be independently analyzed and reviewed before application.',
 ].join('\n\n');
 return {'specification.json':JSON.stringify(blueprint,null,2),'ARCHITECTURE.md':['# '+project.name,'Target: '+project.target,project.description,...sections,...(requirements.length?['## Requirements',...requirements]:[]),'## Relationships',...graph.edges.map(e=>'- '+e.source+' '+e.kind+' '+e.target+(e.label?' ('+e.label+')':''))].join('\n\n'),'AGENT_TASK.md':taskText,'IMPORT_REPORT.json':JSON.stringify(project.analysis?.quality||{message:'No source has been analyzed.'},null,2)};
}
export function exportBundle(project:Project,task:string,scope:string[]){
 return zipSync(Object.fromEntries(Object.entries(bundleFiles(project,task,scope)).map(([path,text])=>[path,strToU8(text)])));
}
