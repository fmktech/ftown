import { accessSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export type IdentityResetReason = 'revoked' | 'manual';
export interface IdentityResetResult { oldBridgeId: string | null; newBridgeId: string; reason: IdentityResetReason }

interface Marker { version: 1; reason: IdentityResetReason; requestedAt: string; newBridgeId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const markerPath = (dataDir: string): string => join(dataDir, 'security', 'identity-reset.json');

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** Missing file counts as done; any other fs failure must surface. */
function removeIfPresent(path: string): void {
  try { unlinkSync(path); }
  catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
}

/** Removes `*.tmp` files (and links) left in `dir` by interrupted atomic writes; never descends into directories. */
function sweepTemporaries(dir: string): void {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (err) {
    if (errCode(err) === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.tmp') && (entry.isFile() || entry.isSymbolicLink())) removeIfPresent(join(dir, entry.name));
  }
}

function syncDir(dir: string): void {
  let fd: number;
  try { fd = openSync(dir, 'r'); } catch { return; }
  try { fsyncSync(fd); } catch { /* directory fsync is unsupported on some platforms */ } finally { closeSync(fd); }
}

function writeAtomic(path: string, dir: string, content: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${uuidv4()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dir);
}

/** null = no marker file; undefined = marker present but invalid. */
function readMarker(dataDir: string): Marker | null | undefined {
  let raw: string;
  try { raw = readFileSync(markerPath(dataDir), 'utf8'); }
  catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return undefined;
    const m = v as Record<string, unknown>;
    if (m.version !== 1 || (m.reason !== 'revoked' && m.reason !== 'manual')) return undefined;
    if (typeof m.requestedAt !== 'string' || typeof m.newBridgeId !== 'string' || !UUID_RE.test(m.newBridgeId)) return undefined;
    return { version: 1, reason: m.reason, requestedAt: m.requestedAt, newBridgeId: m.newBridgeId };
  } catch { return undefined; }
}

export function beginIdentityReset(dataDir: string, reason: IdentityResetReason): void {
  if (readMarker(dataDir)) return;
  const marker: Marker = { version: 1, reason, requestedAt: new Date().toISOString(), newBridgeId: uuidv4() };
  writeAtomic(markerPath(dataDir), join(dataDir, 'security'), JSON.stringify(marker));
}

export function completePendingIdentityReset(dataDir: string): IdentityResetResult | null {
  const marker = readMarker(dataDir);
  if (marker === null) return null;
  // A corrupt marker cannot name the new identity; leave it for beginIdentityReset to replace.
  if (marker === undefined) return null;
  const securityDir = join(dataDir, 'security');
  const bridgeIdPath = join(dataDir, 'bridge-id');

  let oldBridgeId: string | null = null;
  try { oldBridgeId = readFileSync(bridgeIdPath, 'utf8').trim() || null; }
  catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
  // A crash after step 5 already holds the new id; the previous one is unknowable then.
  if (oldBridgeId === marker.newBridgeId) oldBridgeId = null;

  // v1 account state (also what hasLegacyAccountState looks for, so a finished reset never triggers another).
  removeIfPresent(join(dataDir, 'refresh-token'));
  for (const name of ['account-enrollment.json', 'pending-approval-status.json', 'pending-approval-confirmation.json', 'local-cli-identity.json']) {
    removeIfPresent(join(securityDir, name));
  }
  removeIfPresent(join(dataDir, 'browser-devices.json'));
  removeIfPresent(join(securityDir, 'policy.json'));
  // Whatever its owner: a v1 account identity, or Solo/--local's `solo:<bridgeId>` one, which names the bridge-id this reset
  // rotates and so could never be loaded again (Solo/--local then start fresh, as before the ledger). Only account mode starts a
  // reset; a Solo/--local identity never triggers one (hasLegacyAccountState ignores it).
  removeIfPresent(join(securityDir, 'bridge-identity.json'));
  // The ledger bridge: its keys, its replica (including the sticky revocations of the old identity), its offline-grace clock and
  // the last relay URL its server named.
  removeIfPresent(join(securityDir, 'ledger.json'));
  removeIfPresent(join(securityDir, 'ledger-clock.json'));
  removeIfPresent(join(securityDir, 'relay-url.json'));
  removeIfPresent(join(securityDir, 'ledger-identity.json'));
  sweepTemporaries(securityDir);
  // Deletions must be durable before the new id lands.
  syncDir(securityDir);
  syncDir(dataDir);
  writeAtomic(bridgeIdPath, dataDir, `${marker.newBridgeId}\n`);
  removeIfPresent(markerPath(dataDir));
  syncDir(securityDir);

  return { oldBridgeId, newBridgeId: marker.newBridgeId, reason: marker.reason };
}

// Every value-taking `ftown start` option (index.ts); each consumes its next token verbatim.
const VALUE_OPTIONS = ['--port', '--api-url', '--data-dir', '--bridge-id'];
const DROPPED_OPTIONS = ['--bridge-id'];

/** The same start without the old identity's --bridge-id and without --new-identity; an unpaired start pairs by itself. */
export function argvForPairingRestart(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new-identity' || a.startsWith('--new-identity=')) continue;
    if (VALUE_OPTIONS.some((f) => a.startsWith(`${f}=`))) {
      if (!DROPPED_OPTIONS.some((f) => a.startsWith(`${f}=`))) out.push(a);
      continue;
    }
    if (VALUE_OPTIONS.includes(a)) {
      const hasValue = i + 1 < argv.length;
      if (!DROPPED_OPTIONS.includes(a)) { out.push(a); if (hasValue) out.push(argv[i + 1]); }
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function reexec(scriptPath: string, argv: string[]): boolean {
  if (typeof process.execve !== 'function') return false;
  // A failing execve aborts the process (SIGABRT) instead of throwing, e.g. when the node binary was replaced under us.
  try {
    accessSync(process.execPath, constants.X_OK);
    accessSync(scriptPath, constants.R_OK);
  } catch { return false; }
  process.execve(process.execPath, [process.execPath, ...process.execArgv, scriptPath, ...argv], process.env);
  return true;
}
