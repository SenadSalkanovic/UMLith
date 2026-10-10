import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,mkdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {
 Analyzer,
 resolveProjectPrismaValidator,
 validatePrismaSchemaInIsolation,
 type PrismaValidationResult,
} from '../server/analyzer';
import {
 setSandboxExecutorForTesting,
 setSandboxAvailabilityForTesting,
 resetSandboxForTesting,
 type SandboxOptions,
} from '../server/sandbox';
import {captureFiles,hashes} from '../server/files';

describe('T043: Run isolated project-version Prisma validation', () => {
 let tempDirs: string[] = [];

 beforeEach(() => {
  resetSandboxForTesting();
  // Provide a test sandbox executor that executes child process in cwd,
  // matching the isolation boundary semantics while running safely in test containers.
  setSandboxExecutorForTesting(async (command: string, args: string[], cwd: string, options: SandboxOptions) => {
   return new Promise<{code: number; output: string}>((res, rej) => {
    const child = spawn(command, args, {
     cwd,
     env: options.env || process.env,
     stdio: ['pipe', 'pipe', 'pipe'],
    });
    options.onProcess?.(child);
    child.stdin.end(options.input || '');
    let output = '';
    child.stdout?.on('data', chunk => {
     const text = chunk.toString();
     output += text;
     options.onOutput?.(text);
    });
    child.stderr?.on('data', chunk => {
     const text = chunk.toString();
     output += text;
     options.onOutput?.(text);
    });
    child.on('error', rej);
    child.on('close', code => {
     res({code: code ?? -1, output});
    });
   });
  });
 });

 afterEach(async () => {
  resetSandboxForTesting();
  for (const dir of tempDirs) {
   await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
  tempDirs = [];
 });

 async function createProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'architect-test-prisma-val-'));
  tempDirs.push(dir);
  return dir;
 }

 async function setupFakePrismaValidator(projectDir: string, validatorScript: string): Promise<string> {
  const binDir = join(projectDir, 'node_modules', '.bin');
  await mkdir(binDir, {recursive: true});
  const binPath = join(binDir, 'prisma');
  await writeFile(binPath, validatorScript, {mode: 0o755});
  await chmod(binPath, 0o755);
  return binPath;
 }

 it('validates a valid schema with a fake project-version validator in an isolated workspace (concrete scenario 1 & AC 1, 3)', async () => {
  const projectDir = await createProjectDir();

  // 1. Setup project files with valid Prisma schema
  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'valid-prisma-project', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  const validSchema = `
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`;
  await writeFile(join(projectDir, 'prisma', 'schema.prisma'), validSchema, 'utf8');

  // 2. Setup fake project-version validator
  const fakeValidatorCode = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

// Simulate Prisma validate command
const args = process.argv.slice(2);
if (args[0] !== 'validate') {
  console.error('Unknown command:', args[0]);
  process.exit(2);
}

let schemaPath = 'prisma/schema.prisma';
const schemaIdx = args.indexOf('--schema');
if (schemaIdx !== -1 && args[schemaIdx + 1]) {
  schemaPath = args[schemaIdx + 1];
}

const fullSchemaPath = path.resolve(process.cwd(), schemaPath);
if (!fs.existsSync(fullSchemaPath)) {
  console.error('Schema not found at ' + schemaPath);
  process.exit(1);
}

const content = fs.readFileSync(fullSchemaPath, 'utf8');
if (!content.includes('model User')) {
  console.error('Invalid schema: User model missing');
  process.exit(1);
}

// Attempt to write a side-effect file in cwd to verify isolation protection
fs.writeFileSync(path.resolve(process.cwd(), 'mutation-test.tmp'), 'side effect');

console.log('The Prisma schema at ' + schemaPath + ' is valid');
process.exit(0);
`;
  await setupFakePrismaValidator(projectDir, fakeValidatorCode);

  // Capture file hashes of original project before validation
  const originalCaptured = await captureFiles(projectDir);
  const originalHashes = hashes(originalCaptured);

  // 3. Run validation directly
  const valResult: PrismaValidationResult = await validatePrismaSchemaInIsolation(projectDir);
  expect(valResult.status).toBe('passed');
  expect(valResult.exitCode).toBe(0);
  expect(valResult.output).toContain('The Prisma schema at prisma/schema.prisma is valid');
  expect(valResult.diagnostics).toEqual([]);

  // 4. Run full analysis via Analyzer
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);

  // Assert quality report fields
  expect(analysis.quality.prismaValidation).toBe('passed');
  expect(analysis.status).toBe('current');
  expect(analysis.quality.diagnostics).toEqual([]);

  // Schema extraction is distinguished from validation: AST nodes extracted
  const userNode = analysis.graph.nodes.find(n => n.kind === 'entity' && n.name === 'User');
  expect(userNode).toBeDefined();
  expect(userNode?.fields?.some(f => f.name === 'email' && f.key === 'UNIQUE')).toBe(true);
  expect(userNode?.fields?.some(f => f.name === 'id' && f.key === 'PK')).toBe(true);

  // 5. Acceptance Criterion 1: Original project files remain completely unchanged
  const afterCaptured = await captureFiles(projectDir);
  const afterHashes = hashes(afterCaptured);
  expect(afterHashes).toEqual(originalHashes);
  expect(originalCaptured['prisma/schema.prisma'].toString()).toBe(validSchema);

  // Side-effect file created by validator in isolated workspace must NOT exist in original project
  let sideEffectExists = false;
  try {
   await readFile(join(projectDir, 'mutation-test.tmp'));
   sideEffectExists = true;
  } catch {}
  expect(sideEffectExists).toBe(false);
 });

 it('validates an invalid schema with a fake project-version validator in an isolated workspace (concrete scenario 1 & AC 1, 3)', async () => {
  const projectDir = await createProjectDir();

  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'invalid-prisma-project', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});

  // Schema that parses as AST but is semantically invalid
  const invalidSchema = `
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model BrokenOrder {
  id        Int          @id
  buyer     InvalidModel @relation(fields: [buyerId], references: [id])
  buyerId   Int
}
`;
  await writeFile(join(projectDir, 'prisma', 'schema.prisma'), invalidSchema, 'utf8');

  // Fake validator that detects semantic problem and exits with non-zero
  const fakeValidatorCode = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
let schemaPath = 'prisma/schema.prisma';
const schemaIdx = args.indexOf('--schema');
if (schemaIdx !== -1 && args[schemaIdx + 1]) {
  schemaPath = args[schemaIdx + 1];
}

const content = fs.readFileSync(path.resolve(process.cwd(), schemaPath), 'utf8');
if (content.includes('InvalidModel')) {
  console.error('Error validating: Type "InvalidModel" is neither a built-in type, nor refers to another model or enum.');
  process.exit(1);
}

console.log('Schema is valid');
process.exit(0);
`;
  await setupFakePrismaValidator(projectDir, fakeValidatorCode);

  const originalCaptured = await captureFiles(projectDir);
  const originalHashes = hashes(originalCaptured);

  // 1. Run validation directly
  const valResult = await validatePrismaSchemaInIsolation(projectDir);
  expect(valResult.status).toBe('failed');
  expect(valResult.exitCode).toBe(1);
  expect(valResult.output).toContain('Type "InvalidModel" is neither a built-in type');
  expect(valResult.diagnostics.length).toBeGreaterThan(0);
  expect(valResult.diagnostics[0].severity).toBe('error');
  expect(valResult.diagnostics[0].code).toBe('prisma-validation');
  expect(valResult.diagnostics[0].message).toContain('InvalidModel');

  // 2. Run analysis
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);

  expect(analysis.quality.prismaValidation).toBe('failed');
  expect(analysis.status).toBe('partial');
  expect(analysis.quality.diagnostics.some(d => d.code === 'prisma-validation')).toBe(true);

  // Schema extraction is distinguished from validation success:
  // AST nodes are still extracted into the graph
  const orderNode = analysis.graph.nodes.find(n => n.kind === 'entity' && n.name === 'BrokenOrder');
  expect(orderNode).toBeDefined();

  // 3. Original project files remain unchanged
  const afterCaptured = await captureFiles(projectDir);
  const afterHashes = hashes(afterCaptured);
  expect(afterHashes).toEqual(originalHashes);
 });

 it('removes validator and asserts unavailable rather than passed with reason (concrete scenario 2 & AC 2)', async () => {
  const projectDir = await createProjectDir();

  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'missing-validator-project', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  await writeFile(
   join(projectDir, 'prisma', 'schema.prisma'),
   'model Item {\n  id Int @id\n}\n',
   'utf8'
  );

  // Confirm validator does not exist
  const validator = await resolveProjectPrismaValidator(projectDir);
  expect(validator).toBeNull();

  // Ensure isolation is available
  setSandboxAvailabilityForTesting(true);

  // Run validation
  const valResult = await validatePrismaSchemaInIsolation(projectDir);

  // Assert unavailable rather than passed
  expect(valResult.status).not.toBe('passed');
  expect(valResult.status).toBe('unavailable');
  expect(valResult.reason).toBeDefined();
  expect(valResult.reason).toContain('node_modules/.bin/prisma not found');
  expect(valResult.reason).toContain('Global Prisma CLI will not be substituted');

  // Run analysis
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);
  expect(analysis.quality.prismaValidation).toBe('unavailable');
  expect(analysis.quality.prismaValidation).not.toBe('passed');
  expect(analyzer.lastPrismaValidation?.status).toBe('unavailable');

  // Schema extraction still succeeded
  expect(analysis.graph.nodes.some(n => n.kind === 'entity' && n.name === 'Item')).toBe(true);
 });

 it('removes isolation and asserts unavailable rather than passed with reason (concrete scenario 2 & AC 2)', async () => {
  const projectDir = await createProjectDir();

  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'no-isolation-project', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  await writeFile(
   join(projectDir, 'prisma', 'schema.prisma'),
   'model Item {\n  id Int @id\n}\n',
   'utf8'
  );

  // Fake validator is present
  await setupFakePrismaValidator(projectDir, '#!/usr/bin/env node\nprocess.exit(0);\n');

  // Disable / remove sandbox isolation
  setSandboxAvailabilityForTesting(false);

  // Capture original hashes
  const beforeHashes = hashes(await captureFiles(projectDir));

  // Run validation
  const valResult = await validatePrismaSchemaInIsolation(projectDir);

  // Assert unavailable rather than passed
  expect(valResult.status).not.toBe('passed');
  expect(valResult.status).toBe('unavailable');
  expect(valResult.reason).toBeDefined();
  expect(valResult.reason).toContain('Bubblewrap isolation is unavailable');

  // Run analysis
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);
  expect(analysis.quality.prismaValidation).toBe('unavailable');
  expect(analysis.quality.prismaValidation).not.toBe('passed');

  // Original files remain unchanged
  const afterHashes = hashes(await captureFiles(projectDir));
  expect(afterHashes).toEqual(beforeHashes);
 });

 it('reports not-applicable for projects without Prisma schemas (checklist 4)', async () => {
  const projectDir = await createProjectDir();

  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'pure-ts-project', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'src'), {recursive: true});
  await writeFile(
   join(projectDir, 'src', 'index.ts'),
   'export const hello = "world";\n',
   'utf8'
  );

  const valResult = await validatePrismaSchemaInIsolation(projectDir);
  expect(valResult.status).toBe('not-applicable');
  expect(valResult.diagnostics).toEqual([]);

  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);
  expect(analysis.quality.prismaValidation).toBe('not-applicable');
 });

 it('strictly resolves project validator and never substitutes global Prisma CLI (checklist 2)', async () => {
  const projectDir = await createProjectDir();

  // Without project node_modules/.bin/prisma, resolveProjectPrismaValidator returns null
  const resolved = await resolveProjectPrismaValidator(projectDir);
  expect(resolved).toBeNull();

  // Even if a global validator might exist on system PATH, resolveProjectPrismaValidator rejects it
  const projectBin = await setupFakePrismaValidator(projectDir, '#!/usr/bin/env node\nprocess.exit(0);\n');
  const found = await resolveProjectPrismaValidator(projectDir);
  expect(found).toBe(projectBin);
 });

 it('preserves export/import without crashing when isolation is unavailable (R23 & checklist 4)', async () => {
  const projectDir = await createProjectDir();
  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'export-import-preserve', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  await writeFile(
   join(projectDir, 'prisma', 'schema.prisma'),
   'model Preserved {\n  id Int @id\n}\n',
   'utf8'
  );

  setSandboxAvailabilityForTesting(false);

  // Calling analyze with unavailable isolation does not throw; it completes and sets prismaValidation to unavailable
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze(projectDir);
  expect(analysis.quality.prismaValidation).toBe('unavailable');
  expect(analysis.graph.nodes.some(n => n.name === 'Preserved')).toBe(true);
 });

 it('protects original project files when isolated validator modifies schema or writes artifacts (AC 1)', async () => {
  const projectDir = await createProjectDir();
  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'mutation-isolation-test', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  const originalSchema = 'model Protected {\n  id Int @id\n}\n';
  await writeFile(join(projectDir, 'prisma', 'schema.prisma'), originalSchema, 'utf8');

  // Aggressive validator that overwrites the schema file and creates subdirectories in its working directory
  const maliciousValidator = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// Attempt to overwrite schema in cwd
fs.writeFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'CORRUPTED');
// Attempt to create client dir in cwd
fs.mkdirSync(path.resolve(process.cwd(), 'generated-client'), {recursive: true});
fs.writeFileSync(path.resolve(process.cwd(), 'generated-client/index.js'), '// generated');
console.log('Mutations applied in workspace');
process.exit(0);
`;
  await setupFakePrismaValidator(projectDir, maliciousValidator);

  const beforeHashes = hashes(await captureFiles(projectDir));

  const valResult = await validatePrismaSchemaInIsolation(projectDir);
  expect(valResult.status).toBe('passed');

  // Verify original project files were NOT affected by workspace writes
  const afterCaptured = await captureFiles(projectDir);
  const afterHashes = hashes(afterCaptured);
  expect(afterHashes).toEqual(beforeHashes);
  expect(afterCaptured['prisma/schema.prisma'].toString()).toBe(originalSchema);

  let generatedExists = false;
  try {
   await readFile(join(projectDir, 'generated-client', 'index.js'));
   generatedExists = true;
  } catch {}
  expect(generatedExists).toBe(false);
 });

 it('validates multiple schemas and reports failure if any schema is invalid', async () => {
  const projectDir = await createProjectDir();
  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'multi-schema-test', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  await writeFile(
   join(projectDir, 'prisma', 'schema.prisma'),
   'model FirstValid {\n  id Int @id\n}\n',
   'utf8'
  );
  await mkdir(join(projectDir, 'extra'), {recursive: true});
  await writeFile(
   join(projectDir, 'extra', 'second.prisma'),
   'model SecondInvalid {\n  id Int @id\n}\n',
   'utf8'
  );

  // Validator fails only on second.prisma
  const multiValidator = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schemaIdx = args.indexOf('--schema');
const schemaPath = schemaIdx !== -1 ? args[schemaIdx + 1] : '';
if (schemaPath.includes('second.prisma')) {
  console.error('Validation error in second.prisma: schema invalid');
  process.exit(1);
}
console.log('Schema ' + schemaPath + ' is valid');
process.exit(0);
`;
  await setupFakePrismaValidator(projectDir, multiValidator);

  const valResult = await validatePrismaSchemaInIsolation(projectDir, {
   schemaPaths: ['prisma/schema.prisma', 'extra/second.prisma'],
  });

  expect(valResult.status).toBe('failed');
  expect(valResult.exitCode).toBe(1);
  expect(valResult.output).toContain('Validation error in second.prisma');
  expect(valResult.diagnostics.some(d => d.message.includes('second.prisma'))).toBe(true);
 });

 it('handles validator execution failure or crash gracefully', async () => {
  const projectDir = await createProjectDir();
  await writeFile(
   join(projectDir, 'package.json'),
   JSON.stringify({name: 'crash-validator-test', version: '1.0.0'}),
   'utf8'
  );
  await mkdir(join(projectDir, 'prisma'), {recursive: true});
  await writeFile(
   join(projectDir, 'prisma', 'schema.prisma'),
   'model Test {\n  id Int @id\n}\n',
   'utf8'
  );

  // Validator that exits with signal or throw
  await setupFakePrismaValidator(projectDir, '#!/usr/bin/env node\nthrow new Error("Prisma CLI crashed unexpectedly");\n');

  const valResult = await validatePrismaSchemaInIsolation(projectDir);
  expect(valResult.status).toBe('failed');
  expect(valResult.output).toContain('Prisma CLI crashed unexpectedly');
  expect(valResult.diagnostics[0].severity).toBe('error');
  expect(valResult.diagnostics[0].code).toBe('prisma-validation');
 });
});
