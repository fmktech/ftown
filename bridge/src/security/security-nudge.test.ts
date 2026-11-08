import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_SAFETY_REFRESH_MS,
  SECURITY_NUDGE_MIN_SPACING_MS,
  SECURITY_NUDGE_TYPE,
  createCoalescedTrigger,
  parseSecurityNudge,
  securityNudge,
  securityNudgeChannel,
} from './security-nudge.js';

function fakeTimers() {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { at: t + ms, fn }); return id; },
      clearTimeout: (h: unknown) => { pending.delete(h as number); },
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
    pendingCount: () => pending.size,
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('constants and payload builder', () => {
  assert.equal(SECURITY_NUDGE_MIN_SPACING_MS, 1000);
  assert.equal(ACCOUNT_SAFETY_REFRESH_MS, 3600000);
  assert.deepEqual(securityNudge('account'), { type: SECURITY_NUDGE_TYPE, version: 1, scope: 'account' });
});

test('securityNudgeChannel formats and rejects empty id', () => {
  assert.equal(securityNudgeChannel('a@b.co'), 'bridges:security#a@b.co');
  assert.throws(() => securityNudgeChannel(''));
});

test('parseSecurityNudge accepts both scopes', () => {
  assert.equal(parseSecurityNudge(securityNudge('approvals')), 'approvals');
  assert.equal(parseSecurityNudge(securityNudge('account')), 'account');
  assert.equal(parseSecurityNudge(JSON.parse(JSON.stringify(securityNudge('account')))), 'account');
});

test('parseSecurityNudge rejects malformed input', () => {
  const ok = securityNudge('account');
  assert.equal(parseSecurityNudge({ ...ok, extra: 1 }), null);
  assert.equal(parseSecurityNudge({ type: ok.type, version: 1 }), null);
  assert.equal(parseSecurityNudge({ ...ok, type: 'other' }), null);
  assert.equal(parseSecurityNudge({ ...ok, version: 2 }), null);
  assert.equal(parseSecurityNudge({ ...ok, version: '1' }), null);
  assert.equal(parseSecurityNudge({ ...ok, scope: 'devices' }), null);
  assert.equal(parseSecurityNudge([ok]), null);
  assert.equal(parseSecurityNudge([]), null);
  assert.equal(parseSecurityNudge(null), null);
  assert.equal(parseSecurityNudge(undefined), null);
  assert.equal(parseSecurityNudge(JSON.stringify(ok)), null);
  assert.equal(parseSecurityNudge(5), null);
});

test('parseSecurityNudge checks prototype', () => {
  class Fake { type = 'ftown_security_changed'; version = 1; scope = 'account'; }
  assert.equal(parseSecurityNudge(new Fake()), null);
  assert.equal(parseSecurityNudge(Object.assign(Object.create(null), securityNudge('account'))), 'account');
});

test('coalesced trigger: single request runs once', async () => {
  const f = fakeTimers();
  let runs = 0;
  const trig = createCoalescedTrigger(() => { runs++; }, 1000, f.timers);
  trig.request();
  await flush();
  f.advance(5000);
  assert.equal(runs, 1);
});

test('coalesced trigger: 20 requests during a run produce one trailing run', async () => {
  const f = fakeTimers();
  let runs = 0;
  let release: () => void = () => {};
  const trig = createCoalescedTrigger(() => { runs++; return new Promise<void>(r => { release = r; }); }, 1000, f.timers);
  trig.request();
  assert.equal(runs, 1);
  for (let i = 0; i < 20; i++) trig.request();
  assert.equal(runs, 1);
  f.advance(2000);
  assert.equal(runs, 1, 'never two runs at once');
  release();
  await flush();
  assert.equal(runs, 2, 'trailing run starts after the in-flight run finishes (spacing already elapsed)');
  release();
  await flush();
  f.advance(5000);
  assert.equal(runs, 2);
});

test('coalesced trigger: run starts are spaced at least minSpacingMs apart', async () => {
  const f = fakeTimers();
  const starts: number[] = [];
  const trig = createCoalescedTrigger(() => { starts.push(f.timers.now()); }, 1000, f.timers);
  trig.request();
  trig.request();
  trig.request();
  assert.deepEqual(starts, [0]);
  f.advance(999);
  assert.deepEqual(starts, [0]);
  f.advance(1);
  assert.deepEqual(starts, [0, 1000]);
  f.advance(300);
  trig.request();
  trig.request();
  f.advance(5000);
  assert.deepEqual(starts, [0, 1000, 2000]);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000);
});

test('coalesced trigger: rejection and throw are swallowed and later requests run', async () => {
  const f = fakeTimers();
  let runs = 0;
  const trig = createCoalescedTrigger(() => {
    runs++;
    if (runs === 1) return Promise.reject(new Error('boom'));
    if (runs === 2) throw new Error('sync boom');
  }, 1000, f.timers);
  trig.request();
  await flush();
  trig.request();
  f.advance(1000);
  await flush();
  trig.request();
  f.advance(1000);
  await flush();
  assert.equal(runs, 3);
});

test('coalesced trigger: dispose stops pending and future runs', async () => {
  const f = fakeTimers();
  let runs = 0;
  const trig = createCoalescedTrigger(() => { runs++; }, 1000, f.timers);
  trig.request();
  trig.request();
  assert.equal(runs, 1);
  trig.dispose();
  assert.equal(f.pendingCount(), 0);
  f.advance(5000);
  trig.request();
  f.advance(5000);
  assert.equal(runs, 1);
});

test('coalesced trigger: dispose during a run prevents the trailing run', async () => {
  const f = fakeTimers();
  let runs = 0;
  let release: () => void = () => {};
  const trig = createCoalescedTrigger(() => { runs++; return new Promise<void>(r => { release = r; }); }, 1000, f.timers);
  trig.request();
  trig.request();
  trig.dispose();
  release();
  await flush();
  f.advance(5000);
  assert.equal(runs, 1);
});
