/**
 * Solo hub manager — downloads, verifies, configures, spawns and stops the
 * managed Centrifugo child (contract ownership: solo/hub-manager.ts(+test)).
 *
 * Dependency policy (deliberate): node builtins + node:child_process + the
 * SYSTEM `tar` binary only — no new npm deps. tar(1) ships with macOS and
 * Linux, the only platforms resolvePlatformTriple() supports, so archive
 * listing/extraction needs no bundled extraction library.
 *
 * Invariants owned here: S6 (embedded CENTRIFUGO_SHA256 verification before
 * anything is extracted), S7 (0600 config + pidfile), S15 (child argv is
 * exactly [binPath, '-c', configPath]; no secrets in argv/env), S16 (logs
 * never echo secrets — stderr tails are sanitized), L2 (stale pidfile reap
 * under dataDir/solo/ on boot).
 */

import { execFile as execFileCb, spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, realpath, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CENTRIFUGO_SHA256,
  CENTRIFUGO_VERSION,
  HUB_JWT_AUDIENCE,
} from './contract.js';

const execFile = promisify(execFileCb);

export type PlatformTriple = 'darwin-arm64' | 'darwin-amd64' | 'linux-amd64' | 'linux-arm64';

/** Minimal fetch seam so downloads and health probes run offline in tests. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Structural view of the child we spawn (satisfied by node's ChildProcess). */
export interface HubChildProcess {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => HubChildProcess;

const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as HubChildProcess;

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPlatformError';
  }
}

export class ChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumError';
  }
}

export class ArchiveSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveSafetyError';
  }
}

export class HubStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubStartError';
  }
}

// ---------- Platform triple & release asset URL ----------

const ARCH_ALIASES: Readonly<Record<string, string>> = {
  x64: 'amd64',
  arm64: 'arm64',
};

export function resolvePlatformTriple(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformTriple {
  const archAlias = ARCH_ALIASES[arch];
  if ((platform === 'darwin' || platform === 'linux') && archAlias !== undefined) {
    return `${platform}-${archAlias}` as PlatformTriple;
  }
  throw new UnsupportedPlatformError(`unsupported platform/arch pair: ${platform}/${arch}`);
}

export function assetUrl(version: string, triple: PlatformTriple): string {
  const bare = version.startsWith('v') ? version.slice(1) : version;
  // Release assets use UNDERSCORES between parts (centrifugo_5.4.9_darwin_arm64.tar.gz)
  // while our platform triple is dashed — verified against the v5.4.9 checksums.txt.
  const assetTriple = triple.split('-').join('_');
  return `https://github.com/centrifugal/centrifugo/releases/download/${version}/centrifugo_${bare}_${assetTriple}.tar.gz`;
}

// ---------- Binary ensure (S6) ----------

const MAX_ARCHIVE_ENTRIES = 200;
const TAIL_LIMIT_BYTES = 8192;
const SANITIZED_TAIL_LIMIT = 2000;

export interface EnsureHubBinaryOptions {
  dataDir: string;
  version?: string;
  fetchImpl?: FetchLike;
  /**
   * Test seam overriding the embedded digest map. Production callers MUST
   * leave it unset so verification stays pinned to contract CENTRIFUGO_SHA256.
   */
  digests?: Readonly<Record<string, string>>;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Hex(new Uint8Array(await readFile(filePath)));
}

/**
 * Validates tar entries against the extraction allowlist (S4/S17):
 * names must be relative without '..' segments; entry types must be regular
 * file ('-') or directory ('d') — symlinks, hardlinks, devices are refused.
 */
export function assertSafeTarEntries(names: readonly string[], verboseLines: readonly string[]): void {
  if (names.length !== verboseLines.length) {
    throw new ArchiveSafetyError('tar listing mismatch between name and verbose output');
  }
  for (const name of names) {
    if (name.startsWith('/')) {
      throw new ArchiveSafetyError(`refusing absolute archive entry path`);
    }
    if (name.split('/').includes('..')) {
      throw new ArchiveSafetyError(`refusing archive entry escaping target dir`);
    }
  }
  for (const line of verboseLines) {
    const kind = line.charAt(0);
    if (kind !== '-' && kind !== 'd') {
      throw new ArchiveSafetyError(`refusing non-regular-file archive entry (type "${kind}")`);
    }
  }
}

async function locateCentrifugoBinary(root: string): Promise<string> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ArchiveSafetyError('symlink present in extracted hub archive');
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === 'centrifugo') {
        found.push(full);
      }
    }
  };
  await walk(root);
  if (found.length !== 1) {
    throw new ChecksumError(
      `unexpected hub archive layout: expected exactly one "centrifugo" entry, found ${found.length}`,
    );
  }
  const rootReal = await realpath(root);
  const binaryReal = await realpath(found[0]);
  if (!binaryReal.startsWith(rootReal + path.sep)) {
    throw new ArchiveSafetyError('extracted hub binary resolved outside its sandbox');
  }
  return found[0];
}

export async function ensureHubBinary(opts: EnsureHubBinaryOptions): Promise<string> {
  const version = opts.version ?? CENTRIFUGO_VERSION;
  const triple = resolvePlatformTriple();
  const expectedSha = (opts.digests ?? CENTRIFUGO_SHA256)[triple];
  if (expectedSha === undefined) {
    throw new ChecksumError(`no embedded sha256 digest for platform triple "${triple}"`);
  }

  const soloDir = path.join(opts.dataDir, 'solo');
  const binDir = path.join(soloDir, 'bin');
  const target = path.join(binDir, `centrifugo-${version}`);
  // The embedded digests describe the RELEASE ARCHIVE, not the unpacked binary,
  // so the cache records the verified archive digest in a sidecar at install
  // time; a cached install is trusted only if that record still matches.
  const targetSidecar = `${target}.sha256`;
  await mkdir(binDir, { recursive: true });

  const sidecarSha = existsSync(targetSidecar)
    ? (await readFile(targetSidecar, 'utf8').catch(() => '')).trim()
    : '';
  if (
    existsSync(target) &&
    (sidecarSha === expectedSha || (await sha256File(target)) === expectedSha)
  ) {
    return target;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = assetUrl(version, triple);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new ChecksumError(`hub binary download failed: HTTP ${res.status} from ${url}`);
  }
  const archive = Buffer.from(await res.arrayBuffer());
  const actualSha = sha256Hex(archive);
  if (actualSha !== expectedSha) {
    // S6: mismatch aborts BEFORE any extraction — nothing is ever unpacked or run.
    throw new ChecksumError(
      `hub archive checksum mismatch for ${triple}: expected sha256 ${expectedSha}, got ${actualSha}; nothing was extracted`,
    );
  }

  const archivePath = path.join(soloDir, `.download-${randomUUID()}.tar.gz`);
  const extractDir = path.join(soloDir, `.extract-${randomUUID()}`);
  await writeFile(archivePath, archive, { mode: 0o600 });
  await mkdir(extractDir, { recursive: true });
  try {
    const tarOpts = { encoding: 'utf8' as const, maxBuffer: 16 * 1024 * 1024 };
    const names = (await execFile('tar', ['-tzf', archivePath], tarOpts)).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const verbose = (await execFile('tar', ['-tvzf', archivePath], tarOpts)).stdout
      .split('\n')
      .filter((line) => line.trim().length > 0);
    if (names.length > MAX_ARCHIVE_ENTRIES) {
      throw new ArchiveSafetyError(`hub archive has too many entries (${names.length})`);
    }
    assertSafeTarEntries(names, verbose);
    await execFile('tar', ['-xzf', archivePath, '-C', extractDir], tarOpts);
    const extracted = await locateCentrifugoBinary(extractDir);
    try {
      await rename(extracted, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(extracted, target);
    }
    await chmod(target, 0o700);
    await writeFile(targetSidecar, `${expectedSha}\n`, { mode: 0o600 });
    return target;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

// ---------- Config write (frozen keys, S7) ----------

/**
 * Frozen solo hub configuration. Security keys mirror the contract block
 * translated to actual centrifugo v5 flat key names (verified against the
 * v5.4.9 source defaults): `admin` disables the admin web UI, `api_disable`
 * disables the server HTTP API, `allow_anonymous_connect_without_token=false`
 * means no anonymous client connections. address/port are operational keys so
 * the child binds loopback on the ephemeral port the integrator assigned.
 *
 * `allowed_origins: []` is deliberate, not an oversight: centrifugo v5
 * rejects (403s) any handshake that carries an Origin header when this list
 * is empty. That's fine here because same-origin is enforced ourselves, one
 * hop earlier, in the front proxy (ws-proxy.ts `handleHubUpgrade` /
 * `isSameOrigin`), which also strips the Origin header before forwarding —
 * so centrifugo never sees one to judge. The hub additionally only ever
 * binds loopback (127.0.0.1, see `address` below), so it is never reachable
 * directly from a browser regardless. Do not "fix" this by populating
 * allowed_origins; that would just duplicate — and could drift from — the
 * check ws-proxy.ts already owns.
 */
function hubConfigObject(port: number, secret: string): Record<string, unknown> {
  return {
    address: '127.0.0.1',
    port,
    token_hmac_secret_key: secret,
    token_audience: HUB_JWT_AUDIENCE,
    allowed_origins: [],
    websocket_compression: false,
    allow_anonymous_connect_without_token: false,
    admin: false,
    api_disable: true,
    health: true,
  };
}

export async function writeHubConfig(
  configPath: string,
  opts: { port: number; secret: string },
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const body = JSON.stringify(hubConfigObject(opts.port, opts.secret), null, 2) + '\n';
  await writeFile(configPath, body, { encoding: 'utf8', mode: 0o600 });
  // Enforce even when overwriting a pre-existing file (mode applies at creation).
  await chmod(configPath, 0o600);
}

// ---------- Spawn / health / stop lifecycle ----------

export interface StartHubOptions {
  configPath: string;
  binPath: string;
  dataDir: string;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  /** Overrides http://127.0.0.1:<port> as the base for /health probes (tests). */
  healthBaseUrl?: string;
  healthIntervalMs?: number;
  healthTryTimeoutMs?: number;
  healthDeadlineMs?: number;
}

export interface RunningHub {
  child: HubChildProcess;
  pid: number | undefined;
  port: number;
}

const DEFAULT_HEALTH_INTERVAL_MS = 500;
const DEFAULT_HEALTH_TRY_TIMEOUT_MS = 1000;
const DEFAULT_HEALTH_DEADLINE_MS = 30_000;
const STOP_GRACE_MS = 3_000;
const STOP_POLL_MS = 100;

export function hubPidFilePath(dataDir: string): string {
  return path.join(dataDir, 'solo', 'hub.pid');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendTail(prev: string, chunk: Buffer | string): string {
  return (prev + chunk.toString('utf8')).slice(-TAIL_LIMIT_BYTES);
}

/** Strips ANSI escapes and redacts the hub secret (S16). */
function sanitizeTail(tail: string, secret: string): string {
  let out = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  if (secret.length >= 8) {
    out = out.split(secret).join('[redacted]');
  }
  return out.slice(-SANITIZED_TAIL_LIMIT);
}

async function probeHealth(url: string, timeoutMs: number, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function reapStalePidFile(pidFile: string): Promise<void> {
  const raw = await readFile(pidFile, 'utf8').catch(() => null);
  await rm(pidFile, { force: true });
  if (raw === null) return;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // lost the race — nothing to reap
  }
}

export async function startHub(opts: StartHubOptions): Promise<RunningHub> {
  let port: number;
  let secret: string;
  try {
    const parsed = JSON.parse(await readFile(opts.configPath, 'utf8')) as {
      port?: unknown;
      token_hmac_secret_key?: unknown;
    };
    port = Number(parsed.port);
    secret = typeof parsed.token_hmac_secret_key === 'string' ? parsed.token_hmac_secret_key : '';
  } catch (err) {
    throw new HubStartError(`cannot read hub config ${opts.configPath}: ${errorMessage(err)}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new HubStartError(`hub config ${opts.configPath} has no usable port`);
  }

  const pidFile = hubPidFilePath(opts.dataDir);
  await mkdir(path.dirname(pidFile), { recursive: true });
  await reapStalePidFile(pidFile);

  const spawn = opts.spawnImpl ?? defaultSpawn;
  let child: HubChildProcess;
  try {
    // S15: the ONLY argv the child ever gets.
    child = spawn(opts.binPath, ['-c', opts.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new HubStartError(`failed to spawn hub binary: ${errorMessage(err)}`);
  }

  const state: {
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = { exit: null };
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = appendTail(stderrTail, chunk);
  });
  child.stdout?.on('data', () => {});
  // S16: log the failure kind only — never argv, config contents, or secrets.
  child.on('error', (err: Error) => {
    console.error(`[ftown-solo] hub process error: ${err.message}`);
  });
  child.once('exit', (code, signal) => {
    state.exit = { code, signal };
  });

  if (typeof child.pid === 'number') {
    await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
    await chmod(pidFile, 0o600);
  }

  const base = (opts.healthBaseUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const healthUrl = `${base}/health`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const intervalMs = opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const tryTimeoutMs = opts.healthTryTimeoutMs ?? DEFAULT_HEALTH_TRY_TIMEOUT_MS;
  const deadlineMs = opts.healthDeadlineMs ?? DEFAULT_HEALTH_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;

  let healthy = false;
  while (Date.now() < deadline && !state.exit) {
    if (await probeHealth(healthUrl, tryTimeoutMs, fetchImpl)) {
      healthy = true;
      break;
    }
    await sleep(intervalMs);
  }

  if (!healthy) {
    const exitBeforeKill = state.exit;
    child.kill('SIGKILL');
    await rm(pidFile, { force: true });
    const reason = exitBeforeKill
      ? `hub exited early (code=${exitBeforeKill.code}, signal=${exitBeforeKill.signal})`
      : `hub did not become healthy within ${deadlineMs}ms`;
    throw new HubStartError(`${reason}; last hub stderr:\n${sanitizeTail(stderrTail, secret)}`);
  }
  return { child, pid: child.pid, port };
}

/** SIGTERM → 3s grace → SIGKILL; always unlinks the pidfile. Returns whether a live process was stopped. */
export async function stopHub(dataDir: string): Promise<boolean> {
  const pidFile = hubPidFilePath(dataDir);
  const raw = await readFile(pidFile, 'utf8').catch(() => null);
  await rm(pidFile, { force: true });
  if (raw === null) return false;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (pidAlive(pid) && Date.now() < deadline) {
    await sleep(STOP_POLL_MS);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return true;
}
