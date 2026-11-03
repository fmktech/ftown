import { Worker } from 'node:worker_threads';

/**
 * Wall-clock budget for one grep match pass. Bounds catastrophic backtracking
 * (e.g. `(.|..)+X$` on an ordinary line) that a read-permission endpoint could
 * otherwise use to stall the bridge event loop.
 */
export const GREP_REGEX_TIMEOUT_MS = 300;

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

/**
 * Test `pattern` against every line within a hard time budget.
 * Returns matching line indexes, or `null` when the match exceeded the budget.
 * Throws `SyntaxError` for a pattern that is not a valid regular expression.
 */
export function boundedMatchIndexes(
  pattern: string,
  lines: string[],
  timeoutMs: number = GREP_REGEX_TIMEOUT_MS,
): Promise<number[] | null> {
  // Compile in the parent to distinguish an invalid pattern (throw) from a
  // timeout (null) cheaply and without spawning a worker for bad input.
  new RegExp(pattern, 'i');

  return new Promise(resolve => {
    let settled = false;
    let worker: Worker | undefined;
    const finish = (value: number[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, lines } });
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve(null);
      return;
    }
    worker.once('message', (message: { indexes?: unknown; invalid?: boolean }) => {
      if (message?.invalid) return finish(null);
      finish(Array.isArray(message?.indexes) ? (message.indexes as number[]) : []);
    });
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}
