import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLongSelftest } from './selftest.ts';

// On the host the t values depend on host speed, so only the format and the step
// schedule (which is a pure function of the probe's fixed LCG) are compared.
test('long probe writes one JSON line per step with a fixed step schedule', async () => {
  const parse = (out: string) => out.trimEnd().split('\n').map((l) => JSON.parse(l) as { i: number; step: string; t: string });
  const logs: string[] = [];
  const a = parse(await runLongSelftest(1, (l) => logs.push(l)));
  const b = parse(await runLongSelftest(1, () => {}));
  assert.ok(a.length > 0 && b.length > 0);
  a.forEach((r, k) => {
    assert.deepEqual(Object.keys(r), ['i', 'step', 't']);
    assert.equal(r.i, k);
    assert.match(r.t, /^\d+$/);
    assert.ok(['node', 'pipe', 'timer', 'write', 'cpu', 'mem', 'console', 'idle'].includes(r.step));
    if (k > 0) assert.ok(BigInt(r.t) >= BigInt(a[k - 1].t));
  });
  const n = Math.min(a.length, b.length);
  assert.deepEqual(a.slice(0, n).map((r) => r.step), b.slice(0, n).map((r) => r.step));
  assert.ok(logs.every((l) => l.startsWith('long-probe ')));
});
