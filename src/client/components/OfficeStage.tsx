import {
  AGENT_PROFILES,
  isRunActive,
  type AgentView,
  type Run,
  type Task,
} from '../../shared/types';
import { elapsedBetween, formatDuration, shortId, timeAgo } from '../../shared/format';
import { OfficeCanvas } from '../office/OfficeCanvas';
import type { ConnectionState } from '../useRunStream';
import { useNow } from '../useNow';
import { StatusBadge } from './StatusBadge';

interface OfficeStageProps {
  run: Run | null;
  agents: AgentView[];
  tasks: Task[];
  connection: ConnectionState;
  viewingLive: boolean;
  loading: boolean;
}

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  idle: 'FEED STANDBY',
  connecting: 'LINKING FEED',
  live: 'FEED LIVE',
  reconnecting: 'RECONNECTING',
  offline: 'FEED OFFLINE',
};

export function OfficeStage({ run, agents, tasks, connection, viewingLive, loading }: OfficeStageProps) {
  const active = Boolean(run && isRunActive(run.status));
  const now = useNow(active);
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'waiting_approval').length;
  const progress = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;
  const busyAgents = agents.filter((agent) =>
    ['working', 'thinking', 'waiting', 'blocked'].includes(agent.status),
  ).length;
  const elapsed = run
    ? elapsedBetween(run.startedAt ?? run.createdAt, run.completedAt ?? new Date(now).toISOString())
    : 0;

  return (
    <section className={`panel office-stage${loading ? ' is-loading' : ''}`}>
      <header className="stage-header">
        <div className="stage-heading">
          <span className="stage-eyebrow">
            {viewingLive ? 'Mission control · live' : run ? 'Mission control · archive' : 'Mission control'}
          </span>
          <h2>{run ? run.goal : 'The floor is ready.'}</h2>
          <div className="stage-subline">
            {run ? (
              <>
                <StatusBadge status={run.status} pulse={active} />
                <span className="mono-id">#{shortId(run.id)}</span>
                <span className="stage-dot" aria-hidden="true" />
                <span>{formatDuration(elapsed)}</span>
                <span className="stage-dot" aria-hidden="true" />
                <span>{AGENT_PROFILES.length} agents</span>
              </>
            ) : (
              <span>Brief the CEO to put the crew to work.</span>
            )}
          </div>
        </div>

        <div className="stage-readout">
          <div className="readout-cell">
            <span>Tasks</span>
            <strong>
              {completed}/{tasks.length || '—'}
            </strong>
          </div>
          <div className="readout-cell">
            <span>Active</span>
            <strong>{running}</strong>
          </div>
          <div className="readout-cell">
            <span>Crew</span>
            <strong>{busyAgents}</strong>
          </div>
        </div>
      </header>

      <div className="stage-viewport">
        <OfficeCanvas
          agents={agents}
          run={run}
          tasks={tasks}
          connected={connection === 'live' || connection === 'connecting'}
        />
        <div className="stage-scanlines" aria-hidden="true" />
        {loading ? (
          <div className="stage-loading" role="status">
            <span className="pixel-loader" aria-hidden="true" />
            Loading mission record…
          </div>
        ) : null}
      </div>

      <footer className="stage-footer">
        <div className="stage-footer-left">
          <span className={`feed-state is-${connection}`}>
            <span className="feed-dot" aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </span>
          {run ? (
            <>
              <span className="stage-footer-sep">/</span>
              <span className="stage-workspace" title={run.workspace}>
                {run.workspace}
              </span>
            </>
          ) : null}
        </div>

        <div className="stage-progress">
          <span className="stage-progress-label">{progress}% shipped</span>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          {run ? <span className="stage-updated">upd. {timeAgo(run.updatedAt)}</span> : null}
        </div>
      </footer>
    </section>
  );
}
