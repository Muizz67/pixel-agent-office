import { mkdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Logger } from 'pino';
import {
  type AgentId,
  type Artifact,
  type Run,
  type RunSnapshot,
  type RunStatus,
  type Task,
} from '../shared/types';
import type { AppConfig } from './config';
import { RunBudget, type BudgetWarning } from './budget';
import type { Stores } from './db';
import { conflict, errorMessage, notFound } from './errors';
import type { RunEventService } from './events';
import { AgentPresence } from './agents';
import { ApprovalBroker } from './approvals';
import { AgentRuntime, type RuntimeHooks, type TaskOutcome } from './agent-runtime';
import type { ProviderBundle } from './llm/types';
import { Planner } from './planner';
import { normalizePlan, type PlanDraft } from './plan';
import { sleep } from './retry';
import { ToolRegistry } from './tools/builtins';
import { newId } from './ids';

interface RunControl {
  runId: string;
  abort: AbortController;
  budget: RunBudget;
  done: Promise<Run | null>;
  resolveDone: (run: Run | null) => void;
  taskPromises: Map<string, Promise<void>>;
  busyAgents: Set<AgentId>;
  notBefore: Map<string, number>;
  fatalError: Error | null;
  cancelRequested: boolean;
  timedOut: boolean;
  shutdownRequested: boolean;
}

export interface StartRunInput {
  goal: string;
  maxTasks?: number;
  idempotencyKey?: string | null;
}

export interface OrchestratorOptions {
  config: AppConfig;
  logger: Logger;
  stores: Stores;
  events: RunEventService;
  presence: AgentPresence;
  approvals: ApprovalBroker;
  provider: ProviderBundle;
  tools: ToolRegistry;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code).includes('CONSTRAINT')
  ) || (error instanceof Error && error.message.includes('UNIQUE constraint'));
}

function abortWake(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWake) => {
    signal.addEventListener('abort', () => resolveWake(), { once: true });
  });
}

function summariseTaskList(tasks: Task[]): string {
  const titles = tasks
    .filter((task) => task.status === 'completed')
    .map((task) => task.title)
    .slice(0, 4);
  return titles.join(' · ');
}

/**
 * Owns the full mission lifecycle: plan, schedule, delegate, persist, cancel,
 * resume, enforce budgets, and recover after a restart.
 *
 * A single active mission is enforced because the office has one physical set
 * of agents. Historical runs remain fully inspectable.
 */
export class OfficeOrchestrator {
  private readonly active = new Map<string, RunControl>();
  private readonly runtime: AgentRuntime;
  private readonly planner: Planner;
  private shuttingDown = false;

  constructor(private readonly options: OrchestratorOptions) {
    this.planner = new Planner(
      options.provider.provider,
      options.provider.plannerModel,
      options.provider.kind,
    );
    this.runtime = new AgentRuntime({
      config: options.config,
      provider: options.provider.provider,
      model: options.provider.workerModel,
      tools: options.tools,
      approvals: options.approvals,
      events: options.events,
      presence: options.presence,
      tasks: options.stores.tasks,
      artifacts: options.stores.artifacts,
    });
  }

  recoverFromRestart(): string[] {
    const message = 'The server restarted before this mission completed. Resume to continue.';
    const ids = this.options.stores.runs.recoverInterrupted(new Date().toISOString(), message);
    this.options.presence.resetIdle();
    for (const id of ids) {
      this.options.stores.audit.append('run.recovered', id, { status: 'interrupted' });
      this.options.logger.warn({ runId: id }, 'Marked interrupted run for recovery');
    }
    return ids;
  }

  get activeRunId(): string | null {
    return this.active.keys().next().value ?? null;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  start(input: StartRunInput): Run {
    if (this.shuttingDown) {
      throw conflict('The office is shutting down.');
    }
    const goal = input.goal.trim();
    if (!goal) throw conflict('A mission goal is required.');

    if (input.idempotencyKey) {
      const existing = this.options.stores.runs.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }

    const active = this.options.stores.runs.findActive();
    if (active || this.active.size > 0) {
      const runId = active?.id ?? this.activeRunId;
      throw conflict('Another mission is already in progress. Wait for it to finish or cancel it.', {
        runId,
      });
    }

    const id = newId('run');
    const workspace = `missions/${id}`;
    const workspacePath = resolve(this.options.config.workspaceRoot, workspace);
    const root = resolve(this.options.config.workspaceRoot);
    const rel = relative(root, workspacePath);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) {
      throw new Error('Refusing to create a workspace outside WORKSPACE_ROOT.');
    }
    mkdirSync(workspacePath, { recursive: true });

    const now = new Date().toISOString();
    const maxTasks = Math.max(
      1,
      Math.min(input.maxTasks ?? this.options.config.maxTasksPerRun, this.options.config.maxTasksPerRun),
    );
    const run: Run = {
      id,
      goal,
      status: 'planning',
      summary: null,
      error: null,
      provider: this.options.provider.kind,
      plannerModel: this.options.provider.plannerModel,
      workerModel: this.options.provider.workerModel,
      workspace,
      maxTasks,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };

    try {
      this.options.stores.runs.create(run, input.idempotencyKey ?? null);
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = this.options.stores.runs.findByIdempotencyKey(input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    this.options.events.emit(run.id, 'run.created', run);
    this.options.events.emit(run.id, 'run.planning', run);
    this.options.presence.beginMission(run.id, 'Reading the mission brief');
    this.options.stores.audit.append('run.created', run.id, {
      goal,
      provider: run.provider,
      maxTasks,
    });

    const control = this.createControl(run);
    this.active.set(run.id, control);
    void this.execute(control, false);
    return run;
  }

  waitForRun(runId: string): Promise<Run | null> {
    const control = this.active.get(runId);
    if (control) return control.done;
    return Promise.resolve(this.options.stores.runs.get(runId));
  }

  async cancel(runId: string, reason = 'Mission cancelled by operator.'): Promise<Run> {
    const control = this.active.get(runId);
    if (!control) {
      const run = this.options.stores.runs.get(runId);
      if (!run) throw notFound('Run not found.');
      if (run.status !== 'planning' && run.status !== 'running') {
        throw conflict(`Cannot cancel a mission that is already ${run.status}.`);
      }
      throw conflict('This mission is not active in the current server process.');
    }
    control.cancelRequested = true;
    if (!control.abort.signal.aborted) {
      control.abort.abort(new Error(reason));
    }
    this.options.stores.audit.append('run.cancel_requested', runId, { reason });
    await control.done;
    const run = this.options.stores.runs.get(runId);
    if (!run) throw notFound('Run not found.');
    return run;
  }

  async resume(runId: string): Promise<Run> {
    if (this.shuttingDown) throw conflict('The office is shutting down.');
    if (this.active.has(runId)) throw conflict('This mission is already active.');
    const existing = this.options.stores.runs.get(runId);
    if (!existing) throw notFound('Run not found.');
    if (existing.status !== 'interrupted') {
      throw conflict(`Only interrupted missions can be resumed (current status: ${existing.status}).`);
    }
    const active = this.options.stores.runs.findActive();
    if (active) {
      throw conflict('Another mission is already in progress.', { runId: active.id });
    }

    const now = new Date().toISOString();
    this.options.stores.runs.resetForResume(runId, now);
    const tasks = this.options.stores.tasks.listByRun(runId);
    const nextStatus: RunStatus = tasks.length > 0 ? 'running' : 'planning';
    const run: Run = {
      ...existing,
      status: nextStatus,
      error: null,
      completedAt: null,
      updatedAt: now,
    };
    this.options.stores.runs.update(run);
    this.options.events.emit(runId, 'run.resumed', run);
    this.options.presence.beginMission(runId, 'Resuming the mission');
    this.options.stores.audit.append('run.resumed', runId, {
      remainingTasks: tasks.filter((task) => task.status !== 'completed').length,
    });

    const control = this.createControl(run);
    this.active.set(runId, control);
    void this.execute(control, true);
    return run;
  }

  snapshot(runId: string): RunSnapshot {
    const run = this.options.stores.runs.get(runId);
    if (!run) throw notFound('Run not found.');
    return {
      run,
      tasks: this.options.stores.tasks.listByRun(runId),
      events: this.options.events.replay(runId, 0, 2_000),
      approvals: this.options.stores.approvals.listByRun(runId),
      artifacts: this.options.stores.artifacts.listByRun(runId),
      agents: this.options.presence.list(),
    };
  }

  getRun(runId: string): Run {
    const run = this.options.stores.runs.get(runId);
    if (!run) throw notFound('Run not found.');
    return run;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const controls = [...this.active.values()];
    for (const control of controls) {
      control.shutdownRequested = true;
      if (!control.abort.signal.aborted) {
        control.abort.abort(new Error('Server is shutting down.'));
      }
    }
    await Promise.allSettled(controls.map((control) => control.done));
  }

  private createControl(run: Run): RunControl {
    let resolveDone!: (value: Run | null) => void;
    const done = new Promise<Run | null>((resolve) => {
      resolveDone = resolve;
    });
    const budget = new RunBudget(
      {
        maxTokens: this.options.config.maxRunTokens,
        maxToolCalls: this.options.config.maxToolCallsPerRun,
      },
      run.usage,
      (warning) => this.emitBudgetWarning(run.id, warning),
    );

    return {
      runId: run.id,
      abort: new AbortController(),
      budget,
      done,
      resolveDone,
      taskPromises: new Map(),
      busyAgents: new Set(),
      notBefore: new Map(),
      fatalError: null,
      cancelRequested: false,
      timedOut: false,
      shutdownRequested: false,
    };
  }

  private async execute(control: RunControl, resumed: boolean): Promise<void> {
    const timeout = setTimeout(() => {
      control.timedOut = true;
      if (!control.abort.signal.aborted) {
        control.abort.abort(
          new Error(
            `Mission exceeded the ${Math.round(this.options.config.runTimeoutMs / 1000)}s wall-clock limit.`,
          ),
        );
      }
    }, this.options.config.runTimeoutMs);
    timeout.unref?.();

    try {
      let run = this.getRun(control.runId);
      let tasks = this.options.stores.tasks.listByRun(control.runId);
      if (tasks.length === 0) {
        run = await this.planMission(control, run);
        tasks = this.options.stores.tasks.listByRun(control.runId);
      }

      if (tasks.length === 0) {
        throw new Error('The CEO did not produce any executable tasks.');
      }

      run = this.getRun(control.runId);
      if (!run.startedAt) run.startedAt = new Date().toISOString();
      run = this.saveRun({ ...run, status: 'running', updatedAt: new Date().toISOString() });
      this.options.events.emit(control.runId, 'run.started', run);
      this.options.presence.setStatus('ceo', 'working', `Coordinating ${tasks.length} tasks`, {
        runId: control.runId,
        currentTaskId: null,
      });

      await this.schedule(control);

      const completedTasks = this.options.stores.tasks.listByRun(control.runId);
      if (!completedTasks.every((task) => task.status === 'completed')) {
        throw new Error('The scheduler stopped before every task completed.');
      }
      await this.finishCompleted(control, completedTasks);
    } catch (error) {
      await this.finishStopped(control, error);
    } finally {
      clearTimeout(timeout);
      this.options.approvals.cancelForRun(control.runId, 'Mission is no longer active.');
      this.active.delete(control.runId);
      const finalRun = this.options.stores.runs.get(control.runId);
      control.resolveDone(finalRun ?? null);
      void resumed;
    }
  }

  private async planMission(control: RunControl, initial: Run): Promise<Run> {
    let run = this.saveRun({
      ...initial,
      status: 'planning',
      error: null,
      updatedAt: new Date().toISOString(),
    });
    this.options.events.emit(run.id, 'run.planning', run);
    this.options.presence.setStatus('ceo', 'thinking', 'Drafting the mission plan', {
      runId: run.id,
      currentTaskId: null,
    });
    this.options.presence.say('ceo', 'I am turning the brief into a delegated plan.', 'speech', {
      runId: run.id,
    });

    const result = await this.planner.plan(
      run.goal,
      { maxTasks: run.maxTasks },
      control.abort.signal,
    );
    run = this.applyUsage(control, result.usage);

    const plan: PlanDraft = result.plan;
    const normalized = normalizePlan(plan, run, {
      maxTasks: run.maxTasks,
      maxAttempts: this.options.config.maxTaskAttempts,
    });
    this.options.stores.tasks.createMany(normalized.tasks);
    for (const task of normalized.tasks) {
      this.options.events.emit(run.id, 'task.created', task, {
        agentId: task.agentId,
        taskId: task.id,
      });
      this.options.presence.update(
        task.agentId,
        {
          status: 'idle',
          activity: `Queued: ${task.title.slice(0, 60)}`,
          currentTaskId: null,
        },
        { runId: run.id, taskId: task.id },
      );
    }

    run = this.saveRun({
      ...run,
      summary: normalized.summary,
      updatedAt: new Date().toISOString(),
    });
    this.options.events.emit(
      run.id,
      'plan.created',
      { summary: normalized.summary, taskCount: normalized.tasks.length },
      { agentId: 'ceo' },
    );
    this.options.presence.say('ceo', normalized.summary, 'speech', { runId: run.id });
    this.options.stores.audit.append('plan.created', run.id, {
      taskCount: normalized.tasks.length,
      agents: [...new Set(normalized.tasks.map((task) => task.agentId))],
    });
    return run;
  }

  private async schedule(control: RunControl): Promise<void> {
    const signal = control.abort.signal;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('Mission aborted.');
      control.budget.timeWarning(this.options.config.runTimeoutMs);

      let tasks = this.options.stores.tasks.listByRun(control.runId);
      if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) {
        return;
      }

      const run = this.getRun(control.runId);
      const ordered = [...tasks].sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      const now = Date.now();

      for (const task of ordered) {
        if (control.taskPromises.size >= this.options.config.maxConcurrentTasks) break;
        if (task.status !== 'queued') continue;
        if (control.busyAgents.has(task.agentId)) continue;
        if (!this.dependenciesSatisfied(task, tasks)) continue;
        if ((control.notBefore.get(task.id) ?? 0) > now) continue;
        this.launchTask(control, run, task);
      }

      if (control.taskPromises.size > 0) {
        const pending = [...control.taskPromises.values()];
        await Promise.race([...pending, abortWake(signal)]);
        continue;
      }

      tasks = this.options.stores.tasks.listByRun(control.runId);
      if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) {
        return;
      }

      const queued = tasks.filter((task) => task.status === 'queued');
      if (queued.length > 0) {
        const retryTimes = queued
          .filter((task) => this.dependenciesSatisfied(task, tasks))
          .map((task) => control.notBefore.get(task.id) ?? 0)
          .filter((time) => time > Date.now());
        if (retryTimes.length > 0) {
          const wait = Math.max(50, Math.min(...retryTimes) - Date.now());
          await sleep(wait, signal);
          continue;
        }
        const blocked = queued.find((task) => !this.dependenciesSatisfied(task, tasks));
        const error = new Error(
          blocked
            ? `Task "${blocked.title}" cannot start because one of its dependencies did not complete.`
            : 'The scheduler could not start any remaining task.',
        );
        control.fatalError = error;
        control.abort.abort(error);
        throw error;
      }

      const unfinished = tasks.filter(
        (task) =>
          task.status === 'running' ||
          task.status === 'waiting_approval' ||
          task.status === 'blocked' ||
          task.status === 'failed' ||
          task.status === 'cancelled',
      );
      if (unfinished.length > 0) {
        const failed = unfinished.find(
          (task) => task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled',
        );
        throw new Error(
          failed
            ? `Task "${failed.title}" ended as ${failed.status}: ${failed.error ?? 'no details'}`
            : 'Tasks are still marked as running but no runtime is active.',
        );
      }

      await sleep(100, signal);
    }
  }

  private launchTask(control: RunControl, run: Run, task: Task): void {
    control.busyAgents.add(task.agentId);
    const promise = this.executeTask(control, run, task).finally(() => {
      control.busyAgents.delete(task.agentId);
      control.taskPromises.delete(task.id);
    });
    control.taskPromises.set(task.id, promise);
  }

  private async executeTask(control: RunControl, run: Run, task: Task): Promise<void> {
    const tasks = this.options.stores.tasks.listByRun(control.runId);
    const dependencies = tasks.filter((candidate) => task.dependsOn.includes(candidate.id));
    const workspaceRoot = resolve(this.options.config.workspaceRoot, run.workspace);
    const hooks: RuntimeHooks = {
      recordUsage: (delta) => this.recordRunUsage(control, delta.inputTokens, delta.outputTokens, 0),
      recordToolCall: () => this.recordRunUsage(control, 0, 0, 1),
    };

    let outcome: TaskOutcome;
    try {
      outcome = await this.runtime.runTask({
        run,
        task,
        dependencies,
        attempts: task.attempts + 1,
        workspaceRoot,
        signal: control.abort.signal,
        hooks,
      });
    } catch (error) {
      if (control.abort.signal.aborted) return;
      control.fatalError = error instanceof Error ? error : new Error(errorMessage(error));
      control.abort.abort(control.fatalError);
      return;
    }

    if (outcome.status === 'completed' || outcome.status === 'cancelled') return;
    if (control.abort.signal.aborted) return;

    const latest = this.options.stores.tasks.get(task.id);
    if (!latest) return;
    if (
      outcome.retryable &&
      outcome.failureKind !== 'budget' &&
      latest.attempts < latest.maxAttempts &&
      !this.shuttingDown
    ) {
      const now = new Date().toISOString();
      const retryTask: Task = {
        ...latest,
        status: 'queued',
        error: outcome.error,
        completedAt: null,
        updatedAt: now,
      };
      this.options.stores.tasks.update(retryTask);
      this.options.events.emit(control.runId, 'task.updated', retryTask, {
        agentId: retryTask.agentId,
        taskId: retryTask.id,
      });
      const delay = Math.min(8_000, 750 * 2 ** (latest.attempts - 1));
      control.notBefore.set(task.id, Date.now() + delay);
      this.options.presence.setStatus(
        task.agentId,
        'idle',
        `Retry queued in ${Math.round(delay / 1000)}s`,
        { runId: control.runId, taskId: task.id, currentTaskId: null },
      );
      this.options.events.emit(
        control.runId,
        'log',
        {
          level: 'warn',
          message: `Retrying "${task.title}" in ${Math.round(delay / 1000)}s (attempt ${latest.attempts + 1}/${latest.maxAttempts}).`,
        },
        { agentId: task.agentId, taskId: task.id },
      );
      return;
    }

    control.fatalError =
      outcome.failureKind === 'budget'
        ? new Error(outcome.error ?? 'Mission budget exhausted.')
        : new Error(`Task "${task.title}" failed: ${outcome.error ?? 'unknown error'}`);
    if (!control.abort.signal.aborted) control.abort.abort(control.fatalError);
  }

  private dependenciesSatisfied(task: Task, tasks: Task[]): boolean {
    if (task.dependsOn.length === 0) return true;
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    return task.dependsOn.every((id) => byId.get(id)?.status === 'completed');
  }

  private recordRunUsage(
    control: RunControl,
    inputTokens: number,
    outputTokens: number,
    toolCalls: number,
  ): void {
    const run = this.getRun(control.runId);
    const updated = this.saveRun({
      ...run,
      usage: {
        inputTokens: run.usage.inputTokens + inputTokens,
        outputTokens: run.usage.outputTokens + outputTokens,
        toolCalls: run.usage.toolCalls + toolCalls,
      },
      updatedAt: new Date().toISOString(),
    });
    this.options.events.emit(control.runId, 'run.updated', updated);
    if (inputTokens || outputTokens) {
      control.budget.addTokens(inputTokens, outputTokens);
    }
    if (toolCalls) {
      control.budget.reserveToolCall();
    }
  }

  private applyUsage(control: RunControl, usage: { inputTokens: number; outputTokens: number }): Run {
    const run = this.getRun(control.runId);
    const updated = this.saveRun({
      ...run,
      usage: {
        ...run.usage,
        inputTokens: run.usage.inputTokens + usage.inputTokens,
        outputTokens: run.usage.outputTokens + usage.outputTokens,
      },
      updatedAt: new Date().toISOString(),
    });
    this.options.events.emit(control.runId, 'run.updated', updated);
    control.budget.addTokens(usage.inputTokens, usage.outputTokens);
    return updated;
  }

  private async finishCompleted(control: RunControl, tasks: Task[]): Promise<void> {
    const artifacts = this.options.stores.artifacts.listByRun(control.runId);
    const before = this.options.stores.runs.get(control.runId);
    if (!before) throw new Error('Run disappeared before completion.');
    const delivered = summariseTaskList(tasks);
    const summary = [
      `Mission complete. ${tasks.filter((task) => task.status === 'completed').length}/${tasks.length} tasks delivered.`,
      delivered ? `Outputs: ${delivered}.` : '',
      artifacts.length > 0
        ? `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} saved in \`${before.workspace}\`.`
        : 'No files were written; results are in the task handoffs.',
    ]
      .filter(Boolean)
      .join(' ');

    const run = this.saveRun({
      ...before,
      status: 'completed',
      summary,
      error: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.options.presence.say('ceo', summary, 'result', { runId: control.runId });
    for (const agentId of ['ceo', 'researcher', 'designer', 'engineer', 'reviewer'] as AgentId[]) {
      this.options.presence.setStatus(
        agentId,
        agentId === 'ceo' ? 'celebrating' : 'idle',
        'Mission complete',
        { runId: control.runId, currentTaskId: null },
      );
    }
    // Terminal events are emitted last so clients that stop reading at the
    // terminal frame still observe the final agent and task state.
    this.options.events.emit(control.runId, 'run.completed', run);
    this.options.stores.audit.append('run.completed', control.runId, {
      artifacts: artifacts.length,
      tokens: run.usage.inputTokens + run.usage.outputTokens,
      toolCalls: run.usage.toolCalls,
    });
  }

  private async finishStopped(control: RunControl, error: unknown): Promise<void> {
    const reason = errorMessage(error);
    const cancelled = control.cancelRequested;
    const interrupted = control.shutdownRequested;
    const status: RunStatus = cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed';

    if (!control.abort.signal.aborted) control.abort.abort(error);
    this.options.approvals.cancelForRun(
      control.runId,
      cancelled ? 'Mission cancelled.' : 'Mission stopped.',
    );

    const pending = [...control.taskPromises.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        sleep(5_000).catch(() => undefined),
      ]);
    }

    const now = new Date().toISOString();
    const message = cancelled
      ? 'Mission cancelled by operator.'
      : interrupted
        ? 'Server shut down before the mission completed. Resume to continue.'
        : this.shuttingDown
          ? 'Server shut down before the mission completed. Resume to continue.'
          : reason;
    const tasks = this.options.stores.tasks.listByRun(control.runId);
    for (const task of tasks) {
      if (
        task.status === 'queued' ||
        task.status === 'running' ||
        task.status === 'waiting_approval'
      ) {
        const stopped: Task = {
          ...task,
          status: 'cancelled',
          error: message,
          completedAt: now,
          updatedAt: now,
        };
        this.options.stores.tasks.update(stopped);
        this.options.events.emit(control.runId, 'task.updated', stopped, {
          agentId: stopped.agentId,
          taskId: stopped.id,
        });
        this.options.presence.setStatus(
          stopped.agentId,
          cancelled || interrupted ? 'idle' : 'blocked',
          cancelled || interrupted ? 'Mission stopped' : 'Task not completed',
          { runId: control.runId, taskId: stopped.id, currentTaskId: null },
        );
      }
    }

    const before = this.options.stores.runs.get(control.runId);
    if (!before) return;
    const run = this.saveRun({
      ...before,
      status,
      error: message,
      completedAt: now,
      updatedAt: now,
    });
    const eventType = cancelled
      ? 'run.cancelled'
      : interrupted || this.shuttingDown
        ? 'run.interrupted'
        : 'run.failed';

    if (status === 'failed') {
      const failedTask = tasks.find((task) => task.status === 'failed');
      this.options.presence.setStatus(
        'ceo',
        'error',
        failedTask ? `Mission failed · ${failedTask.title}` : 'Mission failed',
        { runId: control.runId, currentTaskId: null },
      );
      this.options.presence.say('ceo', `Mission failed: ${message}`, 'system', {
        runId: control.runId,
      });
    } else if (status === 'cancelled') {
      this.options.presence.setStatus('ceo', 'idle', 'Mission cancelled', {
        runId: control.runId,
        currentTaskId: null,
      });
      this.options.presence.say('ceo', 'Mission cancelled. Workspace and history were preserved.', 'system', {
        runId: control.runId,
      });
    } else {
      this.options.presence.setStatus('ceo', 'idle', 'Interrupted · resumable', {
        runId: control.runId,
        currentTaskId: null,
      });
      this.options.presence.say('ceo', 'The server stopped. This mission can be resumed.', 'system', {
        runId: control.runId,
      });
    }

    this.options.stores.audit.append(`run.${status}`, control.runId, {
      reason: message,
      cancelRequested: cancelled,
      timedOut: control.timedOut,
      fatal: control.fatalError?.message ?? null,
    });
    if (control.timedOut) {
      this.options.events.emit(
        control.runId,
        'log',
        { level: 'error', message: 'Mission stopped after exceeding its wall-clock limit.' },
        {},
      );
    }
    // Keep the terminal event last; see finishCompleted.
    this.options.events.emit(control.runId, eventType, run);
  }

  private saveRun(run: Run): Run {
    return this.options.stores.runs.update(run);
  }

  private emitBudgetWarning(runId: string, warning: BudgetWarning): void {
    this.options.events.emit(runId, 'budget.warning', warning);
    this.options.events.emit(
      runId,
      'log',
      {
        level: warning.kind === 'tokens' ? 'warn' : 'warn',
        message: `${warning.kind} budget at ${Math.round((warning.used / warning.limit) * 100)}% (${warning.used}/${warning.limit}).`,
      },
      {},
    );
  }

  artifactsFor(runId: string): Artifact[] {
    return this.options.stores.artifacts.listByRun(runId);
  }
}
