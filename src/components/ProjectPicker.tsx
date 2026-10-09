import React, { useState, useEffect } from 'react';
import type { Project } from '../../shared/model';
import type { CreateProjectRequest } from '../../shared/api';
import {
  X,
  FolderOpen,
  Plus,
  ArrowRight,
  Monitor,
  Globe,
  Server,
  Terminal,
  Cpu,
  Search,
  CheckCircle,
  AlertCircle,
  FileCode,
  FolderGit2,
  Info,
  Folder,
} from 'lucide-react';

export interface ProjectPickerProps {
  availableProjects: Project[];
  activeProjectId?: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (data: CreateProjectRequest) => Promise<void>;
  isOpen?: boolean;
  onClose?: () => void;
  initialTab?: 'list' | 'blank' | 'register' | 'create';
  isModal?: boolean;
}

export const TARGET_PRESETS = [
  { label: 'Desktop application', value: 'Desktop application', icon: Monitor },
  { label: 'Web application', value: 'Web application', icon: Globe },
  { label: 'Node.js service', value: 'Node.js service', icon: Server },
  { label: 'CLI tool', value: 'CLI tool', icon: Terminal },
  { label: 'Other / Custom', value: 'other', icon: Cpu },
] as const;

export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  availableProjects,
  activeProjectId = null,
  onSelectProject,
  onCreateProject,
  isOpen = true,
  onClose,
  initialTab = 'list',
  isModal = true,
}) => {
  // Normalize initialTab
  const getInitialTab = (): 'list' | 'blank' | 'register' => {
    if (initialTab === 'create' || initialTab === 'blank') return 'blank';
    if (initialTab === 'register') return 'register';
    return 'list';
  };

  const [tab, setTab] = useState<'list' | 'blank' | 'register'>(getInitialTab);

  useEffect(() => {
    if (isOpen) {
      if (initialTab === 'create' || initialTab === 'blank') {
        setTab('blank');
      } else if (initialTab === 'register') {
        setTab('register');
      } else {
        setTab('list');
      }
      setError(null);
    }
  }, [initialTab, isOpen]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('Desktop application');
  const [customTarget, setCustomTarget] = useState('');
  const [isCustomTarget, setIsCustomTarget] = useState(false);
  const [root, setRoot] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isModal && !isOpen) return null;

  const effectiveTarget = isCustomTarget ? customTarget : target;

  const handleSelectPreset = (val: string) => {
    if (val === 'other') {
      setIsCustomTarget(true);
      if (!customTarget) setCustomTarget('Custom target');
    } else {
      setIsCustomTarget(false);
      setTarget(val);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Project name is required.');
      return;
    }

    const finalTarget = effectiveTarget.trim() || 'TypeScript application';

    if (tab === 'register') {
      const trimmedRoot = root.trim();
      if (!trimmedRoot) {
        setError('Root directory path is required when registering an existing folder.');
        return;
      }
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: trimmedName,
        description: description.trim(),
        target: finalTarget,
        root: tab === 'register' ? root.trim() : undefined,
      });
      setName('');
      setDescription('');
      setRoot('');
      if (onClose) onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create or register project.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter available projects
  const filteredProjects = availableProjects.filter(p => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.target.toLowerCase().includes(q) ||
      (p.description && p.description.toLowerCase().includes(q)) ||
      (p.root && p.root.toLowerCase().includes(q))
    );
  });

  const content = (
    <div className={`project-picker-container ${isModal ? 'modal-dialog' : 'standalone-dialog'}`} data-testid="project-picker">
      <div className="picker-header modal-header" data-testid="picker-header">
        <div className="picker-tabs modal-tabs">
          <button
            type="button"
            className={`modal-tab ${tab === 'list' ? 'active' : ''}`}
            onClick={() => { setTab('list'); setError(null); }}
            data-testid="picker-tab-list"
          >
            <FolderOpen size={16} />
            <span>Projects ({availableProjects.length})</span>
          </button>
          <button
            type="button"
            className={`modal-tab ${tab === 'blank' ? 'active' : ''}`}
            onClick={() => { setTab('blank'); setError(null); }}
            data-testid="picker-tab-blank"
          >
            <Plus size={16} />
            <span>Blank Project</span>
          </button>
          <button
            type="button"
            className={`modal-tab ${tab === 'register' ? 'active' : ''}`}
            onClick={() => { setTab('register'); setError(null); }}
            data-testid="picker-tab-register"
          >
            <FolderGit2 size={16} />
            <span>Register Existing Folder</span>
          </button>
        </div>
        {isModal && onClose && (
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            title="Close dialog"
            data-testid="picker-close-btn"
          >
            <X size={18} />
          </button>
        )}
      </div>

      <div className="picker-body modal-body" data-testid="picker-body">
        {error && (
          <div className="form-error-banner" data-testid="picker-error-banner">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {tab === 'list' && (
          <div className="picker-projects-view" data-testid="picker-projects-view">
            <div className="picker-search-bar">
              <Search size={14} className="search-icon" />
              <input
                type="text"
                className="form-input search-input"
                placeholder="Filter projects by name, target, or path…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="picker-search-input"
              />
            </div>

            <div className="modal-projects-list" data-testid="picker-projects-list">
              {filteredProjects.length === 0 ? (
                <div className="empty-subtext" data-testid="picker-no-projects">
                  {availableProjects.length === 0
                    ? 'No projects available. Start a blank project or register an existing folder.'
                    : 'No projects match your filter.'}
                </div>
              ) : (
                filteredProjects.map((p) => {
                  const isUnadopted = (p.analysis?.graph?.nodes?.length ?? 0) > 0 && p.specification.nodes.length === 0;
                  const isActive = p.id === activeProjectId;

                  return (
                    <div
                      key={p.id}
                      className={`modal-project-item ${isActive ? 'active-project' : ''}`}
                      onClick={() => {
                        onSelectProject(p.id);
                        if (onClose) onClose();
                      }}
                      data-testid={`picker-project-${p.id}`}
                    >
                      <div className="modal-project-info">
                        <div className="modal-project-name-row">
                          <span className="modal-project-name">{p.name}</span>
                          {isActive && <span className="current-badge" data-testid="picker-active-badge">Active</span>}
                          {isUnadopted && (
                            <span className="unadopted-badge" data-testid="picker-unadopted-badge" title="Imported structure in implemented model awaiting human adoption">
                              Implemented Model Imported (Unadopted)
                            </span>
                          )}
                        </div>
                        {p.description && <p className="modal-project-desc">{p.description}</p>}
                        <div className="modal-project-meta">
                          <span className="meta-target">{p.target}</span>
                          <span>•</span>
                          <span className="meta-rev">Rev {p.specRevision}</span>
                          <span>•</span>
                          <span className="meta-root" title={p.root}>
                            {p.managed ? 'Blank / Managed' : p.root}
                          </span>
                        </div>
                      </div>
                      <ArrowRight size={16} className="item-arrow" />
                    </div>
                  );
                })
              )}
            </div>

            <div className="picker-quick-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setTab('blank')}
                data-testid="picker-quick-blank-btn"
              >
                <Plus size={14} />
                <span>New Blank Project</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setTab('register')}
                data-testid="picker-quick-register-btn"
              >
                <FolderGit2 size={14} />
                <span>Register Existing Folder</span>
              </button>
            </div>
          </div>
        )}

        {(tab === 'blank' || tab === 'register') && (
          <form onSubmit={handleSubmit} className="modal-form" data-testid="picker-form">
            <div className="tab-explanation-banner">
              <Info size={16} />
              <div>
                {tab === 'blank' ? (
                  <span>
                    <strong>Blank Project:</strong> Starts an empty architecture specification. Requires no existing code or filesystem directory (R40).
                  </span>
                ) : (
                  <span>
                    <strong>Register Existing Folder:</strong> Scans the directory to populate the implemented graph. The intended architecture will <em>not</em> be auto-adopted and remains under your control (R03, R40).
                  </span>
                )}
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="picker-name">Project Name *</label>
              <input
                id="picker-name"
                type="text"
                className="form-input"
                placeholder={tab === 'blank' ? 'e.g. Identity Architecture' : 'e.g. Existing API Service'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                data-testid="picker-input-name"
              />
            </div>

            <div className="form-group">
              <label htmlFor="picker-desc">Description</label>
              <textarea
                id="picker-desc"
                className="form-input form-textarea"
                placeholder="High-level architecture intent, system boundaries, and responsibilities"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="picker-input-desc"
              />
            </div>

            <div className="form-group">
              <label>Target Platform Metadata</label>
              <div className="target-presets-grid" data-testid="picker-target-presets">
                {TARGET_PRESETS.map((preset) => {
                  const Icon = preset.icon;
                  const isSelected = preset.value === 'other' ? isCustomTarget : (!isCustomTarget && target === preset.value);
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      className={`target-preset-chip ${isSelected ? 'active' : ''}`}
                      onClick={() => handleSelectPreset(preset.value)}
                      data-testid={`picker-target-${preset.value}`}
                    >
                      <Icon size={14} />
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="custom-target-input-wrapper">
                <input
                  id="picker-target"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Desktop application, Embedded IoT, Microservices, Custom"
                  value={effectiveTarget}
                  onChange={(e) => {
                    setIsCustomTarget(true);
                    setCustomTarget(e.target.value);
                  }}
                  data-testid="picker-input-target"
                />
              </div>

              <div className="target-policy-notice" data-testid="picker-no-scaffold-notice">
                <Info size={13} />
                <span>
                  Target choice is descriptive metadata only; it does not impose or generate any code template, scaffold, or boilerplate (R40).
                </span>
              </div>
            </div>

            {tab === 'register' && (
              <div className="form-group" data-testid="picker-root-group">
                <label htmlFor="picker-root">Existing Folder Root Directory *</label>
                <div className="root-input-wrapper">
                  <Folder size={16} className="root-icon" />
                  <input
                    id="picker-root"
                    type="text"
                    className="form-input"
                    placeholder="/absolute/path/to/existing/codebase"
                    value={root}
                    onChange={(e) => setRoot(e.target.value)}
                    required
                    data-testid="picker-input-root"
                  />
                </div>
                <span className="field-hint" data-testid="picker-import-notice">
                  The folder will be analyzed for TypeScript structures. The extracted model is stored as implemented structure and requires human review before adoption (R03).
                </span>
              </div>
            )}

            <div className="modal-form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (isModal && onClose) onClose();
                  else setTab('list');
                }}
                data-testid="picker-cancel-btn"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
                data-testid={tab === 'blank' ? 'picker-submit-blank' : 'picker-submit-register'}
              >
                {isSubmitting
                  ? (tab === 'blank' ? 'Creating Project…' : 'Registering & Importing…')
                  : (tab === 'blank' ? 'Create Blank Project' : 'Register & Import Folder')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div className="modal-backdrop" onClick={onClose} data-testid="project-modal">
        <div onClick={(e) => e.stopPropagation()}>
          {content}
        </div>
      </div>
    );
  }

  return content;
};
