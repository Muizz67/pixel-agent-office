import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentId,
  AnyRunEvent,
  Approval,
  ApprovalStatus,
  Artifact,
  ProviderKind,
  Run,
  RunEventType,
  RunStatus,
  Task,
  TaskStatus,
  ToolRisk,
  RunEvent,
} from '../shared/types';
import { newId } from './ids';

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | null | Uint8Array;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: Row): Run {
  return {
    id: asString(row.id),
    goal: asString(row.goal),
    status: asString(row.status) as RunStatus,
    summary: asNullableString(row.summary),
    error: asNullableString(row.error),
    provider: asString(row.provider) as ProviderKind,
    plannerModel: asString(row.planner_model),
    workerModel: asString(row.worker_model),
    workspace: asString(row.workspace),
    maxTasks: asNumber(row.max_tasks),
    usage: {
      inputTokens: asNumber(row.input_tokens),
      outputTokens: asNumber(row.output_tokens),
      toolCalls: asNumber(row.tool_calls),
    },
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at),
  };
}

function mapTask(row: Row): Task {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    title: asString(row.title),
    description: asString(row.description),
    acceptanceCriteria: asNullableString(row.acceptance_criteria),
    agentId: asString(row.agent_id) as AgentId,
    status: asString(row.status) as TaskStatus,
    priority: asNumber(row.priority, 3),
    dependsOn: parseJson<string[]>(row.depends_on, []),
    result: asNullableString(row.result),
    error: asNullableString(row.error),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts, 2),
    usage: {
      inputTokens: asNumber(row.input_tokens),
      outputTokens: asNumber(row.output_tokens),
      toolCalls: asNumber(row.tool_calls),
    },
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at),
  };
}

function mapEvent(row: Row): AnyRunEvent {
  const event = {
    id: asString(row.id),
    runId: asString(row.run_id),
    seq: asNumber(row.seq),
    type: asString(row.type) as RunEventType,
    payload: parseJson<unknown>(row.payload, {}),
    agentId: asNullableString(row.agent_id) as AgentId | null,
    taskId: asNullableString(row.task_id),
    createdAt: asString(row.created_at),
  };
  return event as AnyRunEvent;
}

function mapApproval(row: Row): Approval {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    taskId: asString(row.task_id),
    agentId: asString(row.agent_id) as AgentId,
    tool: asString(row.tool),
    arguments: parseJson<unknown>(row.arguments_json, {}),
    risk: asString(row.risk) as ToolRisk,
    reason: asString(row.reason),
    status: asString(row.status) as ApprovalStatus,
    createdAt: asString(row.created_at),
    expiresAt: asString(row.expires_at),
    resolvedAt: asNullableString(row.resolved_at),
    note: asNullableString(row.note),
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    taskId: asNullableString(row.task_id),
    agentId: asNullableString(row.agent_id) as AgentId | null,
    path: asString(row.path),
    bytes: asNumber(row.bytes),
    createdAt: asString(row.created_at),
  };
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    error TEXT,
    provider TEXT NOT NULL,
    planner_model TEXT NOT NULL,
    worker_model TEXT NOT NULL,
    workspace TEXT NOT NULL,
    max_tasks INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    idempotency_key TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
    ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 3,
    depends_on TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id, ordinal);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    agent_id TEXT,
    task_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    risk TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT,
    agent_id TEXT,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, path)
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  `,
];

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  resource: string;
  metadata: unknown;
  createdAt: string;
}

export class OfficeDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL;');
      this.raw.exec('PRAGMA synchronous = NORMAL;');
    }
    this.migrate();
  }

  private migrate(): void {
    this.transaction(() => {
      const version = this.raw.prepare('PRAGMA user_version').get() as Row | undefined;
      const current = asNumber(version?.user_version);
      for (let index = current; index < MIGRATIONS.length; index += 1) {
        const migration = MIGRATIONS[index];
        if (!migration) continue;
        this.raw.exec(migration);
      }
      this.raw.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.raw.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK;');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }

  ping(): boolean {
    try {
      this.raw.prepare('SELECT 1 AS ok').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export class RunStore {
  constructor(private readonly db: OfficeDatabase) {}

  create(run: Run, idempotencyKey: string | null): Run {
    this.db.raw
      .prepare(
        `INSERT INTO runs (
          id, goal, status, summary, error, provider, planner_model, worker_model,
          workspace, max_tasks, input_tokens, output_tokens, tool_calls,
          created_at, updated_at, started_at, completed_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.goal,
        run.status,
        run.summary,
        run.error,
        run.provider,
        run.plannerModel,
        run.workerModel,
        run.workspace,
        run.maxTasks,
        run.usage.inputTokens,
        run.usage.outputTokens,
        run.usage.toolCalls,
        run.createdAt,
        run.updatedAt,
        run.startedAt,
        run.completedAt,
        idempotencyKey,
      );
    return run;
  }

  update(run: Run): Run {
    this.db.raw
      .prepare(
        `UPDATE runs SET
          status = ?, summary = ?, error = ?, input_tokens = ?, output_tokens = ?,
          tool_calls = ?, updated_at = ?, started_at = ?, completed_at = ?
        WHERE id = ?`,
      )
      .run(
        run.status,
        run.summary,
        run.error,
        run.usage.inputTokens,
        run.usage.outputTokens,
        run.usage.toolCalls,
        run.updatedAt,
        run.startedAt,
        run.completedAt,
        run.id,
      );
    return run;
  }

  get(id: string): Run | null {
    const row = this.db.raw.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  findByIdempotencyKey(key: string): Run | null {
    const row = this.db.raw
      .prepare('SELECT * FROM runs WHERE idempotency_key = ?')
      .get(key) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  findActive(): Run | null {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM runs WHERE status IN ('planning','running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    return row ? mapRun(row) : null;
  }

  list(limit = 20, offset = 0): Run[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Row[];
    return rows.map(mapRun);
  }

  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row | undefined;
    return asNumber(row?.count);
  }

  countByStatus(): Array<{ status: string; count: number }> {
    const rows = this.db.raw
      .prepare('SELECT status, COUNT(*) AS count FROM runs GROUP BY status')
      .all() as Row[];
    return rows.map((row) => ({ status: asString(row.status), count: asNumber(row.count) }));
  }

  usageTotals(): { inputTokens: number; outputTokens: number; toolCalls: number } {
    const row = this.db.raw
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) AS tokens_in,
         COALESCE(SUM(output_tokens),0) AS tokens_out,
         COALESCE(SUM(tool_calls),0) AS tool_calls
         FROM runs`,
      )
      .get() as Row | undefined;
    return {
      inputTokens: asNumber(row?.tokens_in),
      outputTokens: asNumber(row?.tokens_out),
      toolCalls: asNumber(row?.tool_calls),
    };
  }

  recoverInterrupted(now: string, message: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db.raw
        .prepare(`SELECT id FROM runs WHERE status IN ('planning','running')`)
        .all() as Row[];
      const ids = rows.map((row) => asString(row.id));
      if (ids.length > 0) {
        this.db.raw
          .prepare(
            `UPDATE runs SET status = 'interrupted', error = ?, updated_at = ?,
             completed_at = COALESCE(completed_at, ?)
             WHERE status IN ('planning','running')`,
          )
          .run(message, now, now);

        this.db.raw
          .prepare(
            `UPDATE tasks SET status = 'queued', updated_at = ?,
             error = 'Interrupted by a server restart; queued for resume.'
             WHERE run_id IN (${ids.map(() => '?').join(',')})
             AND status IN ('running','waiting_approval')`,
          )
          .run(now, ...ids);

        this.db.raw
          .prepare(
            `UPDATE approvals SET status = 'expired', resolved_at = ?,
             note = COALESCE(note, 'Expired when the server restarted.')
             WHERE run_id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`,
          )
          .run(now, ...ids);
      }
      return ids;
    });
  }

  updateStatus(
    id: string,
    status: RunStatus,
    fields: Partial<Pick<Run, 'summary' | 'error' | 'startedAt' | 'completedAt'>> = {},
  ): Run | null {
    const run = this.get(id);
    if (!run) return null;
    const updated: Run = {
      ...run,
      ...fields,
      status,
      updatedAt: new Date().toISOString(),
    };
    return this.update(updated);
  }

  withUsage(id: string, usage: { inputTokens: number; outputTokens: number; toolCalls: number }): Run {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    const updated: Run = {
      ...run,
      usage: {
        inputTokens: run.usage.inputTokens + usage.inputTokens,
        outputTokens: run.usage.outputTokens + usage.outputTokens,
        toolCalls: run.usage.toolCalls + usage.toolCalls,
      },
      updatedAt: new Date().toISOString(),
    };
    return this.update(updated);
  }

  resetForResume(id: string, now: string): void {
    this.db.transaction(() => {
      this.db.raw
        .prepare(
          `UPDATE tasks SET status = 'queued', error = NULL, result = NULL,
           attempts = 0, started_at = NULL, completed_at = NULL, updated_at = ?
           WHERE run_id = ? AND status <> 'completed'`,
        )
        .run(now, id);
      this.db.raw
        .prepare(
          `UPDATE approvals SET status = 'cancelled', resolved_at = ?,
           note = COALESCE(note, 'Cancelled when the run resumed.')
           WHERE run_id = ? AND status = 'pending'`,
        )
        .run(now, id);
    });
  }
}

export class TaskStore {
  constructor(private readonly db: OfficeDatabase) {}

  createMany(tasks: Task[]): void {
    const statement = this.db.raw.prepare(
      `INSERT INTO tasks (
        id, run_id, ordinal, title, description, acceptance_criteria, agent_id, status,
        priority, depends_on, result, error, attempts, max_attempts,
        input_tokens, output_tokens, tool_calls,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      tasks.forEach((task, ordinal) => {
        statement.run(
          task.id,
          task.runId,
          ordinal,
          task.title,
          task.description,
          task.acceptanceCriteria,
          task.agentId,
          task.status,
          task.priority,
          JSON.stringify(task.dependsOn),
          task.result,
          task.error,
          task.attempts,
          task.maxAttempts,
          task.usage.inputTokens,
          task.usage.outputTokens,
          task.usage.toolCalls,
          task.createdAt,
          task.updatedAt,
          task.startedAt,
          task.completedAt,
        );
      });
    });
  }

  update(task: Task): Task {
    this.db.raw
      .prepare(
        `UPDATE tasks SET
          status = ?, result = ?, error = ?, attempts = ?, max_attempts = ?,
          input_tokens = ?, output_tokens = ?, tool_calls = ?,
          updated_at = ?, started_at = ?, completed_at = ?
        WHERE id = ?`,
      )
      .run(
        task.status,
        task.result,
        task.error,
        task.attempts,
        task.maxAttempts,
        task.usage.inputTokens,
        task.usage.outputTokens,
        task.usage.toolCalls,
        task.updatedAt,
        task.startedAt,
        task.completedAt,
        task.id,
      );
    return task;
  }

  get(id: string): Task | null {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTask(row) : null;
  }

  listByRun(runId: string): Task[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY ordinal ASC')
      .all(runId) as Row[];
    return rows.map(mapTask);
  }

  countByStatus(): Array<{ status: string; count: number }> {
    const rows = this.db.raw
      .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
      .all() as Row[];
    return rows.map((row) => ({ status: asString(row.status), count: asNumber(row.count) }));
  }
}

export class EventStore {
  constructor(private readonly db: OfficeDatabase) {}

  append<T extends RunEventType>(
    runId: string,
    type: T,
    payload: AnyRunEvent['payload'],
    options: {
      agentId?: AgentId | null;
      taskId?: string | null;
      createdAt?: string;
    } = {},
  ): RunEvent<T> {
    return this.db.transaction(() => {
      const row = this.db.raw
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?')
        .get(runId) as Row | undefined;
      const seq = asNumber(row?.seq) + 1;
      const event: RunEvent<T> = {
        id: newId('evt'),
        runId,
        seq,
        type,
        payload: payload as RunEvent<T>['payload'],
        agentId: options.agentId ?? null,
        taskId: options.taskId ?? null,
        createdAt: options.createdAt ?? new Date().toISOString(),
      };
      this.db.raw
        .prepare(
          `INSERT INTO events (id, run_id, seq, type, payload, agent_id, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.runId,
          event.seq,
          event.type,
          JSON.stringify(event.payload),
          event.agentId,
          event.taskId,
          event.createdAt,
        );
      return event;
    });
  }

  list(runId: string, after = 0, limit = 1000): AnyRunEvent[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM events WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(runId, after, limit) as Row[];
    return rows.map(mapEvent);
  }

  latestSeq(runId: string): number {
    const row = this.db.raw
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?')
      .get(runId) as Row | undefined;
    return asNumber(row?.seq);
  }

  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS count FROM events').get() as Row | undefined;
    return asNumber(row?.count);
  }
}

export class ApprovalStore {
  constructor(private readonly db: OfficeDatabase) {}

  create(approval: Approval): Approval {
    this.db.raw
      .prepare(
        `INSERT INTO approvals (
          id, run_id, task_id, agent_id, tool, arguments_json, risk,
          reason, status, created_at, expires_at, resolved_at, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.taskId,
        approval.agentId,
        approval.tool,
        JSON.stringify(approval.arguments),
        approval.risk,
        approval.reason,
        approval.status,
        approval.createdAt,
        approval.expiresAt,
        approval.resolvedAt,
        approval.note,
      );
    return approval;
  }

  get(id: string): Approval | null {
    const row = this.db.raw
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? mapApproval(row) : null;
  }

  listByRun(runId: string): Approval[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Row[];
    return rows.map(mapApproval);
  }

  listPending(runId: string): Approval[] {
    const rows = this.db.raw
      .prepare(
        "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC",
      )
      .all(runId) as Row[];
    return rows.map(mapApproval);
  }

  resolve(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    note: string | null,
    now: string,
  ): Approval | null {
    this.db.raw
      .prepare('UPDATE approvals SET status = ?, resolved_at = ?, note = ? WHERE id = ?')
      .run(status, now, note, id);
    return this.get(id);
  }

  expirePendingForRun(runId: string, status: 'expired' | 'cancelled', note: string, now: string): void {
    this.db.raw
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, note = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(status, now, note, runId);
  }

  countPending(): number {
    const row = this.db.raw
      .prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'")
      .get() as Row | undefined;
    return asNumber(row?.count);
  }
}

export class ArtifactStore {
  constructor(private readonly db: OfficeDatabase) {}

  upsert(artifact: Artifact): Artifact {
    this.db.raw
      .prepare(
        `INSERT INTO artifacts (id, run_id, task_id, agent_id, path, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, path) DO UPDATE SET
           task_id = excluded.task_id, agent_id = excluded.agent_id,
           bytes = excluded.bytes, created_at = excluded.created_at`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.taskId,
        artifact.agentId,
        artifact.path,
        artifact.bytes,
        artifact.createdAt,
      );
    const row = this.db.raw
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND path = ?')
      .get(artifact.runId, artifact.path) as Row | undefined;
    return row ? mapArtifact(row) : artifact;
  }

  listByRun(runId: string): Artifact[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Row[];
    return rows.map(mapArtifact);
  }

  findByPath(runId: string, path: string): Artifact | null {
    const row = this.db.raw
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND path = ?')
      .get(runId, path) as Row | undefined;
    return row ? mapArtifact(row) : null;
  }

  count(): number {
    const row = this.db.raw
      .prepare('SELECT COUNT(*) AS count FROM artifacts')
      .get() as Row | undefined;
    return asNumber(row?.count);
  }
}

export class AuditStore {
  constructor(private readonly db: OfficeDatabase) {}

  append(action: string, resource: string, metadata: unknown, actor = 'local'): AuditEntry {
    const entry: AuditEntry = {
      id: newId('aud'),
      actor,
      action,
      resource,
      metadata,
      createdAt: new Date().toISOString(),
    };
    this.db.raw
      .prepare(
        `INSERT INTO audit_log (id, actor, action, resource, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.actor,
        entry.action,
        entry.resource,
        JSON.stringify(entry.metadata),
        entry.createdAt,
      );
    return entry;
  }

  list(limit = 100): AuditEntry[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      actor: asString(row.actor),
      action: asString(row.action),
      resource: asString(row.resource),
      metadata: parseJson<unknown>(row.metadata_json, {}),
      createdAt: asString(row.created_at),
    }));
  }
}

export interface Stores {
  runs: RunStore;
  tasks: TaskStore;
  events: EventStore;
  approvals: ApprovalStore;
  artifacts: ArtifactStore;
  audit: AuditStore;
}

export function createStores(db: OfficeDatabase): Stores {
  return {
    runs: new RunStore(db),
    tasks: new TaskStore(db),
    events: new EventStore(db),
    approvals: new ApprovalStore(db),
    artifacts: new ArtifactStore(db),
    audit: new AuditStore(db),
  };
}

export type { SqlValue };
