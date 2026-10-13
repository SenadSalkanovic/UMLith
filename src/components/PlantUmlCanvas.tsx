import React, {useEffect,useMemo,useRef,useState,useCallback} from 'react';
import {Plus,ZoomIn,ZoomOut,Maximize2,Download,Code2,ArrowLeft} from 'lucide-react';
import {renderDiagram} from '../api';
import {graphToPlantUml,visibleDesignNodes,ownerId,displayMethod} from '../../shared/plantuml';
import {DiagramAddMenu, type DiagramAddTarget} from './DiagramAddMenu';
import type {GraphCanvasProps} from './GraphCanvas';

function diagramSvg(raw:string,graph:NonNullable<GraphCanvasProps['graph']>,selectedId:string|null,editable=false) {
  if(typeof DOMParser==='undefined')return '';
  const document=new DOMParser().parseFromString(raw,'image/svg+xml');
  const svg=document.documentElement;
  if(svg.tagName!=='svg')return '';
  const allowed=new Set(['svg','g','a','rect','path','text','tspan','line','polygon','polyline','ellipse','circle','defs','marker','title','desc']);
  for(const element of Array.from(svg.querySelectorAll('*'))) {
    if(!allowed.has(element.localName)){element.remove();continue;}
    for(const attribute of Array.from(element.attributes)) {
      if(attribute.name.toLowerCase().startsWith('on')||attribute.name==='style'&&/url\s*\(/i.test(attribute.value))element.removeAttribute(attribute.name);
      if(['href','xlink:href'].includes(attribute.name)&&!attribute.value.startsWith('umlith://'))element.removeAttribute(attribute.name);
    }
  }
  for(const anchor of Array.from(svg.querySelectorAll('a'))) {
    const href=anchor.getAttribute('href')||anchor.getAttribute('xlink:href');
    if(!href?.startsWith('umlith://')){anchor.removeAttribute('href');anchor.removeAttribute('xlink:href');continue;}
    const link=new URL(href),[id,field]=link.pathname.slice(1).split('/').map(decodeURIComponent);
    const node=graph.nodes.find(node=>node.id===id),edge=graph.edges.find(edge=>edge.id===id);
    if(!node&&!edge){anchor.remove();continue;}
    const owner=node&&graph.nodes.find(parent=>parent.id===ownerId(graph,node));
    anchor.removeAttribute('target');anchor.setAttribute('tabindex','0');anchor.setAttribute('role','button');
    anchor.setAttribute('aria-label',link.hostname==='field'?`Edit ${node?.name}.${field}`:edge?`Edit relationship ${edge.kind}`:node?.kind==='function'?`Open method ${owner?owner.name+'.':''}${displayMethod(node)}`:`Select ${node?.name}`);
    const isStatic=link.hostname==='field'?node?.fields.find(value=>value.name===field)?.isStatic:node?.isStatic;
    for(const label of Array.from(anchor.querySelectorAll('text')))label.setAttribute('text-decoration',isStatic?'underline':'none');
    if(id===selectedId){anchor.setAttribute('data-selected','true');for(const label of Array.from(anchor.querySelectorAll('text')))label.setAttribute('fill','#FF3D00');}
  }
  if(editable){
    const controls:Element[]=[];const fieldOwners=new Set<string>();
    const bounds=(anchor:Element)=>{
      const rect=anchor.querySelector('rect');
      if(rect)return {x:Number(rect.getAttribute('x')),y:Number(rect.getAttribute('y')),width:Number(rect.getAttribute('width')),height:Number(rect.getAttribute('height'))};
      const shape=anchor.querySelector('polygon,path');if(!shape)return null;
      const values=(shape.getAttribute('points')||shape.getAttribute('d')||'').match(/-?\d+(?:\.\d+)?/g)?.map(Number);if(!values?.length)return null;
      const xs=values.filter((_,index)=>index%2===0),ys=values.filter((_,index)=>index%2===1);
      return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
    };
    const occupied=Array.from(svg.querySelectorAll('a')).filter(anchor=>(anchor.getAttribute('href')||'').startsWith('umlith://node/')).map(bounds).filter((box):box is NonNullable<typeof box>=>!!box);
    const add=(id:string,kind:string,x:number,y:number,label:string,ownerBox:{x:number;y:number;width:number;height:number})=>{
      const overlaps=(left:number,top:number)=>occupied.some(box=>left<box.x+box.width+2&&left+22>box.x-2&&top<box.y+box.height+2&&top+18>box.y-2);
      const candidates=[[x,y],[ownerBox.x-28,y],[ownerBox.x+ownerBox.width-22,ownerBox.y-24],[ownerBox.x+ownerBox.width-22,ownerBox.y+ownerBox.height+6]];
      const free=candidates.find(([left,top])=>!overlaps(left,top));
      if(free)[x,y]=free;else {x=ownerBox.x+ownerBox.width+6;while(overlaps(x,y))x+=28;}
      occupied.push({x,y,width:22,height:18});
      const button=document.createElementNS(svg.namespaceURI,'a');
      button.setAttribute('href',`umlith://add/${encodeURIComponent(id)}/${kind}`);button.setAttribute('role','button');button.setAttribute('tabindex','0');button.setAttribute('aria-label',label);button.setAttribute('class','diagram-plus');
      const box=document.createElementNS(svg.namespaceURI,'rect');for(const [name,value]of Object.entries({x,y,width:22,height:18,rx:3,fill:'#171717',stroke:'#A3A3A3'}))box.setAttribute(name,String(value));
      const mark=document.createElementNS(svg.namespaceURI,'text');for(const [name,value]of Object.entries({x:x+11,y:y+14,'text-anchor':'middle','font-size':20,fill:'#FAFAFA'}))mark.setAttribute(name,String(value));mark.textContent='+';
      button.append(box,mark);controls.push(button);
    };
    for(const anchor of Array.from(svg.querySelectorAll('a'))){
      const href=anchor.getAttribute('href');if(!href)continue;const link=new URL(href),id=decodeURIComponent(link.pathname.split('/')[1]||'');const node=graph.nodes.find(node=>node.id===id);if(!node)continue;
      const box=bounds(anchor),groupBox=bounds(anchor.parentElement!),text=anchor.querySelector('text');
      if(link.hostname==='node'&&box)add(id,'',box.x+box.width+6,box.y+2,`Add to ${node.name}`,box);
      else if(link.hostname==='node'&&node.kind==='function'&&groupBox&&text)add(id,'',groupBox.x+groupBox.width+6,Number(text.getAttribute('y'))-16,`Add parameter or flow step to ${node.name}`,groupBox);
      else if(link.hostname==='field'&&!fieldOwners.has(id)&&groupBox&&text){fieldOwners.add(id);add(id,'field',groupBox.x+groupBox.width+6,Number(text.getAttribute('y'))-16,`Add ${node.kind==='entity'?'field':'attribute'} to ${node.name}`,groupBox);}
    }
    svg.append(...controls);
    const original=(svg.getAttribute('viewBox')||`0 0 ${parseFloat(svg.getAttribute('width')||'0')} ${parseFloat(svg.getAttribute('height')||'0')}`).split(/[ ,]+/).map(Number);
    const left=Math.min(original[0],...occupied.map(box=>box.x-4)),top=Math.min(original[1],...occupied.map(box=>box.y-4));
    const width=Math.max(original[0]+original[2],...occupied.map(box=>box.x+box.width+4))-left,height=Math.max(original[1]+original[3],...occupied.map(box=>box.y+box.height+4))-top;
    svg.setAttribute('viewBox',`${left} ${top} ${width} ${height}`);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.removeAttribute('style');
  }
  return new XMLSerializer().serializeToString(svg);
}
function download(text:string,name:string,type:string) {
  const object=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=object;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(object),1000);
}
export function PlantUmlCanvas({graph,viewState,onSelectNode,onSelectEdge,onSelectField,onConnectNodes,onCanvasEdit,creationDisabled,onScopeChange,onOpenArchitectureEditor,apiBaseUrl,readOnly,projectId}:GraphCanvasProps) {
  const [svg,setSvg]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[sourceOpen,setSourceOpen]=useState(false),[zoom,setZoom]=useState(1),[retry,setRetry]=useState(0),[showMembers,setShowMembers]=useState(true);
  const [addTarget,setAddTarget]=useState<DiagramAddTarget|null>(null);
  const closeAdd=useCallback(()=>setAddTarget(null),[]);
  useEffect(closeAdd,[projectId,viewState.designView,viewState.activeScope,readOnly,creationDisabled,closeAdd]);
  const openAdd=(event:React.MouseEvent,ownerId:string|null)=>{const box=event.currentTarget.getBoundingClientRect();setAddTarget({ownerId,x:Math.max(12,box.left),y:box.bottom+8});};
  const drag=useRef<{id:string;x:number;y:number}|null>(null),suppressClick=useRef(false);
  const host=useRef<HTMLDivElement>(null),drawing=useRef<HTMLDivElement>(null);
  const positions=useRef<Record<string,{zoom:number;left:number;top:number}>>({});
  const key=`${projectId}:${viewState.workspace}:${viewState.graphContext}:${viewState.designView}:${viewState.activeScope}:${viewState.flowchartId}`;
  const request=useMemo(()=>graph?{graph,view:viewState.designView||'classes' as const,scopeId:viewState.activeScope,functionId:viewState.flowchartId,selectedId:viewState.selectedId,showMembers}:null,[graph,viewState.designView,viewState.activeScope,viewState.flowchartId,viewState.selectedId,showMembers]);
  const source=useMemo(()=>request?graphToPlantUml(request):'',[request]);
  const visible=useMemo(()=>graph?visibleDesignNodes(graph,viewState.designView||'classes',viewState.activeScope,viewState.flowchartId):[],[graph,viewState.designView,viewState.activeScope,viewState.flowchartId]);
  const scope=graph?.nodes.find(node=>node.id===viewState.activeScope);
  const changeZoom=(next:number)=>{setZoom(next);positions.current[key]={zoom:next,left:host.current?.scrollLeft||0,top:host.current?.scrollTop||0};};
  const fit=()=>{const svg=drawing.current?.querySelector('svg');if(!svg||!host.current)return;const width=parseFloat(svg.getAttribute('width')||'800'),height=parseFloat(svg.getAttribute('height')||'600');const next=Math.min(1.3,Math.max(.1,Math.min((host.current.clientWidth-40)/width,(host.current.clientHeight-40)/height)));setZoom(next);positions.current[key]={zoom:next,left:0,top:0};host.current.scrollTo(0,0);};
  useEffect(()=>{if(!request||!visible.length){setSvg('');setError('');setLoading(false);return;}const controller=new AbortController();let cancelled=false;setLoading(true);setError('');const timer=setTimeout(()=>{renderDiagram(request,apiBaseUrl,controller.signal).then(result=>{if(!cancelled)setSvg(result.svg);}).catch(error=>{if(!cancelled)setError(error.message);}).finally(()=>{if(!cancelled)setLoading(false);});},250);return()=>{cancelled=true;clearTimeout(timer);controller.abort();};},[source,apiBaseUrl,retry]);
  useEffect(()=>{if(!svg)return;const saved=positions.current[key];if(saved){setZoom(saved.zoom);host.current?.scrollTo(saved.left,saved.top);}else fit();},[svg,key]);
  const safeSvg=useMemo(()=>graph?diagramSvg(svg,graph,viewState.selectedId,!!onCanvasEdit&&!readOnly&&!creationDisabled):'',[svg,graph,viewState.selectedId,onCanvasEdit,readOnly,creationDisabled]);
  const select=(event:React.MouseEvent|React.KeyboardEvent)=>{if(suppressClick.current){suppressClick.current=false;event.preventDefault();return;}const anchor=(event.target as Element).closest('a');if(!anchor)return;const href=anchor.getAttribute('href')||anchor.getAttribute('xlink:href');event.preventDefault();if(!href?.startsWith('umlith://'))return;const link=new URL(href),[id,field]=link.pathname.slice(1).split('/').map(decodeURIComponent);if(link.hostname==='add'){if(!readOnly&&!creationDisabled){const box=anchor.getBoundingClientRect();setAddTarget({ownerId:id,kind:(field||undefined) as DiagramAddTarget['kind'],x:Math.max(12,box.right+8),y:box.top});}}else if(link.hostname==='edge')onSelectEdge?.(id);else if(link.hostname==='field')onSelectField?.(id,field);else onSelectNode(id);};
  const linkedNode=(target:EventTarget)=>{const anchor=target instanceof Element?target.closest('a'):null;const href=anchor?.getAttribute('href')||anchor?.getAttribute('xlink:href');if(!href?.startsWith('umlith://node/'))return null;return decodeURIComponent(new URL(href).pathname.slice(1));};
  const beginConnection=(event:React.PointerEvent)=>{if(readOnly||!onConnectNodes||event.button!==0)return;const id=linkedNode(event.target);if(id)drag.current={id,x:event.clientX,y:event.clientY};};
  const endConnection=(event:React.PointerEvent)=>{const start=drag.current;drag.current=null;if(!start||Math.hypot(event.clientX-start.x,event.clientY-start.y)<8)return;const target=linkedNode(event.target);if(target){suppressClick.current=true;onConnectNodes?.(start.id,target);}};
  return <section className="panel plantuml-panel" aria-label="Scoped Canvas" data-testid="scoped-canvas-panel">
    <header className="panel-header canvas-header"><div className="scope-indicator">{scope&&<button className="btn btn-outline" onClick={()=>onScopeChange(scope.parentId||null)}><ArrowLeft size={14}/>Back</button>}<strong>{viewState.flowchartId?`${scope?.name||'Method'} · Flowchart`:scope?.name||'Project design'}</strong><span className="scope-count">{visible.length} elements</span></div><div className="canvas-header-actions"><span className="plantuml-credit" title="Drag between items to choose a relationship, or use Connect in Details.">PlantUML</span>{!readOnly&&onCanvasEdit&&<button className="btn btn-outline" disabled={creationDisabled} onClick={event=>openAdd(event,viewState.flowchartId||viewState.activeScope)}><Plus size={14}/>Add</button>}</div></header>
    <div className="plantuml-tools"><button className="btn btn-outline" aria-label="Zoom out" onClick={()=>changeZoom(Math.max(.1,zoom/1.2))}><ZoomOut size={15}/></button><span>{Math.round(zoom*100)}%</span><button className="btn btn-outline" aria-label="Zoom in" onClick={()=>changeZoom(Math.min(4,zoom*1.2))}><ZoomIn size={15}/></button><button className="btn btn-outline" onClick={fit}><Maximize2 size={15}/>Fit</button><span className="toolbar-spacer"/>{!viewState.flowchartId&&viewState.designView!=='overview'&&<button className="btn btn-outline" aria-pressed={showMembers} onClick={()=>setShowMembers(value=>!value)}>{showMembers?'Hide members':'Show members'}</button>}<button className="btn btn-outline" onClick={()=>setSourceOpen(value=>!value)} aria-pressed={sourceOpen}><Code2 size={15}/>PlantUML source</button><button className="btn btn-outline" disabled={!source} onClick={()=>download(source,`${viewState.flowchartId?'method-flow':viewState.designView}.puml`,'text/plain')}><Download size={15}/>.puml</button><button className="btn btn-outline" disabled={!safeSvg||loading} onClick={()=>download(diagramSvg(svg,graph!,viewState.selectedId),`${viewState.flowchartId?'method-flow':viewState.designView}.svg`,'image/svg+xml')}><Download size={15}/>SVG</button></div>
    {loading&&<p className="plantuml-status" role="status">Updating local PlantUML diagram…</p>}{error&&<div className="canvas-error-banner" role="alert"><span>{error}</span><button className="btn btn-outline" onClick={()=>setRetry(value=>value+1)}>Retry</button></div>}
    {!visible.length?<div className="canvas-empty-state"><h2>{viewState.flowchartId?'Describe it first.':'Start with your design.'}</h2><p>{viewState.flowchartId?'A flowchart is optional. Use + to add your first step.':'Use + to choose your first item. Add fields and methods directly beside it.'}</p>{!readOnly&&onCanvasEdit&&<button className="btn btn-primary canvas-first-add" disabled={creationDisabled} onClick={event=>openAdd(event,viewState.flowchartId||viewState.activeScope)}><Plus size={20}/>Add your first {viewState.flowchartId?'step':viewState.designView==='database'?'table':viewState.designView==='overview'?'component':'class'}</button>}</div>:<div className="plantuml-viewport" ref={host} onScroll={event=>{positions.current[key]={zoom,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};}}><div ref={drawing} className={`plantuml-drawing ${loading?'is-updating':''}`} onPointerDown={beginConnection} onPointerUp={endConnection} onPointerCancel={()=>{drag.current=null;}} onDragStart={event=>event.preventDefault()} onClick={select} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){select(event);}}} style={{zoom}} dangerouslySetInnerHTML={{__html:safeSvg}}/></div>}
    {addTarget&&graph&&onCanvasEdit&&!readOnly&&!creationDisabled&&<DiagramAddMenu graph={graph} target={addTarget} scopeId={viewState.activeScope} onApply={onCanvasEdit} onClose={closeAdd}/>}
    {sourceOpen&&<details open className="plantuml-source"><summary>Generated from the current design · {loading?'rendering':'local renderer'}</summary><textarea readOnly value={source} aria-label="PlantUML source" spellCheck={false}/></details>}
  </section>;
}
