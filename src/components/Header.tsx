import React from 'react';
import type { Project } from '../../shared/model';
import type { SyncStatus, ViewState } from '../types';
import { Layers, PanelLeft, Layout, Sliders, FileCode, CheckSquare, Plus, FolderOpen } from 'lucide-react';

interface HeaderProps {
  project: Project | null;
  syncStatus: SyncStatus;
  viewState: ViewState;
  onTogglePanel: (panel: keyof ViewState['panels']) => void;
  onOpenNewProject: () => void;
  onOpenProjectPicker: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  project,
  syncStatus,
  viewState,
  onTogglePanel,
  onOpenNewProject,
  onOpenProjectPicker,
}) => {
  const getStatusBadge = () => {
    switch (syncStatus) {
      case 'updating':
        return <span className="status-badge status-updating" data-testid="status-updating">Updating…</span>;
      case 'current':
        return <span className="status-badge status-current" data-testid="status-current">Current</span>;
      case 'partial':
        return <span className="status-badge status-partial" data-testid="status-partial">Partial</span>;
      case 'stale':
        return <span className="status-badge status-stale" data-testid="status-stale">Stale</span>;
      default:
        return <span className="status-badge status-idle">Ready</span>;
    }
  };

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
            <span className="project-revision" title={`Specification Revision ${project.specRevision}`}>
              {`Rev ${project.specRevision}`}
            </span>
            {getStatusBadge()}
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
