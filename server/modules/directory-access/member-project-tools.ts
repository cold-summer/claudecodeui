import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LLMProvider, MemberChatRun, MemberPermissionMode } from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

const SHELL = '/bin/bash';
const SANDBOX = '/usr/bin/sandbox-exec';
const OUTPUT_LIMIT = 24_000;
const execFileAsync = promisify(execFile);
let runningCommands = 0;
const EXECUTABLES = ['/bin', '/usr/bin', '/usr/libexec', '/Library/Developer/CommandLineTools/usr/bin'];
const SYSTEM_READS = [
  ...EXECUTABLES, '/usr/lib', '/usr/share', '/System/Library', '/private/var/db/dyld',
  '/Library/Apple/System/Library', '/Library/Developer/CommandLineTools',
];
const DEVICES = ['/', '/dev/null', '/dev/urandom', '/dev/random'];

export function memberToolsAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX);
}

export function memberPermissionModes(provider: LLMProvider): MemberPermissionMode[] {
  if (!memberToolsAvailable()) return ['default'];
  const standard: MemberPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
  if (provider === 'codex') return standard;
  return provider === 'claude'
    ? ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']
    : [...standard, 'plan'];
}

export function readMemberPermissionMode(provider: LLMProvider, value: unknown): MemberPermissionMode {
  const mode = value === undefined ? 'default' : value;
  const match = memberPermissionModes(provider).find((candidate) => candidate === mode);
  if (!match) {
    throw new AppError('This permission mode is unavailable for the selected conversation.', {
      code: 'MEMBER_CHAT_PERMISSION_MODE_UNAVAILABLE', statusCode: 400,
    });
  }
  return match;
}

const toolDefinitions = [
  {
    name: 'list_files', description: 'List one directory in the authorized project. Use "." for the project root.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_file', description: 'Read a text file in the authorized project. Optional line range, one-based and inclusive.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file', description: 'Write a complete text file inside the authorized project. The parent directory must already exist.',
    input_schema: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
    },
  },
  {
    name: 'run_command', description: 'Run a shell command in the authorized project under its sandbox. Network and project-external file access are unavailable. Prefer read_file/list_files for inspection.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

export function getMemberToolDefinitions(mode: MemberPermissionMode, hostWorkspaceAccess = false) {
  if (mode === 'plan') return [];
  return toolDefinitions.flatMap((tool) => {
    if (tool.name !== 'run_command') return [tool];
    if (mode === 'auto') return [];
    return [hostWorkspaceAccess ? {
      ...tool,
      description: 'Run a shell command on the CloudCLI host, starting in the selected project, with the host environment and network access.',
    } : tool];
  });
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
}

function checkProtectedRoot(root: string) {
  const home = os.homedir();
  const protectedPaths = ['.claude', '.cloudcli', '.codex', '.ssh'].map((name) => path.join(home, name));
  if (process.env.DATABASE_PATH) protectedPaths.push(path.resolve(process.env.DATABASE_PATH));
  if (isWithin(root, home) || protectedPaths.some((target) => isWithin(target, root) || isWithin(root, target))) {
    throw new Error('This directory is too broad or contains protected host data.');
  }
}

function pathArgument(root: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Enter a project path.');
  const target = path.resolve(root, value);
  if (!isWithin(root, target)) throw new Error('The path is outside the authorized project.');
  return target;
}

function pathFilters(kind: 'subpath' | 'literal', paths: string[]) {
  return [...new Set(paths)].map((item) => `(${kind} ${JSON.stringify(item)})`).join(' ');
}

function makeSandboxProfile(root: string, scratch: string, writable: boolean): string {
  const ancestors: string[] = [];
  for (const item of [root, scratch]) {
    for (let cursor = path.dirname(item); cursor !== '/'; cursor = path.dirname(cursor)) ancestors.push(cursor);
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec file-map-executable ${pathFilters('subpath', [...EXECUTABLES, ...SYSTEM_READS, root, scratch])})`,
    `(allow file-read* ${pathFilters('subpath', [...SYSTEM_READS, root, scratch])}`,
    `  ${pathFilters('literal', DEVICES)})`,
    `(allow file-read-metadata ${pathFilters('literal', [...ancestors, '/private/var/select', '/private/var/select/developer_dir'])})`,
    `(allow file-write* ${pathFilters('subpath', writable ? [scratch, root] : [scratch])} (literal "/dev/null"))`,
  ].join('\n');
}

type SandboxedCommand = { args: string[]; stdin?: string; writable?: boolean };

type ToolResult = { content: string; is_error?: boolean };

async function runProjectCommand(root: string, command: SandboxedCommand, run: MemberChatRun): Promise<ToolResult> {
  if (runningCommands >= 4) throw new Error('Project tools are busy. Try again shortly.');
  runningCommands += 1;
  const { signal, hostWorkspaceAccess } = run;
  let scratch: string | undefined;
  try {
    let executable = SHELL;
    let args = command.args;
    let env = process.env;
    if (!hostWorkspaceAccess) {
      scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloudcli-member-tools-')));
      const { stdout } = await execFileAsync('/bin/ps', ['-U', String(process.getuid?.() ?? ''), '-o', 'pid='], {
        maxBuffer: 64_000, timeout: 2_000, signal,
      });
      const processLimit = String(stdout.trim().split('\n').length + 32);
      executable = SANDBOX;
      args = [
        '-p', makeSandboxProfile(root, scratch, Boolean(command.writable)),
        SHELL, '--noprofile', '--norc', '-c',
        'ulimit -c 0 && ulimit -t 20 && ulimit -f 32768 && ulimit -n 128 && ulimit -u "$1" || exit 125; shift; exec "$@"',
        'cloudcli-tool', processLimit, SHELL, ...args,
      ];
      env = {
        PATH: '/usr/bin:/bin',
        HOME: scratch,
        TMPDIR: scratch,
        LANG: 'en_US.UTF-8',
        DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      };
    }
    signal.throwIfAborted();
    run.checkAccess();
    return await new Promise<ToolResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env,
        detached: true,
        stdio: [command.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stopped: string | undefined;
      const stopGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      };
      const stop = (reason: string) => {
        stopped ??= reason;
        stopGroup();
      };
      const abort = () => stop('Action cancelled.');
      const timeout = setTimeout(
        () => stop('Command exceeded the time limit.'),
        hostWorkspaceAccess ? 300_000 : 25_000,
      );
      const accessCheck = setInterval(() => {
        try { run.checkAccess(); } catch { stop('Workspace access was revoked.'); }
      }, 2_000);
      const collect = (chunk: Buffer) => {
        if (bytes < OUTPUT_LIMIT) chunks.push(chunk.subarray(0, OUTPUT_LIMIT - bytes));
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT && !hostWorkspaceAccess) stop('Output limit reached.');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.stdin?.on('error', () => {});
      child.stdin?.end(command.stdin);
      child.once('exit', stopGroup);
      child.once('error', reject);
      child.once('close', (code, signalName) => {
        clearTimeout(timeout);
        clearInterval(accessCheck);
        signal.removeEventListener('abort', abort);
        const output = Buffer.concat(chunks).toString('utf8') + (bytes > OUTPUT_LIMIT ? '\n[Output truncated]' : '');
        const status = stopped ?? (code === 0 ? '' : `Command failed (${code ?? signalName}).`);
        resolve({ content: [status, output].filter(Boolean).join('\n') || 'Done.', ...(status ? { is_error: true } : {}) });
      });
    });
  } finally {
    runningCommands -= 1;
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** Runs a model tool inside the currently authorized project using the selected approval mode. */
export async function executeMemberTool(
  run: MemberChatRun, name: string, input: unknown,
): Promise<ToolResult> {
  try {
    run.signal.throwIfAborted();
    if (!memberToolsAvailable() || !getMemberToolDefinitions(run.permissionMode).some((tool) => tool.name === name)) {
      throw new Error('This tool is unavailable in the selected permission mode.');
    }
    run.checkAccess();
    const root = await realpath(run.projectPath);
    const normalized = path.resolve(run.projectPath).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1');
    if (root !== normalized || !(await stat(root)).isDirectory()) throw new Error('The project must be a real directory.');
    if (!run.hostWorkspaceAccess) checkProtectedRoot(root);
    const args = readObjectRecord(input) ?? {};
    if (name === 'run_command') {
      const script = typeof args.command === 'string' ? args.command.trim() : '';
      if (!script || script.length > 12_000 || script.includes('\0')) throw new Error('Invalid shell command.');
      if (run.permissionMode !== 'bypassPermissions' && !(await run.approve('Bash', { command: script }))) {
        throw new Error('The user did not approve this command.');
      }
      run.checkAccess();
      return await runProjectCommand(root, { args: ['--noprofile', '--norc', '-c', script], writable: true }, run);
    }

    const target = run.hostWorkspaceAccess && typeof args.path === 'string' && args.path.trim() && !args.path.includes('\0')
      ? path.resolve(root, args.path)
      : pathArgument(root, args.path);
    if (name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : undefined;
      if (content === undefined || Buffer.byteLength(content) > 160_000) throw new Error('Enter text under 160 KB.');
      if (run.permissionMode === 'default' && !(await run.approve('Write', { file_path: target, content }))) {
        throw new Error('The user did not approve writing this file.');
      }
      run.checkAccess();
      return await runProjectCommand(root, {
        args: ['--noprofile', '--norc', '-c', '/bin/cat > "$1"', 'cloudcli-write', target],
        stdin: content, writable: true,
      }, run);
    }

    run.checkAccess();
    const first = Number.isSafeInteger(args.start_line) ? Math.max(1, Number(args.start_line)) : 1;
    const last = Number.isSafeInteger(args.end_line) ? Math.max(first, Number(args.end_line)) : first + 499;
    const script = name === 'list_files' ? '/bin/ls -A -- "$1"' : '/usr/bin/sed -n "$2" "$1"';
    return await runProjectCommand(root, {
      args: ['--noprofile', '--norc', '-c', script, 'cloudcli-read', target, `${first},${last}p`],
    }, run);
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'The project action failed.', is_error: true };
  }
}
