import React from 'react';
import type { Graph, ProgramNode, ProgramEdge, Project } from '../../shared/model';
import type { ViewState } from '../types';
import { Sliders, Shield, Tag, FileText, CheckCircle2, AlertCircle, Info } from 'lucide-react';

interface PropertyInspectorProps {
  project: Project | null;
  graph: Graph | null;
  viewState: ViewState;
  onClearSelection: () => void;
}

export const PropertyInspector: React.FC<PropertyInspectorProps> = ({
  project,
  graph,
  viewState,
  onClearSelection,
}) => {
  const selectedNode = viewState.selectedId
    ? graph?.nodes.find(n => n.id === viewState.selectedId) || null
    : null;

  const selectedEdge = viewState.selectedId
    ? graph?.edges.find(e => e.id === viewState.selectedId) || null
    : null;

  return (
    <aside
      className="panel property-inspector-panel"
      data-testid="property-inspector-panel"
      aria-label="Property Inspector"
    >
      <div className="panel-header">
        <div className="panel-title">
          <Sliders size={16} />
          <span>Property Inspector</span>
        </div>
        {viewState.selectedId && (
          <button
            className="btn btn-xs btn-outline"
            onClick={onClearSelection}
            title="Deselect item"
            data-testid="clear-selection-btn"
          >
            Clear
          </button>
        )}
      </div>

      <div className="panel-content inspector-content">
        {selectedNode ? (
          <div className="inspector-details" data-testid="node-inspector">
            <div className="inspector-section">
              <span className="section-label">Selected Node</span>
              <h3 className="item-title" title={selectedNode.name}>{selectedNode.name}</h3>
              <div className="badge-row">
                <span className="kind-badge">{selectedNode.kind}</span>
                <span className={`policy-badge policy-${selectedNode.policy}`}>
                  <Shield size={12} />
                  {selectedNode.policy}
                </span>
                <span className={`prov-badge prov-${selectedNode.provenance}`}>
                  <Tag size={12} />
                  {selectedNode.provenance}
                </span>
              </div>
            </div>

            <div className="inspector-field">
              <label>Node ID</label>
              <code>{selectedNode.id}</code>
            </div>

            {selectedNode.parentId && (
              <div className="inspector-field">
                <label>Parent Container</label>
                <span>{selectedNode.parentId}</span>
              </div>
            )}

            {selectedNode.description && (
              <div className="inspector-field">
                <label>Description</label>
                <p className="item-desc">{selectedNode.description}</p>
              </div>
            )}

            {selectedNode.contract && (
              <div className="inspector-field">
                <label>Contract / Interface</label>
                <pre className="code-block">{selectedNode.contract}</pre>
              </div>
            )}

            {selectedNode.fields && selectedNode.fields.length > 0 && (
              <div className="inspector-field">
                <label>Fields ({selectedNode.fields.length})</label>
                <div className="fields-table-wrapper">
                  <table className="fields-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedNode.fields.map((f, i) => (
                        <tr key={i}>
                          <td>{f.name}{f.optional ? '?' : ''}</td>
                          <td><code>{f.type}</code></td>
                          <td>{f.key || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedNode.inputs && (
              <div className="inspector-field">
                <label>Inputs</label>
                <p>{selectedNode.inputs}</p>
              </div>
            )}

            {selectedNode.outputs && (
              <div className="inspector-field">
                <label>Outputs</label>
                <p>{selectedNode.outputs}</p>
              </div>
            )}

            {selectedNode.rules && (
              <div className="inspector-field">
                <label>Rules</label>
                <p>{selectedNode.rules}</p>
              </div>
            )}

            {selectedNode.errors && (
              <div className="inspector-field">
                <label>Errors</label>
                <p>{selectedNode.errors}</p>
              </div>
            )}

            {selectedNode.scenarios && selectedNode.scenarios.length > 0 && (
              <div className="inspector-field">
                <label>Scenarios ({selectedNode.scenarios.length})</label>
                <ul className="scenario-list">
                  {selectedNode.scenarios.map((sc, i) => (
                    <li key={i}>{sc}</li>
                  ))}
                </ul>
              </div>
            )}

            {selectedNode.requiredChecks && selectedNode.requiredChecks.length > 0 && (
              <div className="inspector-field">
                <label>Required Checks ({selectedNode.requiredChecks.length})</label>
                <ul className="check-list">
                  {selectedNode.requiredChecks.map((chk, i) => (
                    <li key={i}><CheckCircle2 size={12} /> {chk}</li>
                  ))}
                </ul>
              </div>
            )}

            {selectedNode.source && (
              <div className="inspector-field">
                <label>Bound Source</label>
                <div className="source-meta-card">
                  <div><strong>File:</strong> {selectedNode.source.path}</div>
                  <div><strong>Line:</strong> {selectedNode.source.line}</div>
                  <div><strong>Revision:</strong> {selectedNode.source.revision}</div>
                </div>
              </div>
            )}
          </div>
        ) : selectedEdge ? (
          <div className="inspector-details" data-testid="edge-inspector">
            <div className="inspector-section">
              <span className="section-label">Selected Relationship</span>
              <h3 className="item-title">{selectedEdge.kind}</h3>
              <div className="badge-row">
                <span className="kind-badge">{selectedEdge.kind}</span>
                <span className={`prov-badge prov-${selectedEdge.provenance}`}>{selectedEdge.provenance}</span>
                {selectedEdge.uncertain && (
                  <span className="uncertain-badge"><AlertCircle size={12} /> Uncertain</span>
                )}
              </div>
            </div>

            <div className="inspector-field">
              <label>Edge ID</label>
              <code>{selectedEdge.id}</code>
            </div>

            <div className="inspector-field">
              <label>Source Node</label>
              <span>{selectedEdge.source}</span>
            </div>

            <div className="inspector-field">
              <label>Target Node</label>
              <span>{selectedEdge.target}</span>
            </div>

            {selectedEdge.label && (
              <div className="inspector-field">
                <label>Label</label>
                <span>{selectedEdge.label}</span>
              </div>
            )}
          </div>
        ) : project ? (
          <div className="inspector-details" data-testid="project-inspector">
            <div className="inspector-section">
              <span className="section-label">Project Overview</span>
              <h3 className="item-title">{project.name}</h3>
              <p className="item-desc">{project.description || 'No description provided.'}</p>
            </div>

            <div className="inspector-field">
              <label>Project ID</label>
              <code>{project.id}</code>
            </div>

            <div className="inspector-field">
              <label>Target Platform</label>
              <span>{project.target}</span>
            </div>

            <div className="inspector-field">
              <label>Root Directory</label>
              <code>{project.root || 'In-memory / Unmanaged'}</code>
            </div>

            <div className="inspector-field">
              <label>Specification Revision</label>
              <span>Revision {project.specRevision}</span>
            </div>

            <div className="inspector-field">
              <label>Configured Checks</label>
              <span>{Object.keys(project.checks || {}).length} check(s) configured</span>
            </div>

            <div className="inspector-tip">
              <Info size={14} />
              <span>Select any element in the Project Tree or Canvas to inspect its individual properties, policies, and contracts.</span>
            </div>
          </div>
        ) : (
          <div className="inspector-empty" data-testid="inspector-empty">
            <p>No project or item selected.</p>
          </div>
        )}
      </div>
    </aside>
  );
};
