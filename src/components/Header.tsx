import React from 'react';
import type { Project, Analysis } from '../../shared/model';
import type { SyncStatus, ViewState } from '../types';
import { AnalysisStatus } from './AnalysisStatus';
import { Layers, PanelLeft, Layout, Sliders, FileCode, CheckSquare, Plus, FolderOpen, Database, Terminal, Workflow, History } from 'lucide-react';

interface HeaderProps {
  project: Project | null;
  syncStatus: SyncStatus;
  analysis?: Analysis | null;
  viewState: ViewState;
  onTogglePanel: (panel: keyof ViewState['panels']) => void;
  onOpenNewProject: () => void;
  onOpenProjectPicker: () => void;
  onOpenArchitectureEditor?: () => void;
  onOpenErEditor?: () => void;
  onOpenFunctionEditor?: () => void;
  onOpenWorkflowEditor?: () => void;
  onOpenRevisionHistory?: () => void;
  onOpenImportReview?: () => void;
  onRefreshAnalysis?: () => void;
  onRescanAnalysis?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  project,
  syncStatus,
  analysis,
  viewState,
  onTogglePanel,
  onOpenNewProject,
  onOpenProjectPicker,
  onOpenArchitectureEditor,
  onOpenErEditor,
  onOpenFunctionEditor,
  onOpenWorkflowEditor,
  onOpenRevisionHistory,
  onOpenImportReview,
  onRefreshAnalysis,
  onRescanAnalysis,
}) => {
  return (
    <header className="workspace-header" data-testid="workspace-header">
      <div className="header-brand">
        <Layers className="brand-icon" size={20} />
        <span className="brand-title">Architecture Workspace</span>
      </div>

      <div className="header-project-info">
        {project ? (
          <>
            <span className="project-name" title={project.name}>
              {project.name}
            </span>
            <span className="project-target" title={`Target: ${project.target}`}>
              {project.target}
            </span>
            {onOpenRevisionHistory ? (
              <button
                type="button"
                className="project-revision btn-revision"
                onClick={onOpenRevisionHistory}
                title={`Specification Revision ${project.specRevision} — Click to inspect history`}
                data-testid="header-revision-badge"
              >
                {`Rev ${project.specRevision}`}
              </button>
            ) : (
              <span className="project-revision" title={`Specification Revision ${project.specRevision}`}>
                {`Rev ${project.specRevision}`}
              </span>
            )}
            <AnalysisStatus
              status={syncStatus}
              analysis={analysis}
              compact={true}
              onRefresh={onRefreshAnalysis}
              onRescan={onRescanAnalysis}
            />
          </>
        ) : (
          <span className="no-project-label">No project active</span>
        )}
      </div>

      <div className="header-actions">
        <button
          className="btn btn-secondary btn-sm"
          onClick={onOpenProjectPicker}
          title="Switch or Open Project"
          data-testid="header-open-project"
        >
          <FolderOpen size={16} />
          <span>Projects</span>
        </button>

        <button
          className="btn btn-primary btn-sm"
          onClick={onOpenNewProject}
          title="Create New Project"
          data-testid="header-new-project"
        >
          <Plus size={16} />
          <span>New</span>
        </button>

        {onOpenArchitectureEditor && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenArchitectureEditor}
            title="Open Architecture Editor"
            data-testid="header-open-architecture"
          >
            <Layers size={16} />
            <span>Architecture</span>
          </button>
        )}

        {onOpenErEditor && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenErEditor}
            title="Open ER Schema Editor"
            data-testid="header-open-er"
          >
            <Database size={16} />
            <span>ER Schema</span>
          </button>
        )}

        {onOpenFunctionEditor && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenFunctionEditor}
            title="Open Function Specifications & Contracts Editor"
            data-testid="header-open-functions"
          >
            <Terminal size={16} />
            <span>Functions</span>
          </button>
        )}

        {onOpenWorkflowEditor && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenWorkflowEditor}
            title="Open Function Workflows Editor"
            data-testid="header-open-workflows"
          >
            <Workflow size={16} />
            <span>Workflows</span>
          </button>
        )}

        {onOpenRevisionHistory && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenRevisionHistory}
            title="Inspect Specification Revisions & History"
            data-testid="header-open-history"
          >
            <History size={16} />
            <span>History</span>
          </button>
        )}

        {onOpenImportReview && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenImportReview}
            title="Inspect Import Quality & Adopt into Intent"
            data-testid="header-open-import"
          >
            <FileCode size={16} />
            <span>Import</span>
          </button>
        )}

        <div className="panel-toggles">
          <button
            className={`btn-icon ${viewState.panels.tree ? 'active' : ''}`}
            onClick={() => onTogglePanel('tree')}
            title="Toggle Project Tree"
            data-testid="toggle-tree"
          >
            <PanelLeft size={16} />
          </button>
          <button
            className={`btn-icon ${viewState.panels.canvas ? 'active' : ''}`}
            onClick={() => onTogglePanel('canvas')}
            title="Toggle Canvas"
            data-testid="toggle-canvas"
          >
            <Layout size={16} />
          </button>
          <button
            className={`btn-icon ${viewState.panels.inspector ? 'active' : ''}`}
            onClick={() => onTogglePanel('inspector')}
            title="Toggle Property Inspector"
            data-testid="toggle-inspector"
          >
            <Sliders size={16} />
          </button>
          <button
            className={`btn-icon ${viewState.panels.source ? 'active' : ''}`}
            onClick={() => onTogglePanel('source')}
            title="Toggle Source Viewer"
            data-testid="toggle-source"
          >
            <FileCode size={16} />
          </button>
          <button
            className={`btn-icon ${viewState.panels.review ? 'active' : ''}`}
            onClick={() => onTogglePanel('review')}
            title="Toggle Review Panel"
            data-testid="toggle-review"
          >
            <CheckSquare size={16} />
          </button>
        </div>
      </div>
    </header>
  );
};
