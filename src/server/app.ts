import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  type AnyRunEvent,
  type BootstrapResponse,
  type HealthResponse,
  type PublicConfig,
  type PublicFeatures,
  type PublicLimits,
} from '../shared/types';
import type { OfficeRuntime } from './office';
import { AppError, badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors';
import { RateLimiter } from './rate-limit';
import { WorkspaceGuard } from './tools/workspace';

const startRunSchema = z
  .object({
    goal: z.string().trim().min(8, 'Give the office a little more context (at least 8 characters).').max(2_000),
    maxTasks: z.number().int().min(1).max(12).optional(),
  })
  .strict();

const approvalSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

const runIdSchema = z.string().min(4).max(80).regex(/^run_/, 'Invalid run id.');
const approvalIdSchema = z.string().min(4).max(80).regex(/^apr_/, 'Invalid approval id.');
const artifactPathSchema = z.string().min(1).max(500);

function parseId(schema: z.ZodType<string>, value: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest('Invalid identifier.');
  return parsed.data;
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function publicConfig(runtime: OfficeRuntime): PublicConfig {
  const limits: PublicLimits = {
    maxTasks: runtime.config.maxTasksPerRun,
    maxAgentSteps: runtime.config.maxAgentSteps,
    maxConcurrentTasks: runtime.config.maxConcurrentTasks,
    maxRunTokens: runtime.config.maxRunTokens,
    maxToolCalls: runtime.config.maxToolCallsPerRun,
    runTimeoutMs: runtime.config.runTimeoutMs,
  };
  const features: PublicFeatures = {
    streaming: true,
    approvals: true,
    shellTools: runtime.config.enableShellTools,
    fetchTool: runtime.config.enableFetchTool,
  };
  return {
    version: runtime.config.version,
    provider: {
      kind: runtime.provider.kind,
      label: runtime.provider.label,
      plannerModel: runtime.provider.plannerModel,
      workerModel: runtime.provider.workerModel,
      live: runtime.provider.kind === 'openai',
    },
    limits,
    features,
  };
}

function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function isLoopbackOrigin(origin: URL): boolean {
  return (
    ['http:', 'https:'].includes(origin.protocol) &&
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(origin.hostname.toLowerCase())
  );
}

function originAllowed(origin: string, hostHeader: string | undefined, extra: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackOrigin(parsed)) return true;
  if (extra.some((allowed) => allowed.replace(/\/$/, '') === origin.replace(/\/$/, ''))) return true;
  if (hostHeader && parsed.host === hostHeader) return true;
  return false;
}

function queryNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function terminalEvent(type: string): boolean {
  return ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(type);
}

export async function buildApp(runtime: OfficeRuntime): Promise<FastifyInstance> {
  const { config, logger } = runtime;
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 128 * 1024,
    trustProxy: false,
    requestTimeout: 30_000,
  });

  const limiter = new RateLimiter();
  const staticEnabled = existsSync(join(config.clientDist, 'index.html'));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );

    const path = (request.raw.url ?? '/').split('?')[0] ?? '/';
    const isApi = path.startsWith('/api') || path === '/metrics';

    if (
      config.officeApiToken &&
      isApi &&
      path !== '/api/health' &&
      path !== '/api'
    ) {
      let provided = headerValue(request.headers['x-office-token']);
      if (!provided && (request.method === 'GET' || request.method === 'HEAD')) {
        try {
          const parsedUrl = new URL(request.raw.url ?? '/', 'http://localhost');
          provided = parsedUrl.searchParams.get('token') ?? '';
        } catch {
          provided = '';
        }
      }
      if (!provided || !bearerMatches(provided, config.officeApiToken)) {
        throw unauthorized('A valid office access token is required.');
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      const origin = headerValue(request.headers.origin);
      if (origin && !originAllowed(origin, request.headers.host, config.allowedOrigins)) {
        throw forbidden('Request origin is not allowed.');
      }
    }

    if (isApi) {
      const isStart = path === '/api/runs' && request.method === 'POST';
      const limit = isStart ? 8 : 300;
      const key = `${request.ip}:${isStart ? 'start' : 'api'}`;
      const result = limiter.hit(key, limit, 60_000);
      if (!result.allowed) {
        reply.header('Retry-After', String(result.retryAfterSeconds));
        throw rateLimited(`Too many requests. Try again in ${result.retryAfterSeconds}s.`);
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply
        .code(error.statusCode)
        .type('application/json')
        .send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).type('application/json').send({
        error: { code: 'BAD_REQUEST', message: 'Request validation failed.', details: error.issues },
      });
      return;
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      const message =
        fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
          ? 'Request body is not valid JSON.'
          : (fastifyError.message ?? 'Request rejected.');
      reply
        .code(fastifyError.statusCode)
        .type('application/json')
        .send({ error: { code: 'BAD_REQUEST', message } });
      return;
    }

    request.log.error({ err: error }, 'Unhandled API error');
    reply.code(500).type('application/json').send({
      error: { code: 'INTERNAL', message: 'The office hit an internal error. Check the server log.' },
    });
  });

  app.get('/api/health', async (_request, reply) => {
    const database = runtime.db.ping();
    const body: HealthResponse = {
      status: database ? 'ok' : 'degraded',
      version: config.version,
      database: database ? 'ok' : 'error',
      provider: runtime.provider.kind,
      activeRuns: runtime.orchestrator.activeRunId ? 1 : 0,
      uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
    };
    return reply.code(database ? 200 : 503).send(body);
  });

  app.get('/api/config', async () => publicConfig(runtime));

  app.get('/api/bootstrap', async () => {
    const activeRun = runtime.stores.runs.findActive();
    const body: BootstrapResponse = {
      config: publicConfig(runtime),
      agents: runtime.presence.list(),
      activeRun,
      runs: runtime.stores.runs.list(12),
    };
    return body;
  });

  app.get('/api/agents', async () => ({ agents: runtime.presence.list() }));

  app.get('/api/runs', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = queryNumber(query.limit, 20, 1, 100);
    const offset = queryNumber(query.offset, 0, 0, 10_000);
    return {
      runs: runtime.stores.runs.list(limit, offset),
      total: runtime.stores.runs.count(),
      limit,
      offset,
    };
  });

  app.post('/api/runs', async (request, reply) => {
    const body = parseBody(startRunSchema, request.body);
    const idempotencyKey = headerValue(request.headers['idempotency-key']).slice(0, 120) || null;
    const run = runtime.orchestrator.start({
      goal: body.goal,
      maxTasks: body.maxTasks,
      idempotencyKey,
    });
    return reply.code(201).send({ run });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const id = parseId(runIdSchema, request.params.id);
    return runtime.orchestrator.snapshot(id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request) => {
    const id = parseId(runIdSchema, request.params.id);
    runtime.orchestrator.getRun(id);
    const query = request.query as Record<string, unknown>;
    const after = queryNumber(query.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = queryNumber(query.limit, 500, 1, 5_000);
    return { events: runtime.events.replay(id, after, limit) };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
    const id = parseId(runIdSchema, request.params.id);
    const run = await runtime.orchestrator.cancel(id);
    return { run };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (request) => {
    const id = parseId(runIdSchema, request.params.id);
    const run = await runtime.orchestrator.resume(id);
    return { run };
  });

  app.post<{ Params: { id: string; approvalId: string } }>(
    '/api/runs/:id/approvals/:approvalId',
    async (request) => {
      const runId = parseId(runIdSchema, request.params.id);
      const approvalId = parseId(approvalIdSchema, request.params.approvalId);
      const body = parseBody(approvalSchema, request.body);
      const approval = runtime.approvals.resolve(
        runId,
        approvalId,
        body.decision,
        body.note ?? null,
      );
      runtime.stores.audit.append(`approval.${body.decision}`, runId, {
        approvalId,
        note: body.note ?? null,
        tool: approval.tool,
      });
      return { approval };
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts', async (request) => {
    const id = parseId(runIdSchema, request.params.id);
    runtime.orchestrator.getRun(id);
    return { artifacts: runtime.orchestrator.artifactsFor(id) };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts/content', async (request, reply) => {
    const id = parseId(runIdSchema, request.params.id);
    const run = runtime.orchestrator.getRun(id);
    const query = request.query as Record<string, unknown>;
    const path = typeof query.path === 'string' ? query.path : '';
    const parsedPath = artifactPathSchema.safeParse(path);
    if (!parsedPath.success) throw badRequest('A valid artifact path is required.');
    const artifact = runtime.stores.artifacts.findByPath(id, parsedPath.data);
    if (!artifact) throw notFound('Artifact not found.');
    const guard = new WorkspaceGuard(join(config.workspaceRoot, run.workspace));
    const target = guard.resolve(artifact.path);
    let info;
    try {
      info = await stat(target);
    } catch {
      throw notFound('Artifact file is missing from the workspace.');
    }
    if (!info.isFile()) throw notFound('Artifact is not a file.');
    if (info.size > 512 * 1024) throw badRequest('Artifact is too large to preview.');
    const content = await readFile(target, 'utf8');
    return reply.type('application/json').send({ artifact, content });
  });

  app.get('/api/audit', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = queryNumber(query.limit, 100, 1, 500);
    return { entries: runtime.stores.audit.list(limit) };
  });

  app.get('/api/metrics', async () => metricsSnapshot(runtime));

  app.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return prometheusMetrics(runtime);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/stream', async (request, reply) => {
    const id = parseId(runIdSchema, request.params.id);
    runtime.orchestrator.getRun(id);
    const query = request.query as Record<string, unknown>;
    const lastEventId = headerValue(request.headers['last-event-id']);
    const after = queryNumber(
      query.after ?? (lastEventId ? Number(lastEventId) : 0),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    reply.raw.write('retry: 3000\n\n');

    let closed = false;
    let replaying = true;
    let lastSent = after;
    let terminalSeen = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    const buffered: AnyRunEvent[] = [];

    const close = () => {
      if (closed) return;
      closed = true;
      replaying = false;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (closeTimer) clearTimeout(closeTimer);
      try {
        if (!reply.raw.writableEnded) reply.raw.end();
      } catch {
        // Already closed.
      }
    };

    const scheduleClose = () => {
      if (closed || closeTimer) return;
      closeTimer = setTimeout(close, 300);
      closeTimer.unref?.();
    };

    const writeEvent = (event: AnyRunEvent) => {
      if (closed || event.seq <= lastSent) return;
      lastSent = event.seq;
      try {
        reply.raw.write(
          `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      } catch {
        close();
        return;
      }
      if (terminalEvent(event.type)) {
        terminalSeen = true;
        scheduleClose();
      }
    };

    const unsubscribe = runtime.events.bus.subscribe(id, (event) => {
      if (replaying) buffered.push(event);
      else writeEvent(event);
    });

    reply.raw.on('close', close);
    reply.raw.on('error', close);

    const replay = runtime.events.replay(id, after, 5_000);
    for (const event of replay) writeEvent(event);
    replaying = false;
    for (const event of buffered) writeEvent(event);
    buffered.length = 0;
    if (terminalSeen) scheduleClose();

    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        close();
      }
    }, 15_000);
    heartbeat.unref?.();

    return reply;
  });

  if (staticEnabled) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: '/',
      wildcard: false,
      index: false,
      cacheControl: true,
      maxAge: '1h',
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = (request.raw.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith('/api/') || path === '/api' || path === '/metrics') {
      return reply
        .code(404)
        .type('application/json')
        .send({ error: { code: 'NOT_FOUND', message: 'API route not found.' } });
    }
    if (staticEnabled && request.method === 'GET') {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .type('text/plain')
      .send('Pixel Agent Office API is running. Build the client with `npm run build` to serve the UI.');
  });

  return app as unknown as FastifyInstance;
}

function metricsSnapshot(runtime: OfficeRuntime): {
  runs: Record<string, number>;
  tasks: Record<string, number>;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  approvalsPending: number;
  artifacts: number;
  events: number;
  activeRuns: number;
  uptimeSeconds: number;
  provider: string;
} {
  const runs = Object.fromEntries(
    runtime.stores.runs.countByStatus().map((entry) => [entry.status, entry.count]),
  );
  const tasks = Object.fromEntries(
    runtime.stores.tasks.countByStatus().map((entry) => [entry.status, entry.count]),
  );
  return {
    runs,
    tasks,
    usage: runtime.stores.runs.usageTotals(),
    approvalsPending: runtime.stores.approvals.countPending(),
    artifacts: runtime.stores.artifacts.count(),
    events: runtime.stores.events.count(),
    activeRuns: runtime.orchestrator.activeRunId ? 1 : 0,
    uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
    provider: runtime.provider.kind,
  };
}

function prometheusMetrics(runtime: OfficeRuntime): string {
  const metrics = metricsSnapshot(runtime);
  const lines: string[] = [];
  lines.push('# HELP office_runs_total Missions by terminal/current status.');
  lines.push('# TYPE office_runs_total gauge');
  for (const [status, count] of Object.entries(metrics.runs)) {
    lines.push(`office_runs_total{status="${status}"} ${count}`);
  }
  lines.push('# HELP office_tasks_total Tasks by status.');
  lines.push('# TYPE office_tasks_total gauge');
  for (const [status, count] of Object.entries(metrics.tasks)) {
    lines.push(`office_tasks_total{status="${status}"} ${count}`);
  }
  lines.push('# HELP office_tokens_total Model tokens consumed.');
  lines.push('# TYPE office_tokens_total counter');
  lines.push(`office_tokens_total{kind="input"} ${metrics.usage.inputTokens}`);
  lines.push(`office_tokens_total{kind="output"} ${metrics.usage.outputTokens}`);
  lines.push('# HELP office_tool_calls_total Sandboxed tool invocations.');
  lines.push('# TYPE office_tool_calls_total counter');
  lines.push(`office_tool_calls_total ${metrics.usage.toolCalls}`);
  lines.push('# HELP office_approvals_pending Pending human approvals.');
  lines.push('# TYPE office_approvals_pending gauge');
  lines.push(`office_approvals_pending ${metrics.approvalsPending}`);
  lines.push('# HELP office_artifacts_total Artifacts persisted.');
  lines.push('# TYPE office_artifacts_total gauge');
  lines.push(`office_artifacts_total ${metrics.artifacts}`);
  lines.push('# HELP office_events_total Persisted run events.');
  lines.push('# TYPE office_events_total counter');
  lines.push(`office_events_total ${metrics.events}`);
  lines.push('# HELP office_active_runs Active missions.');
  lines.push('# TYPE office_active_runs gauge');
  lines.push(`office_active_runs ${metrics.activeRuns}`);
  lines.push('# HELP office_uptime_seconds Server uptime.');
  lines.push('# TYPE office_uptime_seconds counter');
  lines.push(`office_uptime_seconds ${metrics.uptimeSeconds}`);
  lines.push('# HELP office_info Build and provider information.');
  lines.push('# TYPE office_info gauge');
  lines.push(`office_info{version="${runtime.config.version}",provider="${metrics.provider}"} 1`);
  return `${lines.join('\n')}\n`;
}

