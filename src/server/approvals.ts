import type { Approval, AgentId, ToolRisk } from '../shared/types';
import type { ApprovalStore } from './db';
import { conflict, notFound } from './errors';
import type { RunEventService } from './events';
import { newId } from './ids';

interface PendingApproval {
  approval: Approval;
  resolve: (approval: Approval) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ApprovalRequest {
  runId: string;
  taskId: string;
  agentId: AgentId;
  tool: string;
  arguments: unknown;
  risk: ToolRisk;
  reason: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Durable human-in-the-loop approval broker. Pending requests are persisted,
 * so their resolution is auditable, but live waiters are in-memory. On restart,
 * interrupted approvals are expired and the owning task can be resumed.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly approvals: ApprovalStore,
    private readonly events: RunEventService,
  ) {}

  request(input: ApprovalRequest): Promise<Approval> {
    const now = new Date();
    const approval: Approval = {
      id: newId('apr'),
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      tool: input.tool,
      arguments: input.arguments,
      risk: input.risk,
      reason: input.reason,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString(),
      resolvedAt: null,
      note: null,
    };
    this.approvals.create(approval);
    this.events.emit(input.runId, 'approval.requested', approval, {
      agentId: input.agentId,
      taskId: input.taskId,
    });

    return new Promise<Approval>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(approval.id, 'expired', 'Approval timed out.', true);
      }, input.timeoutMs);
      timer.unref?.();

      const entry: PendingApproval = {
        approval,
        resolve,
        timer,
        signal: input.signal,
      };

      if (input.signal) {
        const onAbort = () => {
          this.settle(approval.id, 'cancelled', 'Run was cancelled or interrupted.', true);
        };
        entry.onAbort = onAbort;
        if (input.signal.aborted) {
          queueMicrotask(onAbort);
        } else {
          input.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      this.pending.set(approval.id, entry);
    });
  }

  resolve(
    runId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    note: string | null,
  ): Approval {
    const existing = this.approvals.get(approvalId);
    if (!existing || existing.runId !== runId) {
      throw notFound('Approval request not found.');
    }
    if (existing.status !== 'pending') {
      throw conflict(`This approval is already ${existing.status}.`);
    }
    const updated = this.settle(
      approvalId,
      decision === 'approve' ? 'approved' : 'denied',
      note,
      false,
    );
    return updated;
  }

  cancelForRun(runId: string, note = 'Run cancelled.'): void {
    const pending = this.approvals.listPending(runId);
    for (const approval of pending) {
      this.settle(approval.id, 'cancelled', note, true);
    }
    this.approvals.expirePendingForRun(runId, 'cancelled', note, new Date().toISOString());
  }

  expireForRun(runId: string, note = 'Run interrupted.'): void {
    const pending = this.approvals.listPending(runId);
    for (const approval of pending) {
      this.settle(approval.id, 'expired', note, true);
    }
  }

  private settle(
    approvalId: string,
    status: 'approved' | 'denied' | 'expired' | 'cancelled',
    note: string | null,
    fromTimer: boolean,
  ): Approval {
    const entry = this.pending.get(approvalId);
    if (entry) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      this.pending.delete(approvalId);
    }

    const existing = this.approvals.get(approvalId);
    if (!existing) throw notFound('Approval request not found.');
    if (existing.status !== 'pending') {
      return existing;
    }

    const updated = this.approvals.resolve(approvalId, status, note, new Date().toISOString());
    if (!updated) throw notFound('Approval request not found.');

    this.events.emit(updated.runId, 'approval.resolved', updated, {
      agentId: updated.agentId,
      taskId: updated.taskId,
    });
    if (fromTimer) {
      const seconds = Math.round((Date.now() - Date.parse(updated.createdAt)) / 1000);
      this.events.emit(
        updated.runId,
        'log',
        { level: 'warn', message: `Approval ${status} after ${seconds}s.` },
        { agentId: updated.agentId, taskId: updated.taskId },
      );
    }
    entry?.resolve(updated);
    return updated;
  }
}
