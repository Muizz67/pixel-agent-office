import { EventEmitter } from 'node:events';
import type { AgentId, AnyRunEvent, RunEventType } from '../shared/types';
import type { EventStore } from './db';

export type RunEventListener = (event: AnyRunEvent) => void;

/**
 * In-process fan-out for live run events. Events are persisted first, then
 * published, so a subscriber that reconnects can always recover from the store.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: AnyRunEvent): void {
    this.emitter.emit(event.runId, event);
    this.emitter.emit('*', event);
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  subscribeAll(listener: RunEventListener): () => void {
    this.emitter.on('*', listener);
    return () => this.emitter.off('*', listener);
  }
}

export class RunEventService {
  readonly bus = new EventBus();

  constructor(private readonly store: EventStore) {}

  emit<T extends RunEventType>(
    runId: string,
    type: T,
    payload: AnyRunEvent['payload'],
    options: {
      agentId?: AgentId | null;
      taskId?: string | null;
      createdAt?: string;
    } = {},
  ): AnyRunEvent {
    const event = this.store.append(runId, type, payload, options) as AnyRunEvent;
    this.bus.publish(event);
    return event;
  }

  replay(runId: string, after = 0, limit = 1000): AnyRunEvent[] {
    return this.store.list(runId, after, limit);
  }
}
