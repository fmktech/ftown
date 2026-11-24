import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveFtownHome } from './ftown-home.js';

function savedValue(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function publishedOwnerIsAlive(dataDir: string, port: number): boolean {
  const raw = savedValue(join(resolveFtownHome(dataDir), 'bridge.json'));
  if (!raw) return false;
  try {
    const pointer = JSON.parse(raw);
    if (pointer.port !== port || !Number.isSafeInteger(pointer.pid) || pointer.pid < 1) return false;
    process.kill(pointer.pid, 0);
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Older releases do not acquire the instance lock. Identify their existing loopback listener
 * without sending credentials or confusing an unrelated service on a reused port with a bridge. */
async function legacyBridgeIsRunning(dataDir: string): Promise<boolean> {
  const port = Number(savedValue(join(dataDir, 'local-api-port')));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const bridgeId = savedValue(join(dataDir, 'bridge-id'));
  if (!bridgeId) return false;
  const signal = AbortSignal.timeout(2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/security/info`, { redirect: 'manual', signal });
    if (![200, 503].includes(response.status) || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 16_384) { await reader.cancel(); return false; }
      chunks.push(value);
    }
    const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return (response.status === 200 && info?.protocolVersion === 1 && info.bridgeId === bridgeId)
      || (response.status === 503 && info?.code === 'security_setup_required');
  } catch (error) {
    if (error instanceof SyntaxError || (error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED') return false;
    if (publishedOwnerIsAlive(dataDir, port)) {
      throw new Error(`Cannot verify the previous bridge on local port ${port}. Check whether it is still running and retry.`);
    }
    return false; // A stale port can now belong to a non-HTTP listener.
  }
}

/** A lifetime kernel lock on a dedicated SQLite file. Never unlink the file: every contender must
 * lock the same inode. The OS releases it on crash, abrupt termination and exec, without PID leases. */
export async function acquireBridgeInstance(dataDir: string): Promise<DatabaseSync> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'bridge-instance.sqlite'));
  const occupied = `An ftown bridge is already running with data directory ${dataDir}. Stop it before starting another bridge here.`;
  try {
    db.exec('BEGIN EXCLUSIVE');
    if (await legacyBridgeIsRunning(dataDir)) throw new Error(occupied);
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) throw new Error(occupied); // SQLITE_BUSY
    throw error;
  }
}
