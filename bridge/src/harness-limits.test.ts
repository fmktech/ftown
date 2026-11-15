import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLimit, parseResetAt } from './harness-limits.js';

const NOW = new Date(2026, 0, 2, 8, 0, 0);

function at(hour: number, minute = 0): string {
  return new Date(2026, 0, 2, hour, minute, 0, 0).toISOString();
}

test('muse usage limit parses a clock reset on the same screen', () => {
  const hit = detectLimit('muse', 'working\nUsage limit reached\nresets at 9:00 PM\n', NOW);
  assert.equal(hit?.reason, 'usage_limit');
  assert.equal(hit?.resetAt, at(21));
  assert.match(hit?.line ?? '', /Usage limit reached/);
});

test('muse rate limit and auth screens', () => {
  const rate = detectLimit('muse', 'rate limited — try again in 5m', NOW);
  assert.equal(rate?.reason, 'rate_limit');
  assert.equal(rate?.resetAt, new Date(NOW.getTime() + 5 * 60_000).toISOString());
  const retryAfter = detectLimit('muse', 'rate limited (retry after 30s)', NOW);
  assert.equal(retryAfter?.reason, 'rate_limit');
  assert.equal(retryAfter?.resetAt, new Date(NOW.getTime() + 30_000).toISOString());
  assert.equal(detectLimit('muse', 'not logged in: run `muse login` first')?.reason, 'auth');
  assert.equal(detectLimit('muse', 'Not logged in — run /login')?.reason, 'auth');
});

test('claude usage, rate, and auth screens', () => {
  assert.equal(detectLimit('claude', 'Usage limit reached')?.reason, 'usage_limit');
  assert.equal(detectLimit('claude', 'rate limit exceeded')?.reason, 'rate_limit');
  assert.equal(detectLimit('claude', 'Please run /login')?.reason, 'auth');
  assert.equal(detectLimit('claude', 'Not logged in. Run claude auth login to authenticate.')?.reason, 'auth');
  assert.equal(detectLimit('claude', 'Login expired')?.reason, 'auth');
  assert.equal(detectLimit('claude', 'token has expired')?.reason, 'auth');
});

test('codex usage sentence, apostrophes, and billing quota', () => {
  assert.equal(detectLimit('codex', "You've hit your usage limit.")?.reason, 'usage_limit');
  assert.equal(detectLimit('codex', 'You’ve hit your usage limit.')?.reason, 'usage_limit');
  assert.equal(detectLimit('codex', 'Usage limit reached')?.reason, 'usage_limit');
  assert.equal(detectLimit('codex', 'rate limit reached')?.reason, 'rate_limit');
  assert.equal(detectLimit('codex', 'Not logged in')?.reason, 'auth');
  assert.equal(detectLimit('codex', 'token has expired. Please log out and sign in again.')?.reason, 'auth');
  assert.equal(detectLimit('codex', 'Quota exceeded. Check your plan and billing details.')?.reason, 'usage_limit');
  assert.equal(detectLimit('codex', 'Quota exceededFile too large'), undefined);
  assert.equal(detectLimit('codex', 'Quota exceeded'), undefined);
});

test('grok usage, rate, and auth screens', () => {
  assert.equal(detectLimit('grok', 'usage limit reached')?.reason, 'usage_limit');
  assert.equal(detectLimit('grok', 'rate limit exceeded')?.reason, 'rate_limit');
  assert.equal(detectLimit('grok', 'Not logged in. Run `grok login`.')?.reason, 'auth');
  assert.equal(detectLimit('grok', 'Token expired. Run `grok login` to re-authenticate')?.reason, 'auth');
  assert.equal(detectLimit('grok', 'Unauthorized (401)')?.reason, 'auth');
});

test('opencode usage, rate, resource exhausted, and auth screens', () => {
  const paused = detectLimit('opencode', 'usage limit reached. Model use is paused until the limit resets.');
  assert.equal(paused?.reason, 'usage_limit');
  assert.equal(detectLimit('opencode', 'Rate limit exceeded\nRetry after 2026-11-15T21:00:00Z', NOW)?.reason, 'rate_limit');
  assert.equal(detectLimit('opencode', 'Rate limit exceeded\nRetry after 2026-11-15T21:00:00Z', NOW)?.resetAt, '2026-11-15T21:00:00.000Z');
  assert.equal(detectLimit('opencode', 'RESOURCE_EXHAUSTED')?.reason, 'rate_limit');
  assert.equal(detectLimit('opencode', 'not logged in')?.reason, 'auth');
  assert.equal(detectLimit('opencode', 'Please run /login')?.reason, 'auth');
  assert.equal(detectLimit('opencode', 'Sign in required')?.reason, 'auth');
  assert.equal(detectLimit('opencode', 'token has expired and no refresh token is available')?.reason, 'auth');
});

test('antigravity and agy share one detector', () => {
  assert.equal(detectLimit('antigravity', 'Usage limit reached')?.reason, 'usage_limit');
  assert.equal(detectLimit('agy', 'Usage limit reached')?.reason, 'usage_limit');
  const retry = detectLimit('agy', 'rate limit exceeded on models; retry in 30s', NOW);
  assert.equal(retry?.reason, 'rate_limit');
  assert.equal(retry?.resetAt, new Date(NOW.getTime() + 30_000).toISOString());
  assert.equal(detectLimit('antigravity', 'quota exceeded, try again later')?.reason, 'rate_limit');
  assert.equal(detectLimit('antigravity', 'RESOURCE_EXHAUSTED')?.reason, 'rate_limit');
  assert.equal(detectLimit('antigravity', 'Sign in required')?.reason, 'auth');
  assert.equal(detectLimit('antigravity', 'not logged in')?.reason, 'auth');
  assert.equal(detectLimit('antigravity', 'cannot sign in')?.reason, 'auth');
});

test('cursor auth strings and limit phrases, not a storage quota', () => {
  assert.equal(detectLimit('cursor', 'Authentication required')?.reason, 'auth');
  assert.equal(detectLimit('cursor', 'Sign in required')?.reason, 'auth');
  assert.equal(detectLimit('cursor', 'usage limit reached')?.reason, 'usage_limit');
  assert.equal(detectLimit('cursor', 'rate limit exceeded')?.reason, 'rate_limit');
  assert.equal(detectLimit('cursor', 'storage quota is full'), undefined);
  assert.equal(detectLimit('cursor', 'quota_exceeded'), undefined);
});

test('resource exhausted is only a rate limit for opencode and antigravity', () => {
  assert.equal(detectLimit('claude', 'RESOURCE_EXHAUSTED'), undefined);
  assert.equal(detectLimit('muse', 'RESOURCE_EXHAUSTED'), undefined);
  assert.equal(detectLimit('codex', 'RESOURCE_EXHAUSTED'), undefined);
  assert.equal(detectLimit('grok', 'RESOURCE_EXHAUSTED'), undefined);
});

test('a long line is not a limit screen', () => {
  const padded = `${'x'.repeat(280)} usage limit reached`;
  assert.equal(detectLimit('muse', padded), undefined);
});

test('usage limit wins over a rate line, and the later usage line wins a tie', () => {
  const hit = detectLimit('claude', 'rate limit exceeded\nUsage limit reached\nresets 9pm', NOW);
  assert.equal(hit?.reason, 'usage_limit');
  assert.equal(hit?.resetAt, at(21));
});

test('ansi around a limit line still matches', () => {
  const hit = detectLimit('muse', '\x1b[31mUsage limit reached\x1b[0m\nresets at 21:00', NOW);
  assert.equal(hit?.reason, 'usage_limit');
  assert.equal(hit?.resetAt, at(21));
});

test('a clock that has already passed is tomorrow', () => {
  const evening = new Date(2026, 0, 2, 22, 0, 0);
  const reset = parseResetAt('resets at 9:00 PM', evening);
  assert.equal(reset, new Date(2026, 0, 3, 21, 0, 0, 0).toISOString());
});

test('an unknown harness is not classified from the screen', () => {
  assert.equal(detectLimit('shell', 'Usage limit reached'), undefined);
  assert.equal(detectLimit(undefined, 'Usage limit reached'), undefined);
});
