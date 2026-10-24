import { useState } from 'react';
import {
  AGENT_PROFILE_MAP,
  type Approval,
  type Run,
  type ToolRisk,
} from '../../shared/types';
import { formatClock, shortId } from '../../shared/format';
import { AgentAvatar } from './AgentAvatar';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';

interface ApprovalPanelProps {
  run: Run | null;
  approvals: Approval[];
  onResolve: (approvalId: string, decision: 'approve' | 'deny', note?: string) => Promise<boolean>;
}

const RISK_LABELS: Record<ToolRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical',
};

function prettyArguments(value: unknown): string {
  if (value === null || value === undefined) return '{}';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > 1_200 ? `${text.slice(0, 1_200)}\n… truncated` : text;
  } catch {
    return '[unserializable arguments]';
  }
}

export function ApprovalPanel({ run, approvals, onResolve }: ApprovalPanelProps) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = approvals
    .filter((approval) => approval.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const resolved = approvals
    .filter((approval) => approval.status !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt))
    .slice(0, 4);

  const resolve = async (approvalId: string, decision: 'approve' | 'deny') => {
    if (busy) return;
    setBusy(approvalId);
    try {
      const ok = await onResolve(approvalId, decision, notes[approvalId]?.trim() || undefined);
      if (ok) {
        setNotes((current) => {
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Approvals"
      eyebrow="Human in the loop"
      count={pending.length}
      className={`approval-panel${pending.length > 0 ? ' needs-action' : ''}`}
    >
      {!run ? (
        <p className="empty-copy">Approval requests from gated tools will land here.</p>
      ) : pending.length === 0 ? (
        <div className="approval-empty">
          <span className="approval-empty-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <h3>No approvals pending</h3>
            <p>The crew is operating inside its sandbox.</p>
          </div>
        </div>
      ) : (
        <div className="approval-list">
          {pending.map((approval) => {
            const profile = AGENT_PROFILE_MAP[approval.agentId];
            const isBusy = busy === approval.id;
            return (
              <article key={approval.id} className={`approval-card risk-${approval.risk}`}>
                <header className="approval-head">
                  <StatusBadge status="pending" pulse />
                  <span className={`risk-badge risk-${approval.risk}`}>{RISK_LABELS[approval.risk]}</span>
                </header>

                <h3 className="approval-tool">{approval.tool}</h3>
                <p className="approval-reason">{approval.reason}</p>

                <div className="approval-agent">
                  <AgentAvatar agentId={approval.agentId} size={24} status="waiting" />
                  <span>{profile.name}</span>
                  <span className="approval-agent-task">task #{shortId(approval.taskId)}</span>
                  <span className="approval-expiry">expires {formatClock(approval.expiresAt)}</span>
                </div>

                <pre className="approval-args">{prettyArguments(approval.arguments)}</pre>

                <label className="approval-note">
                  <span>Operator note (optional)</span>
                  <input
                    type="text"
                    value={notes[approval.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [approval.id]: event.target.value.slice(0, 1_000) }))
                    }
                    placeholder="Why are you approving or denying this?"
                    disabled={isBusy}
                  />
                </label>

                <div className="approval-actions">
                  <button
                    type="button"
                    className="button button-primary button-small"
                    onClick={() => void resolve(approval.id, 'approve')}
                    disabled={isBusy}
                  >
                    {isBusy ? 'Sending…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="button button-danger button-small"
                    onClick={() => void resolve(approval.id, 'deny')}
                    disabled={isBusy}
                  >
                    Deny
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {resolved.length > 0 ? (
        <details className="approval-history">
          <summary>Recent decisions ({resolved.length})</summary>
          <ul>
            {resolved.map((approval) => (
              <li key={approval.id}>
                <StatusBadge status={approval.status} />
                <span>{approval.tool}</span>
                <span className="approval-history-time">
                  {approval.resolvedAt ? formatClock(approval.resolvedAt) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
