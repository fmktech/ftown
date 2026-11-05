import {
  OUTBOUND_CAPACITY_WARNING,
  OUTBOUND_FAILURE_ERROR,
  OUTBOUND_MAX_IN_FLIGHT_BYTES,
  OUTBOUND_MAX_IN_FLIGHT_PACKETS,
  OUTBOUND_MAX_QUEUED,
  OUTBOUND_WARN_INTERVAL_MS,
  describeError,
  type CreateOutboundPipeline,
  type OutboundJob,
  type OutboundLogger,
  type OutboundPacket,
} from './outbound-pipeline-types.js';

export const createOutboundPipeline: CreateOutboundPipeline = ({ logger }) => {
  const jobs: OutboundJob[] = [];
  let queued = 0;
  let inFlightPackets = 0;
  let inFlightBytes = 0;
  let running = false;
  let windowWaiter: (() => void) | null = null;
  let idleWaiters: Array<() => void> = [];

  // Loggers must never break the pipeline.
  const safeLog = (level: keyof OutboundLogger, message: string): void => {
    try {
      logger[level](message);
    } catch {
      // swallow
    }
  };

  // --- failure log window ---
  let failureWindowOpen = false;
  let failureSuppressed = 0;
  let lastFailure = '';
  const recordFailure = (label: string, err: unknown): void => {
    const detail = `${label}: ${describeError(err)}`;
    if (failureWindowOpen) {
      failureSuppressed += 1;
      lastFailure = detail;
      return;
    }
    failureWindowOpen = true;
    failureSuppressed = 0;
    safeLog('error', `${OUTBOUND_FAILURE_ERROR}: ${detail}`);
    const timer = setTimeout(() => {
      failureWindowOpen = false;
      const n = failureSuppressed;
      failureSuppressed = 0;
      if (n > 0) {
        safeLog(
          'error',
          `${OUTBOUND_FAILURE_ERROR}: ${n} more in the last ${OUTBOUND_WARN_INTERVAL_MS / 1000}s (last: ${lastFailure})`
        );
      }
    }, OUTBOUND_WARN_INTERVAL_MS);
    timer.unref();
  };

  // --- drop log window ---
  let dropWindowOpen = false;
  const suppressedDrops = new Map<string, number>();
  const recordDrop = (label: string): void => {
    if (dropWindowOpen) {
      suppressedDrops.set(label, (suppressedDrops.get(label) ?? 0) + 1);
      return;
    }
    dropWindowOpen = true;
    suppressedDrops.clear();
    safeLog(
      'warn',
      `${OUTBOUND_CAPACITY_WARNING} (queued ${queued}, in flight ${inFlightPackets} packets / ${inFlightBytes} bytes); dropped ${label}`
    );
    const timer = setTimeout(() => {
      dropWindowOpen = false;
      if (suppressedDrops.size > 0) {
        const entries = [...suppressedDrops.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const total = entries.reduce((sum, [, count]) => sum + count, 0);
        safeLog(
          'warn',
          `${OUTBOUND_CAPACITY_WARNING}: dropped ${total} more in the last ${OUTBOUND_WARN_INTERVAL_MS / 1000}s (${entries
            .map(([label, count]) => `${label}=${count}`)
            .join(', ')})`
        );
      }
      suppressedDrops.clear();
    }, OUTBOUND_WARN_INTERVAL_MS);
    timer.unref();
  };

  const notifyIdle = (): void => {
    if (queued !== 0 || inFlightPackets !== 0 || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const wakeSender = (): void => {
    const wake = windowWaiter;
    windowWaiter = null;
    wake?.();
  };

  const hasRoom = (bytes: number): boolean =>
    inFlightPackets < OUTBOUND_MAX_IN_FLIGHT_PACKETS &&
    (inFlightPackets === 0 || inFlightBytes + bytes <= OUTBOUND_MAX_IN_FLIGHT_BYTES);

  const waitForRoom = async (bytes: number): Promise<void> => {
    while (!hasRoom(bytes)) {
      await new Promise<void>((resolve) => {
        windowWaiter = resolve;
      });
    }
  };

  const sendPacket = (label: string, packet: OutboundPacket): void => {
    const bytes = Number.isFinite(packet.bytes) && packet.bytes > 0 ? packet.bytes : 0;
    inFlightPackets += 1;
    inFlightBytes += bytes;
    const settle = (): void => {
      inFlightPackets -= 1;
      inFlightBytes -= bytes;
      wakeSender();
      notifyIdle();
    };
    let reply: Promise<void>;
    try {
      reply = Promise.resolve(packet.send());
    } catch (err) {
      reply = Promise.reject(err);
    }
    reply.then(settle, (err: unknown) => {
      settle();
      safeRecordFailure(label, err);
    });
  };

  const safeRecordFailure = (label: string, err: unknown): void => {
    try {
      recordFailure(label, err);
    } catch {
      // logging must never break the pipeline
    }
  };

  const processJob = async (job: OutboundJob): Promise<void> => {
    let packets: readonly OutboundPacket[] = [];
    try {
      const prepared: unknown = await job.prepare();
      if (!Array.isArray(prepared)) throw new Error('prepare() did not return an array');
      packets = prepared;
    } catch (err) {
      safeRecordFailure(job.label, err);
    }
    for (const packet of packets) {
      const bytes = Number.isFinite(packet.bytes) && packet.bytes > 0 ? packet.bytes : 0;
      if (!hasRoom(bytes)) await waitForRoom(bytes);
      sendPacket(job.label, packet);
    }
  };

  const run = async (): Promise<void> => {
    running = true;
    try {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        try {
          await processJob(job);
        } catch (err) {
          safeRecordFailure(job.label, err);
        } finally {
          queued -= 1;
        }
      }
    } finally {
      running = false;
      notifyIdle();
    }
  };

  return {
    enqueue(job) {
      try {
        if (queued >= OUTBOUND_MAX_QUEUED) {
          try {
            recordDrop(job.label);
          } catch {
            // logging must never break the pipeline
          }
          return false;
        }
        queued += 1;
        jobs.push(job);
        if (!running) void run();
        return true;
      } catch {
        return false;
      }
    },
    get queued() {
      return queued;
    },
    get inFlightPackets() {
      return inFlightPackets;
    },
    get inFlightBytes() {
      return inFlightBytes;
    },
    idle() {
      if (queued === 0 && inFlightPackets === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
};
