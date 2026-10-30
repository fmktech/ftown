import assert from 'node:assert/strict';
import test from 'node:test';
import { PullRequestStatusService } from './pull-request-status.js';

const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;
const pr = (state = 'SUCCESS', count = 1, oid = 'head') => ({ state: 'OPEN', merged: false, headRefOid: 'head', commits: { nodes: [{ commit: { oid, statusCheckRollup: { state, contexts: { totalCount: count } } } }] } });
const reply = (items: unknown[], rate = { cost: 1, remaining: 5000, resetAt: '2030-01-01T00:00:00Z' }) => ({ stdout: JSON.stringify({ data: { ...Object.fromEntries(items.map((item, i) => [`r${i}`, { pullRequest: item }])), rateLimit: rate } }), stderr: '', exitCode: 0 });

test('maps head checks, merged and closed without treating no checks as passed', async () => {
  let calls = 0;
  const items = [pr('PENDING'), pr('FAILURE'), pr('ERROR'), pr('EXPECTED'), pr(), pr('SUCCESS', 0), pr('SUCCESS', 1, 'old'), { state: 'CLOSED', merged: false }, { state: 'MERGED', merged: true }];
  const service = new PullRequestStatusService(() => 1_000_000, async () => { calls++; return reply(items); });
  const statuses = (await service.get(items.map((_, i) => url(i + 1)))).statuses;
  assert.deepEqual(statuses.map(s => s.state), ['in_progress', 'failed', 'failed', 'in_progress', 'passed', 'unknown', 'unknown', 'closed', 'merged']);
  assert.equal(statuses[5].reason, 'no_checks'); assert.equal(statuses[6].reason, 'unavailable');
  await service.get([url(9)]); assert.equal(calls, 1);
});

test('single flight serves each caller and deduplicates canonical URL, with minimum cadence and TTLs', async () => {
  let now = 1_000_000, calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new PullRequestStatusService(() => now, async () => { calls++; await gate; return reply([pr('PENDING')]); });
  const first = service.get([url(1)]); const second = service.get([url(2), 'https://github.com/OWNER/REPO/pull/1']);
  release(); const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.deepEqual(a.statuses.map(s => s.url), [url(1)]); assert.deepEqual(b.statuses.map(s => s.url), [url(2), url(1)]);
  await service.get([url(2)]); assert.equal(calls, 1);
  now += 60_000; await service.get([url(2)]); assert.equal(calls, 2);
  assert.equal(new Date((await service.get([url(2)])).nextRefreshAt).getTime(), now + 60_000);
});

test('caps batches and fairly rotates inaccessible items; rejects invalid URLs and GraphQL integer overflow', async () => {
  let now = 1_000_000; const queries: string[] = [];
  const service = new PullRequestStatusService(() => now, async input => { queries.push(input); return reply(Array(20).fill(null)); });
  const urls = Array.from({ length: 25 }, (_, i) => url(i + 1));
  await service.get([...urls, 'https://evil.example/x', url(2_147_483_648)]);
  assert.equal((queries[0].match(/repository\(/g) ?? []).length, 20);
  now += 60_000; await service.get(urls);
  assert.match(queries[1], /pullRequest\(number: 21\)/); assert.doesNotMatch(queries[1], /pullRequest\(number: 1\)/);
});

test('enforces rolling 60 per hour and cooldown on failures and reported rate limits', async () => {
  let now = 1_000_000, calls = 0;
  const service = new PullRequestStatusService(() => now, async () => { calls++; return reply([pr('PENDING')]); });
  for (let i = 0; i < 60; i++) { await service.get([url(i + 1)]); now += 60_000; }
  assert.equal(calls, 60); now -= 1; await service.get([url(100)]); assert.equal(calls, 60);
  now += 1; await service.get([url(100)]); assert.equal(calls, 61);
  let failures = 0; now = 10_000_000;
  const limited = new PullRequestStatusService(() => now, async () => { failures++; return { stdout: 'HTTP/2 429\r\nRetry-After: 900\r\n\r\n{}', stderr: '', exitCode: 1 }; });
  const blocked = await limited.get([url(1)]); assert.equal(blocked.statuses[0].reason, 'rate_limited'); assert.equal(Date.parse(blocked.nextRefreshAt), now + 900_000);
  now += 899_999; await limited.get([url(2)]); assert.equal(failures, 1);
  now += 1; await limited.get([url(2)]); assert.equal(failures, 2);
});

test('retains last known result stale on authentication errors and honors low remaining', async () => {
  let now = 1_000_000, calls = 0;
  const service = new PullRequestStatusService(() => now, async () => { calls++; return calls === 1 ? reply([pr()]) : { stdout: 'HTTP/2 401\r\n\r\n{}', stderr: 'private error', exitCode: 1 }; });
  await service.get([url(1)]); now += 300_000;
  const status = (await service.get([url(1)])).statuses[0];
  assert.equal(status.state, 'passed'); assert.equal(status.stale, true); assert.equal(status.reason, 'unauthenticated');
  now += 60_000; await service.get([url(2)]); assert.equal(calls, 2);
  now = 1_000_000; calls = 0; const reset = new Date(now + 600_000).toISOString();
  const low = new PullRequestStatusService(() => now, async () => { calls++; return reply([pr()], { cost: 1, remaining: 100, resetAt: reset }); });
  const snapshot = await low.get([url(1)]); assert.equal(Date.parse(snapshot.nextRefreshAt), Date.parse(reset));
  now += 300_000; await low.get([url(2)]); assert.equal(calls, 1);
});

test('open results refresh after five minutes, closed after one hour, merged never', async () => {
  let now = 1_000_000, calls = 0;
  const values = [pr(), { state: 'CLOSED', merged: false }, { state: 'MERGED', merged: true }];
  const service = new PullRequestStatusService(() => now, async () => { calls++; return reply(values); });
  await service.get([url(1), url(2), url(3)]);
  now += 299_999; await service.get([url(1)]); assert.equal(calls, 1);
  now += 1; await service.get([url(1)]); assert.equal(calls, 2);
  now += 60_000; await service.get([url(2), url(3)]); assert.equal(calls, 2);
  now = 4_600_000; await service.get([url(2)]); assert.equal(calls, 3);
  now += 10_000_000; await service.get([url(3)]); assert.equal(calls, 3);
});

test('HTTP 403 exhausted rate headers honor reset without leaking response body', async () => {
  const now = 1_000_000; let calls = 0;
  const service = new PullRequestStatusService(() => now, async () => { calls++; return { stdout: 'HTTP/2 403\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1900\r\n\r\n{"message":"secret"}', stderr: '', exitCode: 1 }; });
  const result = await service.get([url(1)]);
  assert.equal(result.statuses[0].reason, 'rate_limited'); assert.equal(Date.parse(result.nextRefreshAt), 1_900_000);
  assert.doesNotMatch(JSON.stringify(result), /secret/); await service.get([url(2)]); assert.equal(calls, 1);
});

test('partial GraphQL resolver errors preserve last known alias while healthy aliases update', async () => {
  let now = 1_000_000, calls = 0;
  const service = new PullRequestStatusService(() => now, async () => {
    calls++;
    if (calls === 1) return reply([pr(), pr()]);
    const broken = pr(); broken.commits.nodes[0].commit.statusCheckRollup = null as unknown as typeof broken.commits.nodes[0].commit.statusCheckRollup;
    return { stdout: JSON.stringify({ data: { r0: { pullRequest: broken }, r1: { pullRequest: pr('PENDING') }, rateLimit: { remaining: 5000 } },
      errors: [{ message: 'resolver failed', path: ['r0', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] }] }), stderr: 'GraphQL error', exitCode: 1 };
  });
  const previous = await service.get([url(1), url(2)]);
  now += 300_000;
  const result = await service.get([url(1), url(2)]);
  assert.equal(result.statuses[0].state, 'passed'); assert.equal(result.statuses[0].checkedAt, previous.statuses[0].checkedAt);
  assert.equal(result.statuses[0].stale, true); assert.equal(result.statuses[0].reason, 'unavailable');
  assert.equal(result.statuses[1].state, 'in_progress'); assert.equal(result.statuses[1].stale, false);
  now += 60_000; await service.get([url(1)]); assert.equal(calls, 2);
});

test('unscoped GraphQL errors conservatively preserve all aliases; rateLimit-only errors do not', async () => {
  let now = 1_000_000, call = 0;
  const service = new PullRequestStatusService(() => now, async () => {
    call++;
    if (call === 1) return reply([pr()]);
    return { ...reply([pr('FAILURE')]), exitCode: 1, stdout: JSON.stringify({ data: { r0: { pullRequest: pr('FAILURE') } }, errors: [call === 2 ? { message: 'unknown error' } : { message: 'cannot fetch quota', path: ['rateLimit'] }] }) };
  });
  await service.get([url(1)]); now += 300_000;
  let status = (await service.get([url(1)])).statuses[0]; assert.equal(status.state, 'passed'); assert.equal(status.reason, 'unavailable');
  now += 300_000; status = (await service.get([url(1)])).statuses[0]; assert.equal(status.state, 'failed'); assert.equal(status.stale, false);
});
