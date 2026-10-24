import {
  AGENT_PROFILE_MAP,
  TASK_STATUS_LABELS,
  type Run,
  type Task,
  type TaskStatus,
} from '../../shared/types';
import { shortId } from '../../shared/format';
import { AgentAvatar } from './AgentAvatar';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';

interface TaskBoardProps {
  run: Run | null;
  tasks: Task[];
}

interface TaskColumn {
  key: string;
  label: string;
  statuses: TaskStatus[];
}

const COLUMNS: TaskColumn[] = [
  { key: 'queue', label: 'Queue', statuses: ['queued', 'blocked'] },
  { key: 'active', label: 'In flight', statuses: ['running', 'waiting_approval'] },
  { key: 'shipped', label: 'Shipped', statuses: ['completed'] },
  { key: 'issues', label: 'Issues', statuses: ['failed', 'cancelled'] },
];

export function TaskBoard({ run, tasks }: TaskBoardProps) {
  const grouped = COLUMNS.map((column) => ({
    ...column,
    tasks: tasks
      .filter((task) => column.statuses.includes(task.status))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)),
  }));

  return (
    <Panel
      title="Task Board"
      eyebrow="Plan · delegate · verify"
      count={tasks.length}
      className="task-board-panel"
    >
      {tasks.length === 0 ? (
        <div className="board-empty">
          {run?.status === 'planning' ? (
            <>
              <span className="pixel-loader" aria-hidden="true" />
              <div>
                <h3>The CEO is shaping the plan</h3>
                <p>Tasks will appear here as the mission is decomposed and delegated.</p>
              </div>
            </>
          ) : run ? (
            <>
              <span className="board-empty-mark" aria-hidden="true">
                ▦
              </span>
              <div>
                <h3>No tasks were created</h3>
                <p>Check the activity feed for the planner&apos;s notes, then try a sharper brief.</p>
              </div>
            </>
          ) : (
            <>
              <span className="board-empty-mark" aria-hidden="true">
                ▦
              </span>
              <div>
                <h3>No mission in flight</h3>
                <p>Start a mission and the task graph will materialise here.</p>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="task-columns">
          {grouped.map((column) => (
            <section key={column.key} className={`task-column is-${column.key}`}>
              <header className="task-column-head">
                <h3>{column.label}</h3>
                <span>{column.tasks.length}</span>
              </header>
              <div className="task-column-body">
                {column.tasks.length === 0 ? (
                  <p className="task-column-empty">—</p>
                ) : (
                  column.tasks.map((task) => <TaskCard key={task.id} task={task} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function TaskCard({ task }: { task: Task }) {
  const profile = AGENT_PROFILE_MAP[task.agentId];
  const pendingApproval = task.status === 'waiting_approval';

  return (
    <article className={`task-card is-${task.status}`}>
      <header className="task-card-head">
        <StatusBadge status={task.status} pulse={pendingApproval} />
        <span className="task-card-id">#{shortId(task.id)}</span>
      </header>

      <h4 title={task.title}>{task.title}</h4>
      <p className="task-card-description" title={task.description}>
        {task.description}
      </p>

      <div className="task-card-agent">
        <AgentAvatar agentId={task.agentId} size={22} status="idle" />
        <span>{profile.name}</span>
        <span className="task-card-priority">P{task.priority}</span>
      </div>

      <footer className="task-card-meta">
        <span>{TASK_STATUS_LABELS[task.status]}</span>
        {task.dependsOn.length > 0 ? <span>{task.dependsOn.length} deps</span> : null}
        {task.attempts > 0 ? (
          <span>
            try {task.attempts}/{task.maxAttempts}
          </span>
        ) : null}
        {task.usage.toolCalls > 0 ? <span>{task.usage.toolCalls} tools</span> : null}
      </footer>

      {task.result ? (
        <details className="task-result">
          <summary>Agent handoff</summary>
          <p>{task.result}</p>
        </details>
      ) : null}

      {task.error ? <p className="task-error">{task.error}</p> : null}
    </article>
  );
}
