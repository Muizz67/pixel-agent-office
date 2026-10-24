import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceAccessError, WorkspaceGuard } from '../src/server/tools/workspace';

const dirs: string[] = [];

async function sandbox(): Promise<{ root: string; outside: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-workspace-'));
  dirs.push(dir);
  const root = join(dir, 'mission');
  const outside = join(dir, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
  return { root, outside };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceGuard', () => {
  it('resolves nested workspace paths and reports relative paths', async () => {
    const { root } = await sandbox();
    const guard = new WorkspaceGuard(root);
    const target = guard.resolve('notes/deep/brief.md');
    expect(target.startsWith(root)).toBe(true);
    expect(guard.relative(target)).toBe('notes/deep/brief.md');
  });

  it.each([
    ['parent traversal', '../escape.txt'],
    ['nested traversal', 'notes/../../escape.txt'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\win.ini'],
    ['scheme path', 'file:///etc/passwd'],
    ['null byte', 'notes/brief\0.md'],
    ['empty path', '   '],
  ])('rejects %s', async (_label, input) => {
    const { root } = await sandbox();
    const guard = new WorkspaceGuard(root);
    expect(() => guard.resolve(input)).toThrow(WorkspaceAccessError);
  });

  it('rejects paths that escape through a directory symlink', async () => {
    const { root, outside } = await sandbox();
    try {
      await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // The host may not allow symlink creation; the lexical checks still run.
      return;
    }
    const guard = new WorkspaceGuard(root);
    expect(() => guard.resolve('link/secret.txt')).toThrow(WorkspaceAccessError);
  });
});
