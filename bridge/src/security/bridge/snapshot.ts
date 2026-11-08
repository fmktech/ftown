import { statSync, type BigIntStats } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { BridgeSecurityError } from './errors.js';

const RACY_WINDOW_MS = 50;
const identityOf = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

/** Writers replace the file atomically; reads are served from an identity-validated cache. Never publish in-memory state before durable replacement. */
export class AtomicSnapshot<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private cache: { identity: string; value: T } | null = null;
  constructor(private readonly file: string, private readonly schema: z.ZodType<T>, private readonly initial: () => NoInfer<T>) {}

  private async load(): Promise<T> {
    let stat: BigIntStats;
    try { stat = statSync(this.file, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cache = null; return this.initial(); }
      throw new BridgeSecurityError('storage_unavailable');
    }
    if (this.cache?.identity === identityOf(stat)) return structuredClone(this.cache.value);
    let handle;
    try {
      handle = await open(this.file, 'r');
      const fstat = await handle.stat({ bigint: true });
      if (fstat.size > 64n * 1024n * 1024n) throw new Error('Oversize snapshot');
      const value = this.schema.parse(JSON.parse(await handle.readFile('utf8')));
      const newest = Math.max(Number(fstat.mtimeMs), Number(fstat.ctimeMs));
      this.cache = Date.now() - newest >= RACY_WINDOW_MS ? { identity: identityOf(fstat), value } : null;
      return structuredClone(value);
    } catch (error) {
      this.cache = null;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.initial();
      throw new BridgeSecurityError('storage_unavailable');
    } finally { await handle?.close(); }
  }

  private async save(value: T): Promise<void> {
    this.cache = null;
    const directory = dirname(this.file);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(this.schema.parse(value))); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new BridgeSecurityError('storage_unavailable');
    }
  }

  transact<R>(update: (state: T) => R | Promise<R>): Promise<R> {
    const run = this.tail.then(async () => {
      const state = await this.load();
      const result = await update(state);
      await this.save(state);
      return structuredClone(result);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  read<R>(select: (state: T) => R): Promise<R> {
    const run = this.tail.then(async () => structuredClone(select(await this.load())));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> { await this.tail; }
}
