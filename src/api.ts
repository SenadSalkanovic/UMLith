import type {
  CreateProjectRequest,
  LayoutResponse,
  ApiErrorResponse,
  RevisionRecord,
  StartAnalysisRequest,
  AnalysisStatusResponse,
  ImportQualityReportResponse,
  AnalysisResponse,
  AcceptBindingRequest,
  BindingReviewsResponse,
  DivergenceReportResponse,
  ProposalReviewResponse,
} from '../shared/api';
import type { Graph, Layout, Project, Analysis, ProgramNode, BindingReviewRecord, DivergenceReport, AgentJob } from '../shared/model';
import { ProposalReviewResponseSchema } from '../shared/api';

export async function getProposals(id: string, baseUrl?: string): Promise<ProposalReviewResponse[]> {
  const proposals = await request<unknown[]>(`/projects/${id}/proposals`, {}, baseUrl);
  return proposals.map(proposal => ProposalReviewResponseSchema.parse(proposal));
}
export async function acceptProposal(id: string, proposalId: string, expectedRevision: number, baseUrl?: string): Promise<Project> {
  return request<Project>(`/projects/${id}/proposals/${proposalId}/accept`, {
    method: 'POST', body: JSON.stringify({ expectedRevision }),
  }, baseUrl);
}
export async function rejectProposal(id: string, proposalId: string, baseUrl?: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/projects/${id}/proposals/${proposalId}/reject`, { method: 'POST', body: '{}' }, baseUrl);
}

export class ApiConnectionError extends Error {
  public actionableSteps: string[];
  public statusCode?: number;
  public isConnectionError: boolean;
  public expectedRevision?: number;
  public currentRevision?: number;
  public projectId?: string;
  public details?: ApiErrorResponse | null;

  constructor(
    message: string,
    actionableSteps?: string[],
    statusCode?: number,
    isConnectionError = true,
    details?: ApiErrorResponse | null
  ) {
    super(message);
    this.name = 'ApiConnectionError';
    this.statusCode = statusCode;
    this.isConnectionError = isConnectionError;
    this.details = details;
    if (details) {
      this.expectedRevision = details.expectedRevision;
      this.currentRevision = details.currentRevision;
      this.projectId = details.projectId;
    }
    this.actionableSteps = actionableSteps && actionableSteps.length > 0 ? actionableSteps : [
      'Verify that the local architecture workspace service is running (`npm start` or `npm run dev`).',
      'Check that the service is listening on loopback at http://127.0.0.1:4317.',
      'Check that your browser is connecting from an allowed origin (http://127.0.0.1:5173 or http://localhost:5173).',
    ];
  }
}

const DEFAULT_API_BASE = '/api';

function resolveUrl(path: string, baseUrl?: string): string {
  const base = baseUrl ?? DEFAULT_API_BASE;
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

async function request<T>(path: string, options: RequestInit = {}, baseUrl?: string, asBlob = false): Promise<T> {
  const url = resolveUrl(path, baseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (err: any) {
    throw new ApiConnectionError(
      `Unable to reach local architecture service at ${url}: ${err?.message || 'Network request failed'}`,
      [
        'Verify that the local architecture service is running (`npm start` or `npm run dev`).',
        'Check that the service is bound to loopback at http://127.0.0.1:4317.',
        'Ensure the host header and network permissions allow loopback connections.',
      ],
      undefined,
      true
    );
  }

  if (!res.ok) {
    let errorData: ApiErrorResponse | null = null;
    try {
      errorData = await res.json();
    } catch {
      // not JSON
    }

    const message = errorData?.message || `Request failed with status ${res.status} ${res.statusText}`;
    const steps: string[] = [];

    if (res.status === 403) {
      steps.push('Check that the browser origin is allowed by the loopback service policy (127.0.0.1:5173).');
      steps.push('Ensure the request host is loopback (127.0.0.1, localhost, or ::1).');
    } else if (res.status === 404) {
      steps.push('The requested project or resource does not exist.');
      steps.push('Check the project ID or return to the workspace home.');
    } else if (res.status === 409) {
      steps.push('Specification conflict detected. Reload the latest revision from the server.');
    } else {
      steps.push('Inspect server logs for diagnostic output.');
    }

    throw new ApiConnectionError(
      message,
      steps,
      res.status,
      false,
      errorData
    );
  }

  return (asBlob ? res.blob() : res.json()) as Promise<T>;
}

export type AgentTaskRequest = {
  task: string; scope: string[]; kind: 'implementation' | 'design';
  settings: { provider: 'hosted' | 'ollama' | 'lmstudio'; model?: string; timeoutMinutes: number };
};
export type AgentCapabilities = { available: boolean; reason: string | null; providers: string[] };
export type ResultEnvelope = {
  schemaVersion: 1; handoffId: string; projectId: string; specRevision: number; sourceHashes: Record<string, string>;
  task: string; scope: string[]; files: Record<string, string | null>;
};
export const getAgentCapabilities = (baseUrl?: string) => request<AgentCapabilities>('/agent/capabilities', {}, baseUrl);
export const getJobs = (id: string, baseUrl?: string) => request<AgentJob[]>(`/projects/${id}/jobs`, {}, baseUrl);
export const getJob = (id: string, jobId: string, baseUrl?: string) => request<AgentJob>(`/projects/${id}/jobs/${jobId}`, {}, baseUrl);
export const createJob = (id: string, task: AgentTaskRequest, baseUrl?: string) => request<AgentJob>(`/projects/${id}/jobs`, { method: 'POST', body: JSON.stringify(task) }, baseUrl);
export const decideJob = (id: string, jobId: string, action: 'cancel' | 'apply' | 'revalidate', baseUrl?: string) => request<AgentJob>(`/projects/${id}/jobs/${jobId}/${action}`, { method: 'POST', body: '{}' }, baseUrl);
export const importResult = (id: string, result: unknown, baseUrl?: string) => request<AgentJob>(`/projects/${id}/results`, { method: 'POST', body: JSON.stringify(result) }, baseUrl);
export const exportPackage = (id: string, task: string, scope: string[], baseUrl?: string) => request<Blob>(`/projects/${id}/export`, { method: 'POST', body: JSON.stringify({ task, scope }) }, baseUrl, true);
export const getHandoff = (id: string, task: string, scope: string[], baseUrl?: string) => request<{ handoffId: string; specRevision: number; sourceHashes: Record<string, string> }>(`/projects/${id}/handoff?${new URLSearchParams({ task, scope: JSON.stringify(scope) })}`, {}, baseUrl);
export const getRecovery = (id: string, retry = false, baseUrl?: string) => request<{ conflicts: string[] }>(`/projects/${id}/recovery`, retry ? { method: 'POST', body: '{}' } : {}, baseUrl);

export async function checkHealth(baseUrl?: string): Promise<{ status: string }> {
  return request<{ status: string }>('/health', { method: 'GET' }, baseUrl);
}

export async function getProjects(baseUrl?: string): Promise<Project[]> {
  return request<Project[]>('/projects', { method: 'GET' }, baseUrl);
}

export async function getProject(id: string, baseUrl?: string): Promise<Project> {
  return request<Project>(`/projects/${id}`, { method: 'GET' }, baseUrl);
}

export async function createProject(data: CreateProjectRequest, baseUrl?: string): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  }, baseUrl);
}

export async function createBlankProject(
  data: { name: string; description?: string; target?: string },
  baseUrl?: string
): Promise<Project> {
  return createProject({
    name: data.name,
    description: data.description || '',
    target: data.target || 'TypeScript application',
  }, baseUrl);
}

export async function registerExistingProject(
  data: { name: string; root: string; description?: string; target?: string },
  baseUrl?: string
): Promise<Project> {
  return createProject({
    name: data.name,
    description: data.description || '',
    target: data.target || 'TypeScript application',
    root: data.root,
  }, baseUrl);
}

export async function adoptImplementedArchitecture(
  id: string,
  expectedRevision: number,
  implementedGraph: Graph,
  baseUrl?: string
): Promise<Project> {
  return updateSpecification(id, expectedRevision, implementedGraph, baseUrl);
}

export async function getSpecification(id: string, baseUrl?: string): Promise<Graph> {
  return request<Graph>(`/projects/${id}/specification`, { method: 'GET' }, baseUrl);
}

export async function updateSpecification(
  id: string,
  expectedRevision: number,
  graph: Graph,
  baseUrl?: string
): Promise<Project> {
  return request<Project>(`/projects/${id}/specification`, {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision, graph }),
  }, baseUrl);
}

export async function getSpecificationHistory(
  id: string,
  baseUrl?: string
): Promise<RevisionRecord[]> {
  return request<RevisionRecord[]>(`/projects/${id}/revisions`, { method: 'GET' }, baseUrl);
}

export async function getLayout(id: string, baseUrl?: string): Promise<LayoutResponse> {
  return request<LayoutResponse>(`/projects/${id}/layout`, { method: 'GET' }, baseUrl);
}

export async function updateLayout(
  id: string,
  layout: Layout,
  view?: string,
  baseUrl?: string
): Promise<Project> {
  return request<Project>(`/projects/${id}/layout`, {
    method: 'PUT',
    body: JSON.stringify({ layout, view }),
  }, baseUrl);
}

export async function getChecks(
  id: string,
  baseUrl?: string
): Promise<Record<string, { command: string; args: string[] }>> {
  return request<Record<string, { command: string; args: string[] }>>(`/projects/${id}/checks`, { method: 'GET' }, baseUrl);
}

export async function updateChecks(
  id: string,
  checks: Record<string, { command: string; args: string[] }>,
  baseUrl?: string
): Promise<Project> {
  return request<Project>(`/projects/${id}/checks`, {
    method: 'PUT',
    body: JSON.stringify(checks),
  }, baseUrl);
}

export interface ProjectFileResponse {
  path: string;
  text: string;
  hash: string;
  revision?: string;
  captured?: boolean;
}

export async function getProjectFile(
  id: string,
  path: string,
  revision?: string,
  baseUrl?: string
): Promise<ProjectFileResponse> {
  const query = new URLSearchParams({ path });
  if (revision) query.set('revision', revision);
  return request<ProjectFileResponse>(`/projects/${id}/files?${query.toString()}`, { method: 'GET' }, baseUrl);
}

export async function startAnalysis(
  id: string,
  options?: StartAnalysisRequest,
  baseUrl?: string
): Promise<AnalysisResponse> {
  return request<AnalysisResponse>(`/projects/${id}/analysis`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  }, baseUrl);
}

export async function getAnalysisStatus(
  id: string,
  baseUrl?: string
): Promise<AnalysisStatusResponse> {
  return request<AnalysisStatusResponse>(`/projects/${id}/analysis/status`, { method: 'GET' }, baseUrl);
}

export async function getAnalysisSnapshot(
  id: string,
  baseUrl?: string
): Promise<Analysis> {
  return request<Analysis>(`/projects/${id}/analysis/snapshot`, { method: 'GET' }, baseUrl);
}

export async function getAnalysisReport(
  id: string,
  baseUrl?: string
): Promise<ImportQualityReportResponse> {
  return request<ImportQualityReportResponse>(`/projects/${id}/analysis/report`, { method: 'GET' }, baseUrl);
}

export async function importProject(
  id: string,
  options?: StartAnalysisRequest,
  baseUrl?: string
): Promise<AnalysisResponse> {
  return request<AnalysisResponse>(`/projects/${id}/import`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  }, baseUrl);
}

export async function rescanProject(
  id: string,
  options?: { async?: boolean } | string,
  baseUrl?: string
): Promise<AnalysisResponse> {
  const opts = typeof options === 'string' ? {} : (options ?? {});
  const base = typeof options === 'string' ? options : baseUrl;
  return request<AnalysisResponse>(`/projects/${id}/rescan`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }, base);
}

export async function resumeProject(
  id: string,
  options?: { async?: boolean } | string,
  baseUrl?: string
): Promise<{ projectId: string; status: string; revision?: string | null; sequence?: number; changed?: boolean; analysis?: Analysis }> {
  const opts = typeof options === 'string' ? {} : (options ?? {});
  const base = typeof options === 'string' ? options : baseUrl;
  return request<{ projectId: string; status: string; revision?: string | null; sequence?: number; changed?: boolean; analysis?: Analysis }>(`/projects/${id}/resume`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }, base);
}

export async function reconcileProject(
  id: string,
  options?: { force?: boolean; async?: boolean } | string,
  baseUrl?: string
): Promise<{ projectId: string; changed: boolean; status: string; revision?: string | null; sequence?: number; analysis?: Analysis }> {
  const opts = typeof options === 'string' ? {} : (options ?? {});
  const base = typeof options === 'string' ? options : baseUrl;
  return request<{ projectId: string; changed: boolean; status: string; revision?: string | null; sequence?: number; analysis?: Analysis }>(`/projects/${id}/reconcile`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }, base);
}

export async function getBindingReviews(
  id: string,
  baseUrl?: string
): Promise<BindingReviewsResponse> {
  return request<BindingReviewsResponse>(`/projects/${id}/bindings`, { method: 'GET' }, baseUrl);
}

export async function acceptBinding(
  id: string,
  requestData: AcceptBindingRequest,
  baseUrl?: string
): Promise<{ success: boolean; project: Project; node: ProgramNode; bindingReviews: BindingReviewRecord[] }> {
  return request<{ success: boolean; project: Project; node: ProgramNode; bindingReviews: BindingReviewRecord[] }>(`/projects/${id}/bindings/accept`, {
    method: 'POST',
    body: JSON.stringify(requestData),
  }, baseUrl);
}

export async function getDivergenceReport(
  id: string,
  baseUrl?: string
): Promise<DivergenceReportResponse> {
  return request<DivergenceReportResponse>(`/projects/${id}/divergence`, { method: 'GET' }, baseUrl);
}
