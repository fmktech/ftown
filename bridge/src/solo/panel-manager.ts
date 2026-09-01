/**
 * ftown Solo — panel-manager.
 *
 * Owns the managed Next.js STANDALONE child ("the panel"):
 *   - bundle URL templating from PANEL_BUNDLE_URL_TEMPLATE
 *   - bundle fetch + sha256 sidecar verification (S6, first-party trust root)
 *   - extraction hardened per S4 (zip-slip, entry-type allowlist) and S17
 *     (per-entry / total uncompressed / entry-count caps — decompression bombs)
 *   - spawn on 127.0.0.1:<port>, pinned via HOSTNAME/PORT env (private binding),
 *     argv carries ONLY [interpreter, server.js] — no secrets ever (S15)
 *   - lifecycle L2: pidfile under <dataDir>/solo/panel.pid with stale-orphan
 *     reap on boot; SIGTERM → 3s → SIGKILL shutdown
 *   - pinned health probe: HEAD http://127.0.0.1:<port>/ , status <500 = up,
 *     1s probe timeout, 45s give-up (cold-start budget)
 *
 * EXTERNAL TOOLING CHOICE (documented): the system `tar` binary is used for
 * extraction (`tar -xzf --no-same-owner`) and for the entry-name pre-listing
 * (`tar -tzf`). Structural enforcement (S4 type allowlist, S17 byte caps) is
 * performed by walking the ustar headers of the gunzipped stream with node
 * builtins only: `-t` output is prose whose layout differs between bsdtar and
 * GNU tar (and is ambiguous for filenames containing whitespace), whereas raw
 * ustar headers are exact, portable, and let us abort MID-STREAM on cap
 * breach instead of after extraction. No third-party dependencies.
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { ChildProcess } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { PANEL_BUNDLE_URL_TEMPLATE } from './contract.js';

const execFileP = promisify(execFile);

// ---------- Errors ----------

/** Any panel bundle acquisition/installation failure. */
export class PanelBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelBundleError';
  }
}

/** sha256 sidecar verification failure (S6) — install aborted, nothing ran. */
export class ChecksumError extends PanelBundleError {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumError';
  }
}

/** Panel child failed to spawn or never became healthy. */
export class PanelStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelStartError';
  }
}

// ---------- Limits (S17) ----------

/** Per-entry uncompressed size cap (decompression-bomb defense). */
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
/** Total uncompressed size cap across all entries. */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** Maximum number of archive entries. */
export const MAX_ENTRIES = 20_000;

/** Pinned panel health-probe parameters (contract: probe table). */
export const PANEL_HEALTH_PROBE_TIMEOUT_MS = 1_000;
export const PANEL_HEALTH_MAX_WAIT_MS = 45_000;
/** L2 shutdown: SIGTERM → 3s → SIGKILL. */
export const STOP_GRACE_MS = 3_000;

/** Inter-poll delay while waiting for the panel to become healthy. */
const HEALTH_POLL_INTERVAL_MS = 250;
/** Poll cadence when waiting for a signalled pid to die. */
const PID_DEATH_POLL_MS = 50;
/** Bytes of child stderr retained for sanitized error reporting (S16-safe). */
const STDERR_TAIL_BYTES = 4_096;

// ---------- URL templating ----------

/** Substitute every `<version>` placeholder in the frozen template. */
export function panelBundleUrl(version: string): string {
  return PANEL_BUNDLE_URL_TEMPLATE.replaceAll('<version>', version);
}

// ---------- Bundle install ----------

export interface EnsurePanelBundleOptions {
  /** Bridge data dir (~/.ftown/data). Bundle caches under <dataDir>/solo/panel/. */
  dataDir: string;
  /** UI package version identifying the release asset. */
  version: string;
  /** Injectable fetch (tests run offline). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ensure the standalone bundle for `version` is extracted under
 * `<dataDir>/solo/panel/<version>/` and return that directory.
 *
 * Flow: cached-marker short-circuit → download tar.gz → download `.sha256`
 * sidecar → lowercase-hex comparison (mismatch ⇒ cleanup + ChecksumError) →
 * pre-scan (`tar -tzf` names + structural ustar walk enforcing S4/S17) →
 * `tar -xzf --no-same-owner` → write `.ok` marker (0600).
 */
export async function ensurePanelBundle(opts: EnsurePanelBundleOptions): Promise<string> {
  assertSafeVersion(opts.version);
  const doFetch = opts.fetchImpl ?? fetch;
  const versionDir = path.join(opts.dataDir, 'solo', 'panel', opts.version);
  const marker = path.join(versionDir, '.ok');

  if (await isFile(marker)) return versionDir;

  try {
    // No marker ⇒ prior run was interrupted or tampered: rebuild from scratch.
    await fs.rm(versionDir, { recursive: true, force: true });
    await fs.mkdir(versionDir, { recursive: true });
    await assertContained(opts.dataDir, versionDir, opts.version);

    const url = panelBundleUrl(opts.version);
    const bundleRes = await doFetch(url);
    if (!bundleRes.ok) {
      throw new PanelBundleError(`panel bundle download failed: HTTP ${bundleRes.status} for ${url}`);
    }
    const bytes = Buffer.from(await bundleRes.arrayBuffer());

    const sidecarRes = await doFetch(`${url}.sha256`);
    if (!sidecarRes.ok) {
      throw new ChecksumError(`panel bundle checksum sidecar download failed: HTTP ${sidecarRes.status}`);
    }
    const expected = (await sidecarRes.text()).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new ChecksumError('panel bundle checksum sidecar is malformed (expected 64 hex chars)');
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      throw new ChecksumError(
        `panel bundle checksum mismatch: expected ${expected}, got ${actual}`,
      );
    }

    const archivePath = path.join(versionDir, 'bundle.tar.gz');
    await fs.writeFile(archivePath, bytes, { mode: 0o600 });

    // Pre-scan pass 1: structural ustar walk (entry-type allowlist + S17 caps
    // + name safety), aborting mid-stream on any breach. Runs before the
    // system-tar listing because hostile archives can make `tar -t` itself
    // choke on truncation; the structural walk gives precise diagnostics.
    await scanTarStructure(archivePath);

    // Pre-scan pass 2: independent system-tar entry-name cross-check
    // (absolute paths, ".." segments, entry count).
    const names = await listTarEntryNames(archivePath);
    if (names.length > MAX_ENTRIES) {
      throw new PanelBundleError(
        `panel bundle rejects archive: ${names.length} entries exceeds limit ${MAX_ENTRIES}`,
      );
    }
    for (const name of names) assertSafeEntryName(name);

    await extractArchive(archivePath, versionDir);
    await fs.rm(archivePath, { force: true });

    await fs.writeFile(marker, `${opts.version}\n`, { mode: 0o600 });
    return versionDir;
  } catch (err) {
    // Failed installs leave nothing behind.
    await fs.rm(versionDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function assertSafeVersion(version: string): void {
  if (!/^[\w.-]+$/.test(version) || version.includes('..')) {
    throw new PanelBundleError(`refusing unsafe panel version identifier: ${version}`);
  }
}

async function assertContained(dataDir: string, versionDir: string, version: string): Promise<void> {
  const realData = await fs.realpath(dataDir);
  const expected = path.join(realData, 'solo', 'panel', version);
  const realDest = await fs.realpath(versionDir);
  if (realDest !== expected) {
    throw new PanelBundleError(
      `extraction target ${realDest} resolved outside its dataDir subdirectory (${expected})`,
    );
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// ---------- Archive scanning ----------

/** Pass 1: entry NAMES via the system tar binary. */
async function listTarEntryNames(archivePath: string): Promise<string[]> {
  let stdout: string;
  try {
    const res = await execFileP('tar', ['-tzf', archivePath], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PanelBundleError(`panel bundle archive unreadable by tar: ${detail}`);
  }
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

/** Rejects absolute paths, windows drives, and any ".." segment (S4). */
function assertSafeEntryName(name: string): void {
  const normalizedName = name.replace(/\/+$/, '');
  if (normalizedName.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalizedName)) {
    throw new PanelBundleError(`panel bundle rejects archive entry with absolute path: ${name}`);
  }
  if (normalizedName.split('/').includes('..')) {
    throw new PanelBundleError(`panel bundle rejects archive entry with '..' segment: ${name}`);
  }
}

/**
 * Pass 2: stream the gunzipped archive and walk raw 512-byte ustar headers.
 * Enforces the S4 type allowlist (regular files and directories only —
 * symlinks/hardlinks/devices/fifos rejected), the S17 caps, and name safety,
 * aborting mid-stream BEFORE extraction. Understands pax ('x'/'g') and GNU
 * ('L'/'K') metadata records so long paths resolve correctly.
 */
async function scanTarStructure(archivePath: string): Promise<void> {
  const source = createReadStream(archivePath);
  const stream = source.pipe(createGunzip());

  let buf = Buffer.alloc(0);
  let sawZeroBlock = false;
  let finished = false;
  let totalBytes = 0;
  let entryCount = 0;
  // Pending metadata applying to the NEXT real entry.
  let pendingPath: string | undefined;
  let pendingSize: number | undefined;
  // Accumulator for metadata record bodies (pax key=value, GNU longname).
  let metaBody: { chunks: Buffer[]; remaining: number } | null = null;

  const fail = (err: Error): void => {
    finished = true;
    source.destroy();
    stream.destroy();
    rejectRun(err);
  };

  let rejectRun!: (err: Error) => void;
  let resolveRun!: () => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const handleBlock = (block: Buffer): void => {
    if (isZeroBlock(block)) {
      sawZeroBlock = true;
      return;
    }
    if (sawZeroBlock) {
      throw new Error('archive contains data after end-of-archive blocks');
    }
    const rawName = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    const declaredSize = readTarSize(block, 124, 12);
    const typeflag = String.fromCharCode(block[156]);

    // Metadata records describe the NEXT entry; their bodies are consumed
    // separately below and never count toward caps or the type allowlist.
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      metaKind = typeflag;
      metaBody = { chunks: [], remaining: paddedSize(declaredSize) };
      buf = Buffer.alloc(0);
      enterBody(metaBody.remaining);
      return;
    }

    const name = pendingPath ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    const size = pendingSize ?? declaredSize;
    pendingPath = undefined;
    pendingSize = undefined;

    // S17: explicit entry-type allowlist — regular files and directories only.
    const isRegular = typeflag === '0' || typeflag === '\0' || typeflag === '7';
    const isDirectory = typeflag === '5';
    if (!isRegular && !isDirectory) {
      throw new Error(
        `archive entry '${name}' has disallowed tar type '${describeType(typeflag)}' (only regular files and directories are permitted)`,
      );
    }

    assertSafeEntryName(name);

    entryCount += 1;
    if (entryCount > MAX_ENTRIES) {
      throw new Error(`archive exceeds maximum entry count (${MAX_ENTRIES})`);
    }
    if (size > MAX_ENTRY_BYTES) {
      throw new Error(
        `archive entry '${name}' declares ${size} bytes, exceeding per-entry cap ${MAX_ENTRY_BYTES}`,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `archive exceeds total uncompressed cap ${MAX_TOTAL_BYTES} at entry '${name}'`,
      );
    }
    buf = Buffer.alloc(0);
    enterBody(paddedSize(size));
  };

  // Body consumption: metadata bodies accumulate; file/dir bodies are counted
  // (already accounted above) and discarded without materializing.
  const enterBody = (padded: number): void => {
    bodyRemaining = padded;
    inBody = true;
  };
  let inBody = false;
  let bodyRemaining = 0;

  const consumeChunk = (chunk: Buffer): void => {
    let offset = 0;
    while (offset < chunk.length) {
      if (inBody) {
        if (metaBody !== null) {
          const take = Math.min(chunk.length - offset, bodyRemaining);
          metaBody.chunks.push(chunk.subarray(offset, offset + take));
          offset += take;
          bodyRemaining -= take;
          if (bodyRemaining === 0) {
            const body = Buffer.concat(metaBody.chunks);
            metaBody = null;
            inBody = false;
            applyMetaBody(body);
          }
          continue;
        }
        const take = Math.min(chunk.length - offset, bodyRemaining);
        offset += take;
        bodyRemaining -= take;
        if (bodyRemaining === 0) inBody = false;
        continue;
      }
      if (finished) return;
      const available = chunk.length - offset;
      if (buf.length === 0 && available >= 512) {
        handleBlock(chunk.subarray(offset, offset + 512));
        offset += 512;
        continue;
      }
      const need = 512 - buf.length;
      const take = Math.min(need, available);
      buf = Buffer.concat([buf, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (buf.length === 512) {
        const block = buf;
        buf = Buffer.alloc(0);
        handleBlock(block);
      }
    }
  };

  let metaKind: 'x' | 'g' | 'L' | 'K' | undefined;

  const applyMetaBody = (body: Buffer): void => {
    // GNU longname/longlink bodies are raw text; pax bodies are
    // "<len> key=value\n" records.
    if (metaKind === 'L' || metaKind === 'K') {
      const text = readCString(body);
      if (metaKind === 'L') pendingPath = text;
      // 'K' (long link target) is irrelevant: link entries are rejected.
    } else {
      const overrides = parsePaxRecords(body);
      if (overrides.path !== undefined) pendingPath = overrides.path;
      if (overrides.size !== undefined) pendingSize = overrides.size;
    }
    metaKind = undefined;
  };

  stream.on('data', (chunk: Buffer) => {
    try {
      consumeChunk(chunk);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fail(new PanelBundleError(`panel bundle archive rejected: ${detail}`));
    }
  });
  stream.on('error', (err: Error) => fail(new PanelBundleError(`panel bundle archive scan failed: ${err.message}`)));
  stream.on('end', () => {
    if (finished) return;
    if (inBody || buf.length > 0) {
      fail(new PanelBundleError('panel bundle archive is truncated'));
      return;
    }
    finished = true;
    resolveRun();
  });

  return done;
}

function paddedSize(size: number): number {
  return Math.ceil(size / 512) * 512;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < 512; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readTarString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return block.subarray(offset, end).toString('utf8');
}

function readCString(body: Buffer): string {
  let end = body.indexOf(0);
  if (end === -1) end = body.length;
  return body.subarray(0, end).toString('utf8');
}

function readTarSize(block: Buffer, offset: number, length: number): number {
  if ((block[offset] & 0x80) !== 0) {
    // GNU base-256 encoding (large sizes).
    let value = 0n;
    for (let i = offset + 1; i < offset + length; i++) {
      value = (value << 8n) | BigInt(block[i]);
    }
    return Number(value);
  }
  const text = readTarString(block, offset, length).trim();
  if (text.length === 0) return 0;
  const parsed = Number.parseInt(text, 8);
  if (Number.isNaN(parsed)) {
    throw new Error('archive contains a malformed size field');
  }
  return parsed;
}

function describeType(typeflag: string): string {
  switch (typeflag) {
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    case '3':
      return 'char device';
    case '4':
      return 'block device';
    case '6':
      return 'fifo';
    default:
      return `typeflag 0x${typeflag.charCodeAt(0).toString(16)}`;
  }
}

/** Parse pax extended-header records (path/size overrides for next entry). */
function parsePaxRecords(body: Buffer): { path?: string; size?: number } {
  const overrides: { path?: string; size?: number } = {};
  let pos = 0;
  while (pos < body.length) {
    let space = pos;
    while (space < body.length && body[space] !== 0x20) space++;
    if (space >= body.length) break;
    const recordLength = Number.parseInt(body.subarray(pos, space).toString('ascii'), 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0) break;
    const record = body.subarray(pos, pos + recordLength);
    let end = record.length;
    while (end > 0 && (record[end - 1] === 0x0a || record[end - 1] === 0)) end--;
    const pair = record.subarray(space + 1, end).toString('utf8');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key === 'path') overrides.path = value;
      if (key === 'size') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) overrides.size = parsed;
      }
    }
    pos += recordLength;
  }
  return overrides;
}

// ---------- Extraction ----------

/** Extract with the system tar binary; --no-same-owner drops ownership bits. */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  try {
    await execFileP('tar', ['-xzf', archivePath, '-C', destDir, '--no-same-owner'], {
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PanelBundleError(`panel bundle extraction failed: ${detail}`);
  }
}

// ---------- Server-dir discovery ----------

/**
 * Locate the Next standalone output root: the directory containing server.js.
 * Searches the extract root first, then one level deep (deterministic order).
 */
export async function findPanelServerDir(extractDir: string): Promise<string> {
  if (await isFile(path.join(extractDir, 'server.js'))) return extractDir;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(extractDir, { withFileTypes: true });
  } catch {
    throw new PanelBundleError(`panel bundle extract dir is missing: ${extractDir}`);
  }
  const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of sorted) {
    if (!dirent.isDirectory()) continue;
    const candidate = path.join(extractDir, dirent.name);
    if (await isFile(path.join(candidate, 'server.js'))) return candidate;
  }
  throw new PanelBundleError(
    `panel bundle does not contain a Next standalone root (no server.js found shallow or one level deep) under ${extractDir}`,
  );
}

// ---------- Lifecycle ----------

export interface StartPanelOptions {
  /** Extracted bundle directory (findPanelServerDir locates server.js inside). */
  bundleDir: string;
  /** Private loopback port chosen by the CALLER (free-port guarantee upstream). */
  port: number;
  /** Bridge data dir — pidfile lives at <dataDir>/solo/panel.pid. */
  dataDir: string;
  /** Extra environment merged over process.env (never carries secrets, S15). */
  env?: Record<string, string>;
  /** Injectable spawn (tests). Defaults to node:child_process spawn. */
  spawnImpl?: typeof nodeSpawn;
  /** Injectable health-probe fetch (tests run offline). */
  healthFetchImpl?: typeof fetch;
  /** Test seams for the pinned probe budgets (defaults per contract). */
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  probeMaxWaitMs?: number;
}

export interface RunningPanel {
  pid: number;
  proc: ChildProcess;
  /** Directory containing server.js (the standalone output root). */
  serverDir: string;
}

function pidFilePath(dataDir: string): string {
  return path.join(dataDir, 'solo', 'panel.pid');
}

/**
 * Spawn the panel standalone server pinned to 127.0.0.1:<port>.
 *
 * - argv is exactly [process.execPath, <server.js>] — no secrets on the command
 *   line (S15). Secrets reach children only through 0600 files, never argv/env.
 * - HOSTNAME=127.0.0.1 pins the standalone server's binding (private port; the
 *   front proxies everything).
 * - A stale/orphaned pidfile is detected and reaped before spawn (L2).
 * - Resolves only after the pinned health probe succeeds (HEAD / <500).
 */
export async function startPanel(opts: StartPanelOptions): Promise<RunningPanel> {
  const serverDir = await findPanelServerDir(opts.bundleDir);
  const serverJs = path.join(serverDir, 'server.js');

  const pidfile = pidFilePath(opts.dataDir);
  await reapOrStopByPidFile(pidfile);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOSTNAME: '127.0.0.1',
    PORT: String(opts.port),
    ...(opts.env ?? {}),
  };

  const spawnFn = opts.spawnImpl ?? nodeSpawn;
  // S15: argv is exactly interpreter + script. Nothing secret-shaped may pass.
  const proc = spawnFn(process.execPath, [serverJs], {
    cwd: serverDir,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const tail = new RollingTail(STDERR_TAIL_BYTES);
  proc.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));

  // Attach the exit tracker SYNCHRONOUSLY after spawn — a child that dies
  // immediately must never slip past health-wait unnoticed.
  const exitInfo: { code: number | null; signal: string | null; exited: boolean } = {
    code: null,
    signal: null,
    exited: false,
  };
  const onExit = (code: number | null, signal: string | null): void => {
    exitInfo.code = code;
    exitInfo.signal = signal;
    exitInfo.exited = true;
  };
  proc.once('exit', onExit);

  const pid = proc.pid;
  if (pid === undefined) {
    proc.off('exit', onExit);
    throw new PanelStartError('panel spawn failed: no pid assigned');
  }

  try {
    await fs.mkdir(path.dirname(pidfile), { recursive: true });
    await fs.writeFile(
      pidfile,
      `${JSON.stringify({ pid, port: opts.port, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await waitHealthy(opts.port, exitInfo, tail, opts);
  } catch (err) {
    await terminateChild(proc);
    await fs.rm(pidfile, { force: true }).catch(() => {});
    throw err;
  } finally {
    proc.off('exit', onExit);
  }
  return { pid, proc, serverDir };
}

/** Pinned probe: HEAD http://127.0.0.1:<port>/ — up iff status < 500. */
async function waitHealthy(
  port: number,
  exitInfo: { code: number | null; signal: string | null; exited: boolean },
  tail: RollingTail,
  opts: StartPanelOptions,
): Promise<void> {
  const probeTimeoutMs = opts.probeTimeoutMs ?? PANEL_HEALTH_PROBE_TIMEOUT_MS;
  const intervalMs = opts.probeIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const maxWaitMs = opts.probeMaxWaitMs ?? PANEL_HEALTH_MAX_WAIT_MS;
  const doFetch = opts.healthFetchImpl ?? fetch;
  const deadline = Date.now() + maxWaitMs;

  const tailSuffix = (): string => {
    const text = sanitizeStderr(tail.text());
    return text.length > 0 ? `\npanel stderr (sanitized tail): ${text}` : '';
  };

  while (Date.now() < deadline) {
    if (exitInfo.exited) {
      throw new PanelStartError(
        `panel exited prematurely (code ${exitInfo.code}, signal ${exitInfo.signal})${tailSuffix()}`,
      );
    }
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (res.status < 500) return;
    } catch {
      // Probe failure ≠ fatal; retry until the deadline.
    }
    await delay(intervalMs);
  }
  throw new PanelStartError(
    `panel did not become healthy on 127.0.0.1:${port} within ${maxWaitMs}ms${tailSuffix()}`,
  );
}

/**
 * Redact anything secret-shaped from stderr excerpts before surfacing them
 * (S16: keys/JWTs/bearer tokens never reach logs).
 */
function sanitizeStderr(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}

class RollingTail {
  private content = '';
  constructor(private readonly budgetBytes: number) {}
  push(chunk: Buffer | string): void {
    this.content =
      (this.content + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).slice(
        -this.budgetBytes,
      );
  }
  text(): string {
    return this.content;
  }
}

/** SIGTERM → grace → SIGKILL on a live ChildProcess handle. */
async function terminateChild(proc: ChildProcess, graceMs = STOP_GRACE_MS): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('exit', () => resolve());
  });
  proc.kill('SIGTERM');
  const died = await Promise.race([
    exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!died) {
    proc.kill('SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForPidDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(PID_DEATH_POLL_MS);
  }
  return !isPidAlive(pid);
}

/**
 * L2 stale-pidfile semantics (own implementation, mirroring hub-manager
 * behavior without importing it): if the pidfile names a LIVE process it is an
 * orphan from a previous run — SIGTERM → 3s → SIGKILL — then remove the
 * pidfile. Dead/stale/garbled pidfiles are simply unlinked.
 */
export async function reapOrStopByPidFile(pidfile: string, graceMs = STOP_GRACE_MS): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(pidfile, 'utf8');
  } catch {
    return;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    pid = Number.NaN;
  }
  const parsed = typeof pid === 'number' ? pid : Number.NaN;
  const valid = Number.isInteger(parsed) && parsed > 1 && parsed !== process.pid;
  if (valid && isPidAlive(parsed)) {
    try {
      process.kill(parsed, 'SIGTERM');
    } catch {
      // Lost the race — nothing to signal.
    }
    if (!(await waitForPidDeath(parsed, graceMs))) {
      try {
        process.kill(parsed, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await waitForPidDeath(parsed, 1_000);
    }
  }
  await fs.rm(pidfile, { force: true }).catch(() => {});
}

/**
 * Stop the panel previously started under `dataDir`: SIGTERM → 3s → SIGKILL,
 * then remove the pidfile. Idempotent; safe when no pidfile exists.
 */
export async function stopPanel(dataDir: string): Promise<void> {
  await reapOrStopByPidFile(pidFilePath(dataDir));
}
