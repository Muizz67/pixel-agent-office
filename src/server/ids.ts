import { randomUUID } from 'node:crypto';

export type IdPrefix = 'run' | 'tsk' | 'evt' | 'apr' | 'art' | 'aud';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}
