import { afterEach, describe, expect, it } from 'vitest';
import { createTestLogger } from '../src/server/logger';
import { createOffice, type OfficeRuntime } from '../src/server/office';
import { newId } from '../src/server/ids';
import { disposeOffice, makeOffice, type TestOffice } from './test-utils';

let office: TestOffice | null = null;
let reopened: OfficeRuntime | null = null;

afterEach(async () => {
  if (reopened) {
    await reopened.close().catch(() => undefined);
    reopened = null;
  }
  await disposeOffice(office);
  office = null;
});

describe('restart recovery', () => {
  it('marks in-flight work interrupted, expires approvals, and resumes cleanly', async () => {
    office = await makeOffice();
    const started = office.runtime.orchestrator.start({
      goal: 'Recover a mission that was interrupted mid-flight.',
    });
    await office.runtime.orchestrator.waitForRun(started.id);

    const run = office.runtime.stores.runs.get(started.id);
    expect(run?.status).toBe('completed');
    const tasks = office.runtime.stores.tasks.listByRun(started.id);
    expect(tasks.length).toBeGreaterThan(0);

    // Simulate a process that died while one task was running and waiting on
    // a human approval. The other tasks stay completed so resume can skip them.
    const inFlight = tasks[0]!;
    const now = new Date().toISOString();
    office.runtime.stores.runs.update({
      ...run!,
      status: 'running',
      error: null,
      completedAt: null,
      updatedAt: now,
    });
    office.runtime.stores.tasks.update({
      ...inFlight,
      status: 'running',
      error: null,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });

    const approvalId = newId('apr');
    office.runtime.stores.approvals.create({
      id: approvalId,
      runId: started.id,
      taskId: inFlight.id,
      agentId: inFlight.agentId,
      tool: 'run_command',
      arguments: { command: 'node', args: ['--version'] },
      risk: 'high',
      reason: 'Pending approval at restart.',
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resolvedAt: null,
      note: null,
    });

    const config = office.runtime.config;
    await office.runtime.close();

    reopened = createOffice(config, createTestLogger());

    const recovered = reopened.stores.runs.get(started.id);
    expect(recovered?.status).toBe('interrupted');
    expect(recovered?.error).toMatch(/restarted/i);

    const recoveredTask = reopened.stores.tasks.get(inFlight.id);
    expect(recoveredTask?.status).toBe('queued');
    expect(recoveredTask?.error).toMatch(/restart/i);

    const approval = reopened.stores.approvals.get(approvalId);
    expect(approval?.status).toBe('expired');
    expect(approval?.resolvedAt).not.toBeNull();

    const audit = reopened.stores.audit.list(50);
    expect(audit.some((entry) => entry.action === 'run.recovered')).toBe(true);

    await reopened.orchestrator.resume(started.id);
    const finished = await reopened.orchestrator.waitForRun(started.id);
    expect(finished?.status).toBe('completed');

    const finalTasks = reopened.stores.tasks.listByRun(started.id);
    expect(finalTasks.every((task) => task.status === 'completed')).toBe(true);
    expect(reopened.stores.approvals.listPending(started.id)).toHaveLength(0);

    const events = reopened.events.replay(started.id, 0, 5_000);
    expect(events.some((event) => event.type === 'run.resumed')).toBe(true);
  });
});
