import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePullRequestUrl } from './pull-request-url.js';

test('canonicalizes GitHub PR URLs without fetching their destination', () => {
  assert.equal(normalizePullRequestUrl(' https://github.com/FmKTech/ftown/pull/128/?tab=files#discussion '), 'https://github.com/FmKTech/ftown/pull/128');
  assert.equal(normalizePullRequestUrl('https://GITHUB.COM:443/owner/repo.name_1/pull/0007'), 'https://github.com/owner/repo.name_1/pull/7');
  assert.equal(normalizePullRequestUrl('https://github.com/owner/repo/pull/9007199254740991'), 'https://github.com/owner/repo/pull/9007199254740991');
});

test('rejects unsafe origins, invalid PR paths and ambiguous encoded or normalized paths', () => {
  for (const value of [
    '', '   ', 'http://github.com/owner/repo/pull/1', 'javascript:alert(1)',
    'https://example.com/owner/repo/pull/1', 'https://github.com.evil.test/owner/repo/pull/1',
    'https://user:password@github.com/owner/repo/pull/1', 'https://github.com:444/owner/repo/pull/1',
    'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/1/files',
    'https://github.com/owner/repo/pull/0', 'https://github.com/owner/repo/pull/-1',
    'https://github.com/owner/repo/pull/1e3', 'https://github.com/owner/repo/pull/9007199254740992',
    'https://github.com/-owner/repo/pull/1', 'https://github.com/owner-/repo/pull/1',
    'https://github.com/owner/repo%2fname/pull/1', 'https://github.com/owner/repo%5cname/pull/1',
    'https://github.com/owner/repo%00/pull/1', 'https://github.com/owner/other/../repo/pull/1',
    'https://github.com/owner/repo\\pull\\1', 'https://github.com/owner/repo/pull/1\n',
    'https://github.com/owner/repo/pull/1?' + 'x'.repeat(2048),
  ]) assert.throws(() => normalizePullRequestUrl(value), /Invalid pullRequestUrl/, value);
  assert.throws(() => normalizePullRequestUrl(42 as unknown as string), /Invalid pullRequestUrl/);
});
