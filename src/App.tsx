import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Project, Graph, Layout, BindingReviewRecord, DivergenceReport } from '../shared/model';
import type { CreateProjectRequest, RevisionRecord } from '../shared/api';
import type { ViewState, SpecificationState, AnalysisState, WorkspaceError, SyncStatus } from './types';
import * as api from './api';
import { GraphSchema } from '../shared/model';
import sensorExample from './examples/sensor-platform.json';
import { defaultDestination, readDestination, destinationUrl, selectionDestination, type Destination } from './navigation-state';
import { newEditHistory, recordEdit, undoEdit, redoEdit, type EditHistory } from './editor-history';
import { DesignDetails } from './components/DesignDetails';
import { reconcileSelectionAndScope } from './workspace-state';
import { Header } from './components/Header';
import { ProjectTree } from './components/ProjectTree';
import { Canvas } from './components/Canvas';
import { PropertyInspector } from './components/PropertyInspector';
import { SourceViewer } from './components/SourceViewer';
import { ReviewPanel, type ArchitectureProposalReview, type PendingReviewItem } from './components/ReviewPanel';
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
import { AgentWorkspace } from './components/AgentWorkspace';
import { Loader2, Clock, AlertTriangle, Undo2, Redo2, PanelLeft, SlidersHorizontal, ArrowLeft } from 'lucide-react';

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
  const [isAgentWorkspaceOpen, setIsAgentWorkspaceOpen] = useState(false);

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
  const [divergenceReport, setDivergenceReport] = useState<DivergenceReport | null>(null);
  const [proposalReviews, setProposalReviews] = useState<ArchitectureProposalReview[]>([]);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [isDecidingProposal, setIsDecidingProposal] = useState(false);
  const [proposalRefresh, setProposalRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const project = specificationState.project;
    setProposalReviews([]);
    if (!project || project.root.startsWith('/test')) return;
    api.getProposals(project.id, apiBaseUrl).then(proposals => {
      if (!cancelled) setProposalReviews(proposals.filter(p => p.status === 'review').map(p => ({
        id: p.id, kind: 'architecture', title: p.task, createdAt: p.createdAt, specRevision: p.specRevision,
        proposal: p.proposal, specificationDiff: p.diff, diagnostics: p.diagnostics,
        isStale: p.diagnostics.some(d => d.code === 'stale-spec'),
        staleReason: p.diagnostics.find(d => d.code === 'stale-spec')?.message,
      })));
    }).catch(err => { if (!cancelled) setProposalError(err.message); });
    return () => { cancelled = true; };
  }, [specificationState.project?.id, specificationState.specRevision, apiBaseUrl, proposalRefresh]);

  const decideProposal = async (review: PendingReviewItem, decision: 'accept' | 'reject') => {
    const projectId = specificationState.project?.id;
    if (!projectId || review.kind !== 'architecture' || isDecidingProposal) return;
    if (draftBaseRevision.current !== null || saving.current) throw new Error('Save or discard the draft before deciding on design changes.');
    setIsDecidingProposal(true);
    setProposalError(null);
    try {
      if (decision === 'accept') {
        const updated = await api.acceptProposal(projectId, review.id, review.specRevision, apiBaseUrl);
        setSpecificationState(prev => prev.project?.id === projectId ? {
          ...prev, project: updated, specRevision: updated.specRevision, specification: updated.specification,
        } : prev);
        await fetchRevisionsList(projectId);
      } else {
        await api.rejectProposal(projectId, review.id, apiBaseUrl);
      }
      setProposalReviews(reviews => reviews.filter(r => r.id !== review.id));
    } catch (err: any) {
      if (err.statusCode === 409) setProposalRefresh(value => value + 1);
      throw err;
    } finally {
      setIsDecidingProposal(false);
    }
  };

  // 5. View State (UI-only, strictly decoupled from Spec and Analysis)
  const [viewState, setViewState] = useState<ViewState>({
    ...defaultDestination,
    ...(initialProject && typeof window !== 'undefined' ? readDestination(window.location.search, initialProject.id, initialProject.specification) : {}),
    searchQuery: '',
    graphContext: 'intended',
    panels: {
      tree: true,
      canvas: true,
      inspector: true,
      source: false,
      review: false,
    },
  });

  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [notesError, setNotesError] = useState('');
  const [semanticDrafts, setSemanticDrafts] = useState(false);
  const [pendingDetailBuffers, setPendingDetailBuffers] = useState(false);
  const [draftGraph, setDraftGraph] = useState<Graph | null>(null);
  const [editHistory, setEditHistory] = useState(() => newEditHistory(initialProject?.specRevision ?? 0));
  const [editMessage, setEditMessage] = useState('');
  const [draftResetToken, setDraftResetToken] = useState(0);
  const [connectionDraft, setConnectionDraft] = useState<{source:string;target:string;nonce:number}>();
  const destinationCache = useRef<Record<string, ViewState>>({});
  const lastBuildContext = useRef<'intended' | 'implemented'>('intended');
  const currentProjectId = useRef(initialProject?.id || null);
  currentProjectId.current = specificationState.project?.id || null;
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'failed'>('saved');
  const saving = useRef(false);
  const draftBaseRevision = useRef<number | null>(null);
  const pendingDraftSelection = useRef<string | null>(null);
  const workspace = viewState.workspace || 'design';
  const designView = viewState.designView || 'classes';
  const projectId = specificationState.project?.id;
  const changeDestination = (updates: Partial<ViewState>, replace = false) => {
    setViewState(previous => ({ ...previous, ...updates }));
    if (typeof window !== 'undefined' && projectId) {
      const destination = { ...defaultDestination, ...viewState, ...updates } as Destination;
      const url = destinationUrl(new URL(window.location.href), projectId, destination);
      if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    }
  };
  const changeWorkspace = (next: 'design' | 'build') => {
    if (next === workspace) return;
    destinationCache.current[`${workspace}:${viewState.graphContext || 'intended'}`] = viewState;
    const context = next === 'design' ? 'intended' : lastBuildContext.current;
    const cached = destinationCache.current[`${next}:${context}`];
    changeDestination({ ...(cached || defaultDestination), workspace: next, graphContext: context });
  };
  useEffect(() => {
    if (typeof window === 'undefined' || !projectId || !specificationState.specification) return;
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const nextProject = params.get('project');
      if (nextProject && nextProject !== projectId) {
        if (draftBaseRevision.current !== null || saving.current) {
          window.history.pushState({}, '', destinationUrl(new URL(window.location.href), projectId, { ...defaultDestination, ...viewState } as Destination));
          setEditMessage('Save or discard changes before switching projects.');
        } else void loadProjectById(nextProject);
        return;
      }
      const graph = params.get('context') === 'implemented' ? analysisState.analysis?.graph || specificationState.specification! : draftGraph || specificationState.specification!;
      setViewState(previous => ({ ...previous, ...readDestination(window.location.search, projectId, graph) }));
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [projectId, specificationState.specification, analysisState.analysis, draftGraph, viewState]);
  useEffect(() => {
    setEditHistory(previous => {
      if (previous.revision === specificationState.specRevision) return previous;
      return newEditHistory(specificationState.specRevision);
    });
  }, [specificationState.specRevision]);
  const draftGraphChanged = useCallback((graph: Graph | null) => {
    setDraftGraph(graph);
    const id = pendingDraftSelection.current;
    if (graph && id && graph.nodes.some(node => node.id === id)) {
      pendingDraftSelection.current = null;
      setViewState(previous => ({ ...previous, selectedId: id, selectedType: 'node' }));
    }
  }, []);
  const draftChanged = useCallback((dirty: boolean) => {
    setSemanticDrafts(dirty);
    if (dirty && draftBaseRevision.current === null) draftBaseRevision.current = specificationState.specRevision;
    if (!dirty) draftBaseRevision.current = null;
  }, [specificationState.specRevision]);

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
    if (draftBaseRevision.current !== null || saving.current) { setEditMessage('Save or discard changes before switching projects.'); return; }
    const switching = currentProjectId.current !== id;
    if (switching) { destinationCache.current = {}; lastBuildContext.current = 'intended'; setConnectionDraft(undefined); }
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

      try {
        const dRes = await api.getDivergenceReport(proj.id, apiBaseUrl);
        setDivergenceReport(dRes.report || null);
      } catch {
        setDivergenceReport(null);
      }

      // Reset selection, scope, historical view, and conflict state on project load
      setActiveHistoricalRevision(null);
      setConflictState(null);
      setViewState(prev => ({
        ...prev,
        ...readDestination(typeof window !== 'undefined' ? window.location.search : '', proj.id, typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('context') === 'implemented' && proj.analysis ? proj.analysis.graph : proj.specification),
        searchQuery: '',
      }));
      setDraftGraph(null);
      setSemanticDrafts(false);
      draftBaseRevision.current = null;
      setEditHistory(newEditHistory(proj.specRevision));

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
    if (workspace === 'design' && panel === 'canvas') return;
    setViewState(previous => {
      const panels = { ...previous.panels, [panel]: !previous.panels[panel] };
      if (typeof window !== 'undefined' && window.innerWidth < 1100 && panels[panel]) {
        if (panel === 'tree') panels.inspector = false;
        if (panel === 'inspector') panels.tree = false;
      }
      return { ...previous, panels };
    });
  };

  const historicalRecord = activeHistoricalRevision !== null
    ? revisionsList.find(r => r.revision === activeHistoricalRevision) || null
    : null;

  const isHistoricalActive = activeHistoricalRevision !== null && activeHistoricalRevision !== specificationState.specRevision;

  const activeGraph = viewState.graphContext === 'implemented'
    ? (analysisState.analysis?.graph || null)
    : (historicalRecord ? historicalRecord.graph : (draftGraph || specificationState.specification));

  const handleSelectNode = (id: string | null) => {
    if (!id) { changeDestination({ selectedId: null, selectedType: null }); return; }
    pendingDraftSelection.current = null;
    const graph = activeGraph;
    if (!graph) return;
    const selection = selectionDestination(graph, id);
    changeDestination({ ...selection, panels: { ...viewState.panels, inspector: true } });
  };
  const handleScopeChange = (scopeId: string | null) => {
    const scope = activeGraph?.nodes.find(node => node.id === scopeId);
    changeDestination({ activeScope: scopeId, flowchartId: scope?.kind === 'function' ? scope.id : null, ...(scope?.kind === 'function' ? { detailTab: 'flowchart' as const } : {}) });
  };

  const handleSearchChange = (query: string) => {
    setViewState(prev => ({ ...prev, searchQuery: query }));
  };

  const handleClearSelection = () => {
    changeDestination({ selectedId: null, selectedType: null });
  };

  const handleGraphContextChange = (context: 'intended' | 'implemented') => {
    if (context === viewState.graphContext) return;
    destinationCache.current[`${workspace}:${viewState.graphContext || 'intended'}`] = viewState;
    lastBuildContext.current = context;
    const cached = destinationCache.current[`${workspace}:${context}`];
    changeDestination({ ...(cached || defaultDestination), workspace, graphContext: context });
  };

  const handleOpenArchitectureEditor = (
    tab: 'add' | 'edit' | 'connect' | 'preview-delete' = 'add',
    nodeId: string | null = null
  ) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard the current draft before opening another editor.'); return; }
    setArchEditorTab(tab);
    setArchEditorNodeId(nodeId || viewState.selectedId);
    setIsArchEditorOpen(true);
  };

  const handleOpenErEditor = (
    tab: 'entities' | 'fields' | 'enums' | 'relationships' = 'entities',
    nodeId: string | null = null
  ) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard the current draft before opening another editor.'); return; }
    setErEditorTab(tab);
    setErEditorNodeId(nodeId || viewState.selectedId);
    setIsErEditorOpen(true);
  };

  const handleOpenFunctionEditor = (
    tab: 'details' | 'contract' | 'scenarios' | 'add' = 'details',
    nodeId: string | null = null
  ) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard the current draft before opening another editor.'); return; }
    setFunctionEditorTab(tab);
    setFunctionEditorNodeId(nodeId || viewState.selectedId);
    setIsFunctionEditorOpen(true);
  };

  const handleOpenWorkflowEditor = (
    tab: 'steps' | 'connect' | 'opaque' | 'overview' | 'remove' = 'steps',
    functionId: string | null = null
  ) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard the current draft before opening another editor.'); return; }
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
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard the current draft before opening another editor.'); return; }
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

  const handleDeleteNode = (id: string) => {
    handleOpenArchitectureEditor('preview-delete', id);
  };

  const handleSelectEdge = (id: string | null) => {
    changeDestination({ selectedId: id, selectedType: id ? 'edge' : null, panels: { ...viewState.panels, inspector: true } });
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

  const handleUpdateSpecification = async (nextGraph: Graph, historyOverride?: EditHistory, fromDraft = false, description?: string) => {
    if (semanticDrafts && !fromDraft) throw new Error('Save or discard the current detail draft before making a separate design change.');
    if (isHistoricalActive || viewState.graphContext === 'implemented') throw new Error('This evidence view is read-only. Return to the current intended design to edit.');
    if (saving.current) throw new Error('A save is already in progress.');
    const graph = GraphSchema.parse(nextGraph);
    const project = specificationState.project;
    const before = specificationState.specification;
    if (!project || !before) throw new Error('Open a project before saving.');
    if (draftBaseRevision.current !== null && draftBaseRevision.current !== specificationState.specRevision) {
      const message = 'The design changed while this draft was open. Reconcile it with the latest revision.';
      setSaveStatus('failed');
      setConflictState({projectId:project.id,expectedRevision:draftBaseRevision.current,currentRevision:specificationState.specRevision,draftGraph:graph,errorMessage:message,timestamp:Date.now()});
      throw new Error(message);
    }
    saving.current = true;
    setSaveStatus('saving');
    try {
      const updated = project.root.startsWith('/test')
        ? { ...project, ...(description !== undefined ? { description } : {}), specification: graph, specRevision: specificationState.specRevision + 1 }
        : await api.updateSpecification(project.id, specificationState.specRevision, graph, apiBaseUrl, description);
      if (currentProjectId.current !== project.id) return;
      setSpecificationState(previous => ({ ...previous, project: updated, specRevision: updated.specRevision, specification: updated.specification }));
      setEditHistory(historyOverride ? { ...historyOverride, revision: updated.specRevision } : recordEdit(editHistory.revision === specificationState.specRevision ? editHistory : newEditHistory(specificationState.specRevision), before, updated.specification, updated.specRevision));
      setConflictState(null);
      setSaveStatus('saved');
      setDraftGraph(null);
      setSemanticDrafts(false);
      draftBaseRevision.current = null;
      pendingDraftSelection.current = null;
      await fetchRevisionsList(updated.id);
    } catch (err: any) {
      setSaveStatus('failed');
      if (err?.statusCode === 409 && description === undefined) {
        setConflictState({ projectId: project.id, expectedRevision: specificationState.specRevision, currentRevision: err.currentRevision ?? specificationState.specRevision + 1, draftGraph: graph, errorMessage: err.message || 'Specification conflict', timestamp: Date.now() });
      }
      throw err;
    } finally { saving.current = false; }
  };
  const replayEdit = async (direction: 'undo' | 'redo') => {
    try {
      if (semanticDrafts) throw new Error('Save or discard your draft before undoing.');
      const transition = (direction === 'undo' ? undoEdit : redoEdit)(editHistory, specificationState.specRevision, specificationState.specification!);
      await handleUpdateSpecification(transition.graph, transition.history);
      setEditMessage('');
    } catch (err) { setEditMessage(err instanceof Error ? err.message : String(err)); }
  };

  // Restore a historical revision as an explicit forward mutation
  const handleRestoreRevision = async (targetRevision: RevisionRecord) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard changes before restoring a revision.'); return; }
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
    if (!specificationState.project || saving.current) return;
    try {
      const fresh = await api.getProject(specificationState.project.id, apiBaseUrl);
      setSpecificationState(previous => ({ ...previous, project: fresh, specification: fresh.specification, specRevision: fresh.specRevision }));
      setConflictState(previous => previous ? { ...previous, currentRevision: fresh.specRevision } : previous);
      setEditHistory(newEditHistory(fresh.specRevision));
      setEditMessage('Latest design loaded. Your original draft is retained; review it before applying or discarding.');
    } catch (err) { setEditMessage(err instanceof Error ? err.message : String(err)); }
  };
  const handleResolveConflictApply = async () => {
    if (!conflictState || !specificationState.project || saving.current) return;
    if (pendingDetailBuffers) { setEditMessage('Apply or cancel the pending field or relationship edit before resolving this conflict.'); return; }
    saving.current = true;
    setSaveStatus('saving');
    try {
      const fresh = await api.getProject(specificationState.project.id, apiBaseUrl);
      if (fresh.specRevision !== conflictState.currentRevision) {
        setConflictState(previous => previous ? { ...previous, currentRevision:fresh.specRevision } : previous);
        throw new Error('The saved design changed again. Reload and review the latest revision before applying your draft.');
      }
      const updated = await api.updateSpecification(fresh.id, conflictState.currentRevision, draftGraph || conflictState.draftGraph, apiBaseUrl);
      setSpecificationState(previous => ({ ...previous, specRevision: updated.specRevision, specification: updated.specification, project: updated }));
      setConflictState(null);
      setDraftGraph(null);
      setSemanticDrafts(false);
      draftBaseRevision.current = null;
      pendingDraftSelection.current = null;
      setDraftResetToken(value => value + 1);
      setEditHistory(recordEdit(newEditHistory(fresh.specRevision), fresh.specification, updated.specification, updated.specRevision));
      setSaveStatus('saved');
      setEditMessage('Draft accepted as a new revision.');
      await fetchRevisionsList(updated.id);
    } catch (err) { setSaveStatus('failed'); setEditMessage(err instanceof Error ? err.message : String(err)); }
    finally { saving.current = false; }
  };
  const handleResolveConflictDiscard = () => {
    setConflictState(null);
    setDraftGraph(null);
    setSemanticDrafts(false);
    draftBaseRevision.current = null;
    pendingDraftSelection.current = null;
    setDraftResetToken(value => value + 1);
    setSaveStatus('saved');
  };

  const handleAcceptBinding = async (nodeId: string, candidateId: string) => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard changes before accepting a source binding.'); return; }
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
      : (draftGraph || specificationState.specification);

    if (!currentGraph || (workspace === 'design' && (semanticDrafts || pendingDraftSelection.current))) return;

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
    draftGraph,
    semanticDrafts,
    workspace,
    analysisState.analysis,
    viewState.graphContext,
    viewState.selectedId,
    viewState.activeScope,
    bindingReviews,
    viewState.selectedType,
  ]);

  // Project management handlers
  const handleCreateProject = async (data: CreateProjectRequest) => {
    if (semanticDrafts || saving.current) throw new Error('Save or discard changes before creating another project.');
    destinationCache.current = {};
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
      setViewState(prev => ({ ...prev, ...defaultDestination, graphContext: 'intended' }));
      setDraftGraph(null);
      setSemanticDrafts(false);
      draftBaseRevision.current = null;
      setEditHistory(newEditHistory(created.specRevision));
      if (typeof window !== 'undefined') window.history.replaceState({}, '', destinationUrl(new URL(window.location.href), created.id, defaultDestination));
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

  const openSensorExample = async () => {
    if (semanticDrafts || saving.current) { setEditMessage('Save or discard changes before opening the example.'); return; }
    setIsLoading(true);
    try {
      const created = await api.createProject({ name: 'Sensor platform · example', description: 'Synthetic reference design: eight UML types, method behavior, and a linked logical database.', target: 'Sensor application' }, apiBaseUrl);
      const updated = await api.updateSpecification(created.id, created.specRevision, GraphSchema.parse(sensorExample), apiBaseUrl);
      setAvailableProjects(previous => [...previous, updated]);
      await loadProjectById(updated.id);
      if (typeof window !== 'undefined') window.history.replaceState({}, '', destinationUrl(new URL(window.location.href), updated.id, defaultDestination));
    } catch (err) { setEditMessage(err instanceof Error ? err.message : String(err)); }
    finally { setIsLoading(false); }
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
        onOpenExample={openSensorExample}
      />
    );
  }

  // Render Populated Workspace Shell
  return (
    <div className="workspace-shell" data-testid="workspace-shell">
      <Header
        workspace={workspace}
        onWorkspaceChange={changeWorkspace}
        saveState={semanticDrafts ? 'Unsaved' : saveStatus === 'saving' ? 'Saving…' : saveStatus === 'failed' ? 'Save failed' : 'Saved'}
        onPrepareHandoff={() => setIsAgentWorkspaceOpen(true)}
        onOpenExample={openSensorExample}
        onEditNotes={() => { if (!semanticDrafts && !saving.current) { setNotesDraft(specificationState.project!.description); setNotesError(''); } }}
        hasDraft={semanticDrafts || saveStatus === 'saving'}
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
        onOpenImportReview={() => { if (!semanticDrafts && !saving.current) setIsImportReviewOpen(true); else setEditMessage('Save or discard changes before adopting imported code.'); }}
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
      <div className="workspace-toolbar">
        <button className="btn btn-outline" onClick={() => handleTogglePanel('tree')} aria-pressed={viewState.panels.tree}><PanelLeft size={16}/>Model</button>
        {workspace === 'design' && <div className="design-view-tabs" aria-label="Design views">
          {(['overview', 'classes', 'database'] as const).map(value => <button key={value} aria-pressed={designView === value} onClick={() => changeDestination({ designView: value, workspace: 'design', graphContext: 'intended', flowchartId: null })}>{value === 'overview' ? 'Overview' : value === 'classes' ? 'Classes' : 'Database'}</button>)}
        </div>}
        {viewState.flowchartId && <button className="btn btn-outline" onClick={() => { const id = viewState.flowchartId!; changeDestination({ ...selectionDestination(activeGraph!, id), detailTab: 'flowchart' }); }}><ArrowLeft size={14}/>Return to class</button>}
        <span className="toolbar-spacer"/>
        <button className="btn btn-outline" disabled={semanticDrafts || !editHistory.undo.length || isHistoricalActive || viewState.graphContext === 'implemented'} onClick={() => replayEdit('undo')} aria-label="Undo"><Undo2 size={16}/></button>
        <button className="btn btn-outline" disabled={semanticDrafts || !editHistory.redo.length || isHistoricalActive || viewState.graphContext === 'implemented'} onClick={() => replayEdit('redo')} aria-label="Redo"><Redo2 size={16}/></button>
        <button className="btn btn-outline" onClick={() => handleTogglePanel('inspector')} aria-pressed={viewState.panels.inspector}><SlidersHorizontal size={16}/>Details</button>
      </div>
      {editMessage && <p className="workspace-edit-message" role="alert">{editMessage}</p>}
      {workspace === 'build' && <div className="build-workspace-actions"><strong>Build &amp; review</strong><span>Intended design → candidate changes → checks → human decision</span><button className="btn btn-primary" disabled={semanticDrafts} onClick={() => setIsAgentWorkspaceOpen(true)}>Tasks &amp; candidate review</button><button className="btn btn-outline" disabled={semanticDrafts || saveStatus === 'saving'} onClick={() => setIsImportReviewOpen(true)}>Import &amp; adoption</button><button className="btn btn-outline" onClick={() => handleTogglePanel('source')}>Source evidence</button><button className="btn btn-outline" onClick={() => handleTogglePanel('review')}>Design proposals &amp; bindings</button></div>}
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

      <main className={`workspace-main workspace-${workspace} ${viewState.panels.tree ? 'with-tree' : ''} ${viewState.panels.inspector ? 'with-details' : ''}`} data-testid="workspace-main">
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
              onDeleteNode={isHistoricalActive || viewState.graphContext === 'implemented' ? undefined : handleDeleteNode}
              hideContext={workspace === 'design'}
            />
          </div>
        )}

        {/* Center Work Area: Scoped Canvas + Source Viewer */}
        <div className="layout-col-center">
          {/* Panel 2: Scoped Canvas */}
          {(workspace === 'design' || viewState.panels.canvas) && (
            <div className="center-top-canvas">
              <Canvas
                graph={activeGraph}
                layout={specificationState.layout}
                scopedLayouts={specificationState.project?.scopedLayouts}
                viewState={viewState}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onConnectNodes={(source, target) => { handleSelectNode(source); setConnectionDraft(previous => ({source, target, nonce:(previous?.nonce||0)+1})); changeDestination({ ...selectionDestination(activeGraph!, source), panels: { ...viewState.panels, inspector:true } }); }}
                onSelectField={(owner, field) => changeDestination({ ...selectionDestination(activeGraph!, owner), selectedField: field, panels: { ...viewState.panels, inspector: true } })}
                onScopeChange={handleScopeChange}
                onLayoutChange={handleLayoutChange}
                onUpdateSpecification={semanticDrafts ? undefined : handleUpdateSpecification}
                readOnly={isHistoricalActive || viewState.graphContext === 'implemented'}
                projectId={specificationState.project?.id}
                apiBaseUrl={apiBaseUrl}
                onOpenArchitectureEditor={() => changeDestination({ selectedId: null, selectedType: null, panels: { ...viewState.panels, inspector: true } })}
              />
            </div>
          )}

          {/* Panel 4: Source Viewer */}
          {workspace === 'build' && viewState.panels.source && (
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
          {specificationState.specification && <div className="design-details-host" hidden={workspace !== 'design' || !viewState.panels.inspector || isHistoricalActive || viewState.graphContext === 'implemented'}>
            <DesignDetails key={specificationState.project.id} connectionDraft={connectionDraft} graph={specificationState.specification} selectionId={viewState.selectedId} scopeId={viewState.activeScope} onSelect={id => { if (id && !activeGraph?.nodes.some(node => node.id === id) && !activeGraph?.edges.some(edge => edge.id === id)) pendingDraftSelection.current = id; changeDestination({ selectedId: id, selectedType: id ? (draftGraph || specificationState.specification)?.edges.some(edge => edge.id === id) ? 'edge' : 'node' : null, selectedField: null, ...(id && activeGraph?.nodes.some(node => node.id === id && node.kind === 'step') ? selectionDestination(activeGraph, id) : {}) }); }} onScope={handleScopeChange} onSave={graph => handleUpdateSpecification(graph, undefined, true)} resetToken={draftResetToken} onDraftChange={draftChanged} onPendingChange={setPendingDetailBuffers} onDraftGraphChange={draftGraphChanged} detailTab={viewState.detailTab} selectedField={viewState.selectedField} onDetailTabChange={detailTab => changeDestination({ detailTab })} onFlowchart={id => changeDestination({ flowchartId: id, activeScope: id, detailTab: 'flowchart' })}/>
          </div>}
          {(workspace === 'build' || isHistoricalActive || viewState.graphContext === 'implemented') && viewState.panels.inspector && (
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
          {workspace === 'build' && viewState.panels.review && (
            <div className="right-bottom-review">
              <ReviewPanel
                project={specificationState.project}
                graph={specificationState.specification}
                analysisState={analysisState}
                onOpenImportReview={() => { if (!semanticDrafts && !saving.current) setIsImportReviewOpen(true); else setEditMessage('Save or discard changes before adopting imported code.'); }}
                bindingReviews={bindingReviews}
                onAcceptBinding={handleAcceptBinding}
                divergenceReport={divergenceReport}
                pendingReviews={proposalReviews}
                onAccept={review => decideProposal(review, 'accept')}
                onReject={review => decideProposal(review, 'reject')}
                onDismiss={() => { setProposalError(null); }}
                actionError={proposalError}
                isDeciding={isDecidingProposal}
                onRefreshProposals={() => { setProposalError(null); setProposalRefresh(value => value + 1); }}
              />
            </div>
          )}
        </div>
      </main>

      <footer className="workspace-statusbar"><span>Design r{specificationState.specRevision} · {semanticDrafts ? 'Unsaved changes' : saveStatus === 'failed' ? 'Save failed — draft retained' : 'Saved locally'}</span><span>{workspace === 'design' ? 'Human-owned intended design' : `Implemented evidence: ${analysisState.status}`} · layout saved independently</span></footer>
      {notesDraft !== null && <div className="modal-backdrop"><section className="project-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="project-notes-title"><h2 id="project-notes-title">Project notes</h2><p>Purpose, responsibilities, and design decisions for this project. Notes save as a new revision; diagram Undo applies to graph edits.</p><label>Notes<textarea autoFocus value={notesDraft} onChange={event => { setNotesDraft(event.target.value); setSemanticDrafts(true); if (draftBaseRevision.current === null) draftBaseRevision.current = specificationState.specRevision; }}/></label>{notesError && <p role="alert">{notesError}</p>}<div className="detail-actions"><button className="btn btn-primary" disabled={saveStatus === 'saving'} onClick={async () => { try { await handleUpdateSpecification(specificationState.specification!, undefined, true, notesDraft); setNotesDraft(null); } catch (err) { setNotesError(err instanceof Error ? err.message : String(err)); } }}>Save notes</button><button className="btn btn-secondary" disabled={saveStatus === 'saving'} onClick={() => { setNotesDraft(null); setSemanticDrafts(false); draftBaseRevision.current = null; setNotesError(''); }}>Cancel</button></div></section></div>}
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
        onAdopt={graph => handleUpdateSpecification(graph)}
        apiBaseUrl={apiBaseUrl}
        mode="modal"
      />
      {specificationState.project && <AgentWorkspace
        key={specificationState.project.id}
        open={isAgentWorkspaceOpen}
        project={specificationState.project}
        semanticDrafts={semanticDrafts}
        selectedNodeId={viewState.selectedType === 'node' ? viewState.selectedId || undefined : undefined}
        analysisRevision={analysisState.analysis?.revision}
        apiBaseUrl={apiBaseUrl}
        onClose={() => setIsAgentWorkspaceOpen(false)}
        onChanged={() => loadProjectById(specificationState.project!.id)}
        onChecksChanged={project => setSpecificationState(prev => ({ ...prev, project }))}
      />}
    </div>
  );
};
