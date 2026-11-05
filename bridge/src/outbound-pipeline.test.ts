import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createOutboundPipeline } from './outbound-pipeline.js';
import {
  OUTBOUND_CAPACITY_WARNING,
  OUTBOUND_FAILURE_ERROR,
  OUTBOUND_MAX_IN_FLIGHT_BYTES,
  OUTBOUND_MAX_IN_FLIGHT_PACKETS,
  OUTBOUND_MAX_QUEUED,
  OUTBOUND_WARN_INTERVAL_MS,
  describeError,
  type OutboundJob,
  type OutboundLogger,
  type OutboundPacket,
} from './outbound-pipeline-types.js';

const MIB = 1024 * 1024;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask chain run to completion (setImmediate is never mocked here). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface FakePacket {
  readonly id: string;
  readonly packet: OutboundPacket;
  readonly reply: Deferred<void>;
}

function makePacket(id: string, bytes: number, sent: string[]): FakePacket {
  const reply = deferred<void>();
  return {
    id,
    reply,
    packet: {
      bytes,
      send: () => {
        sent.push(id);
        return reply.promise;
      },
    },
  };
}

function makeJob(label: string, packets: readonly FakePacket[], events?: string[]): OutboundJob {
  return {
    label,
    prepare: async () => {
      events?.push(`prepare:${label}`);
      return packets.map((p) => p.packet);
    },
  };
}

function makeLogger(): OutboundLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return { warns, errors, warn: (m) => void warns.push(m), error: (m) => void errors.push(m) };
}

afterEach(() => {
  mock.timers.reset();
});

describe('outbound pipeline', () => {
  it('O1: sends packets in strict FIFO order across jobs even when replies resolve out of order', async () => {
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    const all: FakePacket[] = [];
    const expected: string[] = [];
    for (let j = 0; j < 5; j += 1) {
      const packets = [0, 1, 2].map((p) => makePacket(`j${j}p${p}`, 10, sent));
      all.push(...packets);
      expected.push(...packets.map((p) => p.id));
      assert.equal(pipeline.enqueue(makeJob(`job${j}`, packets)), true);
    }
    await settle();
    assert.deepEqual(sent, expected);
    // Resolve replies in reverse order; nothing more may be sent and nothing reordered.
    for (const p of [...all].reverse()) p.reply.resolve();
    await pipeline.idle();
    assert.deepEqual(sent, expected);
    assert.equal(pipeline.inFlightPackets, 0);
    assert.equal(pipeline.inFlightBytes, 0);
    assert.equal(pipeline.queued, 0);
  });

  it('O2: pipelines up to the packet window without awaiting replies, and releases one per settled reply', async () => {
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    const total = OUTBOUND_MAX_IN_FLIGHT_PACKETS + 6;
    const packets = Array.from({ length: total }, (_, i) => makePacket(`p${i}`, 1, sent));
    pipeline.enqueue(makeJob('many', packets));
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS);
    assert.equal(pipeline.inFlightPackets, OUTBOUND_MAX_IN_FLIGHT_PACKETS);
    assert.equal(pipeline.queued, 1);

    packets[0].reply.resolve();
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS + 1);
    assert.equal(sent[sent.length - 1], `p${OUTBOUND_MAX_IN_FLIGHT_PACKETS}`);
    assert.equal(pipeline.inFlightPackets, OUTBOUND_MAX_IN_FLIGHT_PACKETS);
  });

  it('O2: byte window allows two 1 MiB packets in flight and sends an oversized packet alone', async () => {
    assert.equal(OUTBOUND_MAX_IN_FLIGHT_BYTES, 2 * MIB);
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    const a = makePacket('a', MIB, sent);
    const b = makePacket('b', MIB, sent);
    const c = makePacket('c', MIB, sent);
    const big = makePacket('big', 3 * MIB, sent);
    const after = makePacket('after', 1, sent);
    pipeline.enqueue(makeJob('job', [a, b, c, big, after]));
    await settle();
    assert.deepEqual(sent, ['a', 'b']);
    assert.equal(pipeline.inFlightBytes, 2 * MIB);

    a.reply.resolve();
    await settle();
    assert.deepEqual(sent, ['a', 'b', 'c']);
    assert.equal(pipeline.inFlightBytes, 2 * MIB);

    b.reply.resolve();
    c.reply.resolve();
    await settle();
    assert.deepEqual(sent, ['a', 'b', 'c', 'big']);
    assert.equal(pipeline.inFlightPackets, 1);
    assert.equal(pipeline.inFlightBytes, 3 * MIB);

    big.reply.resolve();
    await settle();
    assert.deepEqual(sent, ['a', 'b', 'c', 'big', 'after']);
    after.reply.resolve();
    await pipeline.idle();
  });

  it('O1: does not call prepare() of the next job before every packet of the previous job was sent', async () => {
    const sent: string[] = [];
    const events: string[] = [];
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    const packets = Array.from({ length: OUTBOUND_MAX_IN_FLIGHT_PACKETS + 1 }, (_, i) => makePacket(`a${i}`, 1, sent));
    const second = makePacket('b0', 1, sent);
    pipeline.enqueue(makeJob('first', packets, events));
    pipeline.enqueue(makeJob('second', [second], events));
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS);
    assert.deepEqual(events, ['prepare:first']);

    packets[0].reply.resolve();
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS + 1);
    assert.equal(sent[sent.length - 1], `a${OUTBOUND_MAX_IN_FLIGHT_PACKETS}`);
    assert.deepEqual(events, ['prepare:first', 'prepare:second']);

    packets[1].reply.resolve();
    await settle();
    assert.equal(sent[sent.length - 1], 'b0');
  });

  it('O4: logs a prepare() rejection once with label and description, and still sends the next job', async () => {
    const logger = makeLogger();
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger });
    const err = Object.assign(new Error('seal exploded'), { code: 'E_SEAL' });
    pipeline.enqueue({ label: 'terminal/output', prepare: () => Promise.reject(err) });
    const ok = makePacket('ok', 5, sent);
    pipeline.enqueue(makeJob('next', [ok]));
    await settle();
    assert.deepEqual(sent, ['ok']);
    assert.deepEqual(logger.errors, [`${OUTBOUND_FAILURE_ERROR}: terminal/output: ${describeError(err)}`]);
    assert.equal(pipeline.queued, 0);
    ok.reply.resolve();
    await pipeline.idle();
  });

  it('O3/O4: send() rejection and synchronous throw only affect their packet; counters recover', async () => {
    const logger = makeLogger();
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger });
    const rejecting = makePacket('rej', 100, sent);
    const throwing: FakePacket = {
      id: 'throw',
      reply: deferred<void>(),
      packet: {
        bytes: 50,
        send: () => {
          sent.push('throw');
          throw new Error('sync boom');
        },
      },
    };
    const good = makePacket('good', 10, sent);
    pipeline.enqueue(makeJob('mixed', [rejecting, throwing, good]));
    const later = makePacket('later', 7, sent);
    pipeline.enqueue(makeJob('later', [later]));
    await settle();
    assert.deepEqual(sent, ['rej', 'throw', 'good', 'later']);
    // Sync throw already released its slot; rej, good and later are still pending.
    assert.equal(pipeline.inFlightPackets, 3);
    assert.equal(pipeline.inFlightBytes, 117);

    rejecting.reply.reject(new Error('reply failed'));
    await settle();
    assert.equal(pipeline.inFlightPackets, 2);
    assert.equal(pipeline.inFlightBytes, 17);
    good.reply.resolve();
    later.reply.resolve();
    await pipeline.idle();
    assert.equal(pipeline.inFlightPackets, 0);
    assert.equal(pipeline.inFlightBytes, 0);
    assert.equal(logger.errors.length, 1, 'second failure in the window is only counted');
    assert.match(logger.errors[0], new RegExp(`^${escapeRegExp(OUTBOUND_FAILURE_ERROR)}: mixed: `));
  });

  it('O3: a rejected reply on a full window frees a slot for the next packet', async () => {
    const sent: string[] = [];
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    const packets = Array.from({ length: OUTBOUND_MAX_IN_FLIGHT_PACKETS + 1 }, (_, i) => makePacket(`p${i}`, 1, sent));
    pipeline.enqueue(makeJob('full', packets));
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS);
    packets[3].reply.reject(new Error('nope'));
    await settle();
    assert.equal(sent.length, OUTBOUND_MAX_IN_FLIGHT_PACKETS + 1);
  });

  it('O5: drops at the queue cap with an immediate warn, then one summary per window', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const logger = makeLogger();
    const pipeline = createOutboundPipeline({ logger });
    const block = deferred<readonly OutboundPacket[]>();
    const blocked: OutboundJob = { label: 'blocked', prepare: () => block.promise };
    assert.equal(pipeline.enqueue(blocked), true);
    for (let i = 1; i < OUTBOUND_MAX_QUEUED; i += 1) {
      assert.equal(pipeline.enqueue({ label: `q${i}`, prepare: async () => [] }), true);
    }
    assert.equal(pipeline.queued, OUTBOUND_MAX_QUEUED);

    const noop: OutboundJob = { label: 'first', prepare: async () => [] };
    assert.equal(pipeline.enqueue(noop), false);
    assert.equal(pipeline.queued, OUTBOUND_MAX_QUEUED);
    assert.deepEqual(logger.warns, [
      `${OUTBOUND_CAPACITY_WARNING} (queued ${OUTBOUND_MAX_QUEUED}, in flight 0 packets / 0 bytes); dropped first`,
    ]);

    for (const label of ['a', 'a', 'b']) {
      assert.equal(pipeline.enqueue({ label, prepare: async () => [] }), false);
    }
    assert.equal(logger.warns.length, 1);

    mock.timers.tick(OUTBOUND_WARN_INTERVAL_MS);
    assert.equal(logger.warns.length, 2);
    assert.equal(logger.warns[1], `${OUTBOUND_CAPACITY_WARNING}: dropped 3 more in the last 5s (a=2, b=1)`);

    // Window over: the next drop logs immediately again and starts a new window.
    assert.equal(pipeline.enqueue({ label: 'c', prepare: async () => [] }), false);
    assert.equal(logger.warns.length, 3);
    assert.equal(
      logger.warns[2],
      `${OUTBOUND_CAPACITY_WARNING} (queued ${OUTBOUND_MAX_QUEUED}, in flight 0 packets / 0 bytes); dropped c`,
    );
    mock.timers.tick(OUTBOUND_WARN_INTERVAL_MS);
    assert.equal(logger.warns.length, 3, 'no suppressed drops, so no summary');

    block.resolve([]);
    await pipeline.idle();
    assert.equal(pipeline.queued, 0);
  });

  it('O5: drop summary sorts by count descending, then label ascending', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const logger = makeLogger();
    const pipeline = createOutboundPipeline({ logger });
    const block = deferred<readonly OutboundPacket[]>();
    pipeline.enqueue({ label: 'blocked', prepare: () => block.promise });
    for (let i = 1; i < OUTBOUND_MAX_QUEUED; i += 1) pipeline.enqueue({ label: 'fill', prepare: async () => [] });
    for (const label of ['z', 'b', 'a', 'z', 'b', 'c', 'z']) {
      pipeline.enqueue({ label, prepare: async () => [] });
    }
    // First drop ('z') logged immediately; the remaining six are suppressed.
    mock.timers.tick(OUTBOUND_WARN_INTERVAL_MS);
    assert.equal(logger.warns.length, 2);
    assert.equal(logger.warns[1], `${OUTBOUND_CAPACITY_WARNING}: dropped 6 more in the last 5s (b=2, z=2, a=1, c=1)`);
    block.resolve([]);
    await pipeline.idle();
  });

  it('O4: failure summary after the timer, with independent windows and a fresh window afterwards', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const logger = makeLogger();
    const pipeline = createOutboundPipeline({ logger });
    const failing = (label: string, message: string): OutboundJob => ({
      label,
      prepare: () => Promise.reject(Object.assign(new Error(message), { code: 42 })),
    });
    pipeline.enqueue(failing('l1', 'm1'));
    pipeline.enqueue(failing('l2', 'm2'));
    pipeline.enqueue(failing('l3', 'm3'));
    await settle();
    assert.deepEqual(logger.errors, [`${OUTBOUND_FAILURE_ERROR}: l1: 42: m1`]);

    mock.timers.tick(OUTBOUND_WARN_INTERVAL_MS);
    assert.equal(logger.errors.length, 2);
    assert.equal(
      logger.errors[1],
      `${OUTBOUND_FAILURE_ERROR}: 2 more in the last ${OUTBOUND_WARN_INTERVAL_MS / 1000}s (last: l3: 42: m3)`,
    );
    assert.equal(logger.warns.length, 0, 'failures never go to the warn channel');

    pipeline.enqueue(failing('l4', 'm4'));
    await settle();
    assert.equal(logger.errors.length, 3);
    assert.equal(logger.errors[2], `${OUTBOUND_FAILURE_ERROR}: l4: 42: m4`);
  });

  it('O8: idle() resolves only after the last reply settles, and immediately when already idle', async () => {
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    await pipeline.idle();

    const sent: string[] = [];
    const p = makePacket('p', 1, sent);
    pipeline.enqueue(makeJob('job', [p]));
    let first = false;
    let second = false;
    const idle1 = pipeline.idle().then(() => {
      first = true;
    });
    const idle2 = pipeline.idle().then(() => {
      second = true;
    });
    await settle();
    assert.deepEqual(sent, ['p']);
    assert.equal(pipeline.queued, 0);
    assert.equal(pipeline.inFlightPackets, 1);
    assert.equal(first || second, false);

    p.reply.resolve();
    await Promise.all([idle1, idle2]);
    assert.equal(first && second, true);
    await pipeline.idle();
  });

  it('O9: a throwing logger never breaks enqueue or the pipeline', async () => {
    const throwingLogger: OutboundLogger = {
      warn: () => {
        throw new Error('warn broke');
      },
      error: () => {
        throw new Error('error broke');
      },
    };
    const pipeline = createOutboundPipeline({ logger: throwingLogger });
    const block = deferred<readonly OutboundPacket[]>();
    pipeline.enqueue({ label: 'blocked', prepare: () => block.promise });
    for (let i = 1; i < OUTBOUND_MAX_QUEUED; i += 1) pipeline.enqueue({ label: 'x', prepare: async () => [] });
    assert.doesNotThrow(() => {
      assert.equal(pipeline.enqueue({ label: 'dropped', prepare: async () => [] }), false);
    });

    block.resolve([]);
    await pipeline.idle();
    pipeline.enqueue({ label: 'bad', prepare: () => Promise.reject(new Error('x')) });
    const sent: string[] = [];
    const ok = makePacket('ok', 1, sent);
    pipeline.enqueue(makeJob('good', [ok]));
    await settle();
    assert.deepEqual(sent, ['ok']);
    ok.reply.resolve();
    await pipeline.idle();
  });

  it('O6: a job with zero packets leaves the queue once prepare settles', async () => {
    const pipeline = createOutboundPipeline({ logger: makeLogger() });
    pipeline.enqueue(makeJob('empty', []));
    assert.equal(pipeline.queued, 1);
    await settle();
    assert.equal(pipeline.queued, 0);
    assert.equal(pipeline.inFlightPackets, 0);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
