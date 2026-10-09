import React, { useState } from 'react';
import type { Project } from '../../shared/model';
import type { CreateProjectRequest } from '../../shared/api';
import { Layers, Plus, FolderOpen, ArrowRight } from 'lucide-react';

interface EmptyWorkspaceProps {
  availableProjects: Project[];
  onSelectProject: (id: string) => void;
  onCreateProject: (data: CreateProjectRequest) => Promise<void>;
}

export const EmptyWorkspace: React.FC<EmptyWorkspaceProps> = ({
  availableProjects,
  onSelectProject,
  onCreateProject,
}) => {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('TypeScript application');
  const [root, setRoot] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Project name is required.');
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: name.trim(),
        description: description.trim(),
        target: target.trim() || 'TypeScript application',
        root: root.trim() || undefined,
      });
    } catch (err: any) {
      setFormError(err?.message || 'Failed to create project.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="empty-workspace-view" data-testid="empty-workspace">
      <div className="empty-workspace-card">
        <div className="empty-hero">
          <Layers size={48} className="hero-icon" />
          <h1 className="hero-title">Architecture Workspace</h1>
          <p className="hero-subtitle">
            Local browser workspace for software architecture, ER models, and interface specifications with live code synchronization.
          </p>
        </div>

        {availableProjects.length > 0 && !showCreateForm && (
          <div className="existing-projects-section" data-testid="existing-projects-section">
            <h2 className="section-title">
              <FolderOpen size={18} />
              <span>Available Local Projects</span>
            </h2>
            <div className="projects-grid">
              {availableProjects.map(proj => (
                <div
                  key={proj.id}
                  className="project-card"
                  onClick={() => onSelectProject(proj.id)}
                  data-testid={`project-card-${proj.id}`}
                >
                  <div className="project-card-header">
                    <h3 className="project-card-title">{proj.name}</h3>
                    <span className="project-card-rev">Rev {proj.specRevision}</span>
                  </div>
                  <p className="project-card-desc">{proj.description || 'No description'}</p>
                  <div className="project-card-footer">
                    <span className="project-card-target">{proj.target}</span>
                    <button className="btn btn-sm btn-primary">
                      <span>Open</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="or-divider">
              <span>or</span>
            </div>

            <div className="action-row-center">
              <button
                className="btn btn-secondary"
                onClick={() => setShowCreateForm(true)}
                data-testid="show-create-project-btn"
              >
                <Plus size={16} />
                <span>Create New Project</span>
              </button>
            </div>
          </div>
        )}

        {(availableProjects.length === 0 || showCreateForm) && (
          <div className="create-project-form-container" data-testid="create-project-form">
            <div className="form-header">
              <h2>Create New Architecture Project</h2>
              {availableProjects.length > 0 && (
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={() => setShowCreateForm(false)}
                >
                  Back to Project List
                </button>
              )}
            </div>

            {formError && (
              <div className="form-error-banner" data-testid="create-project-error">
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="project-form">
              <div className="form-group">
                <label htmlFor="proj-name">Project Name *</label>
                <input
                  id="proj-name"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Core Banking System"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  data-testid="input-project-name"
                />
              </div>

              <div className="form-group">
                <label htmlFor="proj-desc">Description</label>
                <textarea
                  id="proj-desc"
                  className="form-input form-textarea"
                  placeholder="High-level architecture intent and system responsibilities"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="input-project-desc"
                />
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="proj-target">Target Platform / Scope</label>
                  <input
                    id="proj-target"
                    type="text"
                    className="form-input"
                    placeholder="e.g. TypeScript application, Desktop, Web"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    data-testid="input-project-target"
                  />
                  <span className="field-hint">Descriptive target; does not impose a generation template.</span>
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="proj-root">Root Directory Path (Optional)</label>
                  <input
                    id="proj-root"
                    type="text"
                    className="form-input"
                    placeholder="e.g. /workspace/project"
                    value={root}
                    onChange={(e) => setRoot(e.target.value)}
                    data-testid="input-project-root"
                  />
                  <span className="field-hint">Leave blank for blank in-memory project.</span>
                </div>
              </div>

              <div className="form-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                  data-testid="submit-create-project-btn"
                >
                  <Plus size={16} />
                  <span>{isSubmitting ? 'Creating Project…' : 'Create & Open Project'}</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
