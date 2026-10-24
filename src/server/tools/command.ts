import { spawn } from 'node:child_process';
import type { ToolContext } from './types';
import { ToolExecutionError } from './types';
import type { WorkspaceGuard } from './workspace';

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

interface CommandRule {
  allowedArgs?: (args: string[]) => string | null;
}

const GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'ls-files',
  'grep',
  'rev-parse',
  'branch',
]);

const RULES: Record<string, CommandRule> = {
  node: {
    allowedArgs: (args) => {
      if (args.length === 1 && args[0] === '--version') return null;
      if (args.length === 2 && args[0] === '--check' && args[1]) return null;
      return 'node is limited to --version and --check <workspace-file>.';
    },
  },
  git: {
    allowedArgs: (args) => {
      if (args.length === 0) return 'A read-only git subcommand is required.';
      const subcommand = args[0];
      if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand)) {
        return `git is limited to: ${[...GIT_SUBCOMMANDS].join(', ')}.`;
      }
      if (
        args.some(
          (argument) =>
            argument.startsWith('--git-dir') ||
            argument.startsWith('--work-tree') ||
            argument === '-C' ||
            argument.startsWith('-C') ||
            argument.includes('\0'),
        )
      ) {
        return 'Repository redirection flags are not allowed.';
      }
      return null;
    },
  },
};

function cleanEnv(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export interface CommandInput {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export function validateCommandInput(input: CommandInput, guard: WorkspaceGuard): string {
  const command = input.command.trim().toLowerCase();
  const rule = RULES[command];
  if (!rule) {
    throw new ToolExecutionError(
      `Command "${input.command}" is not allowed. Allowed commands: ${Object.keys(RULES).join(', ')}.`,
      'COMMAND_DENIED',
    );
  }
  const args = input.args ?? [];
  if (args.length > 24) {
    throw new ToolExecutionError('Too many command arguments (maximum 24).', 'INVALID_INPUT');
  }
  for (const argument of args) {
    if (typeof argument !== 'string') {
      throw new ToolExecutionError('Command arguments must be strings.', 'INVALID_INPUT');
    }
    if (argument.length > 500 || argument.includes('\0')) {
      throw new ToolExecutionError('A command argument is invalid.', 'INVALID_INPUT');
    }
  }
  const ruleError = rule.allowedArgs?.(args);
  if (ruleError) throw new ToolExecutionError(ruleError, 'COMMAND_DENIED');

  if (command === 'node' && args[0] === '--check') {
    const file = args[1];
    if (!file) throw new ToolExecutionError('A file path is required.', 'INVALID_INPUT');
    guard.resolve(file);
  }
  return command;
}

/**
 * Runs an allowlisted command with no shell, a sanitized environment, a hard
 * timeout, and bounded output. Shell execution is disabled by default in
 * configuration and always requires approval when enabled.
 */
export async function runSafeCommand(
  input: CommandInput,
  context: ToolContext,
  guard: WorkspaceGuard,
): Promise<CommandResult> {
  const command = validateCommandInput(input, guard);
  const args = input.args ?? [];
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    30_000,
  );

  if (context.signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: guard.root,
      env: {
        ...cleanEnv(),
        GIT_CEILING_DIRECTORIES: guard.root,
        NODE_OPTIONS: '',
      },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > remaining) truncated = true;
      return current + chunk.subarray(0, remaining).toString('utf8');
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      killTree(child.pid);
      finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      callback();
    };

    child.on('error', (error) => {
      finish(() => reject(new ToolExecutionError(`Could not start command: ${error.message}`)));
    });

    child.on('close', (exitCode, signal) => {
      finish(() =>
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          truncated,
          timedOut,
        }),
      );
    });
  });
}
