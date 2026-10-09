import type { Graph, ProgramNode, ProgramEdge, Project, Analysis, Layout } from '../shared/model';

export type SyncStatus = 'updating' | 'current' | 'partial' | 'stale';

export interface ViewState {
  selectedId: string | null;
  selectedType: 'node' | 'edge' | 'project' | null;
  activeScope: string | null; // null represents root/global scope, otherwise node.id of container
  searchQuery: string;
  panels: {
    tree: boolean;
    canvas: boolean;
    inspector: boolean;
    source: boolean;
    review: boolean;
  };
}

export interface SpecificationState {
  project: Project | null;
  specRevision: number;
  specification: Graph | null;
  layout: Layout;
}

export interface AnalysisState {
  analysis: Analysis | null;
  status: SyncStatus;
  lastChecked: number | null;
}

export interface WorkspaceError {
  title: string;
  message: string;
  actionableSteps: string[];
  statusCode?: number;
  isConnectionError?: boolean;
}
