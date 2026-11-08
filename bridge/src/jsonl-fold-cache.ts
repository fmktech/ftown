import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * Incremental left folds over append-only JSONL files.
 *
 * A fold's state is cached per (kind, path) together with the byte offset it has consumed, so a repeat call
 * reads only what was appended since. The cache entry is trusted only while the file keeps the same
 * dev/ino, is not shorter than the offset, and the last ANCHOR_BYTES before the offset are unchanged; any
 * other change (truncate, rename-replace, in-place rewrite) refolds from scratch. Only complete lines advance
 * the offset, except a final unterminated segment that already parses as JSON. File reads go through a FIFO
 * limiter so many transcripts never hit the event loop at once.
 */

/** A synchronous left fold over the parsed values of a JSONL file. */
export interface JsonlFold<S> {
  /** Stable id of the fold semantics; part of the cache key. Change it when init/step semantics change. */
  readonly kind: string;
  /** A fresh, empty state. */
  init(): S;
  /** Applies one parsed line. Synchronous; must not throw; must not keep `value` (copy what it needs). */
  step(state: S, value: unknown): void;
}

export interface JsonlFoldCacheOptions {
  /** Max files read at once across all folds of this cache. Integer >= 1. Default 2. */
  concurrency?: number;
  /** Max cached (kind, path) entries; least recently used are evicted. Default 512. */
  maxEntries?: number;
  /** Bytes per read call. Default 65_536. Tests may use tiny values. */
  chunkBytes?: number;
}

export interface JsonlFoldCacheStats {
  /** Entries currently cached. */
  entries: number;
  /** Total bytes returned by file reads since construction, anchor bytes included. */
  bytesRead: number;
  /** Highest number of simultaneous file reads observed since construction. */
  peakActiveReads: number;
}

export const ANCHOR_BYTES = 64;

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_CHUNK_BYTES = 65_536;
const LF = 0x0a;
const CR = 0x0d;

interface Entry {
  dev: number;
  ino: number;
  offset: number;
  anchor: Buffer;
  state: unknown;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function lastBytes(buf: Buffer, n: number): Buffer {
  // Owned copy: a view would pin the whole chunk it came from.
  return Buffer.from(buf.subarray(Math.max(0, buf.length - n)));
}

/** Parses one raw line (CR already allowed at the end); undefined when blank or not JSON. */
function parseLine(raw: Buffer): { value: unknown } | undefined {
  const end = raw.length > 0 && raw[raw.length - 1] === CR ? raw.length - 1 : raw.length;
  if (end === 0) return undefined;
  try {
    return { value: JSON.parse(raw.toString('utf8', 0, end)) as unknown };
  } catch {
    return undefined;
  }
}

export class JsonlFoldCache {
  private readonly concurrency: number;
  private readonly maxEntries: number;
  private readonly chunkBytes: number;
  private readonly entries = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private bytesRead = 0;
  private peakActiveReads = 0;

  constructor(options: JsonlFoldCacheOptions = {}) {
    this.concurrency = positiveInt(options.concurrency, DEFAULT_CONCURRENCY);
    this.maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.chunkBytes = positiveInt(options.chunkBytes, DEFAULT_CHUNK_BYTES);
  }

  fold<S, R>(
    filePath: string,
    fold: JsonlFold<S>,
    timeoutMs: number,
    finish: (state: Readonly<S>) => R,
  ): Promise<R | null> {
    const key = `${fold.kind}\0${filePath}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.run(key, filePath, fold, timeoutMs, finish));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  stats(): JsonlFoldCacheStats {
    return {
      entries: this.entries.size,
      bytesRead: this.bytesRead,
      peakActiveReads: this.peakActiveReads,
    };
  }

  clear(): void {
    this.entries.clear();
  }

  private async run<S, R>(
    key: string,
    filePath: string,
    fold: JsonlFold<S>,
    timeoutMs: number,
    finish: (state: Readonly<S>) => R,
  ): Promise<R | null> {
    await this.acquire();
    let state: S | null;
    try {
      state = await this.read(key, filePath, fold, Date.now() + timeoutMs);
    } finally {
      this.release();
    }
    if (state === null) return null;
    return finish(state);
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.take();
        resolve();
      });
    });
  }

  private take(): void {
    this.active += 1;
    if (this.active > this.peakActiveReads) this.peakActiveReads = this.active;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, position + got);
      if (bytesRead === 0) break;
      got += bytesRead;
      this.bytesRead += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
  }

  /** Brings the cached state for `key` up to date; the state on success, null (entry dropped) on failure. */
  private async read<S>(key: string, filePath: string, fold: JsonlFold<S>, deadline: number): Promise<S | null> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(filePath, 'r');
      const st = await fh.stat();
      if (!st.isFile()) {
        this.entries.delete(key);
        return null;
      }

      let entry = this.entries.get(key);
      if (entry) {
        let reusable = entry.dev === st.dev && entry.ino === st.ino && st.size >= entry.offset;
        if (reusable && entry.anchor.length > 0) {
          const current = await this.readAt(fh, entry.offset - entry.anchor.length, entry.anchor.length);
          reusable = current.equals(entry.anchor);
        }
        if (!reusable) entry = undefined;
      }

      const state = entry ? (entry.state as S) : fold.init();
      let offset = entry ? entry.offset : 0;
      // The last committed boundary is `chunk[0..k)` preceded by `hist`; the anchor is derived from it at the end.
      let hist: Buffer = entry ? entry.anchor : Buffer.alloc(0);
      let commitChunk: Buffer = Buffer.alloc(0);
      let commitK = 0;
      let commitHist = hist;

      const pending: Buffer[] = [];
      let pos = offset;
      let stopped = false;
      let tailCommitted = false;
      while (!stopped && pos < st.size) {
        const chunk = await this.readAt(fh, pos, Math.min(this.chunkBytes, st.size - pos));
        if (chunk.length === 0) break;
        const chunkPos = pos;
        pos += chunk.length;
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(LF, start);
          if (nl === -1) break;
          if (Date.now() > deadline) {
            stopped = true;
            break;
          }
          pending.push(chunk.subarray(start, nl));
          const parsed = parseLine(pending.length === 1 ? pending[0] : Buffer.concat(pending));
          pending.length = 0;
          if (parsed) fold.step(state, parsed.value);
          start = nl + 1;
          offset = chunkPos + start;
          commitChunk = chunk;
          commitK = start;
          commitHist = hist;
        }
        if (stopped) break;
        if (start < chunk.length) pending.push(chunk.subarray(start));
        hist = lastBytes(Buffer.concat([hist, lastBytes(chunk, ANCHOR_BYTES)]), ANCHOR_BYTES);
      }

      if (!stopped && pending.length > 0 && pos === st.size && Date.now() <= deadline) {
        const parsed = parseLine(Buffer.concat(pending));
        // A scalar could still grow ("12" -> "123"); an object or array cannot be a strict prefix of a longer line.
        if (parsed && typeof parsed.value === 'object' && parsed.value !== null) {
          fold.step(state, parsed.value);
          offset = st.size;
          // Everything read is consumed, so `hist` (tail of all consumed bytes) is the anchor.
          tailCommitted = true;
        }
      }

      const anchor = tailCommitted
        ? hist
        : lastBytes(Buffer.concat([commitHist, commitChunk.subarray(0, commitK)]), ANCHOR_BYTES);

      this.entries.delete(key);
      this.entries.set(key, {
        dev: st.dev,
        ino: st.ino,
        offset,
        anchor,
        state,
      });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
      return state;
    } catch {
      this.entries.delete(key);
      return null;
    } finally {
      if (fh) await fh.close().catch(() => undefined);
    }
  }
}

export const defaultJsonlFoldCache = new JsonlFoldCache();
