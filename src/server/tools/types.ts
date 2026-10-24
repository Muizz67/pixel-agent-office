import type { AgentId, Run, Task } from '../../shared/types';

export interface ToolArtifactDraft {
  path: string;
  bytes: number;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  artifact?: ToolArtifactDraft;
}

export interface ToolContext {
  run: Run;
  task: Task;
  agentId: AgentId;
  /** Absolute path to this run's isolated workspace. */
  workspaceRoot: string;
  signal: AbortSignal;
}

export type ToolApprovalMode = 'never' | 'always' | 'config' | 'denied';

export interface ToolPolicy {
  mode: ToolApprovalMode;
  risk: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  readonly risk: ToolPolicy['risk'];
  readonly summary: (input: unknown) => string;
  policy(input: unknown): ToolPolicy;
  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult>;
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string = 'TOOL_ERROR',
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
