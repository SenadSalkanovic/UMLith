import React, {useEffect, useRef, useState} from 'react';
import {GraphSchema, createNodeId, validRelationship, type Graph, type ProgramNode} from '../../shared/model';
import {ownerId} from '../../shared/plantuml';
import {createArchitectureNode} from './ArchitectureEditor';
import {createWorkflowStep, findOwningFunction} from './WorkflowEditor';
import {updateDesignField, updateDesignNode} from '../editor-commands';

type Choice = 'class'|'interface'|'entity'|'enum'|'module'|'system'|'function'|'field'|'parameter'|'step'|'requirement';
export interface DiagramAddTarget {ownerId:string|null;kind?:Choice;x:number;y:number}
export function DiagramAddMenu({graph,target,scopeId,onApply,onClose}:{graph:Graph;target:DiagramAddTarget;scopeId:string|null;onApply:(graph:Graph,selectedId:string)=>void;onClose:()=>void}) {
  const owner=graph.nodes.find(node=>node.id===target.ownerId);
  const [kind,setKind]=useState<Choice|undefined>(target.kind),[name,setName]=useState(''),[type,setType]=useState(''),[error,setError]=useState('');
  const [stepType,setStepType]=useState<NonNullable<ProgramNode['stepType']>>('operation');
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;host.current?.querySelector<HTMLElement>('input,button')?.focus();const dismiss=(event:PointerEvent)=>{if(!host.current?.contains(event.target as Node))onClose();};document.addEventListener('pointerdown',dismiss);return()=>{document.removeEventListener('pointerdown',dismiss);previous?.focus();};},[onClose]);
  useEffect(()=>{host.current?.querySelector<HTMLInputElement>('input')?.focus();},[kind]);
  const label=(choice:Choice)=>choice==='function'?(owner&&['class','interface'].includes(owner.kind)?'Method':'Function'):choice==='entity'?'Table':choice==='field'?(owner?.kind==='entity'?'Field':'Attribute'):choice[0].toUpperCase()+choice.slice(1);
  const choices:Choice[]=owner?.kind==='function'?['parameter','step','requirement']:owner?.kind==='step'?['step','requirement']:owner&&['class','interface','entity','enum'].includes(owner.kind)?[...(owner.kind==='class'||owner.kind==='interface'?['field','function'] as Choice[]:['field'] as Choice[]),...(owner.kind==='entity'?['entity'] as Choice[]:['class','interface','enum'] as Choice[]),'requirement']:['class','interface','entity','enum','function','module',...(owner?[]:['system'] as Choice[])];
  function submit(event:React.FormEvent){
    event.preventDefault();setError('');
    try{
      if(!kind||!name.trim())throw new Error('Enter a name.');
      let next:Graph,selection=owner?.id||'';
      if(kind==='field'){
        if(!owner)throw new Error('Choose a class or table first.');
        next=updateDesignField(graph,owner.id,null,{name,type:type.trim()||'unknown',key:'',optional:false});
      }else if(kind==='parameter'){
        if(owner?.kind!=='function')throw new Error('Choose a method first.');
        if(owner.signature?.parameters.some(parameter=>parameter.name===name.trim()))throw new Error('A parameter with this name already exists.');
        next=updateDesignNode(graph,owner.id,{signature:{...owner.signature,parameters:[...(owner.signature?.parameters||[]),{name:name.trim(),...(type.trim()?{type:type.trim()}:{})}]}});
      }else if(kind==='step'){
        const fn=owner&&findOwningFunction(graph,owner.id);
        if(!fn)throw new Error('Open a method to add a flow step.');
        const result=createWorkflowStep(graph,{functionId:fn.id,name,stepType,parentStepId:owner?.kind==='step'&&['loop','try'].includes(owner.stepType||'')?owner.id:undefined});
        next=result.graph;selection=next.nodes.find(node=>!graph.nodes.some(old=>old.id===node.id))!.id;
      }else if(kind==='requirement'){
        if(!owner)throw new Error('Choose an item for this requirement.');
        next=GraphSchema.parse({...graph,requirements:[...graph.requirements,{id:createNodeId(),text:name,nodeIds:[owner.id],edgeIds:[],constraints:[],scenarios:[]}]});
      }else{
        const parent=kind==='function'?owner:owner&&['module','system'].includes(owner.kind)?owner:graph.nodes.find(node=>node.id===(owner?ownerId(graph,owner):scopeId));
        const result=createArchitectureNode(graph,{kind,name,parentId:parent&&validRelationship('contains',parent.kind,kind)?parent.id:undefined});
        next=result.graph;selection=result.node.id;
      }
      onApply(next,selection);onClose();
    }catch(error){setError(error instanceof Error?error.message:String(error));}
  }
  return <div ref={host} className="diagram-add-menu" role="dialog" aria-label={kind?`Add ${label(kind).toLowerCase()}`:`Add beside ${owner?.name||'design'}`} style={{left:Math.max(12,Math.min(target.x,window.innerWidth-292)),top:Math.min(target.y,Math.max(12,window.innerHeight-360))}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}if(event.key==='Tab'){const items=Array.from(host.current?.querySelectorAll<HTMLElement>('button,input,select')||[]).filter(element=>!element.hasAttribute('disabled'));if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}}}}>
    <header><strong>{kind?`Add ${label(kind).toLowerCase()}`:owner?`Add to ${owner.name}`:'Start your design'}</strong><button aria-label="Close add menu" onClick={onClose}>×</button></header>
    {!kind?<div className="diagram-add-choices">{choices.map(choice=><button key={choice} onClick={()=>setKind(choice)}><span>+</span>{label(choice)}{owner&&['class','interface','entity','enum'].includes(owner.kind)&&['class','interface','entity','enum'].includes(choice)&&<small>beside this item</small>}</button>)}</div>:<form onSubmit={submit}>
      <label>{kind==='requirement'?'Requirement':'Name'}<input value={name} onChange={event=>setName(event.target.value)} autoComplete="off"/></label>
      {(kind==='field'||kind==='parameter')&&<label>Type <span>(optional)</span><input value={type} onChange={event=>setType(event.target.value)} placeholder="e.g. String"/></label>}
      {kind==='step'&&<label>Step type<select value={stepType} onChange={event=>setStepType(event.target.value as typeof stepType)}>{['operation','call','condition','loop','try','throw','return'].map(value=><option key={value}>{value}</option>)}</select></label>}
      {error&&<p role="alert">{error}</p>}<footer><button type="button" onClick={()=>{setKind(undefined);setError('');}}>Back</button><button className="btn-primary" type="submit">Add {label(kind).toLowerCase()}</button></footer>
    </form>}
  </div>;
}
