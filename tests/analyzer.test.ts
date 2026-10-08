import {it,expect} from 'vitest';
import {Analyzer} from '../server/analyzer';
import {GraphSchema} from '../shared/model';
import {mkdtemp,writeFile,cp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
it('extracts source-backed symbols, calls, workflows and Prisma relationships',async()=>{
 const a=await new Analyzer().analyze(resolve('examples/shop'));
 expect(a.graph.schemaVersion).toBe(1);
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 const place=a.graph.nodes.find(n=>n.name==='placeOrder')!;
 expect(place.kind).toBe('function');expect(place.source?.path).toBe('orders.ts');
 expect(place.contract).toContain('Promise<Order>');
 expect(place.provenance).toBe('extracted');
 for(const field of ['inputs','outputs','rules','errors','scenarios'] as const)expect(place[field]).toBeUndefined();
 const stock=a.graph.nodes.find(n=>n.name==='checkStock')!;
 expect(a.graph.edges).toContainEqual(expect.objectContaining({source:place.id,target:stock.id,kind:'calls'}));
 expect(a.graph.nodes.filter(n=>n.parentId===place.id).map(n=>n.stepType)).toContain('condition');
 const user=a.graph.nodes.find(n=>n.kind==='entity'&&n.name==='User')!;
 const order=a.graph.nodes.find(n=>n.kind==='entity'&&n.name==='Order')!;
 expect(user.fields).toContainEqual(expect.objectContaining({name:'id',key:'PK'}));
 expect(order.fields).toContainEqual(expect.objectContaining({name:'userId',key:'FK'}));
 expect(a.graph.edges).toContainEqual(expect.objectContaining({source:order.id,target:user.id,kind:'relates-to'}));
 expect(a.quality.analyzedFiles).toBe(2);
 expect(a.quality.prismaValidation).toBe('unavailable');
});
it('preserves symbol IDs across line shifts and matches a fresh full analysis after edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-analysis-'));
 try{
  await cp(resolve('examples/shop'),dir,{recursive:true});
  const analyzer=new Analyzer();const before=await analyzer.analyze(dir);
  await writeFile(join(dir,'orders.ts'),'export function changed(x: number) { if(x) return x; return 0; }\n');
  const incremental=await analyzer.analyze(dir);
  const fresh=await new Analyzer().analyze(dir);
  expect(incremental.graph).toEqual(fresh.graph);
  const original=before.graph.nodes.find(n=>n.name==='User')!;
  expect(incremental.graph.nodes.find(n=>n.name==='User')?.id).toBe(original.id);
  await writeFile(join(dir,'orders.ts'),'\n\nexport function changed(x: number) { if(x) return x; return 0; }\n');
  const shifted=await analyzer.analyze(dir);
  expect(shifted.graph.nodes.find(n=>n.name==='changed')?.id).toBe(incremental.graph.nodes.find(n=>n.name==='changed')?.id);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('reports incomplete imports instead of hiding unresolved dependencies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-broken-'));
 try{
  await writeFile(join(dir,'code.ts'),'import { missing } from "./absent"; export function run() { return missing(); }');
  const a=await new Analyzer().analyze(dir);
  expect(a.status).toBe('partial');expect(a.quality.diagnostics.length).toBeGreaterThan(0);
  expect(a.graph.nodes.some(n=>n.name==='run')).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('accepts the extracted relationship when a TypeScript class implements another class',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-class-contract-'));
 try{
  await writeFile(join(dir,'point.ts'),'export class Point { x=0; y=0; } export class Point3d implements Point { x=0; y=0; z=0; }');
  const a=await new Analyzer().analyze(dir);
  const point=a.graph.nodes.find(n=>n.name==='Point')!;
  const point3d=a.graph.nodes.find(n=>n.name==='Point3d')!;
  expect(a.quality.diagnostics).toEqual([]);
  expect(a.graph.edges).toContainEqual(expect.objectContaining({source:point3d.id,target:point.id,kind:'implements'}));
  expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('binds class inheritance to the class when its name is merged with an interface',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-merged-class-'));
 try{
  await writeFile(join(dir,'base.ts'),'export interface Base { value:number; } export class Base { value=1; } export class Child extends Base {}');
  const a=await new Analyzer().analyze(dir);
  const base=a.graph.nodes.find(n=>n.name==='Base'&&n.kind==='class')!;
  const child=a.graph.nodes.find(n=>n.name==='Child')!;
  expect(a.quality.diagnostics).toEqual([]);
  expect(a.graph.edges).toContainEqual(expect.objectContaining({source:child.id,target:base.id,kind:'inherits'}));
  expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
