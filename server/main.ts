import Fastify, { type FastifyInstance } from 'fastify';
import { stat } from 'node:fs/promises';
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

export interface ServerOptions {
  store?: ProjectStore;
  storeDir?: string;
  logger?: boolean | object;
}

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const store = options.store ?? new ProjectStore(
    options.storeDir ?? process.env.DATA_DIR ?? process.env.ARCHITECT_DATA_DIR ?? join(process.cwd(), '.workspace-data')
  );

  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.decorate('store', store);

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

  app.setNotFoundHandler((request, reply) => {
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
