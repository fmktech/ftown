/**
 * Contract-level tests for WatchRegistry (docs/plans/direct-transport-contract.md, R2/R3).
 * Written against bridge/src/direct-transport/contract.ts (frozen) before the
 * implementation lands — expect module-not-found failures until watch-registry.ts exists.
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { WatchRegistry } from './watch-registry.js';
import { WATCH_TTL_MS } from './contract.js';

// WatchRegistry's constructor takes an options object: `{ now?, ttlMs?, sweepIntervalMs? }`.

// Drive both the injected clock and real timers in lockstep so the test is agnostic
// to whether the implementation polls via setInterval + now(), or schedules a
// setTimeout per watcher using the injected clock.
function makeClock() {
  let current = 0;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
      mock.timers.tick(ms);
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
});

describe('WatchRegistry', () => {
  it('hasWatchers is false for a session that was never watched', () => {
    const registry = new WatchRegistry();
    assert.strictEqual(registry.hasWatchers('sess-none'), false);
    registry.dispose();
  });

  it('watch() adds a watcher and hasWatchers becomes true', () => {
    const registry = new WatchRegistry();
    registry.watch('sess-1', 'client-a');
    assert.strictEqual(registry.hasWatchers('sess-1'), true);
    registry.dispose();
  });

  it('onFirstWatcher fires exactly once for the 0->1 transition, not for subsequent watchers on the same session', () => {
    const registry = new WatchRegistry();
    const seen: string[] = [];
    registry.onFirstWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    registry.watch('sess-1', 'client-b');
    registry.watch('sess-1', 'client-a'); // heartbeat re-watch, same client

    assert.deepStrictEqual(seen, ['sess-1']);
    registry.dispose();
  });

  it('onFirstWatcher is scoped per session', () => {
    const registry = new WatchRegistry();
    const seen: string[] = [];
    registry.onFirstWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    registry.watch('sess-2', 'client-b');

    assert.deepStrictEqual(seen.sort(), ['sess-1', 'sess-2']);
    registry.dispose();
  });

  it('unwatch() removes the sole watcher and hasWatchers becomes false', () => {
    const registry = new WatchRegistry();
    registry.watch('sess-1', 'client-a');
    registry.unwatch('sess-1', 'client-a');
    assert.strictEqual(registry.hasWatchers('sess-1'), false);
    registry.dispose();
  });

  it('unwatch() of one client leaves other watchers on the same session intact', () => {
    const registry = new WatchRegistry();
    registry.watch('sess-1', 'client-a');
    registry.watch('sess-1', 'client-b');
    registry.unwatch('sess-1', 'client-a');
    assert.strictEqual(registry.hasWatchers('sess-1'), true);
    registry.dispose();
  });

  it('unwatch() of an unknown client/session is a no-op, not a throw', () => {
    const registry = new WatchRegistry();
    assert.doesNotThrow(() => registry.unwatch('sess-missing', 'client-x'));
    registry.dispose();
  });

  it('a watcher expires after WATCH_TTL_MS with no heartbeat', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    registry.watch('sess-1', 'client-a');
    assert.strictEqual(registry.hasWatchers('sess-1'), true);

    clock.advance(WATCH_TTL_MS + 1_000);

    assert.strictEqual(registry.hasWatchers('sess-1'), false);
    registry.dispose();
  });

  it('re-watching before expiry (heartbeat) refreshes the TTL', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    registry.watch('sess-1', 'client-a');

    clock.advance(WATCH_TTL_MS - 5_000);
    registry.watch('sess-1', 'client-a'); // heartbeat refresh
    clock.advance(WATCH_TTL_MS - 5_000); // would have expired w/o the refresh above

    assert.strictEqual(registry.hasWatchers('sess-1'), true);
    registry.dispose();
  });

  it('onFirstWatcher fires again after an expiry -> re-watch cycle (0->1 transition twice)', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    const seen: string[] = [];
    registry.onFirstWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    clock.advance(WATCH_TTL_MS + 1_000);
    assert.strictEqual(registry.hasWatchers('sess-1'), false);

    registry.watch('sess-1', 'client-a');

    assert.deepStrictEqual(seen, ['sess-1', 'sess-1']);
    registry.dispose();
  });

  // onNewWatcher spec: fires whenever a clientId registers that was not already a
  // live watcher for that session — first watcher, each additional distinct client,
  // and re-registration after TTL expiry. NOT on heartbeat refresh of a live watcher.
  it('onNewWatcher fires for the first watcher of a session', () => {
    const registry = new WatchRegistry();
    const seen: string[] = [];
    registry.onNewWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');

    assert.deepStrictEqual(seen, ['sess-1']);
    registry.dispose();
  });

  it('onNewWatcher fires for each additional distinct client on the same session', () => {
    const registry = new WatchRegistry();
    const seen: string[] = [];
    registry.onNewWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    registry.watch('sess-1', 'client-b');
    registry.watch('sess-1', 'client-c');

    assert.deepStrictEqual(seen, ['sess-1', 'sess-1', 'sess-1']);
    registry.dispose();
  });

  it('onNewWatcher does NOT fire on a heartbeat refresh of a live watcher', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    const seen: string[] = [];
    registry.onNewWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    clock.advance(WATCH_TTL_MS / 2);
    registry.watch('sess-1', 'client-a'); // heartbeat: still live

    assert.deepStrictEqual(seen, ['sess-1']);
    registry.dispose();
  });

  it('onNewWatcher fires again when the same client re-registers after TTL expiry', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    const seen: string[] = [];
    registry.onNewWatcher((sessionId) => seen.push(sessionId));

    registry.watch('sess-1', 'client-a');
    clock.advance(WATCH_TTL_MS + 1_000);
    registry.watch('sess-1', 'client-a'); // expired -> counts as new again

    assert.deepStrictEqual(seen, ['sess-1', 'sess-1']);
    registry.dispose();
  });

  it('onNewWatcher and onFirstWatcher coexist: additional distinct clients fire onNewWatcher only', () => {
    const registry = new WatchRegistry();
    const firsts: string[] = [];
    const news: string[] = [];
    registry.onFirstWatcher((sessionId) => firsts.push(sessionId));
    registry.onNewWatcher((sessionId) => news.push(sessionId));

    registry.watch('sess-1', 'client-a');
    registry.watch('sess-1', 'client-b');

    assert.deepStrictEqual(firsts, ['sess-1']);
    assert.deepStrictEqual(news, ['sess-1', 'sess-1']);
    registry.dispose();
  });

  it('dispose() stops background timers so further clock advances do not throw or fire callbacks', () => {
    const clock = makeClock();
    const registry = new WatchRegistry({ now: clock.now });
    const seen: string[] = [];
    registry.onFirstWatcher((sessionId) => seen.push(sessionId));
    registry.watch('sess-1', 'client-a');

    registry.dispose();
    assert.doesNotThrow(() => clock.advance(WATCH_TTL_MS * 3));
    assert.deepStrictEqual(seen, ['sess-1']);
  });
});
