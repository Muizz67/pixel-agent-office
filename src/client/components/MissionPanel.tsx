import { useMemo, useState, type FormEvent } from 'react';
import {
  SUGGESTED_GOALS,
  type PublicConfig,
  type Run,
  type Task,
  isRunActive,
} from '../../shared/types';
import { elapsedBetween, formatNumber, formatDuration, shortId } from '../../shared/format';
import { useNow } from '../useNow';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';

interface MissionPanelProps {
  config: PublicConfig;
  activeRun: Run | null;
  viewRun: Run | null;
  viewTasks: Task[];
  starting: boolean;
  onStart: (goal: string, maxTasks?: number) => Promise<boolean>;
  onCancel: (runId: string) => Promise<void>;
  onResume: (runId: string) => Promise<void>;
  onViewLive: (runId: string) => void;
}

function taskCounts(tasks: Task[]): { done: number; total: number; failed: number } {
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    failed: tasks.filter((task) => task.status === 'failed').length,
  };
}

export function MissionPanel({
  config,
  activeRun,
  viewRun,
  viewTasks,
  starting,
  onStart,
  onCancel,
  onResume,
  onViewLive,
}: MissionPanelProps) {
  const [goal, setGoal] = useState('');
  const [maxTasks, setMaxTasks] = useState('auto');
  const [busy, setBusy] = useState<'cancel' | 'resume' | null>(null);

  const active = Boolean(viewRun && isRunActive(viewRun.status));
  const now = useNow(active);
  const counts = taskCounts(viewTasks);
  const liveHere = Boolean(activeRun && viewRun && activeRun.id === viewRun.id);
  const elapsed = viewRun
    ? elapsedBetween(viewRun.startedAt ?? viewRun.createdAt, viewRun.completedAt ?? new Date(now).toISOString())
    : 0;
  const progress = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  const taskOptions = useMemo(() => {
    const limit = config.limits.maxTasks;
    const presets = [4, 6, 8].filter((value) => value <= limit);
    return [...new Set([...presets, limit])].sort((a, b) => a - b);
  }, [config.limits.maxTasks]);

  const canSubmit = goal.trim().length >= 8 && !activeRun && !starting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const parsed = maxTasks === 'auto' ? undefined : Number(maxTasks);
    const ok = await onStart(goal.trim(), parsed);
    if (ok) {
      setGoal('');
    }
  };

  const cancel = async () => {
    if (!viewRun || busy) return;
    setBusy('cancel');
    try {
      await onCancel(viewRun.id);
    } finally {
      setBusy(null);
    }
  };

  const resume = async () => {
    if (!viewRun || busy) return;
    setBusy('resume');
    try {
      await onResume(viewRun.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Mission Brief" eyebrow="Delegate to the floor" className="mission-panel">
      <form className="mission-form" onSubmit={submit}>
        <label className="field-label" htmlFor="mission-goal">
          What should the office ship?
        </label>
        <div className="textarea-wrap">
          <textarea
            id="mission-goal"
            className="mission-input"
            value={goal}
            onChange={(event) => setGoal(event.target.value.slice(0, 2_000))}
            placeholder="Describe the outcome, audience, and constraints…"
            rows={4}
            maxLength={2_000}
            disabled={starting}
          />
          <span className="char-count">{goal.length}/2000</span>
        </div>

        <div className="suggestion-list" aria-label="Suggested missions">
          {SUGGESTED_GOALS.slice(0, 3).map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className="suggestion"
              onClick={() => setGoal(suggestion)}
              disabled={starting}
              title={suggestion}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="mission-form-footer">
          <label className="task-select">
            <span>Task budget</span>
            <select
              value={maxTasks}
              onChange={(event) => setMaxTasks(event.target.value)}
              disabled={starting}
            >
              <option value="auto">Auto · up to {config.limits.maxTasks}</option>
              {taskOptions.map((value) => (
                <option key={value} value={value}>
                  {value} tasks
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="button button-primary"
            disabled={!canSubmit}
            title={activeRun ? 'Another mission is already in progress.' : undefined}
          >
            {starting ? 'Dispatching…' : activeRun ? 'Floor busy' : 'Start mission'}
          </button>
        </div>
      </form>

      {activeRun && !liveHere ? (
        <div className="mission-alert">
          <div>
            <span className="mission-alert-label">Live mission elsewhere</span>
            <p>{activeRun.goal}</p>
          </div>
          <button type="button" className="button button-ghost button-small" onClick={() => onViewLive(activeRun.id)}>
            Watch live
          </button>
        </div>
      ) : null}

      {viewRun ? (
        <article className={`mission-card is-${viewRun.status}`}>
          <div className="mission-card-head">
            <StatusBadge status={viewRun.status} pulse={isRunActive(viewRun.status)} />
            <span className="mono-id">#{shortId(viewRun.id)}</span>
          </div>
          <h3 className="mission-card-goal">{viewRun.goal}</h3>

          {viewRun.summary ? <p className="mission-card-summary">{viewRun.summary}</p> : null}
          {viewRun.error ? <p className="mission-card-error">{viewRun.error}</p> : null}

          <div className="mission-stats">
            <div>
              <span>Elapsed</span>
              <strong>{formatDuration(elapsed)}</strong>
            </div>
            <div>
              <span>Tasks</span>
              <strong>
                {counts.done}/{counts.total || viewRun.maxTasks}
              </strong>
            </div>
            <div>
              <span>Tokens</span>
              <strong>{formatNumber(viewRun.usage.inputTokens + viewRun.usage.outputTokens)}</strong>
            </div>
            <div>
              <span>Tools</span>
              <strong>{formatNumber(viewRun.usage.toolCalls)}</strong>
            </div>
          </div>

          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${Math.max(progress, viewRun.status === 'planning' ? 6 : 0)}%` }} />
          </div>

          <div className="mission-card-actions">
            <span className="workspace-label" title={viewRun.workspace}>
              {viewRun.workspace}
            </span>
            {liveHere ? (
              <button
                type="button"
                className="button button-danger button-small"
                onClick={() => void cancel()}
                disabled={busy !== null}
              >
                {busy === 'cancel' ? 'Stopping…' : 'Cancel mission'}
              </button>
            ) : viewRun.status === 'interrupted' ? (
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() => void resume()}
                disabled={busy !== null || Boolean(activeRun)}
                title={activeRun ? 'Finish the live mission first.' : undefined}
              >
                {busy === 'resume' ? 'Resuming…' : 'Resume mission'}
              </button>
            ) : null}
          </div>
        </article>
      ) : (
        <div className="mission-empty">
          <span className="mission-empty-mark" aria-hidden="true">
            ◇
          </span>
          <div>
            <h3>No mission on the floor</h3>
            <p>Brief the CEO above. The office will plan, delegate, and report back.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
