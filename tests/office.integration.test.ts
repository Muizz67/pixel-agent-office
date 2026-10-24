import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../src/server/config';
import { createTestLogger } from '../src/server/logger';
import { createOffice, type OfficeRuntime } from '../src/server/office';

const runtimes: OfficeRuntime[] = [];
const dirs: string[] = [];

async function makeOffice(): Promise<{ runtime: OfficeRuntime; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-office-'));
  dirs.push(dir);
  const config = createConfig({
    NODE_ENV: 'test',
    DATA_DIR: join(dir, 'data'),
    WORKSPACE_ROOT: join(dir, 'workspaces'),
    LLM_PROVIDER: 'mock',
    MOCK_LATENCY_MS: '0',
    LOG_LEVEL: 'silent',
    MAX_CONCURRENT_TASKS: '2',
    MAX_TASKS_PER_RUN: '8',
    MAX_RUN_TOKENS: '200000',
  });
  const runtime = createOffice(config, createTestLogger());
  runtimes.push(runtime);
  return { runtime, dir };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('office end-to-end', () => {
  it('runs a mock mission through plan, delegation, tools, and review', async () => {
    const { runtime } = await makeOffice();
    const run = runtime.orchestrator.start({
      goal: 'Research, design, and ship a landing page for a plant-care app.',
    });
    const finished = await runtime.orchestrator.waitForRun(run.id);
    expect(finished?.status).toBe('completed');

    const snapshot = runtime.orchestrator.snapshot(run.id);
    expect(snapshot.tasks).toHaveLength(4);
    expect(snapshot.tasks.every((task) => task.status === 'completed')).toBe(true);
    expect(snapshot.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.events.some((event) => event.type === 'tool.completed')).toBe(true);
    expect(snapshot.events.some((event) => event.type === 'plan.created')).toBe(true);
    expect(snapshot.events.some((event) => event.type === 'run.completed')).toBe(true);
    // The terminal frame must be last so clients that stop reading at it still
    // have the final task and agent state.
    expect(snapshot.events.at(-1)?.type).toBe('run.completed');

    const firstArtifact = snapshot.artifacts[0];
    expect(firstArtifact).toBeDefined();
    const content = await readFile(
      join(runtime.config.workspaceRoot, finished!.workspace, firstArtifact!.path),
      'utf8',
    );
    expect(content).toContain('Mission:');

    const ceo = snapshot.agents.find((agent) => agent.id === 'ceo');
    expect(ceo?.status).toBe('celebrating');
  });
});
