import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { ProjectStore, SpecificationConflictError } from './store';
import { AppError, safePath, hash, isPathExcluded, captureFiles, hashes, isRevisionIncomplete } from './files';
import {renderPlantUml} from './plantuml';
import {GraphSchema} from '../shared/model';
import { exportBundle } from './export';
import {prepareHandoff,readHandoff,handoffArchive,HandoffId,checkHandoffConnection} from './handoff';
import { HandoffSpecificationSchema } from '../shared/export';
import { recoverPending, recoveryStatus } from './application';
import { AnalysisWorker } from './worker';
import { generateImportQualityReport, type ImportQualityReport } from './analyzer';
import { randomUUID } from 'node:crypto';
import { SyncService, type SyncServiceOptions } from './sync';
import { JobService } from './jobs';
import { AnalysisSchema, emptyGraph, createGraphUpdate, type Analysis } from '../shared/model';
import { reconcileSourceBindings, acceptBindingCandidate, computeDivergenceReport } from './review';
import {
  CreateProjectRequestSchema,
  UpdateSpecificationRequestSchema,
  UpdateLayoutRequestSchema,
  ProjectIdParamSchema,
  ChecksSchema,
  StartAnalysisRequestSchema,
  AnalysisStatusResponseSchema,
  ImportQualityReportSchema,
  AnalysisSnapshotResponseSchema,
  AnalysisResponseSchema,
  SseReadyEventSchema,
  SseStatusEventSchema,
  SseDeltaEventSchema,
  SseDiagnosticsEventSchema,
  AcceptBindingRequestSchema,
  BindingReviewsResponseSchema,
  SseBindingReviewEventSchema,
  DivergenceReportResponseSchema,
  ProposalIdParamSchema,
  AcceptProposalRequestSchema,
  SseDivergenceEventSchema,
} from '../shared/api';

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
  'http://127.0.0.1:4317',
  'http://localhost:4317',
  'http://[::1]:4317',
] as const;

export function isWildcardHost(host: string): boolean {
  if (!host) return true;
  const h = host.trim().toLowerCase();
  return h === '0.0.0.0' || h === '::' || h === '0' || h === '[::]' || h === '0.0.0.0/0';
}

export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    return true;
  }
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(h);
}

export function extractHostName(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end !== -1 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0];
}

export interface OriginCheckOptions {
  allowedOrigins?: string[];
  port?: number;
}

export function isAllowedOrigin(
  origin: string | undefined | null,
  options: OriginCheckOptions = {}
): boolean {
  if (!origin) return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === 'null') return false;

  const allowedList = (options.allowedOrigins || []).map(o => o.trim().toLowerCase());
  if (allowedList.includes(trimmed.toLowerCase())) return true;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (allowedList.includes(parsed.origin.toLowerCase())) return true;

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  if (!isLoopbackHost(parsed.hostname)) {
    return false;
  }

  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);

  // Vite development server default port
  if (port === 5173) return true;

  // Server default port
  if (port === 4317) return true;

  // Specific or dynamically bound server port
  if (options.port && port === options.port) return true;

  return false;
}

export interface ServerOptions {
  store?: ProjectStore;
  storeDir?: string;
  worker?: AnalysisWorker;
  sync?: SyncService;
  syncOptions?: SyncServiceOptions;
  logger?: boolean | object;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  staticDir?: string;
}

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const store = options.store ?? new ProjectStore(
    options.storeDir ?? process.env.DATA_DIR ?? process.env.ARCHITECT_DATA_DIR ?? join(process.cwd(), '.workspace-data')
  );

  const ownsWorker = !options.worker;
  const worker = options.worker ?? new AnalysisWorker();

  const ownsSync = !options.sync;
  const sync = options.sync ?? new SyncService(store, { worker, ...options.syncOptions });
  const jobs = new JobService(store, sync);
  await recoverPending(store);
  await jobs.recover();
  jobs.on('notification', (projectId, event) => sync.emit('notification', projectId, event));

  const defaultHost = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(defaultHost)) {
    throw new Error(`Cannot configure service with non-loopback host "${defaultHost}". Service must bind to loopback (127.0.0.1, ::1, or localhost).`);
  }

  const envAllowed = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const configuredAllowedOrigins = [
    ...(options.allowedOrigins ?? []),
    ...envAllowed,
  ];

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024 * 1024,
  });

  app.decorate('store', store);
  app.decorate('worker', worker);
  app.decorate('sync', sync);

  const activeSubscriptions = new Map<string, {
    id: string;
    projectId?: string;
    cleanup: () => void;
  }>();
  const projectSubscriptions = new Map<string, Set<string>>();

  app.decorate('getActiveSubscriptions', () => activeSubscriptions.size);
  app.decorate('getProjectSubscriptions', (id: string) => projectSubscriptions.get(id)?.size ?? 0);

  const activeAnalyses = new Map<string, { startedAt: string; promise: Promise<{ analysis: Analysis; report: ImportQualityReport }> }>();

  app.addHook('onClose', async () => {
    for (const sub of Array.from(activeSubscriptions.values())) {
      sub.cleanup();
    }
    activeSubscriptions.clear();
    projectSubscriptions.clear();

    await jobs.close();
    await sync.close();
    if (ownsWorker) {
      await worker.close();
    }
  });

  // Enforce loopback Host and precise Origin policy
  app.addHook('onRequest', async (request, reply) => {
    // 1. Host header validation for DNS rebinding protection
    if (request.headers.host) {
      const hostName = extractHostName(request.headers.host);
      if (!isLoopbackHost(hostName)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Foreign host header not allowed: ${request.headers.host}`,
          statusCode: 403,
        });
      }
    }

    // 2. Active listening port (if bound)
    const serverAddress = app.server?.address();
    const activePort = typeof serverAddress === 'object' && serverAddress ? serverAddress.port : options.port;

    const origin = request.headers.origin;
    const secFetchSite = request.headers['sec-fetch-site'];

    // 3. Origin header enforcement
    if (origin) {
      const allowed = isAllowedOrigin(origin, {
        allowedOrigins: configuredAllowedOrigins,
        port: activePort,
      });

      if (!allowed) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Foreign origin not allowed: ${origin}`,
          statusCode: 403,
        });
      }

      // Preflight OPTIONS handling
      if (request.method === 'OPTIONS') {
        return reply
          .header('Access-Control-Allow-Origin', origin)
          .header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
          .header('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-Requested-With, Accept, Origin')
          .header('Access-Control-Max-Age', '86400')
          .header('Vary', 'Origin')
          .status(204)
          .send();
      }

      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    } else {
      // Reject cross-site requests that attempt to omit Origin
      if (secFetchSite === 'cross-site') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Cross-site request without allowed origin rejected',
          statusCode: 403,
        });
      }

      if (request.method === 'OPTIONS') {
        return reply
          .header('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
          .status(204)
          .send();
      }
    }

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;

    if (error instanceof ZodError) {
      const issues = error.issues;
      const message = issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
      return reply.status(400).send({
        error: 'Bad Request',
        message: message || 'Validation failed',
        statusCode: 400,
        issues,
      });
    }

    if (error instanceof SpecificationConflictError) {
      return reply.status(409).send({
        error: 'Conflict',
        message: error.message,
        statusCode: 409,
        projectId: error.projectId,
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision,
      });
    }

    if (error instanceof AppError) {
      const statusCode = error.statusCode;
      const errorTitle = statusCode === 404 ? 'Not Found' : statusCode === 409 ? 'Conflict' : statusCode === 403 ? 'Forbidden' : 'Bad Request';
      return reply.status(statusCode).send({
        error: errorTitle,
        message: error.message,
        statusCode,
      });
    }

    if (error instanceof SyntaxError) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message,
        statusCode: 400,
      });
    }

    const err = error as { statusCode?: number; message?: string; name?: string };
    const fastifyStatus = err?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      return reply.status(fastifyStatus).send({
        error: fastifyStatus === 404 ? 'Not Found' : 'Bad Request',
        message: err?.message || 'Bad Request',
        statusCode: fastifyStatus,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: 'Internal Server Error',
      message: err?.message || 'Internal server error',
      statusCode: 500,
    });
  });

  const staticDir = options.staticDir ?? (existsSync(resolve(process.cwd(), 'dist')) ? resolve(process.cwd(), 'dist') : undefined);
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      wildcard: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (staticDir && existsSync(join(staticDir, 'index.html')) && request.method === 'GET' && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  // Health check
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/diagrams/plantuml', async request => {
    const input=z.object({graph:GraphSchema,view:z.enum(['overview','classes','database']),scopeId:z.string().nullable().optional(),functionId:z.string().nullable().optional(),selectedId:z.string().nullable().optional(),showMembers:z.boolean().optional()}).strict().parse(request.body);
    return renderPlantUml(input);
  });

  const handoffRequest = z.object({task: HandoffSpecificationSchema.shape.task, scope: HandoffSpecificationSchema.shape.scope}).strict();
  const jobParams = z.object({id: ProjectIdParamSchema.shape.id, jobId: z.string().regex(/^[a-zA-Z0-9-]+$/)}).strict();
  app.get('/api/agent/capabilities', () => jobs.capabilities());
  app.post('/api/projects/:id/export', async (request, reply) => {
    const {id} = ProjectIdParamSchema.parse(request.params);
    const input = handoffRequest.parse(request.body);
    const archive = exportBundle(await store.get(id), input.task, input.scope);
    return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="umlith-handoff.zip"').send(Buffer.from(archive));
  });
  app.get('/api/projects/:id/handoff', async request => {
    const {id} = ProjectIdParamSchema.parse(request.params);
    const query = z.object({task: z.string().default('Implement the approved specification'), scope: z.string().default('["."]')}).strict().parse(request.query);
    let scope: unknown;
    try {scope = JSON.parse(query.scope);} catch {throw new AppError('Scope must be a JSON array');}
    const input = handoffRequest.parse({task: query.task, scope});
    const project = await store.get(id);
    const files = await captureFiles(project.root);
    if (isRevisionIncomplete(files)) throw new AppError('Source changed while preparing the handoff. Retry.',409);
    if((await store.get(id)).specRevision!==project.specRevision)throw new AppError('Specification changed while preparing the handoff. Retry.',409);
    const snapshot=await prepareHandoff(project,input.task,input.scope,hashes(files),store.projectDir(id));
    if((await store.get(id)).specRevision!==project.specRevision)throw new AppError('Specification changed while preparing the handoff. Retry.',409);
    return snapshot;
  });
  const snapshotParams=z.object({id:ProjectIdParamSchema.shape.id,handoffId:HandoffId}).strict();
  app.get('/api/projects/:id/handoffs/:handoffId',async request=>{
    const {id,handoffId}=snapshotParams.parse(request.params);await store.get(id);
    return readHandoff(store.projectDir(id),handoffId);
  });
  app.post('/api/projects/:id/handoffs/:handoffId/check',async request=>{
    const {id,handoffId}=snapshotParams.parse(request.params);await store.get(id);
    return checkHandoffConnection(await readHandoff(store.projectDir(id),handoffId),store.projectDir(id));
  });
  app.get('/api/projects/:id/handoffs/:handoffId/download',async(request,reply)=>{
    const {id,handoffId}=snapshotParams.parse(request.params);await store.get(id);
    const snapshot=await readHandoff(store.projectDir(id),handoffId);
    return reply.type('application/zip').header('Content-Disposition','attachment; filename="umlith-handoff.zip"').send(Buffer.from(handoffArchive(snapshot)));
  });
  app.get('/api/projects/:id/jobs', async request => {
    const {id} = ProjectIdParamSchema.parse(request.params);return jobs.list(id);
  });
  app.post('/api/projects/:id/jobs', async (request, reply) => {
    const {id} = ProjectIdParamSchema.parse(request.params);return reply.status(202).send(await jobs.create(id,request.body));
  });
  app.get('/api/projects/:id/jobs/:jobId', async request => {
    const {id,jobId} = jobParams.parse(request.params);await store.get(id);return jobs.get(id,jobId);
  });
  app.post('/api/projects/:id/jobs/:jobId/cancel', async request => {
    const {id,jobId} = jobParams.parse(request.params);return jobs.cancel(id,jobId);
  });
  app.post('/api/projects/:id/jobs/:jobId/apply', async request => {
    const {id,jobId} = jobParams.parse(request.params);return jobs.apply(id,jobId);
  });
  app.post('/api/projects/:id/jobs/:jobId/revalidate', async request => {
    const {id,jobId} = jobParams.parse(request.params);return jobs.revalidate(id,jobId);
  });
  app.post('/api/projects/:id/results', async (request,reply) => {
    const {id} = ProjectIdParamSchema.parse(request.params);return reply.status(201).send(await jobs.importResult(id,request.body));
  });
  app.get('/api/projects/:id/recovery', async request => {
    const {id} = ProjectIdParamSchema.parse(request.params);return {conflicts: await recoveryStatus(store,id)};
  });
  app.post('/api/projects/:id/recovery', async request => {
    const {id} = ProjectIdParamSchema.parse(request.params);await recoverPending(store,id);await sync.request(id);return {conflicts: await recoveryStatus(store,id)};
  });

  // Projects endpoints
  app.get('/api/projects', async (request, reply) => {
    const list = await store.list();
    return reply.send(list);
  });

  app.post('/api/projects', async (request, reply) => {
    const input = CreateProjectRequestSchema.parse(request.body);
    if (input.root) {
      try {
        const s = await stat(input.root);
        if (!s.isDirectory()) {
          throw new AppError('Project root must be a directory', 400);
        }
      } catch (err: any) {
        if (err instanceof AppError) throw err;
        throw new AppError(`Project root does not exist: ${input.root}`, 400);
      }
    }
    try {
      const project = await store.create(input);
      return reply.status(201).send(project);
    } catch (err: any) {
      if (err instanceof ZodError || err instanceof AppError || err instanceof SpecificationConflictError) {
        throw err;
      }
      throw new AppError(err.message, 400);
    }
  });

  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    return reply.send(project);
  });

  app.get('/api/projects/:id/proposals', async request => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    await store.get(id);
    const proposals = (await store.jobs(id)).filter(job => job.kind === 'design' && job.proposal);
    return Promise.all(proposals.map(job => jobs.getProposalReview(id, job.id)));
  });
  app.get('/api/projects/:id/proposals/:proposalId', async request => {
    const { id, proposalId } = ProposalIdParamSchema.parse(request.params);
    return jobs.getProposalReview(id, proposalId);
  });
  app.post('/api/projects/:id/proposals/:proposalId/accept', async request => {
    const { id, proposalId } = ProposalIdParamSchema.parse(request.params);
    const { expectedRevision } = AcceptProposalRequestSchema.parse(request.body);
    return jobs.acceptProposal(id, proposalId, expectedRevision);
  });
  app.post('/api/projects/:id/proposals/:proposalId/reject', async request => {
    const { id, proposalId } = ProposalIdParamSchema.parse(request.params);
    await jobs.rejectProposal(id, proposalId);
    return { success: true };
  });

  // Specification endpoints
  const updateSpecHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const { expectedRevision, graph, projectDescription } = UpdateSpecificationRequestSchema.parse(request.body);
    const updated = await store.updateSpec(id, expectedRevision, graph, projectDescription);
    return reply.send(updated);
  };

  const getSpecHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    return reply.send(project.specification);
  };

  app.put('/api/projects/:id/specification', updateSpecHandler);
  app.put('/api/projects/:id/spec', updateSpecHandler);
  app.get('/api/projects/:id/specification', getSpecHandler);
  app.get('/api/projects/:id/spec', getSpecHandler);

  // Specification history endpoints
  const historyHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const history = await store.history(id);
    return reply.send(history);
  };

  app.get('/api/projects/:id/revisions', historyHandler);
  app.get('/api/projects/:id/history', historyHandler);

  // Layout endpoints
  const updateLayoutHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const { layout, view } = UpdateLayoutRequestSchema.parse(request.body);
    const updated = await store.updateLayout(id, layout, view);
    return reply.send(updated);
  };

  app.put('/api/projects/:id/layout', updateLayoutHandler);
  app.patch('/api/projects/:id/layout', updateLayoutHandler);

  app.get('/api/projects/:id/layout', async (request, reply) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    return reply.send({
      layout: project.layout,
      layoutRevision: project.layoutRevision ?? 0,
      scopedLayouts: project.scopedLayouts ?? {},
    });
  });

  // Checks endpoints
  app.put('/api/projects/:id/checks', async (request, reply) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const checks = ChecksSchema.parse(request.body);
    const updated = await store.updateChecks(id, checks);
    return reply.send(updated);
  });

  app.get('/api/projects/:id/checks', async (request, reply) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    return reply.send(project.checks);
  });

  // Analysis and import endpoints (T045)
  const startAnalysisHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const body = StartAnalysisRequestSchema.parse(request.body ?? {});
    const project = await store.get(id);

    const rootPath = body.root ? await safePath(project.root, body.root) : project.root;
    const s = await stat(rootPath);
    if (!s.isDirectory()) {
      throw new AppError('Project root is not a directory', 400);
    }

    const isAsync = body.async === true || request.query?.async === 'true' || request.query?.async === '1';

    let active = activeAnalyses.get(id);
    if (!active) {
      const executeAnalysis = async () => {
        const cur = await store.get(id).catch(() => project);
        sync.emit('notification', id, {
          type: 'status',
          projectId: id,
          status: 'updating',
          sequence: cur.analysis?.sequence || 0,
          revision: cur.analysis?.revision || null,
        });
        try {
          const result = await worker.analyzeAndReport(rootPath, body.options);
          const prev = await store.get(id);
          result.analysis.sequence = (prev.analysis?.sequence || 0) + 1;
          AnalysisSchema.parse(result.analysis);
          const update = createGraphUpdate(prev.analysis, result.analysis, id);
          await store.updateAnalysis(id, result.analysis);
          sync.emit('notification', id, update);
          return result;
        } catch (err: any) {
          const staleEvidence = { scope: 'all' as const, paths: [], reason: err.message };
          const currentProject = await store.get(id).catch(() => project);
          const stale: Analysis = currentProject.analysis
            ? {
                ...currentProject.analysis,
                status: 'stale',
                staleEvidence,
                quality: {
                  ...currentProject.analysis.quality,
                  diagnostics: [
                    ...currentProject.analysis.quality.diagnostics.filter(d => d.code !== 'analysis-failure'),
                    { severity: 'error', code: 'analysis-failure', message: err.message },
                  ],
                },
              }
            : {
                revision: '',
                sequence: 0,
                analyzedAt: new Date().toISOString(),
                status: 'stale',
                staleEvidence,
                graph: emptyGraph(),
                files: {},
                durationMs: 0,
                quality: {
                  eligibleFiles: 0,
                  analyzedFiles: 0,
                  unresolvedReferences: 0,
                  unsupportedConstructs: 0,
                  inferredItems: 0,
                  prismaValidation: 'unavailable',
                  diagnostics: [{ severity: 'error', code: 'analysis-failure', message: err.message }],
                },
              };
          try {
            await store.updateAnalysis(id, stale);
          } catch {}
          sync.emit('notification', id, {
            type: 'status',
            projectId: id,
            status: 'stale',
            sequence: stale.sequence,
            revision: stale.revision,
            quality: stale.quality,
            diagnostics: stale.quality.diagnostics,
            staleEvidence,
            message: err.message,
          });
          throw err;
        } finally {
          activeAnalyses.delete(id);
        }
      };

      const promise = executeAnalysis();
      active = { startedAt: new Date().toISOString(), promise };
      activeAnalyses.set(id, active);
    }

    if (isAsync) {
      return reply.status(202).send({
        projectId: id,
        status: 'updating',
        message: 'Analysis started',
      });
    }

    try {
      const { analysis, report } = await active.promise;
      return reply.status(200).send({
        analysis,
        report,
        status: analysis.status,
        revision: analysis.revision,
        sequence: analysis.sequence,
      });
    } catch (err: any) {
      const statusCode = err instanceof AppError ? err.statusCode : (err?.statusCode || 400);
      return reply.status(statusCode).send({
        error: statusCode === 404 ? 'Not Found' : 'Bad Request',
        message: err.message,
        statusCode,
        diagnostics: [{ severity: 'error', code: 'analysis-failure', message: err.message }],
      });
    }
  };

  app.post('/api/projects/:id/analysis', startAnalysisHandler);
  app.post('/api/projects/:id/analysis/start', startAnalysisHandler);
  app.post('/api/projects/:id/import', startAnalysisHandler);
  app.post('/api/projects/:id/analyze', startAnalysisHandler);

  // Manual full rescan endpoints (T060)
  const rescanHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    const isAsync = request.body?.async === true || request.query?.async === 'true' || request.query?.async === '1';

    if (!sync.hasSession(id)) {
      await sync.start(id);
    }

    if (isAsync) {
      void sync.rescan(id, { force: true }).catch(err => {
        app.log.error(err);
        sync.emit('notification', id, { type: 'error', projectId: id, message: err.message });
      });
      return reply.status(202).send({
        projectId: id,
        status: 'updating',
        message: 'Manual full rescan started',
      });
    }

    try {
      await sync.rescan(id, { force: true });
      const updated = await store.get(id);
      const analysis = updated.analysis || project.analysis;
      return reply.status(200).send({
        projectId: id,
        status: analysis?.status || 'current',
        revision: analysis?.revision ?? null,
        sequence: analysis?.sequence ?? 0,
        analysis,
      });
    } catch (err: any) {
      const statusCode = err instanceof AppError ? err.statusCode : (err?.statusCode || 400);
      return reply.status(statusCode).send({
        error: statusCode === 404 ? 'Not Found' : 'Bad Request',
        message: err.message,
        statusCode,
      });
    }
  };

  app.post('/api/projects/:id/rescan', rescanHandler);
  app.post('/api/projects/:id/sync/rescan', rescanHandler);

  // Application resume endpoints (T060)
  const resumeHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    const isAsync = request.body?.async === true || request.query?.async === 'true' || request.query?.async === '1';

    if (!sync.hasSession(id)) {
      await sync.start(id);
    }

    if (isAsync) {
      void sync.resume(id).catch(err => {
        app.log.error(err);
        sync.emit('notification', id, { type: 'error', projectId: id, message: err.message });
      });
      return reply.status(202).send({
        projectId: id,
        status: 'updating',
        message: 'Resume reconciliation started',
      });
    }

    try {
      await sync.resume(id);
      const updated = await store.get(id);
      const analysis = updated.analysis || project.analysis;
      return reply.status(200).send({
        projectId: id,
        status: analysis?.status || 'current',
        revision: analysis?.revision ?? null,
        sequence: analysis?.sequence ?? 0,
        analysis,
      });
    } catch (err: any) {
      const statusCode = err instanceof AppError ? err.statusCode : (err?.statusCode || 400);
      return reply.status(statusCode).send({
        error: statusCode === 404 ? 'Not Found' : 'Bad Request',
        message: err.message,
        statusCode,
      });
    }
  };

  app.post('/api/projects/:id/resume', resumeHandler);
  app.post('/api/projects/:id/sync/resume', resumeHandler);

  app.post('/api/resume', async (request: any, reply: any) => {
    const isAsync = request.body?.async === true || request.query?.async === 'true' || request.query?.async === '1';
    if (isAsync) {
      void sync.resume().catch(err => {
        app.log.error(err);
      });
      return reply.status(202).send({
        status: 'updating',
        message: 'Global resume reconciliation started',
      });
    }
    await sync.resume();
    return reply.status(200).send({ status: 'ok', message: 'Resumed all active project sessions' });
  });

  // Hash reconciliation endpoints
  const reconcileHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    const force = request.body?.force === true || request.query?.force === 'true';
    const isAsync = request.body?.async === true || request.query?.async === 'true' || request.query?.async === '1';

    if (!sync.hasSession(id)) {
      await sync.start(id);
    }

    if (isAsync) {
      void sync.reconcile(id, { force }).catch(err => {
        app.log.error(err);
        sync.emit('notification', id, { type: 'error', projectId: id, message: err.message });
      });
      return reply.status(202).send({
        projectId: id,
        status: 'updating',
        message: 'Reconciliation started',
      });
    }

    try {
      const changed = await sync.reconcile(id, { force });
      const updated = await store.get(id);
      const analysis = updated.analysis || project.analysis;
      return reply.status(200).send({
        projectId: id,
        changed,
        status: analysis?.status || 'current',
        revision: analysis?.revision ?? null,
        sequence: analysis?.sequence ?? 0,
        analysis,
      });
    } catch (err: any) {
      const statusCode = err instanceof AppError ? err.statusCode : (err?.statusCode || 400);
      return reply.status(statusCode).send({
        error: statusCode === 404 ? 'Not Found' : 'Bad Request',
        message: err.message,
        statusCode,
      });
    }
  };

  app.post('/api/projects/:id/reconcile', reconcileHandler);
  app.post('/api/projects/:id/sync/reconcile', reconcileHandler);

  const getAnalysisStatusHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    const active = activeAnalyses.get(id);
    const isUpdating = Boolean(active) || sync.isUpdating(id);
    if (isUpdating) {
      return reply.send({
        projectId: id,
        status: 'updating',
        revision: project.analysis?.revision ?? null,
        sequence: project.analysis?.sequence ?? 0,
        quality: project.analysis?.quality,
        diagnostics: project.analysis?.quality?.diagnostics ?? [],
        staleEvidence: project.analysis?.staleEvidence,
      });
    }
    if (!project.analysis) {
      return reply.send({
        projectId: id,
        status: 'stale',
        revision: null,
        sequence: 0,
        diagnostics: [],
      });
    }
    return reply.send({
      projectId: id,
      status: project.analysis.status,
      revision: project.analysis.revision,
      sequence: project.analysis.sequence,
      analyzedAt: project.analysis.analyzedAt,
      durationMs: project.analysis.durationMs,
      quality: project.analysis.quality,
      staleEvidence: project.analysis.staleEvidence,
      diagnostics: project.analysis.quality.diagnostics,
    });
  };

  app.get('/api/projects/:id/analysis/status', getAnalysisStatusHandler);
  app.get('/api/projects/:id/status', getAnalysisStatusHandler);

  const getAnalysisSnapshotHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    if (!project.analysis) {
      throw new AppError(`Analysis snapshot not found for project ${id}`, 404);
    }
    const snapshot = AnalysisSchema.parse(project.analysis);
    return reply.send(snapshot);
  };

  app.get('/api/projects/:id/analysis/snapshot', getAnalysisSnapshotHandler);
  app.get('/api/projects/:id/snapshot', getAnalysisSnapshotHandler);
  app.get('/api/projects/:id/analysis', getAnalysisSnapshotHandler);

  const getAnalysisReportHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const project = await store.get(id);
    if (!project.analysis) {
      throw new AppError(`Import quality report not found for project ${id}`, 404);
    }
    const report = generateImportQualityReport(project.analysis);
    return reply.send(report);
  };

  app.get('/api/projects/:id/analysis/report', getAnalysisReportHandler);
  app.get('/api/projects/:id/report', getAnalysisReportHandler);
  app.get('/api/projects/:id/analysis/quality', getAnalysisReportHandler);
  app.get('/api/projects/:id/quality', getAnalysisReportHandler);

  // Project files and source inspection endpoints (T025)
  const getFileHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const query = request.query as { path?: string; revision?: string } | undefined;
    const wildcard = (request.params as any)['*'];
    const filePath = wildcard || query?.path;
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
      throw new AppError('File path is required', 400);
    }

    if (isPathExcluded(filePath)) {
      throw new AppError(`Access to excluded or sensitive file is not permitted: ${filePath}`, 403);
    }

    const project = await store.get(id);

    // If an analysis revision is explicitly specified, check if captured content is available
    if (query?.revision && project.analysis && project.analysis.revision === query.revision) {
      const captured = project.analysis.files[filePath];
      if (captured) {
        return reply.send({
          path: filePath,
          text: captured.text,
          hash: captured.hash,
          revision: query.revision,
          captured: true,
        });
      }
    }

    // Obey root-boundary file access policy using safePath
    try {
      const validatedPath = await safePath(project.root, filePath, false);
      const relFromRoot = relative(project.root, validatedPath);
      if (isPathExcluded(relFromRoot)) {
        throw new AppError(`Access to excluded or sensitive file is not permitted: ${filePath}`, 403);
      }
      const fileStat = await stat(validatedPath);
      if (!fileStat.isFile()) {
        throw new AppError(`Not a regular project file: ${filePath}`, 400);
      }
      const maxSizeBytes = 20 * 1024 * 1024;
      if (fileStat.size > maxSizeBytes) {
        throw new AppError(`File exceeds 20 MB: ${filePath}`, 400);
      }
      const text = await readFile(validatedPath, 'utf8');
      if (Buffer.byteLength(text) > maxSizeBytes) {
        throw new AppError(`File exceeds 20 MB: ${filePath}`, 400);
      }
      const fileHash = hash(text);
      return reply.send({
        path: filePath,
        text,
        hash: fileHash,
        captured: false,
      });
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      if (err?.code === 'ENOENT') {
        throw new AppError(`File not found: ${filePath}`, 404);
      }
      throw err;
    }
  };

  app.get('/api/projects/:id/files', getFileHandler);
  app.get('/api/projects/:id/files/*', getFileHandler);
  app.get('/api/projects/:id/source', getFileHandler);

  // Binding review endpoints (T061)
  const getBindingsHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const p = await store.get(id);
    const records = p.analysis ? reconcileSourceBindings(p.specification, p.analysis) : [];
    return reply.status(200).send({
      projectId: id,
      records,
    });
  };

  const acceptBindingHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const reqData = AcceptBindingRequestSchema.parse(request.body);
    const p = await store.get(id);
    if (reqData.expectedRevision !== undefined && p.specRevision !== reqData.expectedRevision) {
      throw new SpecificationConflictError(id, reqData.expectedRevision, p.specRevision);
    }
    if (!p.analysis) {
      throw new AppError('Cannot accept binding without active analysis', 400);
    }
    const { graph, updatedNode } = acceptBindingCandidate(
      p.specification,
      reqData.nodeId,
      reqData.candidateId,
      p.analysis,
      { preserveBaseline: reqData.preserveBaseline ?? true }
    );
    const updatedProject = await store.updateSpec(id, reqData.expectedRevision ?? p.specRevision, graph);
    const remainingReviews = reconcileSourceBindings(updatedProject.specification, p.analysis);
    sync.emit('binding-review', id, remainingReviews);
    sync.emit('notification', id, {
      type: 'binding-review',
      projectId: id,
      records: remainingReviews,
    });
    return reply.status(200).send({
      success: true,
      project: updatedProject,
      node: updatedNode,
      bindingReviews: remainingReviews,
    });
  };

  app.get('/api/projects/:id/bindings', getBindingsHandler);
  app.get('/api/projects/:id/binding-reviews', getBindingsHandler);
  app.post('/api/projects/:id/bindings/accept', acceptBindingHandler);
  app.post('/api/projects/:id/binding/accept', acceptBindingHandler);

  const getDivergenceHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const p = await store.get(id);
    let report = sync.getDivergenceReport(id);
    if (!report) {
      const activeAnalysis: Analysis = p.analysis ?? {
        revision: '',
        sequence: 0,
        analyzedAt: new Date().toISOString(),
        status: 'stale' as const,
        graph: emptyGraph(),
        files: {},
        durationMs: 0,
        staleEvidence: { scope: 'all' as const, paths: ['project'], reason: 'No analysis has run yet' },
        quality: {
          eligibleFiles: 0,
          analyzedFiles: 0,
          unresolvedReferences: 0,
          unsupportedConstructs: 0,
          inferredItems: 0,
          prismaValidation: 'not-applicable' as const,
          diagnostics: [],
        },
      };
      report = computeDivergenceReport(p, activeAnalysis);
    }
    return reply.status(200).send({
      success: true,
      projectId: id,
      report,
    });
  };

  app.get('/api/projects/:id/divergence', getDivergenceHandler);
  app.get('/api/projects/:id/drift', getDivergenceHandler);

  // Event streams (SSE)
  const createSseHandler = (forProject: boolean) => {
    return async (request: any, reply: any) => {
      let projectId: string | undefined;
      let project: any;
      if (forProject) {
        const { id } = ProjectIdParamSchema.parse(request.params);
        projectId = id;
        project = await store.get(projectId);
      } else {
        const queryProjectId = (request.query as any)?.projectId;
        if (queryProjectId) {
          projectId = ProjectIdParamSchema.parse({ id: queryProjectId }).id;
          project = await store.get(projectId);
        }
      }

      reply.hijack();
      const corsOrigin = reply.getHeader('access-control-allow-origin');
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': String(corsOrigin), 'Vary': 'Origin' } : {}),
      });

      const writeSseMessage = (eventName: string, eventId: string | number, data: any) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      reply.raw.write(': connected\n\n');

      const query = request.query as { once?: string; watch?: string } | undefined;
      const isOnce = query?.once === 'true' || query?.once === '1';

      if (projectId && query?.watch !== 'false' && !isOnce) {
        if (!sync.hasSession(projectId)) {
          try {
            await sync.start(projectId);
          } catch (err) {
            app.log.error(err);
          }
        } else if (
          request.headers['last-event-id'] ||
          (query as any)?.lastEventId ||
          (query as any)?.reconnect === 'true' ||
          (query as any)?.resume === 'true'
        ) {
          void sync.resume(projectId).catch(err => {
            app.log.error(err);
          });
        }
      }

      const activeProject = projectId ? await store.get(projectId).catch(() => project) : project;
      const currentRevision = activeProject?.analysis?.revision ?? null;
      const currentSequence = activeProject?.analysis?.sequence ?? 0;
      const lastEventId = (request.headers['last-event-id'] as string) || (request.query as any)?.lastEventId;

      const readyEventId = projectId
        ? `${projectId}:${currentRevision ?? 'ready'}:${currentSequence}`
        : `global:ready:0`;

      const readyData = forProject || projectId
        ? {
            projectId,
            status: 'connected',
            analysisStatus: activeProject?.analysis?.status,
            revision: currentRevision,
            sequence: currentSequence,
            ...(lastEventId ? { lastEventId, reconnected: true } : {}),
          }
        : { status: 'connected' };

      writeSseMessage('ready', readyEventId, readyData);

      if (isOnce) {
        reply.raw.end();
        return;
      }

      const subscriptionId = randomUUID();

      const onNotification = (notifProjectId: string, payload: any) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        if (projectId && notifProjectId !== projectId) return;

        const targetProjectId = notifProjectId || projectId;

        if (payload.type === 'status') {
          const statusRevision = payload.revision ?? null;
          const statusSequence = payload.sequence ?? 0;
          const eventId = `${targetProjectId}:${statusRevision ?? 'status'}:${statusSequence}`;
          const statusData = {
            event: 'status',
            type: 'status',
            projectId: targetProjectId,
            status: payload.status,
            revision: statusRevision,
            sequence: statusSequence,
            diagnostics: payload.diagnostics ?? payload.quality?.diagnostics ?? [],
            quality: payload.quality,
            staleEvidence: payload.staleEvidence,
            message: payload.message,
            timestamp: new Date().toISOString(),
          };
          writeSseMessage('status', eventId, statusData);

          if (payload.diagnostics?.length || payload.quality?.diagnostics?.length) {
            const diagEventId = `${targetProjectId}:${statusRevision ?? 'diag'}:${statusSequence}`;
            const diagData = {
              event: 'diagnostics',
              type: 'diagnostics',
              projectId: targetProjectId,
              revision: statusRevision,
              sequence: statusSequence,
              diagnostics: payload.diagnostics ?? payload.quality?.diagnostics ?? [],
              quality: payload.quality,
            };
            writeSseMessage('diagnostics', diagEventId, diagData);
          }
        } else if (payload.type === 'analysis') {
          const updateRevision = payload.revision;
          const updateSequence = payload.sequence;

          // 1. Status transition
          const statusEventId = `${targetProjectId}:${updateRevision}:${updateSequence}`;
          const statusData = {
            event: 'status',
            type: 'status',
            projectId: targetProjectId,
            status: payload.status,
            revision: updateRevision,
            sequence: updateSequence,
            diagnostics: payload.quality?.diagnostics ?? [],
            quality: payload.quality,
            staleEvidence: payload.staleEvidence,
            timestamp: new Date().toISOString(),
          };
          writeSseMessage('status', statusEventId, statusData);

          // 2. Versioned delta
          const deltaEventId = `${targetProjectId}:${updateRevision}:${updateSequence}`;
          const deltaData = {
            event: 'delta',
            type: 'analysis',
            projectId: targetProjectId,
            schemaVersion: payload.schemaVersion ?? 1,
            revision: updateRevision,
            baseRevision: payload.baseRevision,
            sequence: updateSequence,
            baseSequence: payload.baseSequence,
            status: payload.status,
            delta: payload.delta,
            quality: payload.quality,
            diagnostics: payload.quality?.diagnostics ?? [],
            analyzedAt: payload.analyzedAt,
            durationMs: payload.durationMs,
            staleEvidence: payload.staleEvidence,
            update: payload,
          };
          writeSseMessage('delta', deltaEventId, deltaData);

          // 3. Diagnostics event
          const diagEventId = `${targetProjectId}:${updateRevision}:diag:${updateSequence}`;
          const diagData = {
            event: 'diagnostics',
            type: 'diagnostics',
            projectId: targetProjectId,
            revision: updateRevision,
            sequence: updateSequence,
            diagnostics: payload.quality?.diagnostics ?? [],
            quality: payload.quality,
          };
          writeSseMessage('diagnostics', diagEventId, diagData);
        } else if (payload.type === 'binding-review') {
          const bindingEventId = `${targetProjectId}:binding:${Date.now()}`;
          writeSseMessage('binding-review', bindingEventId, {
            event: 'binding-review',
            type: 'binding-review',
            projectId: targetProjectId,
            records: payload.records,
            timestamp: new Date().toISOString(),
          });
        } else if (payload.type === 'divergence') {
          const divergenceEventId = `${targetProjectId}:${payload.report?.revision ?? 'divergence'}:${payload.report?.sequence ?? Date.now()}`;
          writeSseMessage('divergence', divergenceEventId, {
            event: 'divergence',
            type: 'divergence',
            projectId: targetProjectId,
            report: payload.report,
            timestamp: new Date().toISOString(),
          });
        } else if (payload.type === 'error') {
          const errorEventId = `${targetProjectId}:error:${Date.now()}`;
          writeSseMessage('error', errorEventId, {
            event: 'error',
            type: 'error',
            projectId: targetProjectId,
            message: payload.message,
            timestamp: new Date().toISOString(),
          });
        }
      };

      sync.on('notification', onNotification);

      const pingTimer = setInterval(() => {
        try {
          const pingId = projectId
            ? `${projectId}:ping:${Date.now()}`
            : `global:ping:${Date.now()}`;
          const pingData = projectId
            ? { projectId, revision: project?.analysis?.revision ?? null, timestamp: Date.now() }
            : { timestamp: Date.now() };
          writeSseMessage('ping', pingId, pingData);
        } catch {
          clearInterval(pingTimer);
        }
      }, 30000);
      pingTimer.unref();

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(pingTimer);
        sync.off('notification', onNotification);
        activeSubscriptions.delete(subscriptionId);
        if (projectId && projectSubscriptions.has(projectId)) {
          const set = projectSubscriptions.get(projectId)!;
          set.delete(subscriptionId);
          if (set.size === 0) {
            projectSubscriptions.delete(projectId);
          }
        }
        try {
          if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
        } catch {}
      };

      activeSubscriptions.set(subscriptionId, {
        id: subscriptionId,
        projectId,
        cleanup,
      });
      if (projectId) {
        if (!projectSubscriptions.has(projectId)) {
          projectSubscriptions.set(projectId, new Set());
        }
        projectSubscriptions.get(projectId)!.add(subscriptionId);
      }

      request.raw.on('close', cleanup);
      reply.raw.on('close', cleanup);
      reply.raw.on('error', cleanup);
    };
  };

  app.get('/api/events', createSseHandler(false));
  app.get('/api/projects/:id/events', createSseHandler(true));

  const originalListen = app.listen.bind(app);
  app.listen = (async (listenOptions?: any, cb?: any) => {
    let normalizedOpts: { host?: string; port?: number; [key: string]: any } = {};

    if (typeof listenOptions === 'number' || typeof listenOptions === 'string') {
      normalizedOpts = { port: Number(listenOptions), host: defaultHost };
    } else if (typeof listenOptions === 'object' && listenOptions !== null) {
      normalizedOpts = { ...listenOptions };
      if (!normalizedOpts.host) {
        normalizedOpts.host = defaultHost;
      }
    } else {
      normalizedOpts = { port: options.port ?? (Number(process.env.PORT) || 4317), host: defaultHost };
    }

    const requestedHost = normalizedOpts.host!;
    if (isWildcardHost(requestedHost)) {
      throw new Error(`Cannot bind service to wildcard interface "${requestedHost}". Service must bind to loopback (127.0.0.1, ::1, or localhost).`);
    }
    if (!isLoopbackHost(requestedHost)) {
      throw new Error(`Cannot bind service to non-loopback interface "${requestedHost}". Service must bind to loopback (127.0.0.1, ::1, or localhost).`);
    }

    return originalListen(normalizedOpts, cb);
  }) as any;

  return app;
}

const currentFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && (
  resolve(process.argv[1]) === currentFile ||
  process.argv[1].endsWith('server/main.ts') ||
  process.argv[1].endsWith('server/main.js')
);

if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 4317;
  const app = await createServer({ logger: true });
  await app.listen({ host, port });
  console.log(`Architecture workspace service running on http://${host}:${port}`);
}
