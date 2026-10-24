import {
  AGENT_PROFILES,
  WORKER_AGENT_IDS,
  type ProviderKind,
} from '../shared/types';
import { PlanValidationError, planSchema, validatePlan, type PlanDraft } from './plan';
import type {
  JsonSchema,
  LlmMessage,
  LlmProvider,
  LlmToolDefinition,
  LlmUsage,
} from './llm/types';
import { LlmError } from './llm/types';

const SUBMIT_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'A crisp executive summary of the plan and intended outcome.',
    },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable short identifier, e.g. "research".' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Concrete, self-contained brief.' },
          agent: { type: 'string', enum: [...WORKER_AGENT_IDS] },
          priority: { type: 'integer', minimum: 1, maximum: 5 },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keys of tasks that must finish first.',
          },
          acceptanceCriteria: {
            type: 'string',
            description: 'How a reviewer can tell this task is done.',
          },
        },
        required: [
          'key',
          'title',
          'description',
          'agent',
          'priority',
          'dependsOn',
          'acceptanceCriteria',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'tasks'],
  additionalProperties: false,
};

const SUBMIT_PLAN_TOOL: LlmToolDefinition = {
  name: 'submit_plan',
  description: 'Submit the final execution plan for the mission. Use this exactly once.',
  parameters: SUBMIT_PLAN_SCHEMA,
};

const WORKER_PROFILES = AGENT_PROFILES.filter((profile) =>
  (WORKER_AGENT_IDS as readonly string[]).includes(profile.id),
);

const PLANNER_SYSTEM = `You are the CEO of a five-person AI studio. Your job is to turn a user's mission into a small, dependency-aware execution plan for your specialists.

The roster (you cannot assign work to yourself):
${WORKER_PROFILES.map(
  (profile) =>
    `- ${profile.id}: ${profile.name}, ${profile.title}. ${profile.systemRole}`,
).join('\n')}

Planning rules:
1. Use 3–5 tasks for a normal mission; use fewer only for genuinely simple requests.
2. Every task must be concrete, independently reviewable, and assigned to exactly one specialist.
3. Use dependencies to sequence work. Never create cycles. Parallelize independent work.
4. Avoid assigning two independent tasks to the same specialist unless the work genuinely needs multiple passes.
5. Each task needs acceptance criteria that a reviewer can verify.
6. The final task should normally be a review of the primary deliverable.
7. Do not invent tools, external facts, or completed work. Workers will inspect the workspace.
8. The plan must fully cover the user's mission without scope creep.
9. Return the plan using the submit_plan tool, not as prose.

You are accountable for the outcome. Make the plan sharp enough that a specialist can execute it without asking follow-up questions.`;

export interface PlannerResult {
  plan: PlanDraft;
  usage: LlmUsage;
  summary: string;
}

export class PlannerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PlannerError';
  }
}

export interface PlannerOptions {
  maxTasks: number;
  maxOutputTokens?: number;
}

/**
 * The CEO layer. It calls the model with a narrow planning tool, validates the
 * graph, and retries once with structured feedback when a model produces an
 * unusable plan. No model output is trusted without validation.
 */
export class Planner {
  constructor(
    private readonly provider: LlmProvider,
    private readonly model: string,
    readonly kind: ProviderKind,
  ) {}

  async plan(
    goal: string,
    options: PlannerOptions,
    signal?: AbortSignal,
  ): Promise<PlannerResult> {
    const messages: LlmMessage[] = [
      { role: 'system', content: PLANNER_SYSTEM },
      {
        role: 'user',
        content: `MISSION:\n${goal}\n\nHARD LIMIT: at most ${options.maxTasks} tasks.\nSubmit the plan now.`,
      },
    ];

    let totalUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let lastError = 'The model did not return a valid plan.';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

      let response;
      try {
        response = await this.provider.complete({
          model: this.model,
          messages,
          tools: [SUBMIT_PLAN_TOOL],
          temperature: 0.25,
          maxOutputTokens: options.maxOutputTokens ?? 2_400,
          signal,
          metadata: {
            purpose: 'plan',
            goal,
            maxTasks: options.maxTasks,
          },
        });
      } catch (error) {
        if (error instanceof LlmError && !error.retryable) {
          throw new PlannerError(`CEO planning failed: ${error.message}`, error);
        }
        lastError = error instanceof Error ? error.message : 'Unknown provider failure.';
        if (attempt === 2) break;
        await this.backoff(attempt, signal);
        continue;
      }

      totalUsage = {
        inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
      };

      const call = response.toolCalls.find((candidate) => candidate.name === 'submit_plan');
      if (!call) {
        lastError = 'The plan was returned as prose instead of calling submit_plan.';
        messages.push(
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: `Your response was not accepted: ${lastError}\nCall submit_plan with the valid JSON plan now.`,
          },
        );
        continue;
      }

      let rejection: string | null = null;
      try {
        const parsedJson: unknown = JSON.parse(call.arguments);
        const parsedPlan = planSchema.safeParse(parsedJson);
        if (!parsedPlan.success) {
          rejection = `The plan failed schema validation: ${parsedPlan.error.issues
            .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
            .join('; ')}`;
        } else {
          validatePlan(parsedPlan.data, { maxTasks: options.maxTasks });
          return {
            plan: parsedPlan.data,
            usage: totalUsage,
            summary: parsedPlan.data.summary,
          };
        }
      } catch (error) {
        rejection =
          error instanceof PlanValidationError || error instanceof SyntaxError
            ? error.message
            : `Plan could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`;
      }

      if (rejection) {
        lastError = rejection;
        messages.push(
          { role: 'assistant', content: response.content, toolCalls: response.toolCalls },
          {
            role: 'tool',
            toolCallId: call.id,
            name: 'submit_plan',
            content: `PLAN_REJECTED: ${rejection}`,
          },
          {
            role: 'user',
            content: `Your plan was rejected: ${rejection}\nReturn a corrected plan via submit_plan.`,
          },
        );
      }
    }

    throw new PlannerError(`CEO could not produce a valid plan after two attempts. ${lastError}`);
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.min(4_000, 500 * 2 ** (attempt - 1));
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
