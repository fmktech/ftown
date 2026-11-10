import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REOFFER_MAX_BACKOFF_MS, REOFFER_MAX_RETRY_AFTER_MS, REOFFER_PAIR_WINDOW_MS, createLedgerReoffer, reofferBackoffMs,
  type LedgerPostAnswer, type LedgerReofferDeps,
} from './ledger-reoffer.js';
import type { LedgerOfferOutcome, ServerLedgerRead } from './security/bridge/security.js';

const OURS = { ledger: { chain: 'ours' }, head: 'H-ours' };
const behind = (head = 'H-server'): ServerLedgerRead => ({ kind: 'read', outcome: { decision: 'keep', relation: 'behind', head, revision: 3 } });
const same: ServerLedgerRead = { kind: 'read', outcome: { decision: 'keep', relation: 'same', head: OURS.head, revision: 5 } };
const diverged: ServerLedgerRead = { kind: 'read', outcome: { decision: 'keep', relation: 'diverged', head: 'H-other', revision: 9 } };
const answer = (status: number, body: unknown = null, retryAfterMs: number | null = null): LedgerPostAnswer => ({ status, body, retryAfterMs });
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Fake reads, posts and offers, a manual monotonic clock and manual timers. */
function harness(options: { random?: number } = {}) {
  const clock = { t: 100_000 };
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const reads: ServerLedgerRead[] = [];
  const posts: Array<{ ledger: unknown; expectHead: string; at: number }> = [];
  const replies: Array<LedgerPostAnswer | Error> = [];
  const offers: unknown[] = [];
  const offerOutcomes: LedgerOfferOutcome[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  let local: { ledger: unknown; head: string } | null = OURS;
  const deps: LedgerReofferDeps = {
    read: async () => { events.push('read'); const next = reads.length > 1 ? reads.shift()! : reads[0]; assert.ok(next, 'a read is queued'); return next; },
    local: async () => local,
    post: async (ledger, expectHead) => {
      events.push(`post:${expectHead}`);
      posts.push({ ledger, expectHead, at: clock.t });
      const next = replies.length > 1 ? replies.shift()! : replies[0];
      assert.ok(next, 'a reply is queued');
      if (next instanceof Error) throw next;
      return next;
    },
    offer: async ledger => {
      events.push('offer');
      offers.push(ledger);
      const next = offerOutcomes.length > 1 ? offerOutcomes.shift()! : offerOutcomes[0];
      return next ?? { decision: 'keep', relation: 'same', head: OURS.head, revision: 5 };
    },
    now: () => clock.t,
    random: () => options.random ?? 0.5,
    schedule: (run, ms) => {
      const timer = { at: clock.t + ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    log: line => logs.push(line),
  };
  const live = () => timers.filter(timer => !timer.cancelled).sort((a, b) => a.at - b.at);
  const fire = async () => {
    const next = live()[0];
    assert.ok(next, 'a timer is scheduled');
    next.cancelled = true;
    clock.t = Math.max(clock.t, next.at);
    next.run();
    await settle();
    return next;
  };
  return {
    reoffer: createLedgerReoffer(deps), clock, reads, posts, replies, offers, offerOutcomes, logs, events, live, fire,
    setLocal: (value: typeof local) => { local = value; },
  };
}

describe('createLedgerReoffer', () => {
  it('server behind: one POST of our chain with expectHead = the server head, always after a fresh read', async () => {
    const h = harness();
    h.reads.push(behind('H-fresh'));
    h.replies.push(answer(200, { decision: 'adopt', ledger: { chain: 'ours' } }));
    h.reoffer.noteServerBehind();
    await settle();
    assert.deepEqual(h.events, ['read', 'post:H-fresh', 'offer']);
    assert.deepEqual(h.posts.map(post => post.ledger), [OURS.ledger]);
    assert.deepEqual(h.offers, [{ chain: 'ours' }], 'the answered chain goes through the replica');
    assert.deepEqual(h.live(), [], 'success leaves no retry');
  });

  it('never POSTs when the fresh read shows the server is not behind (same, diverged, ahead) or failed to parse', async () => {
    for (const read of [same, diverged, { kind: 'read', outcome: { decision: 'adopt', relation: 'ahead', head: 'H-new', revision: 7 } } as ServerLedgerRead,
      { kind: 'read', outcome: { decision: 'reject', relation: null, head: null, revision: null } } as ServerLedgerRead]) {
      const h = harness();
      h.reads.push(read);
      h.reoffer.noteServerBehind();
      await settle();
      assert.deepEqual(h.events, ['read'], JSON.stringify(read));
      assert.deepEqual(h.live(), []);
    }
  });

  it('sends nothing when there is nothing it may send (no chain, or not active)', async () => {
    const h = harness();
    h.setLocal(null);
    h.reads.push(behind());
    h.reoffer.noteServerBehind();
    await settle();
    assert.deepEqual(h.events, ['read']);
  });

  it('one attempt at a time: triggers during an attempt are absorbed by it, and check() joins it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let posts = 0;
    const reoffer = createLedgerReoffer({
      read: async () => { reads++; await gate; return behind(); }, local: async () => OURS,
      post: async () => { posts++; return answer(200, {}); }, offer: async () => ({ decision: 'keep', relation: 'same', head: null, revision: null }),
      now: () => 0, random: () => 0.5, schedule: () => () => undefined, log: () => undefined,
    });
    reoffer.noteServerBehind();
    reoffer.noteServerBehind();
    const joined = reoffer.check();
    release();
    assert.equal(await joined, 'posted');
    await settle();
    assert.deepEqual([reads, posts], [1, 1]);
  });

  it('the same (our head, server head) pair is posted at most once per 30 s, checked after the fresh read', async () => {
    const h = harness();
    h.reads.push(behind('H1'));
    h.replies.push(answer(200, {}));
    h.reoffer.noteServerBehind();
    await settle();
    assert.equal(h.posts.length, 1);
    // The server stayed behind (e.g. another replica rolled it back again): read again, but the pair is still in its window.
    h.clock.t += REOFFER_PAIR_WINDOW_MS - 1;
    assert.equal(await h.reoffer.check(), 'skipped');
    assert.deepEqual(h.events, ['read', 'post:H1', 'read']);
    // Another server head is another pair.
    h.reads.length = 0;
    h.reads.push(behind('H2'));
    assert.equal(await h.reoffer.check(), 'posted');
    // The first pair again once its window has passed.
    h.reads.length = 0;
    h.reads.push(behind('H1'));
    h.clock.t += 1;
    assert.equal(await h.reoffer.check(), 'posted');
    assert.deepEqual(h.posts.map(post => post.expectHead), ['H1', 'H2', 'H1']);
  });

  it('backoff after failures: 30 s doubling to 10 min, at exact instants for a fixed random, each retry reading first', async () => {
    const h = harness({ random: 0.75 });
    h.reads.push(behind());
    h.replies.push(answer(503, { error: 'ledger_unavailable' }));
    h.reoffer.noteServerBehind();
    await settle();
    const start = h.clock.t;
    const gaps: number[] = [];
    let last = start;
    for (let i = 0; i < 7; i++) {
      const timer = await h.fire();
      gaps.push(timer.at - last);
      last = timer.at;
    }
    // random 0.75 -> factor 1.1.
    assert.deepEqual(gaps, [33_000, 66_000, 132_000, 264_000, 528_000, 660_000, 660_000]);
    assert.equal(h.posts.length, 8);
    assert.deepEqual(h.events.slice(0, 4), ['read', 'post:H-server', 'read', 'post:H-server']);
    assert.equal(h.logs.length, 6, 'logged once per larger step, then quiet');
  });

  it('jitter stays within plus or minus 20 % and the base never exceeds 10 min', () => {
    assert.equal(reofferBackoffMs(1, 0), 24_000);
    assert.equal(reofferBackoffMs(1, 0.999999), 36_000);
    assert.equal(reofferBackoffMs(1, 0.5), 30_000);
    assert.equal(reofferBackoffMs(2, 0.5), 60_000);
    assert.equal(reofferBackoffMs(20, 0.5), REOFFER_MAX_BACKOFF_MS);
    assert.equal(reofferBackoffMs(20, 0), REOFFER_MAX_BACKOFF_MS * 0.8);
  });

  it('a retry that comes back inside the pair window waits for the window instead of stalling', async () => {
    const h = harness({ random: 0 });
    h.reads.push(behind());
    h.replies.push(answer(503));
    h.reoffer.noteServerBehind();
    await settle();
    const first = h.posts[0].at;
    const retry = await h.fire();
    assert.equal(retry.at - first, 24_000);
    assert.equal(h.posts.length, 1, 'the pair is still in its window');
    const after = await h.fire();
    assert.equal(after.at - first, REOFFER_PAIR_WINDOW_MS);
    assert.equal(h.posts.length, 2);
  });

  it('success and a server that is no longer behind reset the backoff', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(503), answer(503), answer(200, {}));
    h.reoffer.noteServerBehind();
    await settle();
    await h.fire();
    assert.equal(h.live()[0].at - h.clock.t, 60_000);
    await h.fire();
    assert.deepEqual(h.live(), []);
    h.replies.length = 0;
    h.replies.push(answer(503));
    h.clock.t += REOFFER_PAIR_WINDOW_MS;
    assert.equal(await h.reoffer.check(), 'failed');
    assert.equal(h.live()[0].at - h.clock.t, 30_000, 'back to the first step');
    h.reads.length = 0;
    h.reads.push(same);
    await h.fire();
    assert.deepEqual(h.live(), []);
    h.reads.length = 0;
    h.reads.push(behind());
    h.clock.t += REOFFER_PAIR_WINDOW_MS;
    assert.equal(await h.reoffer.check(), 'failed');
    assert.equal(h.live()[0].at - h.clock.t, 30_000);
  });

  it('404 account_unknown stops it for good: never a POST again, never a creation', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(404, { error: 'account_unknown' }));
    h.reoffer.noteServerBehind();
    await settle();
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.live(), []);
    h.clock.t += 3_600_000;
    h.reoffer.noteServerBehind();
    assert.equal(await h.reoffer.check(), 'stopped');
    await settle();
    assert.equal(h.posts.length, 1);
    assert.equal(h.events.filter(event => event === 'read').length, 1);
    assert.equal(h.logs.length, 1);
  });

  it('no POST ever when the fresh read answers 404', async () => {
    const h = harness();
    h.reads.push({ kind: 'unknown_account', reason: 'Ledger read failed (404)' });
    h.reoffer.noteServerBehind();
    await settle();
    assert.equal(await h.reoffer.check(), 'stopped');
    h.reoffer.noteServerBehind();
    await settle();
    assert.deepEqual(h.events, ['read']);
    assert.equal(h.posts.length, 0);
  });

  it('409 head_changed: the server chain is offered, and if the server is still behind it is sent once more, then backoff', async () => {
    const h = harness();
    h.reads.push(behind('H1'));
    h.replies.push(answer(409, { error: 'head_changed', ledger: { chain: 'server-2' } }), answer(409, { error: 'head_changed', ledger: { chain: 'server-3' } }));
    h.offerOutcomes.push({ decision: 'keep', relation: 'behind', head: 'H2', revision: 4 }, { decision: 'keep', relation: 'behind', head: 'H3', revision: 4 });
    assert.equal(await h.reoffer.check(), 'failed');
    assert.deepEqual(h.events, ['read', 'post:H1', 'offer', 'post:H2', 'offer']);
    assert.deepEqual(h.offers, [{ chain: 'server-2' }, { chain: 'server-3' }]);
    assert.equal(h.live().length, 1, 'then a backoff retry');

    const moved = harness();
    moved.reads.push(behind('H1'));
    moved.replies.push(answer(409, { error: 'head_changed', ledger: { chain: 'newer' } }));
    moved.offerOutcomes.push({ decision: 'adopt', relation: 'ahead', head: 'H9', revision: 9 });
    assert.equal(await moved.reoffer.check(), 'not_behind');
    assert.deepEqual(moved.events, ['read', 'post:H1', 'offer']);
    assert.deepEqual(moved.live(), [], 'a server that is no longer behind needs nothing more');
  });

  it('409 diverged: the server chain is offered (the replica records the divergence) and nothing is re-sent before the backoff', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(409, { error: 'diverged', ledger: { chain: 'theirs' } }));
    h.offerOutcomes.push({ decision: 'keep', relation: 'diverged', head: 'H-other', revision: 9 });
    assert.equal(await h.reoffer.check(), 'failed');
    assert.deepEqual(h.offers, [{ chain: 'theirs' }]);
    assert.equal(h.posts.length, 1);
    // The retry reads first; a diverged server is not behind, so it ends there.
    h.reads.length = 0;
    h.reads.push(diverged);
    await h.fire();
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.live(), []);
  });

  it('409 ledger_rejected is logged once per local head and backs off', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(409, { error: 'ledger_rejected' }));
    assert.equal(await h.reoffer.check(), 'failed');
    await h.fire();
    await h.fire();
    assert.deepEqual(h.logs, ['[ledger] the server rejected our account history; retrying later']);
    assert.equal(h.posts.length, 3);
  });

  it('429 honours a later Retry-After (at most 1 h); a shorter one does not shorten the backoff', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(429, { error: 'rate_limited' }, 300_000));
    assert.equal(await h.reoffer.check(), 'failed');
    assert.equal(h.live()[0].at - h.clock.t, 300_000);
    assert.equal(await h.reoffer.check(), 'deferred', 'no attempt before the wait');
    assert.equal(h.posts.length, 1);

    const long = harness();
    long.reads.push(behind());
    long.replies.push(answer(429, {}, 10 * 3_600_000));
    await long.reoffer.check();
    assert.equal(long.live()[0].at - long.clock.t, REOFFER_MAX_RETRY_AFTER_MS);

    const short = harness();
    short.reads.push(behind());
    short.replies.push(answer(429, {}, 1_000));
    await short.reoffer.check();
    assert.equal(short.live()[0].at - short.clock.t, 30_000);
  });

  it('network failures of the read or the POST count as failures', async () => {
    const h = harness();
    h.reads.push({ kind: 'failed', reason: 'fetch failed' });
    assert.equal(await h.reoffer.check(), 'failed');
    assert.equal(h.posts.length, 0);
    h.reads.length = 0;
    h.reads.push(behind());
    h.replies.push(new Error('socket hang up'));
    await h.fire();
    assert.equal(h.posts.length, 1);
    assert.equal(h.live()[0].at - h.clock.t, 60_000, 'second failure in a row');
  });

  it('stop cancels the retry and nothing runs afterwards', async () => {
    const h = harness();
    h.reads.push(behind());
    h.replies.push(answer(503));
    await h.reoffer.check();
    assert.equal(h.live().length, 1);
    h.reoffer.stop();
    assert.deepEqual(h.live(), []);
    h.reoffer.noteServerBehind();
    assert.equal(await h.reoffer.check(), 'stopped');
    assert.equal(h.posts.length, 1);
  });
});
