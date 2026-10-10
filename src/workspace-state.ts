import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  Graph,
  ProgramNode,
  ProgramEdge,
  Layout,
  Analysis,
  Project,
  BindingReviewRecord,
} from '../shared/model';
import type { ViewState, SyncStatus } from './types';
import type { AnalysisClient } from './analysis-client';

export interface MergeLayoutResult {
  layout: Layout;
  scopedLayouts: Record<string, Layout>;
  retainedCount: number;
  newNodesCount: number;
  prunedCount: number;
}

/**
 * Merges updated graph nodes and edges with existing layout, strictly preserving
 * the independent positions of all surviving identities.
 */
export function mergeLayoutAcrossUpdates(
  previousLayout: Layout,
  nextGraph: Graph,
  previousScopedLayouts?: Record<string, Layout>,
  incomingLayout?: Layout,
  incomingScopedLayouts?: Record<string, Layout>,
  options?: { pruneStale?: boolean }
): MergeLayoutResult {
  const pruneStale = options?.pruneStale ?? false;
  const nextNodeIds = new Set(nextGraph.nodes.map(n => n.id));
  const mergedLayout: Layout = {};
  let retainedCount = 0;
  let newNodesCount = 0;
  let prunedCount = 0;

  // 1. For all nodes surviving in the updated graph:
  // Existing layout positions must be preserved without reset
  for (const node of nextGraph.nodes) {
    if (previousLayout[node.id]) {
      // Surviving identity retains independent position
      mergedLayout[node.id] = { ...previousLayout[node.id] };
      retainedCount++;
    } else if (incomingLayout && incomingLayout[node.id]) {
      // New node with incoming layout position
      mergedLayout[node.id] = { ...incomingLayout[node.id] };
      newNodesCount++;
    } else {
      newNodesCount++;
    }
  }

  // 2. If not pruning stale positions, keep existing positions for non-conflicting nodes
  if (!pruneStale) {
    for (const [id, pos] of Object.entries(previousLayout)) {
      if (!nextNodeIds.has(id) && !mergedLayout[id]) {
        mergedLayout[id] = { ...pos };
      }
    }
  } else {
    for (const id of Object.keys(previousLayout)) {
      if (!nextNodeIds.has(id)) {
        prunedCount++;
      }
    }
  }

  // 3. Reconcile scoped layouts
  const mergedScopedLayouts: Record<string, Layout> = {};
  const allScopeIds = new Set([
    ...Object.keys(previousScopedLayouts || {}),
    ...Object.keys(incomingScopedLayouts || {}),
  ]);

  for (const scopeId of allScopeIds) {
    if (nextNodeIds.has(scopeId) || !pruneStale) {
      const prevScope = previousScopedLayouts?.[scopeId] || {};
      const incomingScope = incomingScopedLayouts?.[scopeId] || {};
      const nextScopeLayout: Layout = {};

      for (const [nodeId, pos] of Object.entries(prevScope)) {
        if (nextNodeIds.has(nodeId) || !pruneStale) {
          nextScopeLayout[nodeId] = { ...pos };
        }
      }

      for (const [nodeId, pos] of Object.entries(incomingScope)) {
        if (!nextScopeLayout[nodeId] && (nextNodeIds.has(nodeId) || !pruneStale)) {
          nextScopeLayout[nodeId] = { ...pos };
        }
      }

      mergedScopedLayouts[scopeId] = nextScopeLayout;
    }
  }

  return {
    layout: mergedLayout,
    scopedLayouts: mergedScopedLayouts,
    retainedCount,
    newNodesCount,
    prunedCount,
  };
}

export interface SelectionResolution {
  selectedId: string | null;
  selectedType: 'node' | 'edge' | 'project' | null;
  activeScope: string | null;
  selectionSurvives: boolean;
  scopeSurvives: boolean;
  status: 'survived' | 'deleted' | 'ambiguous' | 'none';
  isEditable: boolean;
  bindingReview?: BindingReviewRecord;
  protectionIssue?: string;
  unresolvedNode?: ProgramNode;
}

/**
 * Reconciles selection and canvas scope across graph updates.
 * Preserves selection and scope for surviving identities.
 * Explicitly resolves deleted or ambiguous selections without silently rebinding protected items.
 */
export function reconcileSelectionAndScope(
  currentViewState: ViewState,
  nextGraph: Graph,
  options?: {
    previousGraph?: Graph | null;
    specification?: Graph | null;
    bindingReviews?: BindingReviewRecord[];
  }
): SelectionResolution {
  const previousGraph = options?.previousGraph || null;
  const specification = options?.specification || null;
  const bindingReviews = options?.bindingReviews || [];

  const { selectedId, selectedType, activeScope } = currentViewState;

  // 1. Resolve Active Canvas Scope
  let nextScope = activeScope;
  let scopeSurvives = false;

  if (activeScope === null) {
    scopeSurvives = true;
  } else {
    const scopeNodeExists = nextGraph.nodes.some(n => n.id === activeScope);
    if (scopeNodeExists) {
      scopeSurvives = true;
      nextScope = activeScope;
    } else {
      scopeSurvives = false;
      // If scope node was deleted, check if parent survived in previous graph
      const prevScopeNode = previousGraph?.nodes.find(n => n.id === activeScope);
      const parentId = prevScopeNode?.parentId;
      if (parentId && nextGraph.nodes.some(n => n.id === parentId)) {
        nextScope = parentId;
      } else {
        nextScope = null;
      }
    }
  }

  // 2. Resolve Selection
  if (!selectedId || !selectedType) {
    return {
      selectedId: null,
      selectedType: null,
      activeScope: nextScope,
      selectionSurvives: false,
      scopeSurvives,
      status: 'none',
      isEditable: false,
    };
  }

  if (selectedType === 'project') {
    return {
      selectedId,
      selectedType: 'project',
      activeScope: nextScope,
      selectionSurvives: true,
      scopeSurvives,
      status: 'survived',
      isEditable: true,
    };
  }

  if (selectedType === 'edge') {
    const survivingEdge = nextGraph.edges.find(e => e.id === selectedId);
    const endpointsExist = survivingEdge
      ? nextGraph.nodes.some(n => n.id === survivingEdge.source) &&
        nextGraph.nodes.some(n => n.id === survivingEdge.target)
      : false;

    if (survivingEdge && endpointsExist) {
      return {
        selectedId,
        selectedType: 'edge',
        activeScope: nextScope,
        selectionSurvives: true,
        scopeSurvives,
        status: 'survived',
        isEditable: true,
      };
    }

    // Edge or its endpoints deleted
    return {
      selectedId: null,
      selectedType: null,
      activeScope: nextScope,
      selectionSurvives: false,
      scopeSurvives,
      status: 'deleted',
      isEditable: false,
    };
  }

  // selectedType === 'node'
  const survivingNode = nextGraph.nodes.find(n => n.id === selectedId);
  const specNode = specification?.nodes.find(n => n.id === selectedId);
  const prevNode = previousGraph?.nodes.find(n => n.id === selectedId);
  const relevantNode = survivingNode || specNode || prevNode;

  // Check if there is an explicit binding review for this node
  const bindingReview = bindingReviews.find(r => r.nodeId === selectedId);

  // If node has an ambiguous or unresolved binding review
  if (bindingReview && (bindingReview.status === 'ambiguous' || bindingReview.status === 'unresolved')) {
    const isProtected = relevantNode?.policy && relevantNode.policy !== 'editable';
    const protectionIssue = isProtected
      ? `Protected item "${relevantNode?.name || selectedId}" has ambiguous binding across ${bindingReview.candidates.length} candidates. Manual source-binding review required.`
      : `Item "${relevantNode?.name || selectedId}" has ambiguous binding.`;

    return {
      selectedId: null, // Clear editable selection to prevent arbitrary rebinding or editing
      selectedType: null,
      activeScope: nextScope,
      selectionSurvives: false,
      scopeSurvives,
      status: 'ambiguous',
      isEditable: false, // Ambiguous items do not remain editable!
      bindingReview,
      protectionIssue,
      unresolvedNode: relevantNode,
    };
  }

  if (survivingNode) {
    // Unambiguous surviving node!
    return {
      selectedId,
      selectedType: 'node',
      activeScope: nextScope,
      selectionSurvives: true,
      scopeSurvives,
      status: 'survived',
      isEditable: true,
      unresolvedNode: undefined,
    };
  }

  // Node was DELETED from the graph
  const isProtected = relevantNode?.policy && relevantNode.policy !== 'editable';
  const protectionIssue = isProtected
    ? `Protected item "${relevantNode?.name || selectedId}" cannot be resolved or was deleted from source code.`
    : undefined;

  return {
    selectedId: null, // Deleted node is not selected
    selectedType: null,
    activeScope: nextScope,
    selectionSurvives: false,
    scopeSurvives,
    status: 'deleted',
    isEditable: false, // Deleted items do not remain editable!
    protectionIssue,
    unresolvedNode: relevantNode,
  };
}

/**
 * Checks whether an item in the graph remains editable after updates.
 * Deleted and ambiguous items never remain editable.
 */
export function isItemEditable(
  itemId: string | null,
  graph: Graph | null,
  bindingReviews?: BindingReviewRecord[]
): boolean {
  if (!itemId || !graph) return false;

  const nodeExists = graph.nodes.some(n => n.id === itemId);
  const edgeExists = graph.edges.some(e => e.id === itemId);

  if (!nodeExists && !edgeExists) {
    // Deleted item does not exist in graph -> NOT editable!
    return false;
  }

  if (bindingReviews && bindingReviews.length > 0) {
    const review = bindingReviews.find(r => r.nodeId === itemId);
    if (review && (review.status === 'ambiguous' || review.status === 'unresolved')) {
      // Ambiguous item requires binding review -> NOT directly editable!
      return false;
    }
  }

  return true;
}

export interface WorkspaceState {
  graph: Graph | null;
  specification: Graph | null;
  layout: Layout;
  scopedLayouts: Record<string, Layout>;
  viewState: ViewState;
  bindingReviews: BindingReviewRecord[];
  syncStatus: SyncStatus;
  protectionIssues: string[];
}

export interface WorkspaceStateUpdateOptions {
  incomingGraph?: Graph;
  incomingAnalysis?: Analysis;
  incomingLayout?: Layout;
  incomingScopedLayouts?: Record<string, Layout>;
  bindingReviews?: BindingReviewRecord[];
  status?: SyncStatus;
  pruneStaleLayout?: boolean;
}

/**
 * Reconciles the full workspace state across graph updates:
 * - Surviving selection and positions remain unchanged.
 * - Deleted items do not remain editable.
 * - Intended specification and baselines remain strictly unchanged.
 */
export function reconcileWorkspaceState(
  currentState: WorkspaceState,
  update: WorkspaceStateUpdateOptions
): {
  nextState: WorkspaceState;
  resolution: SelectionResolution;
  specificationMutated: boolean;
  baselinesMutated: boolean;
} {
  const specBeforeJson = currentState.specification ? JSON.stringify(currentState.specification) : null;

  // 1. Determine next graph
  const nextGraph = update.incomingGraph || update.incomingAnalysis?.graph || currentState.graph;

  if (!nextGraph) {
    return {
      nextState: currentState,
      resolution: {
        selectedId: null,
        selectedType: null,
        activeScope: null,
        selectionSurvives: false,
        scopeSurvives: true,
        status: 'none',
        isEditable: false,
      },
      specificationMutated: false,
      baselinesMutated: false,
    };
  }

  // 2. Next binding reviews
  const nextReviews = update.bindingReviews !== undefined
    ? update.bindingReviews
    : currentState.bindingReviews;

  // 3. Reconcile layout: surviving positions remain unchanged!
  const layoutResult = mergeLayoutAcrossUpdates(
    currentState.layout,
    nextGraph,
    currentState.scopedLayouts,
    update.incomingLayout,
    update.incomingScopedLayouts,
    { pruneStale: update.pruneStaleLayout ?? false }
  );

  // 4. Reconcile selection and scope
  const resolution = reconcileSelectionAndScope(
    currentState.viewState,
    nextGraph,
    {
      previousGraph: currentState.graph,
      specification: currentState.specification,
      bindingReviews: nextReviews,
    }
  );

  const nextViewState: ViewState = {
    ...currentState.viewState,
    selectedId: resolution.selectedId,
    selectedType: resolution.selectedType,
    activeScope: resolution.activeScope,
  };

  // 5. Collect protection issues
  const protectionIssues: string[] = [];
  if (resolution.protectionIssue) {
    protectionIssues.push(resolution.protectionIssue);
  }

  // 6. Verify specification and baselines immutability:
  // Live synchronization NEVER rewrites or mutates human specification intent or baselines!
  const specAfterJson = currentState.specification ? JSON.stringify(currentState.specification) : null;
  const specificationMutated = specBeforeJson !== specAfterJson;

  let baselinesMutated = false;
  if (currentState.specification) {
    for (const node of currentState.specification.nodes) {
      if (node.baseline) {
        // Compare with baseline if updated
        const currentSpecNode = currentState.specification.nodes.find(n => n.id === node.id);
        if (!currentSpecNode || JSON.stringify(currentSpecNode.baseline) !== JSON.stringify(node.baseline)) {
          baselinesMutated = true;
          break;
        }
      }
    }
  }

  const nextState: WorkspaceState = {
    graph: nextGraph,
    specification: currentState.specification, // Human intent strictly preserved!
    layout: layoutResult.layout,
    scopedLayouts: layoutResult.scopedLayouts,
    viewState: nextViewState,
    bindingReviews: nextReviews,
    syncStatus: update.status || (update.incomingAnalysis?.status as SyncStatus) || currentState.syncStatus,
    protectionIssues,
  };

  return {
    nextState,
    resolution,
    specificationMutated,
    baselinesMutated,
  };
}

export interface UseWorkspaceSyncProps {
  project?: Project | null;
  specification?: Graph | null;
  initialGraph?: Graph | null;
  initialLayout?: Layout;
  initialScopedLayouts?: Record<string, Layout>;
  initialViewState?: Partial<ViewState>;
  initialBindingReviews?: BindingReviewRecord[];
  initialStatus?: SyncStatus;
  client?: AnalysisClient | null;
  onLayoutChange?: (layout: Layout, scopeId?: string | null) => void | Promise<void>;
}

/**
 * React hook managing workspace state, layout preservation, selection resolution,
 * and live synchronization via AnalysisClient.
 */
export function useWorkspaceSync({
  project,
  specification,
  initialGraph,
  initialLayout = {},
  initialScopedLayouts = {},
  initialViewState,
  initialBindingReviews = [],
  initialStatus = 'current',
  client,
  onLayoutChange,
}: UseWorkspaceSyncProps) {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(() => {
    const activeGraph = initialGraph || specification || project?.specification || null;
    const baseLayout = initialLayout || project?.layout || {};
    const baseScopedLayouts = initialScopedLayouts || project?.scopedLayouts || {};

    const baseViewState: ViewState = {
      selectedId: null,
      selectedType: null,
      activeScope: null,
      searchQuery: '',
      panels: {
        tree: true,
        canvas: true,
        inspector: true,
        source: true,
        review: true,
      },
      ...(initialViewState || {}),
    };

    return {
      graph: activeGraph,
      specification: specification || project?.specification || null,
      layout: baseLayout,
      scopedLayouts: baseScopedLayouts,
      viewState: baseViewState,
      bindingReviews: initialBindingReviews,
      syncStatus: initialStatus,
      protectionIssues: [],
    };
  });

  const [lastResolution, setLastResolution] = useState<SelectionResolution | null>(null);

  // Apply an update cleanly
  const applyUpdate = useCallback((update: WorkspaceStateUpdateOptions) => {
    setWorkspaceState(prev => {
      const { nextState, resolution } = reconcileWorkspaceState(prev, update);
      setLastResolution(resolution);
      return nextState;
    });
  }, []);

  // Selection handlers
  const selectNode = useCallback((id: string | null) => {
    setWorkspaceState(prev => {
      if (!id) {
        return {
          ...prev,
          viewState: {
            ...prev.viewState,
            selectedId: null,
            selectedType: null,
          },
        };
      }

      // Check if node exists and if it's ambiguous
      const nodeExists = prev.graph?.nodes.some(n => n.id === id);
      const isAmbiguous = prev.bindingReviews.some(
        r => r.nodeId === id && (r.status === 'ambiguous' || r.status === 'unresolved')
      );

      if (!nodeExists || isAmbiguous) {
        // Cannot select non-existent or ambiguous node as editable
        return {
          ...prev,
          viewState: {
            ...prev.viewState,
            selectedId: null,
            selectedType: null,
          },
        };
      }

      return {
        ...prev,
        viewState: {
          ...prev.viewState,
          selectedId: id,
          selectedType: 'node',
        },
      };
    });
  }, []);

  const selectEdge = useCallback((id: string | null) => {
    setWorkspaceState(prev => ({
      ...prev,
      viewState: {
        ...prev.viewState,
        selectedId: id,
        selectedType: id ? 'edge' : null,
      },
    }));
  }, []);

  const changeScope = useCallback((scopeId: string | null) => {
    setWorkspaceState(prev => ({
      ...prev,
      viewState: {
        ...prev.viewState,
        activeScope: scopeId,
      },
    }));
  }, []);

  const updateLayout = useCallback(async (updatedLayout: Layout, scopeId?: string | null) => {
    setWorkspaceState(prev => {
      const nextLayout = { ...prev.layout, ...updatedLayout };
      const nextScopedLayouts = scopeId
        ? {
            ...prev.scopedLayouts,
            [scopeId]: {
              ...(prev.scopedLayouts[scopeId] || {}),
              ...updatedLayout,
            },
          }
        : prev.scopedLayouts;

      return {
        ...prev,
        layout: nextLayout,
        scopedLayouts: nextScopedLayouts,
      };
    });

    if (onLayoutChange) {
      await onLayoutChange(updatedLayout, scopeId);
    }
  }, [onLayoutChange]);

  // Connect to AnalysisClient live events if provided
  useEffect(() => {
    if (!client) return;

    const unSnapshot = client.on('snapshot', (snapshot) => {
      applyUpdate({
        incomingAnalysis: snapshot,
        incomingGraph: snapshot.graph,
        status: snapshot.status as SyncStatus,
      });
    });

    const unDelta = client.on('delta', (deltaEvent) => {
      // client.applyDelta updates client.getSnapshot()
      const snap = client.getSnapshot();
      if (snap) {
        applyUpdate({
          incomingAnalysis: snap,
          incomingGraph: snap.graph,
          status: snap.status as SyncStatus,
        });
      }
    });

    const unStatus = client.on('status', (statusEvent) => {
      setWorkspaceState(prev => ({
        ...prev,
        syncStatus: statusEvent.status as SyncStatus,
      }));
    });

    return () => {
      unSnapshot();
      unDelta();
      unStatus();
    };
  }, [client, applyUpdate]);

  const isSelectionEditable = useMemo(() => {
    return isItemEditable(
      workspaceState.viewState.selectedId,
      workspaceState.graph,
      workspaceState.bindingReviews
    );
  }, [workspaceState.viewState.selectedId, workspaceState.graph, workspaceState.bindingReviews]);

  return {
    state: workspaceState,
    setState: setWorkspaceState,
    applyUpdate,
    selectNode,
    selectEdge,
    changeScope,
    updateLayout,
    isSelectionEditable,
    lastResolution,
  };
}
