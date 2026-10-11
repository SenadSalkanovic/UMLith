import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Analyzer } from '../server/analyzer';
import { AnalysisWorker } from '../server/worker';
import { GraphSchema, AnalysisSchema, graphDelta, applyGraphUpdate, type Analysis, type Graph, type Layout, type Project } from '../shared/model';
import { SyncService } from '../server/sync';
import { ProjectStore } from '../server/store';
import { freezeNode } from '../server/review';

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

describe('T051: Reconcile Prisma and nonlocal analysis inputs', () => {
  it('reparses changed schemas, caches unchanged schemas, and reconciles deleted schema findings with correct deltas (T051 Scenario 1 & AC 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-reconcile-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.graph.nodes.some(n => n.name === 'User')).toBe(true);
      expect(initial.graph.nodes.some(n => n.name === 'Post')).toBe(true);
      expect(initial.graph.edges.some(e => e.kind === 'relates-to')).toBe(true);
      expect(analyzer.getPrismaCache().has('prisma/schema.prisma')).toBe(true);

      const initialUserNode = initial.graph.nodes.find(n => n.name === 'User')!;
      const initialPostNode = initial.graph.nodes.find(n => n.name === 'Post')!;
      const initialRelEdge = initial.graph.edges.find(e => e.kind === 'relates-to')!;

      // 1. Add model Tag to schema.prisma
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}

model Tag {
  id   Int    @id @default(autoincrement())
  name String
}`
      );

      const step2 = await analyzer.analyze(dir);
      expect(analyzer.lastIncrementalInfo?.isWarm).toBe(true);
      expect(analyzer.lastIncrementalInfo?.scope).toBe('local');
      expect(analyzer.lastChangedInputs).toContain('prisma/schema.prisma');
      expect(step2.graph.nodes.some(n => n.name === 'Tag')).toBe(true);

      const delta2 = graphDelta(initial.graph, step2.graph);
      expect(delta2.changedNodes.some(n => n.name === 'Tag')).toBe(true);
      expect(delta2.deletedNodes).toEqual([]);

      const fresh2 = await new Analyzer().analyze(dir);
      expect(step2.graph).toEqual(fresh2.graph);
      expect(step2.quality).toEqual(fresh2.quality);
      expect(step2.status).toEqual(fresh2.status);

      // 2. Delete model Tag from schema.prisma
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`
      );

      const tagNode = step2.graph.nodes.find(n => n.name === 'Tag')!;
      const step3 = await analyzer.analyze(dir);
      expect(step3.graph.nodes.some(n => n.name === 'Tag')).toBe(false);

      const delta3 = graphDelta(step2.graph, step3.graph);
      expect(delta3.deletedNodes).toContain(tagNode.id);

      const fresh3 = await new Analyzer().analyze(dir);
      expect(step3.graph).toEqual(fresh3.graph);
      expect(step3.quality).toEqual(fresh3.quality);

      // 3. Delete schema.prisma entirely
      await rm(join(dir, 'prisma', 'schema.prisma'));
      const step4 = await analyzer.analyze(dir);
      expect(analyzer.getPrismaCache().has('prisma/schema.prisma')).toBe(false);

      const delta4 = graphDelta(step3.graph, step4.graph);
      expect(delta4.deletedNodes).toContain(initialUserNode.id);
      expect(delta4.deletedNodes).toContain(initialPostNode.id);
      expect(delta4.deletedEdges).toContain(initialRelEdge.id);

      expect(step4.graph.nodes.filter(n => n.kind === 'entity')).toEqual([]);
      expect(step4.graph.edges.filter(e => e.kind === 'relates-to')).toEqual([]);

      const fresh4 = await new Analyzer().analyze(dir);
      expect(step4.graph).toEqual(fresh4.graph);
      expect(step4.quality).toEqual(fresh4.quality);
      expect(step4.status).toEqual(fresh4.status);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renames and deletes relation targets, updating diagnostics, marking uncertain edges, and matching fresh full import oracle (T051 Scenario 1 & AC 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-targets-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id    Int    @id @default(autoincrement())
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.quality.unresolvedReferences).toBe(0);

      const initialUserNode = initial.graph.nodes.find(n => n.name === 'User')!;
      const initialPostNode = initial.graph.nodes.find(n => n.name === 'Post')!;
      const relEdgeInitial = initial.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(relEdgeInitial.uncertain).toBe(false);
      expect(relEdgeInitial.label).toBe('many → one · authorId');

      // Rename target model User to Account, but Post.author still points to User
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Account {
  id Int @id @default(autoincrement())
}

model Post {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`
      );

      const warmBroken = await analyzer.analyze(dir);
      expect(warmBroken.status).toBe('partial');
      expect(warmBroken.quality.unresolvedReferences).toBeGreaterThanOrEqual(1);
      expect(
        warmBroken.quality.diagnostics.some(
          d => d.code === 'unresolved-relation' && d.message.includes('User')
        )
      ).toBe(true);

      const relEdgeBroken = warmBroken.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(relEdgeBroken.uncertain).toBe(true);

      const deltaBroken = graphDelta(initial.graph, warmBroken.graph);
      expect(deltaBroken.deletedNodes).toContain(initialUserNode.id);
      expect(deltaBroken.changedNodes.some(n => n.name === 'Account')).toBe(true);
      expect(deltaBroken.changedEdges.some(e => e.id === relEdgeBroken.id && e.uncertain === true)).toBe(true);

      // Verify oracle equivalence
      const freshBroken = await new Analyzer().analyze(dir);
      expect(warmBroken.graph).toEqual(freshBroken.graph);
      expect(warmBroken.quality).toEqual(freshBroken.quality);
      expect(warmBroken.status).toEqual(freshBroken.status);

      // Delete Post as well, removing the broken relation
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Account {
  id Int @id @default(autoincrement())
}`
      );

      const warmClean = await analyzer.analyze(dir);
      expect(warmClean.status).toBe('current');
      expect(warmClean.quality.unresolvedReferences).toBe(0);
      expect(warmClean.graph.edges.filter(e => e.kind === 'relates-to')).toEqual([]);

      const deltaClean = graphDelta(warmBroken.graph, warmClean.graph);
      expect(deltaClean.deletedNodes).toContain(initialPostNode.id);
      expect(deltaClean.deletedEdges).toContain(relEdgeBroken.id);

      const freshClean = await new Analyzer().analyze(dir);
      expect(warmClean.graph).toEqual(freshClean.graph);
      expect(warmClean.quality).toEqual(freshClean.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates dependent relationships and edge labels when mapped fields and relation keys change (T051 Scenario 2 & AC 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-mapped-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Author {
  id    Int    @id @default(autoincrement())
  books Book[]

  @@map("authors")
}

model Book {
  id       Int    @id @default(autoincrement())
  authorId Int    @map("author_user_id")
  author   Author @relation(fields: [authorId], references: [id])

  @@map("books")
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');

      const bookInitial = initial.graph.nodes.find(n => n.name === 'Book')!;
      const authorIdField = (bookInitial as any).fields.find((f: any) => f.name === 'authorId')!;
      expect(authorIdField.mappedName).toBe('author_user_id');
      expect(authorIdField.key).toBe('FK');

      const edgeInitial = initial.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(edgeInitial.label).toBe('many → one · authorId');
      expect(edgeInitial.uncertain).toBe(false);

      // Step 1: Change logical field name to writerRef while keeping @map("author_user_id") and relation fields
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Author {
  id    Int    @id @default(autoincrement())
  books Book[]

  @@map("authors")
}

model Book {
  id        Int    @id @default(autoincrement())
  writerRef Int    @map("author_user_id")
  author    Author @relation(fields: [writerRef], references: [id])

  @@map("books")
}`
      );

      const warmMapped = await analyzer.analyze(dir);
      expect(warmMapped.status).toBe('current');

      const bookWarm = warmMapped.graph.nodes.find(n => n.name === 'Book')!;
      const writerRefField = (bookWarm as any).fields.find((f: any) => f.name === 'writerRef')!;
      expect(writerRefField.mappedName).toBe('author_user_id');
      expect(writerRefField.key).toBe('FK');

      const edgeWarm = warmMapped.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(edgeWarm.id).toBe(edgeInitial.id); // stable relation edge ID
      expect(edgeWarm.label).toBe('many → one · writerRef');
      expect(edgeWarm.uncertain).toBe(false);

      const delta = graphDelta(initial.graph, warmMapped.graph);
      expect(delta.changedEdges.some(e => e.id === edgeInitial.id && e.label === 'many → one · writerRef')).toBe(true);

      const freshMapped = await new Analyzer().analyze(dir);
      expect(warmMapped.graph).toEqual(freshMapped.graph);
      expect(warmMapped.quality).toEqual(freshMapped.quality);

      // Step 2: Break referenced field mapping (reference non-existent authorCode on Author)
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Author {
  id    Int    @id @default(autoincrement())
  books Book[]

  @@map("authors")
}

model Book {
  id        Int    @id @default(autoincrement())
  writerRef Int    @map("author_user_id")
  author    Author @relation(fields: [writerRef], references: [authorCode])

  @@map("books")
}`
      );

      const warmBroken = await analyzer.analyze(dir);
      expect(warmBroken.status).toBe('partial');
      expect(warmBroken.quality.unresolvedReferences).toBeGreaterThanOrEqual(1);
      expect(
        warmBroken.quality.diagnostics.some(
          d => d.code === 'unresolved-relation' && d.message.includes('authorCode')
        )
      ).toBe(true);

      const edgeBroken = warmBroken.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(edgeBroken.uncertain).toBe(true);

      const freshBroken = await new Analyzer().analyze(dir);
      expect(warmBroken.graph).toEqual(freshBroken.graph);
      expect(warmBroken.quality).toEqual(freshBroken.quality);
      expect(warmBroken.status).toEqual(freshBroken.status);

      // Step 3: Add authorCode to Author, resolving the relationship
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Author {
  id         Int    @id @default(autoincrement())
  authorCode Int    @unique
  books      Book[]

  @@map("authors")
}

model Book {
  id        Int    @id @default(autoincrement())
  writerRef Int    @map("author_user_id")
  author    Author @relation(fields: [writerRef], references: [authorCode])

  @@map("books")
}`
      );

      const warmResolved = await analyzer.analyze(dir);
      expect(warmResolved.status).toBe('current');
      expect(warmResolved.quality.unresolvedReferences).toBe(0);

      const edgeResolved = warmResolved.graph.edges.find(e => e.kind === 'relates-to')!;
      expect(edgeResolved.uncertain).toBe(false);

      const freshResolved = await new Analyzer().analyze(dir);
      expect(warmResolved.graph).toEqual(freshResolved.graph);
      expect(warmResolved.quality).toEqual(freshResolved.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('invalidates relation dependents across files when models change in multi-schema setups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-multi-schema-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'user.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id    Int    @id @default(autoincrement())
  posts Post[]
}`
      );
      await writeFile(
        join(dir, 'prisma', 'post.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Post {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.graph.edges.some(e => e.kind === 'relates-to')).toBe(true);

      // Verify transitive closure includes dependent schema
      const closureFromUser = analyzer.getAffectedClosure(['prisma/user.prisma']);
      expect(closureFromUser).toContain('prisma/user.prisma');
      expect(closureFromUser).toContain('prisma/post.prisma');

      const closureFromPost = analyzer.getAffectedClosure(['prisma/post.prisma']);
      expect(closureFromPost).toContain('prisma/user.prisma');
      expect(closureFromPost).toContain('prisma/post.prisma');

      // Update user.prisma
      await writeFile(
        join(dir, 'prisma', 'user.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id    Int    @id @default(autoincrement())
  role  String @default("user")
  posts Post[]
}`
      );

      const warm = await analyzer.analyze(dir);
      expect(analyzer.lastAffectedFiles).toContain('prisma/user.prisma');
      expect(analyzer.lastAffectedFiles).toContain('prisma/post.prisma');

      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers explicit broader invalidation and clears Prisma/compiler caches when Prisma parser configuration changes (T051 AC 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prisma-config-change-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id Int @id @default(autoincrement())
}`
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(analyzer.getPrismaCache().size).toBeGreaterThan(0);

      // Change prismaParserConfig option during warm analysis
      const warm = await analyzer.analyze(dir, {
        prismaParserConfig: { nodeLocationTracking: 'none' },
      });

      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.nonlocalInputs).toContain('prisma-parser-config');

      const fresh = await new Analyzer({
        prismaParserConfig: { nodeLocationTracking: 'none' },
      }).analyze(dir, {
        prismaParserConfig: { nodeLocationTracking: 'none' },
      });

      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers explicit broader invalidation when Prisma configuration files (.prismarc / prisma.config.ts) change (T051 Scenario 2 & AC 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-prismarc-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Member {
  id Int @id @default(autoincrement())
}`
      );
      await writeFile(
        join(dir, '.prismarc'),
        JSON.stringify({ schema: 'prisma/schema.prisma' })
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(analyzer.lastDiscovery?.dependencyInputs).toContain('.prismarc');
      expect(analyzer.lastDiscovery?.trackingInputs).toContain('.prismarc');

      // Modify .prismarc
      await writeFile(
        join(dir, '.prismarc'),
        JSON.stringify({ schema: 'prisma/schema.prisma', earlyAccess: true })
      );

      const warm = await analyzer.analyze(dir);
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.nonlocalInputs).toContain('.prismarc');

      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.revision).toEqual(fresh.revision);

      // Add prisma.config.ts (TypeScript format, verifying it is not treated as a tsconfig JSON file)
      await writeFile(
        join(dir, 'prisma.config.ts'),
        `export default {
  earlyAccess: true,
};`
      );

      const withPrismaConfig = await analyzer.analyze(dir);
      expect(withPrismaConfig.status).toBe('current');
      expect(withPrismaConfig.quality.diagnostics).toEqual([]);
      expect(analyzer.lastDiscovery?.configurationFiles).toContain('prisma.config.ts');
      expect(analyzer.lastDiscovery?.dependencyInputs).toContain('prisma.config.ts');
      expect(analyzer.lastDiscovery?.trackingInputs).toContain('prisma.config.ts');
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.nonlocalInputs).toContain('prisma.config.ts');

      const freshWithPrismaConfig = await new Analyzer().analyze(dir);
      expect(withPrismaConfig.graph).toEqual(freshWithPrismaConfig.graph);
      expect(withPrismaConfig.quality).toEqual(freshWithPrismaConfig.quality);
      expect(withPrismaConfig.status).toBe('current');

      // Modify prisma.config.ts
      await writeFile(
        join(dir, 'prisma.config.ts'),
        `export default {
  earlyAccess: false,
};`
      );

      const warmPrismaConfig = await analyzer.analyze(dir);
      expect(warmPrismaConfig.status).toBe('current');
      expect(warmPrismaConfig.quality.diagnostics).toEqual([]);
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.scope).toBe('broader');
      expect(analyzer.lastIncrementalInfo?.nonlocalInputs).toContain('prisma.config.ts');

      const freshModifiedPrismaConfig = await new Analyzer().analyze(dir);
      expect(warmPrismaConfig.graph).toEqual(freshModifiedPrismaConfig.graph);
      expect(warmPrismaConfig.quality).toEqual(freshModifiedPrismaConfig.quality);
      expect(warmPrismaConfig.status).toBe('current');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ensures config and dependency changes cannot leave an apparently current old graph and update status and quality (T051 AC 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-config-dep-safety-'));
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true });
      await writeFile(
        join(dir, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id Int @id @default(autoincrement())
}`
      );
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'prisma-app',
          devDependencies: {
            typescript: '6.0.3',
          },
        })
      );

      const analyzer = new Analyzer();
      const initial = await analyzer.analyze(dir);
      expect(initial.status).toBe('current');
      expect(initial.quality.diagnostics).toEqual([]);

      // Invalidate with incompatible compiler dependency
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'prisma-app',
          devDependencies: {
            typescript: '3.9.0',
          },
        })
      );

      const warm = await analyzer.analyze(dir);
      expect(analyzer.lastInvalidation?.scope).toBe('broader');
      expect(warm.status).toBe('partial');
      expect(
        warm.quality.diagnostics.some(
          d => d.code === 'incompatible-compiler-version'
        )
      ).toBe(true);

      const fresh = await new Analyzer().analyze(dir);
      expect(warm.graph).toEqual(fresh.graph);
      expect(warm.status).toEqual(fresh.status);
      expect(warm.quality).toEqual(fresh.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('integrates with SyncService: watches Prisma schemas and configs, emitting graph deltas and marking stale on errors (T051 R10/R11/R32)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-sync-prisma-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'architect-sync-prisma-store-'));
    const store = new ProjectStore(storeDir);
    const p = await store.create({ name: 'PrismaSyncTest', root: dir });
    const sync = new SyncService(store, { watch: false });

    const analysisUpdates: any[] = [];
    sync.on('notification', (_id, event) => {
      if (event.type === 'analysis') analysisUpdates.push(event);
    });

    try {
      await mkdir(join(p.root, 'prisma'), { recursive: true });
      await writeFile(
        join(p.root, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Customer {
  id    Int     @id @default(autoincrement())
  name  String
  orders Order[]
}

model Order {
  id         Int      @id @default(autoincrement())
  customerId Int      @map("customer_id")
  customer   Customer @relation(fields: [customerId], references: [id])
}`
      );
      await writeFile(
        join(p.root, 'app.ts'),
        `export function getApp() { return 'ready'; }`
      );

      await sync.start(p.id);
      expect(analysisUpdates.length).toBe(1);

      const initialAnalysis = (await store.get(p.id)).analysis!;
      expect(initialAnalysis.status).toBe('current');
      expect(initialAnalysis.graph.nodes.some(n => n.name === 'Customer')).toBe(true);
      expect(initialAnalysis.graph.nodes.some(n => n.name === 'Order')).toBe(true);

      const initialCustomerNode = initialAnalysis.graph.nodes.find(n => n.name === 'Customer')!;

      // Step 1: Change mapped field in Order
      await writeFile(
        join(p.root, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Customer {
  id    Int     @id @default(autoincrement())
  name  String
  orders Order[]
}

model Order {
  id          Int      @id @default(autoincrement())
  customerRef Int      @map("customer_id")
  customer    Customer @relation(fields: [customerRef], references: [id])
}`
      );

      await sync.reconcile(p.id);
      expect(analysisUpdates.length).toBe(2);

      const update1 = analysisUpdates[1];
      expect(update1.status).toBe('current');
      expect(
        update1.delta.changedEdges.some((e: any) => e.label === 'many → one · customerRef')
      ).toBe(true);

      // Step 2: Delete Customer model (relation target)
      await writeFile(
        join(p.root, 'prisma', 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Order {
  id          Int      @id @default(autoincrement())
  customerRef Int      @map("customer_id")
}`
      );

      await sync.reconcile(p.id);
      expect(analysisUpdates.length).toBe(3);

      const update2 = analysisUpdates[2];
      expect(update2.delta.deletedNodes).toContain(initialCustomerNode.id);
      expect(update2.delta.deletedEdges.length).toBeGreaterThan(0);

      // Step 3: Write invalid TypeScript syntax into app.ts, ensuring stale status is recorded and old graph cannot be left as current
      await writeFile(join(p.root, 'app.ts'), `export function broken( { return ;`);
      await sync.reconcile(p.id);

      const staleProject = await store.get(p.id);
      expect(staleProject.analysis?.status).toBe('stale');
      expect(staleProject.analysis?.staleEvidence).toBeDefined();
    } finally {
      await sync.close();
      await rm(dir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe('T063: Verify incremental and full import equivalence', () => {
  function assertSyncEquivalenceWithFreshImport(
    syncedAnalysis: Analysis,
    freshAnalysis: Analysis,
    options?: { allowPreservedRenamedIds?: boolean }
  ): void {
    expect(syncedAnalysis.status).toBe(freshAnalysis.status);
    expect(syncedAnalysis.quality.eligibleFiles).toBe(freshAnalysis.quality.eligibleFiles);
    expect(syncedAnalysis.quality.analyzedFiles).toBe(freshAnalysis.quality.analyzedFiles);
    expect(syncedAnalysis.quality.unresolvedReferences).toBe(freshAnalysis.quality.unresolvedReferences);
    expect(syncedAnalysis.quality.unsupportedConstructs).toBe(freshAnalysis.quality.unsupportedConstructs);
    expect(syncedAnalysis.quality.inferredItems).toBe(freshAnalysis.quality.inferredItems);
    expect(syncedAnalysis.quality.prismaValidation).toBe(freshAnalysis.quality.prismaValidation);

    // File inventory
    expect(Object.keys(syncedAnalysis.files).sort()).toEqual(Object.keys(freshAnalysis.files).sort());

    // Nodes and edges count
    expect(syncedAnalysis.graph.nodes.length).toBe(freshAnalysis.graph.nodes.length);
    expect(syncedAnalysis.graph.edges.length).toBe(freshAnalysis.graph.edges.length);

    if (!options?.allowPreservedRenamedIds) {
      expect(syncedAnalysis.graph.nodes).toEqual(freshAnalysis.graph.nodes);
      expect(syncedAnalysis.graph.edges).toEqual(freshAnalysis.graph.edges);
    } else {
      for (const freshNode of freshAnalysis.graph.nodes) {
        const match = syncedAnalysis.graph.nodes.find(
          n => n.kind === freshNode.kind && n.name === freshNode.name && n.source?.path === freshNode.source?.path
        );
        expect(match, `Missing matching node for ${freshNode.kind} ${freshNode.name}`).toBeDefined();
        expect(match?.contract).toBe(freshNode.contract);
        if (freshNode.source && match?.source) {
          expect(match.source.hash).toBe(freshNode.source.hash);
        }
      }
      for (const freshEdge of freshAnalysis.graph.edges) {
        const match = syncedAnalysis.graph.edges.find(
          e => e.kind === freshEdge.kind && e.label === freshEdge.label
        );
        expect(match, `Missing matching edge for ${freshEdge.kind} ${freshEdge.label}`).toBeDefined();
      }
    }

    expect(GraphSchema.safeParse(syncedAnalysis.graph).success).toBe(true);
    expect(AnalysisSchema.safeParse(syncedAnalysis).success).toBe(true);
  }

  function assertPreservationInvariants(
    project: Project,
    initialSpec: Graph,
    initialLayout: Layout,
    initialBaselines: Record<string, any>
  ): void {
    // 1. Human specification JSON is strictly preserved
    expect(project.specification.nodes).toEqual(initialSpec.nodes);
    expect(project.specification.edges).toEqual(initialSpec.edges);

    // 2. Protected baselines in specification are strictly preserved
    for (const [nodeId, expectedBaseline] of Object.entries(initialBaselines)) {
      const node = project.specification.nodes.find(n => n.id === nodeId);
      expect(node, `Protected node ${nodeId} missing in specification`).toBeDefined();
      expect(node?.baseline).toEqual(expectedBaseline);
    }

    // 3. Layout of surviving nodes is preserved
    for (const [nodeId, pos] of Object.entries(initialLayout)) {
      if (
        project.analysis?.graph.nodes.some(n => n.id === nodeId) ||
        project.specification.nodes.some(n => n.id === nodeId)
      ) {
        expect(project.layout[nodeId], `Layout position missing for node ${nodeId}`).toEqual(pos);
      }
    }
  }

  it('verifies the mutation-matrix fixture matches expected full-import oracle', async () => {
    const fixtureDir = resolve('tests/fixtures/mutation-matrix');
    const expectedPath = resolve('tests/fixtures/mutation-matrix.expected.json');

    const analyzer = new Analyzer();
    const actual = await analyzer.analyze(fixtureDir);
    expect(actual.status).toBe('current');
    expect(actual.quality.analyzedFiles).toBeGreaterThanOrEqual(2);

    let expectedRaw: string;
    try {
      expectedRaw = await readFile(expectedPath, 'utf8');
    } catch {
      await writeFile(expectedPath, JSON.stringify(actual.graph, null, 2) + '\n');
      expectedRaw = await readFile(expectedPath, 'utf8');
    }
    const expectedGraph = JSON.parse(expectedRaw);
    expect(actual.graph).toEqual(expectedGraph);
    expect(GraphSchema.safeParse(actual.graph).success).toBe(true);
  });

  it('executes comprehensive mutation matrix across saves, additions, renames, deletions, config, and dependency changes, proving convergence to fresh-import oracle while strictly preserving specifications, layouts, and protection baselines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-mutation-matrix-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'architect-mutation-store-'));
    const store = new ProjectStore(storeDir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, watch: false });

    try {
      await cp(resolve('tests/fixtures/mutation-matrix'), dir, { recursive: true });
      const p = await store.create({ name: 'MutationMatrix', root: dir });

      // Initial Sync to obtain source-bound nodes
      await sync.start(p.id);
      const initialAnalysis = (await store.get(p.id)).analysis!;

      const orderNode = initialAnalysis.graph.nodes.find(n => n.name === 'OrderDto')!;
      const processOrderNode = initialAnalysis.graph.nodes.find(n => n.name === 'processOrder')!;
      const customerNode = initialAnalysis.graph.nodes.find(n => n.name === 'Customer')!;
      const validateOrderNode = initialAnalysis.graph.nodes.find(n => n.name === 'validateOrder')!;

      // Setup human specification nodes using freezeNode for protected items
      const frozenOrderNode = {
        ...freezeNode(orderNode, 'frozen-contract', initialAnalysis),
        parentId: undefined,
        description: 'Human-owned order interface contract',
      };

      const frozenProcessOrderNode = {
        ...freezeNode(processOrderNode, 'frozen-implementation', initialAnalysis),
        parentId: undefined,
        description: 'Human-owned order processing rule',
      };

      const sensitiveCustomerNode = {
        ...customerNode,
        policy: 'sensitive' as const,
        parentId: undefined,
        description: 'Human-owned customer entity',
      };

      const editableValidateOrderNode = {
        ...validateOrderNode,
        policy: 'editable' as const,
        parentId: undefined,
        description: 'Human-owned validation function',
      };

      const specNodes = [
        sensitiveCustomerNode,
        frozenOrderNode,
        frozenProcessOrderNode,
        editableValidateOrderNode,
      ];
      await store.updateSpec(p.id, 0, { nodes: specNodes, edges: [] });

      const initialLayout: Layout = {
        [sensitiveCustomerNode.id]: { x: 100, y: 150 },
        [frozenOrderNode.id]: { x: 300, y: 150 },
        [frozenProcessOrderNode.id]: { x: 500, y: 150 },
        [editableValidateOrderNode.id]: { x: 700, y: 150 },
      };
      await store.updateLayout(p.id, initialLayout);
      await store.updateLayout(p.id, { [sensitiveCustomerNode.id]: { x: 100, y: 150 } }, 'er');
      await store.updateLayout(p.id, { [frozenOrderNode.id]: { x: 300, y: 150 } }, 'architecture');

      const initialBaselines: Record<string, any> = {
        [frozenOrderNode.id]: frozenOrderNode.baseline,
        [frozenProcessOrderNode.id]: frozenProcessOrderNode.baseline,
      };

      let project = await store.get(p.id);
      let fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      assertPreservationInvariants(project, project.specification, initialLayout, initialBaselines);
      const expectedSpec = project.specification;

      // ── Step 1: Save (TypeScript function body modification of editable node) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total >= 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 2: Addition (TypeScript new interface & function) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total >= 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}

export interface ShippingInfo {
  trackingNumber: string;
}

export function calculateShipping(weight: number): number {
  return weight * 1.5;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'ShippingInfo')).toBe(true);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'calculateShipping')).toBe(true);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 3: Prisma Save (New enum and model field) ──
      await writeFile(
        join(dir, 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
}

enum OrderStatus {
  PENDING
  SHIPPED
  DELIVERED
}

model Customer {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String?
  orders Order[]
}

model Order {
  id         Int         @id @default(autoincrement())
  customerId Int
  amount     Float
  status     OrderStatus @default(PENDING)
  customer   Customer    @relation(fields: [customerId], references: [id])
  @@map("orders")
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'OrderStatus')).toBe(true);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 4: Rename (TypeScript unambiguous function rename) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total >= 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}

export interface ShippingInfo {
  trackingNumber: string;
}

export function computeShippingRate(weight: number): number {
  return weight * 1.5;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh, { allowPreservedRenamedIds: true });
      expect(project.analysis?.graph.nodes.some(n => n.name === 'computeShippingRate')).toBe(true);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'calculateShipping')).toBe(false);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 5: Prisma Rename (Field mapped rename) ──
      await writeFile(
        join(dir, 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
}

enum OrderStatus {
  PENDING
  SHIPPED
  DELIVERED
}

model Customer {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String?
  orders Order[]
}

model Order {
  id          Int         @id @default(autoincrement())
  customerId  Int
  totalAmount Float       @map("amount")
  status      OrderStatus @default(PENDING)
  customer    Customer    @relation(fields: [customerId], references: [id])
  @@map("orders")
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh, { allowPreservedRenamedIds: true });
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 6: Deletion (TypeScript removal) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total >= 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'computeShippingRate')).toBe(false);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'ShippingInfo')).toBe(false);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 7: Prisma Deletion (Field & enum removal) ──
      await writeFile(
        join(dir, 'schema.prisma'),
        `datasource db {
  provider = "sqlite"
}

model Customer {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String?
  orders Order[]
}

model Order {
  id         Int      @id @default(autoincrement())
  customerId Int
  amount     Float
  customer   Customer @relation(fields: [customerId], references: [id])
  @@map("orders")
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      expect(project.analysis?.graph.nodes.some(n => n.name === 'OrderStatus')).toBe(false);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 8: Dependency Change (package.json) ──
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify(
          {
            name: 'mutation-matrix-fixture',
            version: '1.1.0',
            dependencies: {
              typescript: '6.0.3',
              zod: '^3.23.8',
            },
          },
          null,
          2
        )
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 9: Configuration Change (tsconfig.json paths) ──
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              skipLibCheck: true,
              paths: {
                '@matrix/*': ['./*'],
              },
            },
            include: ['*.ts'],
          },
          null,
          2
        )
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 10: Protected External Edit (Divergence Violation without baseline reset) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total >= 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  console.log("tampered external edit to frozen implementation");
  return true;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);

      // Divergence report verifies deterministic violation
      const divergence = sync.getDivergenceReport(p.id)!;
      expect(divergence).toBeDefined();
      expect(divergence.summary.hasBlockingViolations).toBe(true);
      expect(
        divergence.items.some(v => v.kind === 'frozen-implementation-violation')
      ).toBe(true);

      // Preservation invariants strictly verified: baseline was NOT reset!
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);

      // ── Step 11: Protected Code Restored (Divergence clears, baseline still preserved) ──
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total > 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}
`
      );
      await sync.reconcile(p.id);
      project = await store.get(p.id);
      fresh = await new Analyzer().analyze(dir);
      assertSyncEquivalenceWithFreshImport(project.analysis!, fresh);

      const clearedDivergence = sync.getDivergenceReport(p.id)!;
      expect(clearedDivergence.summary.hasBlockingViolations).toBe(false);
      assertPreservationInvariants(project, expectedSpec, initialLayout, initialBaselines);
    } finally {
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('proves superseded analysis evidence never wins during rapid out-of-order completions and concurrent writes (R33, AC 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-superseded-matrix-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'architect-superseded-store-'));
    const store = new ProjectStore(storeDir);
    const p = await store.create({ name: 'SupersededMatrix', root: dir });

    await writeFile(join(p.root, 'index.ts'), 'export function v0(): number { return 0; }\n');

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

    const discardedEvents: any[] = [];
    sync.on('discarded', (_id, ev) => {
      discardedEvents.push(ev);
    });

    try {
      await sync.start(p.id);
      const initial = await store.get(p.id);
      expect(initial.analysis?.graph.nodes.some(n => n.name === 'v0')).toBe(true);

      // Save 1: writes v1 (generation 2, held in worker)
      await writeFile(join(p.root, 'index.ts'), 'export function v1(): number { return 1; }\n');
      const reqGen2Promise = sync.request(p.id);

      // Save 2: writes v2 (generation 3, not held)
      await writeFile(join(p.root, 'index.ts'), 'export function v2(): number { return 2; }\n');
      const reqGen3Promise = sync.request(p.id);

      // Generation 3 completes first
      await reqGen3Promise;
      const afterGen3 = await store.get(p.id);
      expect(afterGen3.analysis?.graph.nodes.some(n => n.name === 'v2')).toBe(true);
      expect(afterGen3.analysis?.graph.nodes.some(n => n.name === 'v1')).toBe(false);

      // Release generation 2
      releaseGen2!();
      await reqGen2Promise;

      // Assert that generation 2 was discarded
      expect(discardedEvents.some(d => d.generation === 2)).toBe(true);

      // The store MUST still have v2, NOT v1
      const finalProject = await store.get(p.id);
      expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'v2')).toBe(true);
      expect(finalProject.analysis?.graph.nodes.some(n => n.name === 'v1')).toBe(false);

      // Final committed model matches fresh full import oracle
      const fresh = await new Analyzer().analyze(dir);
      expect(finalProject.analysis?.graph).toEqual(fresh.graph);
      expect(finalProject.analysis?.quality).toEqual(fresh.quality);
    } finally {
      await sync.close();
      await realWorker.close();
      await rm(dir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it('recovers from rapid successive writes and invalid intermediate code, ensuring synchronization converges to fresh-import oracle once stabilized (R33, Scenario 2, AC 1 & 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-rapid-invalid-matrix-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'architect-rapid-invalid-store-'));
    const store = new ProjectStore(storeDir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, debounceMs: 40, stabilityThreshold: 40 });

    try {
      await cp(resolve('tests/fixtures/mutation-matrix'), dir, { recursive: true });
      const p = await store.create({ name: 'RapidInvalidMatrix', root: dir });

      // Initial analysis to freeze node cleanly
      await sync.start(p.id);
      const initialAnalysis = (await store.get(p.id)).analysis!;
      const procNode = initialAnalysis.graph.nodes.find(n => n.name === 'processOrder')!;
      const frozenNode = {
        ...freezeNode(procNode, 'frozen-implementation', initialAnalysis),
        parentId: undefined,
        description: 'Protected processing function',
      };

      await store.updateSpec(p.id, 0, {
        nodes: [frozenNode],
        edges: [],
      });
      await store.updateLayout(p.id, { [frozenNode.id]: { x: 200, y: 300 } });
      const initialProject = await store.get(p.id);

      // 1. Rapid successive writes (<15ms apart) across files
      for (let i = 1; i <= 5; i++) {
        await writeFile(
          join(dir, 'orders.ts'),
          `export interface OrderDto { id: string; total: number; }\nexport function validateOrder(order: OrderDto): boolean { return order.total > ${i}; }\nexport async function processOrder(order: OrderDto): Promise<boolean> { return true; }\n`
        );
        await new Promise(r => setTimeout(r, 10));
      }

      // Wait for debounce & stabilization
      await expect.poll(async () => {
        const proj = await store.get(p.id);
        return Boolean(proj.analysis?.files['orders.ts']?.text.includes('> 5'));
      }, { timeout: 5000, interval: 50 }).toBe(true);

      const postRapid = await store.get(p.id);
      const freshAfterRapid = await new Analyzer().analyze(dir);
      expect(postRapid.analysis?.status).toBe('current');
      expect(postRapid.analysis?.graph.nodes.length).toBe(freshAfterRapid.graph.nodes.length);
      expect(postRapid.specification).toEqual(initialProject.specification);
      expect(postRapid.layout[frozenNode.id]).toEqual({ x: 200, y: 300 });

      // 2. Invalid intermediate code: introduce syntax error
      await writeFile(join(dir, 'orders.ts'), 'export function broken( { return ;');
      await sync.reconcile(p.id);

      const staleProj = await store.get(p.id);
      expect(staleProj.analysis?.status).toBe('stale');
      expect(staleProj.analysis?.staleEvidence).toBeDefined();
      expect(staleProj.specification).toEqual(initialProject.specification);
      expect(staleProj.layout[frozenNode.id]).toEqual({ x: 200, y: 300 });

      // 3. Valid recovery: repair syntax
      await writeFile(
        join(dir, 'orders.ts'),
        `export interface OrderDto { id: string; total: number; }\nexport function validateOrder(order: OrderDto): boolean { return order.total > 0; }\nexport async function processOrder(order: OrderDto): Promise<boolean> {\n  if (!validateOrder(order)) {\n    throw new Error('Invalid order total');\n  }\n  return true;\n}\n`
      );
      await sync.reconcile(p.id);

      const recoveredProj = await store.get(p.id);
      expect(recoveredProj.analysis?.status).toBe('current');
      const freshRecovered = await new Analyzer().analyze(dir);
      expect(recoveredProj.analysis?.graph.nodes).toEqual(freshRecovered.graph.nodes);
      expect(recoveredProj.analysis?.quality).toEqual(freshRecovered.quality);
      expect(recoveredProj.specification).toEqual(initialProject.specification);
      expect(recoveredProj.layout[frozenNode.id]).toEqual({ x: 200, y: 300 });
    } finally {
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it('handles ambiguous renames and moves without resetting protected baselines or silently rebinding (R14, R34, AC 3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'architect-ambiguous-matrix-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'architect-ambiguous-store-'));
    const store = new ProjectStore(storeDir);
    const worker = new AnalysisWorker();
    const sync = new SyncService(store, { worker, watch: false });

    try {
      await writeFile(
        join(dir, 'service.ts'),
        `export function calculateRate(amount: number): number { return amount * 0.1; }\n`
      );

      const p = await store.create({ name: 'AmbiguousMatrix', root: dir });

      // Initial analysis to obtain node id
      await sync.start(p.id);
      const initialAnalysis = (await store.get(p.id)).analysis!;
      const rateNode = initialAnalysis.graph.nodes.find(n => n.name === 'calculateRate')!;

      // Add human specification with frozen-implementation policy
      const frozenRateNode = {
        ...freezeNode(rateNode, 'frozen-implementation', initialAnalysis),
        parentId: undefined,
        description: 'Protected rate calculation',
      };
      await store.updateSpec(p.id, 0, {
        nodes: [frozenRateNode],
        edges: [],
      });

      // External mutation: introduce two competing candidate declarations with identical signature
      await writeFile(
        join(dir, 'service.ts'),
        `export function calculateRateAlpha(amount: number): number { return amount * 0.1; }\nexport function calculateRateBeta(amount: number): number { return amount * 0.1; }\n`
      );

      await sync.reconcile(p.id);
      const afterMutation = await store.get(p.id);

      // Verify that binding review surfaces ambiguity
      const bindingReviews = sync.getBindingReviews(p.id);
      expect(bindingReviews.length).toBeGreaterThanOrEqual(1);
      const ambiguousRecord = bindingReviews.find(r => r.nodeName === 'calculateRate');
      expect(ambiguousRecord).toBeDefined();
      expect(ambiguousRecord?.status).toBe('ambiguous');
      expect(ambiguousRecord?.candidates.length).toBeGreaterThanOrEqual(2);

      // Verify preservation invariants:
      // 1. The protected node in specification was NOT arbitrarily rebound
      const specNode = afterMutation.specification.nodes.find(n => n.name === 'calculateRate');
      expect(specNode).toBeDefined();
      expect(specNode?.baseline).toEqual(frozenRateNode.baseline);

      // 2. Fresh full import oracle confirms candidates exist
      const fresh = await new Analyzer().analyze(dir);
      expect(fresh.graph.nodes.some(n => n.name === 'calculateRateAlpha')).toBe(true);
      expect(fresh.graph.nodes.some(n => n.name === 'calculateRateBeta')).toBe(true);
      expect(fresh.graph.nodes.some(n => n.name === 'calculateRate')).toBe(false);
    } finally {
      await sync.close();
      await worker.close();
      await rm(dir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
