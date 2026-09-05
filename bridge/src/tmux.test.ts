/**
 * Cache behavior for hasTmuxSession: the has-session probe is a synchronous
 * tmux subprocess run on every terminal_watch (and re-sent every ~20s by each
 * watcher), so it must be served from a short-TTL cache — both true and false
 * outcomes — rather than spawning tmux each time. Uses the injected test probe/
 * clock seams so no real tmux process is spawned.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasTmuxSession,
  invalidateTmuxSessionCache,
  __setTmuxProbeForTest,
  __resetTmuxProbeForTest,
} from './tmux.js';

afterEach(() => {
  __resetTmuxProbeForTest();
});

describe('hasTmuxSession negative/positive cache', () => {
  it('probes tmux only once for repeated calls within the TTL', () => {
    let calls = 0;
    let clock = 1000;
    __setTmuxProbeForTest({ probe: () => { calls += 1; return true; }, now: () => clock });

    assert.strictEqual(hasTmuxSession('s1'), true);
    assert.strictEqual(hasTmuxSession('s1'), true);
    clock += 1999; // still inside the 2000ms window
    assert.strictEqual(hasTmuxSession('s1'), true);
    assert.strictEqual(calls, 1);
  });

  it('caches a false result too (foreign/dead session does not re-spawn tmux)', () => {
    let calls = 0;
    let clock = 1000;
    __setTmuxProbeForTest({ probe: () => { calls += 1; return false; }, now: () => clock });

    assert.strictEqual(hasTmuxSession('gone'), false);
    assert.strictEqual(hasTmuxSession('gone'), false);
    assert.strictEqual(calls, 1);
  });

  it('re-probes after the TTL expires', () => {
    let calls = 0;
    let clock = 1000;
    __setTmuxProbeForTest({ probe: () => { calls += 1; return true; }, now: () => clock });

    assert.strictEqual(hasTmuxSession('s1'), true);
    clock += 2001; // past the 2000ms TTL
    assert.strictEqual(hasTmuxSession('s1'), true);
    assert.strictEqual(calls, 2);
  });

  it('keys the cache per sessionId', () => {
    let calls = 0;
    __setTmuxProbeForTest({ probe: () => { calls += 1; return true; }, now: () => 1000 });

    hasTmuxSession('a');
    hasTmuxSession('b');
    hasTmuxSession('a');
    assert.strictEqual(calls, 2);
  });

  it('invalidateTmuxSessionCache forces the next call to re-probe', () => {
    let calls = 0;
    __setTmuxProbeForTest({ probe: () => { calls += 1; return true; }, now: () => 1000 });

    hasTmuxSession('s1');
    invalidateTmuxSessionCache('s1');
    hasTmuxSession('s1');
    assert.strictEqual(calls, 2);
  });
});
