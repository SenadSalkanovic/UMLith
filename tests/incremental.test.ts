import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Analyzer } from '../server/analyzer';
import { AnalysisWorker } from '../server/worker';
import { GraphSchema } from '../shared/model';

describe('T050: Incremental analysis and affected dependencies', () => {
  it('updates dependent signatures and calls when a provider changes, matching a fresh full import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-incremental-provider-'));
    try {
      await writeFile(
        join(dir, 'shared.ts'),
        `export interface UserDto {
  id: string;
  name: string;
}`
      );
      await writeFile(
        join(dir, 'serviceA.ts'),
        `import { UserDto } from './shared';
export function createUser(data: UserDto) {
  return { ...data, active: true };
}`
      );
      await writeFile(
        join(dir, 'serviceB.ts'),
        `import { UserDto } from './shared';
export function formatUser(u: UserDto): string {
  return u.name;
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.quality.analyzedFiles).toBe(3);

      const userDtoInitial = initial.graph.nodes.find(n => n.name === 'UserDto')!;
      expect(userDtoInitial.contract).toContain('id: string');
      expect(userDtoInitial.contract).toContain('name: string');
      expect(userDtoInitial.contract).not.toContain('email: string');

      const createUserInitial = initial.graph.nodes.find(n => n.name === 'createUser')!;
      expect(createUserInitial.contract).toContain('id: string');
      expect(createUserInitial.contract).toContain('name: string');
      expect(createUserInitial.contract).not.toContain('email: string');

      // Update provider interface by adding email: string
      await writeFile(
        join(dir, 'shared.ts'),
        `export interface UserDto {
  id: string;
  name: string;
  email: string;
}`
      );

      // Run warm analysis on the existing Analyzer instance
      const warm = await analyzer.analyze(dir);
      expect(warm.quality.analyzedFiles).toBe(3);

      // Verify incremental info
      expect(analyzer.lastIncrementalInfo?.isWarm).toBe(true);
      expect(analyzer.lastIncrementalInfo?.scope).toBe('local');
      expect(analyzer.lastChangedInputs).toContain('shared.ts');

      // Affected files closure must include provider and both dependents
      expect(analyzer.lastAffectedFiles).toContain('shared.ts');
      expect(analyzer.lastAffectedFiles).toContain('serviceA.ts');
      expect(analyzer.lastAffectedFiles).toContain('serviceB.ts');

      // Dependent signatures/contracts must update
      const userDtoWarm = warm.graph.nodes.find(n => n.name === 'UserDto')!;
      expect(userDtoWarm.contract).toContain('email: string');

      // createUser in serviceA.ts inferred return type signature updates to include email: string
      const createUserWarm = warm.graph.nodes.find(n => n.name === 'createUser')!;
      expect(createUserWarm.contract).toContain('email: string');

      // Fresh full import is the correctness oracle
      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.quality).toEqual(fresh.quality);
      expect(warm.status).toEqual(fresh.status);
      expect(GraphSchema.safeParse(warm.graph).success).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers explicit broader invalidation when path aliases in tsconfig.json change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-incremental-alias-'));
    try {
      await mkdir(join(dir, 'src', 'v1'), { recursive: true });
      await mkdir(join(dir, 'src', 'v2'), { recursive: true });

      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            paths: {
              '@service/*': ['./src/v1/*'],
            },
          },
        })
      );
      await writeFile(
        join(dir, 'src', 'v1', 'helper.ts'),
        `export function helper(): string { return 'v1'; }`
      );
      await writeFile(
        join(dir, 'src', 'v2', 'helper.ts'),
        `export function helper(): number { return 2; }`
      );
      await writeFile(
        join(dir, 'src', 'consumer.ts'),
        `import { helper } from '@service/helper';
export function run(): any {
  return helper();
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');

      const v1ModuleId = initial.graph.nodes.find(n => n.name === 'src/v1/helper.ts')?.id;
      const consumerModuleId = initial.graph.nodes.find(n => n.name === 'src/consumer.ts')?.id;
      expect(
        initial.graph.edges.some(
          e => e.source === consumerModuleId && e.target === v1ModuleId && e.kind === 'depends-on'
        )
      ).toBe(true);

      // Change path alias in tsconfig.json to point to v2
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            paths: {
              '@service/*': ['./src/v2/*'],
            },
          },
        })
      );

      const updated = await analyzer.analyze(dir);

      // Broader invalidation must be explicit
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastInvalidationReason).toContain('tsconfig.json');
      expect(analyzer.lastIncrementalInfo?.scope).toBe('broader');

      const v2ModuleId = updated.graph.nodes.find(n => n.name === 'src/v2/helper.ts')?.id;
      expect(
        updated.graph.edges.some(
          e => e.source === consumerModuleId && e.target === v2ModuleId && e.kind === 'depends-on'
        )
      ).toBe(true);

      // Oracle verification
      const fresh = await new Analyzer().analyze(dir);
      expect(updated.graph).toEqual(fresh.graph);
      expect(updated.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers explicit broader invalidation when project references change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-incremental-proj-refs-'));
    try {
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'utils', 'src'), { recursive: true });

      await writeFile(
        join(dir, 'packages', 'core', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { composite: true, target: 'ES2022', module: 'ESNext' },
          include: ['src/**/*'],
        })
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        `export class CoreService { id = 1; }`
      );

      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          files: [],
          references: [{ path: './packages/core' }],
        })
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.graph.nodes.some(n => n.name === 'CoreService')).toBe(true);

      // Now create utils project and add reference in root tsconfig
      await writeFile(
        join(dir, 'packages', 'utils', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { composite: true, target: 'ES2022', module: 'ESNext' },
          include: ['src/**/*'],
        })
      );
      await writeFile(
        join(dir, 'packages', 'utils', 'src', 'index.ts'),
        `export class UtilService { util = true; }`
      );

      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          files: [],
          references: [{ path: './packages/core' }, { path: './packages/utils' }],
        })
      );

      const warm = await analyzer.analyze(dir);
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastInvalidationReason).toContain('tsconfig.json');
      expect(warm.graph.nodes.some(n => n.name === 'CoreService')).toBe(true);
      expect(warm.graph.nodes.some(n => n.name === 'UtilService')).toBe(true);

      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers explicit broader invalidation when a dependency declaration in package.json changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-incremental-pkg-'));
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'pkg-test',
          devDependencies: {
            typescript: '6.0.3',
          },
        })
      );
      await writeFile(join(dir, 'app.ts'), `export const appName = 'test';`);

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.quality.diagnostics).toEqual([]);

      // Change dependency to incompatible version
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'pkg-test',
          devDependencies: {
            typescript: '4.9.5',
          },
        })
      );

      const warm = await analyzer.analyze(dir);
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastInvalidationReason).toContain('package.json');
      expect(
        warm.quality.diagnostics.some(d => d.code === 'incompatible-compiler-version')
      ).toBe(true);

      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies incremental results equal fresh full-import results across renames, deletions, and saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-incremental-oracle-'));
    try {
      await writeFile(
        join(dir, 'math.ts'),
        `export function add(a: number, b: number): number { return a + b; }
export function sub(a: number, b: number): number { return a - b; }`
      );
      await writeFile(
        join(dir, 'main.ts'),
        `import { add } from './math';
export function calculate(): number { return add(2, 3); }`
      );

      const analyzer = new Analyzer();
      const step1 = await analyzer.analyze(dir);
      expect(step1.status).toBe('current');

      // 1. Save edit to math.ts
      await writeFile(
        join(dir, 'math.ts'),
        `export function add(a: number, b: number): number { return a + b + 1; }
export function sub(a: number, b: number): number { return a - b; }`
      );
      const step2 = await analyzer.analyze(dir);
      const fresh2 = await new Analyzer().analyze(dir);
      expect(step2.graph).toEqual(fresh2.graph);
      expect(step2.quality).toEqual(fresh2.quality);

      // 2. Delete math.ts
      await rm(join(dir, 'math.ts'));
      const step3 = await analyzer.analyze(dir);
      const fresh3 = await new Analyzer().analyze(dir);
      expect(step3.graph).toEqual(fresh3.graph);
      expect(step3.quality).toEqual(fresh3.quality);
      expect(step3.quality.diagnostics.some(d => d.code === 'unresolved-import')).toBe(true);

      // 3. Re-create under new name calc.ts and update main.ts
      await writeFile(
        join(dir, 'calc.ts'),
        `export function add(a: number, b: number): number { return a + b; }`
      );
      await writeFile(
        join(dir, 'main.ts'),
        `import { add } from './calc';
export function calculate(): number { return add(5, 5); }`
      );
      const step4 = await analyzer.analyze(dir);
      const fresh4 = await new Analyzer().analyze(dir);
      expect(step4.graph).toEqual(fresh4.graph);
      expect(step4.quality).toEqual(fresh4.quality);
      expect(step4.status).toBe('current');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses compiler builder facilities, exposes builder programs, and computes transitive dependent closure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-builder-closure-'));
    try {
      await writeFile(join(dir, 'a.ts'), `export interface A { value: string; }`);
      await writeFile(join(dir, 'b.ts'), `import { A } from './a'; export interface B { a: A; }`);
      await writeFile(join(dir, 'c.ts'), `import { B } from './b'; export function getB(): B { return { a: { value: 'ok' } }; }`);
      await writeFile(join(dir, 'd.ts'), `export const unrelated = 100;`);

      const analyzer = new Analyzer();
      await analyzer.analyze(dir);

      // Compiler builder program facility must be active
      const builder = analyzer.getBuilderProgram('unconfigured');
      expect(builder).toBeDefined();
      expect(typeof builder?.getProgram).toBe('function');
      expect(typeof builder?.getSemanticDiagnosticsOfNextAffectedFile).toBe('function');

      // Test transitive dependent closure computation
      const closure = analyzer.getAffectedClosure(['a.ts']);
      expect(closure).toContain('a.ts');
      expect(closure).toContain('b.ts');
      expect(closure).toContain('c.ts');
      expect(closure).not.toContain('d.ts');

      // Manual invalidation resets builder state
      analyzer.invalidate('Test reset');
      expect(analyzer.getBuilderProgram('unconfigured')).toBeUndefined();
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastInvalidationReason).toBe('Test reset');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('integrates with AnalysisWorker for warm analysis and explicit invalidation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-worker-incremental-'));
    const worker = new AnalysisWorker();
    try {
      await writeFile(join(dir, 'provider.ts'), `export interface User { id: string; }`);
      await writeFile(
        join(dir, 'consumer.ts'),
        `import { User } from './provider';\nexport function makeUser(): User { return { id: 'u1' }; }`
      );

      const r1 = await worker.analyze(dir);
      expect(r1.status).toBe('current');
      expect(r1.quality.analyzedFiles).toBe(2);

      // Warm modification in worker
      await writeFile(join(dir, 'provider.ts'), `export interface User { id: string; role: string; }`);
      const r2 = await worker.analyze(dir);
      const fresh = await new Analyzer().analyze(dir);
      expect(r2.graph).toEqual(fresh.graph);
      expect(r2.quality).toEqual(fresh.quality);

      // Explicit invalidation via worker
      await worker.invalidate('Manual test invalidation');
      const r3 = await worker.analyze(dir);
      expect(r3.graph).toEqual(fresh.graph);
    } finally {
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
