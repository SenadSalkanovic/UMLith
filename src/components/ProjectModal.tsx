import React, { useState } from 'react';
import type { Project } from '../../shared/model';
import type { CreateProjectRequest } from '../../shared/api';
import { X, FolderOpen, Plus, ArrowRight } from 'lucide-react';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableProjects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (data: CreateProjectRequest) => Promise<void>;
  initialTab?: 'list' | 'create';
}

export const ProjectModal: React.FC<ProjectModalProps> = ({
  isOpen,
  onClose,
  availableProjects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  initialTab = 'list',
}) => {
  const [tab, setTab] = useState<'list' | 'create'>(initialTab);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('TypeScript application');
  const [root, setRoot] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Project name is required.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: name.trim(),
        description: description.trim(),
        target: target.trim() || 'TypeScript application',
        root: root.trim() || undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create project.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="project-modal">
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-tabs">
            <button
              className={`modal-tab ${tab === 'list' ? 'active' : ''}`}
              onClick={() => setTab('list')}
              data-testid="modal-tab-projects"
            >
              <FolderOpen size={16} />
              <span>Projects ({availableProjects.length})</span>
            </button>
            <button
              className={`modal-tab ${tab === 'create' ? 'active' : ''}`}
              onClick={() => setTab('create')}
              data-testid="modal-tab-create"
            >
              <Plus size={16} />
              <span>Create New</span>
            </button>
          </div>
          <button className="btn-icon" onClick={onClose} title="Close dialog">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {tab === 'list' ? (
            <div className="modal-projects-list">
              {availableProjects.length === 0 ? (
                <div className="empty-subtext">No projects available. Create one to get started.</div>
              ) : (
                availableProjects.map((p) => (
                  <div
                    key={p.id}
                    className={`modal-project-item ${p.id === activeProjectId ? 'active-project' : ''}`}
                    onClick={() => {
                      onSelectProject(p.id);
                      onClose();
                    }}
                    data-testid={`modal-project-${p.id}`}
                  >
                    <div className="modal-project-info">
                      <div className="modal-project-name">{p.name}</div>
                      <div className="modal-project-meta">
                        <span>{p.target}</span> • <span>Rev {p.specRevision}</span>
                      </div>
                    </div>
                    {p.id === activeProjectId ? (
                      <span className="current-badge">Active</span>
                    ) : (
                      <ArrowRight size={16} className="item-arrow" />
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <form onSubmit={handleCreate} className="modal-form">
              {error && <div className="form-error-banner">{error}</div>}
              <div className="form-group">
                <label>Project Name *</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Identity Service"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea
                  className="form-input form-textarea"
                  placeholder="System goals and boundary"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Target Platform</label>
                <input
                  type="text"
                  className="form-input"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Root Directory (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="/absolute/path/to/folder"
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                />
              </div>

              <div className="modal-form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Creating…' : 'Create Project'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
