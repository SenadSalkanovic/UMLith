import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  calculatePercentiles,
  getSystemEnvironment,
  measureProjectSize,
  runProjectBenchmark,
  formatBenchmarkReportMarkdown,
  formatBenchmarkReportConsole,
  type FullBenchmarkResult,
} from '../scripts/benchmark';
import { AnalysisWorker } from '../server/worker';

describe('T064: Benchmark warm synchronization latency on representative projects', () => {
  describe('Statistical & Percentile Calculations (Work checklist & AC 1)', () => {
    it('handles empty input gracefully without dividing by zero', () => {
      const stats = calculatePercentiles([]);
      expect(stats.count).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.p95).toBe(0);
      expect(stats.achieved).toBe(false);
    });

    it('calculates exact percentiles and standard deviation for known distributions', () => {
      // 10 sample latencies (in milliseconds)
      const latencies = [450, 460, 465, 470, 475, 480, 485, 490, 500, 520];
      const stats = calculatePercentiles(latencies, 1000);

      expect(stats.count).toBe(10);
      expect(stats.min).toBe(450);
      expect(stats.max).toBe(520);
      expect(stats.mean).toBe(479.5);
      expect(stats.median).toBe(477.5);
      expect(stats.p90).toBe(502);
      expect(stats.p95).toBe(511);
      expect(stats.stdDev).toBeGreaterThan(0);
      expect(stats.achieved).toBe(true);
      expect(stats.marginMs).toBe(1000 - stats.p95);
    });

    it('correctly marks target missed when p95 exceeds 1000 ms threshold', () => {
      const slowLatencies = [800, 900, 950, 1050, 1100, 1200];
      const stats = calculatePercentiles(slowLatencies, 1000);
      expect(stats.achieved).toBe(false);
      expect(stats.marginMs).toBeLessThan(0);
    });
  });

  describe('Environment & Fixture Size Documentation (Work checklist)', () => {
    it('records hardware, runtime, and pinned dependency versions', () => {
      const env = getSystemEnvironment();
      expect(env.platform).toBeTruthy();
      expect(env.arch).toBeTruthy();
      expect(env.cpuModel).toBeTruthy();
      expect(env.cpuCores).toBeGreaterThan(0);
      expect(env.totalMemoryGb).toBeGreaterThan(0);
      expect(env.nodeVersion).toMatch(/^v\d+/);
      expect(env.typescriptVersion).toBe('6.0.3');
      expect(env.prismaAstVersion).toBe('0.16.0');
    });

    it('documents exact file, line, AST node, and schema counts for small and larger fixtures', async () => {
      const worker = new AnalysisWorker();
      try {
        const smallAnalysis = await worker.analyze('tests/fixtures/benchmark-small');
        const smallSize = await measureProjectSize(
          'Small Project',
          'tests/fixtures/benchmark-small',
          smallAnalysis
        );
        expect(smallSize.totalFiles).toBeGreaterThanOrEqual(4);
        expect(smallSize.eligibleFiles).toBe(3);
        expect(smallSize.astNodesCount).toBeGreaterThan(15);
        expect(smallSize.prismaModelsCount).toBe(2);
        expect(smallSize.functionsCount).toBeGreaterThan(2);

        const largeAnalysis = await worker.analyze('tests/fixtures/benchmark-large');
        const largeSize = await measureProjectSize(
          'Larger Project',
          'tests/fixtures/benchmark-large',
          largeAnalysis
        );
        expect(largeSize.totalFiles).toBeGreaterThanOrEqual(14);
        expect(largeSize.eligibleFiles).toBe(13);
        expect(largeSize.astNodesCount).toBeGreaterThan(100);
        expect(largeSize.prismaModelsCount).toBe(6);
        expect(largeSize.functionsCount).toBeGreaterThan(30);
      } finally {
        await worker.close();
      }
    });
  });

  describe('Concrete Scenario 1: Repeat ordinary edits after warm-up and report percentiles', () => {
    it('measures saved-edit to browser-visible update separately from cold import and achieves ~1s target', async () => {
      // Run 3 iterations on small fixture
      const result = await runProjectBenchmark('Small Project', 'tests/fixtures/benchmark-small', {
        iterations: 3,
        debounceMs: 300,
        stabilityThresholdMs: 150,
      });

      // Cold import is measured separately
      expect(result.coldImportLatencyMs).toBeGreaterThan(50);
      expect(result.coldImportWorkerDurationMs).toBeGreaterThan(0);
      expect(result.coldImportQuality.eligibleFiles).toBe(3);

      // Warm edit stats
      expect(result.warmEditStats.count).toBe(3);
      expect(result.warmEditStats.median).toBeLessThan(1000);
      expect(result.warmEditStats.p95).toBeLessThan(1000);
      expect(result.warmEditStats.achieved).toBe(true);

      // Invariants on every iteration
      for (const iter of result.iterations) {
        expect(iter.endToEndLatencyMs).toBeGreaterThan(0);
        expect(iter.endToEndLatencyMs).toBeLessThan(1000);
        expect(iter.browserVisibleTimestamp).toBeGreaterThan(iter.saveTimestamp);
        expect(iter.verified).toBe(true);
        expect(iter.sequence).toBeGreaterThan(1);
      }
    });
  });

  describe('Concrete Scenario 2 & AC 2: Larger-project update and verify progress stays visible', () => {
    it('keeps larger analyses visibly updating with previous model retained throughout', async () => {
      const result = await runProjectBenchmark('Larger Project', 'tests/fixtures/benchmark-large', {
        iterations: 2,
        debounceMs: 300,
        stabilityThresholdMs: 150,
      });

      // Verify larger work remains visibly updating
      expect(result.largerUpdateVisibleProgress).toBeDefined();
      expect(result.largerUpdateVisibleProgress?.observedUpdatingStatus).toBe(true);
      expect(result.largerUpdateVisibleProgress?.snapshotRetainedDuringUpdating).toBe(true);
      expect(result.largerUpdateVisibleProgress?.completedStatus).toBeTruthy();

      // Verify latency was within target
      expect(result.warmEditStats.achieved).toBe(true);
      expect(result.warmEditStats.p95).toBeLessThan(1000);
    });
  });

  describe('Acceptance Criterion 1 & 3: Evidence documentation and repeatability', () => {
    it('verifies benchmark documentation contains empirical results, percentiles, and repeatable commands', async () => {
      const docPath = resolve('docs/benchmarks/synchronization.md');
      const docContent = await readFile(docPath, 'utf8');

      // The 1-second goal is never stated as measured without results
      expect(docContent).toContain('Empirical evidence documented from reproducible runs');
      expect(docContent).toContain('Cold Import vs. Warm Incremental Separation');
      expect(docContent).toContain('Hardware and Runtime Environment');
      expect(docContent).toContain('Representative Projects and Fixture Sizes');
      expect(docContent).toContain('Median (p50)');
      expect(docContent).toContain('p95');
      expect(docContent).toContain('Larger Work Remains Visibly Updating');
      expect(docContent).toContain('npm run benchmark');
      expect(docContent).toContain('npm test -- tests/benchmark.test.ts');
    });

    it('formats console and markdown summaries reproducibly from structured results', () => {
      const mockResult: FullBenchmarkResult = {
        environment: getSystemEnvironment(),
        debounceMs: 300,
        stabilityThresholdMs: 150,
        smallProject: {
          name: 'Small Project',
          size: {
            name: 'Small Project',
            fixturePath: 'tests/fixtures/benchmark-small',
            totalFiles: 5,
            eligibleFiles: 3,
            analyzedFiles: 3,
            totalLinesOfCode: 53,
            astNodesCount: 22,
            prismaModelsCount: 2,
            functionsCount: 4,
            interfacesCount: 1,
            entitiesCount: 2,
          },
          coldImportLatencyMs: 200,
          coldImportWorkerDurationMs: 180,
          coldImportQuality: { eligibleFiles: 3, analyzedFiles: 3, diagnostics: 0 },
          warmEditStats: calculatePercentiles([465, 467, 469]),
          workerDurationStats: calculatePercentiles([10, 11, 12]),
          iterations: [],
        },
        largerProject: {
          name: 'Larger Project',
          size: {
            name: 'Larger Project',
            fixturePath: 'tests/fixtures/benchmark-large',
            totalFiles: 15,
            eligibleFiles: 13,
            analyzedFiles: 13,
            totalLinesOfCode: 272,
            astNodesCount: 124,
            prismaModelsCount: 6,
            functionsCount: 46,
            interfacesCount: 7,
            entitiesCount: 6,
          },
          coldImportLatencyMs: 240,
          coldImportWorkerDurationMs: 220,
          coldImportQuality: { eligibleFiles: 13, analyzedFiles: 13, diagnostics: 0 },
          warmEditStats: calculatePercentiles([485, 488, 492]),
          workerDurationStats: calculatePercentiles([20, 22, 25]),
          iterations: [],
          largerUpdateVisibleProgress: {
            observedUpdatingStatus: true,
            snapshotRetainedDuringUpdating: true,
            completedStatus: 'current',
            durationMs: 490,
          },
        },
        overallAchieved: true,
        generatedAt: '2026-10-11T03:00:00.000Z',
      };

      const md = formatBenchmarkReportMarkdown(mockResult);
      expect(md).toContain('# Live Synchronization Benchmark Report');
      expect(md).toContain('Small Project');
      expect(md).toContain('Larger Project');
      expect(md).toContain('ACHIEVED');

      const consoleText = formatBenchmarkReportConsole(mockResult);
      expect(consoleText).toContain('SYNCHRONIZATION BENCHMARK SUMMARY');
      expect(consoleText).toContain('Small Project');
      expect(consoleText).toContain('Larger Project');
    });
  });
});
