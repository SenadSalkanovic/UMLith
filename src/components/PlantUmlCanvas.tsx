import React, {useEffect,useMemo,useRef,useState} from 'react';
import {Plus,ZoomIn,ZoomOut,Maximize2,Download,Code2,ArrowLeft} from 'lucide-react';
import {renderDiagram} from '../api';
import {graphToPlantUml,visibleDesignNodes,ownerId,displayMethod} from '../../shared/plantuml';
import type {GraphCanvasProps} from './GraphCanvas';

function diagramSvg(raw:string,graph:NonNullable<GraphCanvasProps['graph']>,selectedId:string|null) {
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
  return new XMLSerializer().serializeToString(svg);
}
function download(text:string,name:string,type:string) {
  const object=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=object;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(object),1000);
}
export function PlantUmlCanvas({graph,viewState,onSelectNode,onSelectEdge,onSelectField,onConnectNodes,onScopeChange,onOpenArchitectureEditor,apiBaseUrl,readOnly,projectId}:GraphCanvasProps) {
  const [svg,setSvg]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[sourceOpen,setSourceOpen]=useState(false),[zoom,setZoom]=useState(1),[retry,setRetry]=useState(0);
  const drag=useRef<{id:string;x:number;y:number}|null>(null),suppressClick=useRef(false);
  const host=useRef<HTMLDivElement>(null),drawing=useRef<HTMLDivElement>(null);
  const positions=useRef<Record<string,{zoom:number;left:number;top:number}>>({});
  const key=`${projectId}:${viewState.workspace}:${viewState.graphContext}:${viewState.designView}:${viewState.activeScope}:${viewState.flowchartId}`;
  const request=useMemo(()=>graph?{graph,view:viewState.designView||'classes' as const,scopeId:viewState.activeScope,functionId:viewState.flowchartId,selectedId:viewState.selectedId}:null,[graph,viewState.designView,viewState.activeScope,viewState.flowchartId,viewState.selectedId]);
  const source=useMemo(()=>request?graphToPlantUml(request):'',[request]);
  const visible=useMemo(()=>graph?visibleDesignNodes(graph,viewState.designView||'classes',viewState.activeScope,viewState.flowchartId):[],[graph,viewState.designView,viewState.activeScope,viewState.flowchartId]);
  const scope=graph?.nodes.find(node=>node.id===viewState.activeScope);
  const changeZoom=(next:number)=>{setZoom(next);positions.current[key]={zoom:next,left:host.current?.scrollLeft||0,top:host.current?.scrollTop||0};};
  const fit=()=>{const svg=drawing.current?.querySelector('svg');if(!svg||!host.current)return;const width=parseFloat(svg.getAttribute('width')||'800'),height=parseFloat(svg.getAttribute('height')||'600');const next=Math.min(1.3,Math.max(.1,Math.min((host.current.clientWidth-40)/width,(host.current.clientHeight-40)/height)));setZoom(next);positions.current[key]={zoom:next,left:0,top:0};host.current.scrollTo(0,0);};
  useEffect(()=>{if(!request||!visible.length){setSvg('');setError('');setLoading(false);return;}const controller=new AbortController();let cancelled=false;setLoading(true);setError('');const timer=setTimeout(()=>{renderDiagram(request,apiBaseUrl,controller.signal).then(result=>{if(!cancelled)setSvg(result.svg);}).catch(error=>{if(!cancelled)setError(error.message);}).finally(()=>{if(!cancelled)setLoading(false);});},250);return()=>{cancelled=true;clearTimeout(timer);controller.abort();};},[source,apiBaseUrl,retry]);
  useEffect(()=>{if(!svg)return;const saved=positions.current[key];if(saved){setZoom(saved.zoom);host.current?.scrollTo(saved.left,saved.top);}else fit();},[svg,key]);
  const safeSvg=useMemo(()=>graph?diagramSvg(svg,graph,viewState.selectedId):'',[svg,graph,viewState.selectedId]);
  const select=(event:React.MouseEvent|React.KeyboardEvent)=>{if(suppressClick.current){suppressClick.current=false;event.preventDefault();return;}const anchor=(event.target as Element).closest('a');if(!anchor)return;const href=anchor.getAttribute('href')||anchor.getAttribute('xlink:href');event.preventDefault();if(!href?.startsWith('umlith://'))return;const link=new URL(href),[id,field]=link.pathname.slice(1).split('/').map(decodeURIComponent);if(link.hostname==='edge')onSelectEdge?.(id);else if(link.hostname==='field')onSelectField?.(id,field);else onSelectNode(id);};
  const linkedNode=(target:EventTarget)=>{const anchor=target instanceof Element?target.closest('a'):null;const href=anchor?.getAttribute('href')||anchor?.getAttribute('xlink:href');if(!href?.startsWith('umlith://node/'))return null;return decodeURIComponent(new URL(href).pathname.slice(1));};
  const beginConnection=(event:React.PointerEvent)=>{if(readOnly||!onConnectNodes||event.button!==0)return;const id=linkedNode(event.target);if(id)drag.current={id,x:event.clientX,y:event.clientY};};
  const endConnection=(event:React.PointerEvent)=>{const start=drag.current;drag.current=null;if(!start||Math.hypot(event.clientX-start.x,event.clientY-start.y)<8)return;const target=linkedNode(event.target);if(target){suppressClick.current=true;onConnectNodes?.(start.id,target);}};
  return <section className="panel plantuml-panel" aria-label="Scoped Canvas" data-testid="scoped-canvas-panel">
    <header className="panel-header canvas-header"><div className="scope-indicator">{scope&&<button className="btn btn-outline" onClick={()=>onScopeChange(scope.parentId||null)}><ArrowLeft size={14}/>Back</button>}<strong>{viewState.flowchartId?`${scope?.name||'Method'} · Flowchart`:scope?.name||'Project design'}</strong><span className="scope-count">{visible.length} elements</span></div><div className="canvas-header-actions"><span className="plantuml-credit" title="Drag between items to choose a relationship, or use Connect in Details.">PlantUML</span>{!readOnly&&onOpenArchitectureEditor&&<button className="btn btn-outline" onClick={onOpenArchitectureEditor}><Plus size={14}/>Add</button>}</div></header>
    <div className="plantuml-tools"><button className="btn btn-outline" aria-label="Zoom out" onClick={()=>changeZoom(Math.max(.1,zoom/1.2))}><ZoomOut size={15}/></button><span>{Math.round(zoom*100)}%</span><button className="btn btn-outline" aria-label="Zoom in" onClick={()=>changeZoom(Math.min(4,zoom*1.2))}><ZoomIn size={15}/></button><button className="btn btn-outline" onClick={fit}><Maximize2 size={15}/>Fit</button><span className="toolbar-spacer"/><button className="btn btn-outline" onClick={()=>setSourceOpen(value=>!value)} aria-pressed={sourceOpen}><Code2 size={15}/>PlantUML source</button><button className="btn btn-outline" disabled={!source} onClick={()=>download(source,`${viewState.flowchartId?'method-flow':viewState.designView}.puml`,'text/plain')}><Download size={15}/>.puml</button><button className="btn btn-outline" disabled={!safeSvg||loading} onClick={()=>download(safeSvg,`${viewState.flowchartId?'method-flow':viewState.designView}.svg`,'image/svg+xml')}><Download size={15}/>SVG</button></div>
    {loading&&<p className="plantuml-status" role="status">Updating local PlantUML diagram…</p>}{error&&<div className="canvas-error-banner" role="alert"><span>{error}</span><button className="btn btn-outline" onClick={()=>setRetry(value=>value+1)}>Retry</button></div>}
    {!visible.length?<div className="canvas-empty-state"><h2>{viewState.flowchartId?'Describe it first.':'Start with your design.'}</h2><p>{viewState.flowchartId?'A flowchart is optional. Add steps in the method details.':'Add a class, system, or table in Details. PlantUML renders the diagram locally.'}</p>{onOpenArchitectureEditor&&<button className="btn btn-primary" onClick={onOpenArchitectureEditor}>Add your first {viewState.designView==='database'?'table':viewState.designView==='overview'?'component':'class'}</button>}</div>:<div className="plantuml-viewport" ref={host} onScroll={event=>{positions.current[key]={zoom,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};}}><div ref={drawing} className={`plantuml-drawing ${loading?'is-updating':''}`} onPointerDown={beginConnection} onPointerUp={endConnection} onPointerCancel={()=>{drag.current=null;}} onDragStart={event=>event.preventDefault()} onClick={select} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){select(event);}}} style={{zoom}} dangerouslySetInnerHTML={{__html:safeSvg}}/></div>}
    {sourceOpen&&<details open className="plantuml-source"><summary>Generated from the current design · {loading?'rendering':'local renderer'}</summary><textarea readOnly value={source} aria-label="PlantUML source" spellCheck={false}/></details>}
  </section>;
}
