import {it,expect} from 'vitest';
import {Analyzer,checkCompilerPin,discoverAnalysisInputs,isTypeScriptVersionCompatible,TYPESCRIPT_PIN} from '../server/analyzer';
import {GraphSchema,resolveSourceEvidence} from '../shared/model';
import {hash,captureSourceRevision} from '../server/files';
import {mkdtemp,writeFile,readFile,cp,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../server/store';
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

it('detects changes during capture, retries, and captures a consistent revision when stabilized',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-capture-retry-'));
 try{
  await writeFile(join(dir,'orders.ts'),'export function placeOrder(): number { return 1; }\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  let changed=false;
  const analyzer=new Analyzer();
  const a=await analyzer.analyze(dir,{
   captureOptions:{
    maxRetries:2,
    retryDelayMs:20,
    onCaptureFile:async(path)=>{
     if(path==='tsconfig.json'&&!changed){
      changed=true;
      await writeFile(join(dir,'orders.ts'),'export function placeOrder(): number { return 2; }\n');
      await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2020'}}));
     }
    },
   },
  });
  expect(changed).toBe(true);
  expect(a.status).toBe('current');
  expect(a.quality.diagnostics.filter(d=>d.code==='incomplete-revision')).toHaveLength(0);
  const place=a.graph.nodes.find(n=>n.name==='placeOrder')!;
  expect(place.source).toBeDefined();
  const evidence=resolveSourceEvidence(place.source,a,a.revision);
  expect(evidence.status).toBe('current');
  if(evidence.status==='current'){
   expect(evidence.text).toContain('return 2');
  }
  expect(place.source?.hash).toBe(hash(a.files['orders.ts'].text));
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('detects changes during capture, marks the revision incomplete explicitly, and never labels it current',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-capture-incomplete-'));
 try{
  await writeFile(join(dir,'orders.ts'),'export function placeOrder(): number { return 1; }\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  let changed=false;
  const captured=await captureSourceRevision(dir,{
   maxRetries:0,
   onCaptureFile:async(path)=>{
    if(path==='tsconfig.json'&&!changed){
     changed=true;
     await writeFile(join(dir,'orders.ts'),'export function placeOrder(): number { return 999; }\n');
     await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2020'}}));
    }
   },
  });
  expect(changed).toBe(true);
  expect(captured.incomplete).toBe(true);
  expect(captured.changedPaths.length).toBeGreaterThan(0);
  expect(captured.changedPaths).toContain('orders.ts');

  const analyzer=new Analyzer();
  const a=await analyzer.analyze(dir,{capturedRevision:captured});
  expect(a.status).not.toBe('current');
  expect(a.status).toBe('partial');
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity:'warning',
    code:'incomplete-revision',
    message:expect.stringContaining('Source files were modified during capture'),
   })
  );
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('confirms source ranges slice the captured text rather than live disk and finding hashes match analyzed text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-source-ranges-'));
 try{
  const originalOrders='export function calculateTotal(qty: number, price: number): number {\n  return qty * price;\n}\n';
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  await writeFile(join(dir,'orders.ts'),originalOrders);

  const captured=await captureSourceRevision(dir);
  expect(captured.incomplete).toBe(false);

  // Now mutate the live disk before running analysis:
  // Prepend comments and lines, and change the code completely on disk!
  const mutatedLiveDisk='// LIVE DISK MUTATION LINE 1\n// LIVE DISK MUTATION LINE 2\n// LIVE DISK MUTATION LINE 3\nexport function calculateTotal(qty: number, price: number): number {\n  return 0;\n}\n';
  await writeFile(join(dir,'orders.ts'),mutatedLiveDisk);

  // Run analysis using the captured revision boundary
  const analyzer=new Analyzer();
  const a=await analyzer.analyze(dir,{capturedRevision:captured});

  const fnNode=a.graph.nodes.find(n=>n.name==='calculateTotal')!;
  expect(fnNode).toBeDefined();
  expect(fnNode.source).toBeDefined();

  // Finding hash matches the actual analyzed text in the captured revision, NOT live disk
  expect(fnNode.source?.hash).toBe(hash(originalOrders));
  expect(fnNode.source?.hash).not.toBe(hash(mutatedLiveDisk));

  // resolveSourceEvidence slices the captured revision text
  const evidence=resolveSourceEvidence(fnNode.source,a,a.revision);
  expect(evidence.status).toBe('current');
  if(evidence.status==='current'){
   expect(evidence.text).toContain('return qty * price');
   expect(evidence.text).not.toContain('return 0');
   expect(evidence.text).not.toContain('LIVE DISK MUTATION');
  }

  // If live disk was sliced at the source range start/end, it would be completely shifted/corrupted
  const liveDiskSliced=mutatedLiveDisk.slice(fnNode.source!.start,fnNode.source!.end);
  expect(liveDiskSliced).not.toBe(evidence.status==='current'?evidence.text:'');
  expect(liveDiskSliced).toContain('LIVE DISK MUTATION');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('ensures configuration parsing does not silently reread newer project files from live disk',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-config-isolation-'));
 try{
  // Initially, tsconfig includes only src/core.ts
  await mkdir(join(dir,'src'),{recursive:true});
  await writeFile(
   join(dir,'tsconfig.json'),
   JSON.stringify({compilerOptions:{target:'ES2022'},include:['src/core.ts']})
  );
  await writeFile(join(dir,'src','core.ts'),'export const core = 1;\n');

  const captured=await captureSourceRevision(dir);
  expect(Object.keys(captured.files).sort()).toEqual(['src/core.ts','tsconfig.json']);

  // Live disk is now modified:
  // 1. tsconfig.json on live disk changed to include all src/**/*
  // 2. A new file src/newer.ts is added to live disk
  await writeFile(
   join(dir,'tsconfig.json'),
   JSON.stringify({compilerOptions:{target:'ES2022'},include:['src/**/*']})
  );
  await writeFile(join(dir,'src','newer.ts'),'export const newer = 2;\n');

  // Analyze using the captured revision boundary
  const analyzer=new Analyzer();
  const a=await analyzer.analyze(dir,{capturedRevision:captured});

  // Configuration parsing must NOT have read the newer tsconfig or newer files from live disk
  expect(a.files['src/newer.ts']).toBeUndefined();
  expect(a.graph.nodes.some(n=>n.name.includes('newer'))).toBe(false);
  expect(a.graph.nodes.some(n=>n.name.includes('core'))).toBe(true);

  const discovery=await analyzer.discoverInputs(dir,captured.files);
  expect(discovery.configuredSourceFiles).toEqual(['src/core.ts']);
  expect(discovery.eligibleFiles).toEqual(['src/core.ts']);
  expect(discovery.eligibleFiles).not.toContain('src/newer.ts');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('ensures a mixed or unavailable input revision is never labeled current',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-unavailable-rev-'));
 try{
  await writeFile(join(dir,'app.ts'),'export function run(): number { return 1; }\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
  const analyzer=new Analyzer();
  const a=await analyzer.analyze(dir);
  const node=a.graph.nodes.find(n=>n.name==='run')!;
  expect(node).toBeDefined();

  // 1. When source revision is compared against an unavailable revision
  const unavailableEvidence=resolveSourceEvidence(node.source,undefined,a.revision);
  expect(unavailableEvidence.status).toBe('unavailable');
  expect(unavailableEvidence.status).not.toBe('current');

  const mismatchedEvidence=resolveSourceEvidence(
   node.source,
   {revision:'diff-rev',status:'current',files:a.files},
   'diff-rev'
  );
  expect(mismatchedEvidence.status).toBe('unavailable');
  expect(mismatchedEvidence.status).not.toBe('current');

  // 2. An incomplete / mixed capture is never current
  let changed=false;
  const incompleteRev=await captureSourceRevision(dir,{
   maxRetries:0,
   onCaptureFile:async(path)=>{
    if(path==='tsconfig.json'&&!changed){
     changed=true;
     await writeFile(join(dir,'app.ts'),'export function run(): number { return 2; }\n');
    }
   },
  });
  expect(incompleteRev.incomplete).toBe(true);
  const incompleteAnalysis=await analyzer.analyze(dir,{capturedRevision:incompleteRev});
  expect(incompleteAnalysis.status).not.toBe('current');
  expect(incompleteAnalysis.status).toBe('partial');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('imports a project using extends, path aliases, and a project reference (T033 concrete scenario 1)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-config');
 const analyzer = new Analyzer();
 const discovery = await analyzer.discoverInputs(fixtureDir);

 // Discovery verification
 expect(discovery.configurationFiles).toEqual([
  'packages/app/tsconfig.json',
  'packages/core/tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.json',
 ].sort());
 expect(discovery.eligibleFiles).toEqual([
  'packages/app/src/index.ts',
  'packages/core/src/service.ts',
 ]);
 expect(discovery.configuredSourceFiles).toEqual([
  'packages/app/src/index.ts',
  'packages/core/src/service.ts',
 ]);
 expect(discovery.unconfiguredSourceFiles).toEqual([]);

 // Full analysis verification
 const a = await analyzer.analyze(fixtureDir);
 expect(a.quality.diagnostics).toEqual([]);
 expect(a.status).toBe('current');
 expect(a.quality.unresolvedReferences).toBe(0);
 expect(a.quality.eligibleFiles).toBe(2);
 expect(a.quality.analyzedFiles).toBe(2);
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);

 // Module nodes
 const appModule = a.graph.nodes.find(n => n.kind === 'module' && n.name === 'packages/app/src/index.ts')!;
 const coreModule = a.graph.nodes.find(n => n.kind === 'module' && n.name === 'packages/core/src/service.ts')!;
 expect(appModule).toBeDefined();
 expect(coreModule).toBeDefined();

 // Extracted symbols from both projects
 const coreClass = a.graph.nodes.find(n => n.kind === 'class' && n.name === 'CoreService')!;
 const computeFn = a.graph.nodes.find(n => n.kind === 'function' && n.name === 'computeValue')!;
 const handleFn = a.graph.nodes.find(n => n.kind === 'function' && n.name === 'handleRequest')!;
 expect(coreClass).toBeDefined();
 expect(computeFn).toBeDefined();
 expect(handleFn).toBeDefined();

 // Module dependency edge driven by path alias resolution
 const dependsOnEdge = a.graph.edges.find(e => e.source === appModule.id && e.target === coreModule.id && e.kind === 'depends-on');
 expect(dependsOnEdge).toBeDefined();

 // Call edges driven by cross-project reference resolution
 const callCompute = a.graph.edges.find(e => e.source === handleFn.id && e.target === computeFn.id && e.kind === 'calls');
 expect(callCompute).toBeDefined();
 expect(callCompute?.uncertain).toBe(false);

 const executeNode = a.graph.nodes.find(n => n.name === 'execute' && n.parentId === coreClass.id)!;
 expect(executeNode).toBeDefined();
 const callExecute = a.graph.edges.find(e => e.source === handleFn.id && e.target === executeNode.id && e.kind === 'calls');
 expect(callExecute).toBeDefined();
 expect(callExecute?.uncertain).toBe(false);
});

it('removes a referenced config or dependency, emitting diagnostics and keeping missing reference evidence visible (T033 concrete scenario 2)', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-missing-ref-'));
 try {
  await cp(resolve('tests/fixtures/typescript-config'), dir, { recursive: true });

  // 1. Remove a referenced config (packages/core/tsconfig.json)
  await rm(join(dir, 'packages', 'core', 'tsconfig.json'), { force: true });

  const analyzer = new Analyzer();
  const aMissingConfig = await analyzer.analyze(dir);

  // Status is not current; missing referenced config diagnostic is emitted
  expect(aMissingConfig.status).not.toBe('current');
  expect(aMissingConfig.status).toBe('partial');
  expect(aMissingConfig.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity: 'error',
    code: '6053',
    message: expect.stringContaining('not found'),
   })
  );

  // 2. Remove a dependency (packages/core/src/service.ts)
  await rm(join(dir, 'packages', 'core', 'src', 'service.ts'), { force: true });
  // Restore packages/core/tsconfig.json so we isolate the missing dependency scenario
  await writeFile(
   join(dir, 'packages', 'core', 'tsconfig.json'),
   JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: { composite: true, rootDir: 'src' },
    include: ['src/**/*'],
   })
  );

  const aMissingDep = await new Analyzer().analyze(dir);
  expect(aMissingDep.status).not.toBe('current');
  expect(aMissingDep.status).toBe('partial');

  // Diagnostics contain missing module diagnostic and unresolved call diagnostic
  expect(aMissingDep.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity: 'error',
    code: '2307',
    message: expect.stringContaining("Cannot find module '@core/service'"),
   })
  );
  expect(aMissingDep.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity: 'warning',
    message: expect.stringContaining('Unresolved call'),
   })
  );

  // Missing reference evidence remains visible in the graph
  expect(aMissingDep.quality.unresolvedReferences).toBeGreaterThan(0);
  const externalSystem = aMissingDep.graph.nodes.find(n => n.id === 'external');
  expect(externalSystem).toBeDefined();

  const handleFn = aMissingDep.graph.nodes.find(n => n.name === 'handleRequest')!;
  expect(handleFn).toBeDefined();

  // Call edges to unresolved targets are marked uncertain: true
  const uncertainCalls = aMissingDep.graph.edges.filter(e => e.source === handleFn.id && e.kind === 'calls');
  expect(uncertainCalls.length).toBeGreaterThan(0);
  for (const call of uncertainCalls) {
   expect(call.uncertain).toBe(true);
   const targetNode = aMissingDep.graph.nodes.find(n => n.id === call.target)!;
   expect(targetNode).toBeDefined();
   expect(targetNode.parentId).toBe('external');
  }
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('labels unconfigured analysis when files are outside configured TypeScript projects', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-unconfigured-label-'));
 try {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'orphan'), { recursive: true });

  await writeFile(join(dir, 'src', 'configured.ts'), 'export function inside(): number { return 1; }\n');
  await writeFile(join(dir, 'orphan', 'unconfigured.ts'), 'export function outside(): number { return 2; }\n');
  await writeFile(
   join(dir, 'tsconfig.json'),
   JSON.stringify({
    compilerOptions: { target: 'ES2022' },
    include: ['src/**/*'],
   })
  );

  const analyzer = new Analyzer();
  const discovery = await analyzer.discoverInputs(dir);

  // Discovery labels configured vs unconfigured source files
  expect(discovery.configuredSourceFiles).toEqual(['src/configured.ts']);
  expect(discovery.unconfiguredSourceFiles).toEqual(['orphan/unconfigured.ts']);

  // Analysis emits diagnostic labeling the unconfigured fallback analysis
  const a = await analyzer.analyze(dir);
  expect(a.status).toBe('partial');
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    severity: 'warning',
    code: 'unconfigured-analysis',
    message: 'Files outside configured TypeScript projects were analyzed with fallback options.',
   })
  );

  // Both files are still analyzed
  expect(a.graph.nodes.some(n => n.name === 'inside')).toBe(true);
  expect(a.graph.nodes.some(n => n.name === 'outside')).toBe(true);
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('extracts TypeScript architecture declarations: named/default exports, overloads, arrow functions, nested classes, and methods (T034 concrete scenario 1)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-structure');
 const analyzer = new Analyzer();
 const analysis = await analyzer.analyze(fixtureDir);

 // Schema validity and successful analysis
 expect(analysis.graph.schemaVersion).toBe(1);
 expect(GraphSchema.safeParse(analysis.graph).success).toBe(true);
 expect(analysis.status).toBe('current');
 expect(analysis.quality.diagnostics).toEqual([]);

 const nodes = analysis.graph.nodes;
 const edges = analysis.graph.edges;

 // 1. Modules
 const modelsMod = nodes.find(n => n.kind === 'module' && n.name === 'src/models.ts')!;
 const serviceMod = nodes.find(n => n.kind === 'module' && n.name === 'src/service.ts')!;
 const defaultFnMod = nodes.find(n => n.kind === 'module' && n.name === 'src/default-fn.ts')!;
 const indexMod = nodes.find(n => n.kind === 'module' && n.name === 'src/index.ts')!;
 expect(modelsMod).toBeDefined();
 expect(serviceMod).toBeDefined();
 expect(defaultFnMod).toBeDefined();
 expect(indexMod).toBeDefined();

 // 2. Enums and enum members (fields)
 const priorityEnum = nodes.find(n => n.kind === 'enum' && n.name === 'Priority')!;
 expect(priorityEnum).toBeDefined();
 expect(priorityEnum.parentId).toBe(modelsMod.id);
 expect(priorityEnum.fields.map(f => f.name)).toEqual(['Low', 'Medium', 'High']);
 expect(priorityEnum.fields.every(f => f.type === 'enum')).toBe(true);

 // 3. Interfaces and interface inheritance
 const identifiable = nodes.find(n => n.kind === 'interface' && n.name === 'Identifiable')!;
 const auditable = nodes.find(n => n.kind === 'interface' && n.name === 'Auditable')!;
 const taskHandler = nodes.find(n => n.kind === 'interface' && n.name === 'TaskHandler')!;
 expect(identifiable).toBeDefined();
 expect(auditable).toBeDefined();
 expect(taskHandler).toBeDefined();

 const auditableInheritsIdentifiable = edges.find(
  e => e.source === auditable.id && e.target === identifiable.id && e.kind === 'inherits'
 );
 expect(auditableInheritsIdentifiable).toBeDefined();

 // Interface method signature (overloaded)
 const taskHandlerHandle = nodes.find(n => n.kind === 'function' && n.name === 'handle' && n.parentId === taskHandler.id)!;
 expect(taskHandlerHandle).toBeDefined();
 expect(taskHandlerHandle.contract).toContain('handle(task: string): boolean');
 expect(taskHandlerHandle.contract).toContain('handle(tasks: string[]): boolean');

 // 4. Arrow functions (standalone, class property, and default export)
 const formatPriorityFn = nodes.find(n => n.kind === 'function' && n.name === 'formatPriority')!;
 expect(formatPriorityFn).toBeDefined();
 expect(formatPriorityFn.parentId).toBe(serviceMod.id);
 expect(formatPriorityFn.contract).toContain('formatPriority(priority: Priority): string');

 const defaultFn = nodes.find(n => n.kind === 'function' && n.name === 'default' && n.parentId === defaultFnMod.id)!;
 expect(defaultFn).toBeDefined();
 expect(defaultFn.contract).toContain('default(msg: string): string');

 // 5. Overloaded functions
 const processInputFn = nodes.find(n => n.kind === 'function' && n.name === 'processInput')!;
 expect(processInputFn).toBeDefined();
 expect(processInputFn.parentId).toBe(serviceMod.id);
 const processInputOverloadLines = processInputFn.contract.split('\n');
 expect(processInputOverloadLines).toContain('processInput(input: string): string');
 expect(processInputOverloadLines).toContain('processInput(input: number): number');
 expect(processInputOverloadLines).toContain('processInput(input: string | number): string | number');

 // 6. Classes, constructors, methods, getters/setters, class-property arrow functions
 const baseService = nodes.find(n => n.kind === 'class' && n.name === 'BaseService')!;
 expect(baseService).toBeDefined();
 expect(baseService.parentId).toBe(serviceMod.id);
 const baseCtor = nodes.find(n => n.kind === 'function' && n.name === 'constructor' && n.parentId === baseService.id)!;
 expect(baseCtor).toBeDefined();
 const baseGetName = nodes.find(n => n.kind === 'function' && n.name === 'getName' && n.parentId === baseService.id)!;
 expect(baseGetName).toBeDefined();

 const baseImplementsAuditable = edges.find(
  e => e.source === baseService.id && e.target === auditable.id && e.kind === 'implements'
 );
 expect(baseImplementsAuditable).toBeDefined();

 const taskService = nodes.find(n => n.kind === 'class' && n.name === 'TaskService')!;
 expect(taskService).toBeDefined();
 expect(taskService.parentId).toBe(serviceMod.id);

 const taskInheritsBase = edges.find(
  e => e.source === taskService.id && e.target === baseService.id && e.kind === 'inherits'
 );
 expect(taskInheritsBase).toBeDefined();

 const taskImplementsHandler = edges.find(
  e => e.source === taskService.id && e.target === taskHandler.id && e.kind === 'implements'
 );
 expect(taskImplementsHandler).toBeDefined();

 // Getter/setter accessor representation
 const statusAccessor = nodes.find(n => n.kind === 'function' && n.name === 'status' && n.parentId === taskService.id)!;
 expect(statusAccessor).toBeDefined();
 expect(statusAccessor.contract).toContain('status(): string');
 expect(statusAccessor.contract).toContain('status(val: string): void');

 // Arrow function member on class
 const validatorMember = nodes.find(n => n.kind === 'function' && n.name === 'validator' && n.parentId === taskService.id)!;
 expect(validatorMember).toBeDefined();
 expect(validatorMember.contract).toContain('validator(task: string): boolean');

 // Overloaded method on class
 const taskHandleMethod = nodes.find(n => n.kind === 'function' && n.name === 'handle' && n.parentId === taskService.id)!;
 expect(taskHandleMethod).toBeDefined();
 const taskHandleLines = taskHandleMethod.contract.split('\n');
 expect(taskHandleLines).toContain('handle(task: string): boolean');
 expect(taskHandleLines).toContain('handle(tasks: string[]): boolean');
 expect(taskHandleLines).toContain('handle(taskOrTasks: string | string[]): boolean');

 // 7. Nested classes (static nested class and local class inside function)
 const helperClass = nodes.find(n => n.kind === 'class' && n.name === 'Helper')!;
 expect(helperClass).toBeDefined();
 expect(helperClass.parentId).toBe(taskService.id);
 const helperFormat = nodes.find(n => n.kind === 'function' && n.name === 'format' && n.parentId === helperClass.id)!;
 expect(helperFormat).toBeDefined();

 const createRunnerMethod = nodes.find(n => n.kind === 'function' && n.name === 'createRunner' && n.parentId === taskService.id)!;
 expect(createRunnerMethod).toBeDefined();

 const localRunnerClass = nodes.find(n => n.kind === 'class' && n.name === 'LocalRunner')!;
 expect(localRunnerClass).toBeDefined();
 expect(localRunnerClass.parentId).toBe(createRunnerMethod.id);
 const localRunnerRun = nodes.find(n => n.kind === 'function' && n.name === 'run' && n.parentId === localRunnerClass.id)!;
 expect(localRunnerRun).toBeDefined();

 // 8. Default export class
 const appClass = nodes.find(n => n.kind === 'class' && n.name === 'Application')!;
 expect(appClass).toBeDefined();
 expect(appClass.parentId).toBe(indexMod.id);
 const appStart = nodes.find(n => n.kind === 'function' && n.name === 'start' && n.parentId === appClass.id)!;
 expect(appStart).toBeDefined();

 // 9. Cross-module dependencies and calls
 expect(edges).toContainEqual(expect.objectContaining({ source: serviceMod.id, target: modelsMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: indexMod.id, target: serviceMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: indexMod.id, target: defaultFnMod.id, kind: 'depends-on' }));

 expect(edges).toContainEqual(expect.objectContaining({ source: taskHandleMethod.id, target: validatorMember.id, kind: 'calls' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: createRunnerMethod.id, target: localRunnerRun.id, kind: 'calls' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: appStart.id, target: defaultFn.id, kind: 'calls' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: appStart.id, target: taskHandleMethod.id, kind: 'calls' }));
});

it('compares extracted graph against a hand-authored fixture graph (T034 concrete scenario 2)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-structure');
 const expectedPath = resolve('tests/fixtures/typescript-structure.expected.json');

 const analyzer = new Analyzer();
 const actual = await analyzer.analyze(fixtureDir);

 const expectedContent = await readFile(expectedPath, 'utf8');
 const expectedGraph = JSON.parse(expectedContent);

 expect(GraphSchema.safeParse(expectedGraph).success).toBe(true);

 expect(actual.graph.schemaVersion).toBe(expectedGraph.schemaVersion);
 expect(actual.graph.nodes.length).toBe(expectedGraph.nodes.length);
 expect(actual.graph.edges.length).toBe(expectedGraph.edges.length);
 expect(actual.graph).toEqual(expectedGraph);
});

it('imported code changes only the implemented graph, preserving human-authored intent (T034 acceptance criterion 3)', async () => {
 const tempDir = await mkdtemp(join(tmpdir(), 'architect-spec-isolation-'));
 try {
  const fixtureDir = resolve('tests/fixtures/typescript-structure');
  const store = new ProjectStore(tempDir);
  const project = await store.create({ name: 'StructureIsolation', root: fixtureDir });

  // 1. Initial human specification is empty at revision 0
  expect(project.specRevision).toBe(0);
  expect(project.specification.nodes).toEqual([]);
  expect(project.specification.edges).toEqual([]);

  // Implemented graph has the extracted architecture
  expect(project.analysis).toBeDefined();
  expect(project.analysis!.graph.nodes.length).toBeGreaterThan(0);
  expect(project.analysis!.graph.nodes.some(n => n.name === 'TaskService')).toBe(true);

  // 2. Human explicitly authoring/adopting intended specification
  const humanNode = {
   id: 'human-arch-intent',
   kind: 'system' as const,
   name: 'Intended Architecture Boundary',
   description: 'Human-reviewed architectural baseline',
   provenance: 'human' as const,
   policy: 'editable' as const,
   contract: '',
   requiredChecks: [],
   instructions: '',
   outputPath: '',
   fields: [],
  };
  await store.updateSpec(project.id, 0, {
   nodes: [humanNode],
   edges: [],
  });

  const updated = await store.get(project.id);
  expect(updated.specRevision).toBe(1);
  expect(updated.specification.nodes).toHaveLength(1);
  expect(updated.specification.nodes[0].name).toBe('Intended Architecture Boundary');

  // 3. Re-analyzing or importing code updates only the analysis graph, never human specification
  const analyzer = new Analyzer();
  const reAnalysis = await analyzer.analyze(fixtureDir);
  await store.updateAnalysis(project.id, reAnalysis);

  const reloaded = await store.get(project.id);
  // Human specification remains exactly as authored at specRevision 1
  expect(reloaded.specRevision).toBe(1);
  expect(reloaded.specification.nodes).toHaveLength(1);
  expect(reloaded.specification.nodes[0].id).toBe('human-arch-intent');
  expect(reloaded.specification.nodes[0].name).toBe('Intended Architecture Boundary');

  // Implemented graph contains only the code-backed analysis
  expect(reloaded.analysis!.graph.nodes.some(n => n.id === 'human-arch-intent')).toBe(false);
  expect(reloaded.analysis!.graph.nodes.some(n => n.name === 'TaskService')).toBe(true);
 } finally {
  await rm(tempDir, { recursive: true, force: true });
 }
});
