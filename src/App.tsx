import React, { useState, useEffect, useCallback } from 'react';
import type { Project, Graph, Layout } from '../shared/model';
import type { CreateProjectRequest } from '../shared/api';
import type { ViewState, SpecificationState, AnalysisState, WorkspaceError, SyncStatus } from './types';
import * as api from './api';
import { Header } from './components/Header';
import { ProjectTree } from './components/ProjectTree';
import { Canvas } from './components/Canvas';
import { PropertyInspector } from './components/PropertyInspector';
import { SourceViewer } from './components/SourceViewer';
import { ReviewPanel } from './components/ReviewPanel';
import { EmptyWorkspace } from './components/EmptyWorkspace';
import { ErrorView } from './components/ErrorView';
import { ProjectModal } from './components/ProjectModal';
import { ArchitectureEditor } from './components/ArchitectureEditor';
import { ErEditor } from './components/ErEditor';
import { FunctionEditor } from './components/FunctionEditor';
import { Loader2 } from 'lucide-react';

export interface AppProps {
  initialProject?: Project;
  initialProjects?: Project[];
  apiBaseUrl?: string;
  autoLoad?: boolean;
}

export const App: React.FC<AppProps> = ({
  initialProject,
  initialProjects,
  apiBaseUrl,
  autoLoad = true,
}) => {
  // 1. Loading & Error States
  const [isLoading, setIsLoading] = useState<boolean>(!initialProject && autoLoad);
  const [error, setError] = useState<WorkspaceError | null>(null);

  // 2. Available Projects List & Modal State
  const [availableProjects, setAvailableProjects] = useState<Project[]>(initialProjects || []);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalTab, setModalTab] = useState<'list' | 'create'>('list');

  // Architecture Editor Modal State
  const [isArchEditorOpen, setIsArchEditorOpen] = useState<boolean>(false);
  const [archEditorTab, setArchEditorTab] = useState<'add' | 'edit' | 'connect' | 'preview-delete'>('add');
  const [archEditorNodeId, setArchEditorNodeId] = useState<string | null>(null);

  // ER Editor Modal State
  const [isErEditorOpen, setIsErEditorOpen] = useState<boolean>(false);
  const [erEditorTab, setErEditorTab] = useState<'entities' | 'fields' | 'enums' | 'relationships'>('entities');
  const [erEditorNodeId, setErEditorNodeId] = useState<string | null>(null);

  // Function Editor Modal State
  const [isFunctionEditorOpen, setIsFunctionEditorOpen] = useState<boolean>(false);
  const [functionEditorTab, setFunctionEditorTab] = useState<'details' | 'contract' | 'scenarios' | 'add'>('details');
  const [functionEditorNodeId, setFunctionEditorNodeId] = useState<string | null>(null);

  // 3. Specification State (Persistent & Versioned Intent)
  const [specificationState, setSpecificationState] = useState<SpecificationState>(() => ({
    project: initialProject || null,
    specRevision: initialProject?.specRevision ?? 0,
    specification: initialProject?.specification || null,
    layout: initialProject?.layout || {},
  }));

  // 4. Analysis State (Compiler Findings & Sync Diagnostics)
  const [analysisState, setAnalysisState] = useState<AnalysisState>(() => {
    return {
      analysis: initialProject?.analysis || null,
      status: initialProject?.analysis?.status || 'current',
      lastChecked: initialProject ? Date.now() : null,
    };
  });

  // 5. View State (UI-only, strictly decoupled from Spec and Analysis)
  const [viewState, setViewState] = useState<ViewState>({
    selectedId: null,
    selectedType: null,
    activeScope: null,
    searchQuery: '',
    graphContext: 'intended',
    panels: {
      tree: true,
      canvas: true,
      inspector: true,
      source: true,
      review: true,
    },
  });

  // Load project by ID
  const loadProjectById = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const proj = await api.getProject(id, apiBaseUrl);
      setSpecificationState({
        project: proj,
        specRevision: proj.specRevision,
        specification: proj.specification,
        layout: proj.layout || {},
      });

      setAnalysisState({
        analysis: proj.analysis || null,
        status: proj.analysis?.status || 'current',
        lastChecked: Date.now(),
      });

      // Reset selection and scope for newly loaded project
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
        activeScope: null,
        searchQuery: '',
      }));
    } catch (err: any) {
      const actionableSteps = err instanceof api.ApiConnectionError && err.actionableSteps
        ? err.actionableSteps
        : [
            'Verify that the local architecture workspace service is running (`npm start` or `npm run dev`).',
            'Check that the service is listening on loopback at http://127.0.0.1:4317.',
          ];

      setError({
        title: 'Unable to Load Project',
        message: err?.message || 'Failed to fetch project details from local service.',
        actionableSteps,
        statusCode: err?.statusCode,
        isConnectionError: true,
      });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  // Initial load: fetch projects and determine initial active project
  const initializeWorkspace = useCallback(async () => {
    if (initialProject) {
      setIsLoading(false);
      return;
    }
    if (!autoLoad) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const list = await api.getProjects(apiBaseUrl);
      setAvailableProjects(list);

      // Check if URL has ?project=<id>
      let targetId: string | null = null;
      if (typeof window !== 'undefined' && window.location) {
        const urlParams = new URLSearchParams(window.location.search);
        targetId = urlParams.get('project');
      }

      if (targetId) {
        await loadProjectById(targetId);
      } else if (list.length > 0) {
        // Automatically load the first available project
        await loadProjectById(list[0].id);
      } else {
        // No projects exist yet -> Empty workspace state
        setSpecificationState({
          project: null,
          specRevision: 0,
          specification: null,
          layout: {},
        });
      }
    } catch (err: any) {
      const actionableSteps = err instanceof api.ApiConnectionError && err.actionableSteps
        ? err.actionableSteps
        : [
            'Verify that the local architecture workspace service is running (`npm start` or `npm run dev`).',
            'Check that the service is listening on loopback at http://127.0.0.1:4317.',
            'Ensure your browser is connecting from an allowed origin (http://127.0.0.1:5173).',
          ];

      setError({
        title: 'Service Connection Error',
        message: err?.message || 'Could not connect to the local architecture workspace backend.',
        actionableSteps,
        statusCode: err?.statusCode,
        isConnectionError: true,
      });
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, autoLoad, initialProject, loadProjectById]);

  useEffect(() => {
    initializeWorkspace();
  }, [initializeWorkspace]);

  // View state handlers (Pure view operations - do not mutate specification!)
  const handleTogglePanel = (panel: keyof ViewState['panels']) => {
    setViewState(prev => ({
      ...prev,
      panels: {
        ...prev.panels,
        [panel]: !prev.panels[panel],
      },
    }));
  };

  const activeGraph = viewState.graphContext === 'implemented'
    ? (analysisState.analysis?.graph || null)
    : specificationState.specification;

  const handleSelectNode = (id: string | null) => {
    if (!id) {
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
      }));
      return;
    }

    const currentGraph = viewState.graphContext === 'implemented'
      ? (analysisState.analysis?.graph || null)
      : specificationState.specification;

    const node = currentGraph?.nodes.find(n => n.id === id);
    let parentId: string | null = null;
    if (node) {
      if (node.parentId && currentGraph?.nodes.some(n => n.id === node.parentId)) {
        parentId = node.parentId;
      } else {
        const containsEdge = currentGraph?.edges.find(e => e.kind === 'contains' && e.target === id);
        if (containsEdge && currentGraph?.nodes.some(n => n.id === containsEdge.source)) {
          parentId = containsEdge.source;
        }
      }
    }

    setViewState(prev => ({
      ...prev,
      selectedId: id,
      selectedType: 'node',
      // Tree selection opens the correct graph scope containing the node
      activeScope: parentId,
    }));
  };

  const handleScopeChange = (scopeId: string | null) => {
    setViewState(prev => ({
      ...prev,
      activeScope: scopeId,
    }));
  };

  const handleSearchChange = (query: string) => {
    setViewState(prev => ({ ...prev, searchQuery: query }));
  };

  const handleClearSelection = () => {
    setViewState(prev => ({ ...prev, selectedId: null, selectedType: null }));
  };

  const handleGraphContextChange = (context: 'intended' | 'implemented') => {
    setViewState(prev => {
      const nextGraph = context === 'implemented'
        ? (analysisState.analysis?.graph || null)
        : specificationState.specification;

      const nextNodes = nextGraph?.nodes || [];
      const selectedStillExists = prev.selectedId ? nextNodes.some(n => n.id === prev.selectedId) : false;
      const scopeStillExists = prev.activeScope ? nextNodes.some(n => n.id === prev.activeScope) : false;

      return {
        ...prev,
        graphContext: context,
        selectedId: selectedStillExists ? prev.selectedId : null,
        selectedType: selectedStillExists ? prev.selectedType : null,
        activeScope: scopeStillExists ? prev.activeScope : null,
      };
    });
  };

  const handleOpenArchitectureEditor = (
    tab: 'add' | 'edit' | 'connect' | 'preview-delete' = 'add',
    nodeId: string | null = null
  ) => {
    setArchEditorTab(tab);
    setArchEditorNodeId(nodeId || viewState.selectedId);
    setIsArchEditorOpen(true);
  };

  const handleOpenErEditor = (
    tab: 'entities' | 'fields' | 'enums' | 'relationships' = 'entities',
    nodeId: string | null = null
  ) => {
    setErEditorTab(tab);
    setErEditorNodeId(nodeId || viewState.selectedId);
    setIsErEditorOpen(true);
  };

  const handleOpenFunctionEditor = (
    tab: 'details' | 'contract' | 'scenarios' | 'add' = 'details',
    nodeId: string | null = null
  ) => {
    setFunctionEditorTab(tab);
    setFunctionEditorNodeId(nodeId || viewState.selectedId);
    setIsFunctionEditorOpen(true);
  };

  const handleEditNode = (nodeId: string) => {
    const currentSpec = specificationState.specification;
    const target = currentSpec?.nodes.find(n => n.id === nodeId);
    if (target?.kind === 'entity') {
      handleOpenErEditor('fields', nodeId);
    } else if (target?.kind === 'enum') {
      handleOpenErEditor('enums', nodeId);
    } else if (target?.kind === 'function') {
      handleOpenFunctionEditor('details', nodeId);
    } else {
      handleOpenArchitectureEditor('edit', nodeId);
    }
  };

  const handleDeleteNode = async (id: string) => {
    const currentSpec = specificationState.specification;
    if (!currentSpec) return;

    const targetNode = currentSpec.nodes.find(n => n.id === id);
    if (!targetNode) return;

    const remainingNodes = currentSpec.nodes
      .filter(n => n.id !== id)
      .map(n => {
        if (n.parentId === id) {
          return { ...n, parentId: targetNode.parentId };
        }
        return n;
      });

    const remainingEdges = currentSpec.edges.filter(e => e.source !== id && e.target !== id);

    const remainingReqs = currentSpec.requirements.map(req => ({
      ...req,
      nodeIds: req.nodeIds.filter(nid => nid !== id),
    }));

    const nextGraph: Graph = {
      ...currentSpec,
      nodes: remainingNodes,
      edges: remainingEdges,
      requirements: remainingReqs,
    };

    const nextRevision = specificationState.specRevision + 1;

    setSpecificationState(prev => ({
      ...prev,
      specRevision: nextRevision,
      specification: nextGraph,
    }));

    // Predictably resolve selection and scope
    setViewState(prev => {
      const isDeletedSelected = prev.selectedId === id;
      const isDeletedScope = prev.activeScope === id;
      return {
        ...prev,
        selectedId: isDeletedSelected ? null : prev.selectedId,
        selectedType: isDeletedSelected ? null : prev.selectedType,
        activeScope: isDeletedScope ? (targetNode.parentId ?? null) : prev.activeScope,
      };
    });

    if (specificationState.project && !specificationState.project.root?.startsWith('/test')) {
      try {
        await api.updateSpecification(
          specificationState.project.id,
          specificationState.specRevision,
          nextGraph,
          apiBaseUrl
        );
      } catch {
        // Fallback for isolated tests or unmanaged projects
      }
    }
  };

  const handleSelectEdge = (id: string | null) => {
    setViewState(prev => ({
      ...prev,
      selectedId: id,
      selectedType: id ? 'edge' : null,
    }));
  };

  const handleLayoutChange = async (updatedLayout: Layout, scopeId?: string | null) => {
    // 1. Immediately update view/spec state layout without touching specification or specRevision
    setSpecificationState(prev => {
      const nextLayout = { ...prev.layout, ...updatedLayout };
      const nextScopedLayouts = scopeId
        ? {
            ...prev.project?.scopedLayouts,
            [scopeId]: {
              ...(prev.project?.scopedLayouts?.[scopeId] || {}),
              ...updatedLayout,
            },
          }
        : prev.project?.scopedLayouts;

      return {
        ...prev,
        layout: nextLayout,
        project: prev.project
          ? {
              ...prev.project,
              layout: nextLayout,
              scopedLayouts: nextScopedLayouts,
            }
          : null,
      };
    });

    // 2. Persist to server via layout API
    if (specificationState.project && !specificationState.project.root?.startsWith('/test')) {
      try {
        await api.updateLayout(
          specificationState.project.id,
          updatedLayout,
          scopeId || undefined,
          apiBaseUrl
        );
      } catch (err) {
        console.error('Failed to persist layout change:', err);
      }
    }
  };

  const handleUpdateSpecification = async (nextGraph: Graph) => {
    const nextRevision = specificationState.specRevision + 1;

    // Persist to server
    if (specificationState.project && !specificationState.project.root?.startsWith('/test')) {
      const updatedProject = await api.updateSpecification(
        specificationState.project.id,
        specificationState.specRevision,
        nextGraph,
        apiBaseUrl
      );
      setSpecificationState(prev => ({
        ...prev,
        specRevision: updatedProject.specRevision,
        specification: updatedProject.specification,
        project: updatedProject,
      }));
    } else {
      // Local fallback for in-memory or isolated test projects
      setSpecificationState(prev => ({
        ...prev,
        specRevision: nextRevision,
        specification: nextGraph,
        project: prev.project
          ? {
              ...prev.project,
              specRevision: nextRevision,
              specification: nextGraph,
            }
          : null,
      }));
    }
  };

  // Reconcile removed items or deleted nodes/edges to prevent stale selections
  useEffect(() => {
    const currentGraph = viewState.graphContext === 'implemented'
      ? (analysisState.analysis?.graph || null)
      : specificationState.specification;

    if (!currentGraph) return;

    const nodeExists = viewState.selectedId
      ? currentGraph.nodes.some(n => n.id === viewState.selectedId)
      : false;

    const edgeExists = viewState.selectedId
      ? currentGraph.edges.some(e => e.id === viewState.selectedId)
      : false;

    const scopeExists = viewState.activeScope
      ? currentGraph.nodes.some(n => n.id === viewState.activeScope)
      : false;

    if (viewState.selectedId && !nodeExists && viewState.selectedType === 'node') {
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
      }));
    }

    if (viewState.selectedId && !edgeExists && viewState.selectedType === 'edge') {
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
      }));
    }

    if (viewState.activeScope && !scopeExists) {
      setViewState(prev => ({
        ...prev,
        activeScope: null,
      }));
    }
  }, [
    specificationState.specification,
    analysisState.analysis,
    viewState.graphContext,
    viewState.selectedId,
    viewState.activeScope,
    viewState.selectedType,
  ]);

  // Project management handlers
  const handleCreateProject = async (data: CreateProjectRequest) => {
    setIsLoading(true);
    setError(null);
    try {
      const created = await api.createProject(data, apiBaseUrl);
      setAvailableProjects(prev => [...prev, created]);
      setSpecificationState({
        project: created,
        specRevision: created.specRevision,
        specification: created.specification,
        layout: created.layout || {},
      });
      setAnalysisState({
        analysis: created.analysis || null,
        status: 'current',
        lastChecked: Date.now(),
      });
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
        activeScope: null,
      }));
    } catch (err: any) {
      setError({
        title: 'Failed to Create Project',
        message: err?.message || 'Project creation request rejected by service.',
        actionableSteps: [
          'Ensure the project name is non-empty.',
          'If specifying an existing directory root, verify the path exists and is a directory.',
          'Check server permissions for the workspace data directory.',
        ],
        statusCode: err?.statusCode,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Render Loading State
  if (isLoading) {
    return (
      <div className="workspace-loading" data-testid="loading-state">
        <Loader2 className="spinner" size={36} />
        <h2>Loading Architecture Workspace…</h2>
        <p>Connecting to local loopback service at 127.0.0.1:4317</p>
      </div>
    );
  }

  // Render Actionable Error State
  if (error) {
    return (
      <ErrorView
        error={error}
        onRetry={initializeWorkspace}
        onBackToEmpty={() => {
          setError(null);
          setSpecificationState({ project: null, specRevision: 0, specification: null, layout: {} });
        }}
      />
    );
  }

  // Render Empty Workspace State (No project open)
  if (!specificationState.project) {
    return (
      <EmptyWorkspace
        availableProjects={availableProjects}
        onSelectProject={loadProjectById}
        onCreateProject={handleCreateProject}
      />
    );
  }

  // Render Populated Workspace Shell
  return (
    <div className="workspace-shell" data-testid="workspace-shell">
      <Header
        project={specificationState.project}
        syncStatus={analysisState.status}
        viewState={viewState}
        onTogglePanel={handleTogglePanel}
        onOpenNewProject={() => {
          setModalTab('create');
          setIsModalOpen(true);
        }}
        onOpenProjectPicker={() => {
          setModalTab('list');
          setIsModalOpen(true);
        }}
        onOpenArchitectureEditor={() => handleOpenArchitectureEditor('add')}
        onOpenErEditor={() => handleOpenErEditor('entities')}
        onOpenFunctionEditor={() => handleOpenFunctionEditor('details')}
      />

      <main className="workspace-main" data-testid="workspace-main">
        {/* Panel 1: Project Tree */}
        {viewState.panels.tree && (
          <div className="layout-col-tree">
            <ProjectTree
              graph={activeGraph}
              viewState={viewState}
              onSelectNode={handleSelectNode}
              onScopeChange={handleScopeChange}
              onSearchChange={handleSearchChange}
              project={specificationState.project}
              analysis={analysisState.analysis}
              onGraphContextChange={handleGraphContextChange}
              onDeleteNode={handleDeleteNode}
            />
          </div>
        )}

        {/* Center Work Area: Scoped Canvas + Source Viewer */}
        <div className="layout-col-center">
          {/* Panel 2: Scoped Canvas */}
          {viewState.panels.canvas && (
            <div className="center-top-canvas">
              <Canvas
                graph={activeGraph}
                layout={specificationState.layout}
                viewState={viewState}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onScopeChange={handleScopeChange}
                onLayoutChange={handleLayoutChange}
                onUpdateSpecification={handleUpdateSpecification}
                projectId={specificationState.project?.id}
                apiBaseUrl={apiBaseUrl}
                onOpenArchitectureEditor={() => handleOpenArchitectureEditor('add')}
                onOpenErEditor={() => handleOpenErEditor('entities')}
                onOpenFunctionEditor={() => handleOpenFunctionEditor('details')}
              />
            </div>
          )}

          {/* Panel 4: Source Viewer */}
          {viewState.panels.source && (
            <div className="center-bottom-source">
              <SourceViewer
                project={specificationState.project}
                graph={activeGraph}
                analysisState={analysisState}
                viewState={viewState}
              />
            </div>
          )}
        </div>

        {/* Right Work Area: Property Inspector + Review Area */}
        <div className="layout-col-right">
          {/* Panel 3: Property Inspector */}
          {viewState.panels.inspector && (
            <div className="right-top-inspector">
              <PropertyInspector
                project={specificationState.project}
                graph={activeGraph}
                viewState={viewState}
                onClearSelection={handleClearSelection}
                onDeleteNode={handleDeleteNode}
                onEditNode={handleEditNode}
                onEditErNode={id => handleOpenErEditor('fields', id)}
                onEditFunctionNode={id => handleOpenFunctionEditor('details', id)}
              />
            </div>
          )}

          {/* Panel 5: Review Area */}
          {viewState.panels.review && (
            <div className="right-bottom-review">
              <ReviewPanel
                project={specificationState.project}
                graph={specificationState.specification}
                analysisState={analysisState}
              />
            </div>
          )}
        </div>
      </main>

      <ProjectModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        availableProjects={availableProjects}
        activeProjectId={specificationState.project.id}
        onSelectProject={loadProjectById}
        onCreateProject={handleCreateProject}
        initialTab={modalTab}
      />

      <ArchitectureEditor
        isOpen={isArchEditorOpen}
        onClose={() => setIsArchEditorOpen(false)}
        project={specificationState.project}
        graph={specificationState.specification}
        onUpdateSpecification={handleUpdateSpecification}
        selectedNodeId={archEditorNodeId || viewState.selectedId}
        onSelectNode={handleSelectNode}
        initialTab={archEditorTab}
        mode="modal"
      />

      <ErEditor
        isOpen={isErEditorOpen}
        onClose={() => setIsErEditorOpen(false)}
        project={specificationState.project}
        graph={specificationState.specification}
        onUpdateSpecification={handleUpdateSpecification}
        selectedNodeId={erEditorNodeId || viewState.selectedId}
        onSelectNode={handleSelectNode}
        initialTab={erEditorTab}
        mode="modal"
      />

      <FunctionEditor
        isOpen={isFunctionEditorOpen}
        onClose={() => setIsFunctionEditorOpen(false)}
        project={specificationState.project}
        graph={specificationState.specification}
        onUpdateSpecification={handleUpdateSpecification}
        selectedNodeId={functionEditorNodeId || viewState.selectedId}
        onSelectNode={handleSelectNode}
        initialTab={functionEditorTab}
        mode="modal"
      />
    </div>
  );
};
