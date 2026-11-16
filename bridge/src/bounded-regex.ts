import { Worker } from 'node:worker_threads';

/**
 * Wall-clock budget for one grep match pass. Bounds catastrophic backtracking
 * (e.g. `(.|..)+X$` on an ordinary line) that a read-permission endpoint could
 * otherwise use to stall the bridge event loop.
 */
export const GREP_REGEX_TIMEOUT_MS = 2_000;

/** Allow for worker startup separately from the matching budget. */
export const GREP_WORKER_STARTUP_TIMEOUT_MS = 10_000;

export type GrepMatchResult =
  | { status: 'completed'; indexes: number[] }
  | { status: 'timeout'; phase: 'startup' | 'match' }
  | { status: 'error' };

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
  parentPort.postMessage({ ready: true });
  parentPort.once('message', () => { try {
    const re = new RegExp(workerData.pattern, 'i');
    const lines = workerData.lines;
    const indexes = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) indexes.push(i);
    parentPort.postMessage({ indexes });
  } catch { parentPort.postMessage({ error: true }); } });
});`;

function runWorker(pattern: string, lines: string[], timeoutMs: number): Promise<GrepMatchResult> {
  return new Promise(resolve => {
    // Resolve only once the worker has actually exited, so a pool slot is never
    // released while a terminating worker is still live.
    let settled = false;
    let exited = false;
    let outcome: GrepMatchResult = { status: 'error' };
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    const decide = (value: GrepMatchResult): void => {
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
      else decide({ status: 'error' });
    };
    timer = setTimeout(() => decide({ status: 'timeout', phase: 'startup' }), GREP_WORKER_STARTUP_TIMEOUT_MS);
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, lines } });
    } catch {
      if (timer) clearTimeout(timer);
      resolve({ status: 'error' });
      return;
    }
    worker.on('message', (message: { ready?: boolean; indexes?: unknown }) => {
      if (settled) return;
      if (message?.ready) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => decide({ status: 'timeout', phase: 'match' }), timeoutMs);
        worker?.postMessage('start');
      } else if (Array.isArray(message?.indexes)) {
        decide({ status: 'completed', indexes: message.indexes as number[] });
      } else {
        decide({ status: 'error' });
      }
    });
    worker.once('error', () => decide({ status: 'error' }));
    worker.once('exit', onExit);
  });
}

/**
 * Test `pattern` against every line within a hard time budget, at most
 * `GREP_MAX_CONCURRENT` at once with a bounded wait queue.
 * Returns matching line indexes, a timeout phase, or a worker error.
 * Throws `SyntaxError` for an invalid pattern and `GrepBusyError` when the pool
 * and queue are saturated (the caller should respond 429).
 */
export async function boundedMatchIndexes(
  pattern: string,
  lines: string[],
  timeoutMs: number = GREP_REGEX_TIMEOUT_MS,
): Promise<GrepMatchResult> {
  // Compile in the parent to distinguish an invalid pattern (throw) from a
  // worker failure cheaply and without spawning a worker for bad input.
  new RegExp(pattern, 'i');

  if (!(await acquireSlot())) throw new GrepBusyError();
  try {
    return await runWorker(pattern, lines, timeoutMs);
  } finally {
    releaseSlot();
  }
}
