export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retries an operation with bounded exponential backoff and jitter. Only
 * errors accepted by `shouldRetry` are retried; everything else fails fast.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (options.signal?.aborted) throw abortError(options.signal);
      if (options.shouldRetry && !options.shouldRetry(error)) break;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(exponential * (0.75 + Math.random() * 0.5));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}
