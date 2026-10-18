import { spawn } from 'node:child_process';
import type { Session } from './types.js';

export type NativeMailWakeResult = { status: 'accepted' | 'unsupported' | 'rejected' | 'unknown' };
export type NativeMailWaker = (session: Session, text: string, signal?: AbortSignal,
  isCurrent?: () => Promise<boolean>) => Promise<NativeMailWakeResult>;

interface CommandOptions {
  cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal;
  timeoutMs: number; maxOutputBytes: number;
}
interface CommandResult {
  started: boolean; code: number | null; stdout: string; stderr: string;
  errorCode?: string; timedOut?: boolean; overflow?: boolean; aborted?: boolean;
}
interface Dependencies {
  run?: (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_OUTPUT = 65_536;
const PROBE_TTL_MS = 60_000;
const PROBE_CACHE_LIMIT = 16;

/** No shell interpolation, bounded output/time, explicit stdin EOF for Muse. */
async function runCommand(file: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) return { started: false, code: null, stdout: '', stderr: '', aborted: true };
  return new Promise((resolve) => {
    const result: CommandResult = { started: false, code: null, stdout: '', stderr: '' };
    let bytes = 0;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const terminate = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => { child.kill('SIGKILL'); }, 250);
      forceTimer.unref();
    };
    const abort = () => { result.aborted = true; terminate(); };
    const timer = setTimeout(() => { result.timedOut = true; terminate(); }, options.timeoutMs);
    timer.unref();
    const collect = (key: 'stdout' | 'stderr', data: Buffer) => {
      bytes += data.length;
      if (bytes > options.maxOutputBytes) { result.overflow = true; terminate(); return; }
      result[key] += data.toString('utf8');
    };
    child.once('spawn', () => { result.started = true; });
    child.stdout.on('data', (data: Buffer) => collect('stdout', data));
    child.stderr.on('data', (data: Buffer) => collect('stderr', data));
    child.once('error', (error: NodeJS.ErrnoException) => { result.errorCode = error.code; });
    child.once('close', (code) => {
      result.code = code;
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    });
    child.stdin.on('error', () => { /* A receiver may close stdin before EOF. Receipt decides admission. */ });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });
}

function targetEnvironment(base: NodeJS.ProcessEnv, session: Session): NodeJS.ProcessEnv {
  const env = { ...base };
  // A bridge may itself be running inside Codex/Muse. Its client/transport
  // selectors must not redirect the wake away from the receiving session.
  for (const key of Object.keys(env)) {
    if ((key.startsWith('CODEX_') && key !== 'CODEX_HOME') || key.startsWith('MUSE_')) delete env[key];
  }
  // ProcessRunner applies explicit target overrides last, including home/XDG.
  Object.assign(env, session.env);
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'MUSE_SESSION_ID', 'MUSE_THREAD_ID']) delete env[key];
  env.MUSE_NO_AUTO_UPDATE = '1';
  return env;
}
function interrupted(result: CommandResult): boolean {
  return !!(result.timedOut || result.overflow || result.aborted || result.errorCode);
}
function parserUnsupported(result: CommandResult): boolean {
  return result.code !== 0 && /(?:unrecognized subcommand|unknown command|unexpected argument)[^\n]*(?:queue|session-message|--thread|--target|--json)/i.test(result.stderr);
}
function backendUnsupported(result: CommandResult): boolean {
  // Codex itself emits this only for typed method-not-found/feature-gate
  // errors. Capacity, permissions and transport failures are not unsupported.
  return result.code !== 0 && /the (?:local app-server daemon|remote app server) does not support thread\/queue\/add; update or restart the (?:local app-server daemon|remote app server)/.test(result.stderr);
}

/** Native commands are only wake pointers; the durable inbox owns consumption. */
export function createNativeMailWaker(deps: Dependencies = {}): NativeMailWaker {
  const run = deps.run ?? runCommand;
  const now = deps.now ?? Date.now;
  const base = deps.env ?? process.env;
  const probes = new Map<string, { supported: boolean; expires: number }>();
  return async (session, text, signal, isCurrent) => {
    const harness = session.shellType;
    if (harness !== 'codex' && harness !== 'muse') return { status: 'unsupported' };
    const nativeId = harness === 'codex' ? session.codexSessionId : session.museSessionId;
    if (!nativeId || !UUID.test(nativeId)) return { status: 'unsupported' };
    if (session.status !== 'running' || !text.trim() || text.length > 4096 || signal?.aborted) return { status: 'rejected' };
    // Real Muse 1.4.10 default-preset echo receivers rejected idle AND busy
    // sends with external_agent_ingress_closed and no receipts. Keep the
    // compatibility path until an ingress with verified admission is available;
    // command presence alone is insufficient.
    if (harness === 'muse') return { status: 'unsupported' };
    const env = targetEnvironment(base, session);
    const cwd = session.workingDir ?? process.cwd();
    const options = { cwd, env, signal, timeoutMs: 5_000, maxOutputBytes: MAX_OUTPUT };
    const cacheKey = JSON.stringify([harness, env.PATH, env.HOME, env.CODEX_HOME, env.XDG_CONFIG_HOME, cwd]);
    let probe = probes.get(cacheKey);
    try {
      if (!probe || now() >= probe.expires) {
        const result = await run('codex', ['queue', '--help'], options);
        if (signal?.aborted) return { status: 'rejected' };
        if (result.errorCode === 'ENOENT' || parserUnsupported(result)) probe = { supported: false, expires: now() + PROBE_TTL_MS };
        else if (interrupted(result) || result.code !== 0) return { status: 'rejected' }; // Probe never submits input.
        else probe = { supported: /Usage:\s*codex queue\b/.test(result.stdout) && result.stdout.includes('--thread') && result.stdout.includes('--message'), expires: now() + PROBE_TTL_MS };
        probes.delete(cacheKey);
        while (probes.size >= PROBE_CACHE_LIMIT) probes.delete(probes.keys().next().value!);
        probes.set(cacheKey, probe);
      }
      if (!probe.supported) return { status: 'unsupported' };
      if (signal?.aborted || (isCurrent && !await isCurrent()) || signal?.aborted) return { status: 'rejected' };
      const result = await run('codex', ['queue', '--thread', nativeId, '--message', text], { ...options, timeoutMs: 10_000 });
      if (!result.started) return { status: result.errorCode === 'ENOENT' ? 'unsupported' : 'rejected' };
      if (interrupted(result)) return { status: 'unknown' };
      if (parserUnsupported(result) || backendUnsupported(result)) return { status: 'unsupported' };
      if (result.code !== 0) return { status: 'unknown' };
      const receipt = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.$/i.exec(result.stdout.trim());
      return { status: receipt && UUID.test(receipt[1]) && receipt[2].toLowerCase() === nativeId.toLowerCase() ? 'accepted' : 'unknown' };
    } catch {
      // An injected runner must preserve dispatch state; a thrown exception is
      // ambiguous, so never automatically dispatch again through another path.
      return { status: 'unknown' };
    }
  };
}
