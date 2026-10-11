import React, { useState, useEffect, useCallback } from 'react';
import type { Project, Graph, Layout, BindingReviewRecord } from '../shared/model';
import type { CreateProjectRequest, RevisionRecord } from '../shared/api';
import type { ViewState, SpecificationState, AnalysisState, WorkspaceError, SyncStatus } from './types';
import * as api from './api';
import { reconcileSelectionAndScope } from './workspace-state';
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
import { WorkflowEditor } from './components/WorkflowEditor';
import { RevisionHistory, type SpecificationConflictState } from './components/RevisionHistory';
import { ProtectionEditor } from './components/ProtectionEditor';
import { ImportReview } from './components/ImportReview';
import { AnalysisStatus } from './components/AnalysisStatus';
import { Loader2, Clock, AlertTriangle } from 'lucide-react';

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

  // Workflow Editor Modal State
  const [isWorkflowEditorOpen, setIsWorkflowEditorOpen] = useState<boolean>(false);
  const [workflowEditorTab, setWorkflowEditorTab] = useState<'steps' | 'connect' | 'opaque' | 'overview' | 'remove'>('steps');
  const [workflowEditorFunctionId, setWorkflowEditorFunctionId] = useState<string | null>(null);

  // Revision History & Conflict State (T028)
  const [isRevisionHistoryOpen, setIsRevisionHistoryOpen] = useState<boolean>(false);
  const [activeHistoricalRevision, setActiveHistoricalRevision] = useState<number | null>(null);
  const [conflictState, setConflictState] = useState<SpecificationConflictState | null>(null);
  const [revisionsList, setRevisionsList] = useState<RevisionRecord[]>([]);

  // Protection Editor Modal State (T029)
  const [isProtectionEditorOpen, setIsProtectionEditorOpen] = useState<boolean>(false);
  const [protectionEditorNodeId, setProtectionEditorNodeId] = useState<string | null>(null);

  // Import Review Modal State (T046)
  const [isImportReviewOpen, setIsImportReviewOpen] = useState<boolean>(false);

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

  const [bindingReviews, setBindingReviews] = useState<BindingReviewRecord[]>([]);

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

  // Fetch specification history
  const fetchRevisionsList = useCallback(async (projectId: string) => {
    if (!projectId || projectId.startsWith('/test')) return;
    try {
      const history = await api.getSpecificationHistory(projectId, apiBaseUrl);
      setRevisionsList(history);
    } catch {
      // In-memory or offline fallback
    }
  }, [apiBaseUrl]);

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

      try {
        const bRes = await api.getBindingReviews(proj.id, apiBaseUrl);
        setBindingReviews(bRes.records || []);
      } catch {
        setBindingReviews([]);
      }

      // Reset selection, scope, historical view, and conflict state on project load
      setActiveHistoricalRevision(null);
      setConflictState(null);
      setViewState(prev => ({
        ...prev,
        selectedId: null,
        selectedType: null,
        activeScope: null,
        searchQuery: '',
      }));

      // Fetch saved revisions
      await fetchRevisionsList(proj.id);
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

  const historicalRecord = activeHistoricalRevision !== null
    ? revisionsList.find(r => r.revision === activeHistoricalRevision) || null
    : null;

  const isHistoricalActive = activeHistoricalRevision !== null && activeHistoricalRevision !== specificationState.specRevision;

  const activeGraph = viewState.graphContext === 'implemented'
    ? (analysisState.analysis?.graph || null)
    : (historicalRecord ? historicalRecord.graph : specificationState.specification);

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

  const handleOpenWorkflowEditor = (
    tab: 'steps' | 'connect' | 'opaque' | 'overview' | 'remove' = 'steps',
    functionId: string | null = null
  ) => {
    setWorkflowEditorTab(tab);
    if (functionId) {
      setWorkflowEditorFunctionId(functionId);
    } else {
      const currentSpec = specificationState.specification;
      const selected = viewState.selectedId
        ? currentSpec?.nodes.find(n => n.id === viewState.selectedId)
        : null;
      if (selected?.kind === 'function') {
        setWorkflowEditorFunctionId(selected.id);
      } else if (selected?.kind === 'step') {
        setWorkflowEditorFunctionId(selected.parentId || null);
      }
    }
    setIsWorkflowEditorOpen(true);
  };

  const handleOpenProtectionEditor = (nodeId: string | null = null) => {
    setProtectionEditorNodeId(nodeId || viewState.selectedId);
    setIsProtectionEditorOpen(true);
  };

  const handleUpdateChecks = async (checks: Record<string, { command: string; args: string[] }>) => {
    if (!specificationState.project) return;
    try {
      const updated = await api.updateChecks(specificationState.project.id, checks, apiBaseUrl);
      setSpecificationState(prev => ({
        ...prev,
        project: updated,
      }));
    } catch (err: any) {
      setError({
        title: 'Check Update Failed',
        message: err.message || 'Failed to update project verification checks',
        actionableSteps: ['Verify project state and try again'],
      });
    }
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
    } else if (target?.kind === 'step') {
      handleOpenWorkflowEditor('steps', target.parentId || null);
    } else {
      handleOpenArchitectureEditor('edit', nodeId);
    }
  };

  const handleDeleteNode = async (id: string) => {
    if (isHistoricalActive) {
      setError({
        title: 'Action Blocked in Historical View',
        message: 'Historical specification snapshots are read-only. Edits cannot overwrite newer data implicitly.',
        actionableSteps: ['Exit the historical view or restore this revision as a new forward revision.'],
      });
      return;
    }

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
    if (isHistoricalActive) {
      throw new Error('Historical view is read-only. Cannot overwrite newer data implicitly.');
    }

    const nextRevision = specificationState.specRevision + 1;

    // Persist to server
    if (specificationState.project && !specificationState.project.root?.startsWith('/test')) {
      try {
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
        setConflictState(null);
        await fetchRevisionsList(updatedProject.id);
      } catch (err: any) {
        if (err?.statusCode === 409 || err?.message?.includes('conflict') || err?.message?.includes('Specification changed')) {
          // Strictly preserve draft and surface actionable conflict recovery!
          const currentRev = err?.currentRevision ?? (specificationState.project.specRevision + 1);
          setConflictState({
            projectId: specificationState.project.id,
            expectedRevision: specificationState.specRevision,
            currentRevision: currentRev,
            draftGraph: nextGraph,
            errorMessage: err?.message || 'Specification conflict: draft based on stale revision',
            timestamp: Date.now(),
          });
          return;
        }
        throw err;
      }
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

  // Restore a historical revision as an explicit forward mutation
  const handleRestoreRevision = async (targetRevision: RevisionRecord) => {
    if (!specificationState.project) return;
    const currentRev = specificationState.project.specRevision;
    const nextRevision = currentRev + 1;

    if (!specificationState.project.root?.startsWith('/test')) {
      try {
        const updated = await api.updateSpecification(
          specificationState.project.id,
          currentRev,
          targetRevision.graph,
          apiBaseUrl
        );
        setSpecificationState(prev => ({
          ...prev,
          specRevision: updated.specRevision,
          specification: updated.specification,
          project: updated,
        }));
        setActiveHistoricalRevision(null);
        await fetchRevisionsList(updated.id);
      } catch (err: any) {
        setError({
          title: 'Failed to Restore Revision',
          message: err?.message || 'Conflict occurred while attempting to restore historical revision.',
          actionableSteps: ['Reload the latest specification and retry restoring.'],
        });
      }
    } else {
      // In-memory test fallback
      setSpecificationState(prev => ({
        ...prev,
        specRevision: nextRevision,
        specification: targetRevision.graph,
        project: prev.project
          ? {
              ...prev.project,
              specRevision: nextRevision,
              specification: targetRevision.graph,
            }
          : null,
      }));
      setActiveHistoricalRevision(null);
    }
  };

  const handleResolveConflictReload = async () => {
    if (!specificationState.project) return;
    await loadProjectById(specificationState.project.id);
    setConflictState(null);
  };

  const handleResolveConflictApply = async () => {
    if (!conflictState || !specificationState.project) return;
    try {
      const freshProject = await api.getProject(specificationState.project.id, apiBaseUrl);
      const updated = await api.updateSpecification(
        freshProject.id,
        freshProject.specRevision,
        conflictState.draftGraph,
        apiBaseUrl
      );
      setSpecificationState(prev => ({
        ...prev,
        specRevision: updated.specRevision,
        specification: updated.specification,
        project: updated,
      }));
      setConflictState(null);
      await fetchRevisionsList(updated.id);
    } catch (err: any) {
      setError({
        title: 'Failed to Apply Conflict Draft',
        message: err?.message || 'Could not apply draft on top of latest revision.',
        actionableSteps: ['Inspect conflict diff and review changes before retrying.'],
      });
    }
  };

  const handleResolveConflictDiscard = () => {
    setConflictState(null);
  };

  const handleAcceptBinding = async (nodeId: string, candidateId: string) => {
    if (!specificationState.project) return;
    try {
      const res = await api.acceptBinding(
        specificationState.project.id,
        {
          nodeId,
          candidateId,
          expectedRevision: specificationState.project.specRevision,
          preserveBaseline: true,
        },
        apiBaseUrl
      );
      if (res.success && res.project) {
        setSpecificationState(prev => ({
          ...prev,
          project: res.project,
          specification: res.project.specification,
          specRevision: res.project.specRevision,
        }));
        setBindingReviews(res.bindingReviews || []);
      }
    } catch (err) {
      console.error('Failed to accept binding candidate', err);
    }
  };

  // Reconcile removed items or deleted nodes/edges to prevent stale selections
  useEffect(() => {
    const currentGraph = viewState.graphContext === 'implemented'
      ? (analysisState.analysis?.graph || null)
      : specificationState.specification;

    if (!currentGraph) return;

    const resolution = reconcileSelectionAndScope(viewState, currentGraph, {
      specification: specificationState.specification,
      bindingReviews,
    });

    if (
      resolution.selectedId !== viewState.selectedId ||
      resolution.selectedType !== viewState.selectedType ||
      resolution.activeScope !== viewState.activeScope
    ) {
      setViewState(prev => ({
        ...prev,
        selectedId: resolution.selectedId,
        selectedType: resolution.selectedType,
        activeScope: resolution.activeScope,
      }));
    }
  }, [
    specificationState.specification,
    analysisState.analysis,
    viewState.graphContext,
    viewState.selectedId,
    viewState.activeScope,
    bindingReviews,
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
        analysis={analysisState.analysis}
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
        onOpenWorkflowEditor={() => handleOpenWorkflowEditor('steps')}
        onOpenRevisionHistory={() => setIsRevisionHistoryOpen(true)}
        onOpenImportReview={() => setIsImportReviewOpen(true)}
        onRefreshAnalysis={() => {
          if (specificationState.project) {
            void api.startAnalysis(specificationState.project.id, { async: true }, apiBaseUrl);
          }
        }}
        onRescanAnalysis={() => {
          if (specificationState.project) {
            void api.rescanProject(specificationState.project.id, { async: true }, apiBaseUrl);
          }
        }}
      />

      {/* Analysis Status Alert Banner for Stale or Partial states */}
      {(analysisState.status === 'stale' || analysisState.status === 'partial') && (
        <div className="workspace-analysis-banner-wrapper" data-testid="workspace-analysis-banner">
          <AnalysisStatus
            status={analysisState.status}
            analysis={analysisState.analysis}
            compact={false}
            className="workspace-analysis-alert-banner"
            onRefresh={() => {
              if (specificationState.project) {
                void api.startAnalysis(specificationState.project.id, { async: true }, apiBaseUrl);
              }
            }}
            onRescan={() => {
              if (specificationState.project) {
                void api.rescanProject(specificationState.project.id, { async: true }, apiBaseUrl);
              }
            }}
          />
        </div>
      )}

      {/* Workspace Conflict Alert Banner */}
      {conflictState && (
        <div className="workspace-conflict-banner alert alert-warning" data-testid="workspace-conflict-banner">
          <AlertTriangle size={16} />
          <div className="conflict-banner-text">
            <span>
              <strong>Specification Conflict:</strong> Your draft based on Revision {conflictState.expectedRevision} was rejected because the server is at Revision {conflictState.currentRevision}. Your draft has been preserved.
            </span>
          </div>
          <div className="conflict-banner-buttons">
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={handleResolveConflictReload}
              data-testid="workspace-conflict-reload-btn"
            >
              Reload Latest
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setIsRevisionHistoryOpen(true)}
              data-testid="workspace-conflict-review-btn"
            >
              Review & Resolve
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={handleResolveConflictApply}
              data-testid="workspace-conflict-apply-btn"
            >
              Apply Draft as Rev {conflictState.currentRevision + 1}
            </button>
          </div>
        </div>
      )}

      {/* Historical View Warning Banner */}
      {isHistoricalActive && (
        <div className="workspace-historical-banner alert alert-info" data-testid="historical-view-banner">
          <Clock size={16} />
          <div className="historical-banner-text">
            <span>
              Viewing historical specification <strong>Revision {activeHistoricalRevision} (Read-Only)</strong>. Current committed revision is <strong>Revision {specificationState.specRevision}</strong>.
            </span>
          </div>
          <div className="historical-banner-buttons">
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setActiveHistoricalRevision(null)}
              data-testid="exit-historical-view-btn"
            >
              Exit Historical View
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => {
                const record = revisionsList.find(r => r.revision === activeHistoricalRevision);
                if (record) handleRestoreRevision(record);
              }}
              data-testid="restore-historical-revision-btn"
            >
              Restore as Rev {specificationState.specRevision + 1}
            </button>
          </div>
        </div>
      )}

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
                scopedLayouts={specificationState.project?.scopedLayouts}
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
                onOpenWorkflowEditor={() => handleOpenWorkflowEditor('steps')}
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
                apiBaseUrl={apiBaseUrl}
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
                onEditWorkflowNode={id => {
                  const currentSpec = specificationState.specification;
                  const target = currentSpec?.nodes.find(n => n.id === id);
                  if (target?.kind === 'function') {
                    handleOpenWorkflowEditor('steps', id);
                  } else if (target?.kind === 'step') {
                    handleOpenWorkflowEditor('steps', target.parentId || null);
                  } else {
                    handleOpenWorkflowEditor('steps');
                  }
                }}
                onUpdateSpecification={handleUpdateSpecification}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                apiBaseUrl={apiBaseUrl}
                onOpenRevisionHistory={() => setIsRevisionHistoryOpen(true)}
                onEditProtection={handleOpenProtectionEditor}
                isReadOnly={isHistoricalActive}
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
                onOpenImportReview={() => setIsImportReviewOpen(true)}
                bindingReviews={bindingReviews}
                onAcceptBinding={handleAcceptBinding}
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
        onOpenWorkflowEditor={id => handleOpenWorkflowEditor('steps', id)}
      />

      <WorkflowEditor
        isOpen={isWorkflowEditorOpen}
        onClose={() => setIsWorkflowEditorOpen(false)}
        project={specificationState.project}
        graph={specificationState.specification}
        onUpdateSpecification={handleUpdateSpecification}
        selectedFunctionId={workflowEditorFunctionId || viewState.selectedId}
        onSelectFunction={id => setWorkflowEditorFunctionId(id)}
        initialTab={workflowEditorTab}
        mode="modal"
      />

      <RevisionHistory
        isOpen={isRevisionHistoryOpen}
        onClose={() => setIsRevisionHistoryOpen(false)}
        project={specificationState.project}
        currentRevision={specificationState.specRevision}
        currentGraph={specificationState.specification}
        revisions={revisionsList}
        activeHistoricalRevision={activeHistoricalRevision}
        onSelectHistoricalRevision={rev => setActiveHistoricalRevision(rev)}
        onRestoreRevision={handleRestoreRevision}
        conflict={conflictState}
        onResolveConflictReload={handleResolveConflictReload}
        onResolveConflictReview={() => setIsRevisionHistoryOpen(true)}
        onResolveConflictApply={handleResolveConflictApply}
        onResolveConflictDiscard={handleResolveConflictDiscard}
        apiBaseUrl={apiBaseUrl}
        mode="modal"
      />

      <ProtectionEditor
        isOpen={isProtectionEditorOpen}
        onClose={() => setIsProtectionEditorOpen(false)}
        project={specificationState.project}
        graph={specificationState.specification}
        analysis={analysisState.analysis}
        selectedNodeId={protectionEditorNodeId || viewState.selectedId}
        onSelectNode={handleSelectNode}
        onUpdateSpecification={handleUpdateSpecification}
        onUpdateChecks={handleUpdateChecks}
        mode="modal"
      />

      <ImportReview
        isOpen={isImportReviewOpen}
        onClose={() => setIsImportReviewOpen(false)}
        project={specificationState.project}
        specification={specificationState.specification}
        analysis={analysisState.analysis}
        analysisStatus={analysisState.status}
        onAdopt={handleUpdateSpecification}
        apiBaseUrl={apiBaseUrl}
        mode="modal"
      />
    </div>
  );
};
