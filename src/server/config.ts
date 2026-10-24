import { resolve } from 'node:path';
import { z } from 'zod';

export const APP_VERSION = '0.1.0';

const booleanValue = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const positiveInt = (fallback: number, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected an integer between ${min} and ${max}.`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const nonEmptyString = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? fallback : value.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: nonEmptyString('127.0.0.1'),
  PORT: positiveInt(8787, 1, 65_535),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATA_DIR: nonEmptyString('./data'),
  WORKSPACE_ROOT: nonEmptyString('./workspaces'),
  LLM_PROVIDER: z.enum(['auto', 'mock', 'openai']).default('auto'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_BASE_URL: nonEmptyString('https://api.openai.com/v1'),
  OPENAI_MODEL: nonEmptyString('gpt-4o-mini'),
  PLANNER_MODEL: z.string().optional().default(''),
  WORKER_MODEL: z.string().optional().default(''),
  LLM_TIMEOUT_MS: positiveInt(90_000, 5_000, 600_000),
  MAX_CONCURRENT_TASKS: positiveInt(2, 1, 4),
  MAX_TASKS_PER_RUN: positiveInt(8, 1, 12),
  MAX_AGENT_STEPS: positiveInt(8, 1, 24),
  MAX_TASK_ATTEMPTS: positiveInt(2, 1, 5),
  MAX_RUN_TOKENS: positiveInt(60_000, 1_000, 2_000_000),
  MAX_TOOL_CALLS_PER_RUN: positiveInt(80, 1, 500),
  RUN_TIMEOUT_MS: positiveInt(900_000, 10_000, 3_600_000),
  APPROVAL_TIMEOUT_MS: positiveInt(600_000, 10_000, 3_600_000),
  MOCK_LATENCY_MS: positiveInt(350, 0, 5_000),
  ENABLE_SHELL_TOOLS: booleanValue.default(false),
  ENABLE_FETCH_TOOL: booleanValue.default(false),
  REQUIRE_APPROVAL_FOR_COMMANDS: booleanValue.default(true),
  OFFICE_API_TOKEN: z.string().optional().default(''),
  ALLOWED_ORIGINS: z.string().optional().default(''),
});

export type RequestedProvider = 'auto' | 'mock' | 'openai';

export interface AppConfig {
  version: string;
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  clientDist: string;
  requestedProvider: RequestedProvider;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  plannerModel: string;
  workerModel: string;
  llmTimeoutMs: number;
  maxConcurrentTasks: number;
  maxTasksPerRun: number;
  maxAgentSteps: number;
  maxTaskAttempts: number;
  maxRunTokens: number;
  maxToolCallsPerRun: number;
  runTimeoutMs: number;
  approvalTimeoutMs: number;
  mockLatencyMs: number;
  enableShellTools: boolean;
  enableFetchTool: boolean;
  requireApprovalForCommands: boolean;
  officeApiToken: string;
  allowedOrigins: string[];
}

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
}

/**
 * Parse and validate configuration. Throws a readable error on invalid values
 * so the process fails fast rather than starting in a half-configured state.
 */
export function createConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const value = parsed.data;
  const dataDir = resolve(process.cwd(), value.DATA_DIR);
  const workspaceRoot = resolve(process.cwd(), value.WORKSPACE_ROOT);
  const clientDist = resolve(process.cwd(), 'dist/client');
  const officeApiToken = value.OFFICE_API_TOKEN.trim();

  if (value.NODE_ENV === 'production' && !isLoopbackHost(value.HOST) && !officeApiToken) {
    throw new Error(
      'Refusing to bind a non-loopback host without OFFICE_API_TOKEN. Set a token or bind to 127.0.0.1.',
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(value.OPENAI_BASE_URL);
  } catch {
    throw new Error('OPENAI_BASE_URL must be a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('OPENAI_BASE_URL must use http or https.');
  }

  return {
    version: APP_VERSION,
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    dataDir,
    dbPath: resolve(dataDir, 'office.db'),
    workspaceRoot,
    clientDist,
    requestedProvider: value.LLM_PROVIDER,
    openaiApiKey: value.OPENAI_API_KEY.trim(),
    openaiBaseUrl: baseUrl.toString().replace(/\/+$/, ''),
    openaiModel: value.OPENAI_MODEL,
    plannerModel: value.PLANNER_MODEL.trim() || value.OPENAI_MODEL,
    workerModel: value.WORKER_MODEL.trim() || value.OPENAI_MODEL,
    llmTimeoutMs: value.LLM_TIMEOUT_MS,
    maxConcurrentTasks: value.MAX_CONCURRENT_TASKS,
    maxTasksPerRun: value.MAX_TASKS_PER_RUN,
    maxAgentSteps: value.MAX_AGENT_STEPS,
    maxTaskAttempts: value.MAX_TASK_ATTEMPTS,
    maxRunTokens: value.MAX_RUN_TOKENS,
    maxToolCallsPerRun: value.MAX_TOOL_CALLS_PER_RUN,
    runTimeoutMs: value.RUN_TIMEOUT_MS,
    approvalTimeoutMs: value.APPROVAL_TIMEOUT_MS,
    mockLatencyMs: value.MOCK_LATENCY_MS,
    enableShellTools: value.ENABLE_SHELL_TOOLS,
    enableFetchTool: value.ENABLE_FETCH_TOOL,
    requireApprovalForCommands: value.REQUIRE_APPROVAL_FOR_COMMANDS,
    officeApiToken,
    allowedOrigins: value.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
