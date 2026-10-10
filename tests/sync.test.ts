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
} from '../server/sync';
import {AnalysisSchema,GraphUpdateSchema,applyGraphUpdate} from '../shared/model';

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
