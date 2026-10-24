import { afterEach, describe, expect, it } from 'vitest';
import { disposeOffice, makeOffice, type TestOffice } from './test-utils';

let office: TestOffice | null = null;

afterEach(async () => {
  await disposeOffice(office);
  office = null;
});

describe('approval broker', () => {
  it('persists, approves, and audits a gated tool request', async () => {
    office = await makeOffice();
    const run = office.runtime.orchestrator.start({
      goal: 'Research a small launch page and produce a reviewable artifact.',
    });
    await office.runtime.orchestrator.waitForRun(run.id);
    const snapshot = office.runtime.orchestrator.snapshot(run.id);
    const task = snapshot.tasks[0]!;

    const pending = office.runtime.approvals.request({
      runId: run.id,
      taskId: task.id,
      agentId: task.agentId,
      tool: 'run_command',
      arguments: { command: 'node', args: ['--version'] },
      risk: 'high',
      reason: 'Integration test needs a gated command.',
      timeoutMs: 5_000,
    });

    const stored = office.runtime.stores.approvals.listPending(run.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tool).toBe('run_command');

    const resolved = office.runtime.approvals.resolve(run.id, stored[0]!.id, 'approve', 'Looks safe.');
    expect(resolved.status).toBe('approved');
    expect(resolved.note).toBe('Looks safe.');
    const completed = await pending;
    expect(completed.status).toBe('approved');
    expect(office.runtime.stores.approvals.listPending(run.id)).toHaveLength(0);

    expect(() =>
      office!.runtime.approvals.resolve(run.id, stored[0]!.id, 'deny', null),
    ).toThrow(/already approved/);

    const events = office.runtime.events.replay(run.id, 0, 5_000);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'approval.resolved')).toBe(true);
  });

  it('cancels waiting approvals when the run aborts', async () => {
    office = await makeOffice();
    const run = office.runtime.orchestrator.start({
      goal: 'Prepare a short mission brief for the approval cancellation test.',
    });
    await office.runtime.orchestrator.waitForRun(run.id);
    const task = office.runtime.orchestrator.snapshot(run.id).tasks[0]!;
    const controller = new AbortController();

    const pending = office.runtime.approvals.request({
      runId: run.id,
      taskId: task.id,
      agentId: task.agentId,
      tool: 'fetch_url',
      arguments: { url: 'https://example.com' },
      risk: 'medium',
      reason: 'Test cancellation.',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(office.runtime.stores.approvals.listPending(run.id)).toHaveLength(0);
  });

  it('expires an unanswered approval', async () => {
    office = await makeOffice();
    const run = office.runtime.orchestrator.start({
      goal: 'Prepare a tiny artifact for the approval expiry test.',
    });
    await office.runtime.orchestrator.waitForRun(run.id);
    const task = office.runtime.orchestrator.snapshot(run.id).tasks[0]!;

    const pending = office.runtime.approvals.request({
      runId: run.id,
      taskId: task.id,
      agentId: task.agentId,
      tool: 'run_command',
      arguments: { command: 'git', args: ['status'] },
      risk: 'high',
      reason: 'Expiry test.',
      timeoutMs: 25,
    });

    const result = await pending;
    expect(result.status).toBe('expired');
    expect(result.resolvedAt).not.toBeNull();
  });
});
