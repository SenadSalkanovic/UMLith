import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ReviewPanel, type ArchitectureProposalReview } from '../../src/components/ReviewPanel';
import { computeSpecificationDiff } from '../../server/proposals';
import { GraphSchema, emptyGraph, type Project } from '../../shared/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../server/main';
import { ProjectStore } from '../../server/store';
import { getProposals, acceptProposal, rejectProposal, ApiConnectionError } from '../../src/api';

describe('T067: Human proposal review presentation', () => {
  const graph = GraphSchema.parse({ ...emptyGraph(), nodes: [{ id: 'module', name: 'Original module', kind: 'module' }],
    requirements: [{ id: 'req', text: 'Original requirement', nodeIds: ['module'] }] });
  const proposed = structuredClone(graph);
  proposed.nodes[0].name = 'Proposed module';
  proposed.nodes[0].contract = 'Reviewed contract';
  proposed.requirements[0].text = 'Proposed requirement';
  const project: Project = { id: 'project', name: 'Review', description: '', target: '', root: '/test', managed: true,
    createdAt: new Date().toISOString(), specRevision: 1, specification: graph, layout: {}, checks: {} };
  const review: ArchitectureProposalReview = { id: 'proposal', kind: 'architecture', title: 'Clarify intent', specRevision: 1,
    proposal: { graph: proposed, explanation: 'Explain the proposal', questions: [] },
    specificationDiff: computeSpecificationDiff(graph, proposed) };

  it('shows the proposed graph and complete semantic diff without accepting on render', () => {
    const accept = vi.fn();
    const html = renderToString(<ReviewPanel project={project} graph={graph}
      analysisState={{ analysis: null, status: 'current', lastChecked: null }} pendingReviews={[review]}
      activeReviewId={review.id} onAccept={accept} />);
    expect(html).toContain('data-testid="proposal-graph"');
    expect(html).toContain('data-testid="proposal-semantic-diff"');
    expect(html.indexOf('data-testid="proposal-graph"')).toBeGreaterThan(html.indexOf('data-testid="review-spec-section"'));
    expect(html).toContain('Proposed module');
    expect(html).toContain('Original requirement');
    expect(html).toContain('Proposed requirement');
    expect(html).toContain('Reviewed contract');
    expect(accept).not.toHaveBeenCalled();
    expect(project.specRevision).toBe(1);
    expect(project.specification.nodes[0].name).toBe('Original module');
  });

  it('keeps stale proposals visible with acceptance disabled and rejection available', () => {
    const html = renderToString(<ReviewPanel project={{ ...project, specRevision: 2 }} graph={graph}
      analysisState={{ analysis: null, status: 'current', lastChecked: null }} pendingReviews={[review]}
      activeReviewId={review.id} />);
    expect(html).toContain('Specification revision mismatch');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="review-accept-btn"/);
    expect(html).toMatch(/<button(?:(?!<\/button>)[\s\S])*data-testid="review-reject-btn"/);
  });

  it('shows server conflict errors and disables decision buttons while a decision is pending', () => {
    const html = renderToString(<ReviewPanel project={project} graph={graph}
      analysisState={{ analysis: null, status: 'current', lastChecked: null }} pendingReviews={[review]}
      activeReviewId={review.id} actionError="Specification changed. Request a fresh proposal." isDeciding />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Specification changed. Request a fresh proposal.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="review-accept-btn"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="review-reject-btn"/);
  });

  it.each(['modified', 'deleted'] as const)('highlights unchanged sensitive instructions and checks for a %s item', action => {
    const sensitive = structuredClone(graph);
    sensitive.nodes[0].policy = 'sensitive';
    sensitive.nodes[0].instructions = 'Review public authentication behavior';
    sensitive.nodes[0].requiredChecks = ['test', 'typecheck'];
    const candidate = structuredClone(sensitive);
    if (action === 'modified') candidate.nodes[0].description = 'Clarify module purpose';
    else { candidate.nodes = []; candidate.requirements = []; }
    const item = { ...review, proposal: { ...review.proposal, graph: candidate }, specificationDiff: computeSpecificationDiff(sensitive, candidate) };
    const html = renderToString(<ReviewPanel project={{ ...project, specification: sensitive }} graph={sensitive}
      analysisState={{ analysis: null, status: 'current', lastChecked: null }} pendingReviews={[item]} activeReviewId={item.id} />);
    expect(html).toContain('data-testid="sensitive-review-callout-module"');
    expect(html).toContain('Review public authentication behavior');
    expect(html).toContain('test, typecheck');
  });

  it.each(['accept', 'reject', 'stale'] as const)('runs the browser API client through the server for %s', async decision => {
    const dir = await mkdtemp(join(tmpdir(), 'proposal-ui-client-'));
    const store = new ProjectStore(dir);
    const saved = await store.create({ name: 'Proposal client' });
    const app = await createServer({ store, syncOptions: { watch: false } });
    try {
      await store.updateSpec(saved.id, 0, graph);
      await store.saveJob({ id: 'design', projectId: saved.id, kind: 'design', status: 'review', specRevision: 1,
        task: 'Clarify intent', scope: ['.'], sourceHashes: {}, workspace: join(dir, 'candidate'),
        createdAt: new Date().toISOString(), events: [], proposal: { ...review.proposal, baseRevision: 1 } });
      // Substitute only transport; server validation, persistence and client parsing remain real.
      vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
        const res = await app.inject({ method: options.method as 'GET' | 'POST' || 'GET', url,
          headers: options.headers as Record<string, string>, payload: options.body as string | undefined });
        return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
      });
      const reviews = await getProposals(saved.id);
      expect(reviews[0].specRevision).toBe(1);
      expect(reviews[0].proposal.graph.nodes[0].name).toBe('Proposed module');
      expect((await store.get(saved.id)).specRevision).toBe(1);
      if (decision === 'accept') {
        const accepted = await acceptProposal(saved.id, 'design', reviews[0].specRevision);
        expect(accepted.specRevision).toBe(2);
        expect(accepted.specification.requirements[0].text).toBe('Proposed requirement');
        expect((await store.history(saved.id))[2].graph).toEqual(accepted.specification);
      } else if (decision === 'reject') {
        await rejectProposal(saved.id, 'design');
        expect((await store.get(saved.id)).specification).toEqual(graph);
        expect((await getProposals(saved.id))[0].status).toBe('cancelled');
      } else {
        const edited = structuredClone(graph);
        edited.nodes[0].description = 'Later human edit';
        await store.updateSpec(saved.id, 1, edited);
        await expect(acceptProposal(saved.id, 'design', reviews[0].specRevision)).rejects.toMatchObject({
          name: 'ApiConnectionError', statusCode: 409, expectedRevision: 1, currentRevision: 2,
        } satisfies Partial<ApiConnectionError>);
        const refreshed = await getProposals(saved.id);
        expect(refreshed[0].valid).toBe(false);
        expect(refreshed[0].diagnostics.some(d => d.code === 'stale-spec')).toBe(true);
        expect((await store.get(saved.id)).specification).toEqual(edited);
      }
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
