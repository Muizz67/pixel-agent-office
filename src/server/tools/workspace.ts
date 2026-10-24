import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

function within(root: string, candidate: string): boolean {
  const rootComparable = process.platform === 'win32' ? root.toLowerCase() : root;
  const candidateComparable = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const rel = relative(rootComparable, candidateComparable);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Confines all file tool access to one mission workspace, including through
 * symlinks. Existing targets are resolved, and for new files the nearest
 * existing ancestor is resolved before the write is allowed.
 */
export class WorkspaceGuard {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.realRoot = realpathSync(this.root);
  }

  resolve(input: string): string {
    if (typeof input !== 'string') {
      throw new WorkspaceAccessError('Path must be a string.');
    }
    if (input.includes('\0')) {
      throw new WorkspaceAccessError('Path contains a null byte.');
    }
    const trimmed = input.trim();
    if (!trimmed) {
      throw new WorkspaceAccessError('Path is required.');
    }
    if (trimmed.includes('://') || isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      throw new WorkspaceAccessError('Only workspace-relative paths are allowed.');
    }

    const normalized = trimmed.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '..')) {
      throw new WorkspaceAccessError('Path traversal is not allowed.');
    }

    const target = resolve(this.root, ...segments);
    if (!within(this.root, target)) {
      throw new WorkspaceAccessError('Path escapes the mission workspace.');
    }

    let probe = target;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      throw new WorkspaceAccessError('Could not resolve the workspace path.');
    }
    if (!within(this.realRoot, realProbe)) {
      throw new WorkspaceAccessError('Path escapes the mission workspace through a symlink.');
    }

    return target;
  }

  relative(target: string): string {
    const path = relative(this.root, target);
    return path.split(sep).join('/');
  }
}
