import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { SourceViewer } from '../../src/components/SourceViewer';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import { Analyzer } from '../../server/analyzer';
import { hash } from '../../server/files';
import * as api from '../../src/api';
import {
  emptyGraph,
  type Project,
  type Graph,
  type Analysis,
  type ProgramNode,
} from '../../shared/model';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createMockAnalysis(params: {
  revision: string;
  files: Record<string, { hash: string; text: string }>;
  status?: 'current' | 'stale' | 'updating' | 'partial';
  stalePaths?: string[];
  staleReason?: string;
}): Analysis {
  const isStale = params.status === 'stale' || (params.stalePaths && params.stalePaths.length > 0);
  return {
    revision: params.revision,
    sequence: 1,
    analyzedAt: new Date().toISOString(),
    durationMs: 12,
    status: params.status || (isStale ? 'stale' : 'current'),
    graph: emptyGraph(),
    files: params.files,
    quality: {
      eligibleFiles: Object.keys(params.files).length,
      analyzedFiles: Object.keys(params.files).length,
      unresolvedReferences: 0,
      unsupportedConstructs: 0,
      inferredItems: 0,
      prismaValidation: 'not-applicable',
      diagnostics: [],
    },
    ...(isStale
      ? {
          staleEvidence: {
            scope: params.stalePaths ? 'paths' : 'all',
            paths: params.stalePaths || ['all'],
            reason: params.staleReason || 'Files changed on disk',
          },
        }
      : {}),
  };
}

describe('T025: Show exact source bindings and evidence', () => {
  describe('Acceptance Criterion 1: Range highlights match captured source and metadata is exposed', () => {
    it('retrieves captured content by binding and highlights the exact range', () => {
      const fileText =
        'import { config } from "./config";\n\nexport function processPayment(amount: number): boolean {\n  return amount > 0;\n}\n\nexport function refund() {}\n';
      const fileHash = hash(fileText);
      const start = fileText.indexOf('export function processPayment');
      const end = fileText.indexOf('\n\nexport function refund()');
      const expectedSlice = fileText.slice(start, end);

      const node: ProgramNode = {
        id: 'fn-pay',
        kind: 'function',
        name: 'processPayment',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: 'Handles payment processing',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/payment.ts',
        source: {
          path: 'src/payment.ts',
          symbol: 'processPayment',
          line: 3,
          start,
          end,
          hash: fileHash,
          revision: 'rev-001',
        },
        fields: [],
      };

      const graph: Graph = {
        schemaVersion: 1,
        nodes: [node],
        edges: [],
        requirements: [],
      };

      const analysis = createMockAnalysis({
        revision: 'rev-001',
        files: {
          'src/payment.ts': { hash: fileHash, text: fileText },
        },
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={graph}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-pay',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Bound view container
      expect(html).toContain('data-testid="source-bound-view"');

      // Range highlight matches captured source slice
      expect(html).toContain('data-testid="source-range-highlight"');
      expect(html).toContain(expectedSlice.replace(/>/g, '&gt;'));
      expect(html).toContain('data-testid="source-range-text"');
      expect(html).toContain('return amount &gt; 0;');

      // Exposes path, line, symbol, hash, revision, provenance, policy
      expect(html).toContain('src/payment.ts');
      expect(html).toMatch(/line (<!-- -->)?3/);
      expect(html).toContain('processPayment');
      expect(html).toContain(fileHash.slice(0, 10));
      expect(html).toContain('rev-001');
      expect(html).toContain('provenance-extracted');
      expect(html).toContain('editable');
      expect(html).toMatch(new RegExp(`bytes (<!-- -->)?${start}(<!-- -->)? – (<!-- -->)?${end}`));

      // Status badge is current
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).toContain('current');
    });

    it('exposes AI provenance and displays the non-compiler disclaimer', () => {
      const fileText = 'export class RecommendationEngine {}\n';
      const fileHash = hash(fileText);

      const node: ProgramNode = {
        id: 'cls-rec',
        kind: 'class',
        name: 'RecommendationEngine',
        provenance: 'ai',
        policy: 'editable',
        contract: '',
        description: 'AI-inferred recommendation engine component',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/recommend.ts',
        source: {
          path: 'src/recommend.ts',
          symbol: 'RecommendationEngine',
          line: 1,
          start: 0,
          end: fileText.trimEnd().length,
          hash: fileHash,
          revision: 'rev-ai-01',
        },
        fields: [],
      };

      const analysis = createMockAnalysis({
        revision: 'rev-ai-01',
        files: {
          'src/recommend.ts': { hash: fileHash, text: fileText },
        },
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [node], edges: [], requirements: [] }}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'cls-rec',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      expect(html).toContain('data-testid="source-provenance-badge"');
      expect(html).toContain('ai');
      expect(html).toContain('data-testid="ai-notice-banner"');
      expect(html).toContain('AI-inferred interpretation: not compiler-verified evidence');
    });
  });

  describe('Acceptance Criterion 2: Stale evidence is clearly labeled', () => {
    it('clearly labels stale evidence when file is listed in analysis staleEvidence', () => {
      const fileText = 'export function calculateDiscount(price: number): number { return price * 0.9; }\n';
      const fileHash = hash(fileText);

      const node: ProgramNode = {
        id: 'fn-disc',
        kind: 'function',
        name: 'calculateDiscount',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/discount.ts',
        source: {
          path: 'src/discount.ts',
          symbol: 'calculateDiscount',
          line: 1,
          start: 0,
          end: fileText.trimEnd().length,
          hash: fileHash,
          revision: 'rev-001',
        },
        fields: [],
      };

      const analysis = createMockAnalysis({
        revision: 'rev-001',
        files: {
          'src/discount.ts': { hash: fileHash, text: fileText },
        },
        status: 'stale',
        stalePaths: ['src/discount.ts'],
        staleReason: 'src/discount.ts modified by external editor',
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [node], edges: [], requirements: [] }}
          analysisState={{ analysis, status: 'stale', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-disc',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Stale badge and banner are clearly labeled
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).toContain('stale');
      expect(html).toContain('data-testid="source-stale-banner"');
      expect(html).toContain('Stale Evidence');
      expect(html).toContain('src/discount.ts modified by external editor');

      // Highlight carries stale styling
      expect(html).toContain('stale-highlight');
    });

    it('labels evidence stale when finding revision has been superseded by newer analysis revision', () => {
      const fileTextOld = 'export function validateEmail(email: string) { return true; }\n';
      const fileTextNew = 'export function validateEmail(email: string) { return email.includes("@"); }\n';
      const hashOld = hash(fileTextOld);
      const hashNew = hash(fileTextNew);

      // Finding still carries rev-001 evidence
      const node: ProgramNode = {
        id: 'fn-email',
        kind: 'function',
        name: 'validateEmail',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/validation.ts',
        source: {
          path: 'src/validation.ts',
          symbol: 'validateEmail',
          line: 1,
          start: 0,
          end: fileTextOld.trimEnd().length,
          hash: hashOld,
          revision: 'rev-001',
        },
        fields: [],
      };

      // Current analysis has advanced to rev-002 with hashNew
      const analysis = createMockAnalysis({
        revision: 'rev-002',
        files: {
          'src/validation.ts': { hash: hashNew, text: fileTextNew },
        },
        status: 'current',
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [node], edges: [], requirements: [] }}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-email',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Stale/unavailable status is clearly reported, never claiming to be current
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).not.toContain('<span class="status-badge status-current"');
      expect(html).toContain('Captured source revision is unavailable: rev-001');
      expect(html).toContain('data-testid="source-missing-banner"');
    });

    it('prevents state leakage and spurious stale warnings when switching node selection', () => {
      const fileTextA = 'export function funcA() { return "A"; }\n';
      const hashA = hash(fileTextA);
      const fileTextB = 'export function funcB() { return "B"; }\n';
      const hashB = hash(fileTextB);

      const nodeA: ProgramNode = {
        id: 'node-A',
        kind: 'function',
        name: 'funcA',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/a.ts',
        source: {
          path: 'src/a.ts',
          symbol: 'funcA',
          line: 1,
          start: 0,
          end: fileTextA.length,
          hash: hashA,
          revision: 'rev-001',
        },
        fields: [],
      };

      const nodeB: ProgramNode = {
        id: 'node-B',
        kind: 'function',
        name: 'funcB',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: '',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/b.ts',
        source: {
          path: 'src/b.ts',
          symbol: 'funcB',
          line: 1,
          start: 0,
          end: fileTextB.length,
          hash: hashB,
          revision: 'rev-001',
        },
        fields: [],
      };

      const graph: Graph = {
        schemaVersion: 1,
        nodes: [nodeA, nodeB],
        edges: [],
        requirements: [],
      };

      const analysis = createMockAnalysis({
        revision: 'rev-001',
        files: {
          'src/a.ts': { hash: hashA, text: fileTextA },
          'src/b.ts': { hash: hashB, text: fileTextB },
        },
        status: 'current',
      });

      const project: Project = {
        id: 'proj-switching',
        name: 'Switching Project',
        description: '',
        target: 'TypeScript application',
        root: '/workspace/test',
        managed: true,
        createdAt: new Date().toISOString(),
        specRevision: 1,
        specification: graph,
        layout: {},
        checks: {},
      };

      // Render node A
      const htmlA = renderToString(
        <SourceViewer
          project={project}
          graph={graph}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'node-A',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          apiBaseUrl="/api"
        />
      );
      expect(htmlA).toContain('src/a.ts');
      expect(htmlA).toContain('current');

      // Now render node B. Node B must cleanly evaluate node B's own file evidence and not compare hashB against hashA
      const htmlB = renderToString(
        <SourceViewer
          project={project}
          graph={graph}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'node-B',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
          apiBaseUrl="/api"
        />
      );
      expect(htmlB).toContain('src/b.ts');
      expect(htmlB).not.toContain('stale');
      expect(htmlB).toContain('current');
      expect(htmlB).not.toContain('Live file on disk modified since extraction');
    });
  });

  describe('Acceptance Criterion 3: The viewer obeys root-boundary file access', () => {
    it('serves files within project root and strictly rejects directory traversal, escapes, and symlinks', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-source-root-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const projectRoot = join(dir, 'app-repo');
        await mkdir(projectRoot, { recursive: true });
        await writeFile(join(projectRoot, 'index.ts'), 'export const appVersion = "1.0.0";');
        await mkdir(join(projectRoot, 'src'));
        await writeFile(join(projectRoot, 'src', 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }');

        // Create a secret file outside the root
        const outsideDir = join(dir, 'outside-secret');
        await mkdir(outsideDir, { recursive: true });
        await writeFile(join(outsideDir, 'secret.env'), 'SECRET_API_KEY=super-secret');

        // Create symlink pointing outside
        try {
          await symlink(join(outsideDir, 'secret.env'), join(projectRoot, 'escaped-link.ts'));
        } catch {
          // ignore if symlinks restricted
        }

        const project = await store.create({
          name: 'Root Boundary Test Project',
          root: projectRoot,
        });

        // 1. Valid file access inside root (query param)
        const validRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=src/calc.ts`,
        });
        expect(validRes.statusCode).toBe(200);
        const validData = validRes.json<{ path: string; text: string; hash: string }>();
        expect(validData.path).toBe('src/calc.ts');
        expect(validData.text).toContain('export function add');
        expect(validData.hash).toBe(hash('export function add(a: number, b: number) { return a + b; }'));

        // 2. Valid file access via wildcard path
        const wildcardRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files/index.ts`,
        });
        expect(wildcardRes.statusCode).toBe(200);
        expect(wildcardRes.json<{ text: string }>().text).toContain('appVersion');

        // 3. /source route alias
        const sourceRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/source?path=index.ts`,
        });
        expect(sourceRes.statusCode).toBe(200);

        // 4. Directory traversal: ../ escape
        const traversalRes1 = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=../outside-secret/secret.env`,
        });
        expect(traversalRes1.statusCode).toBe(400);
        expect(traversalRes1.json<{ error: string }>().error).toBe('Bad Request');

        // 5. Deep traversal: src/../../ outside
        const traversalRes2 = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=src/../../outside-secret/secret.env`,
        });
        expect(traversalRes2.statusCode).toBe(400);

        // 6. Absolute path escape
        const absoluteRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=/etc/passwd`,
        });
        expect(absoluteRes.statusCode).toBe(400);

        // 7. Null byte injection
        const nullByteRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=src%00calc.ts`,
        });
        expect(nullByteRes.statusCode).toBe(400);

        // 8. Escaping symlink
        const symlinkRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=escaped-link.ts`,
        });
        expect(symlinkRes.statusCode).toBe(400);

        // 9. Nonexistent file inside root returns 404
        const missingRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=src/not-found.ts`,
        });
        expect(missingRes.statusCode).toBe(404);

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('strictly denies access to excluded, ignored, and sensitive files inside project root (403 Forbidden)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-source-security-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const projectRoot = join(dir, 'secure-repo');
        await mkdir(projectRoot, { recursive: true });
        await writeFile(join(projectRoot, 'valid.ts'), 'export const valid = true;');

        // Create sensitive/credential/excluded files in root and subdirectories
        const sensitiveFiles = [
          '.env',
          '.env.local',
          '.env.production',
          'config/.env',
          'credentials.json',
          'auth.json',
          'sub/credentials.json',
          'secret.pem',
          'server.key',
          '.codex/token.txt',
          '.claude/settings.json',
          '.ssh/id_rsa',
          '.aws/credentials',
          '.npmrc',
          '.pypirc',
          '.git/config',
          'node_modules/dummy/index.js',
          'dist/bundle.js',
          'build/bundle.js',
          'coverage/lcov.info',
          '.next/server.js',
          '_architect/task.md',
        ];

        for (const rel of sensitiveFiles) {
          const full = join(projectRoot, rel);
          await mkdir(join(full, '..'), { recursive: true });
          await writeFile(full, 'SECRET_KEY_CONTENTS=classified');
        }

        const project = await store.create({
          name: 'Security Test Project',
          root: projectRoot,
        });

        // 1. Verify valid file inside root is allowed (200)
        const validRes = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=valid.ts`,
        });
        expect(validRes.statusCode).toBe(200);
        expect(validRes.json<{ text: string }>().text).toContain('valid = true');

        // 2. Verify all sensitive/excluded files are strictly rejected with 403 Forbidden
        for (const rel of sensitiveFiles) {
          // Via query parameter
          const resQuery = await app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/files?path=${encodeURIComponent(rel)}`,
          });
          expect(resQuery.statusCode).toBe(403);
          expect(resQuery.json<{ error: string }>().error).toBe('Forbidden');
          expect(resQuery.json<{ message: string }>().message).toContain('Access to excluded or sensitive file is not permitted');
          expect(resQuery.body).not.toContain('SECRET_KEY_CONTENTS');

          // Via wildcard route
          const resWildcard = await app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/files/${rel}`,
          });
          expect(resWildcard.statusCode).toBe(403);
          expect(resWildcard.json<{ error: string }>().error).toBe('Forbidden');
          expect(resWildcard.body).not.toContain('SECRET_KEY_CONTENTS');

          // Via /source endpoint
          const resSource = await app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/source?path=${encodeURIComponent(rel)}`,
          });
          expect(resSource.statusCode).toBe(403);
          expect(resSource.json<{ error: string }>().error).toBe('Forbidden');
          expect(resSource.body).not.toContain('SECRET_KEY_CONTENTS');
        }

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects file reads exceeding the 20 MB size limit with 400 Bad Request', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'architect-source-size-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const projectRoot = join(dir, 'size-repo');
        await mkdir(projectRoot, { recursive: true });

        const project = await store.create({
          name: 'Size Limit Test Project',
          root: projectRoot,
        });

        // Create a sparse file of 21 MB after project creation (exceeds 20 MB limit)
        const bigFilePath = join(projectRoot, 'large-file.dat');
        await writeFile(bigFilePath, '');
        await truncate(bigFilePath, 21 * 1024 * 1024);

        const res = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=large-file.dat`,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('Bad Request');
        expect(res.json<{ message: string }>().message).toContain('File exceeds 20 MB');

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Validation Scenario 1: Edit a file after extraction and inspect the older finding', () => {
    it('surfaces stale/modified status instead of highlighting unrelated current content', async () => {
      const originalText = 'export function calculateInterest(principal: number, rate: number): number {\n  return principal * rate;\n}\n';
      const originalHash = hash(originalText);
      const originalStart = originalText.indexOf('export function calculateInterest');
      const originalEnd = originalText.indexOf('}\n') + 2;

      // Old finding extracted from originalText
      const olderFinding: ProgramNode = {
        id: 'fn-interest',
        kind: 'function',
        name: 'calculateInterest',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: 'Interest calculation',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/finance.ts',
        source: {
          path: 'src/finance.ts',
          symbol: 'calculateInterest',
          line: 1,
          start: originalStart,
          end: originalEnd,
          hash: originalHash,
          revision: 'rev-001',
        },
        fields: [],
      };

      // Now the file was edited on disk: additional comments and lines inserted before the function
      const editedText = '// Copyright 2026\n// Added preamble comments and header\n// Configuration\n\nexport function calculateInterest(principal: number, rate: number, years = 1): number {\n  return principal * Math.pow(1 + rate, years);\n}\n';
      const editedHash = hash(editedText);

      // Situation A: Analysis has the edited file with updated hash, but finding is from older extraction
      const analysisAfterEdit = createMockAnalysis({
        revision: 'rev-001',
        files: {
          'src/finance.ts': { hash: editedHash, text: editedText },
        },
        status: 'stale',
        stalePaths: ['src/finance.ts'],
        staleReason: 'File src/finance.ts modified on disk after analysis',
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [olderFinding], edges: [], requirements: [] }}
          analysisState={{ analysis: analysisAfterEdit, status: 'stale', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-interest',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Finding is clearly identified as invalid / hash mismatch
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).toContain('invalid');
      expect(html).toContain('data-testid="source-invalid-banner"');
      expect(html).toContain('Source content hash does not match the captured file');

      // The viewer does NOT slice the edited file at [originalStart, originalEnd],
      // which would have sliced unrelated preamble comments!
      expect(html).toContain('Content highlight withheld: source file modified or unavailable');
      expect(html).not.toContain('<mark class="source-range-highlight">// Copyright 2026</mark>');

      // Situation B: Finding retained its captured baseline text
      const frozenOlderFinding: ProgramNode = {
        ...olderFinding,
        policy: 'frozen-implementation',
        baseline: {
          text: originalText,
          source: olderFinding.source,
        },
      };

      const htmlFrozen = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [frozenOlderFinding], edges: [], requirements: [] }}
          analysisState={{ analysis: analysisAfterEdit, status: 'stale', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-interest',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Shows preserved baseline text from rev-001
      expect(htmlFrozen).toContain('source-baseline-highlight');
      expect(htmlFrozen).toContain('return principal * rate;');
      expect(htmlFrozen).toContain('data-testid="source-invalid-banner"');
    });
  });

  describe('Concrete Validation Scenario 2: Open a removed file binding and a file with Unicode characters', () => {
    it('handles a removed file binding cleanly without errors', () => {
      const removedFinding: ProgramNode = {
        id: 'fn-removed',
        kind: 'function',
        name: 'legacyCleanUp',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: 'Old cleanup routine',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/legacy.ts',
        source: {
          path: 'src/legacy.ts',
          symbol: 'legacyCleanUp',
          line: 5,
          start: 80,
          end: 140,
          hash: 'sha256-old-deleted-file-hash',
          revision: 'rev-001',
        },
        fields: [],
      };

      // Analysis exists, but src/legacy.ts is absent (deleted/removed)
      const analysis = createMockAnalysis({
        revision: 'rev-001',
        files: {
          'src/other.ts': { hash: 'sha256-other', text: 'export const x = 1;\n' },
        },
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [removedFinding], edges: [], requirements: [] }}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-removed',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Missing banner and status badge
      expect(html).toContain('data-testid="source-missing-banner"');
      expect(html).toContain('Captured source file is unavailable: src/legacy.ts');
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).toContain('unavailable');

      // Exposes binding metadata nonetheless
      expect(html).toContain('src/legacy.ts');
      expect(html).toMatch(/line (<!-- -->)?5/);
      expect(html).toContain('sha256-old-deleted-file-hash'.slice(0, 10));
      expect(html).toContain('rev-001');

      // Withholds highlight to avoid highlighting unrelated text
      expect(html).toContain('Content highlight withheld: source file modified or unavailable');
    });

    it('accurately highlights ranges in files containing multi-byte Unicode characters', async () => {
      // File with emoji, Japanese, German umlauts, and math symbols
      const unicodeText =
        '// 🚀 Unicode Test: 日本語と絵文字 ✨\n' +
        '// Überweisung & π = 3.14159\n' +
        'export function 送信(メッセージ: string): string {\n' +
        '  return `送信完了: ${メッセージ} 🌟`;\n' +
        '}\n' +
        '\n' +
        'export const 定数 = 42;\n';

      const unicodeHash = hash(unicodeText);
      const start = unicodeText.indexOf('export function 送信');
      const end = unicodeText.indexOf('\n\nexport const 定数');
      const expectedSlice = unicodeText.slice(start, end);
      const expectedLine = unicodeText.slice(0, start).split('\n').length; // line 3

      const unicodeFinding: ProgramNode = {
        id: 'fn-unicode-send',
        kind: 'function',
        name: '送信',
        provenance: 'extracted',
        policy: 'editable',
        contract: '',
        description: 'Sends message in Japanese',
        requiredChecks: [],
        instructions: '',
        outputPath: 'src/i18n.ts',
        source: {
          path: 'src/i18n.ts',
          symbol: '送信',
          line: expectedLine,
          start,
          end,
          hash: unicodeHash,
          revision: 'rev-unicode-01',
        },
        fields: [],
      };

      const analysis = createMockAnalysis({
        revision: 'rev-unicode-01',
        files: {
          'src/i18n.ts': { hash: unicodeHash, text: unicodeText },
        },
      });

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [unicodeFinding], edges: [], requirements: [] }}
          analysisState={{ analysis, status: 'current', lastChecked: Date.now() }}
          viewState={{
            selectedId: 'fn-unicode-send',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      // Bound view renders cleanly
      expect(html).toContain('data-testid="source-bound-view"');
      expect(html).toContain('data-testid="source-status-badge"');
      expect(html).toContain('current');

      // Range highlight contains exact Unicode function
      expect(html).toContain('data-testid="source-range-highlight"');
      expect(html).toContain('export function 送信(メッセージ: string): string');
      expect(html).toContain('送信完了: ${メッセージ} 🌟');

      // Dedicated range snippet view matches expected Unicode slice
      expect(html).toContain('data-testid="source-range-text"');
      expect(html).toContain(expectedSlice);

      // Symbol and file metadata preserve Unicode symbols
      expect(html).toContain('送信');
      expect(html).toContain(`line ${expectedLine}`);

      // Verify that server file endpoint also preserves exact Unicode characters
      const dir = await mkdtemp(join(tmpdir(), 'architect-unicode-'));
      try {
        const store = new ProjectStore(dir);
        const app = await createServer({ store });

        const root = join(dir, 'repo');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'i18n.ts'), unicodeText, 'utf8');

        const project = await store.create({ name: 'Unicode Project', root });

        const res = await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/files?path=i18n.ts`,
        });
        expect(res.statusCode).toBe(200);
        const data = res.json<{ text: string; hash: string }>();
        expect(data.text).toBe(unicodeText);
        expect(data.hash).toBe(unicodeHash);
        expect(data.text).toContain('日本語と絵文字 ✨');

        await app.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Unbound and Overview States', () => {
    it('displays unbound view for intended element without source', () => {
      const node: ProgramNode = {
        id: 'mod-spec-only',
        kind: 'module',
        name: 'UnimplementedModule',
        provenance: 'human',
        policy: 'editable',
        contract: '',
        description: 'Planned module',
        requiredChecks: [],
        instructions: '',
        outputPath: '',
        fields: [],
      };

      const html = renderToString(
        <SourceViewer
          project={null}
          graph={{ schemaVersion: 1, nodes: [node], edges: [], requirements: [] }}
          analysisState={{ analysis: null, status: 'current', lastChecked: null }}
          viewState={{
            selectedId: 'mod-spec-only',
            selectedType: 'node',
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      expect(html).toContain('data-testid="source-unbound-view"');
      expect(html).toContain('No Source Binding');
      expect(html).toContain('UnimplementedModule');
      expect(html).toContain('intended architecture specification');
    });

    it('displays project source overview when no node is selected', () => {
      const html = renderToString(
        <SourceViewer
          project={{
            id: 'proj-1',
            name: 'Sample Project',
            description: '',
            target: 'TypeScript application',
            root: '/workspace/sample',
            managed: true,
            createdAt: new Date().toISOString(),
            specRevision: 1,
            specification: emptyGraph(),
            layout: {},
            checks: {},
          }}
          graph={emptyGraph()}
          analysisState={{
            analysis: createMockAnalysis({
              revision: 'rev-001',
              files: {
                'src/index.ts': { hash: 'h1', text: 'export const a = 1;' },
              },
            }),
            status: 'current',
            lastChecked: Date.now(),
          }}
          viewState={{
            selectedId: null,
            selectedType: null,
            activeScope: null,
            searchQuery: '',
            panels: { tree: true, canvas: true, inspector: true, source: true, review: true },
          }}
        />
      );

      expect(html).toContain('data-testid="source-overview"');
      expect(html).toContain('Project Source Status');
      expect(html).toContain('/workspace/sample');
      expect(html).toContain('Eligible files:');
    });
  });
});
