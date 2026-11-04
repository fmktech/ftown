import { Worker } from 'node:worker_threads';

/**
 * Wall-clock budget for one grep match pass. Bounds catastrophic backtracking
 * (e.g. `(.|..)+X$` on an ordinary line) that a read-permission endpoint could
 * otherwise use to stall the bridge event loop.
 */
export const GREP_REGEX_TIMEOUT_MS = 300;

/** Maximum grep workers running at once for this bridge process. */
export const GREP_MAX_CONCURRENT = 4;

/** Maximum requests waiting for a worker slot before overload is reported. */
export const GREP_MAX_QUEUE = 16;

/** Raised when the grep worker pool and its wait queue are both saturated. */
export class GrepBusyError extends Error {
  constructor() {
    super('Too many concurrent searches');
    this.name = 'GrepBusyError';
  }
}

let active = 0;
const waiters: Array<() => void> = [];

/** Reserve a worker slot, or return false when the queue is full. */
async function acquireSlot(): Promise<boolean> {
  if (active < GREP_MAX_CONCURRENT) {
    active += 1;
    return true;
  }
  if (waiters.length >= GREP_MAX_QUEUE) return false;
  await new Promise<void>(resolve => waiters.push(resolve));
  return true;
}

/** Hand the slot to the next waiter, or free it when none is waiting. */
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}

// The worker compiles the pattern and tests each line, then posts the matching
// indexes. It runs off the main event loop; the parent force-terminates it on
// timeout, so a pathological regex cannot block command handling.
const WORKER_SOURCE = `import('node:worker_threads').then(({ parentPort, workerData }) => {
  try {
    const re = new RegExp(workerData.pattern, 'i');
    const lines = workerData.lines;
    const indexes = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) indexes.push(i);
    parentPort.postMessage({ indexes });
  } catch { parentPort.postMessage({ invalid: true }); }
});`;

function runWorker(pattern: string, lines: string[], timeoutMs: number): Promise<number[] | null> {
  return new Promise(resolve => {
    // Resolve only once the worker has actually exited, so a pool slot is never
    // released while a terminating worker is still live.
    let settled = false;
    let exited = false;
    let outcome: number[] | null = null;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    const decide = (value: number[] | null): void => {
      if (settled) return;
      settled = true;
      outcome = value;
      if (timer) clearTimeout(timer);
      if (exited) { resolve(outcome); return; }
      void worker?.terminate();
    };
    const onExit = (): void => {
      exited = true;
      if (settled) resolve(outcome);
      else decide(null);
    };
    timer = setTimeout(() => decide(null), timeoutMs);
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, lines } });
    } catch {
      if (timer) clearTimeout(timer);
      resolve(null);
      return;
    }
    worker.once('message', (message: { indexes?: unknown; invalid?: boolean }) => {
      decide(message?.invalid ? null : (Array.isArray(message?.indexes) ? (message.indexes as number[]) : []));
    });
    worker.once('error', () => decide(null));
    worker.once('exit', onExit);
  });
}

/**
 * Test `pattern` against every line within a hard time budget, at most
 * `GREP_MAX_CONCURRENT` at once with a bounded wait queue.
 * Returns matching line indexes, or `null` when the match exceeded the budget.
 * Throws `SyntaxError` for an invalid pattern and `GrepBusyError` when the pool
 * and queue are saturated (the caller should respond 429).
 */
export async function boundedMatchIndexes(
  pattern: string,
  lines: string[],
  timeoutMs: number = GREP_REGEX_TIMEOUT_MS,
): Promise<number[] | null> {
  // Compile in the parent to distinguish an invalid pattern (throw) from a
  // timeout (null) cheaply and without spawning a worker for bad input.
  new RegExp(pattern, 'i');

  if (!(await acquireSlot())) throw new GrepBusyError();
  try {
    return await runWorker(pattern, lines, timeoutMs);
  } finally {
    releaseSlot();
  }
}
