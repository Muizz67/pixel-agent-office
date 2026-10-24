import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { formatNumber } from '../../shared/format';
import type { AppConfig } from '../config';
import { runSafeCommand, validateCommandInput } from './command';
import { fetchPublicText } from './safe-fetch';
import type { AgentTool, ToolContext, ToolExecutionResult, ToolPolicy } from './types';
import { ToolExecutionError } from './types';
import { WorkspaceGuard, WorkspaceAccessError } from './workspace';

const MAX_WRITE_BYTES = 256 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_FILES = 600;
const MAX_SEARCH_BYTES = 256 * 1024;

function formatZod(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
}

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolExecutionError(`Invalid tool arguments: ${formatZod(parsed.error)}`, 'INVALID_INPUT');
  }
  return parsed.data;
}

function summarize(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function result(
  ok: boolean,
  output: string,
  artifact?: ToolExecutionResult['artifact'],
): ToolExecutionResult {
  return artifact ? { ok, output, artifact } : { ok, output };
}

const listInput = z
  .object({
    path: z.string().max(500).optional().default('.'),
    recursive: z.boolean().optional().default(true),
    maxDepth: z.number().int().min(1).max(5).optional().default(3),
  })
  .strict();

const readInput = z
  .object({
    path: z.string().min(1).max(500),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .strict();

const writeInput = z
  .object({
    path: z.string().min(1).max(500),
    content: z.string().max(300_000),
  })
  .strict();

const searchInput = z
  .object({
    query: z.string().min(1).max(200),
    path: z.string().max(500).optional().default('.'),
    caseSensitive: z.boolean().optional().default(false),
    maxResults: z.number().int().min(1).max(100).optional().default(40),
  })
  .strict();

const commandInput = z
  .object({
    command: z.string().min(1).max(40),
    args: z.array(z.string().max(500)).max(24).optional().default([]),
    timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
  })
  .strict();

const fetchInput = z
  .object({
    url: z.string().url().max(2_000),
  })
  .strict();

const fileListTool: AgentTool = {
  name: 'list_files',
  description:
    'List files in the mission workspace. Use this before reading or editing so you know what exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory. Defaults to ".".' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories. Defaults to true.' },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
    },
    additionalProperties: false,
  },
  risk: 'low',
  summary: (input) => `List ${summarize(input, 120)}`,
  policy: () => ({ mode: 'never', risk: 'low', reason: 'Read-only workspace listing.' }),
  async execute(raw, context) {
    const input = parseInput(listInput, raw);
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const base = guard.resolve(input.path);
    const baseStat = await stat(base);
    const files: Array<{ path: string; bytes: number }> = [];

    if (baseStat.isFile()) {
      files.push({ path: guard.relative(base), bytes: baseStat.size });
    } else {
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (files.length >= 200) return;
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (files.length >= 200) break;
          const absolute = join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (input.recursive && depth < input.maxDepth) await walk(absolute, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          const info = await stat(absolute);
          files.push({ path: guard.relative(absolute), bytes: info.size });
        }
      };
      await walk(base, 0);
    }

    return result(
      true,
      JSON.stringify(
        {
          root: guard.relative(base) || '.',
          count: files.length,
          truncated: files.length >= 200,
          files,
        },
        null,
        2,
      ),
    );
  },
};

const fileReadTool: AgentTool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the mission workspace. Output is bounded; use line ranges for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  risk: 'low',
  summary: (input) => {
    const parsed = readInput.safeParse(input);
    return parsed.success ? `Read ${parsed.data.path}` : 'Read a workspace file';
  },
  policy: () => ({ mode: 'never', risk: 'low', reason: 'Read-only workspace access.' }),
  async execute(raw, context) {
    const input = parseInput(readInput, raw);
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const target = guard.resolve(input.path);
    const info = await stat(target);
    if (!info.isFile()) throw new ToolExecutionError('The path is not a file.', 'INVALID_PATH');

    const bytesToRead = Math.min(info.size, MAX_READ_BYTES);
    const handle = await open(target, 'r');
    const buffer = Buffer.alloc(bytesToRead);
    try {
      await handle.read(buffer, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }
    if (buffer.subarray(0, Math.min(8_192, buffer.length)).includes(0)) {
      throw new ToolExecutionError('Refusing to read a binary file.', 'BINARY_FILE');
    }

    let text = buffer.toString('utf8');
    if (input.startLine || input.endLine) {
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, (input.startLine ?? 1) - 1);
      const end = Math.min(lines.length, input.endLine ?? lines.length);
      text = lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n');
    }
    if (info.size > bytesToRead) {
      text += `\n\n[truncated: file is ${formatNumber(info.size)} bytes]`;
    }
    return result(true, text);
  },
};

const fileWriteTool: AgentTool = {
  name: 'write_file',
  description:
    'Create or replace a UTF-8 text file inside the mission workspace. Use this to deliver artifacts. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      content: { type: 'string', description: 'Complete UTF-8 file contents.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  risk: 'medium',
  summary: (input) => {
    const parsed = writeInput.safeParse(input);
    if (!parsed.success) return 'Write a workspace file';
    return `Write ${Buffer.byteLength(parsed.data.content)} bytes to ${parsed.data.path}`;
  },
  policy: () => ({
    mode: 'never',
    risk: 'medium',
    reason: 'Writes are confined to the isolated mission workspace.',
  }),
  async execute(raw, context) {
    const input = parseInput(writeInput, raw);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new ToolExecutionError(
        `File is too large (${formatNumber(bytes)} bytes). Maximum is ${formatNumber(MAX_WRITE_BYTES)} bytes.`,
        'FILE_TOO_LARGE',
      );
    }
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const target = guard.resolve(input.path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, input.content, 'utf8');
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof WorkspaceAccessError) throw error;
      throw new ToolExecutionError(
        `Could not write file: ${error instanceof Error ? error.message : 'unknown error'}`,
        'WRITE_FAILED',
      );
    }
    const relativePath = guard.relative(target);
    return result(true, `Wrote ${formatNumber(bytes)} bytes to ${relativePath}.`, {
      path: relativePath,
      bytes,
    });
  },
};

const fileSearchTool: AgentTool = {
  name: 'search_files',
  description:
    'Search text files in the mission workspace for a literal string. Returns matching file paths, line numbers, and previews.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Literal text to find.' },
      path: { type: 'string', description: 'Workspace-relative directory to search.' },
      caseSensitive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: 'low',
  summary: (input) => {
    const parsed = searchInput.safeParse(input);
    return parsed.success ? `Search for "${parsed.data.query}"` : 'Search the workspace';
  },
  policy: () => ({ mode: 'never', risk: 'low', reason: 'Read-only workspace access.' }),
  async execute(raw, context) {
    const input = parseInput(searchInput, raw);
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const base = guard.resolve(input.path);
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    let scanned = 0;

    const inspect = async (absolute: string): Promise<void> => {
      if (matches.length >= input.maxResults || scanned >= MAX_SEARCH_FILES) return;
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_SEARCH_BYTES) return;
      scanned += 1;
      const buffer = await readFile(absolute);
      if (buffer.subarray(0, 8_192).includes(0)) return;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const haystack = input.caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push({
            path: guard.relative(absolute),
            line: index + 1,
            preview: line.trim().slice(0, 240),
          });
          if (matches.length >= input.maxResults) break;
        }
      }
    };

    const info = await stat(base);
    if (info.isFile()) {
      await inspect(base);
    } else {
      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= input.maxResults || scanned >= MAX_SEARCH_FILES) return;
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (matches.length >= input.maxResults || scanned >= MAX_SEARCH_FILES) return;
          if (entry.isSymbolicLink()) continue;
          const absolute = join(dir, entry.name);
          if (entry.isDirectory()) await walk(absolute);
          else if (entry.isFile()) await inspect(absolute);
        }
      };
      await walk(base);
    }

    return result(
      true,
      JSON.stringify(
        {
          query: input.query,
          count: matches.length,
          truncated: matches.length >= input.maxResults || scanned >= MAX_SEARCH_FILES,
          matches,
        },
        null,
        2,
      ),
    );
  },
};

const commandTool: AgentTool = {
  name: 'run_command',
  description:
    'Run a strictly allowlisted, read-only developer command inside the mission workspace. Requires human approval. No shell, no network, sanitized environment.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['node', 'git'] },
      args: { type: 'array', items: { type: 'string' }, maxItems: 24 },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'high',
  summary: (input) => {
    const parsed = commandInput.safeParse(input);
    return parsed.success
      ? `Run: ${parsed.data.command} ${parsed.data.args.join(' ')}`.trim()
      : 'Run an allowlisted command';
  },
  policy: () => ({
    mode: 'always',
    risk: 'high',
    reason: 'Shell commands can affect the host and require explicit human approval.',
  }),
  async execute(raw, context) {
    const input = parseInput(commandInput, raw);
    const guard = new WorkspaceGuard(context.workspaceRoot);
    validateCommandInput(input, guard);
    const run = await runSafeCommand(input, context, guard);
    return result(
      run.exitCode === 0 && !run.timedOut,
      JSON.stringify(
        {
          command: input.command,
          args: input.args,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: run.truncated,
          stdout: run.stdout,
          stderr: run.stderr,
        },
        null,
        2,
      ),
    );
  },
};

const fetchTool: AgentTool = {
  name: 'fetch_url',
  description:
    'Fetch a public text/JSON/HTML URL for research. Requires human approval. Local, private, and non-text targets are blocked.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Public http(s) URL.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  risk: 'high',
  summary: (input) => {
    const parsed = fetchInput.safeParse(input);
    return parsed.success ? `Fetch ${parsed.data.url}` : 'Fetch a public URL';
  },
  policy: () => ({
    mode: 'always',
    risk: 'high',
    reason: 'Fetching external content can leak data or introduce untrusted instructions.',
  }),
  async execute(raw, context) {
    const input = parseInput(fetchInput, raw);
    const response = await fetchPublicText(input.url, context.signal);
    return result(
      response.status >= 200 && response.status < 400,
      JSON.stringify(response, null, 2),
    );
  },
};

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(private readonly config: AppConfig) {
    this.register(fileListTool);
    this.register(fileReadTool);
    this.register(fileWriteTool);
    this.register(fileSearchTool);
    if (config.enableShellTools) this.register(commandTool);
    if (config.enableFetchTool) this.register(fetchTool);
  }

  private register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  policy(name: string, input: unknown): ToolPolicy {
    const tool = this.tools.get(name);
    if (!tool) {
      return { mode: 'denied', risk: 'high', reason: `Unknown tool "${name}".` };
    }
    const policy = tool.policy(input);
    if (name === 'run_command' && !this.config.requireApprovalForCommands) {
      return { ...policy, mode: 'never', reason: 'Command approval is disabled by configuration.' };
    }
    return policy;
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolExecutionError(`Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    return tool.execute(input, context);
  }

  summarize(name: string, input: unknown): string {
    const tool = this.tools.get(name);
    if (!tool) return summarize(input);
    try {
      return tool.summary(input);
    } catch {
      return summarize(input);
    }
  }
}
