import React, { useState } from 'react';
import type { DesignProposal, SpecificationDiff, Graph } from '../../shared/model';
import type { ViewState } from '../types';
import { GraphCanvas } from './GraphCanvas';

export function ProposalReview({ proposal, diff, currentGraph }: { proposal: DesignProposal; diff: SpecificationDiff; currentGraph: Graph | null }) {
  const [viewState, setViewState] = useState<ViewState>({ selectedId: null, selectedType: null, activeScope: null,
    searchQuery: '', panels: { tree: false, canvas: true, inspector: false, source: false, review: false } });
  const sensitiveNodes = new Map([...(currentGraph?.nodes ?? []), ...proposal.graph.nodes]
    .filter(node => node.policy === 'sensitive').map(node => [node.id, node]));
  return <>
    <div className="proposal-graph-preview" data-testid="proposal-graph" aria-label="Proposed specification graph">
      <h4>Proposed specification graph</h4>
      <div style={{ height: 320 }}>
        <GraphCanvas graph={proposal.graph} layout={{}} viewState={viewState} readOnly
          onSelectNode={id => setViewState(view => ({ ...view, selectedId: id, selectedType: 'node' }))}
          onScopeChange={id => setViewState(view => ({ ...view, activeScope: id, selectedId: null, selectedType: null }))} />
      </div>
      <details><summary>Complete proposed graph</summary><pre>{JSON.stringify(proposal.graph, null, 2)}</pre></details>
    </div>
    <div className="spec-diff-container proposal-semantic-diff" data-testid="proposal-semantic-diff">
      <h4>Semantic specification changes</h4>
      {[...sensitiveNodes.values()].map(node => <div key={node.id} className="review-sensitive-callout" data-testid={`sensitive-review-callout-${node.id}`}>
        <strong>Sensitive element: {node.name}</strong>
        {node.instructions && <p>Instructions: {node.instructions}</p>}
        {node.requiredChecks.length > 0 && <p>Required checks: {node.requiredChecks.join(', ')}</p>}
      </div>)}
      <p>{diff.summary.additions} additions, {diff.summary.modifications} modifications, {diff.summary.deletions} deletions;
        {' '}{diff.summary.policyChanges} policy changes, {diff.summary.protectedItemChanges} protected and {diff.summary.sensitiveItemChanges} sensitive changes.</p>
      {[...diff.nodes, ...diff.edges, ...diff.requirements].map((entry, index) => <div className={`diff-group diff-${entry.action}`} key={index}>
        <h4>{entry.explanation}</h4>
        <table><thead><tr><th>Property</th><th>Before</th><th>Proposed</th></tr></thead>
          <tbody>{entry.changes.map(change => <tr key={change.property}>
            <th scope="row">{change.property}</th><td><pre>{change.before ?? 'Absent'}</pre></td><td><pre>{change.after ?? 'Absent'}</pre></td>
          </tr>)}</tbody>
        </table>
      </div>)}
      {diff.summary.totalChanges === 0 && <p>No semantic specification changes.</p>}
    </div>
  </>;
}
