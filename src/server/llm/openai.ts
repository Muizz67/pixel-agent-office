import type { Logger } from 'pino';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from './types';

const RESPONSE_SCHEMA_HINT = 'OpenAI-compatible /chat/completions';

interface OpenAiToolCall {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface OpenAiChoice {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
  finish_reason?: unknown;
}

interface OpenAiResponse {
  choices?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (!signal?.reason) return new DOMException('The operation was aborted.', 'AbortError');
  return signal.reason;
}

function linkAbortSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(parent));
  if (parent) {
    if (parent.aborted) controller.abort(abortReason(parent));
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`LLM request timed out after ${timeoutMs}ms.`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function normalizeToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: LlmToolCall[] = [];
  value.forEach((raw, index) => {
    const candidate = raw as OpenAiToolCall;
    if (!candidate || typeof candidate !== 'object' || !candidate.function) return;
    const name = typeof candidate.function.name === 'string' ? candidate.function.name : '';
    if (!name) return;
    let args =
      typeof candidate.function.arguments === 'string'
        ? candidate.function.arguments
        : JSON.stringify(candidate.function.arguments ?? {});
    if (!args.trim()) args = '{}';
    calls.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `call_${index}`,
      name,
      arguments: args,
    });
  });
  return calls;
}

/**
 * Minimal OpenAI-compatible chat-completions client. It works with OpenAI,
 * OpenRouter, vLLM, Ollama's compatibility endpoint, and similar gateways.
 *
 * A small circuit breaker prevents a dead upstream from burning every task's
 * retry budget. A successful call closes it again.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly label: string;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private readonly failureThreshold = 4;
  private readonly cooldownMs = 30_000;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
      logger: Logger;
    },
  ) {
    this.label = new URL(options.baseUrl).host;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (Date.now() < this.openUntil) {
      throw new LlmError(
        `The model provider is temporarily unavailable. Retry after ${new Date(this.openUntil).toISOString()}.`,
        { retryable: true, status: 503 },
      );
    }

    const { signal, cleanup } = linkAbortSignal(request.signal, this.options.timeoutMs);
    try {
      const body = {
        model: request.model,
        messages: request.messages.map((message) => {
          if (message.role === 'assistant' && message.toolCalls?.length) {
            return {
              role: 'assistant',
              content: message.content || null,
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            };
          }
          if (message.role === 'tool') {
            return {
              role: 'tool',
              tool_call_id: message.toolCallId,
              content: message.content,
            };
          }
          return { role: message.role, content: message.content };
        }),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
              tool_choice: 'auto',
            }
          : {}),
        temperature: request.temperature ?? 0.2,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      };

      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      const text = await response.text();
      let parsed: OpenAiResponse;
      try {
        parsed = JSON.parse(text) as OpenAiResponse;
      } catch {
        throw new LlmError(
          `Provider returned a non-JSON response (${response.status}) from ${RESPONSE_SCHEMA_HINT}.`,
          { retryable: response.status >= 500, status: response.status },
        );
      }

      if (!response.ok) {
        const message =
          typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : `Provider request failed with HTTP ${response.status}.`;
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        this.registerFailure();
        throw new LlmError(message, { retryable, status: response.status });
      }

      const choices = Array.isArray(parsed.choices) ? (parsed.choices as OpenAiChoice[]) : [];
      const choice = choices[0];
      if (!choice?.message) {
        throw new LlmError('Provider returned no message choices.', { retryable: true });
      }
      const content = typeof choice.message.content === 'string' ? choice.message.content : '';
      const toolCalls = normalizeToolCalls(choice.message.tool_calls);
      if (!content.trim() && toolCalls.length === 0) {
        throw new LlmError('Provider returned an empty response.', { retryable: true });
      }

      this.registerSuccess();
      return {
        content,
        toolCalls,
        usage: {
          inputTokens:
            typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0,
          outputTokens:
            typeof parsed.usage?.completion_tokens === 'number'
              ? parsed.usage.completion_tokens
              : 0,
        },
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (request.signal?.aborted) throw abortReason(request.signal);
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        this.registerFailure();
        throw new LlmError(
          name === 'TimeoutError'
            ? `Model provider timed out after ${this.options.timeoutMs}ms.`
            : 'Model request was aborted.',
          { retryable: name === 'TimeoutError', cause: error },
        );
      }
      this.registerFailure();
      this.options.logger.warn({ err: error }, 'LLM provider request failed');
      throw new LlmError(
        `Could not reach the model provider: ${error instanceof Error ? error.message : 'unknown network error'}`,
        { retryable: true, cause: error },
      );
    } finally {
      cleanup();
    }
  }

  private registerFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      this.consecutiveFailures = 0;
      this.options.logger.warn(
        { cooldownMs: this.cooldownMs },
        'LLM circuit breaker opened after repeated failures',
      );
    }
  }

  private registerSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }
}
