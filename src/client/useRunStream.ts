import { useEffect, useRef, useState } from 'react';
import type { AnyRunEvent } from '../shared/types';

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

interface UseRunStreamOptions {
  runId: string | null;
  enabled: boolean;
  after: number;
  token: string;
  onEvent: (event: AnyRunEvent) => void;
  onUnauthorized: () => void;
}

const TERMINAL_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

function isTerminal(event: AnyRunEvent): boolean {
  return TERMINAL_EVENTS.has(event.type);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseSseBlock(block: string): AnyRunEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as AnyRunEvent;
  } catch {
    return null;
  }
}

/**
 * Fetch-based SSE client with explicit Last-Event-ID recovery. EventSource
 * cannot send the office auth header, and its automatic reconnect retains the
 * original URL, which can silently replay the entire run. This client tracks
 * the last received sequence across reconnects.
 */
export function useRunStream(options: UseRunStreamOptions): ConnectionState {
  const [state, setState] = useState<ConnectionState>('idle');
  const callbacks = useRef(options);
  callbacks.current = options;

  useEffect(() => {
    const { runId, enabled, after, token } = options;
    if (!enabled || !runId) {
      setState('idle');
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    let lastSeq = after;
    let terminal = false;

    const run = async () => {
      setState('connecting');
      while (!disposed && !terminal) {
        try {
          const params = new URLSearchParams({ after: String(lastSeq) });
          if (token) params.set('token', token);
          const response = await fetch(
            `/api/runs/${encodeURIComponent(runId)}/stream?${params.toString()}`,
            {
              headers: {
                accept: 'text/event-stream',
                ...(token ? { 'x-office-token': token } : {}),
              },
              signal: controller.signal,
            },
          );

          if (response.status === 401) {
            callbacks.current.onUnauthorized();
            setState('offline');
            return;
          }
          if (!response.ok || !response.body) {
            throw new Error(`Stream failed with HTTP ${response.status}.`);
          }

          setState('live');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!disposed && !terminal) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const event = parseSseBlock(block);
              if (event) {
                if (event.seq > lastSeq) {
                  lastSeq = event.seq;
                  callbacks.current.onEvent(event);
                }
                if (isTerminal(event)) {
                  terminal = true;
                  break;
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }

          try {
            await reader.cancel();
          } catch {
            // The server may already have closed after the terminal event.
          }

          if (disposed || terminal) break;
          setState('reconnecting');
          await abortableSleep(1_200, controller.signal);
        } catch (error) {
          if (disposed || controller.signal.aborted) break;
          setState('offline');
          try {
            await abortableSleep(2_500, controller.signal);
          } catch {
            break;
          }
        }
      }
      if (!disposed) setState(terminal ? 'idle' : 'offline');
    };

    void run();
    return () => {
      disposed = true;
      controller.abort();
      setState('idle');
    };
  }, [options.runId, options.enabled, options.after, options.token]);

  return state;
}
