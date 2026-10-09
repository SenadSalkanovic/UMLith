import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ProjectStore, SpecificationConflictError } from './store';
import { AppError } from './files';
import {
  CreateProjectRequestSchema,
  UpdateSpecificationRequestSchema,
  UpdateLayoutRequestSchema,
  ProjectIdParamSchema,
  ChecksSchema,
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
  });

  app.decorate('store', store);

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
      const errorTitle = statusCode === 404 ? 'Not Found' : statusCode === 409 ? 'Conflict' : 'Bad Request';
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

  // Specification endpoints
  const updateSpecHandler = async (request: any, reply: any) => {
    const { id } = ProjectIdParamSchema.parse(request.params);
    const { expectedRevision, graph } = UpdateSpecificationRequestSchema.parse(request.body);
    const updated = await store.updateSpec(id, expectedRevision, graph);
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

  // Event streams (SSE)
  const createSseHandler = (forProject: boolean) => {
    return async (request: any, reply: any) => {
      let projectId: string | undefined;
      if (forProject) {
        const { id } = ProjectIdParamSchema.parse(request.params);
        projectId = id;
        await store.get(projectId);
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

      reply.raw.write(': connected\n\n');
      reply.raw.write(`event: ready\ndata: ${JSON.stringify(forProject ? { projectId, status: 'connected' } : { status: 'connected' })}\n\n`);

      const query = request.query as { once?: string } | undefined;
      if (query?.once === 'true' || query?.once === '1') {
        reply.raw.end();
        return;
      }

      const timer = setInterval(() => {
        try {
          reply.raw.write(`event: ping\ndata: ${JSON.stringify(forProject ? { projectId, timestamp: Date.now() } : { timestamp: Date.now() })}\n\n`);
        } catch {
          clearInterval(timer);
        }
      }, 30000);
      timer.unref();

      request.raw.on('close', () => {
        clearInterval(timer);
        try {
          reply.raw.end();
        } catch {}
      });
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
