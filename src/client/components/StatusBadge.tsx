import type { ApprovalStatus, AgentStatus, RunStatus, TaskStatus } from '../../shared/types';

type Status = RunStatus | TaskStatus | AgentStatus | ApprovalStatus;

const LABELS: Record<Status, string> = {
  planning: 'Planning',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  queued: 'Queued',
  waiting_approval: 'Awaiting approval',
  blocked: 'Blocked',
  offline: 'Offline',
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting',
  error: 'Error',
  celebrating: 'Celebrating',
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
};

interface StatusBadgeProps {
  status: Status;
  label?: string;
  pulse?: boolean;
}

export function StatusBadge({ status, label, pulse }: StatusBadgeProps) {
  return (
    <span className={`status-badge is-${status}${pulse ? ' is-pulsing' : ''}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? LABELS[status] ?? status}
    </span>
  );
}

export function statusLabel(status: Status): string {
  return LABELS[status] ?? status;
}
