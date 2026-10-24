import { isRunActive, type Run } from '../../shared/types';
import { shortId, timeAgo, truncate } from '../../shared/format';
import { useNow } from '../useNow';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';

interface RunHistoryProps {
  runs: Run[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function RunHistory({
  runs,
  selectedRunId,
  onSelect,
  onRefresh,
  refreshing,
}: RunHistoryProps) {
  useNow(true, 30_000);

  return (
    <Panel
      title="Run Archive"
      eyebrow="Mission log"
      count={runs.length}
      className="history-panel"
      action={
        <button
          type="button"
          className="button button-ghost button-tiny"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? '…' : 'Reload'}
        </button>
      }
    >
      {runs.length === 0 ? (
        <p className="empty-copy">No missions yet. The archive fills as the office ships work.</p>
      ) : (
        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={`run-row${selectedRunId === run.id ? ' is-selected' : ''}`}
                onClick={() => onSelect(run.id)}
                aria-current={selectedRunId === run.id ? 'true' : undefined}
              >
                <span className="run-row-top">
                  <StatusBadge status={run.status} pulse={isRunActive(run.status)} />
                  <span className="run-row-time">{timeAgo(run.createdAt)}</span>
                </span>
                <span className="run-row-goal">{truncate(run.goal, 96)}</span>
                <span className="run-row-meta">
                  <span className="mono-id">#{shortId(run.id)}</span>
                  <span className={`run-model is-${run.provider}`}>{run.provider}</span>
                  <span>{run.usage.toolCalls} tools</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
