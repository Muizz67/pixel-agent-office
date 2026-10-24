import type {
  AgentView,
  Approval,
  Artifact,
  BootstrapResponse,
  Run,
  RunEvent,
  RunSnapshot,
  Task,
} from '../shared/types';

const TOKEN_KEY = 'pixel-office-session-token';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let officeToken = '';

export function captureTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    officeToken = token;
    sessionStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  officeToken = sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function getOfficeToken(): string {
  return officeToken;
}

export function setOfficeToken(token: string): void {
  officeToken = token.trim();
  if (officeToken) sessionStorage.setItem(TOKEN_KEY, officeToken);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (officeToken) headers.set('x-office-token', officeToken);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'HTTP_ERROR',
      envelope?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      envelope?.error?.details,
    );
  }
  return body as T;
}

export const api = {
  bootstrap(): Promise<BootstrapResponse> {
    return request<BootstrapResponse>('/api/bootstrap');
  },

  listRuns(limit = 20): Promise<{ runs: Run[]; total: number }> {
    return request('/api/runs?limit=' + limit);
  },

  getRun(runId: string): Promise<RunSnapshot> {
    return request<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`);
  },

  startRun(goal: string, maxTasks?: number): Promise<{ run: Run }> {
    return request('/api/runs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ goal, ...(maxTasks ? { maxTasks } : {}) }),
    });
  },

  cancelRun(runId: string): Promise<{ run: Run }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  },

  resumeRun(runId: string): Promise<{ run: Run }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
  },

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    note?: string,
  ): Promise<{ approval: Approval }> {
    return request(
      `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      },
    );
  },

  getArtifactContent(
    runId: string,
    path: string,
  ): Promise<{ artifact: Artifact; content: string }> {
    const encoded = new URLSearchParams({ path }).toString();
    return request(`/api/runs/${encodeURIComponent(runId)}/artifacts/content?${encoded}`);
  },
};

export interface StreamEventEnvelope {
  event: RunEvent;
}

export type { AgentView, Approval, Artifact, Run, RunSnapshot, Task };
