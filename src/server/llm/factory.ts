import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import { MockProvider } from './mock';
import { OpenAiProvider } from './openai';
import type { LlmProvider, ProviderBundle } from './types';

export function createProviderBundle(
  config: Pick<
    AppConfig,
    | 'requestedProvider'
    | 'openaiApiKey'
    | 'openaiBaseUrl'
    | 'plannerModel'
    | 'workerModel'
    | 'mockLatencyMs'
    | 'llmTimeoutMs'
  >,
  logger: Logger,
): ProviderBundle {
  const useOpenAi =
    config.requestedProvider === 'openai' ||
    (config.requestedProvider === 'auto' && Boolean(config.openaiApiKey));

  if (useOpenAi && !config.openaiApiKey) {
    throw new Error(
      'LLM_PROVIDER=openai requires OPENAI_API_KEY. Set a key or use LLM_PROVIDER=mock.',
    );
  }

  const provider: LlmProvider = useOpenAi
    ? new OpenAiProvider({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        timeoutMs: config.llmTimeoutMs,
        logger,
      })
    : new MockProvider(config.mockLatencyMs);

  return {
    kind: provider.id,
    label: provider.label,
    plannerModel: useOpenAi ? config.plannerModel : 'mock-office-v1',
    workerModel: useOpenAi ? config.workerModel : 'mock-office-v1',
    provider,
  };
}
