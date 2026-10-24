import type { AgentId } from '../../shared/types';
import { AGENT_PROFILE_MAP } from '../../shared/types';
import { randomUUID } from 'node:crypto';
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from './types';

interface MockPlanTask {
  key: string;
  title: string;
  description: string;
  agent: AgentId;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildPlan(goal: string, maxTasks: number): { summary: string; tasks: MockPlanTask[] } {
  const compactGoal = goal.replace(/\s+/g, ' ').trim();
  const bounded = Math.max(1, Math.min(maxTasks, 4));
  const all: MockPlanTask[] = [
    {
      key: 'research',
      title: 'Research the brief and surface constraints',
      description: `Investigate the context behind: "${compactGoal}". Identify the audience, assumptions, risks, and the evidence the team needs before committing to a direction. Write a concise research brief to the workspace.`,
      agent: 'researcher',
      priority: 2,
      dependsOn: [],
      acceptanceCriteria:
        'A research brief records the target audience, 3–5 findings, key risks, and open questions.',
    },
    {
      key: 'design',
      title: 'Shape the solution and experience',
      description: `Translate the research into a concrete product direction for: "${compactGoal}". Define the core flow, interface states, edge cases, and tradeoffs. Record the proposal as a design brief.`,
      agent: 'designer',
      priority: 2,
      dependsOn: ['research'],
      acceptanceCriteria:
        'A design brief defines the primary flow, key screens, empty/error states, and open design questions.',
    },
    {
      key: 'build',
      title: 'Produce the primary deliverable',
      description: `Using the available research and design context, produce a concrete deliverable for: "${compactGoal}". Prefer a focused artifact that someone could act on immediately. Verify it against the brief and write it to the workspace.`,
      agent: 'engineer',
      priority: 3,
      dependsOn: bounded >= 4 ? ['research', 'design'] : bounded >= 2 ? ['research'] : [],
      acceptanceCriteria:
        'The deliverable is complete in the workspace, grounded in the brief, and includes verification notes.',
    },
    {
      key: 'review',
      title: 'Review the deliverable against the brief',
      description: `Inspect the completed work for "${compactGoal}" and review it against the original brief. Check evidence, gaps, usability, and risk. Produce a verdict with concrete follow-ups.`,
      agent: 'reviewer',
      priority: 2,
      dependsOn: ['build'],
      acceptanceCriteria:
        'The review gives a clear verdict, cites concrete evidence, lists defects by severity, and proposes next steps.',
    },
  ];

  let selected: MockPlanTask[];
  if (bounded === 1) selected = [all[2]!];
  else if (bounded === 2) selected = [all[0]!, all[2]!];
  else if (bounded === 3) selected = [all[0]!, all[2]!, all[3]!];
  else selected = all;

  const included = new Set(selected.map((task) => task.key));
  selected = selected.map((task) => ({
    ...task,
    dependsOn: task.dependsOn.filter((dependency) => included.has(dependency)),
  }));

  return {
    summary: `A ${selected.length}-step mission: research the brief, shape the direction, produce a concrete deliverable, and review it before handoff.`,
    tasks: selected,
  };
}

function workerArtifact(request: LlmRequest): { path: string; content: string } {
  const metadata = request.metadata;
  const taskId = metadata?.taskId ?? 'task';
  const agentId = metadata?.agentId ?? 'engineer';
  const profile = AGENT_PROFILE_MAP[agentId];
  const title = metadata?.taskTitle ?? 'Mission deliverable';
  const goal = metadata?.goal ?? 'the requested mission';
  const path = `artifacts/${taskId.slice(0, 18)}-${agentId}.md`;
  const sections: Record<AgentId, string> = {
    ceo: 'Executive direction',
    researcher: 'Research brief',
    designer: 'Design brief',
    engineer: 'Implementation deliverable',
    reviewer: 'Quality review',
  };
  const content = `# ${title}

**Prepared by:** ${profile.name} — ${profile.title}
**Mission:** ${goal}
**Mode:** deterministic local studio provider

## ${sections[agentId]}

This artifact was produced by the built-in mock provider so the complete
orchestration loop can be exercised without a network connection.

### Findings

- The brief is clear enough to begin with a focused, testable slice.
- The highest-value move is to make assumptions explicit before building.
- The work should ship with evidence and a short list of unresolved risks.

### Recommendation

1. Keep the first iteration deliberately small.
2. Validate the primary user journey before expanding scope.
3. Preserve the decisions and open questions in the mission workspace.

### Handoff notes

- Downstream agents should read this file before starting dependent work.
- Replace this mock artifact with live model output by configuring an
  OpenAI-compatible provider.
`;
  return { path, content };
}

/**
 * Deterministic provider used for local demos and tests. It intentionally does
 * real tool calls (not canned UI events) so the agent runtime, sandbox, approval
 * policy, and event pipeline are all exercised.
 */
export class MockProvider implements LlmProvider {
  readonly id = 'mock' as const;
  readonly label = 'Local Studio (mock)';

  constructor(private readonly latencyMs: number) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    await abortableDelay(this.latencyMs, request.signal);
    if (request.metadata?.purpose === 'plan' || request.tools?.some((tool) => tool.name === 'submit_plan')) {
      return this.plan(request);
    }
    return this.work(request);
  }

  private plan(request: LlmRequest): LlmResponse {
    const maxTasks = request.metadata?.maxTasks ?? 4;
    const plan = buildPlan(request.metadata?.goal ?? 'the requested mission', maxTasks);
    const call: LlmToolCall = {
      id: `call_plan_${randomUUID()}`,
      name: 'submit_plan',
      arguments: JSON.stringify(plan),
    };
    return {
      content: '',
      toolCalls: [call],
      usage: { inputTokens: estimateTokens(JSON.stringify(request.messages)), outputTokens: 220 },
      finishReason: 'tool_calls',
    };
  }

  private work(request: LlmRequest): LlmResponse {
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    const writeTool = request.tools?.find((tool) => tool.name === 'write_file');
    const artifact = workerArtifact(request);

    if (writeTool && toolMessages.length === 0) {
      const call: LlmToolCall = {
        id: `call_write_${randomUUID()}`,
        name: 'write_file',
        arguments: JSON.stringify({ path: artifact.path, content: artifact.content }),
      };
      return {
        content: 'I have enough context. I’ll put the deliverable in the mission workspace.',
        toolCalls: [call],
        usage: { inputTokens: estimateTokens(JSON.stringify(request.messages)), outputTokens: 48 },
        finishReason: 'tool_calls',
      };
    }

    let wrote = false;
    for (const message of toolMessages) {
      try {
        const parsed = JSON.parse(message.content) as { ok?: boolean };
        if (parsed.ok) wrote = true;
      } catch {
        // Ignore malformed tool feedback; the final summary remains honest.
      }
    }

    return {
      content: wrote
        ? `Deliverable written to \`${artifact.path}\`. It captures the brief, the working assumptions, a recommended next step, and the risks that still need validation.`
        : 'I completed the reasoning pass but did not write a workspace artifact. The available tools did not permit it, so the findings remain in this response.',
      toolCalls: [],
      usage: { inputTokens: estimateTokens(JSON.stringify(request.messages)), outputTokens: 80 },
      finishReason: 'stop',
    };
  }
}
