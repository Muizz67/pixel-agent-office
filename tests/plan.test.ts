import { describe, expect, it } from 'vitest';
import { PlanValidationError, normalizePlan, topologicalOrder, validatePlan, type PlanDraft } from '../src/server/plan';

function plan(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    summary: 'A small, ordered plan for the office test suite.',
    tasks: [
      {
        key: 'research',
        title: 'Research the brief',
        description: 'Collect context and constraints for the mission.',
        agent: 'researcher',
        priority: 1,
        dependsOn: [],
        acceptanceCriteria: 'Notes are written.',
      },
      {
        key: 'build',
        title: 'Build the deliverable',
        description: 'Produce the concrete artifact requested by the mission.',
        agent: 'engineer',
        priority: 3,
        dependsOn: ['research'],
        acceptanceCriteria: 'Artifact exists.',
      },
    ],
    ...overrides,
  };
}

describe('plan validation', () => {
  it('accepts a valid acyclic plan', () => {
    expect(() => validatePlan(plan(), { maxTasks: 8 })).not.toThrow();
  });

  it('rejects duplicate keys', () => {
    const draft = plan();
    draft.tasks[1]!.key = 'research';
    draft.tasks[1]!.dependsOn = [];
    expect(() => validatePlan(draft, { maxTasks: 8 })).toThrow(/Duplicate task key/);
  });

  it('rejects unknown dependencies', () => {
    const draft = plan();
    draft.tasks[1]!.dependsOn = ['missing'];
    expect(() => validatePlan(draft, { maxTasks: 8 })).toThrow(/unknown task/);
  });

  it('rejects self dependencies and duplicate dependencies', () => {
    const self = plan();
    self.tasks[0]!.dependsOn = ['research'];
    expect(() => validatePlan(self, { maxTasks: 8 })).toThrow(/cannot depend on itself/);

    const duplicate = plan();
    duplicate.tasks[1]!.dependsOn = ['research', 'research'];
    expect(() => validatePlan(duplicate, { maxTasks: 8 })).toThrow(/more than once/);
  });

  it('rejects dependency cycles', () => {
    const draft = plan();
    draft.tasks[0]!.dependsOn = ['build'];
    expect(() => validatePlan(draft, { maxTasks: 8 })).toThrow(/dependency cycle/);
  });

  it('enforces the task budget', () => {
    expect(() => validatePlan(plan(), { maxTasks: 1 })).toThrow(PlanValidationError);
  });
});

describe('plan normalization', () => {
  it('maps dependency keys to generated task ids', () => {
    const normalized = normalizePlan(
      plan(),
      { id: 'run_test' },
      { maxTasks: 8, maxAttempts: 2, now: new Date('2026-01-01T00:00:00.000Z') },
    );
    expect(normalized.tasks).toHaveLength(2);
    const research = normalized.tasks.find((task) => task.title === 'Research the brief');
    const build = normalized.tasks.find((task) => task.title === 'Build the deliverable');
    expect(research).toBeDefined();
    expect(build?.dependsOn).toEqual([research!.id]);
    expect(build?.runId).toBe('run_test');
    expect(build?.status).toBe('queued');
    expect(build?.maxAttempts).toBe(2);
  });

  it('orders tasks so dependencies come first', () => {
    const normalized = normalizePlan(
      plan(),
      { id: 'run_test' },
      { maxTasks: 8, maxAttempts: 2 },
    );
    const ordered = topologicalOrder(normalized.tasks);
    expect(ordered.map((task) => task.title)).toEqual([
      'Research the brief',
      'Build the deliverable',
    ]);
  });
});
