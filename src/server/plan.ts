import { z } from 'zod';
import {
  WORKER_AGENT_IDS,
  type Run,
  type Task,
} from '../shared/types';
import { newId } from './ids';

export const planTaskSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Task keys may only contain letters, numbers, dashes, and underscores.'),
    title: z.string().min(3).max(160),
    description: z.string().min(10).max(4_000),
    agent: z.enum(WORKER_AGENT_IDS),
    priority: z.number().int().min(1).max(5).optional().default(3),
    dependsOn: z.array(z.string().min(1).max(48)).max(8).optional().default([]),
    acceptanceCriteria: z.string().max(1_500).optional().default(''),
  })
  .strict();

export const planSchema = z
  .object({
    summary: z.string().min(10).max(2_000),
    tasks: z.array(planTaskSchema).min(1).max(12),
  })
  .strict();

export type PlanTaskDraft = z.infer<typeof planTaskSchema>;
export type PlanDraft = z.infer<typeof planSchema>;

export interface NormalizedPlan {
  summary: string;
  tasks: Task[];
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export interface ValidatePlanOptions {
  maxTasks: number;
}

export function validatePlan(plan: PlanDraft, options: ValidatePlanOptions): void {
  if (plan.tasks.length > options.maxTasks) {
    throw new PlanValidationError(
      `The plan contains ${plan.tasks.length} tasks, but this office allows at most ${options.maxTasks}.`,
    );
  }

  const keys = new Set<string>();
  for (const task of plan.tasks) {
    if (keys.has(task.key)) {
      throw new PlanValidationError(`Duplicate task key "${task.key}".`);
    }
    keys.add(task.key);
  }

  const dependencies = new Map<string, string[]>();
  for (const task of plan.tasks) {
    const unique = [...new Set(task.dependsOn)];
    if (unique.length !== task.dependsOn.length) {
      throw new PlanValidationError(`Task "${task.key}" lists a dependency more than once.`);
    }
    for (const dependency of unique) {
      if (dependency === task.key) {
        throw new PlanValidationError(`Task "${task.key}" cannot depend on itself.`);
      }
      if (!keys.has(dependency)) {
        throw new PlanValidationError(
          `Task "${task.key}" depends on unknown task "${dependency}".`,
        );
      }
    }
    dependencies.set(task.key, unique);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    if (visiting.has(key)) {
      throw new PlanValidationError(
        `The plan contains a dependency cycle: ${[...path, key].join(' → ')}.`,
      );
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      visit(dependency, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of plan.tasks) visit(task.key, []);
}

export function normalizePlan(
  plan: PlanDraft,
  run: Pick<Run, 'id'>,
  options: { maxTasks: number; maxAttempts: number; now?: Date },
): NormalizedPlan {
  validatePlan(plan, { maxTasks: options.maxTasks });
  const now = (options.now ?? new Date()).toISOString();
  const keyToId = new Map<string, string>();
  for (const task of plan.tasks) {
    keyToId.set(task.key, newId('tsk'));
  }

  const tasks: Task[] = plan.tasks.map((task) => ({
    id: keyToId.get(task.key)!,
    runId: run.id,
    title: task.title.trim(),
    description: task.description.trim(),
    acceptanceCriteria: task.acceptanceCriteria.trim() || null,
    agentId: task.agent,
    status: 'queued',
    priority: task.priority,
    dependsOn: [...new Set(task.dependsOn)].map((key) => keyToId.get(key)!),
    result: null,
    error: null,
    attempts: 0,
    maxAttempts: options.maxAttempts,
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
  }));

  return { summary: plan.summary.trim(), tasks };
}

export function topologicalOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const order: Task[] = [];
  const visited = new Set<string>();
  const visit = (task: Task): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const dependency of task.dependsOn) {
      const parent = byId.get(dependency);
      if (parent) visit(parent);
    }
    order.push(task);
  };
  tasks.forEach(visit);
  return order;
}
