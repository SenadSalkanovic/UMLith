import { GraphSchema, type Graph, type ProgramNode, type NodeField } from '../shared/model';
import { removeArchitectureNode } from './components/ArchitectureEditor';
import { removeWorkflowStep, removeFunctionWorkflow } from './components/WorkflowEditor';

export function previewDesignRemoval(graph:Graph,nodeId:string,workflowOnly=false) {
  const node=graph.nodes.find(n=>n.id===nodeId);
  if(!node)throw new Error('Selected object no longer exists');
  const next=workflowOnly?removeFunctionWorkflow(graph,nodeId).graph:node.kind==='step'?removeWorkflowStep(graph,nodeId).graph:removeArchitectureNode(node.kind==='function'?removeFunctionWorkflow(graph,nodeId).graph:graph,nodeId).graph;
  const remainingIds=new Set(next.nodes.map(n=>n.id));
  const remainingEdges=new Set(next.edges.map(e=>e.id));
  return {graph:next,affectedNode:node,removedNodes:graph.nodes.filter(n=>!remainingIds.has(n.id)),removedEdges:graph.edges.filter(e=>!remainingEdges.has(e.id)),reparentedNodes:next.nodes.filter(n=>n.parentId!==graph.nodes.find(before=>before.id===n.id)?.parentId),referencingRequirements:graph.requirements.filter(req=>JSON.stringify(req)!==JSON.stringify(next.requirements.find(after=>after.id===req.id)))};
}

export function updateDesignNode(graph:Graph,id:string,updates:Partial<ProgramNode>):Graph {
  if (!graph.nodes.some(n=>n.id===id)) throw new Error('Selected object no longer exists');
  if(updates.name!==undefined && !updates.name.trim()) throw new Error('Name must not be blank');
  const existing=graph.nodes.find(n=>n.id===id)!;
  const updatedFields=updates.fields??existing.fields;
  if(new Set(updatedFields.map(f=>f.name)).size!==updatedFields.length) throw new Error('Field already exists');
  for(const key of [...(updates.compositeKeys??existing.compositeKeys??[]),...(updates.indexes??existing.indexes??[])]) {
    const fields=updates.fields??graph.nodes.find(n=>n.id===id)!.fields;
    if(!key.fields.length || new Set(key.fields).size!==key.fields.length || key.fields.some(name=>!fields.some(f=>f.name===name))) throw new Error('Key must reference distinct existing fields');
  }
  return GraphSchema.parse({...graph,nodes:graph.nodes.map(n=>n.id===id?{...n,...updates,id:n.id,name:updates.name?.trim()??n.name}:n)});
}

export function updateDesignField(graph:Graph,ownerId:string,fieldIdentifier:number|string|null,field:NodeField):Graph {
  const owner=graph.nodes.find(n=>n.id===ownerId);
  if(!owner) throw new Error('Field owner no longer exists');
  const index=typeof fieldIdentifier==='string'?owner.fields.findIndex(f=>f.name===fieldIdentifier):fieldIdentifier;
  if(index!==null && (index<0 || index>=owner.fields.length))throw new Error('Field no longer exists; reopen the current field before editing');
  if(!field.name.trim() || !field.type.trim()) throw new Error('Field name and type must not be blank');
  if(owner.fields.some((f,i)=>i!==index && f.name===field.name.trim())) throw new Error('Field already exists');
  const fields=[...owner.fields];
  const next={...field,name:field.name.trim(),type:field.type.trim()};
  if(index===null) fields.push(next); else fields[index]=next;
  // Typed references are schema validated: a referenced rename is rejected atomically.
  return updateDesignNode(graph,ownerId,{fields});
}
