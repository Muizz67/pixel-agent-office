import {
  AGENT_PROFILE_MAP,
  type AgentId,
  type AnyRunEvent,
  type Run,
} from '../../shared/types';
import { formatClock, truncate } from '../../shared/format';
import { Panel } from './Panel';

interface ActivityFeedProps {
  events: AnyRunEvent[];
  run: Run | null;
  active: boolean;
}

interface FeedItem {
  icon: string;
  tone: string;
  title: string;
  detail: string | null;
  agentId: AgentId | null;
}

function agentName(id: AgentId | null): string | null {
  return id ? AGENT_PROFILE_MAP[id]?.name ?? id : null;
}

function summarizeArguments(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return truncate(text, 140);
  } catch {
    return null;
  }
}

function describe(event: AnyRunEvent): FeedItem | null {
  switch (event.type) {
    case 'run.created':
      return { icon: '◆', tone: 'info', title: 'Mission created', detail: truncate(event.payload.goal, 160), agentId: null };
    case 'run.planning':
      return { icon: '◇', tone: 'info', title: 'CEO reading the brief', detail: null, agentId: 'ceo' };
    case 'run.started':
      return { icon: '▶', tone: 'active', title: 'Mission started', detail: `${event.payload.maxTasks} task budget`, agentId: 'ceo' };
    case 'run.completed':
      return { icon: '✓', tone: 'success', title: 'Mission completed', detail: event.payload.summary ?? null, agentId: 'ceo' };
    case 'run.failed':
      return { icon: '✕', tone: 'error', title: 'Mission failed', detail: event.payload.error ?? null, agentId: 'ceo' };
    case 'run.cancelled':
      return { icon: '■', tone: 'warn', title: 'Mission cancelled', detail: null, agentId: 'ceo' };
    case 'run.interrupted':
      return { icon: '‖', tone: 'warn', title: 'Mission interrupted', detail: 'Server restarted mid-mission. Resume to continue.', agentId: 'ceo' };
    case 'run.resumed':
      return { icon: '↻', tone: 'info', title: 'Mission resumed', detail: null, agentId: 'ceo' };
    case 'run.updated':
      return null;
    case 'plan.created':
      return {
        icon: '▦',
        tone: 'info',
        title: 'Plan approved',
        detail: `${event.payload.taskCount} tasks — ${truncate(event.payload.summary, 150)}`,
        agentId: 'ceo',
      };
    case 'task.created':
      return {
        icon: '▸',
        tone: 'info',
        title: 'Task delegated',
        detail: `${event.payload.title} → ${agentName(event.payload.agentId)}`,
        agentId: event.payload.agentId,
      };
    case 'task.updated':
      return {
        icon: event.payload.status === 'completed' ? '✓' : event.payload.status === 'failed' ? '✕' : '▸',
        tone:
          event.payload.status === 'completed'
            ? 'success'
            : event.payload.status === 'failed'
              ? 'error'
              : event.payload.status === 'waiting_approval'
                ? 'warn'
                : 'info',
        title: `Task ${event.payload.status.replace(/_/g, ' ')}`,
        detail: event.payload.title,
        agentId: event.payload.agentId,
      };
    case 'agent.updated':
      return null;
    case 'agent.message':
      return {
        icon: '»',
        tone: 'speech',
        title: agentName(event.agentId) ?? 'Agent',
        detail: truncate(event.payload.text, 180),
        agentId: event.agentId,
      };
    case 'tool.started':
      return {
        icon: '›',
        tone: 'tool',
        title: `${event.payload.tool} started`,
        detail: summarizeArguments(event.payload.arguments),
        agentId: event.payload.agentId,
      };
    case 'tool.completed':
      return {
        icon: '›',
        tone: 'tool',
        title: `${event.payload.tool} complete`,
        detail: event.payload.resultPreview ? truncate(event.payload.resultPreview, 150) : null,
        agentId: event.payload.agentId,
      };
    case 'tool.failed':
      return {
        icon: '!',
        tone: 'error',
        title: `${event.payload.tool} failed`,
        detail: event.payload.error ? truncate(event.payload.error, 150) : null,
        agentId: event.payload.agentId,
      };
    case 'approval.requested':
      return {
        icon: '!',
        tone: 'warn',
        title: 'Approval requested',
        detail: `${event.payload.tool} · ${truncate(event.payload.reason, 130)}`,
        agentId: event.payload.agentId,
      };
    case 'approval.resolved':
      return {
        icon: event.payload.status === 'approved' ? '✓' : '✕',
        tone: event.payload.status === 'approved' ? 'success' : 'warn',
        title: `Approval ${event.payload.status}`,
        detail: event.payload.tool,
        agentId: event.payload.agentId,
      };
    case 'artifact.created':
      return {
        icon: '▤',
        tone: 'success',
        title: 'Artifact shipped',
        detail: event.payload.path,
        agentId: event.payload.agentId,
      };
    case 'budget.warning':
      return {
        icon: '⚠',
        tone: 'warn',
        title: 'Budget warning',
        detail: `${event.payload.kind}: ${event.payload.used}/${event.payload.limit}`,
        agentId: null,
      };
    case 'log':
      return {
        icon: '·',
        tone: event.payload.level === 'error' ? 'error' : event.payload.level === 'warn' ? 'warn' : 'info',
        title: 'Office log',
        detail: truncate(event.payload.message, 160),
        agentId: event.agentId,
      };
    default:
      return null;
  }
}

export function ActivityFeed({ events, run, active }: ActivityFeedProps) {
  const items = [...events]
    .sort((a, b) => b.seq - a.seq)
    .map((event) => ({ event, item: describe(event) }))
    .filter((entry): entry is { event: AnyRunEvent; item: FeedItem } => entry.item !== null)
    .slice(0, 80);

  return (
    <Panel
      title="Activity Feed"
      eyebrow="Realtime event stream"
      count={items.length}
      className="activity-panel"
      action={
        <span className={`feed-live-tag${active ? ' is-on' : ''}`}>
          <span aria-hidden="true" />
          {active ? 'Live' : 'Idle'}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="empty-copy">
          {run ? 'The event stream is quiet.' : 'Mission events, agent speech, and tool calls will stream here.'}
        </p>
      ) : (
        <ol className="event-feed">
          {items.map(({ event, item }) => {
            const profile = item.agentId ? AGENT_PROFILE_MAP[item.agentId] : null;
            return (
              <li key={event.id} className={`event-row tone-${item.tone}`}>
                <span className="event-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <div className="event-copy">
                  <div className="event-title-row">
                    <strong>{item.title}</strong>
                    <time dateTime={event.createdAt}>{formatClock(event.createdAt)}</time>
                  </div>
                  {item.detail ? <p>{item.detail}</p> : null}
                  {profile ? (
                    <span className="event-agent" style={{ color: profile.color }}>
                      {profile.name}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
