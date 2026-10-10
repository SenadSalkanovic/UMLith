import {it,expect} from 'vitest';
import {Analyzer,checkCompilerPin,discoverAnalysisInputs,isTypeScriptVersionCompatible,TYPESCRIPT_PIN,PRISMA_PARSER_CONFIG,DEFAULT_PRISMA_PARSER_CONFIG,createPrismaParser,parsePrismaSchema,findPrismaBlockEnd} from '../server/analyzer';
import {GraphSchema,resolveSourceEvidence,type AgentJob} from '../shared/model';
import {hash,captureSourceRevision,captureFiles,hashes} from '../server/files';
import {mkdtemp,writeFile,readFile,cp,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../server/store';
import {freezeNode,evaluateFreeze,validateCandidate,protectionIssues} from '../server/review';
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

it('extracts optional, generic, and overloaded signatures, and interface member shapes (T035 concrete scenario 1)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-contracts');
 const analyzer = new Analyzer();
 const analysis = await analyzer.analyze(fixtureDir);

 // Schema validity and successful analysis
 expect(analysis.graph.schemaVersion).toBe(1);
 expect(GraphSchema.safeParse(analysis.graph).success).toBe(true);
 expect(analysis.status).toBe('current');
 expect(analysis.quality.diagnostics).toEqual([]);
 expect(analysis.quality.unresolvedReferences).toBe(0);

 const nodes = analysis.graph.nodes;
 const edges = analysis.graph.edges;

 // 1. Generic interface with index signature and optional properties
 const identifiable = nodes.find(n => n.kind === 'interface' && n.name === 'Identifiable')!;
 expect(identifiable).toBeDefined();
 expect(identifiable.contract).toContain('[key: string]: unknown');
 expect(identifiable.contract).toContain('displayName?: string');
 expect(identifiable.contract).toContain('id: TKey');
 expect(identifiable.contract).toContain('metadata?: Record<string, unknown>');

 // 2. Generic interface with overloaded methods
 const queryable = nodes.find(n => n.kind === 'interface' && n.name === 'Queryable')!;
 expect(queryable).toBeDefined();
 expect(queryable.contract).toContain('query: {');
 expect(queryable.contract).toContain('(id: string): Promise<T | null>;');
 expect(queryable.contract).toContain('(ids: string[]): Promise<T[]>;');
 expect(queryable.contract).toContain('(filter: { tag: string; }, limit?: number): Promise<T[]>;');

 const queryableQuery = nodes.find(n => n.kind === 'function' && n.name === 'query' && n.parentId === queryable.id)!;
 expect(queryableQuery).toBeDefined();
 const queryableQueryLines = queryableQuery.contract.split('\n');
 expect(queryableQueryLines).toContain('query(id: string): Promise<T | null>');
 expect(queryableQueryLines).toContain('query(ids: string[]): Promise<T[]>');
 expect(queryableQueryLines).toContain('query(filter: { tag: string; }, limit?: number): Promise<T[]>');

 // 3. Call signature on interface
 const transformer = nodes.find(n => n.kind === 'interface' && n.name === 'Transformer')!;
 expect(transformer).toBeDefined();
 expect(transformer.contract).toContain('(input: TInput, options?: { strict?: boolean; }): TOutput');

 // 4. Construct signature on interface
 const builder = nodes.find(n => n.kind === 'interface' && n.name === 'Builder')!;
 expect(builder).toBeDefined();
 expect(builder.contract).toContain('new (initialConfig?: Record<string, unknown>): TInstance');

 // 5. Standalone overloaded function
 const formatValueFn = nodes.find(n => n.kind === 'function' && n.name === 'formatValue')!;
 expect(formatValueFn).toBeDefined();
 const formatLines = formatValueFn.contract.split('\n');
 expect(formatLines).toContain('formatValue(value: string): string');
 expect(formatLines).toContain('formatValue(value: number, precision?: number): string');
 expect(formatLines).toContain('formatValue(value: string | number, precision?: number): string');

 // 6. Generic function with constraint, optional parameter, default parameter, and Promise return type
 const processBatchFn = nodes.find(n => n.kind === 'function' && n.name === 'processBatch')!;
 expect(processBatchFn).toBeDefined();
 expect(processBatchFn.contract).toContain('processBatch<T extends Identifiable<string>>');
 expect(processBatchFn.contract).toContain('items: T[]');
 expect(processBatchFn.contract).toContain('batchSize?: number');
 expect(processBatchFn.contract).toContain('options?: { dryRun?: boolean; }');
 expect(processBatchFn.contract).toContain('Promise<{ processed: T[]; count: number; }>');

 // 7. Generic arrow function with optional parameter
 const transformListFn = nodes.find(n => n.kind === 'function' && n.name === 'transformList')!;
 expect(transformListFn).toBeDefined();
 expect(transformListFn.contract).toContain('transformList<T, R>');
 expect(transformListFn.contract).toContain('list: T[]');
 expect(transformListFn.contract).toContain('mapper?: (item: T) => R');
 expect(transformListFn.contract).toContain('R[]');

 // 8. Interface inheritance
 const item = nodes.find(n => n.kind === 'interface' && n.name === 'Item')!;
 expect(item).toBeDefined();
 expect(item.contract).toContain('id: string');
 expect(item.contract).toContain('name: string');
 expect(item.contract).toContain('price?: number');

 const itemInheritsIdentifiable = edges.find(
  e => e.source === item.id && e.target === identifiable.id && e.kind === 'inherits'
 );
 expect(itemInheritsIdentifiable).toBeDefined();

 // 9. Class implementing Queryable<Item>
 const itemService = nodes.find(n => n.kind === 'class' && n.name === 'ItemService')!;
 expect(itemService).toBeDefined();
 const itemServiceImplementsQueryable = edges.find(
  e => e.source === itemService.id && e.target === queryable.id && e.kind === 'implements'
 );
 expect(itemServiceImplementsQueryable).toBeDefined();

 const itemServiceCtor = nodes.find(n => n.kind === 'function' && n.name === 'constructor' && n.parentId === itemService.id)!;
 expect(itemServiceCtor).toBeDefined();
 expect(itemServiceCtor.contract).toContain('constructor(region?: string');
 expect(itemServiceCtor.contract).toContain('): ItemService');

 const itemServiceActive = nodes.find(n => n.kind === 'function' && n.name === 'active' && n.parentId === itemService.id)!;
 expect(itemServiceActive).toBeDefined();
 const activeLines = itemServiceActive.contract.split('\n');
 expect(activeLines).toContain('active(): boolean');
 expect(activeLines).toContain('active(val: boolean): void');

 const itemServiceQuery = nodes.find(n => n.kind === 'function' && n.name === 'query' && n.parentId === itemService.id)!;
 expect(itemServiceQuery).toBeDefined();
 const serviceQueryLines = itemServiceQuery.contract.split('\n');
 expect(serviceQueryLines).toContain('query(id: string): Promise<Item | null>');
 expect(serviceQueryLines).toContain('query(ids: string[]): Promise<Item[]>');
 expect(serviceQueryLines).toContain('query(filter: { tag: string; }, limit?: number): Promise<Item[]>');
 expect(serviceQueryLines).toContain('query(arg: string | string[] | { tag: string; }, limit?: number): Promise<Item | null | Item[]>');

 const itemServiceValidate = nodes.find(n => n.kind === 'function' && n.name === 'validateItem' && n.parentId === itemService.id)!;
 expect(itemServiceValidate).toBeDefined();
 expect(itemServiceValidate.contract).toContain('validateItem(item: Item, checkPrice?: boolean): boolean');

 // 10. Acceptance Criterion 3: Extracted signatures remain source-backed
 for (const node of [formatValueFn, processBatchFn, transformListFn, itemServiceQuery, queryableQuery, identifiable, queryable, itemService]) {
  expect(node.source).toBeDefined();
  expect(node.source?.path).toBe('src/contracts.ts');
  expect(node.source?.hash).toBe(analysis.files['src/contracts.ts'].hash);
  expect(node.source?.revision).toBe(analysis.revision);
  const evidence = resolveSourceEvidence(node.source, analysis, analysis.revision);
  expect(evidence.status).toBe('current');
  if (evidence.status === 'current') {
   expect(evidence.text.length).toBe(node.source!.end - node.source!.start);
  }
 }
});

it('imports an unresolved parameter type and observes incomplete evidence (T035 concrete scenario 2 & AC 2)', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-contracts-unresolved-'));
 try {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
   join(dir, 'package.json'),
   JSON.stringify({ name: 'test-unresolved', version: '1.0.0', dependencies: { typescript: '6.0.3' } })
  );
  await writeFile(
   join(dir, 'tsconfig.json'),
   JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, noEmit: true }, include: ['src/**/*'] })
  );
  await writeFile(
   join(dir, 'src', 'service.ts'),
   `export function syncOrder(order: NonExistentOrderType, timeout?: number): Promise<boolean> {
  return Promise.resolve(true);
}
export interface OrderHandler {
  handle(payload: MissingPayload): void;
}
`
  );

  const analyzer = new Analyzer();
  const a = await analyzer.analyze(dir);

  // Status is incomplete / partial, never labeled current
  expect(a.status).toBe('partial');
  expect(a.status).not.toBe('current');

  // Diagnostics are attached to unresolved contract evidence
  expect(a.quality.diagnostics.length).toBeGreaterThan(0);
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unresolved-type',
    severity: 'error',
    message: expect.stringContaining('syncOrder'),
   })
  );
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unresolved-type',
    severity: 'error',
    message: expect.stringContaining('OrderHandler'),
   })
  );
  // Compiler TS2304 is also present
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: '2304',
    severity: 'error',
   })
  );

  // Unresolved references counter reflects the incomplete contract types
  expect(a.quality.unresolvedReferences).toBeGreaterThanOrEqual(2);

  // Extracted signatures remain source-backed in the implemented model
  const syncFn = a.graph.nodes.find(n => n.name === 'syncOrder')!;
  expect(syncFn).toBeDefined();
  expect(syncFn.contract).toContain('syncOrder(order: NonExistentOrderType, timeout?: number): Promise<boolean>');
  expect(syncFn.source).toBeDefined();
  expect(syncFn.source?.path).toBe('src/service.ts');

  const handlerIface = a.graph.nodes.find(n => n.name === 'OrderHandler')!;
  expect(handlerIface).toBeDefined();
  expect(handlerIface.source).toBeDefined();
  expect(handlerIface.source?.path).toBe('src/service.ts');

  // AC 2: Unresolved types never count as verified contracts
  // 1. evaluateFreeze rejects freezing the contract because evidence is partial
  const freezeEval = evaluateFreeze(syncFn, 'frozen-contract', a);
  expect(freezeEval.allowed).toBe(false);
  expect(freezeEval.reason).toContain('Freeze contract cannot be verified due to compiler/type errors');

  // 2. freezeNode throws because evidence is not current
  expect(() => freezeNode(syncFn, 'frozen-contract', a)).toThrow();

  // 3. In protection review, unverified contracts are flagged
  const store = new ProjectStore(dir);
  const project = await store.create({ name: 'UnresolvedContractTest', root: dir });
  // Manually define a frozen-contract specification requiring verified contract
  const frozenSpecNode = {
   ...syncFn,
   policy: 'frozen-contract' as const,
   baseline: { source: syncFn.source, contract: syncFn.contract },
  };
  project.specification = { schemaVersion: 1, nodes: [frozenSpecNode], edges: [], requirements: [] };
  const issues = protectionIssues(project, a);
  expect(issues).toContainEqual(
   expect.objectContaining({
    code: 'unverified-contract',
    nodeId: syncFn.id,
    message: expect.stringContaining('syncOrder'),
   })
  );
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('ensures interface changes are structurally visible while internal edits preserve frozen contracts (T035 AC 1)', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-contracts-structural-'));
 try {
  const fixtureDir = resolve('tests/fixtures/typescript-contracts');
  const projectDir = join(dir, 'project');
  const candidateDir = join(dir, 'candidate');
  await cp(fixtureDir, projectDir, { recursive: true });

  const store = new ProjectStore(dir);
  const project = await store.create({ name: 'StructuralReviewTest', root: projectDir });
  const analyzer = new Analyzer();
  const initialAnalysis = await analyzer.analyze(projectDir);
  await store.updateAnalysis(project.id, initialAnalysis);

  const queryableNode = initialAnalysis.graph.nodes.find(n => n.name === 'Queryable' && n.kind === 'interface')!;
  const itemServiceNode = initialAnalysis.graph.nodes.find(n => n.name === 'ItemService' && n.kind === 'class')!;

  // Freeze the interface contract
  const frozenQueryable = freezeNode({ ...queryableNode, parentId: undefined }, 'frozen-contract', initialAnalysis);
  const frozenService = freezeNode({ ...itemServiceNode, parentId: undefined }, 'frozen-contract', initialAnalysis);

  await store.updateSpec(project.id, 0, {
   nodes: [frozenQueryable, frozenService],
   edges: [],
  });

  await cp(projectDir, candidateDir, { recursive: true });

  const job: AgentJob = {
   id: 'job-1',
   projectId: project.id,
   kind: 'implementation',
   status: 'review',
   createdAt: new Date().toISOString(),
   specRevision: 1,
   sourceHashes: hashes(await captureFiles(projectDir)),
   task: 'Internal change only',
   scope: ['src/contracts.ts'],
   workspace: candidateDir,
   events: [],
  };

  // Case A: Internal implementation change only in ItemService body
  // Modifying query implementation return value while preserving all interface contracts
  const originalCode = await readFile(join(candidateDir, 'src', 'contracts.ts'), 'utf8');
  const internalEditCode = originalCode.replace('return null;', 'return { id: "custom", name: "Internal Edit" } as any;');
  await writeFile(join(candidateDir, 'src', 'contracts.ts'), internalEditCode);

  const reportInternal = await validateCandidate(await store.get(project.id), job);
  // Internal edits preserve frozen contract
  expect(reportInternal.issues.filter(i => i.code === 'frozen-contract')).toHaveLength(0);
  expect(reportInternal.passed).toBe(true);

  // Case B: Structural interface change (changing method signature parameter type)
  // query(id: string) -> query(id: number)
  const interfaceEditCode = originalCode.replace('query(id: string): Promise<T | null>;', 'query(id: number): Promise<T | null>;');
  await writeFile(join(candidateDir, 'src', 'contracts.ts'), interfaceEditCode);

  const reportInterfaceEdit = await validateCandidate(await store.get(project.id), job);
  expect(reportInterfaceEdit.passed).toBe(false);
  expect(reportInterfaceEdit.issues).toContainEqual(
   expect.objectContaining({
    code: 'frozen-contract',
    message: expect.stringContaining('Queryable'),
   })
  );

  // Case C: Structural interface change (changing optionality or member shape)
  // displayName?: string -> displayName: string (optional property becomes required)
  const optionalityEditCode = originalCode.replace('displayName?: string;', 'displayName: string;');
  await writeFile(join(candidateDir, 'src', 'contracts.ts'), optionalityEditCode);

  const candidateAnalysis = await analyzer.analyze(candidateDir);
  const changedIdentifiable = candidateAnalysis.graph.nodes.find(n => n.name === 'Identifiable')!;
  // Interface change is structurally visible in the contract property string
  expect(changedIdentifiable.contract).toContain('displayName: string');
  expect(changedIdentifiable.contract).not.toContain('displayName?:');
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('imports aliased calls, inheritance, and an implemented interface (T036 concrete scenario 1 & AC 1)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-relationships');
 const analyzer = new Analyzer();
 const a = await analyzer.analyze(fixtureDir);

 // 1. Quality report and graph validity
 expect(a.status).toBe('current');
 expect(a.quality.unresolvedReferences).toBe(0);
 expect(a.quality.unsupportedConstructs).toBe(0);
 expect(a.quality.diagnostics).toEqual([]);
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);

 const nodes = a.graph.nodes;
 const edges = a.graph.edges;

 // 2. Verify declared nodes across modules
 const identifiable = nodes.find(n => n.kind === 'interface' && n.name === 'Identifiable')!;
 const auditable = nodes.find(n => n.kind === 'interface' && n.name === 'Auditable')!;
 const baseModel = nodes.find(n => n.kind === 'class' && n.name === 'BaseModel')!;
 const repository = nodes.find(n => n.kind === 'class' && n.name === 'Repository')!;
 const orderRepository = nodes.find(n => n.kind === 'class' && n.name === 'OrderRepository')!;
 const orderService = nodes.find(n => n.kind === 'class' && n.name === 'OrderService')!;
 const iOrderProcessor = nodes.find(n => n.kind === 'interface' && n.name === 'IOrderProcessor')!;

 const calculateTaxFn = nodes.find(n => n.kind === 'function' && n.name === 'calculateTax')!;
 const clampFn = nodes.find(n => n.kind === 'function' && n.name === 'clamp')!;
 const defaultFormatterFn = nodes.find(n => n.kind === 'function' && n.name === 'defaultFormatter')!;
 const processOrderMethod = nodes.find(n => n.kind === 'function' && n.name === 'processOrder' && n.parentId === orderService.id)!;
 const validateStatusMethod = nodes.find(n => n.kind === 'function' && n.name === 'validateStatus' && n.parentId === orderService.id)!;
 const createDefaultMethod = nodes.find(n => n.kind === 'function' && n.name === 'createDefault' && n.parentId === orderService.id)!;
 const orderRepoFindMethod = nodes.find(n => n.kind === 'function' && n.name === 'find' && n.parentId === orderRepository.id)!;
 const processorContractMethod = nodes.find(n => n.kind === 'function' && n.name === 'processOrder' && n.parentId === iOrderProcessor.id)!;
 const runWorkflowFn = nodes.find(n => n.kind === 'function' && n.name === 'runWorkflow')!;

 expect(identifiable).toBeDefined();
 expect(auditable).toBeDefined();
 expect(baseModel).toBeDefined();
 expect(repository).toBeDefined();
 expect(orderRepository).toBeDefined();
 expect(orderService).toBeDefined();
 expect(iOrderProcessor).toBeDefined();
 expect(calculateTaxFn).toBeDefined();
 expect(clampFn).toBeDefined();
 expect(defaultFormatterFn).toBeDefined();
 expect(processOrderMethod).toBeDefined();
 expect(validateStatusMethod).toBeDefined();
 expect(createDefaultMethod).toBeDefined();
 expect(orderRepoFindMethod).toBeDefined();
 expect(processorContractMethod).toBeDefined();
 expect(runWorkflowFn).toBeDefined();

 // 3. Verify inheritance (inherits edges) through direct and aliased declarations
 // Auditable extends Identifiable
 expect(edges).toContainEqual(expect.objectContaining({
  source: auditable.id,
  target: identifiable.id,
  kind: 'inherits',
 }));
 // Repository extends AliasedBaseModel (BaseModel)
 expect(edges).toContainEqual(expect.objectContaining({
  source: repository.id,
  target: baseModel.id,
  kind: 'inherits',
 }));
 // OrderRepository extends Repository
 expect(edges).toContainEqual(expect.objectContaining({
  source: orderRepository.id,
  target: repository.id,
  kind: 'inherits',
 }));
 // OrderService extends AliasedBaseModel (BaseModel)
 expect(edges).toContainEqual(expect.objectContaining({
  source: orderService.id,
  target: baseModel.id,
  kind: 'inherits',
 }));

 // 4. Verify interface implementation (implements edges) through direct and aliased declarations
 // BaseModel implements Identifiable
 expect(edges).toContainEqual(expect.objectContaining({
  source: baseModel.id,
  target: identifiable.id,
  kind: 'implements',
 }));
 // OrderService implements IOrderProcessor
 expect(edges).toContainEqual(expect.objectContaining({
  source: orderService.id,
  target: iOrderProcessor.id,
  kind: 'implements',
 }));
 // OrderService implements AliasedAuditable (Auditable)
 expect(edges).toContainEqual(expect.objectContaining({
  source: orderService.id,
  target: auditable.id,
  kind: 'implements',
 }));

 // 5. Verify aliased calls resolve to the expected graph targets (AC 1)
 // OrderService.processOrder calls computeTax -> resolves to calculateTax
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: calculateTaxFn.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls constrainValue -> resolves to clamp
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: clampFn.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls stringFormatter -> resolves to defaultFormatter
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: defaultFormatterFn.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls defaultFormatter directly -> resolves to defaultFormatter
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: defaultFormatterFn.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls MathUtils.calculateTax (namespace member call) -> resolves to calculateTax
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: calculateTaxFn.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls this.repository.find -> resolves to OrderRepository.find
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: orderRepoFindMethod.id,
  kind: 'calls',
  uncertain: false,
 }));
 // OrderService.processOrder calls this['validateStatus']() (string literal element access) -> resolves to validateStatus
 expect(edges).toContainEqual(expect.objectContaining({
  source: processOrderMethod.id,
  target: validateStatusMethod.id,
  kind: 'calls',
  uncertain: false,
 }));

 // 6. Verify static member calls, constructor calls, and typed contract calls
 // OrderService.createDefault calls new OrderService()
 expect(edges).toContainEqual(expect.objectContaining({
  source: createDefaultMethod.id,
  target: orderService.id,
  kind: 'calls',
  uncertain: false,
 }));
 // runWorkflow calls OrderService.createDefault()
 expect(edges).toContainEqual(expect.objectContaining({
  source: runWorkflowFn.id,
  target: createDefaultMethod.id,
  kind: 'calls',
  uncertain: false,
 }));
 // runWorkflow calls processor.processOrder() (interface contract call)
 expect(edges).toContainEqual(expect.objectContaining({
  source: runWorkflowFn.id,
  target: processorContractMethod.id,
  kind: 'calls',
  uncertain: false,
 }));

 // 7. Module depends-on relationships
 const reexportMod = nodes.find(n => n.kind === 'module' && n.name === 'src/reexport.ts')!;
 const utilsMod = nodes.find(n => n.kind === 'module' && n.name === 'src/utils.ts')!;
 const servicesMod = nodes.find(n => n.kind === 'module' && n.name === 'src/services.ts')!;
 const modelsMod = nodes.find(n => n.kind === 'module' && n.name === 'src/models.ts')!;
 const indexMod = nodes.find(n => n.kind === 'module' && n.name === 'src/index.ts')!;

 expect(edges).toContainEqual(expect.objectContaining({ source: reexportMod.id, target: utilsMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: servicesMod.id, target: modelsMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: servicesMod.id, target: reexportMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: servicesMod.id, target: utilsMod.id, kind: 'depends-on' }));
 expect(edges).toContainEqual(expect.objectContaining({ source: indexMod.id, target: servicesMod.id, kind: 'depends-on' }));
});

it('exercises an unresolved import and dynamic property call (T036 concrete scenario 2, AC 2 & AC 3)', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-relationships-unresolved-'));
 try {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
   join(dir, 'package.json'),
   JSON.stringify({ name: 'test-unresolved-dispatch', version: '1.0.0', dependencies: { typescript: '6.0.3' } })
  );
  await writeFile(
   join(dir, 'tsconfig.json'),
   JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, noEmit: true },
    include: ['src/**/*'],
   })
  );
  await writeFile(
   join(dir, 'src', 'dispatch.ts'),
   `import { missingUtility } from './absent-utils';
import { MissingContract } from './missing-contract';

export class Dispatcher implements MissingContract {
  execute(dynamicKey: string, payload: any): void {
    // 1. Call to unresolved import
    missingUtility();

    // 2. Dynamic element access with variable key
    payload[dynamicKey]();

    // 3. Dynamic element access on any with literal key
    payload['dynamicAction']();

    // 4. Dynamic property call on any
    (payload as any).dynamicMethod();
  }
}
`
  );

  const analyzer = new Analyzer();
  const a = await analyzer.analyze(dir);

  // 1. Status is partial due to unresolved references and diagnostics
  expect(a.status).toBe('partial');
  expect(a.status).not.toBe('current');

  // 2. AC 3: Missing targets contribute to the quality report
  expect(a.quality.unresolvedReferences).toBeGreaterThanOrEqual(3);
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unresolved-import',
    severity: 'error',
    message: expect.stringContaining('./absent-utils'),
   })
  );
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unresolved-import',
    severity: 'error',
    message: expect.stringContaining('./missing-contract'),
   })
  );
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unresolved-call',
    severity: 'warning',
    message: expect.stringContaining('missingUtility'),
   })
  );

  // 3. AC 2: Unsupported dispatch does not produce invented certainty
  // Dynamic property calls are recorded as unsupported constructs, NOT invented calls edges
  expect(a.quality.unsupportedConstructs).toBeGreaterThanOrEqual(3);
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unsupported-dispatch',
    severity: 'warning',
    message: expect.stringContaining('payload[dynamicKey]'),
   })
  );
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unsupported-dispatch',
    severity: 'warning',
    message: expect.stringContaining("payload['dynamicAction']"),
   })
  );
  expect(a.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    code: 'unsupported-dispatch',
    severity: 'warning',
    message: expect.stringContaining('(payload as any).dynamicMethod'),
   })
  );

  const dispatcherNode = a.graph.nodes.find(n => n.name === 'Dispatcher' && n.kind === 'class')!;
  const executeMethod = a.graph.nodes.find(n => n.name === 'execute' && n.parentId === dispatcherNode.id)!;
  expect(dispatcherNode).toBeDefined();
  expect(executeMethod).toBeDefined();

  // No fake calls edges for dynamic property calls exist from executeMethod
  const callEdges = a.graph.edges.filter(e => e.source === executeMethod.id && e.kind === 'calls');
  // Only the named call to missingUtility has an uncertain calls edge; none of the 3 dynamic calls produced invented edges
  for (const call of callEdges) {
   const target = a.graph.nodes.find(n => n.id === call.target)!;
   expect(target.name).not.toContain('dynamicKey');
   expect(target.name).not.toContain('dynamicAction');
   expect(target.name).not.toContain('dynamicMethod');
  }

  // Graph structure remains valid
  expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('imports a nested loop/condition with try/catch/throw and returns (T037 concrete scenario 1 & AC 1-3)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-workflows');
 const analyzer = new Analyzer();
 const a = await analyzer.analyze(fixtureDir);

 // 1. Quality report and graph validity
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 expect(a.quality.unresolvedReferences).toBe(0);
 // unsupportedWorkflow has 1 unsupported construct (switch statement)
 expect(a.quality.unsupportedConstructs).toBe(1);
 expect(a.quality.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'warning',
   message: expect.stringContaining('Workflow contains a source-backed block'),
  })
 );

 const nodes = a.graph.nodes;
 const edges = a.graph.edges;

 // 2. Identify runWorkflow function and its workflow steps
 const runWorkflowFn = nodes.find(n => n.kind === 'function' && n.name === 'runWorkflow')!;
 expect(runWorkflowFn).toBeDefined();

 const workflowSteps = nodes.filter(n => n.kind === 'step' && n.parentId === runWorkflowFn.id);
 expect(workflowSteps.length).toBeGreaterThanOrEqual(10);

 const tryStep = workflowSteps.find(s => s.stepType === 'try')!;
 const loops = workflowSteps.filter(s => s.stepType === 'loop');
 const conditions = workflowSteps.filter(s => s.stepType === 'condition');
 const throws = workflowSteps.filter(s => s.stepType === 'throw');
 const returns = workflowSteps.filter(s => s.stepType === 'return');
 const catchStep = workflowSteps.find(s => s.stepType === 'operation' && s.name.startsWith('catch'))!;
 const calls = workflowSteps.filter(s => s.stepType === 'call');

 expect(tryStep).toBeDefined();
 expect(loops.length).toBe(2);
 expect(conditions.length).toBe(2);
 expect(throws.length).toBe(2);
 expect(returns.length).toBe(2);
 expect(catchStep).toBeDefined();
 expect(calls.length).toBe(2);

 const outerLoop = loops.find(l => l.name.includes('batch of batches'))!;
 const innerLoop = loops.find(l => l.name.includes('item of batch'))!;
 const emptyBatchCond = conditions.find(c => c.name.includes('batch.length === 0'))!;
 const poisonCond = conditions.find(c => c.name.includes("item === 'poison'"))!;
 const emptyBatchThrow = throws.find(t => t.name.includes('Empty batch'))!;
 const poisonThrow = throws.find(t => t.name.includes('Poison pill'))!;
 const completedReturn = returns.find(r => r.name.includes("'completed'"))!;
 const failedReturn = returns.find(r => r.name.includes("'failed'"))!;
 const processItemCall = calls.find(c => c.name.includes('processItem'))!;
 const recordFailureCall = calls.find(c => c.name.includes('recordFailure'))!;

 expect(outerLoop).toBeDefined();
 expect(innerLoop).toBeDefined();
 expect(emptyBatchCond).toBeDefined();
 expect(poisonCond).toBeDefined();
 expect(emptyBatchThrow).toBeDefined();
 expect(poisonThrow).toBeDefined();
 expect(completedReturn).toBeDefined();
 expect(failedReturn).toBeDefined();
 expect(processItemCall).toBeDefined();
 expect(recordFailureCall).toBeDefined();

 // 3. Verify ownership: all steps are owned by runWorkflowFn (AC 1)
 for (const step of workflowSteps) {
  expect(step.parentId).toBe(runWorkflowFn.id);
  expect(step.provenance).toBe('extracted');
  expect(step.source).toBeDefined();
  expect(step.source?.path).toBe('src/workflows.ts');
  expect(step.source?.revision).toBe(a.revision);
 }

 // 4. Verify branch edges and transitions (concrete scenario 1)
 // try --[next]--> outerLoop
 expect(edges).toContainEqual(expect.objectContaining({
  source: tryStep.id,
  target: outerLoop.id,
  kind: 'next',
 }));

 // outerLoop --[true]--> emptyBatchCond
 expect(edges).toContainEqual(expect.objectContaining({
  source: outerLoop.id,
  target: emptyBatchCond.id,
  kind: 'true',
 }));

 // emptyBatchCond --[true]--> emptyBatchThrow
 expect(edges).toContainEqual(expect.objectContaining({
  source: emptyBatchCond.id,
  target: emptyBatchThrow.id,
  kind: 'true',
 }));

 // emptyBatchCond --[false]--> innerLoop
 expect(edges).toContainEqual(expect.objectContaining({
  source: emptyBatchCond.id,
  target: innerLoop.id,
  kind: 'false',
 }));

 // innerLoop --[true]--> poisonCond
 expect(edges).toContainEqual(expect.objectContaining({
  source: innerLoop.id,
  target: poisonCond.id,
  kind: 'true',
 }));

 // poisonCond --[true]--> poisonThrow
 expect(edges).toContainEqual(expect.objectContaining({
  source: poisonCond.id,
  target: poisonThrow.id,
  kind: 'true',
 }));

 // poisonCond --[false]--> processItemCall
 expect(edges).toContainEqual(expect.objectContaining({
  source: poisonCond.id,
  target: processItemCall.id,
  kind: 'false',
 }));

 // processItemCall --[next]--> innerLoop (inner loop repeat)
 expect(edges).toContainEqual(expect.objectContaining({
  source: processItemCall.id,
  target: innerLoop.id,
  kind: 'next',
 }));

 // innerLoop --[false]--> outerLoop (inner loop completion loops back to outer)
 expect(edges).toContainEqual(expect.objectContaining({
  source: innerLoop.id,
  target: outerLoop.id,
  kind: 'false',
 }));

 // outerLoop --[false]--> completedReturn (outer loop completion exits to return)
 expect(edges).toContainEqual(expect.objectContaining({
  source: outerLoop.id,
  target: completedReturn.id,
  kind: 'false',
 }));

 // Exception transitions: throw --[exception]--> catchStep
 expect(edges).toContainEqual(expect.objectContaining({
  source: emptyBatchThrow.id,
  target: catchStep.id,
  kind: 'exception',
  label: 'Failure',
 }));
 expect(edges).toContainEqual(expect.objectContaining({
  source: poisonThrow.id,
  target: catchStep.id,
  kind: 'exception',
  label: 'Failure',
 }));

 // catchStep --[next]--> recordFailureCall
 expect(edges).toContainEqual(expect.objectContaining({
  source: catchStep.id,
  target: recordFailureCall.id,
  kind: 'next',
 }));

 // recordFailureCall --[next]--> failedReturn
 expect(edges).toContainEqual(expect.objectContaining({
  source: recordFailureCall.id,
  target: failedReturn.id,
  kind: 'next',
 }));

 // 5. Confirm returns and throws do NOT continue with next
 for (const terminal of [emptyBatchThrow, poisonThrow, completedReturn, failedReturn]) {
  const nextEdges = edges.filter(e => e.source === terminal.id && e.kind === 'next');
  expect(nextEdges).toHaveLength(0);
 }
});

it('ensures description-only intended functions remain untouched and opaque logic retains source evidence (T037 AC 2 & AC 3)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-workflows');
 const analyzer = new Analyzer();
 const a = await analyzer.analyze(fixtureDir);

 // 1. Description-only intended functions in code (interface method signatures) have no workflow steps
 const ifaceService = a.graph.nodes.find(n => n.kind === 'interface' && n.name === 'IWorkflowService')!;
 expect(ifaceService).toBeDefined();
 const descMethod = a.graph.nodes.find(n => n.kind === 'function' && n.name === 'describeWorkflow' && n.parentId === ifaceService.id)!;
 expect(descMethod).toBeDefined();
 const descSteps = a.graph.nodes.filter(n => n.kind === 'step' && n.parentId === descMethod.id);
 expect(descSteps).toHaveLength(0);

 // 2. Description-only intended function in ProjectStore specification is untouched
 const tempDir = await mkdtemp(join(tmpdir(), 'architect-desc-func-'));
 try {
  const store = new ProjectStore(tempDir);
  const project = await store.create({ name: 'DescFuncTest', root: fixtureDir });

  const humanDescOnlyNode = {
   id: 'human-desc-only-fn',
   kind: 'function' as const,
   name: 'plannedFeature',
   description: 'Intended specification for a future feature',
   provenance: 'human' as const,
   policy: 'editable' as const,
   contract: 'plannedFeature(): void',
   requiredChecks: [],
   instructions: 'Human intent',
   outputPath: '',
   fields: [],
  };

  await store.updateSpec(project.id, 0, {
   nodes: [humanDescOnlyNode],
   edges: [],
  });

  const updatedProject = await store.get(project.id);
  expect(updatedProject.specification.nodes).toHaveLength(1);
  const specFn = updatedProject.specification.nodes[0];
  expect(specFn.id).toBe('human-desc-only-fn');
  expect(specFn.stepType).toBeUndefined();
  expect(specFn.description).toBe('Intended specification for a future feature');
  const specSteps = updatedProject.specification.nodes.filter(n => n.kind === 'step');
  expect(specSteps).toHaveLength(0);
 } finally {
  await rm(tempDir, { recursive: true, force: true });
 }

 // 3. Unsupported logic remains visible as source-backed opaque nodes (AC 3 & R08)
 const unsupportedFn = a.graph.nodes.find(n => n.kind === 'function' && n.name === 'unsupportedWorkflow')!;
 expect(unsupportedFn).toBeDefined();
 const opaqueStep = a.graph.nodes.find(n => n.kind === 'step' && n.parentId === unsupportedFn.id && n.stepType === 'opaque')!;
 expect(opaqueStep).toBeDefined();
 expect(opaqueStep.source).toBeDefined();
 expect(opaqueStep.source?.path).toBe('src/workflows.ts');
 const evidence = resolveSourceEvidence(opaqueStep.source, a, a.revision);
 expect(evidence.status).toBe('current');
 if (evidence.status === 'current') {
  expect(evidence.text).toContain('switch (code)');
 }
});

it('compares workflow nodes and branch edges against an expected graph (T037 concrete scenario 2)', async () => {
 const fixtureDir = resolve('tests/fixtures/typescript-workflows');
 const expectedPath = resolve('tests/fixtures/typescript-workflows.expected.json');

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

it('imports unsupported dynamic and evaluated logic as visible opaque nodes (T038 concrete scenario 1 & AC 1-3)', async () => {
 const fixtureDir = resolve('tests/fixtures/unsupported');
 const expectedPath = resolve('tests/fixtures/unsupported.expected.json');

 const analyzer = new Analyzer();
 const a = await analyzer.analyze(fixtureDir);

 // 1. Schema validity and quality separation (checklist item 4)
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);
 expect(a.status).toBe('partial'); // partial due to unsupported warnings
 expect(a.quality.unresolvedReferences).toBe(0);
 expect(a.quality.inferredItems).toBe(0); // AC 3: opaque logic is not AI-verified
 expect(a.quality.unsupportedConstructs).toBe(4);

 // 2. Diagnostics verify reasons and codes (checklist item 3)
 expect(a.quality.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'warning',
   code: 'unsupported-eval',
   message: expect.stringContaining('Dynamic code evaluation via eval'),
  })
 );
 expect(a.quality.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'warning',
   code: 'unsupported-eval',
   message: expect.stringContaining('Dynamic code evaluation via Function constructor'),
  })
 );
 expect(a.quality.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'warning',
   code: 'unsupported-dispatch',
   message: expect.stringContaining('dispatcher[method]'),
  })
 );
 expect(a.quality.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'warning',
   code: 'unsupported-switch',
   message: expect.stringContaining('Switch statement execution paths are not fully reconstructed'),
  })
 );

 // 3. Opaque nodes in graph
 const opaqueNodes = a.graph.nodes.filter(n => n.kind === 'step' && n.stepType === 'opaque');
 expect(opaqueNodes).toHaveLength(4);

 // AC 2: Unsupported counts correspond to visible findings
 expect(a.quality.unsupportedConstructs).toBe(opaqueNodes.length);

 // AC 1: Opaque nodes open their original source
 for (const node of opaqueNodes) {
  expect(node.source).toBeDefined();
  expect(node.source?.path).toBe('src/dynamic.ts');
  expect(node.source?.line).toBeGreaterThan(0);
  expect(node.source?.start).toBeLessThan(node.source!.end);

  const evidence = resolveSourceEvidence(node.source, a, a.revision);
  expect(evidence.status).toBe('current');
  if (evidence.status === 'current') {
   expect(evidence.text.length).toBeGreaterThan(0);
   // Slices original file text directly
   expect(a.files['src/dynamic.ts'].text.slice(node.source!.start, node.source!.end)).toBe(evidence.text);
  }
 }

 // AC 3: Opaque content does not become AI-verified behavior
 for (const node of opaqueNodes) {
  expect(node.provenance).toBe('extracted');
  expect(node.policy).toBe('editable');
 }
 const opaqueEdges = a.graph.edges.filter(e => opaqueNodes.some(n => n.id === e.source || n.id === e.target));
 for (const edge of opaqueEdges) {
  expect(edge.provenance).toBe('extracted');
 }

 // Supported function (supportedAdd) remains clean workflow with no opaque nodes
 const addFn = a.graph.nodes.find(n => n.kind === 'function' && n.name === 'supportedAdd')!;
 expect(addFn).toBeDefined();
 const addSteps = a.graph.nodes.filter(n => n.kind === 'step' && n.parentId === addFn.id);
 expect(addSteps).toHaveLength(1);
 expect(addSteps[0].stepType).toBe('return');

 // Expected graph persistence and verification (R31)
 const expectedContent = await readFile(expectedPath, 'utf8');
 const expectedGraph = JSON.parse(expectedContent);
 expect(GraphSchema.safeParse(expectedGraph).success).toBe(true);
 expect(a.graph.schemaVersion).toBe(expectedGraph.schemaVersion);
 expect(a.graph.nodes.length).toBe(expectedGraph.nodes.length);
 expect(a.graph.edges.length).toBe(expectedGraph.edges.length);
 expect(a.graph).toEqual(expectedGraph);
});

it('inspects an opaque node after its source changes (T038 concrete scenario 2 & AC 1)', async () => {
 const tempDir = resolve('tests/fixtures/temp-unsupported-' + Date.now());
 const fixtureDir = resolve('tests/fixtures/unsupported');

 try {
  await cp(fixtureDir, tempDir, { recursive: true });
  const analyzer = new Analyzer();

  // 1. Initial analysis
  const a1 = await analyzer.analyze(tempDir);
  expect(a1.quality.unsupportedConstructs).toBe(4);

  const evalStep1 = a1.graph.nodes.find(
   n => n.kind === 'step' && n.stepType === 'opaque' && n.name.includes('eval(expression)')
  )!;
  expect(evalStep1).toBeDefined();

  const evidence1 = resolveSourceEvidence(evalStep1.source, a1, a1.revision);
  expect(evidence1.status).toBe('current');
  if (evidence1.status === 'current') {
   expect(evidence1.text).toContain('const evaluated = eval(expression);');
  }

  // 2. Modify source on disk
  const dynamicFilePath = resolve(tempDir, 'src/dynamic.ts');
  const originalSource = await readFile(dynamicFilePath, 'utf8');
  const modifiedSource = '// Prepended comment shifting source positions\n\n' +
   originalSource.replace('const evaluated = eval(expression);', 'const evaluated = eval(expression.trim()); // modified');
  await writeFile(dynamicFilePath, modifiedSource, 'utf8');

  // 3. Inspect original opaque node against modified file before re-analyzing:
  // Content hash mismatch is detected and rejected
  const hashMismatchEvidence = resolveSourceEvidence(
   evalStep1.source,
   { ...a1, files: { 'src/dynamic.ts': { hash: 'modified-unmatched-hash', text: modifiedSource } } },
   a1.revision
  );
  expect(hashMismatchEvidence.status).toBe('invalid');
  if (hashMismatchEvidence.status === 'invalid') {
   expect(hashMismatchEvidence.message).toContain('Source content hash does not match');
  }

  // 4. Re-analyze modified source
  const a2 = await analyzer.analyze(tempDir);
  expect(a2.revision).not.toBe(a1.revision);

  const evalStep2 = a2.graph.nodes.find(
   n => n.kind === 'step' && n.stepType === 'opaque' && n.name.includes('eval(expression.trim())')
  )!;
  expect(evalStep2).toBeDefined();
  expect(evalStep2.source?.revision).toBe(a2.revision);
  expect(evalStep2.source?.hash).not.toBe(evalStep1.source?.hash);
  expect(evalStep2.source?.line).toBeGreaterThan(evalStep1.source!.line); // shifted down

  const evidence2 = resolveSourceEvidence(evalStep2.source, a2, a2.revision);
  expect(evidence2.status).toBe('current');
  if (evidence2.status === 'current') {
   expect(evidence2.text).toContain('const evaluated = eval(expression.trim());');
  }

  // 5. Inspecting old opaque node against new analysis:
  // Revision is unavailable in the newer analysis snapshot
  const unavailableEvidence = resolveSourceEvidence(evalStep1.source, a2, a2.revision);
  expect(unavailableEvidence.status).toBe('unavailable');
  if (unavailableEvidence.status === 'unavailable') {
   expect(unavailableEvidence.message).toContain('Captured source revision is unavailable');
  }

  // 6. Inspecting old opaque node when marked stale:
  const staleEvidence = resolveSourceEvidence(
   evalStep1.source,
   {
    ...a1,
    status: 'stale',
    staleEvidence: { scope: 'paths', paths: ['src/dynamic.ts'], reason: 'File changed on disk' },
   },
   a2.revision
  );
  expect(staleEvidence.status).toBe('stale');
 } finally {
  await rm(tempDir, { recursive: true, force: true });
 }
});

it('verifies explicit Prisma parser configuration visibility and options (T039 AC 1)', async () => {
 // 1. Visible parser configuration constants
 expect(PRISMA_PARSER_CONFIG).toEqual({ nodeLocationTracking: 'full' });
 expect(DEFAULT_PRISMA_PARSER_CONFIG).toEqual({ nodeLocationTracking: 'full' });
 expect(Analyzer.PRISMA_PARSER_CONFIG).toEqual({ nodeLocationTracking: 'full' });

 // 2. Visible on Analyzer instance
 const analyzer = new Analyzer();
 expect(analyzer.prismaParserConfig).toEqual({ nodeLocationTracking: 'full' });

 // 3. Configurable via constructor
 const customAnalyzer = new Analyzer({ prismaParserConfig: { nodeLocationTracking: 'full' } });
 expect(customAnalyzer.prismaParserConfig.nodeLocationTracking).toBe('full');

 // 4. Parser creation factory initializes parser with explicit configuration
 const parser = createPrismaParser();
 expect(parser.config.nodeLocationTracking).toBe('full');

 // 5. Helper findPrismaBlockEnd correctly identifies block boundaries
 const sampleText = 'model Sample {\n  id Int @id\n}\nenum SampleRole {\n  A\n  B\n}';
 const modelEnd = findPrismaBlockEnd(sampleText, 0);
 expect(sampleText.slice(0, modelEnd)).toBe('model Sample {\n  id Int @id\n}');
 const enumStart = sampleText.indexOf('enum');
 const enumEnd = findPrismaBlockEnd(sampleText, enumStart);
 expect(sampleText.slice(enumStart, enumEnd)).toBe('enum SampleRole {\n  A\n  B\n}');
});

it('parses Prisma schema text and produces explicit diagnostics on syntax errors (T039 AC 2 & checklist 2)', async () => {
 // 1. Valid schema text parses with AST and empty diagnostics
 const validSchema = `datasource db {
  provider = "sqlite"
}
model User {
  id Int @id
}
enum Role {
  USER
  ADMIN
}`;
 const validResult = parsePrismaSchema('prisma/schema.prisma', validSchema);
 expect(validResult.schema).toBeDefined();
 expect(validResult.schema?.type).toBe('schema');
 expect(validResult.diagnostics).toEqual([]);

 // Model location tracking is populated due to explicit nodeLocationTracking: 'full'
 const userModel = validResult.schema?.list.find((b: any) => b.type === 'model' && b.name === 'User') as any;
 expect(userModel).toBeDefined();
 expect(userModel.location).toBeDefined();
 expect(userModel.location.startLine).toBe(4);

 const roleEnum = validResult.schema?.list.find((b: any) => b.type === 'enum' && b.name === 'Role') as any;
 expect(roleEnum).toBeDefined();
 expect(roleEnum.location).toBeDefined();
 expect(roleEnum.location.startLine).toBe(7);

 // 2. Malformed schema produces explicit error diagnostics with path, line, code, and message
 const malformedSchema = `model Broken {
  id Int @id
  invalid syntax here
}`;
 const malformedResult = parsePrismaSchema('prisma/broken.prisma', malformedSchema);
 expect(malformedResult.schema).toBeUndefined();
 expect(malformedResult.diagnostics.length).toBeGreaterThan(0);
 const diag = malformedResult.diagnostics[0];
 expect(diag.severity).toBe('error');
 expect(diag.path).toBe('prisma/broken.prisma');
 expect(diag.code).toBe('prisma-parse-error');
 expect(diag.line).toBe(3);
 expect(diag.message).toContain('Prisma parse failed');

 // 3. Corrupted / unclosed schema produces diagnostics with line
 const unclosedSchema = `model Unclosed {
  id Int @id
`;
 const unclosedResult = parsePrismaSchema('prisma/unclosed.prisma', unclosedSchema);
 expect(unclosedResult.schema).toBeUndefined();
 expect(unclosedResult.diagnostics).toContainEqual(
  expect.objectContaining({
   severity: 'error',
   path: 'prisma/unclosed.prisma',
   code: 'prisma-parse-error',
   line: expect.any(Number),
  })
 );
});

it('parses valid and malformed schema fixtures, reporting schema paths and ranges (T039 concrete scenario 1 & AC 1-3)', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-fixtures-'));
 try {
  await cp(resolve('tests/fixtures/prisma-parser'), dir, { recursive: true });

  // A. Valid-only scenario: remove malformed.prisma so only valid.prisma remains
  await rm(join(dir, 'prisma', 'malformed.prisma'), { force: true });

  const analyzer = new Analyzer();
  const discovery = await analyzer.discoverInputs(dir);
  expect(discovery.eligibleFiles).toEqual(['prisma/valid.prisma', 'src/index.ts']);
  expect(discovery.prismaSchemas).toEqual(['prisma/valid.prisma']);

  const validAnalysis = await analyzer.analyze(dir);
  // Quality and status
  expect(validAnalysis.status).toBe('current');
  expect(validAnalysis.quality.eligibleFiles).toBe(2);
  expect(validAnalysis.quality.analyzedFiles).toBe(2);
  expect(validAnalysis.quality.diagnostics).toEqual([]);
  // Prisma validation reported as unavailable, never passed
  expect(validAnalysis.quality.prismaValidation).toBe('unavailable');

  // Verify extracted entity and enum nodes
  const user = validAnalysis.graph.nodes.find(n => n.kind === 'entity' && n.name === 'User')!;
  const post = validAnalysis.graph.nodes.find(n => n.kind === 'entity' && n.name === 'Post')!;
  const role = validAnalysis.graph.nodes.find(n => n.kind === 'enum' && n.name === 'Role')!;
  const moduleNode = validAnalysis.graph.nodes.find(n => n.kind === 'module' && n.name === 'prisma/valid.prisma')!;

  expect(user).toBeDefined();
  expect(post).toBeDefined();
  expect(role).toBeDefined();
  expect(moduleNode).toBeDefined();

  // Output paths and containment
  expect(user.outputPath).toBe('prisma/valid.prisma');
  expect(post.outputPath).toBe('prisma/valid.prisma');
  expect(role.outputPath).toBe('prisma/valid.prisma');
  expect(user.parentId).toBe(moduleNode.id);
  expect(post.parentId).toBe(moduleNode.id);
  expect(role.parentId).toBe(moduleNode.id);

  // Exact source evidence ranges and lines
  expect(user.source).toBeDefined();
  expect(user.source?.path).toBe('prisma/valid.prisma');
  expect(user.source?.line).toBe(10);
  expect(user.source?.start).toBeLessThan(user.source!.end);

  expect(post.source).toBeDefined();
  expect(post.source?.path).toBe('prisma/valid.prisma');
  expect(post.source?.line).toBe(17);

  expect(role.source).toBeDefined();
  expect(role.source?.path).toBe('prisma/valid.prisma');
  expect(role.source?.line).toBe(5);

  // Source evidence resolves against captured file
  const userEvidence = resolveSourceEvidence(user.source, validAnalysis, validAnalysis.revision);
  expect(userEvidence.status).toBe('current');
  if (userEvidence.status === 'current') {
   expect(userEvidence.text).toContain('model User {');
   expect(userEvidence.text).toContain('role  Role   @default(USER)');
  }

  const roleEvidence = resolveSourceEvidence(role.source, validAnalysis, validAnalysis.revision);
  expect(roleEvidence.status).toBe('current');
  if (roleEvidence.status === 'current') {
   expect(roleEvidence.text).toContain('enum Role {');
   expect(roleEvidence.text).toContain('ADMIN');
  }

  // Relations extracted
  expect(validAnalysis.graph.edges).toContainEqual(
   expect.objectContaining({ source: post.id, target: user.id, kind: 'relates-to' })
  );
  expect(GraphSchema.safeParse(validAnalysis.graph).success).toBe(true);

  // B. Malformed-only scenario: recreate malformed.prisma and remove valid.prisma
  await cp(resolve('tests/fixtures/prisma-parser/prisma/malformed.prisma'), join(dir, 'prisma', 'malformed.prisma'));
  await rm(join(dir, 'prisma', 'valid.prisma'), { force: true });

  const malformedAnalysis = await analyzer.analyze(dir);
  // Status marked partial
  expect(malformedAnalysis.status).toBe('partial');
  expect(malformedAnalysis.quality.eligibleFiles).toBe(2);
  expect(malformedAnalysis.quality.analyzedFiles).toBe(1); // Only src/index.ts was analyzed
  // Diagnostics contain the error with line and code
  expect(malformedAnalysis.quality.diagnostics).toContainEqual(
   expect.objectContaining({
    path: 'prisma/malformed.prisma',
    severity: 'error',
    code: 'prisma-parse-error',
    line: 7,
   })
  );
  // Schema failures never imply successful validation
  expect(malformedAnalysis.quality.prismaValidation).toBe('unavailable');
  expect(malformedAnalysis.quality.prismaValidation).not.toBe('passed');
  // No entity nodes extracted from malformed schema
  expect(malformedAnalysis.graph.nodes.some(n => n.name === 'BrokenModel')).toBe(false);
  expect(GraphSchema.safeParse(malformedAnalysis.graph).success).toBe(true);
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

it('imports multiple schemas where only one fails, preserving usable neighboring schemas (T039 concrete scenario 2 & AC 2-3)', async () => {
 const fixtureDir = resolve('tests/fixtures/prisma-parser');
 const analyzer = new Analyzer();

 // 1. Input discovery identifies both schemas as eligible
 const discovery = await analyzer.discoverInputs(fixtureDir);
 expect(discovery.prismaSchemas).toEqual(['prisma/malformed.prisma', 'prisma/valid.prisma']);
 expect(discovery.eligibleFiles).toEqual(['prisma/malformed.prisma', 'prisma/valid.prisma', 'src/index.ts']);
 expect(discovery.denominator).toBe(3);

 // 2. Analyze the multi-schema project where one schema is malformed
 const a = await analyzer.analyze(fixtureDir);

 // 3. Acceptance Criteria & Quality Checks:
 // Denominator covers all eligible files, numerator counts only successfully analyzed files
 expect(a.quality.eligibleFiles).toBe(3);
 expect(a.quality.analyzedFiles).toBe(2); // src/index.ts and prisma/valid.prisma; malformed.prisma omitted
 // Status is explicitly marked partial
 expect(a.status).toBe('partial');

 // 4. Malformed schema produces diagnostics with path, line, and code
 const malformedDiag = a.quality.diagnostics.find(d => d.path === 'prisma/malformed.prisma');
 expect(malformedDiag).toBeDefined();
 expect(malformedDiag?.severity).toBe('error');
 expect(malformedDiag?.code).toBe('prisma-parse-error');
 expect(malformedDiag?.line).toBe(7);
 expect(malformedDiag?.message).toContain('Prisma parse failed');

 // 5. Schema failures never imply successful validation
 expect(a.quality.prismaValidation).toBe('unavailable');
 expect(a.quality.prismaValidation).not.toBe('passed');

 // 6. Preserve usable neighboring schemas:
 // Entities and enums from prisma/valid.prisma remain in the graph and fully usable
 const user = a.graph.nodes.find(n => n.kind === 'entity' && n.name === 'User');
 const post = a.graph.nodes.find(n => n.kind === 'entity' && n.name === 'Post');
 const role = a.graph.nodes.find(n => n.kind === 'enum' && n.name === 'Role');

 expect(user).toBeDefined();
 expect(post).toBeDefined();
 expect(role).toBeDefined();

 // BrokenModel from malformed.prisma is completely absent
 expect(a.graph.nodes.some(n => n.name === 'BrokenModel')).toBe(false);

 // Neighboring relationships are preserved
 expect(a.graph.edges).toContainEqual(
  expect.objectContaining({ source: post!.id, target: user!.id, kind: 'relates-to' })
 );

 // Sourced evidence on neighboring entities and enums is intact and resolves as current
 const userEvidence = resolveSourceEvidence(user!.source, a, a.revision);
 expect(userEvidence.status).toBe('current');
 if (userEvidence.status === 'current') {
  expect(userEvidence.text).toContain('model User {');
 }

 const roleEvidence = resolveSourceEvidence(role!.source, a, a.revision);
 expect(roleEvidence.status).toBe('current');
 if (roleEvidence.status === 'current') {
  expect(roleEvidence.text).toContain('enum Role {');
 }

 // Entire graph structure remains schema-valid
 expect(GraphSchema.safeParse(a.graph).success).toBe(true);
});

it('ensures schema failures never imply successful validation in review checks (T039 AC 3)', async () => {
 const fixtureDir = resolve('tests/fixtures/prisma-parser');
 const analyzer = new Analyzer();
 const analysis = await analyzer.analyze(fixtureDir);

 // Structural check
 expect(analysis.quality.prismaValidation).not.toBe('passed');
 expect(analysis.quality.prismaValidation).toBe('unavailable');
 expect(analysis.status).toBe('partial');

 // Candidate review verification:
 // A candidate reflecting this partial analysis cannot claim passed validation
 const dir = await mkdtemp(join(tmpdir(), 'architect-review-check-'));
 try {
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'CandidateValidation', root: fixtureDir });
  expect(p.analysis?.quality.prismaValidation).not.toBe('passed');
  expect(p.analysis?.quality.prismaValidation).toBe('unavailable');
  expect(p.analysis?.status).toBe('partial');

  const candidateDir = join(dir, 'candidate');
  await cp(fixtureDir, candidateDir, { recursive: true });
  const job: AgentJob = {
   id: 'test-job',
   projectId: p.id,
   kind: 'implementation',
   status: 'review',
   createdAt: new Date().toISOString(),
   specRevision: p.specRevision,
   sourceHashes: hashes(await captureFiles(p.root)),
   task: 'Test Prisma',
   scope: ['.'],
   workspace: candidateDir,
   events: [],
  };

  const report = await validateCandidate(p, job);
  // Candidate has prisma parse error diagnostics and prisma validation is unavailable
  expect(report.candidate?.quality.prismaValidation).not.toBe('passed');
  expect(report.candidate?.quality.prismaValidation).toBe('unavailable');
  expect(report.warnings).toContain('Prisma schema parsed; project-version semantic validation is not yet available.');
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});
