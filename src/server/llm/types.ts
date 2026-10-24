import type { AgentId } from '../../shared/types';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the provider. Validated by the tool layer. */
  arguments: string;
}

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmRequestMetadata {
  purpose: 'plan' | 'worker';
  goal?: string;
  agentId?: AgentId;
  taskId?: string;
  taskTitle?: string;
  maxTasks?: number;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  metadata?: LlmRequestMetadata;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  finishReason: string;
}

export interface LlmProvider {
  readonly id: 'mock' | 'openai';
  readonly label: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: { retryable: boolean; status?: number | null; cause?: unknown } = {
    retryable: false,
  }) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

export interface ProviderBundle {
  kind: 'mock' | 'openai';
  label: string;
  plannerModel: string;
  workerModel: string;
  provider: LlmProvider;
}
