import React from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { ProgramEdge } from '../../shared/model';
function cardinalityMarker(value?: string) {
  if (!value) return undefined;
  const many = value === '*' || value.endsWith('..*') || Number(value.split('..').at(-1)) > 1;
  const optional = value === '*' || value.startsWith('0');
  return `er-${many ? 'many' : 'one'}${optional ? '-optional' : ''}`;
}
export function relationshipMarkers(edge: ProgramEdge) {
  return {
    start: edge.kind === 'composes' ? 'uml-composition' : edge.kind === 'aggregates' ? 'uml-aggregation' : edge.kind === 'relates-to' ? cardinalityMarker(edge.sourceEndpoint?.multiplicity) : edge.kind === 'associates-with' && edge.sourceEndpoint?.navigable ? 'uml-arrow' : undefined,
    end: edge.kind === 'inherits' || edge.kind === 'implements' ? 'uml-triangle' : edge.kind === 'relates-to' ? cardinalityMarker(edge.targetEndpoint?.multiplicity) : edge.kind === 'associates-with' ? edge.targetEndpoint?.navigable ? 'uml-arrow' : undefined : edge.kind === 'aggregates' || edge.kind === 'composes' || edge.kind === 'contains' ? undefined : 'uml-arrow',
    dashed: edge.uncertain || edge.kind === 'implements' || edge.kind === 'depends-on',
  };
}
export function DiagramMarkers() {
  return <svg className="diagram-marker-definitions" aria-hidden="true"><defs>
    <marker id="uml-triangle" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1,1 L13,7 L1,13 Z" fill="#0a0a0a" stroke="#a3a3a3" strokeWidth="1.5"/></marker>
    <marker id="uml-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1,1 L11,6 L1,11" fill="none" stroke="#a3a3a3" strokeWidth="1.5"/></marker>
    {(['aggregation','composition'] as const).map(kind => <marker key={kind} id={`uml-${kind}`} viewBox="0 0 16 14" refX="1" refY="7" markerWidth="16" markerHeight="14" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1,7 L8,1 L15,7 L8,13 Z" fill={kind === 'composition' ? '#a3a3a3' : '#0a0a0a'} stroke="#a3a3a3" strokeWidth="1.5"/></marker>)}
    {(['one','many'] as const).flatMap(kind => [false,true].map(optional => <marker key={`${kind}-${optional}`} id={`er-${kind}${optional ? '-optional' : ''}`} viewBox="0 0 25 16" refX="2" refY="8" markerWidth="25" markerHeight="16" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d={kind === 'many' ? 'M2,1 L12,8 L2,15' : 'M6,1 L6,15'} fill="none" stroke="#a3a3a3" strokeWidth="1.5"/>{optional ? <circle cx="19" cy="8" r="4" fill="#0a0a0a" stroke="#a3a3a3"/> : <path d="M18,1 L18,15" stroke="#a3a3a3"/>}</marker>))}
  </defs></svg>;
}
export function DiagramEdge(props: EdgeProps) {
  const edge = props.data?.programEdge as ProgramEdge;
  const [path, labelX, labelY] = getSmoothStepPath(props);
  const startText = [edge.sourceEndpoint?.multiplicity, edge.sourceEndpoint?.role].filter(Boolean).join(' ');
  const endText = [edge.targetEndpoint?.multiplicity, edge.targetEndpoint?.role].filter(Boolean).join(' ');
  return <><BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style}/><EdgeLabelRenderer>
    {startText && <span className="diagram-endpoint-label nodrag nopan" style={{transform:`translate(-50%, -100%) translate(${props.sourceX + (props.targetX >= props.sourceX ? 34 : -34)}px, ${props.sourceY - 8}px)`}}>{startText}</span>}
    {endText && <span className="diagram-endpoint-label nodrag nopan" style={{transform:`translate(-50%, -100%) translate(${props.targetX + (props.sourceX >= props.targetX ? 34 : -34)}px, ${props.targetY - 8}px)`}}>{endText}</span>}
    {props.label && <span className="diagram-edge-label nodrag nopan" style={{transform:`translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`}}>{props.label}</span>}
  </EdgeLabelRenderer></>;
}
