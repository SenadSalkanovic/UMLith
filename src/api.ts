import type {
  CreateProjectRequest,
  LayoutResponse,
  ApiErrorResponse,
} from '../shared/api';
import type { Graph, Layout, Project } from '../shared/model';

export class ApiConnectionError extends Error {
  public actionableSteps: string[];
  public statusCode?: number;
  public isConnectionError: boolean;

  constructor(message: string, actionableSteps?: string[], statusCode?: number, isConnectionError = true) {
    super(message);
    this.name = 'ApiConnectionError';
    this.statusCode = statusCode;
    this.isConnectionError = isConnectionError;
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

async function request<T>(path: string, options: RequestInit = {}, baseUrl?: string): Promise<T> {
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
      false
    );
  }

  return res.json() as Promise<T>;
}

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
