import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../src/server/config';
import { createTestLogger } from '../src/server/logger';
import { createOffice, type OfficeRuntime } from '../src/server/office';

export interface TestOffice {
  runtime: OfficeRuntime;
  dir: string;
}

export async function makeOffice(overrides: Record<string, string> = {}): Promise<TestOffice> {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-office-test-'));
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
    ...overrides,
  });
  const runtime = createOffice(config, createTestLogger());
  return { runtime, dir };
}

export async function disposeOffice(office: TestOffice | null): Promise<void> {
  if (!office) return;
  await office.runtime.close().catch(() => undefined);
  await rm(office.dir, { recursive: true, force: true }).catch(() => undefined);
}
