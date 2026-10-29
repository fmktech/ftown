import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { BridgeSecurityError } from './errors.js';

/** One process owns each instance directory. Never publish in-memory state before durable replacement. */
export class AtomicSnapshot<T> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly schema: z.ZodType<T>, private readonly initial: () => NoInfer<T>) {}

  private async load(): Promise<T> {
    let handle;
    try {
      handle = await open(this.file, 'r');
      if ((await handle.stat()).size > 64 * 1024 * 1024) throw new Error('Oversize snapshot');
      return this.schema.parse(JSON.parse(await handle.readFile('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.initial();
      throw new BridgeSecurityError('storage_unavailable');
    } finally { await handle?.close(); }
  }

  private async save(value: T): Promise<void> {
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
