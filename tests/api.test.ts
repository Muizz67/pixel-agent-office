import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { disposeOffice, makeOffice, type TestOffice } from './test-utils';

let office: TestOffice | null = null;
let app: FastifyInstance | null = null;

async function boot(overrides: Record<string, string> = {}): Promise<{ app: FastifyInstance; office: TestOffice }> {
  office = await makeOffice(overrides);
  app = await buildApp(office.runtime);
  return { app, office };
}

afterEach(async () => {
  if (app) await app.close().catch(() => undefined);
  app = null;
  await disposeOffice(office);
  office = null;
});

describe('HTTP API security', () => {
  it('requires the office token and does not leak API data', async () => {
    const booted = await boot({ OFFICE_API_TOKEN: 's3cret-token' });
    const health = await booted.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");

    const denied = await booted.app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('UNAUTHORIZED');

    const wrong = await booted.app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { 'x-office-token': 'wrong-token' },
    });
    expect(wrong.statusCode).toBe(401);

    const headerAllowed = await booted.app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { 'x-office-token': 's3cret-token' },
    });
    expect(headerAllowed.statusCode).toBe(200);
    expect(headerAllowed.json().config.provider.kind).toBe('mock');

    const queryAllowed = await booted.app.inject({
      method: 'GET',
      url: '/api/bootstrap?token=s3cret-token',
    });
    expect(queryAllowed.statusCode).toBe(200);

    const badOrigin = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'x-office-token': 's3cret-token', origin: 'https://evil.example' },
      payload: { goal: 'Build a small test landing page.' },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json().error.code).toBe('FORBIDDEN');
  });
});

describe('HTTP API mission lifecycle', () => {
  it('starts idempotently, rejects concurrent runs, and serves artifacts', async () => {
    const booted = await boot({ MOCK_LATENCY_MS: '30', MAX_CONCURRENT_TASKS: '2' });

    const invalid = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { goal: 'short' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('BAD_REQUEST');

    const goal = 'Research, design, and ship a small launch page for a plant-care app.';
    const first = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'idempotency-key': 'api-test-1' },
      payload: { goal },
    });
    expect(first.statusCode).toBe(201);
    const runId = first.json().run.id as string;
    expect(runId).toMatch(/^run_/);

    const replay = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'idempotency-key': 'api-test-1' },
      payload: { goal },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().run.id).toBe(runId);

    const concurrent = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'idempotency-key': 'api-test-2' },
      payload: { goal: 'A second mission should not start while the first is active.' },
    });
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().error.code).toBe('CONFLICT');

    const finished = await booted.office.runtime.orchestrator.waitForRun(runId);
    expect(finished?.status).toBe('completed');

    const snapshot = await booted.app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json();
    expect(body.run.status).toBe('completed');
    expect(body.tasks).toHaveLength(4);
    expect(body.artifacts.length).toBeGreaterThanOrEqual(3);

    const events = await booted.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?after=0&limit=2000`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.some((event: { type: string }) => event.type === 'plan.created')).toBe(true);
    expect(events.json().events.some((event: { type: string }) => event.type === 'run.completed')).toBe(true);

    const artifact = body.artifacts[0] as { path: string };
    const query = new URLSearchParams({ path: artifact.path }).toString();
    const content = await booted.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/artifacts/content?${query}`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.json().artifact.path).toBe(artifact.path);
    expect(content.json().content).toContain('Mission:');

    const traversal = await booted.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/artifacts/content?path=${encodeURIComponent('../../office.db')}`,
    });
    expect(traversal.statusCode).toBe(404);

    const cancelTerminal = await booted.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/cancel`,
    });
    expect(cancelTerminal.statusCode).toBe(409);

    const missingApproval = await booted.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/approvals/apr_missing`,
      payload: { decision: 'approve' },
    });
    expect(missingApproval.statusCode).toBe(404);

    const list = await booted.app.inject({ method: 'GET', url: '/api/runs?limit=5' });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const audit = await booted.app.inject({ method: 'GET', url: '/api/audit?limit=10' });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries.length).toBeGreaterThan(0);

    const metrics = await booted.app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().runs.completed).toBe(1);

    const prometheus = await booted.app.inject({ method: 'GET', url: '/metrics' });
    expect(prometheus.statusCode).toBe(200);
    expect(prometheus.body).toContain('office_runs_total{status="completed"} 1');

    const notFound = await booted.app.inject({ method: 'GET', url: '/api/unknown-route' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe('NOT_FOUND');

    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const limited = await booted.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { goal: 'short' },
      });
      statuses.push(limited.statusCode);
    }
    expect(statuses).toContain(429);
  });

  it('cancels an active mission', async () => {
    const booted = await boot({ MOCK_LATENCY_MS: '250', MAX_CONCURRENT_TASKS: '1' });
    const started = await booted.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { goal: 'Create a deliberately long mission that will be cancelled by the operator.' },
    });
    expect(started.statusCode).toBe(201);
    const runId = started.json().run.id as string;

    const cancelled = await booted.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');

    const snapshot = await booted.app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(snapshot.json().run.status).toBe('cancelled');
    expect(
      snapshot
        .json()
        .tasks.every((task: { status: string }) => ['cancelled', 'completed'].includes(task.status)),
    ).toBe(true);

    const events = await booted.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?after=0&limit=2000`,
    });
    expect(events.json().events.at(-1).type).toBe('run.cancelled');
  });
});
