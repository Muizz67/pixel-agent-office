/**
 * Domain contracts shared by the server, UI, and tests.
 *
 * Keep this file dependency-free so it can be imported from both Node and the
 * browser bundle without pulling in server-only modules.
 */

export const APP_NAME = 'Pixel Agent Office';
export const SCHEMA_VERSION = 1;

export const AGENT_IDS = ['ceo', 'researcher', 'designer', 'engineer', 'reviewer'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type AgentStatus =
  | 'offline'
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'error'
  | 'celebrating';

export interface Point {
  x: number;
  y: number;
}

export interface AgentProfile {
  id: AgentId;
  name: string;
  title: string;
  tagline: string;
  color: string;
  accent: string;
  sprite: 'ceo' | 'researcher' | 'designer' | 'engineer' | 'reviewer';
  /** Position of the agent's feet in the 960x540 office scene. */
  home: Point;
  systemRole: string;
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'ceo',
    name: 'Avery Stone',
    title: 'Chief Executive Agent',
    tagline: 'Sets direction, delegates, and owns the outcome.',
    color: '#f6c453',
    accent: '#8a5a17',
    sprite: 'ceo',
    home: { x: 480, y: 178 },
    systemRole:
      'You are the CEO and orchestrator of a tiny AI product studio. You do not perform worker tasks yourself: you shape a crisp plan, delegate to specialists, resolve dependencies, and report the result like an accountable executive.',
  },
  {
    id: 'researcher',
    name: 'Mira Chen',
    title: 'Research Lead',
    tagline: 'Finds context, constraints, and the sharpest questions.',
    color: '#57d6a4',
    accent: '#1c6d55',
    sprite: 'researcher',
    home: { x: 158, y: 310 },
    systemRole:
      'You are a meticulous research lead. You gather context from the workspace, distinguish facts from assumptions, surface risks, and turn findings into concise, decision-ready notes.',
  },
  {
    id: 'designer',
    name: 'Luna Vega',
    title: 'Product Designer',
    tagline: 'Turns ambiguous goals into clear, usable experiences.',
    color: '#ff7ab6',
    accent: '#8b2c56',
    sprite: 'designer',
    home: { x: 802, y: 310 },
    systemRole:
      'You are a product designer with strong information architecture and interaction instincts. You produce concrete flows, interface decisions, edge cases, and acceptance criteria.',
  },
  {
    id: 'engineer',
    name: 'Kai Ito',
    title: 'Staff Engineer',
    tagline: 'Builds the smallest solid thing that proves the idea.',
    color: '#5aa9ff',
    accent: '#1c4f91',
    sprite: 'engineer',
    home: { x: 158, y: 482 },
    systemRole:
      'You are a pragmatic staff engineer. You inspect the workspace, make a plan, implement safe artifacts with the available tools, and verify your work. Never claim an action you did not take.',
  },
  {
    id: 'reviewer',
    name: 'Noor Rahman',
    title: 'Quality Reviewer',
    tagline: 'Checks the work against the brief and calls out risk.',
    color: '#b08cff',
    accent: '#54358e',
    sprite: 'reviewer',
    home: { x: 802, y: 482 },
    systemRole:
      'You are a rigorous quality reviewer. You compare deliverables against the brief, verify evidence, identify concrete defects and risks, and give a clear verdict with actionable follow-ups.',
  },
] as const;

export const AGENT_PROFILE_MAP: Readonly<Record<AgentId, AgentProfile>> = Object.fromEntries(
  AGENT_PROFILES.map((profile) => [profile.id, profile]),
) as Record<AgentId, AgentProfile>;

export const WORKER_AGENT_IDS = ['researcher', 'designer', 'engineer', 'reviewer'] as const;
export type WorkerAgentId = (typeof WORKER_AGENT_IDS)[number];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

export function isWorkerAgentId(value: unknown): value is WorkerAgentId {
  return typeof value === 'string' && (WORKER_AGENT_IDS as readonly string[]).includes(value);
}

export type RunStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['planning', 'running'];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export function isRunActive(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  queued: 'Queued',
  running: 'In progress',
  waiting_approval: 'Awaiting approval',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  summary: string | null;
  error: string | null;
  provider: ProviderKind;
  plannerModel: string;
  workerModel: string;
  workspace: string;
  maxTasks: number;
  usage: RunUsage;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Task {
  id: string;
  runId: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  agentId: AgentId;
  status: TaskStatus;
  priority: number;
  dependsOn: string[];
  result: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  usage: RunUsage;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentView {
  id: AgentId;
  name: string;
  title: string;
  color: string;
  accent: string;
  status: AgentStatus;
  activity: string;
  message: string | null;
  currentTaskId: string | null;
  completedTasks: number;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  taskId: string | null;
  agentId: AgentId | null;
  path: string;
  bytes: number;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';

export interface Approval {
  id: string;
  runId: string;
  taskId: string;
  agentId: AgentId;
  tool: string;
  arguments: unknown;
  risk: ToolRisk;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  note: string | null;
}

export interface ToolEventPayload {
  tool: string;
  agentId: AgentId;
  taskId: string;
  arguments?: unknown;
  resultPreview?: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

export interface PlanCreatedPayload {
  summary: string;
  taskCount: number;
}

export interface AgentMessagePayload {
  text: string;
  kind: 'speech' | 'result' | 'system';
}

export interface BudgetWarningPayload {
  kind: 'tokens' | 'tools' | 'time';
  used: number;
  limit: number;
}

export interface LogPayload {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RunEventPayloads {
  'run.created': Run;
  'run.planning': Run;
  'run.started': Run;
  'run.completed': Run;
  'run.failed': Run;
  'run.cancelled': Run;
  'run.interrupted': Run;
  'run.resumed': Run;
  'run.updated': Run;
  'plan.created': PlanCreatedPayload;
  'task.created': Task;
  'task.updated': Task;
  'agent.updated': AgentView;
  'agent.message': AgentMessagePayload;
  'tool.started': ToolEventPayload;
  'tool.completed': ToolEventPayload;
  'tool.failed': ToolEventPayload;
  'approval.requested': Approval;
  'approval.resolved': Approval;
  'artifact.created': Artifact;
  'budget.warning': BudgetWarningPayload;
  log: LogPayload;
}

export type RunEventType = keyof RunEventPayloads;

export interface RunEvent<T extends RunEventType = RunEventType> {
  id: string;
  runId: string;
  seq: number;
  type: T;
  payload: RunEventPayloads[T];
  agentId: AgentId | null;
  taskId: string | null;
  createdAt: string;
}

export type AnyRunEvent = {
  [K in RunEventType]: RunEvent<K>;
}[RunEventType];

export type ProviderKind = 'mock' | 'openai';

export interface ProviderSummary {
  kind: ProviderKind;
  label: string;
  plannerModel: string;
  workerModel: string;
  live: boolean;
}

export interface PublicLimits {
  maxTasks: number;
  maxAgentSteps: number;
  maxConcurrentTasks: number;
  maxRunTokens: number;
  maxToolCalls: number;
  runTimeoutMs: number;
}

export interface PublicFeatures {
  streaming: boolean;
  approvals: boolean;
  shellTools: boolean;
  fetchTool: boolean;
}

export interface PublicConfig {
  version: string;
  provider: ProviderSummary;
  limits: PublicLimits;
  features: PublicFeatures;
}

export interface RunSnapshot {
  run: Run;
  tasks: Task[];
  events: AnyRunEvent[];
  approvals: Approval[];
  artifacts: Artifact[];
  agents: AgentView[];
}

export interface BootstrapResponse {
  config: PublicConfig;
  agents: AgentView[];
  activeRun: Run | null;
  runs: Run[];
}

export interface StartRunRequest {
  goal: string;
  maxTasks?: number;
}

export interface StartRunResponse {
  run: Run;
}

export interface ResolveApprovalRequest {
  decision: 'approve' | 'deny';
  note?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  database: 'ok' | 'error';
  provider: ProviderKind;
  activeRuns: number;
  uptimeSeconds: number;
}

export const SUGGESTED_GOALS = [
  'Research, design, and ship a focused landing page for a plant-care app.',
  'Create a go-to-market plan for a developer productivity tool.',
  'Design an onboarding flow for a multiplayer coding game.',
  'Audit our idea for a local-first AI notebook and propose a build plan.',
] as const;
