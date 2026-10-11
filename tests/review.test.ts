import {it,expect,describe} from 'vitest';
import {mkdtemp,writeFile,cp,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../server/store';
import {Analyzer} from '../server/analyzer';
import {validateCandidate,applyReviewed,freezeNode,protectionIssues,computeDivergenceReport} from '../server/review';
import {captureFiles,hashes,safePath} from '../server/files';
import {SyncService} from '../server/sync';
import {GraphSchema,NodeSchema,emptyGraph,DivergenceReportSchema,type AgentJob,type Analysis,type Project} from '../shared/model';

it('freezes an explicit interface before code exists and rejects blank interfaces',()=>{
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',contract:'  run(): number\r\n'});
 const frozen=freezeNode(node,'frozen-contract');
 expect(GraphSchema.parse({nodes:[frozen],edges:[]}).nodes[0]).toMatchObject({
  policy:'frozen-contract',contract:'  run(): number\r\n',baseline:{contract:'  run(): number\r\n'},
 });
 expect(frozen.source).toBeUndefined();
 expect(()=>freezeNode({...node,contract:'\r\n '},'frozen-contract')).toThrow();
 expect(()=>freezeNode(node,'frozen-implementation')).toThrow();
});

it('captures a contract from valid source evidence when no explicit interface is supplied',()=>{
 const source={path:'run.ts',symbol:'run',start:0,end:3,line:1,hash:'h',revision:'r1'};
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',source});
 const actual={...node,contract:'run(): number'};
 const analysis:Analysis={revision:'r1',sequence:1,analyzedAt:'',status:'current',graph:{...emptyGraph(),nodes:[actual]},
  files:{'run.ts':{hash:'h',text:'run'}},durationMs:0,
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
 const frozen=freezeNode(node,'frozen-contract',analysis);
 expect(frozen.baseline).toEqual({source,contract:'run(): number'});
 expect(NodeSchema.safeParse(frozen).success).toBe(true);
 for(const candidate of [
  {...analysis,revision:'r2'}, {...analysis,status:'stale' as const}, {...analysis,files:{}},
  {...analysis,files:{'run.ts':{hash:'other',text:'run'}}},
  {...analysis,graph:{...analysis.graph,nodes:[node]}},
  {...analysis,graph:{...analysis.graph,nodes:[actual,{...actual,id:'duplicate'}]}},
 ])expect(()=>freezeNode(node,'frozen-contract',candidate)).toThrow();
 // Source rebinding must not mutate the independently captured protection evidence.
 frozen.source!.hash='new-hash';
 expect(frozen.baseline?.source?.hash).toBe('h');
 expect(node.source?.hash).toBe('h');
});

it('rejects invalid or unavailable evidence before freezing or verifying protected source',()=>{
 const source={path:'run.ts',start:0,end:3,line:1,hash:'h',revision:'r1'};
 const node=NodeSchema.parse({id:'run',kind:'function',name:'Run',source});
 const analysis:Analysis={revision:'r1',sequence:1,analyzedAt:'',status:'current',graph:{...emptyGraph(),nodes:[node]},
  files:{'run.ts':{hash:'h',text:'run'}},durationMs:0,
  quality:{eligibleFiles:1,analyzedFiles:1,unresolvedReferences:0,unsupportedConstructs:0,inferredItems:0,prismaValidation:'not-applicable',diagnostics:[]}};
 const frozen=freezeNode(node,'frozen-implementation',analysis);
 const project={specification:{...emptyGraph(),nodes:[frozen]}} as Project;
 for(const candidate of [
  {...analysis,revision:'r2'}, {...analysis,status:'stale' as const}, {...analysis,status:'updating' as const},
  {...analysis,files:{}}, {...analysis,files:{'run.ts':{hash:'other',text:'run'}}},
  {...analysis,graph:{...analysis.graph,nodes:[{...node,source:{...source,end:4}}]}},
 ]) {
  const actual=candidate.graph.nodes[0];
  expect(()=>freezeNode(actual,'frozen-implementation',candidate)).toThrow();
  expect(protectionIssues(project,candidate)).toContainEqual(expect.objectContaining({code:'binding',nodeId:'run'}));
 }
});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'architect-review-'));const store=new ProjectStore(dir);
 const p=await store.create({name:'Protected'});
 await writeFile(join(p.root,'main.ts'),'export function pay(amount: number): number { return amount * 2; }\n');
 const analysis=await new Analyzer().analyze(p.root);await store.updateAnalysis(p.id,analysis);
 const node=analysis.graph.nodes.find(n=>n.name==='pay')!;
 const candidate=join(dir,'candidate');await cp(p.root,candidate,{recursive:true});
 const job:AgentJob={id:'test',projectId:p.id,kind:'implementation',status:'review',createdAt:'',specRevision:0,sourceHashes:hashes(await captureFiles(p.root)),task:'Update',scope:['main.ts'],workspace:candidate,events:[]};
 return {dir,store,p,node,job,candidate};
}
it('blocks frozen implementation edits but permits internal edits under a frozen contract',async()=>{
 const s=await setup();try{
  const frozen=freezeNode(s.node,'frozen-implementation',s.p.analysis||await new Analyzer().analyze(s.p.root));
  await s.store.updateSpec(s.p.id,0,{nodes:[{...frozen,parentId:undefined}],edges:[]});s.job.specRevision=1;
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  const p=await s.store.get(s.p.id);
  expect((await validateCandidate(p,s.job)).issues.some(i=>i.code==='frozen-implementation')).toBe(true);
  const contract=freezeNode(s.node,'frozen-contract',p.analysis!);
  await s.store.updateSpec(s.p.id,1,{nodes:[{...contract,parentId:undefined}],edges:[]});s.job.specRevision=2;
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).passed).toBe(true);
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: string): string { return amount; }\n');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).issues.some(i=>i.code==='frozen-contract')).toBe(true);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('permits internal edits after freezing a binding with a whitespace-only interface',async()=>{
 const s=await setup();try{
  const p=await s.store.get(s.p.id);
  const frozen=freezeNode({...s.node,contract:' \r\n'},'frozen-contract',p.analysis);
  expect(frozen.baseline?.contract).toBe(s.node.contract);
  await s.store.updateSpec(s.p.id,0,{nodes:[{...frozen,parentId:undefined}],edges:[]});s.job.specRevision=1;
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).passed).toBe(true);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('rejects out-of-scope and stale changes, and only applies reviewed file contents',async()=>{
 const s=await setup();try{
  await writeFile(join(s.candidate,'other.ts'),'export const outside = 1;');
  expect((await validateCandidate(await s.store.get(s.p.id),s.job)).issues.some(i=>i.code==='scope')).toBe(true);
  await rm(join(s.candidate,'other.ts'));
  await writeFile(join(s.candidate,'main.ts'),'export function pay(amount: number): number { return amount * 3; }\n');
  s.job.report=await validateCandidate(await s.store.get(s.p.id),s.job);
  await applyReviewed(s.store,s.job);
  expect(await readFile(join(s.p.root,'main.ts'),'utf8')).toContain('* 3');
  await writeFile(join(s.p.root,'main.ts'),'export const externalEdit = true;');
  await expect(applyReviewed(s.store,{...s.job,status:'review'})).rejects.toThrow('Source changed');
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it('rejects path traversal and symbolic links',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'architect-paths-'));try{
  await expect(safePath(dir,'../outside')).rejects.toThrow('Unsafe');
  await symlink(tmpdir(),join(dir,'escape'));
  await expect(safePath(dir,'escape/file.ts')).rejects.toThrow('Symlink');
 }finally{await rm(dir,{recursive:true,force:true});}
});

describe('T062: Continuously report architecture and protection divergence', () => {
  it('raises deterministic violations on frozen external edits while retaining the protected baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-t062-frozen-'));
    const store = new ProjectStore(dir);
    const p = await store.create({ name: 'FrozenDivergence' });
    try {
      await writeFile(
        join(p.root, 'main.ts'),
        'export function secureHash(input: string): string { return "hash:" + input; }\n'
      );
      const initialAnalysis = await new Analyzer().analyze(p.root);
      await store.updateAnalysis(p.id, initialAnalysis);

      const node = initialAnalysis.graph.nodes.find(n => n.name === 'secureHash')!;
      const frozenNode = freezeNode(node, 'frozen-implementation', initialAnalysis);

      // Save frozen node in specification
      await store.updateSpec(p.id, 0, {
        nodes: [{ ...frozenNode, parentId: undefined }],
        edges: [],
      });

      // 1. Unmodified code: no divergence
      const currentProj = await store.get(p.id);
      const cleanReport = computeDivergenceReport(currentProj, initialAnalysis);
      expect(cleanReport.summary.protectionViolations).toBe(0);
      expect(cleanReport.summary.hasBlockingViolations).toBe(false);

      // 2. Modify frozen code externally
      await writeFile(
        join(p.root, 'main.ts'),
        'export function secureHash(input: string): string { return "tampered:" + input; }\n'
      );
      const modifiedAnalysis = await new Analyzer().analyze(p.root);
      modifiedAnalysis.sequence = 2;

      // Retain the protected baseline: specification baseline has NOT been reset
      const projectBeforeReport = await store.get(p.id);
      expect(projectBeforeReport.specification.nodes[0].baseline?.text).toBe(frozenNode.baseline?.text);

      const report = computeDivergenceReport(projectBeforeReport, modifiedAnalysis);

      // AC: Frozen external edits raise violations
      expect(report.summary.protectionViolations).toBe(1);
      expect(report.summary.hasBlockingViolations).toBe(true);

      const violation = report.items.find(i => i.kind === 'frozen-implementation-violation');
      expect(violation).toBeDefined();
      expect(violation?.isDeterministicDefect).toBe(true);
      expect(violation?.category).toBe('protection-violation');
      expect(violation?.nodeName).toBe('secureHash');

      // AC: Drift reports identify source revision and evidence
      expect(report.revision).toBe(modifiedAnalysis.revision);
      expect(report.sequence).toBe(2);
      expect(violation?.evidence).toBeDefined();
      expect(violation?.evidence?.path).toBe('main.ts');
      expect(violation?.evidence?.expectedText).toContain('"hash:" + input');
      expect(violation?.evidence?.actualText).toContain('"tampered:" + input');
      expect(violation?.evidence?.hash).toBe(modifiedAnalysis.files['main.ts'].hash);
      expect(violation?.evidence?.revision).toBe(modifiedAnalysis.revision);

      // Confirm baseline was not reset after divergence report computation
      const projectAfterReport = await store.get(p.id);
      expect(projectAfterReport.specification.nodes[0].baseline?.text).toBe(frozenNode.baseline?.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not present unknown business intent or editable changes as a deterministic code defect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-t062-editable-'));
    const store = new ProjectStore(dir);
    const p = await store.create({ name: 'EditableIntent' });
    try {
      await writeFile(
        join(p.root, 'calc.ts'),
        'export function calculateSum(a: number, b: number): number { return a + b; }\n'
      );
      const initialAnalysis = await new Analyzer().analyze(p.root);
      await store.updateAnalysis(p.id, initialAnalysis);

      const node = initialAnalysis.graph.nodes.find(n => n.name === 'calculateSum')!;
      // Editable node with human-specified contract
      const editableNode = NodeSchema.parse({
        ...node,
        policy: 'editable',
        description: 'Computes sum of numbers',
      });
      await store.updateSpec(p.id, 0, {
        nodes: [{ ...editableNode, parentId: undefined }],
        edges: [],
      });

      // 1. External edit changes internal implementation of editable module without altering intent/contract
      await writeFile(
        join(p.root, 'calc.ts'),
        'export function calculateSum(a: number, b: number): number { const res = a + b; return res; }\n'
      );
      const updatedAnalysis = await new Analyzer().analyze(p.root);
      updatedAnalysis.sequence = 2;

      const project = await store.get(p.id);
      const report = computeDivergenceReport(project, updatedAnalysis);

      // AC: Unknown business intent is not presented as a deterministic code defect
      expect(report.summary.protectionViolations).toBe(0);
      expect(report.summary.hasBlockingViolations).toBe(false);

      // The editable implementation change is reported with isDeterministicDefect: false
      const implItem = report.items.find(i => i.kind === 'implementation-drift');
      expect(implItem).toBeDefined();
      expect(implItem?.isDeterministicDefect).toBe(false);
      expect(implItem?.category).toBe('structural-drift');
      expect(implItem?.message).toContain('calculateSum');
      expect(implItem?.evidence?.path).toBe('calc.ts');
      expect(implItem?.evidence?.revision).toBe(updatedAnalysis.revision);

      // 2. Add an unmodeled function to source (new implementation)
      await writeFile(
        join(p.root, 'calc.ts'),
        'export function calculateSum(a: number, b: number): number { return a + b; }\n' +
        'export function calculateProduct(a: number, b: number): number { return a * b; }\n'
      );
      const analysisWithNewFn = await new Analyzer().analyze(p.root);
      analysisWithNewFn.sequence = 3;

      const reportWithNewFn = computeDivergenceReport(project, analysisWithNewFn);
      expect(reportWithNewFn.summary.protectionViolations).toBe(0);
      expect(reportWithNewFn.summary.hasBlockingViolations).toBe(false);

      const addedItem = reportWithNewFn.items.find(i => i.kind === 'added-node' && i.nodeName === 'calculateProduct');
      expect(addedItem).toBeDefined();
      expect(addedItem?.nodeName).toBe('calculateProduct');
      expect(addedItem?.isDeterministicDefect).toBe(false);
      expect(addedItem?.category).toBe('structural-drift');
      expect(addedItem?.evidence?.path).toBe('calc.ts');

      // 3. Inject uncertain relationship / unresolved reference into analysis
      const analysisWithUncertain = {
        ...analysisWithNewFn,
        quality: {
          ...analysisWithNewFn.quality,
          unresolvedReferences: 3,
        },
      };
      const reportWithUncertain = computeDivergenceReport(project, analysisWithUncertain);
      const uncertainItem = reportWithUncertain.items.find(i => i.kind === 'uncertain-intent');
      expect(uncertainItem).toBeDefined();
      expect(uncertainItem?.isDeterministicDefect).toBe(false);
      expect(uncertainItem?.category).toBe('uncertainty');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Concrete validation scenario 1: Edit frozen code outside the application with live sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-t062-sync-frozen-'));
    const store = new ProjectStore(dir);
    const p = await store.create({ name: 'LiveFrozenDivergence' });
    const sync = new SyncService(store, { watch: false });

    try {
      await writeFile(
        join(p.root, 'main.ts'),
        'export function tokenValidator(token: string): boolean { return token.startsWith("auth_"); }\n'
      );
      await sync.start(p.id);

      const beforeProj = await store.get(p.id);
      expect(beforeProj.analysis).toBeDefined();

      const node = beforeProj.analysis!.graph.nodes.find(n => n.name === 'tokenValidator')!;
      const frozen = freezeNode(node, 'frozen-implementation', beforeProj.analysis!);
      await store.updateSpec(p.id, 0, {
        nodes: [{ ...frozen, parentId: undefined }],
        edges: [],
      });

      // Track published notifications
      const notifications: any[] = [];
      sync.on('notification', (_id, event) => notifications.push(event));
      const divergenceEvents: any[] = [];
      sync.on('divergence', (_id, report) => divergenceEvents.push(report));

      // EDIT FROZEN CODE OUTSIDE THE APPLICATION
      await writeFile(
        join(p.root, 'main.ts'),
        'export function tokenValidator(token: string): boolean { return true; }\n'
      );

      // Live sync request
      await sync.request(p.id);

      // Verify specification baseline was NOT reset
      const afterProj = await store.get(p.id);
      expect(afterProj.specification.nodes[0].baseline?.text).toBe(frozen.baseline?.text);

      // Verify divergence report published after sync
      const publishedReport = sync.getDivergenceReport(p.id);
      expect(publishedReport).toBeDefined();
      expect(publishedReport?.revision).toBe(afterProj.analysis?.revision);
      expect(publishedReport?.summary.hasBlockingViolations).toBe(true);
      expect(publishedReport?.summary.protectionViolations).toBe(1);

      const violation = publishedReport?.items.find(i => i.kind === 'frozen-implementation-violation');
      expect(violation).toBeDefined();
      expect(violation?.isDeterministicDefect).toBe(true);
      expect(violation?.evidence?.path).toBe('main.ts');
      expect(violation?.evidence?.expectedText).toContain('token.startsWith("auth_")');
      expect(violation?.evidence?.actualText).toContain('return true;');
      expect(violation?.evidence?.hash).toBe(afterProj.analysis?.files['main.ts'].hash);
      expect(violation?.evidence?.revision).toBe(afterProj.analysis?.revision);

      // Verify event emission
      expect(divergenceEvents.length).toBeGreaterThan(0);
      expect(notifications.some(n => n.type === 'divergence' && n.report.summary.hasBlockingViolations)).toBe(true);
    } finally {
      await sync.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Concrete validation scenario 2: Change an editable module and compare drift without altering intent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-t062-sync-editable-'));
    const store = new ProjectStore(dir);
    const p = await store.create({ name: 'LiveEditableDrift' });
    const sync = new SyncService(store, { watch: false });

    try {
      await writeFile(
        join(p.root, 'service.ts'),
        'export function formatOrder(id: number): string { return "ORD-" + id; }\n'
      );
      await sync.start(p.id);

      const beforeProj = await store.get(p.id);
      const node = beforeProj.analysis!.graph.nodes.find(n => n.name === 'formatOrder')!;
      const editable = NodeSchema.parse({
        ...node,
        policy: 'editable',
        description: 'Formats customer order identifiers',
      });
      await store.updateSpec(p.id, 0, {
        nodes: [{ ...editable, parentId: undefined }],
        edges: [],
      });

      const notifications: any[] = [];
      sync.on('notification', (_id, event) => notifications.push(event));

      // 1. CHANGE EDITABLE MODULE INTERNALS WITHOUT ALTERING INTENT
      await writeFile(
        join(p.root, 'service.ts'),
        'export function formatOrder(id: number): string { const pad = String(id).padStart(5, "0"); return "ORD-" + pad; }\n'
      );

      await sync.request(p.id);

      const afterProj = await store.get(p.id);
      // Intended graph is NOT altered
      expect(afterProj.specification.nodes[0].description).toBe('Formats customer order identifiers');
      expect(afterProj.specification.nodes[0].policy).toBe('editable');

      const driftReport = sync.getDivergenceReport(p.id);
      expect(driftReport).toBeDefined();
      expect(driftReport?.revision).toBe(afterProj.analysis?.revision);

      // Unknown business intent is NOT presented as a deterministic code defect!
      expect(driftReport?.summary.protectionViolations).toBe(0);
      expect(driftReport?.summary.hasBlockingViolations).toBe(false);

      const implItem = driftReport?.items.find(i => i.kind === 'implementation-drift');
      expect(implItem).toBeDefined();
      expect(implItem?.isDeterministicDefect).toBe(false);
      expect(implItem?.category).toBe('structural-drift');
      expect(implItem?.evidence?.path).toBe('service.ts');
      expect(implItem?.evidence?.snippet).toContain('padStart');

      // 2. Now alter the declared contract of the editable module in source
      await writeFile(
        join(p.root, 'service.ts'),
        'export function formatOrder(id: number, prefix: string = "ORD"): string { return prefix + "-" + id; }\n'
      );

      await sync.request(p.id);

      const contractDriftProj = await store.get(p.id);
      // Human specification still untouched
      expect(contractDriftProj.specification.nodes[0].contract).toBe(editable.contract);

      const contractReport = sync.getDivergenceReport(p.id);
      expect(contractReport?.summary.protectionViolations).toBe(0);
      expect(contractReport?.summary.hasBlockingViolations).toBe(false);

      const contractItem = contractReport?.items.find(i => i.kind === 'contract-drift');
      expect(contractItem).toBeDefined();
      expect(contractItem?.isDeterministicDefect).toBe(false);
      expect(contractItem?.category).toBe('structural-drift');
      expect(contractItem?.evidence?.expectedContract).toContain('formatOrder(id: number): string');
      expect(contractItem?.evidence?.actualContract).toContain('prefix');
    } finally {
      await sync.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
