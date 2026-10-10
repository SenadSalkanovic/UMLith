import {it,expect,describe,vi} from 'vitest';
import {mkdtemp,writeFile,rm,rename,unlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {
 SyncService,
 isRelevantAnalysisInput,
 isGeneratedOrTemporaryFile,
 areHashesEqual,
 getRelevantInputHashes,
} from '../server/sync';
import {Analyzer} from '../server/analyzer';
import {AnalysisWorker} from '../server/worker';
import {AnalysisSchema,GraphUpdateSchema,applyGraphUpdate,resolveSourceEvidence} from '../shared/model';
import {getOutdatedPortions} from '../src/components/AnalysisStatus';
import {createServer} from '../server/main';
import {AnalysisClient} from '../src/analysis-client';

it('updates the implemented graph while preserving human intent and retains a stale model on invalid saves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sync-'));
 const store=new ProjectStore(dir);const p=await store.create({name:'Live'});
 const sync=new SyncService(store,{watch:false});
 const updates:unknown[]=[];
 sync.on('notification',(_id,event)=>{if(event.type==='analysis')updates.push(event);});
 try{
  await writeFile(join(p.root,'main.ts'),'export function original() { return 1; }');
  await sync.start(p.id);
  const before=await store.get(p.id);
  expect(before.analysis?.graph.nodes.some(n=>n.name==='original')).toBe(true);
  expect(AnalysisSchema.safeParse(before.analysis).success).toBe(true);
  const initial=GraphUpdateSchema.parse(updates[0]);
  expect(initial).toMatchObject({baseRevision:null,baseSequence:0,sequence:1,revision:before.analysis!.revision});
  expect(applyGraphUpdate(undefined,initial)).toEqual(before.analysis!.graph);
  await store.updateSpec(p.id,0,{nodes:[{...before.analysis!.graph.nodes.find(n=>n.name==='original')!,parentId:undefined,description:'Human-owned rule'}],edges:[]});
  await writeFile(join(p.root,'main.ts'),'export function changed() { return 2; }');
  await sync.request(p.id);
  const changed=await store.get(p.id);
  expect(changed.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(changed.specification.nodes[0].description).toBe('Human-owned rule');
  const update=GraphUpdateSchema.parse(updates[1]);
  expect(update).toMatchObject({baseRevision:before.analysis!.revision,baseSequence:1,sequence:2,revision:changed.analysis!.revision});
  expect(applyGraphUpdate(before.analysis,update)).toEqual(changed.analysis!.graph);
  expect(()=>applyGraphUpdate(changed.analysis,update)).toThrow(/revision|sequence/i);
  await writeFile(join(p.root,'main.ts'),'export function changed( {');
  await sync.request(p.id);
  const invalid=await store.get(p.id);
  expect(invalid.analysis?.status).toBe('stale');
  expect(invalid.analysis?.graph.nodes.some(n=>n.name==='changed')).toBe(true);
  expect(invalid.analysis?.files['main.ts'].text).toContain('return 2');
  expect(AnalysisSchema.safeParse(invalid.analysis).success).toBe(true);
  expect(invalid.analysis?.staleEvidence).toMatchObject({scope:'all',reason:expect.stringMatching(/invalid TypeScript syntax/i)});
  expect(invalid.analysis?.revision).toBe(changed.analysis?.revision);
  expect(invalid.analysis?.graph).toEqual(changed.analysis?.graph);
  expect(invalid.analysis?.files).toEqual(changed.analysis?.files);
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});

it('labels the whole model outdated when the first analysis fails without inventing evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-sync-initial-failure-'));
 const store=new ProjectStore(dir),p=await store.create({name:'Broken'}),sync=new SyncService(store,{watch:false});
 try{
  await writeFile(join(p.root,'main.ts'),'export function broken( {');
  await sync.start(p.id);
  const {analysis}=await store.get(p.id);
  expect(AnalysisSchema.safeParse(analysis).success).toBe(true);
  expect(analysis).toMatchObject({revision:'',sequence:0,status:'stale',files:{},graph:{nodes:[],edges:[]},
   staleEvidence:{scope:'all'},quality:{diagnostics:[{severity:'error',code:'analysis-failure'}]}});
 }finally{await sync.close();await rm(dir,{recursive:true,force:true});}
});

describe('T048: Watch saved source and analysis inputs', () => {
 it('identifies relevant analysis inputs and excludes temporary, sensitive, and generated files', () => {
  // TypeScript sources and declarations
  expect(isRelevantAnalysisInput('src/index.ts')).toBe(true);
  expect(isRelevantAnalysisInput('src/components/App.tsx')).toBe(true);
  expect(isRelevantAnalysisInput('lib/module.mts')).toBe(true);
  expect(isRelevantAnalysisInput('lib/module.cts')).toBe(true);
  expect(isRelevantAnalysisInput('types/global.d.ts')).toBe(true);
  expect(isRelevantAnalysisInput('types/ambient.d.mts')).toBe(true);

  // Prisma schemas
  expect(isRelevantAnalysisInput('schema.prisma')).toBe(true);
  expect(isRelevantAnalysisInput('prisma/schema.prisma')).toBe(true);
  expect(isRelevantAnalysisInput('models/user.prisma')).toBe(true);

  // Configs and dependency manifests
  expect(isRelevantAnalysisInput('tsconfig.json')).toBe(true);
  expect(isRelevantAnalysisInput('tsconfig.app.json')).toBe(true);
  expect(isRelevantAnalysisInput('tsconfig.node.json')).toBe(true);
  expect(isRelevantAnalysisInput('packages/core/tsconfig.build.json')).toBe(true);
  expect(isRelevantAnalysisInput('package.json')).toBe(true);
  expect(isRelevantAnalysisInput('package-lock.json')).toBe(true);
  expect(isRelevantAnalysisInput('yarn.lock')).toBe(true);
  expect(isRelevantAnalysisInput('pnpm-lock.yaml')).toBe(true);
  expect(isRelevantAnalysisInput('bun.lockb')).toBe(true);
  expect(isRelevantAnalysisInput('config/app.json')).toBe(true);

  // Sensitive files must be excluded
  expect(isRelevantAnalysisInput('.env')).toBe(false);
  expect(isRelevantAnalysisInput('.env.local')).toBe(false);
  expect(isRelevantAnalysisInput('.env.production')).toBe(false);
  expect(isRelevantAnalysisInput('auth.json')).toBe(false);
  expect(isRelevantAnalysisInput('credentials.json')).toBe(false);
  expect(isRelevantAnalysisInput('server.key')).toBe(false);
  expect(isRelevantAnalysisInput('cert.pem')).toBe(false);

  // Ignored directories must be excluded
  expect(isRelevantAnalysisInput('node_modules/pkg/index.ts')).toBe(false);
  expect(isRelevantAnalysisInput('.git/index')).toBe(false);
  expect(isRelevantAnalysisInput('dist/bundle.js')).toBe(false);
  expect(isRelevantAnalysisInput('build/index.js')).toBe(false);
  expect(isRelevantAnalysisInput('_architect/cache.json')).toBe(false);

  // Editor temporary and backup files must be excluded
  expect(isRelevantAnalysisInput('main.ts.tmp')).toBe(false);
  expect(isRelevantAnalysisInput('main.ts.1234.tmp')).toBe(false);
  expect(isRelevantAnalysisInput('main.ts.temp')).toBe(false);
  expect(isRelevantAnalysisInput('.main.ts.swp')).toBe(false);
  expect(isRelevantAnalysisInput('main.ts.swo')).toBe(false);
  expect(isRelevantAnalysisInput('main.ts~')).toBe(false);
  expect(isRelevantAnalysisInput('.#main.ts')).toBe(false);
  expect(isRelevantAnalysisInput('#main.ts#')).toBe(false);
  expect(isRelevantAnalysisInput('main.ts___jb_tmp___')).toBe(false);

  // Non-analysis assets
  expect(isRelevantAnalysisInput('README.md')).toBe(false);
  expect(isRelevantAnalysisInput('notes.txt')).toBe(false);
  expect(isRelevantAnalysisInput('logo.png')).toBe(false);

  // Helper isGeneratedOrTemporaryFile
  expect(isGeneratedOrTemporaryFile('test.ts.tmp')).toBe(true);
  expect(isGeneratedOrTemporaryFile('.test.ts.swp')).toBe(true);
  expect(isGeneratedOrTemporaryFile('test.ts~')).toBe(true);
  expect(isGeneratedOrTemporaryFile('test.ts')).toBe(false);

  // Helper areHashesEqual
  expect(areHashesEqual({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
  expect(areHashesEqual({ a: '1' }, { a: '2' })).toBe(false);
  expect(areHashesEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
 });

 it('Scenario 1: watches save, add, delete, rename, and atomic-save sequences of source and schema files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-scenario1-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'Scenario1' });

  // Use calibrated debounce and stability threshold for responsive test validation
  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 60,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const analysisUpdates: any[] = [];
  sync.on('notification', (_id, event) => {
   if (event.type === 'analysis') analysisUpdates.push(event);
  });

  try {
   await writeFile(join(p.root, 'main.ts'), 'export function originalFn() { return 1; }');
   await sync.start(p.id);

   expect(sync.isWatching(p.id)).toBe(true);
   const initial = await store.get(p.id);
   expect(initial.analysis?.graph.nodes.some(n => n.name === 'originalFn')).toBe(true);
   const countInitial = analysisUpdates.length;

   // 1. Save / modify existing TypeScript file
   await writeFile(join(p.root, 'main.ts'), 'export function savedFn() { return 2; }');
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'savedFn');
   }, { timeout: 5000, interval: 50 }).toBe(true);
   expect(analysisUpdates.length).toBeGreaterThan(countInitial);

   // 2. Add a new TypeScript source file in subfolder
   await mkdir(join(p.root, 'src'), { recursive: true });
   await writeFile(join(p.root, 'src', 'helper.ts'), 'export function helperFn() { return 3; }');
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'helperFn');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 3. Rename a TypeScript source file (main.ts -> core.ts)
   await rename(join(p.root, 'main.ts'), join(p.root, 'core.ts'));
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    const hasCore = updated.analysis?.files['core.ts'] !== undefined;
    const hasMain = updated.analysis?.files['main.ts'] !== undefined;
    return hasCore && !hasMain;
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 4. Delete a TypeScript source file (src/helper.ts)
   await unlink(join(p.root, 'src', 'helper.ts'));
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'helperFn');
   }, { timeout: 5000, interval: 50 }).toBe(false);

   // 5. Add a Prisma schema file
   await mkdir(join(p.root, 'prisma'), { recursive: true });
   const schemaContent1 = `datasource db {
  provider = "sqlite"
  url = "file:dev.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id   Int    @id
  name String
}
`;
   await writeFile(join(p.root, 'prisma', 'schema.prisma'), schemaContent1);
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'User' && n.kind === 'entity');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 6. Save / modify Prisma schema file (add Post model)
   const schemaContent2 = schemaContent1 + `
model Post {
  id    Int    @id
  title String
}
`;
   await writeFile(join(p.root, 'prisma', 'schema.prisma'), schemaContent2);
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'Post' && n.kind === 'entity');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 7. Rename Prisma schema file (schema.prisma -> database.prisma)
   await rename(join(p.root, 'prisma', 'schema.prisma'), join(p.root, 'prisma', 'database.prisma'));
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    const hasDb = updated.analysis?.files['prisma/database.prisma'] !== undefined;
    const hasSchema = updated.analysis?.files['prisma/schema.prisma'] !== undefined;
    return hasDb && !hasSchema;
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 8. Delete Prisma schema file
   await unlink(join(p.root, 'prisma', 'database.prisma'));
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.kind === 'entity');
   }, { timeout: 5000, interval: 50 }).toBe(false);

   // 9. Atomic save simulation (write to temp file, rename temp to core.ts)
   const atomicTemp = join(p.root, 'core.ts.atomic.tmp');
   await writeFile(atomicTemp, 'export function atomicFn() { return 5; }');
   await rename(atomicTemp, join(p.root, 'core.ts'));
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.graph.nodes.some(n => n.name === 'atomicFn');
   }, { timeout: 5000, interval: 50 }).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Scenario 2: changes to tsconfig and package manifests assert reconciliation requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-scenario2-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'Scenario2' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 60,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const requestEvents: string[] = [];
  const scheduleEvents: any[] = [];
  sync.on('request', id => requestEvents.push(id));
  sync.on('reconcile-scheduled', (id, info) => scheduleEvents.push({ id, ...info }));

  try {
   await writeFile(join(p.root, 'main.ts'), 'export const ready = true;');
   await writeFile(join(p.root, 'package.json'), JSON.stringify({ name: 'pkg-initial', version: '1.0.0' }, null, 2));
   await writeFile(join(p.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022' } }, null, 2));
   await sync.start(p.id);

   const initialRequests = requestEvents.length;
   expect(initialRequests).toBeGreaterThanOrEqual(1);

   // 1. Change package.json manifest
   await writeFile(join(p.root, 'package.json'), JSON.stringify({ name: 'pkg-updated', version: '1.1.0' }, null, 2));
   await expect.poll(() => requestEvents.length, { timeout: 5000, interval: 50 }).toBeGreaterThan(initialRequests);
   const afterPkgRequests = requestEvents.length;

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['package.json']?.text.includes('pkg-updated');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 2. Change tsconfig.json configuration
   await writeFile(join(p.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2023', strict: true } }, null, 2));
   await expect.poll(() => requestEvents.length, { timeout: 5000, interval: 50 }).toBeGreaterThan(afterPkgRequests);
   const afterTsconfigRequests = requestEvents.length;

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['tsconfig.json']?.text.includes('es2023');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // 3. Add / change package-lock.json
   await writeFile(join(p.root, 'package-lock.json'), JSON.stringify({ name: 'pkg-updated', lockfileVersion: 3 }, null, 2));
   await expect.poll(() => requestEvents.length, { timeout: 5000, interval: 50 }).toBeGreaterThan(afterTsconfigRequests);

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['package-lock.json'] !== undefined;
   }, { timeout: 5000, interval: 50 }).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Acceptance Criteria 1: excludes sensitive files, ignored directories, and editor temp files from requesting analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-exclusions-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'Exclusions' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 60,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const requestEvents: string[] = [];
  sync.on('request', id => requestEvents.push(id));

  try {
   await writeFile(join(p.root, 'main.ts'), 'export const stable = 1;');
   await sync.start(p.id);
   const baselineRequests = requestEvents.length;

   // 1. Write sensitive file (.env) - must NOT request analysis
   await writeFile(join(p.root, '.env'), 'DATABASE_URL=secret');
   await new Promise(r => setTimeout(r, 200));
   expect(requestEvents.length).toBe(baselineRequests);

   // 2. Write sensitive file (credentials.json) - must NOT request analysis
   await writeFile(join(p.root, 'credentials.json'), '{"key":"secret"}');
   await new Promise(r => setTimeout(r, 200));
   expect(requestEvents.length).toBe(baselineRequests);

   // 3. Write in ignored directory (node_modules) - must NOT request analysis
   await mkdir(join(p.root, 'node_modules', 'dep'), { recursive: true });
   await writeFile(join(p.root, 'node_modules', 'dep', 'index.ts'), 'export const dep = 1;');
   await new Promise(r => setTimeout(r, 200));
   expect(requestEvents.length).toBe(baselineRequests);

   // 4. Write editor temporary / swap files - must NOT request analysis
   await writeFile(join(p.root, 'main.ts.tmp'), 'temp data');
   await writeFile(join(p.root, '.main.ts.swp'), 'vim swap');
   await writeFile(join(p.root, 'main.ts~'), 'backup');
   await new Promise(r => setTimeout(r, 200));
   expect(requestEvents.length).toBe(baselineRequests);

   // 5. Write non-analysis asset (README.md) - must NOT request analysis
   await writeFile(join(p.root, 'README.md'), '# Documentation');
   await new Promise(r => setTimeout(r, 200));
   expect(requestEvents.length).toBe(baselineRequests);

   // 6. Now save a genuine relevant source file to verify watcher is still active and triggers
   await writeFile(join(p.root, 'main.ts'), 'export const stable = 2;');
   await expect.poll(() => requestEvents.length, { timeout: 5000, interval: 50 }).toBeGreaterThan(baselineRequests);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Acceptance Criteria 2: closing a project releases watchers without affecting other open projects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-lifecycle-'));
  const store = new ProjectStore(dir);
  const p1 = await store.create({ name: 'ProjectOne' });
  const p2 = await store.create({ name: 'ProjectTwo' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 60,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const requests: Record<string, number> = { [p1.id]: 0, [p2.id]: 0 };
  sync.on('request', id => {
   requests[id] = (requests[id] || 0) + 1;
  });

  try {
   await writeFile(join(p1.root, 'main.ts'), 'export const p1 = 1;');
   await writeFile(join(p2.root, 'main.ts'), 'export const p2 = 1;');

   await sync.start(p1.id);
   await sync.start(p2.id);

   expect(sync.isWatching(p1.id)).toBe(true);
   expect(sync.isWatching(p2.id)).toBe(true);
   expect(sync.getWatcher(p1.id)).toBeDefined();
   expect(sync.getWatcher(p2.id)).toBeDefined();

   const p1Baseline = requests[p1.id];
   const p2Baseline = requests[p2.id];

   // Close Project 1 specifically
   await sync.close(p1.id);

   expect(sync.isWatching(p1.id)).toBe(false);
   expect(sync.getWatcher(p1.id)).toBeUndefined();
   expect(sync.hasSession(p1.id)).toBe(false);

   // Project 2 must remain open and watching
   expect(sync.isWatching(p2.id)).toBe(true);
   expect(sync.getWatcher(p2.id)).toBeDefined();

   // Modify Project 1 files - no reconciliation request should occur
   await writeFile(join(p1.root, 'main.ts'), 'export const p1 = 99;');
   await new Promise(r => setTimeout(r, 200));
   expect(requests[p1.id]).toBe(p1Baseline);

   // Modify Project 2 files - reconciliation request MUST occur
   await writeFile(join(p2.root, 'main.ts'), 'export const p2 = 2;');
   await expect.poll(() => requests[p2.id], { timeout: 5000, interval: 50 }).toBeGreaterThan(p2Baseline);

   await expect.poll(async () => {
    const p2Updated = await store.get(p2.id);
    return p2Updated.analysis?.files['main.ts']?.text.includes('p2 = 2');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // Close all remaining projects
   await sync.close();
   expect(sync.isWatching(p2.id)).toBe(false);
   expect(sync.hasSession(p2.id)).toBe(false);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Acceptance Criteria 3: changes are not tied to one editor or unsaved buffers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-editor-neutral-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'EditorNeutral' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 60,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  try {
   await writeFile(join(p.root, 'main.ts'), 'export const savedOnDisk = 1;');
   await sync.start(p.id);

   // Unsaved buffer simulation: a string held in editor memory without being written to disk
   // has no effect on analysis
   const unsavedBufferText = 'export const unsavedInMemory = 999;';
   void unsavedBufferText; // In-memory only
   await new Promise(r => setTimeout(r, 150));
   const current = await store.get(p.id);
   expect(current.analysis?.files['main.ts'].text).not.toContain('unsavedInMemory');

   // Saved-file synchronization: when actually saved to disk (by any editor, CLI, or script)
   await writeFile(join(p.root, 'main.ts'), 'export const savedByAnyEditor = 2;');
   await expect.poll(async () => {
    const updated = await store.get(p.id);
    return updated.analysis?.files['main.ts'].text.includes('savedByAnyEditor');
   }, { timeout: 5000, interval: 50 }).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('coalesces rapid successive writes within 300 ms debounce into a single reconciliation request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-debounce-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'DebounceTest' });

  // Use the standard CONTRACT.md 300 ms debounce
  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 300,
   stabilityThreshold: 50,
   pollInterval: 20,
  });

  const requestEvents: string[] = [];
  sync.on('request', id => requestEvents.push(id));

  try {
   await writeFile(join(p.root, 'main.ts'), 'export const v = 0;');
   await sync.start(p.id);
   const baseline = requestEvents.length;

   // Rapid writes inside 300 ms debounce window
   await writeFile(join(p.root, 'main.ts'), 'export const v = 1;');
   await new Promise(r => setTimeout(r, 60));
   await writeFile(join(p.root, 'main.ts'), 'export const v = 2;');
   await new Promise(r => setTimeout(r, 60));
   await writeFile(join(p.root, 'main.ts'), 'export const v = 3;');

   // Wait for debounce to settle
   await expect.poll(() => requestEvents.length, { timeout: 5000, interval: 50 }).toBe(baseline + 1);

   const final = await store.get(p.id);
   expect(final.analysis?.files['main.ts'].text).toContain('v = 3');
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });
});

describe('T049: Debounce 300 ms and stabilize file writes', () => {
 it('retains an explicit 300 ms debounce by default and coalesces bursty events within debounce using fake timers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-fake-timers-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'FakeTimerDebounce' });
  await writeFile(join(p.root, 'main.ts'), 'export function calc() { return 0; }');

  const sync = new SyncService(store, { watch: false });
  expect(sync.getDebounceMs()).toBe(300);

  const scheduledEvents: any[] = [];
  sync.on('reconcile-scheduled', (id, info) => scheduledEvents.push({ id, ...info }));

  vi.useFakeTimers();
  try {
   await sync.start(p.id);

   // Rapid burst of file change events within 300 ms
   // Event 1 at t = 0
   await writeFile(join(p.root, 'main.ts'), 'export function calc() { return 1; }');
   sync.schedule(p.id, 'change', join(p.root, 'main.ts'));
   expect(sync.hasPendingDebounce(p.id)).toBe(true);

   // Advance 100 ms (t = 100): not fired yet (< 300 ms)
   await vi.advanceTimersByTimeAsync(100);
   expect(scheduledEvents.length).toBe(0);
   expect(sync.hasPendingDebounce(p.id)).toBe(true);

   // Event 2 at t = 100 ms: resets debounce timer back to 300 ms
   await writeFile(join(p.root, 'main.ts'), 'export function calc() { return 2; }');
   sync.schedule(p.id, 'change', join(p.root, 'main.ts'));

   // Advance 150 ms (t = 250): only 150 ms since event 2, not fired yet
   await vi.advanceTimersByTimeAsync(150);
   expect(scheduledEvents.length).toBe(0);
   expect(sync.hasPendingDebounce(p.id)).toBe(true);

   // Event 3 at t = 250 ms: resets debounce timer back to 300 ms again
   await writeFile(join(p.root, 'main.ts'), 'export function calc() { return 3; }');
   sync.schedule(p.id, 'change', join(p.root, 'main.ts'));

   // Advance 200 ms (t = 450): only 200 ms since event 3, not fired yet
   await vi.advanceTimersByTimeAsync(200);
   expect(scheduledEvents.length).toBe(0);
   expect(sync.hasPendingDebounce(p.id)).toBe(true);

   // Advance remaining 100 ms (t = 550): exactly 300 ms have passed since event 3!
   await vi.advanceTimersByTimeAsync(100);
   expect(scheduledEvents.length).toBe(1);
   expect(sync.hasPendingDebounce(p.id)).toBe(false);

   // Switch to real timers to await the async analysis resolution
   vi.useRealTimers();

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['main.ts']?.text.includes('return 3;');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   const final = await store.get(p.id);
   expect(final.analysis?.status).toBe('current');
   expect(final.analysis?.graph.nodes.some(n => n.name === 'calc')).toBe(true);
  } finally {
   vi.useRealTimers();
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('simulates a chunked write stream and ensures intermediate incomplete writes are coalesced and stabilized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-chunked-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'ChunkedWrite' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 300,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const requestEvents: string[] = [];
  sync.on('request', id => requestEvents.push(id));

  try {
   await writeFile(join(p.root, 'main.ts'), 'export function initial() { return 0; }');
   await sync.start(p.id);
   const baselineRequests = requestEvents.length;

   // Chunked write sequence with inter-chunk delays < 300 ms debounce
   // Chunk 1: Incomplete function signature (would be syntax error if consumed!)
   await writeFile(join(p.root, 'main.ts'), 'export function chunkedCalc(');
   await new Promise(r => setTimeout(r, 60));

   // Chunk 2: Parameter list (still incomplete syntax!)
   await writeFile(join(p.root, 'main.ts'), 'export function chunkedCalc(a: number, b: number) {\n');
   await new Promise(r => setTimeout(r, 60));

   // Chunk 3: Final complete function body
   await writeFile(join(p.root, 'main.ts'), 'export function chunkedCalc(a: number, b: number) {\n  return a + b;\n}\n');

   // Wait for the 300 ms debounce to settle and store to update
   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['main.ts']?.text.includes('return a + b;');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // Exactly 1 new reconciliation request was triggered, coalescing all chunk events
   expect(requestEvents.length - baselineRequests).toBe(1);

   // Analysis must reflect the stable final state with status 'current'
   const final = await store.get(p.id);
   expect(final.analysis?.status).toBe('current');
   expect(final.analysis?.graph.nodes.some(n => n.name === 'chunkedCalc')).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('does not consume a deliberately incomplete write as final current content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-incomplete-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'IncompleteWrite' });

  const sync = new SyncService(store, { watch: false });

  try {
   // 1. Initial valid source
   await writeFile(join(p.root, 'main.ts'), 'export function validBase() { return 100; }');
   await sync.start(p.id);

   const initial = await store.get(p.id);
   expect(initial.analysis?.status).toBe('current');
   expect(initial.analysis?.graph.nodes.some(n => n.name === 'validBase')).toBe(true);

   // 2. Deliberately incomplete write: invalid syntax left unclosed
   await writeFile(join(p.root, 'main.ts'), 'export function deliberatelyIncomplete(');
   await sync.request(p.id);

   // Analysis must NOT consume the incomplete write as current content
   const incomplete = await store.get(p.id);
   expect(incomplete.analysis?.status).toBe('stale');
   expect(incomplete.analysis?.status).not.toBe('current');
   // The previous valid graph is retained
   expect(incomplete.analysis?.graph.nodes.some(n => n.name === 'validBase')).toBe(true);
   expect(incomplete.analysis?.quality.diagnostics.some(d => d.code === 'analysis-failure')).toBe(true);
   expect(incomplete.analysis?.staleEvidence).toMatchObject({
    scope: 'all',
    reason: expect.stringMatching(/invalid TypeScript syntax/i),
   });

   // 3. Complete the write to verify recovery to current status
   await writeFile(join(p.root, 'main.ts'), 'export function deliberatelyIncomplete() { return 200; }');
   await sync.request(p.id);

   const recovered = await store.get(p.id);
   expect(recovered.analysis?.status).toBe('current');
   expect(recovered.analysis?.graph.nodes.some(n => n.name === 'deliberatelyIncomplete')).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('simulates an atomic editor replacement and coalesces it without losing the final change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-atomic-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'AtomicSave' });

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 300,
   stabilityThreshold: 40,
   pollInterval: 20,
  });

  const requestEvents: string[] = [];
  sync.on('request', id => requestEvents.push(id));

  try {
   await writeFile(join(p.root, 'main.ts'), 'export function versionOne() { return 1; }');
   await sync.start(p.id);

   const baseline = requestEvents.length;
   const initial = await store.get(p.id);
   expect(initial.analysis?.graph.nodes.some(n => n.name === 'versionOne')).toBe(true);

   // Step 1: Editor creates temporary files (vim swap, temp file, JetBrains temp)
   await writeFile(join(p.root, '.main.ts.swp'), 'vim swap file binary');
   await writeFile(join(p.root, 'main.ts___jb_tmp___'), 'jetbrains temp');
   await writeFile(join(p.root, 'main.ts.tmp'), 'export function versionTwo() { return 2; }');

   // Step 2: Atomic replacement: unlink target then immediately rename temp to target
   await unlink(join(p.root, 'main.ts'));
   await rename(join(p.root, 'main.ts.tmp'), join(p.root, 'main.ts'));

   // Clean up swap files
   await rm(join(p.root, '.main.ts.swp'), { force: true });
   await rm(join(p.root, 'main.ts___jb_tmp___'), { force: true });

   // Wait for the 300 ms debounce to settle and analysis to update the store
   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.files['main.ts']?.text.includes('versionTwo');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // Verify exactly one reconciliation request was issued (coalesced)
   expect(requestEvents.length).toBe(baseline + 1);

   // Verify final analysis reflects the atomically saved version Two
   const updated = await store.get(p.id);
   expect(updated.analysis?.status).toBe('current');
   expect(updated.analysis?.files['main.ts']?.text).toContain('versionTwo');
   expect(updated.analysis?.graph.nodes.some(n => n.name === 'versionTwo')).toBe(true);
   expect(updated.analysis?.graph.nodes.some(n => n.name === 'versionOne')).toBe(false);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('releases timers on project stop and global close without leaking timers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-timers-'));
  const store = new ProjectStore(dir);
  const p1 = await store.create({ name: 'TimerLeak1' });
  const p2 = await store.create({ name: 'TimerLeak2' });

  await writeFile(join(p1.root, 'main.ts'), 'export const p1 = 1;');
  await writeFile(join(p2.root, 'main.ts'), 'export const p2 = 1;');

  const sync = new SyncService(store, {
   watch: false,
   debounceMs: 300,
   reconcileIntervalMs: 60000,
  });

  vi.useFakeTimers();
  try {
   await sync.start(p1.id);
   await sync.start(p2.id);

   // Schedule debounce events on both projects
   sync.schedule(p1.id, 'change', join(p1.root, 'main.ts'));
   sync.schedule(p2.id, 'change', join(p2.root, 'main.ts'));

   expect(sync.hasPendingDebounce(p1.id)).toBe(true);
   expect(sync.hasPendingDebounce(p2.id)).toBe(true);

   // Stop project 1 individually: timers for p1 must be cleared immediately
   await sync.close(p1.id);

   expect(sync.hasPendingDebounce(p1.id)).toBe(false);
   expect(sync.hasSession(p1.id)).toBe(false);
   // Project 2 remains active
   expect(sync.hasPendingDebounce(p2.id)).toBe(true);
   expect(sync.hasSession(p2.id)).toBe(true);

   // Close all remaining sessions
   await sync.close();

   expect(sync.hasPendingDebounce(p2.id)).toBe(false);
   expect(sync.hasSession(p2.id)).toBe(false);

   // Assert zero pending timers remain
   expect(vi.getTimerCount()).toBe(0);
  } finally {
   vi.useRealTimers();
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });
});

describe('T052: Discard out-of-order and superseded analysis results', () => {
 it('Scenario 1: finishes analyses in reverse order and discards late older results (AC 1 & AC 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-out-of-order-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'OutOfOrder' });

  await writeFile(join(p.root, 'main.ts'), 'export function v0() { return 0; }');

  const realWorker = new AnalysisWorker();

  let releaseGen2: (() => void) | undefined;
  const gen2HoldPromise = new Promise<void>(resolve => {
   releaseGen2 = resolve;
  });

  const mockWorker = {
   get pendingCount() { return realWorker.pendingCount; },
   isClosed: () => realWorker.isClosed(),
   analyze: async (root: string, options?: any) => {
    const gen = options?.generation;
    if (gen === 2) {
     await gen2HoldPromise;
    }
    return realWorker.analyze(root, options);
   },
   close: async () => realWorker.close(),
  } as unknown as AnalysisWorker;

  const sync = new SyncService(store, {
   watch: false,
   worker: mockWorker,
  });

  const analysisNotifications: any[] = [];
  const discardedEvents: any[] = [];
  sync.on('notification', (_id, ev) => {
   if (ev.type === 'analysis') analysisNotifications.push(ev);
  });
  sync.on('discarded', (_id, ev) => {
   discardedEvents.push(ev);
  });

  try {
   await sync.start(p.id);
   expect(analysisNotifications.length).toBe(1);
   const initial = await store.get(p.id);
   expect(initial.analysis?.graph.nodes.some(n => n.name === 'v0')).toBe(true);

   // Save 1: writes v1 (generation 2, delayed in worker)
   await writeFile(join(p.root, 'main.ts'), 'export function v1() { return 1; }');
   const reqGen2Promise = sync.request(p.id);

   // Save 2: writes v2 (generation 3, not delayed)
   await writeFile(join(p.root, 'main.ts'), 'export function v2() { return 2; }');
   const reqGen3Promise = sync.request(p.id);

   // Generation 3 completes first
   await reqGen3Promise;

   const afterGen3 = await store.get(p.id);
   expect(afterGen3.analysis?.graph.nodes.some(n => n.name === 'v2')).toBe(true);
   expect(afterGen3.analysis?.graph.nodes.some(n => n.name === 'v1')).toBe(false);
   expect(sync.getCommittedGeneration(p.id)).toBe(3);
   expect(analysisNotifications.length).toBe(2);
   const updateGen3 = analysisNotifications[1];
   expect(updateGen3.sequence).toBe(2);
   expect(updateGen3.revision).toBe(afterGen3.analysis!.revision);

   // Now release generation 2 (which finishes LATER than generation 3, i.e. in reverse order)
   releaseGen2!();
   await reqGen2Promise;

   // AC 1: A late older result cannot overwrite newer state
   const finalProject = await store.get(p.id);
   expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'v2')).toBe(true);
   expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'v1')).toBe(false);
   expect(finalProject.analysis?.revision).toBe(afterGen3.analysis!.revision);
   expect(finalProject.analysis?.sequence).toBe(2);

   // Verify discarded event was emitted for generation 2
   expect(discardedEvents.some(d => d.generation === 2)).toBe(true);

   // AC 2: Published graph and evidence belong to one revision
   // No notification was published for generation 2
   expect(analysisNotifications.length).toBe(2);

   const applied = applyGraphUpdate(initial.analysis, updateGen3);
   const v2Node = finalProject.analysis!.graph.nodes.find(n => n.name === 'v2');
   expect(v2Node).toBeDefined();
   expect(v2Node!.source?.revision).toBe(finalProject.analysis!.revision);
   for (const node of finalProject.analysis!.graph.nodes) {
    if (node.source) {
     expect(node.source.revision).toBe(finalProject.analysis!.revision);
    }
   }
  } finally {
   releaseGen2?.();
   await sync.close();
   await realWorker.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('discards late older analysis failure without marking newer valid model as stale (R12, R33)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-stale-superseded-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'StaleSuperseded' });
  await writeFile(join(p.root, 'main.ts'), 'export function v0() { return 0; }');

  const realWorker = new AnalysisWorker();
  let releaseGen2: (() => void) | undefined;
  const gen2HoldPromise = new Promise<void>(resolve => {
   releaseGen2 = resolve;
  });

  const mockWorker = {
   get pendingCount() { return realWorker.pendingCount; },
   isClosed: () => realWorker.isClosed(),
   analyze: async (root: string, options?: any) => {
    const gen = options?.generation;
    if (gen === 2) {
     await gen2HoldPromise;
    }
    return realWorker.analyze(root, options);
   },
   close: async () => realWorker.close(),
  } as unknown as AnalysisWorker;

  const sync = new SyncService(store, { watch: false, worker: mockWorker });
  const notifications: any[] = [];
  sync.on('notification', (_id, ev) => notifications.push(ev));

  try {
   await sync.start(p.id);

   // Save 1: broken syntax (generation 2, delayed)
   await writeFile(join(p.root, 'main.ts'), 'export function broken( {');
   const reqGen2 = sync.request(p.id);

   // Save 2: valid syntax (generation 3, fast)
   await writeFile(join(p.root, 'main.ts'), 'export function fixed() { return 100; }');
   const reqGen3 = sync.request(p.id);

   // Generation 3 completes first
   await reqGen3;
   const afterFixed = await store.get(p.id);
   expect(afterFixed.analysis?.status).toBe('current');
   expect(afterFixed.analysis?.graph.nodes.some(n => n.name === 'fixed')).toBe(true);

   // Now release generation 2 (broken syntax finishes second)
   releaseGen2!();
   await reqGen2;

   // The late broken result must NOT overwrite the valid model or mark it stale!
   const finalProject = await store.get(p.id);
   expect(finalProject.analysis?.status).toBe('current');
   expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'fixed')).toBe(true);
   expect(notifications.some(n => n.status === 'stale')).toBe(false);
  } finally {
   releaseGen2?.();
   await sync.close();
   await realWorker.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Scenario 2A: triggers a new save just before persistence and avoids committing superseded results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-new-save-before-persist-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'SaveBeforePersist' });
  await writeFile(join(p.root, 'main.ts'), 'export function initial() { return 0; }');

  const sync = new SyncService(store, { watch: false });
  const analysisNotifications: any[] = [];
  const discardedEvents: any[] = [];
  sync.on('notification', (_id, ev) => {
   if (ev.type === 'analysis') analysisNotifications.push(ev);
  });
  sync.on('discarded', (_id, ev) => discardedEvents.push(ev));

  try {
   await sync.start(p.id);
   expect(analysisNotifications.length).toBe(1);

   // Write save 1
   await writeFile(join(p.root, 'main.ts'), 'export function intermediate() { return 1; }');

   // Hook into before-persist of generation 2 to trigger save 2 (generation 3)
   let triggeredNewSave = false;
   sync.once('before-persist', async (_id, info) => {
    if (info.generation === 2) {
     triggeredNewSave = true;
     // Trigger a new save just before persistence of generation 2!
     await writeFile(join(p.root, 'main.ts'), 'export function finalVersion() { return 2; }');
     void sync.request(p.id);
    }
   });

   // Request generation 2
   await sync.request(p.id);

   expect(triggeredNewSave).toBe(true);

   // Store must contain finalVersion, NEVER intermediate!
   const current = await store.get(p.id);
   expect(current.analysis?.graph.nodes.some(n => n.name === 'finalVersion')).toBe(true);
   expect(current.analysis?.graph.nodes.some(n => n.name === 'intermediate')).toBe(false);

   // Generation 2 was discarded right at persist check
   expect(discardedEvents.some(d => d.generation === 2)).toBe(true);

   // No notification was published for intermediate
   expect(analysisNotifications.some(n => n.revision === current.analysis!.revision)).toBe(true);
   expect(analysisNotifications.length).toBe(2); // Only initial and finalVersion
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Scenario 2B: closes a running session just before persistence and ensures closed sessions cannot publish results (AC 3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-close-running-session-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'CloseRunningSession' });
  await writeFile(join(p.root, 'main.ts'), 'export function initial() { return 0; }');

  const sync = new SyncService(store, { watch: false });
  const publishedResults: any[] = [];
  const allNotifications: any[] = [];
  sync.on('notification', (_id, ev) => {
   allNotifications.push(ev);
   if (ev.type === 'analysis') publishedResults.push(ev);
  });

  try {
   await sync.start(p.id);
   expect(publishedResults.length).toBe(1);

   await writeFile(join(p.root, 'main.ts'), 'export function shouldNeverPublish() { return 99; }');

   // Hook into before-persist to close the session
   let closedDuringBeforePersist = false;
   let notificationsAfterClose = 0;
   sync.once('before-persist', async () => {
    closedDuringBeforePersist = true;
    sync.on('notification', () => {
     if (closedDuringBeforePersist) notificationsAfterClose++;
    });
    await sync.close(p.id);
   });

   // Request analysis
   await sync.request(p.id);

   expect(closedDuringBeforePersist).toBe(true);

   // AC 3: Closed sessions cannot publish results
   expect(publishedResults.length).toBe(1);
   expect(notificationsAfterClose).toBe(0);

   // The store was not updated to shouldNeverPublish
   const stored = await store.get(p.id);
   expect(stored.analysis?.graph.nodes.some(n => n.name === 'shouldNeverPublish')).toBe(false);
   expect(stored.analysis?.graph.nodes.some(n => n.name === 'initial')).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('associates requests and worker results with generation and source revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-generations-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'GenTest' });
  await writeFile(join(p.root, 'main.ts'), 'export const val = 1;');

  const worker = new AnalysisWorker();
  try {
   const res = await worker.analyze(p.root, { generation: 42 });
   expect((res as any).generation).toBe(42);
   expect(typeof res.revision).toBe('string');
   expect(res.revision.length).toBeGreaterThan(0);
   expect(AnalysisSchema.safeParse(res).success).toBe(true);
  } finally {
   await worker.close();
   await rm(dir, { recursive: true, force: true });
  }
 });
});

describe('T058: Show updating, current, partial, and stale analysis states', () => {
 it('Concrete Scenario 1: introduces invalid intermediate syntax and then fixes it while retaining last valid evidence (AC 1 & AC 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t058-syntax-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'SyntaxLifecycleTest' });
  const sync = new SyncService(store, { watch: false });

  const notifications: any[] = [];
  const statusEvents: any[] = [];
  sync.on('notification', (_id, ev) => notifications.push(ev));
  sync.on('status', (_id, ev) => statusEvents.push(ev));

  try {
   // 1. Valid initial code
   await writeFile(
    join(p.root, 'main.ts'),
    'export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n'
   );
   await sync.start(p.id);

   const initialProject = await store.get(p.id);
   const initialAnalysis = initialProject.analysis!;
   expect(initialAnalysis.status).toBe('current');
   expect(initialAnalysis.sequence).toBe(1);
   expect(initialAnalysis.revision.length).toBeGreaterThan(0);

   const initialNode = initialAnalysis.graph.nodes.find(n => n.name === 'calculateSum');
   expect(initialNode).toBeDefined();
   expect(initialNode?.source?.path).toBe('main.ts');

   // Evidence initially current
   const initialEvidence = resolveSourceEvidence(
    initialNode?.source,
    initialAnalysis,
    initialAnalysis.revision
   );
   expect(initialEvidence.status).toBe('current');
   if (initialEvidence.status === 'current') {
    expect(initialEvidence.text).toContain('return a + b;');
   }

   // 2. Introduce invalid intermediate syntax
   await writeFile(
    join(p.root, 'main.ts'),
    'export function calculateSum(a: number, {\n  // syntax error broken function\n'
   );
   await sync.request(p.id);

   const staleProject = await store.get(p.id);
   const staleAnalysis = staleProject.analysis!;

   // AC 1: Failed analysis does not masquerade as fresh empty success
   expect(staleAnalysis.status).toBe('stale');
   expect(staleAnalysis.status).not.toBe('current');

   // AC 2: Old hashes/ranges remain tied to original evidence
   expect(staleAnalysis.revision).toBe(initialAnalysis.revision);
   expect(staleAnalysis.sequence).toBe(initialAnalysis.sequence);
   expect(staleAnalysis.files['main.ts'].text).toContain('return a + b;');
   expect(staleAnalysis.files['main.ts'].hash).toBe(initialAnalysis.files['main.ts'].hash);
   expect(staleAnalysis.graph).toEqual(initialAnalysis.graph);

   // Source evidence resolves to 'stale' without breaking range or hash binding
   const staleEvidenceRes = resolveSourceEvidence(
    initialNode?.source,
    staleAnalysis,
    staleAnalysis.revision
   );
   expect(staleEvidenceRes.status).toBe('stale');
   if (staleEvidenceRes.status === 'stale') {
    expect(staleEvidenceRes.text).toContain('return a + b;');
   }

   // Identifies outdated portions and diagnostic reason
   expect(staleAnalysis.staleEvidence).toBeDefined();
   expect(staleAnalysis.staleEvidence?.scope).toBe('all');
   expect(staleAnalysis.staleEvidence?.reason).toMatch(/syntax|error|expected/i);
   expect(
    staleAnalysis.quality.diagnostics.some(d => d.code === 'analysis-failure' && d.severity === 'error')
   ).toBe(true);

   // 3. Fix the syntax and verify clean recovery to 'current'
   await writeFile(
    join(p.root, 'main.ts'),
    'export function calculateSum(a: number, b: number): number {\n  return a + b + 10;\n}\n'
   );
   await sync.request(p.id);

   const fixedProject = await store.get(p.id);
   const fixedAnalysis = fixedProject.analysis!;

   expect(fixedAnalysis.status).toBe('current');
   expect(fixedAnalysis.sequence).toBe(2);
   expect(fixedAnalysis.revision).not.toBe(initialAnalysis.revision);
   expect(fixedAnalysis.files['main.ts'].text).toContain('return a + b + 10;');

   const fixedNode = fixedAnalysis.graph.nodes.find(n => n.name === 'calculateSum');
   expect(fixedNode).toBeDefined();
   const fixedEvidence = resolveSourceEvidence(
    fixedNode?.source,
    fixedAnalysis,
    fixedAnalysis.revision
   );
   expect(fixedEvidence.status).toBe('current');
   if (fixedEvidence.status === 'current') {
    expect(fixedEvidence.text).toContain('return a + b + 10;');
   }
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Concrete Scenario 2: fails one schema while retaining valid neighboring findings in partial status (AC 1 & AC 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t058-partial-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'PartialSchemaTest' });
  const sync = new SyncService(store, { watch: false });

  try {
   // Schema 1: valid Prisma schema
   await writeFile(
    join(p.root, 'user.prisma'),
    `datasource db {
  provider = "postgresql"
  url = "postgresql://localhost:5432/test"
}

model ValidUser {
  id Int @id
  name String
}
`
   );

   // Schema 2: invalid syntax in second schema
   await writeFile(
    join(p.root, 'broken.prisma'),
    `model BrokenPost {
  id Int @id
  invalid syntax in this schema !!!
}
`
   );

   // Neighboring TypeScript file: valid function
   await writeFile(
    join(p.root, 'service.ts'),
    'export function getUserHelper(): number { return 42; }\n'
   );

   await sync.start(p.id);

   const proj = await store.get(p.id);
   const analysis = proj.analysis!;

   // Status is partial due to failed schema
   expect(analysis.status).toBe('partial');
   expect(analysis.sequence).toBe(1);

   // Valid neighboring findings are retained in graph!
   const userNode = analysis.graph.nodes.find(n => n.name === 'ValidUser');
   expect(userNode).toBeDefined();
   expect(userNode?.kind).toBe('entity');

   const helperNode = analysis.graph.nodes.find(n => n.name === 'getUserHelper');
   expect(helperNode).toBeDefined();
   expect(helperNode?.kind).toBe('function');

   // Broken model is not present in graph
   expect(analysis.graph.nodes.some(n => n.name === 'BrokenPost')).toBe(false);

   // Diagnostic reports prisma error on broken.prisma
   const prismaErr = analysis.quality.diagnostics.find(
    d => d.path === 'broken.prisma' && d.severity === 'error'
   );
   expect(prismaErr).toBeDefined();

   // Outdated portion inspector identifies broken.prisma as the failed portion
   const outdatedPortions = getOutdatedPortions(analysis);
   expect(outdatedPortions).toBeDefined();
   expect(outdatedPortions?.scope).toBe('paths');
   expect(outdatedPortions?.paths).toContain('broken.prisma');

   // Source evidence for valid neighboring findings remains current
   const userEvidence = resolveSourceEvidence(
    userNode?.source,
    analysis,
    analysis.revision
   );
   expect(userEvidence.status).toBe('current');

   const helperEvidence = resolveSourceEvidence(
    helperNode?.source,
    analysis,
    analysis.revision
   );
   expect(helperEvidence.status).toBe('current');

   // Now fix broken.prisma and verify clean transition to current
   await writeFile(
    join(p.root, 'broken.prisma'),
    `model RepairedPost {
  id Int @id
  title String
}
`
   );
   await sync.request(p.id);

   const fixedProj = await store.get(p.id);
   const fixedAnalysis = fixedProj.analysis!;
   expect(fixedAnalysis.status).toBe('current');
   expect(fixedAnalysis.sequence).toBe(2);
   expect(fixedAnalysis.graph.nodes.some(n => n.name === 'RepairedPost')).toBe(true);
   expect(fixedAnalysis.graph.nodes.some(n => n.name === 'ValidUser')).toBe(true);
   expect(fixedAnalysis.graph.nodes.some(n => n.name === 'getUserHelper')).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('Acceptance Criterion 3: first-import failure has an honest empty/error state and does not masquerade as success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t058-first-fail-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'FirstImportFail' });
  const sync = new SyncService(store, { watch: false });

  try {
   // Write invalid syntax before start
   await writeFile(join(p.root, 'main.ts'), 'export function unclosedBracket( {\n');
   await sync.start(p.id);

   const proj = await store.get(p.id);
   const analysis = proj.analysis!;

   // AC 3: Honest empty/error state
   expect(AnalysisSchema.safeParse(analysis).success).toBe(true);
   expect(analysis.status).toBe('stale');
   expect(analysis.status).not.toBe('current');
   expect(analysis.revision).toBe('');
   expect(analysis.sequence).toBe(0);
   expect(analysis.graph.nodes).toEqual([]);
   expect(analysis.graph.edges).toEqual([]);
   expect(analysis.files).toEqual({});
   expect(analysis.staleEvidence?.scope).toBe('all');
   expect(
    analysis.quality.diagnostics.some(d => d.code === 'analysis-failure' && d.severity === 'error')
   ).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('publishes explicit lifecycle transitions including updating and exposes isUpdating status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t058-lifecycle-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'LifecyclePublishTest' });

  let analyzeResolver: () => void;
  let workerStarted: () => void;
  const workerStartedPromise = new Promise<void>((resolve) => {
   workerStarted = resolve;
  });

  const blockWorker = {
   analyze: vi.fn().mockImplementation(() => {
    workerStarted();
    return new Promise((resolve) => {
     analyzeResolver = () =>
      resolve({
       revision: 'rev-blocked',
       sequence: 1,
       analyzedAt: new Date().toISOString(),
       status: 'current',
       graph: { schemaVersion: 1, nodes: [], edges: [], requirements: [] },
       files: {},
       durationMs: 5,
       quality: {
        eligibleFiles: 0,
        analyzedFiles: 0,
        unresolvedReferences: 0,
        unsupportedConstructs: 0,
        inferredItems: 0,
        prismaValidation: 'not-applicable',
        diagnostics: [],
       },
      });
    });
   }),
   close: vi.fn().mockResolvedValue(undefined),
  };

  const sync = new SyncService(store, {
   watch: false,
   worker: blockWorker as any,
  });

  const statuses: string[] = [];
  sync.on('status', (_id, ev) => {
   statuses.push(ev.status);
  });

  try {
   const reqPromise = sync.start(p.id);
   await workerStartedPromise;

   // While in flight, status is updating and isUpdating returns true
   expect(sync.isUpdating(p.id)).toBe(true);
   expect(statuses).toContain('updating');

   // Unblock the analysis worker
   analyzeResolver!();
   await reqPromise;

   // Finished: isUpdating returns false and status transitioned to current
   expect(sync.isUpdating(p.id)).toBe(false);
   expect(statuses).toContain('current');
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });
});

describe('T059: Reconcile hashes every 60 seconds and after watcher errors', () => {
 it('Concrete Scenario 1: discovers changes missed by the watcher within a reconciliation cycle and avoids spurious revisions (AC 1 & AC 3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-scenario1-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-Scenario1' });

  await writeFile(join(p.root, 'main.ts'), 'export function initialTask() { return 42; }');

  const analyzer = new Analyzer();
  const directWorker = {
   analyze: (root: string, opts?: any) => analyzer.analyze(root, opts),
   close: async () => {},
  };

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   stabilityThreshold: 30,
   reconcileIntervalMs: 60000,
   worker: directWorker as any,
  });

  const analysisUpdates: any[] = [];
  sync.on('notification', (_id, ev) => {
   if (ev.type === 'analysis') analysisUpdates.push(ev);
  });

  const reconciledEvents: any[] = [];
  sync.on('reconciled', (_id, ev) => reconciledEvents.push(ev));

  vi.useFakeTimers();
  try {
   const startPromise = sync.start(p.id);
   await vi.advanceTimersByTimeAsync(2000);
   await startPromise;

   const initialProject = await store.get(p.id);
   const rev1 = initialProject.analysis!.revision;
   const seq1 = initialProject.analysis!.sequence;
   expect(seq1).toBe(1);
   expect(sync.hasReconcileTimer(p.id)).toBe(true);

   // Clear initial notification updates captured during sync.start
   analysisUpdates.length = 0;

   // Step 1: Disable event delivery to simulate missed watcher events
   sync.disableEventDelivery(p.id);
   expect(sync.isEventDeliveryDisabled(p.id)).toBe(true);

   // Step 2: Modify files on disk while watcher notifications are suppressed
   await writeFile(join(p.root, 'main.ts'), 'export function updatedTask() { return 99; }');

   // Confirm that without reconciliation, change is hidden
   await vi.advanceTimersByTimeAsync(200);
   expect(sync.hasPendingDebounce(p.id)).toBe(false);
   const hiddenProject = await store.get(p.id);
   expect(hiddenProject.analysis!.revision).toBe(rev1);
   expect(analysisUpdates.length).toBe(0);

   // Step 3: Advance 60 seconds to trigger the scheduled periodic reconciliation
   const reconciledPromise = new Promise(resolve => sync.once('reconciled', resolve));
   await vi.advanceTimersByTimeAsync(60000);
   await reconciledPromise;

   // Changes missed by watcher must be discovered within the reconciliation cycle (AC 1)
   const updatedProject = await store.get(p.id);
   expect(updatedProject.analysis?.graph.nodes.some(n => n.name === 'updatedTask')).toBe(true);
   expect(updatedProject.analysis!.revision).not.toBe(rev1);
   expect(updatedProject.analysis!.sequence).toBe(2);
   expect(analysisUpdates.length).toBe(1);
   expect(reconciledEvents.some(e => e.changed === true)).toBe(true);

   // Step 4: Advance another 60 seconds with NO file changes (AC 3)
   reconciledEvents.length = 0;
   analysisUpdates.length = 0;
   const noChangePromise = new Promise(resolve => sync.once('reconciled', resolve));
   await vi.advanceTimersByTimeAsync(60000);
   await noChangePromise;

   // No-change reconciliation does not publish spurious graph revisions (AC 3)
   const unchangedProject = await store.get(p.id);
   expect(unchangedProject.analysis!.revision).toBe(updatedProject.analysis!.revision);
   expect(unchangedProject.analysis!.sequence).toBe(updatedProject.analysis!.sequence);
   expect(analysisUpdates.length).toBe(0);
   expect(reconciledEvents.some(e => e.changed === false)).toBe(true);
  } finally {
   vi.useRealTimers();
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 15000);

 it('Concrete Scenario 2: emits watcher error, triggers recovery, and matches full import graph (AC 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-scenario2-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-Scenario2' });

  await writeFile(join(p.root, 'user.ts'), 'export class UserService { getUser(): string { return "user"; } }');
  await mkdir(join(p.root, 'prisma'), { recursive: true });
  await writeFile(
   join(p.root, 'prisma', 'schema.prisma'),
   'datasource db {\n  provider = "sqlite"\n  url = "file:dev.db"\n}\n\nmodel Account {\n  id Int @id\n  email String @unique\n}\n'
  );

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   stabilityThreshold: 30,
   reconcileIntervalMs: 60000,
  });

  const watcherErrors: any[] = [];
  sync.on('watcher-error', (_id, err) => watcherErrors.push(err));

  const recoveryEvents: any[] = [];
  sync.on('recovery', (_id, ev) => recoveryEvents.push(ev));

  try {
   await sync.start(p.id);

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return (
     current.analysis?.graph.nodes.some(n => n.name === 'UserService') &&
     current.analysis?.graph.nodes.some(n => n.name === 'Account')
    );
   }, { timeout: 10000, interval: 50 }).toBe(true);

   // Simulate file changes occurring while watcher is disrupted or event delivery disabled
   sync.disableEventDelivery(p.id);
   await writeFile(
    join(p.root, 'order.ts'),
    'export class OrderService { getOrder(): string { return "order"; } }'
   );
   await writeFile(
    join(p.root, 'prisma', 'schema.prisma'),
    'datasource db {\n  provider = "sqlite"\n  url = "file:dev.db"\n}\n\nmodel Account {\n  id Int @id\n  email String @unique\n}\n\nmodel Order {\n  id Int @id\n  total Float\n}\n'
   );

   // Emit watcher error on the active watcher
   const watcher = sync.getWatcher(p.id);
   expect(watcher).toBeDefined();

   const testError = new Error('ENOSPC: System limit for number of file watchers reached');
   watcher!.emit('error', testError);

   // Await recovery triggered by the watcher error (AC 2)
   await expect.poll(async () => {
    return recoveryEvents.some(ev => ev.phase === 'complete');
   }, { timeout: 10000, interval: 50 }).toBe(true);

   expect(watcherErrors.length).toBeGreaterThanOrEqual(1);
   expect(watcherErrors[0].message).toContain('ENOSPC');

   // Verify graph matches a clean, independent full import
   const cleanAnalyzer = new Analyzer();
   const fullImport = await cleanAnalyzer.analyze(p.root);
   const currentProject = await store.get(p.id);

   expect(currentProject.analysis?.status).toBe('current');
   const syncNodeNames = currentProject.analysis!.graph.nodes.map(n => n.name).sort();
   const fullNodeNames = fullImport.graph.nodes.map(n => n.name).sort();
   expect(syncNodeNames).toEqual(fullNodeNames);

   expect(syncNodeNames).toContain('UserService');
   expect(syncNodeNames).toContain('OrderService');
   expect(syncNodeNames).toContain('Account');
   expect(syncNodeNames).toContain('Order');

   // Re-enable event delivery and verify watcher recovery continues to capture subsequent saves
   sync.enableEventDelivery(p.id);
   await writeFile(join(p.root, 'invoice.ts'), 'export function createInvoice() { return 1; }');

   await expect.poll(async () => {
    const latest = await store.get(p.id);
    return latest.analysis?.graph.nodes.some(n => n.name === 'createInvoice');
   }, { timeout: 10000, interval: 50 }).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 15000);

 it('detects added, deleted, config, and dependency inputs during reconciliation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-inputs-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-Inputs' });

  await writeFile(join(p.root, 'index.ts'), 'export const base = 1;');
  await writeFile(join(p.root, 'package.json'), JSON.stringify({ name: 'input-test', version: '1.0.0' }, null, 2));
  await writeFile(
   join(p.root, 'tsconfig.json'),
   JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)
  );

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   reconcileIntervalMs: 60000,
  });

  try {
   await sync.start(p.id);

   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.graph.nodes.some(n => n.name === 'index.ts');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // Disable watcher events to isolate reconciliation logic
   sync.disableEventDelivery(p.id);

   // 1. Added input: new source file
   await writeFile(join(p.root, 'helper.ts'), 'export function helper() { return "help"; }');
   const addedReconciled = await sync.reconcile(p.id);
   expect(addedReconciled).toBe(true);
   const withHelper = await store.get(p.id);
   expect(withHelper.analysis?.graph.nodes.some(n => n.name === 'helper.ts')).toBe(true);

   // 2. Deleted input: delete source file
   await unlink(join(p.root, 'helper.ts'));
   const deletedReconciled = await sync.reconcile(p.id);
   expect(deletedReconciled).toBe(true);
   const withoutHelper = await store.get(p.id);
   expect(withoutHelper.analysis?.graph.nodes.some(n => n.name === 'helper.ts')).toBe(false);

   // 3. Config input: change tsconfig.json
   await writeFile(
    join(p.root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true } }, null, 2)
   );
   const configReconciled = await sync.reconcile(p.id);
   expect(configReconciled).toBe(true);

   // 4. Dependency input: change package.json
   await writeFile(
    join(p.root, 'package.json'),
    JSON.stringify({ name: 'input-test', version: '1.1.0', dependencies: { zod: '^4.0.0' } }, null, 2)
   );
   const depReconciled = await sync.reconcile(p.id);
   expect(depReconciled).toBe(true);

   // 5. Excluded/Temporary input: change .env and temp file - must NOT trigger reconciliation
   await writeFile(join(p.root, '.env'), 'SECRET_KEY=confidential_secret');
   await writeFile(join(p.root, 'scratch.tmp'), 'temporary contents');
   const excludedReconciled = await sync.reconcile(p.id);
   expect(excludedReconciled).toBe(false);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('retains a manual full-rescan action via rescan() (R16)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-rescan-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-Rescan' });

  await writeFile(join(p.root, 'main.ts'), 'export function alpha() { return "alpha"; }');

  const sync = new SyncService(store, {
   watch: false,
  });

  const reconcileStarts: any[] = [];
  sync.on('reconcile-start', (_id, ev) => reconcileStarts.push(ev));

  try {
   await sync.start(p.id);
   const p1 = await store.get(p.id);
   const seq1 = p1.analysis!.sequence;

   // Rescan with no file changes on disk forces analysis execution
   const rescanResult = await sync.rescan(p.id);
   expect(rescanResult).toBe(true);

   const p2 = await store.get(p.id);
   expect(p2.analysis!.sequence).toBe(seq1 + 1);
   expect(reconcileStarts.some(e => e.force === true)).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('reconciles file hashes on application resume and resets interval timer (R16)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-resume-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-Resume' });

  await writeFile(join(p.root, 'main.ts'), 'export function preSleep() { return 1; }');

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   reconcileIntervalMs: 60000,
  });

  const resumeEvents: string[] = [];
  sync.on('resume', id => resumeEvents.push(id));

  try {
   await sync.start(p.id);
   const before = await store.get(p.id);
   expect(before.analysis?.graph.nodes.some(n => n.name === 'preSleep')).toBe(true);

   // Simulate external change while system was suspended (event delivery disabled)
   sync.disableEventDelivery(p.id);
   await writeFile(join(p.root, 'main.ts'), 'export function postResume() { return 2; }');

   // Application resume triggers immediate reconciliation
   await sync.resume(p.id);

   expect(resumeEvents).toContain(p.id);
   const resumed = await store.get(p.id);
   expect(resumed.analysis?.graph.nodes.some(n => n.name === 'postResume')).toBe(true);
   expect(sync.hasReconcileTimer(p.id)).toBe(true);

   // Resume without arguments resumes all active sessions
   resumeEvents.length = 0;
   await sync.resume();
   expect(resumeEvents).toContain(p.id);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('recovers watcher cleanly when watcher was closed during error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t059-closed-watcher-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T059-ClosedWatcher' });

  await writeFile(join(p.root, 'main.ts'), 'export const active = true;');

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   reconcileIntervalMs: 60000,
  });

  try {
   await sync.start(p.id);
   expect(sync.isWatching(p.id)).toBe(true);

   const watcher = sync.getWatcher(p.id);
   expect(watcher).toBeDefined();

   // Simulate fatal crash where the watcher became closed
   await watcher!.close();
   expect((sync.getWatcher(p.id) as any).closed).toBe(true);

   // Watcher error triggers recovery and watcher re-creation
   await sync.handleWatcherError(p.id, new Error('EIO: Watcher I/O failed'));

   expect(sync.isWatching(p.id)).toBe(true);
   const newWatcher = sync.getWatcher(p.id);
   expect(newWatcher).toBeDefined();
   expect(newWatcher).not.toBe(watcher);

   // Newly recreated watcher successfully synchronizes subsequent saves
   await writeFile(join(p.root, 'new-file.ts'), 'export const fresh = 100;');
   await expect.poll(async () => {
    const current = await store.get(p.id);
    return current.analysis?.graph.nodes.some(n => n.name === 'new-file.ts');
   }, { timeout: 10000, interval: 50 }).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 15000);
});

describe('T060: Reconcile on resume and expose manual full rescan', () => {
 it('Concrete Scenario 1: Change files while the client is inactive, then resume (AC 1 & Scenario 1)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t060-scenario1-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T060-Scenario1' });

  await writeFile(join(p.root, 'main.ts'), 'export function preSuspension(): number { return 1; }');

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
   reconcileIntervalMs: 60000,
  });

  const resumeEvents: string[] = [];
  sync.on('resume', id => resumeEvents.push(id));

  const analysisUpdates: any[] = [];
  sync.on('notification', (_id, ev) => {
   if (ev.type === 'analysis') analysisUpdates.push(ev);
  });

  try {
   await sync.start(p.id);

   const initialProject = await store.get(p.id);
   expect(initialProject.analysis?.status).toBe('current');
   const rev1 = initialProject.analysis!.revision;
   const seq1 = initialProject.analysis!.sequence;
   expect(seq1).toBe(1);
   expect(initialProject.analysis?.graph.nodes.some(n => n.name === 'preSuspension')).toBe(true);

   // Step 1: Simulate client suspension / inactivity (disable event delivery)
   sync.disableEventDelivery(p.id);
   expect(sync.isEventDeliveryDisabled(p.id)).toBe(true);

   // Step 2: Make edits on disk while inactive / suspended
   await writeFile(
    join(p.root, 'main.ts'),
    'export function preSuspension(): number { return 1; }\nexport function postResumeTask(): string { return "resumed"; }\n'
   );
   await mkdir(join(p.root, 'prisma'), { recursive: true });
   await writeFile(
    join(p.root, 'prisma', 'schema.prisma'),
    'datasource db {\n  provider = "sqlite"\n  url = "file:dev.db"\n}\n\nmodel Member {\n  id Int @id\n  email String @unique\n}\n'
   );

   // Step 3: Verify that before resume, edits remain hidden and un-analyzed
   await new Promise(r => setTimeout(r, 150));
   const hiddenProject = await store.get(p.id);
   expect(hiddenProject.analysis!.revision).toBe(rev1);
   expect(hiddenProject.analysis!.sequence).toBe(seq1);
   expect(hiddenProject.analysis?.graph.nodes.some(n => n.name === 'postResumeTask')).toBe(false);

   // Step 4: Application resumes / regains active session
   analysisUpdates.length = 0;
   await sync.resume(p.id);

   // Verified: Resume detects edits made during suspension (AC 1 & Scenario 1)
   expect(resumeEvents).toContain(p.id);
   expect(sync.hasReconcileTimer(p.id)).toBe(true);

   const resumedProject = await store.get(p.id);
   expect(resumedProject.analysis?.status).toBe('current');
   expect(resumedProject.analysis!.sequence).toBe(seq1 + 1);
   expect(resumedProject.analysis!.revision).not.toBe(rev1);
   expect(resumedProject.analysis?.graph.nodes.some(n => n.name === 'postResumeTask')).toBe(true);
   expect(resumedProject.analysis?.graph.nodes.some(n => n.name === 'Member')).toBe(true);
   expect(analysisUpdates.length).toBeGreaterThanOrEqual(1);

   // Step 5: Global resume without arguments resumes all active sessions
   resumeEvents.length = 0;
   await sync.resume();
   expect(resumeEvents).toContain(p.id);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 15000);

 it('Concrete Scenario 2: Request manual rescan while an incremental run is pending (AC 3 & Scenario 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t060-scenario2-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T060-Scenario2' });

  await writeFile(join(p.root, 'main.ts'), 'export function v1(): number { return 1; }');

  // Part A: Request manual rescan while a debounced incremental run is pending
  const syncA = new SyncService(store, {
   watch: true,
   debounceMs: 500, // Generous debounce window to reliably test pending state
   stabilityThreshold: 50,
  });

  try {
   await syncA.start(p.id);
   const initial = await store.get(p.id);
   expect(initial.analysis?.sequence).toBe(1);

   // Trigger file edit that schedules a 500 ms debounced incremental run
   await writeFile(join(p.root, 'main.ts'), 'export function v2(): number { return 2; }');
   syncA.schedule(p.id, 'change', join(p.root, 'main.ts'));

   // Confirm incremental run is currently pending debounce
   expect(syncA.hasPendingDebounce(p.id)).toBe(true);

   // User requests manual rescan while the incremental run is pending
   const rescanPromise = syncA.rescan(p.id);

   // Debounce timer is cancelled immediately by manual rescan
   expect(syncA.hasPendingDebounce(p.id)).toBe(false);

   const rescanSuccess = await rescanPromise;
   expect(rescanSuccess).toBe(true);

   const updated = await store.get(p.id);
   expect(updated.analysis?.sequence).toBe(2);
   expect(updated.analysis?.graph.nodes.some(n => n.name === 'v2')).toBe(true);
  } finally {
   await syncA.close();
  }

  // Part B: Request manual rescan while an incremental worker analysis is in flight (supersession)
  let resolveFirstAnalyze: () => void;
  const firstAnalyzeStartedPromise = new Promise<void>((resolve) => {
   resolveFirstAnalyze = resolve;
  });

  let analyzeCallCount = 0;
  const controlledWorker = {
   analyze: vi.fn().mockImplementation((root: string, opts?: any) => {
    analyzeCallCount++;
    const currentCount = analyzeCallCount;
    if (currentCount === 2) {
     // Second call (generation 1, the incremental run) is held in flight
     resolveFirstAnalyze!();
     return new Promise((resolve) => {
      setTimeout(() => {
       resolve({
        revision: 'rev-incremental-superseded',
        sequence: 2,
        analyzedAt: new Date().toISOString(),
        status: 'current',
        graph: { schemaVersion: 1, nodes: [{ id: 'n-old', kind: 'function', name: 'staleRun', path: 'main.ts' }], edges: [], requirements: [] },
        files: {},
        durationMs: 10,
        quality: {
         eligibleFiles: 1,
         analyzedFiles: 1,
         unresolvedReferences: 0,
         unsupportedConstructs: 0,
         inferredItems: 0,
         prismaValidation: 'not-applicable',
         diagnostics: [],
        },
       });
      }, 50);
     });
    }

    // Normal analysis for start and generation 2 (rescan)
    return Promise.resolve({
     revision: `rev-gen-${opts?.generation || 0}`,
     sequence: (opts?.generation || 0) + 1,
     analyzedAt: new Date().toISOString(),
     status: 'current',
     graph: { schemaVersion: 1, nodes: [{ id: 'n-fresh', kind: 'function', name: 'freshRescan', path: 'main.ts' }], edges: [], requirements: [] },
     files: {},
     durationMs: 10,
     quality: {
      eligibleFiles: 1,
      analyzedFiles: 1,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
     },
    });
   }),
   close: vi.fn().mockResolvedValue(undefined),
  };

  const syncB = new SyncService(store, {
   watch: false,
   worker: controlledWorker as any,
  });

  const discardedEvents: any[] = [];
  syncB.on('discarded', (_id, ev) => discardedEvents.push(ev));

  try {
   await syncB.start(p.id);

   // Launch incremental request (generation 2)
   const incrementalGen = syncB.getGeneration(p.id) + 1;
   const incrementalPromise = syncB.request(p.id);
   await firstAnalyzeStartedPromise;

   // Verify incremental request is currently in-flight
   expect(syncB.getInFlightCount(p.id)).toBeGreaterThanOrEqual(1);

   // Request manual rescan while incremental run is pending in flight (AC 3)
   const rescanPromise = syncB.rescan(p.id);

   // Await both promises
   await Promise.all([incrementalPromise, rescanPromise]);

   // Incremental run must be discarded and superseded before persist (AC 3 & Scenario 2)
   expect(discardedEvents.some(e => e.generation === incrementalGen && e.reason.includes('superseded'))).toBe(true);

   // Committed analysis must reflect generation 2 (the fresh rescan), never the superseded generation 1
   const finalProject = await store.get(p.id);
   expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'freshRescan')).toBe(true);
   expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'staleRun')).toBe(false);
  } finally {
   await syncB.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 15000);

 it('Acceptance Criterion 2: Manual rescan runs fresh full analysis distinct from incremental refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t060-ac2-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T060-AC2' });

  await writeFile(join(p.root, 'main.ts'), 'export const baseline = 100;');

  const sync = new SyncService(store, {
   watch: false,
  });

  const analysisUpdates: any[] = [];
  sync.on('notification', (_id, ev) => {
   if (ev.type === 'analysis') analysisUpdates.push(ev);
  });

  const reconcileStarts: any[] = [];
  sync.on('reconcile-start', (_id, ev) => reconcileStarts.push(ev));

  try {
   await sync.start(p.id);
   const p1 = await store.get(p.id);
   const seq1 = p1.analysis!.sequence;
   expect(seq1).toBe(1);

   analysisUpdates.length = 0;
   reconcileStarts.length = 0;

   // 1. Incremental refresh / periodic reconcile when hashes on disk are unchanged
   const incrementalResult = await sync.reconcile(p.id);
   expect(incrementalResult).toBe(false); // No changes detected: no-op
   expect(analysisUpdates.length).toBe(0); // Zero spurious analysis updates published

   const pAfterIncremental = await store.get(p.id);
   expect(pAfterIncremental.analysis!.sequence).toBe(seq1); // Sequence did not change

   // 2. Manual full rescan when hashes on disk are unchanged
   const rescanResult = await sync.rescan(p.id);
   expect(rescanResult).toBe(true); // Forced full analysis runs (AC 2)
   expect(analysisUpdates.length).toBe(1); // Fresh graph revision published

   const pAfterRescan = await store.get(p.id);
   expect(pAfterRescan.analysis!.sequence).toBe(seq1 + 1); // Sequence advanced
   expect(reconcileStarts.some(e => e.force === true)).toBe(true);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('coalesces simultaneous resume, watch, and manual requests safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t060-coalesce-'));
  const store = new ProjectStore(dir);
  const p = await store.create({ name: 'T060-Coalesce' });

  await writeFile(join(p.root, 'main.ts'), 'export function initial() { return 1; }');

  const sync = new SyncService(store, {
   watch: true,
   debounceMs: 50,
  });

  try {
   await sync.start(p.id);

   await writeFile(join(p.root, 'main.ts'), 'export function simultaneous() { return 2; }');

   // Trigger simultaneous watch schedule, application resume, and manual rescan
   const p1 = sync.schedule(p.id, 'change', join(p.root, 'main.ts'));
   const p2 = sync.resume(p.id);
   const p3 = sync.rescan(p.id);
   const p4 = sync.request(p.id);

   // All concurrent requests settle cleanly without crashing or hanging
   await Promise.all([p2, p3, p4]);

   const final = await store.get(p.id);
   expect(final.analysis?.status).toBe('current');
   expect(final.analysis?.graph.nodes.some(n => n.name === 'simultaneous')).toBe(true);
   expect(sync.isUpdating(p.id)).toBe(false);
  } finally {
   await sync.close();
   await rm(dir, { recursive: true, force: true });
  }
 });

 it('HTTP Integration: server exposes validated manual full-rescan and resume endpoints and AnalysisClient integrates cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'architect-sync-t060-http-'));
  const sourceDir = join(dir, 'source');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'index.ts'), 'export function baseHttp() { return 1; }\n');

  const store = new ProjectStore(dir);
  const worker = new AnalysisWorker();
  const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });
  const app = await createServer({ store, sync, worker });
  const serverAddress = await app.listen({ host: '127.0.0.1', port: 0 });
  const apiBaseUrl = `${serverAddress}/api`;

  try {
   const project = await store.create({ name: 'HTTP T060 Workspace', root: sourceDir });

   // 1. Test POST /api/projects/:id/rescan (synchronous)
   const rescanRes = await fetch(`${apiBaseUrl}/projects/${project.id}/rescan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
   });
   expect(rescanRes.status).toBe(200);
   const rescanData = await rescanRes.json();
   expect(rescanData.projectId).toBe(project.id);
   expect(rescanData.status).toBe('current');
   expect(rescanData.sequence).toBeGreaterThanOrEqual(1);

   // 2. Test POST /api/projects/:id/rescan?async=true
   const rescanAsyncRes = await fetch(`${apiBaseUrl}/projects/${project.id}/rescan?async=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
   });
   expect(rescanAsyncRes.status).toBe(202);
   const rescanAsyncData = await rescanAsyncRes.json();
   expect(rescanAsyncData.status).toBe('updating');

   // 3. Test POST /api/projects/:id/resume while inactive
   sync.disableEventDelivery(project.id);
   await writeFile(join(sourceDir, 'index.ts'), 'export function baseHttp() { return 1; }\nexport function resumeHttp() { return 2; }\n');

   const resumeRes = await fetch(`${apiBaseUrl}/projects/${project.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
   });
   expect(resumeRes.status).toBe(200);
   const resumeData = await resumeRes.json();
   expect(resumeData.projectId).toBe(project.id);
   expect(resumeData.status).toBe('current');

   const projectAfterResume = await store.get(project.id);
   expect(projectAfterResume.analysis?.graph.nodes.some(n => n.name === 'resumeHttp')).toBe(true);

   // 4. Test POST /api/resume (global resume)
   const globalResumeRes = await fetch(`${apiBaseUrl}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
   });
   expect(globalResumeRes.status).toBe(200);

   // 5. Test AnalysisClient resume and rescan methods
   const client = new AnalysisClient({
    projectId: project.id,
    baseUrl: apiBaseUrl,
    origin: 'http://127.0.0.1:5173',
   });

   await client.connect();

   // Test client.rescan()
   const clientSnapshot = await client.rescan();
   expect(clientSnapshot).toBeDefined();
   expect(clientSnapshot.status).toBe('current');
   expect(client.getSnapshot()?.revision).toBe(clientSnapshot.revision);

   // Test client.resume()
   await writeFile(join(sourceDir, 'index.ts'), 'export function baseHttp() { return 1; }\nexport function resumeClient() { return 3; }\n');
   await client.resume();

   await expect.poll(async () => {
    const p = await store.get(project.id);
    return p.analysis?.graph.nodes.some(n => n.name === 'resumeClient');
   }, { timeout: 5000, interval: 50 }).toBe(true);

   // Test client coalescing of simultaneous rescan requests
   const rescanP1 = client.rescan();
   const rescanP2 = client.rescan();
   const [snap1, snap2] = await Promise.all([rescanP1, rescanP2]);
   expect(snap1.revision).toBe(snap2.revision);

   // Test client coalescing of simultaneous resume requests
   const resumeP1 = client.resume();
   const resumeP2 = client.resume();
   await Promise.all([resumeP1, resumeP2]);

   client.disconnect();
  } finally {
   await app.close();
   await sync.close();
   await worker.close();
   await rm(dir, { recursive: true, force: true });
  }
 }, 20000);
});
