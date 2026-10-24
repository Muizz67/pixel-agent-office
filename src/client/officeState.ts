import type {
  AgentView,
  AnyRunEvent,
  Approval,
  Artifact,
  Run,
  RunEvent,
  RunEventType,
  RunSnapshot,
  Task,
} from '../shared/types';

const MAX_EVENTS = 2_000;

export interface OfficeViewState {
  agents: AgentView[];
  runs: Run[];
  selectedRunId: string | null;
  snapshot: RunSnapshot | null;
}

export const EMPTY_VIEW: OfficeViewState = {
  agents: [],
  runs: [],
  selectedRunId: null,
  snapshot: null,
};

const RUN_EVENTS: ReadonlySet<RunEventType> = new Set<RunEventType>([
  'run.created',
  'run.planning',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.resumed',
  'run.updated',
]);

const TERMINAL_EVENTS: ReadonlySet<RunEventType> = new Set<RunEventType>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

export function isTerminalEvent(event: Pick<RunEvent, 'type'>): boolean {
  return TERMINAL_EVENTS.has(event.type);
}

/** Keep one entry per id while preserving ordering (new entries first). */
export function upsert<T>(items: T[], next: T, key: (item: T) => string): T[] {
  const index = items.findIndex((item) => key(item) === key(next));
  if (index === -1) return [next, ...items];
  if (items[index] === next) return items;
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/** Merge a run into the history list without reordering the list. */
export function mergeRun(runs: Run[], run: Run): Run[] {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index === -1) return [run, ...runs];
  if (runs[index] === run) return runs;
  const copy = runs.slice();
  copy[index] = run;
  return copy;
}

export function lastEventSeq(snapshot: RunSnapshot | null): number {
  if (!snapshot || snapshot.events.length === 0) return 0;
  return snapshot.events[snapshot.events.length - 1]?.seq ?? 0;
}

function appendEvent(events: AnyRunEvent[], event: AnyRunEvent): AnyRunEvent[] {
  const last = events[events.length - 1];
  if (last && event.seq <= last.seq) return events;
  const next = [...events, event];
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

function applyEventToSnapshot(
  snapshot: RunSnapshot,
  event: AnyRunEvent,
  agents: AgentView[],
): RunSnapshot {
  let run = snapshot.run;
  let tasks = snapshot.tasks;
  let approvals = snapshot.approvals;
  let artifacts = snapshot.artifacts;

  if (RUN_EVENTS.has(event.type)) {
    run = event.payload as Run;
  }

  switch (event.type) {
    case 'task.created':
    case 'task.updated': {
      const task = event.payload as Task;
      tasks = upsert(tasks, task, (item) => item.id);
      break;
    }
    case 'approval.requested':
    case 'approval.resolved': {
      const approval = event.payload as Approval;
      approvals = upsert(approvals, approval, (item) => item.id);
      break;
    }
    case 'artifact.created': {
      const artifact = event.payload as Artifact;
      artifacts = upsert(artifacts, artifact, (item) => item.id);
      break;
    }
    case 'agent.updated':
      break;
    default:
      break;
  }

  const events = appendEvent(snapshot.events, event);
  if (
    run === snapshot.run &&
    tasks === snapshot.tasks &&
    approvals === snapshot.approvals &&
    artifacts === snapshot.artifacts &&
    events === snapshot.events
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    run,
    tasks,
    approvals,
    artifacts,
    events,
    agents,
  };
}

/**
 * Reduce a streamed event into the current office view. Events are applied only
 * to the selected run's snapshot, but presence updates stay global so the floor
 * remains accurate even while browsing history.
 */
export function applyRunEvent(state: OfficeViewState, event: AnyRunEvent): OfficeViewState {
  let next = state;

  if (event.type === 'agent.updated') {
    const agent = event.payload as AgentView;
    next = { ...next, agents: upsert(next.agents, agent, (item) => item.id) };
  }

  if (!next.snapshot || next.snapshot.run.id !== event.runId) {
    return next;
  }

  const snapshot = applyEventToSnapshot(next.snapshot, event, next.agents);
  let runs = next.runs;
  if (RUN_EVENTS.has(event.type)) {
    runs = mergeRun(runs, event.payload as Run);
  }

  if (snapshot === next.snapshot && runs === next.runs) return next;
  return { ...next, snapshot, runs };
}

export function applySnapshot(state: OfficeViewState, snapshot: RunSnapshot): OfficeViewState {
  return {
    ...state,
    agents: snapshot.agents,
    runs: mergeRun(state.runs, snapshot.run),
    selectedRunId: snapshot.run.id,
    snapshot,
  };
}

export function selectRunInState(state: OfficeViewState, runId: string): OfficeViewState {
  if (state.selectedRunId === runId) return state;
  return { ...state, selectedRunId: runId };
}
