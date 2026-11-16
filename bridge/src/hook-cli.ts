import {
  HOOK_KINDS,
  IMPLEMENTED_HOOK_KINDS,
  type BuildHookArgv,
  type BuildHookExecArgv,
  type BuildHookShellCommand,
  type HookEnvironment,
  type HookFailure,
  type HookKind,
  type PostHookPayload,
} from './hook-contract.js';
import { HOOK_ADAPTERS } from './hook-adapters.js';
import { buildHookTransportConfig, postHookPayload } from './hook-transport.js';

type ParsedArgs = { ok: true; kind: HookKind } | { ok: false; message: string };

const EXPECTED = `expected one of: ${HOOK_KINDS.join(', ')}`;

/** Parse the arguments after `hook`: exactly one known kind, nothing else. */
export function parseHookArgs(args: readonly string[]): ParsedArgs {
  if (args.length === 0) return { ok: false, message: `missing hook kind (${EXPECTED})` };
  if (args.length > 1) return { ok: false, message: `expected exactly one hook kind, got ${args.length} (${EXPECTED})` };
  const kind = args[0];
  if (!HOOK_KINDS.includes(kind as HookKind)) {
    return { ok: false, message: `unknown hook kind "${kind}" (${EXPECTED})` };
  }
  return { ok: true, kind: kind as HookKind };
}

export interface RunHookDeps {
  /** Arguments after `hook`. */
  readonly args: readonly string[];
  /** Complete UTF-8 stdin, read once before adapter dispatch. */
  readonly input: string;
  readonly env: HookEnvironment;
  /** Transport injected so tests can observe the exact wire payload. */
  readonly post: PostHookPayload;
  readonly out?: (message: string) => void;
  readonly err?: (message: string) => void;
  /** Set by the real CLI when stdin could not be read. */
  readonly stdinError?: HookFailure;
}

/**
 * Shared hook entry point. Usage errors return 2; every valid-kind failure is
 * reported on stderr and returns 0 so a hook never blocks its agent. Stdout is
 * emitted at most once, and only when an adapter produced it (mail decisions).
 */
export async function runHookCommand(deps: RunHookDeps): Promise<number> {
  const out = deps.out ?? (() => {});
  const err = deps.err ?? (() => {});
  const parsed = parseHookArgs(deps.args);
  if (!parsed.ok) {
    err(`ftown hook: ${parsed.message}`);
    return 2;
  }
  if (deps.stdinError) {
    err(`ftown hook: ${deps.stdinError.message}`);
    return 0;
  }

  const adapter = HOOK_ADAPTERS[parsed.kind];
  if (!adapter) {
    err(`ftown hook: kind "${parsed.kind}" is not implemented yet (${IMPLEMENTED_HOOK_KINDS.join(', ')})`);
    return 0;
  }

  const config = buildHookTransportConfig(deps.env);
  const result = await adapter({
    kind: parsed.kind,
    input: deps.input,
    env: deps.env,
    post: (payload) => deps.post(payload, config),
  });
  if (result.stdout !== undefined) out(result.stdout);
  if (result.status === 'error') {
    err(`ftown hook: ${result.error.message}`);
  }
  return 0;
}

/** Read all of stdin as UTF-8. Hooks always pipe a complete JSON payload. */
async function readHookStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Real-stdin/env wrapper used by `ftown-harness hook [args...]`. */
export async function runHookCli(args: readonly string[]): Promise<number> {
  // Validate usage before touching stdin: a mis-registered hook must not hang on a TTY.
  const parsed = parseHookArgs(args);
  if (!parsed.ok) {
    console.error(`ftown hook: ${parsed.message}`);
    return 2;
  }
  let input = '';
  let stdinError: HookFailure | undefined;
  try {
    input = await readHookStdin();
  } catch {
    stdinError = { kind: 'stdin-error', message: 'could not read hook payload from stdin' };
  }
  return runHookCommand({
    args,
    input,
    env: process.env as HookEnvironment,
    post: postHookPayload,
    out: (message) => console.log(message),
    err: (message) => console.error(message),
    stdinError,
  });
}

/** POSIX single-quote one argument (embedded quotes become '\''). */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Arguments for a harness that spawns the executable itself, without a shell. */
export const buildHookArgv: BuildHookArgv = (kind) => ['hook', kind];
/** Full argv including the executable, for direct-exec harness registration. */
export const buildHookExecArgv: BuildHookExecArgv = (executablePath, kind) => [executablePath, 'hook', kind];
/** Quoted command string for harnesses that store a POSIX shell command. */
export const buildHookShellCommand: BuildHookShellCommand = (executablePath, kind) =>
  [executablePath, 'hook', kind].map(quotePosix).join(' ');
