import {it,expect} from 'vitest';
import {Analyzer,checkCompilerPin,discoverAnalysisInputs,isTypeScriptVersionCompatible,TYPESCRIPT_PIN} from '../server/analyzer';
import {GraphSchema} from '../shared/model';
import {mkdtemp,writeFile,cp,rm,mkdir} from 'node:fs/promises';
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

it('discovers eligible TypeScript and Prisma inputs, records exclusion reasons, and computes coverage with defined denominator',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-discover-inputs-'));
 try{
  await mkdir(join(dir,'src','domain'),{recursive:true});
  await mkdir(join(dir,'src','services'),{recursive:true});
  await mkdir(join(dir,'src','types'),{recursive:true});
  await mkdir(join(dir,'prisma'),{recursive:true});
  await mkdir(join(dir,'dist'),{recursive:true});
  await mkdir(join(dir,'build'),{recursive:true});
  await mkdir(join(dir,'node_modules','dep'),{recursive:true});

  await writeFile(join(dir,'src','domain','user.ts'),'export class User { id = "u1"; name = "Alice"; }\n');
  await writeFile(join(dir,'src','services','auth.ts'),'import { User } from "../domain/user";\nexport function login(): User { return new User(); }\n');
  await writeFile(join(dir,'src','types','env.d.ts'),'declare const API_KEY: string;\n');
  await writeFile(join(dir,'prisma','schema.prisma'),'datasource db {\n  provider = "sqlite"\n}\nmodel Account {\n  id Int @id\n}\n');
  await writeFile(join(dir,'dist','bundle.js'),'console.log("dist");\n');
  await writeFile(join(dir,'build','out.js'),'console.log("build");\n');
  await writeFile(join(dir,'node_modules','dep','index.js'),'module.exports = {};\n');
  await writeFile(join(dir,'.env'),'SECRET_KEY=secret\n');
  await writeFile(join(dir,'credentials.json'),'{"token": "xyz"}\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true},include:['src/**/*']}));
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'test-project',dependencies:{typescript:'6.0.3'}}));
  await writeFile(join(dir,'package-lock.json'),JSON.stringify({name:'test-project',lockfileVersion:3}));
  await writeFile(join(dir,'README.md'),'# Test Project\n');

  const analyzer=new Analyzer();
  const discovery=await analyzer.discoverInputs(dir);

  // Compiler pin
  expect(discovery.compilerPin.pinned).toBe('6.0.3');
  expect(discovery.compilerPin.installed).toBe('6.0.3');
  expect(discovery.compilerPin.compatible).toBe(true);

  // Eligible files
  expect(discovery.eligibleFiles).toEqual(['prisma/schema.prisma','src/domain/user.ts','src/services/auth.ts']);
  expect(discovery.denominator).toBe(3);
  expect(discovery.prismaSchemas).toEqual(['prisma/schema.prisma']);
  expect(discovery.declarationFiles).toEqual(['src/types/env.d.ts']);
  expect(discovery.configurationFiles).toEqual(['tsconfig.json']);
  expect(discovery.manifestFiles).toEqual(['package.json']);
  expect(discovery.lockfiles).toEqual(['package-lock.json']);
  expect(discovery.configuredSourceFiles).toEqual(['src/domain/user.ts','src/services/auth.ts']);
  expect(discovery.unconfiguredSourceFiles).toEqual([]);

  // Dependency and tracking inputs
  expect(discovery.dependencyInputs).toEqual(['package-lock.json','package.json','src/types/env.d.ts','tsconfig.json']);
  expect(discovery.trackingInputs).toEqual(['package-lock.json','package.json','prisma/schema.prisma','src/domain/user.ts','src/services/auth.ts','src/types/env.d.ts','tsconfig.json']);

  // Inclusions
  expect(discovery.inclusions['src/domain/user.ts']).toMatchObject({category:'typescript-source',eligible:true,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['prisma/schema.prisma']).toMatchObject({category:'prisma-schema',eligible:true,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['src/types/env.d.ts']).toMatchObject({category:'typescript-declaration',eligible:false,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['tsconfig.json']).toMatchObject({category:'typescript-config',eligible:false,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['package.json']).toMatchObject({category:'dependency-manifest',eligible:false,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['package-lock.json']).toMatchObject({category:'dependency-lockfile',eligible:false,requiredForResolution:true,participatesInRevision:true});
  expect(discovery.inclusions['README.md']).toMatchObject({category:'non-analysis-asset',eligible:false,requiredForResolution:false,participatesInRevision:false});

  // Exclusions with recorded reasons
  expect(discovery.exclusions['dist']).toMatchObject({category:'ignored-directory'});
  expect(discovery.exclusions['dist'].reason).toContain('Ignored directory');
  expect(discovery.exclusions['build']).toMatchObject({category:'ignored-directory'});
  expect(discovery.exclusions['node_modules']).toMatchObject({category:'ignored-directory'});
  expect(discovery.exclusions['.env']).toMatchObject({category:'sensitive-file'});
  expect(discovery.exclusions['credentials.json']).toMatchObject({category:'sensitive-file'});
  expect(discovery.exclusions['src/types/env.d.ts']).toMatchObject({category:'declaration'});
  expect(discovery.exclusions['README.md']).toMatchObject({category:'non-analysis-asset'});

  // Run full analysis
  const a=await analyzer.analyze(dir);
  expect(a.quality.eligibleFiles).toBe(3); // Defined denominator
  expect(a.quality.analyzedFiles).toBe(3); // Numerator
  expect(a.quality.prismaValidation).toBe('unavailable');

  // Exclusions do not masquerade as analyzed files
  expect(a.files['dist/bundle.js']).toBeUndefined();
  expect(a.files['build/out.js']).toBeUndefined();
  expect(a.files['node_modules/dep/index.js']).toBeUndefined();
  expect(a.files['.env']).toBeUndefined();
  expect(a.files['credentials.json']).toBeUndefined();

  // Declaration captured for compiler resolution, but not in eligible files and no module node
  expect(a.files['src/types/env.d.ts']).toBeDefined();
  const moduleNodes=a.graph.nodes.filter(n=>n.kind==='module').map(n=>n.name).sort();
  expect(moduleNodes).toEqual(['prisma/schema.prisma','src/domain/user.ts','src/services/auth.ts']);
  expect(a.graph.nodes.some(n=>n.name.includes('.d.ts')||n.name.includes('package.json')||n.name.includes('tsconfig'))).toBe(false);
  expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('participates dependency, declaration, and configuration inputs in revision tracking',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-revision-tracking-'));
 try{
  await mkdir(join(dir,'src'),{recursive:true});
  await writeFile(join(dir,'src','index.ts'),'export const answer = 42;\n');
  await writeFile(join(dir,'src','types.d.ts'),'declare const FOO: string;\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'track-test',dependencies:{typescript:'6.0.3'}}));
  await writeFile(join(dir,'package-lock.json'),JSON.stringify({name:'track-test',lockfileVersion:3}));
  await writeFile(join(dir,'README.md'),'# Notes\n');

  const analyzer=new Analyzer();
  const a0=await analyzer.analyze(dir);
  const r0=a0.revision;

  // Modifying tsconfig changes revision
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2020'}}));
  const r1=(await analyzer.analyze(dir)).revision;
  expect(r1).not.toBe(r0);

  // Modifying declarations changes revision
  await writeFile(join(dir,'src','types.d.ts'),'declare const FOO: number;\n');
  const r2=(await analyzer.analyze(dir)).revision;
  expect(r2).not.toBe(r1);

  // Modifying package.json changes revision
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'track-test',version:'1.0.1',dependencies:{typescript:'6.0.3'}}));
  const r3=(await analyzer.analyze(dir)).revision;
  expect(r3).not.toBe(r2);

  // Modifying package-lock.json changes revision
  await writeFile(join(dir,'package-lock.json'),JSON.stringify({name:'track-test',lockfileVersion:2}));
  const r4=(await analyzer.analyze(dir)).revision;
  expect(r4).not.toBe(r3);

  // Modifying README.md (non-tracking asset) does NOT change revision
  await writeFile(join(dir,'README.md'),'# Notes updated\n');
  const r5=(await analyzer.analyze(dir)).revision;
  expect(r5).toBe(r4);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('checks the installed analyzer compiler pin and reports incompatible project inputs',async()=>{
 const pin=checkCompilerPin();
 expect(pin.pinned).toBe('6.0.3');
 expect(pin.installed).toBe('6.0.3');
 expect(pin.compatible).toBe(true);
 expect(Analyzer.COMPILER_PIN).toBe('6.0.3');
 expect(new Analyzer().compilerPin).toBe('6.0.3');

 // Test version compatibility helper
 expect(isTypeScriptVersionCompatible('6.0.3')).toBe(true);
 expect(isTypeScriptVersionCompatible('^6.0.0')).toBe(true);
 expect(isTypeScriptVersionCompatible('~6.0.3')).toBe(true);
 expect(isTypeScriptVersionCompatible('>=6.0.0')).toBe(true);
 expect(isTypeScriptVersionCompatible('*')).toBe(true);
 expect(isTypeScriptVersionCompatible('latest')).toBe(true);
 expect(isTypeScriptVersionCompatible('^5.0.0')).toBe(false);
 expect(isTypeScriptVersionCompatible('~5.2.0')).toBe(false);
 expect(isTypeScriptVersionCompatible('4.9.5')).toBe(false);
 expect(isTypeScriptVersionCompatible('<6.0.0')).toBe(false);

 // Incompatible project input generates diagnostic warning
 const dirIncompat=await mkdtemp(join(tmpdir(),'architect-incompat-'));
 try{
  await writeFile(join(dirIncompat,'package.json'),JSON.stringify({name:'incompat',dependencies:{typescript:'^5.0.0'}}));
  await writeFile(join(dirIncompat,'app.ts'),'export const a = 1;\n');
  const aIncompat=await new Analyzer().analyze(dirIncompat);
  expect(aIncompat.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity:'warning',
    path:'package.json',
    code:'incompatible-compiler-version',
    message:expect.stringContaining('differs from pinned compiler 6.0.3'),
   })
  );

  // Matching compiler version produces no incompatible warning
  await writeFile(join(dirIncompat,'package.json'),JSON.stringify({name:'incompat',dependencies:{typescript:'6.0.3'}}));
  const aCompat=await new Analyzer().analyze(dirIncompat);
  expect(aCompat.quality.diagnostics.filter(d=>d.code==='incompatible-compiler-version')).toHaveLength(0);
 }finally{await rm(dirIncompat,{recursive:true,force:true});}
});

it('maintains strict denominator when no eligible source files are present',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-empty-sources-'));
 try{
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'empty',dependencies:{typescript:'6.0.3'}}));
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  await writeFile(join(dir,'README.md'),'# Just documentation\n');

  const analyzer=new Analyzer();
  const discovery=await analyzer.discoverInputs(dir);
  expect(discovery.denominator).toBe(0);
  expect(discovery.eligibleFiles).toEqual([]);

  const a=await analyzer.analyze(dir);
  expect(a.quality.eligibleFiles).toBe(0);
  expect(a.quality.analyzedFiles).toBe(0);
  expect(a.graph.nodes.filter(n=>n.kind==='module')).toHaveLength(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
