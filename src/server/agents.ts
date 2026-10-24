import {
  AGENT_PROFILES,
  type AgentId,
  type AgentStatus,
  type AgentView,
} from '../shared/types';
import type { RunEventService } from './events';

export interface AgentUpdateContext {
  runId: string;
  taskId?: string | null;
  emit?: boolean;
}

function initialView(id: AgentId): AgentView {
  const profile = AGENT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown agent ${id}`);
  return {
    id,
    name: profile.name,
    title: profile.title,
    color: profile.color,
    accent: profile.accent,
    status: 'idle',
    activity: 'Awaiting briefing',
    message: null,
    currentTaskId: null,
    completedTasks: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The shared presence layer for the office floor. Orchestrator and worker
 * runtimes update it; the UI receives every change as an `agent.updated`
 * event and gets a full snapshot on reconnect.
 */
export class AgentPresence {
  private readonly views = new Map<AgentId, AgentView>();

  constructor(
    private readonly events: RunEventService,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const profile of AGENT_PROFILES) {
      this.views.set(profile.id, initialView(profile.id));
    }
  }

  list(): AgentView[] {
    return AGENT_PROFILES.map((profile) => {
      const view = this.views.get(profile.id) ?? initialView(profile.id);
      return { ...view };
    });
  }

  get(id: AgentId): AgentView {
    const view = this.views.get(id);
    if (!view) throw new Error(`Unknown agent ${id}`);
    return { ...view };
  }

  beginMission(runId: string, message = 'Reviewing the new brief'): void {
    for (const profile of AGENT_PROFILES) {
      const view: AgentView = {
        ...initialView(profile.id),
        status: 'idle',
        activity: profile.id === 'ceo' ? message : 'Standing by for delegation',
        updatedAt: this.now().toISOString(),
      };
      this.views.set(profile.id, view);
      this.publish(view, { runId, emit: true });
    }
  }

  update(
    id: AgentId,
    patch: Partial<Omit<AgentView, 'id' | 'name' | 'title' | 'color' | 'accent' | 'updatedAt'>>,
    context: AgentUpdateContext,
  ): AgentView {
    const current = this.views.get(id) ?? initialView(id);
    const next: AgentView = {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    this.views.set(id, next);
    if (context.emit ?? true) {
      this.publish(next, context);
    }
    return { ...next };
  }

  setStatus(
    id: AgentId,
    status: AgentStatus,
    activity: string,
    context: AgentUpdateContext & { currentTaskId?: string | null } = { runId: '' },
  ): AgentView {
    return this.update(
      id,
      {
        status,
        activity,
        ...(context.currentTaskId !== undefined
          ? { currentTaskId: context.currentTaskId }
          : {}),
      },
      context,
    );
  }

  say(
    id: AgentId,
    text: string,
    kind: 'speech' | 'result' | 'system',
    context: AgentUpdateContext,
  ): void {
    const current = this.views.get(id) ?? initialView(id);
    const next: AgentView = {
      ...current,
      message: text,
      updatedAt: this.now().toISOString(),
    };
    this.views.set(id, next);
    if (context.emit ?? true) {
      this.publish(next, context);
      this.events.emit(
        context.runId,
        'agent.message',
        { text, kind },
        { agentId: id, taskId: context.taskId ?? null },
      );
    }
  }

  completeTask(id: AgentId, context: AgentUpdateContext): AgentView {
    const current = this.views.get(id) ?? initialView(id);
    return this.update(
      id,
      {
        completedTasks: current.completedTasks + 1,
        currentTaskId: null,
        status: 'idle',
        activity: 'Task delivered',
      },
      context,
    );
  }

  resetIdle(message = 'Awaiting briefing'): void {
    for (const profile of AGENT_PROFILES) {
      const current = this.views.get(profile.id) ?? initialView(profile.id);
      this.views.set(profile.id, {
        ...current,
        status: 'idle',
        activity: message,
        currentTaskId: null,
        message: null,
        updatedAt: this.now().toISOString(),
      });
    }
  }

  private publish(
    view: AgentView,
    context: { runId: string; taskId?: string | null; emit?: boolean },
  ): void {
    if (!context.runId || context.emit === false) return;
    this.events.emit(
      context.runId,
      'agent.updated',
      { ...view },
      {
        agentId: view.id,
        taskId: context.taskId ?? view.currentTaskId ?? null,
      },
    );
  }
}
