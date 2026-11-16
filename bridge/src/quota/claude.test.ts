import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeNotSignedInMessage,
  fetchClaudeQuota,
  loadClaudeCredentials,
  parseClaudeCredentials,
  parseClaudeUsageResponse,
  resolveClaudeCredentialSources,
  safeReason,
} from './claude.js';
import type { QuotaWindow } from './types.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';

function findWindow(windows: readonly QuotaWindow[], kind: QuotaWindow['kind']): QuotaWindow | undefined {
  return windows.find((w) => w.kind === kind);
}

describe('parseClaudeUsageResponse', () => {
  it('maps a populated body with both windows', () => {
    const quota = parseClaudeUsageResponse(
      {
        five_hour: { utilization: 42.5, resets_at: '2026-11-13T12:00:00.000+00:00' },
        seven_day: { utilization: 3, resets_at: '2026-11-20T01:00:00.000000+00:00' },
        extra_usage: { anything: true },
      },
      'max',
      OBSERVED,
    );

    assert.equal(quota.provider, 'claude');
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'max');
    assert.equal(quota.source, 'live');
    assert.equal(quota.observedAt, OBSERVED);
    assert.equal(quota.message, null);
    assert.equal(quota.windows.length, 2);

    const fiveHour = findWindow(quota.windows, 'five_hour');
    assert.deepEqual(fiveHour, {
      kind: 'five_hour',
      usedPercent: 42.5,
      resetsAt: '2026-11-13T12:00:00.000Z',
      windowMinutes: 300,
      note: null,
    });

    const weekly = findWindow(quota.windows, 'weekly');
    assert.deepEqual(weekly, {
      kind: 'weekly',
      usedPercent: 3,
      resetsAt: '2026-11-20T01:00:00.000Z',
      windowMinutes: 10080,
      note: null,
    });
  });

  it('emits a five_hour placeholder with a note when five_hour is null', () => {
    const quota = parseClaudeUsageResponse(
      {
        five_hour: null,
        seven_day: { utilization: 10, resets_at: '2026-11-20T01:00:00.043805+00:00' },
      },
      'pro',
      OBSERVED,
    );

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows.length, 2);
    assert.deepEqual(findWindow(quota.windows, 'five_hour'), {
      kind: 'five_hour',
      usedPercent: null,
      resetsAt: null,
      windowMinutes: 300,
      note: 'not reported',
    });
    assert.equal(findWindow(quota.windows, 'weekly')?.usedPercent, 10);
  });

  it('omits the weekly window when seven_day is absent', () => {
    const quota = parseClaudeUsageResponse(
      { five_hour: { utilization: 7, resets_at: '2026-11-13T12:00:00Z' } },
      'max',
      OBSERVED,
    );

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows.length, 1);
    assert.equal(findWindow(quota.windows, 'weekly'), undefined);
    assert.equal(findWindow(quota.windows, 'five_hour')?.usedPercent, 7);
  });

  it('reports null usedPercent for a non-numeric utilization', () => {
    const quota = parseClaudeUsageResponse(
      {
        five_hour: { utilization: '55', resets_at: '2026-11-13T12:00:00Z' },
        seven_day: { utilization: null, resets_at: '2026-11-20T01:00:00Z' },
      },
      'max',
      OBSERVED,
    );

    assert.equal(findWindow(quota.windows, 'five_hour')?.usedPercent, null);
    assert.equal(findWindow(quota.windows, 'weekly')?.usedPercent, null);
    assert.equal(findWindow(quota.windows, 'weekly')?.resetsAt, '2026-11-20T01:00:00.000Z');
    assert.equal(quota.status, 'no_data');
  });

  it('keeps a numeric window as ok when the other utilization is not a number', () => {
    const quota = parseClaudeUsageResponse(
      {
        seven_day: { utilization: NaN, resets_at: null },
        five_hour: { utilization: 0, resets_at: '2026-11-13T12:00:00Z' },
      },
      'max',
      OBSERVED,
    );

    assert.equal(quota.status, 'ok');
    assert.equal(findWindow(quota.windows, 'five_hour')?.usedPercent, 0);
    assert.equal(findWindow(quota.windows, 'weekly')?.usedPercent, null);
  });

  it('sets resetsAt to null for a missing or invalid resets_at', () => {
    const quota = parseClaudeUsageResponse(
      {
        five_hour: { utilization: 1, resets_at: 'not-a-date' },
        seven_day: { utilization: 2 },
      },
      'max',
      OBSERVED,
    );

    assert.equal(findWindow(quota.windows, 'five_hour')?.resetsAt, null);
    assert.equal(findWindow(quota.windows, 'five_hour')?.usedPercent, 1);
    assert.equal(findWindow(quota.windows, 'weekly')?.resetsAt, null);
    assert.equal(findWindow(quota.windows, 'weekly')?.usedPercent, 2);
  });

  it('returns an error for a non-object body', () => {
    for (const body of [null, 'text', 42, [1, 2], undefined]) {
      const quota = parseClaudeUsageResponse(body, 'max', OBSERVED);
      assert.deepEqual(quota, {
        provider: 'claude',
        status: 'error',
        plan: 'max',
        windows: [],
        source: 'live',
        observedAt: OBSERVED,
        message: 'unexpected response from Anthropic usage endpoint',
      });
    }
  });

  it('normalises microsecond resets_at to a valid ISO-8601 UTC string', () => {
    const quota = parseClaudeUsageResponse(
      { seven_day: { utilization: 3, resets_at: '2026-11-20T01:00:00.043805+00:00' } },
      null,
      OBSERVED,
    );

    const resetsAt = findWindow(quota.windows, 'weekly')?.resetsAt;
    assert.equal(resetsAt, '2026-11-20T01:00:00.043Z');
    assert.ok(resetsAt !== null && resetsAt !== undefined);
    assert.equal(new Date(resetsAt).toISOString(), resetsAt);
  });

  it('passes plan through unchanged, including null', () => {
    const quota = parseClaudeUsageResponse({ seven_day: { utilization: 1 } }, null, OBSERVED);
    assert.equal(quota.plan, null);
  });
});

function credsJson(oauth: unknown): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

describe('parseClaudeCredentials', () => {
  it('maps a valid credentials document', () => {
    const parsed = parseClaudeCredentials(
      credsJson({ accessToken: 'sk-ant-oat01-abc.DEF_123', expiresAt: 1789999999000, subscriptionType: 'max' }),
    );
    assert.deepEqual(parsed, {
      accessToken: 'sk-ant-oat01-abc.DEF_123',
      expiresAt: 1789999999000,
      plan: 'max',
    });
  });

  it('maps missing expiresAt and subscriptionType to null', () => {
    const parsed = parseClaudeCredentials(credsJson({ accessToken: 'tok' }));
    assert.deepEqual(parsed, { accessToken: 'tok', expiresAt: null, plan: null });
  });

  it('treats a token containing a newline as absent', () => {
    assert.equal(parseClaudeCredentials(credsJson({ accessToken: 'abc\ndef' })), null);
    assert.equal(parseClaudeCredentials(credsJson({ accessToken: 'abc def' })), null);
    assert.equal(parseClaudeCredentials(credsJson({ accessToken: 'abc\u0000' })), null);
  });

  it('treats an empty token as absent', () => {
    assert.equal(parseClaudeCredentials(credsJson({ accessToken: '' })), null);
  });

  it('returns null when claudeAiOauth is missing', () => {
    assert.equal(parseClaudeCredentials(JSON.stringify({ other: { accessToken: 'tok' } })), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseClaudeCredentials('{not json'), null);
    assert.equal(parseClaudeCredentials(''), null);
  });
});

describe('safeReason', () => {
  const SECRET = 'sk-ant-oat01-SECRETVALUE';

  it('redacts the secret inside the error text', () => {
    const error = new TypeError('Invalid header value "Bearer ' + SECRET + '"');
    const reason = safeReason(error, SECRET);
    assert.equal(reason, 'Invalid header value "Bearer <redacted>"');
    assert.ok(!reason.includes(SECRET));
  });

  it('redacts every occurrence of the secret', () => {
    const reason = safeReason(new Error(`${SECRET} and ${SECRET}`), SECRET);
    assert.equal(reason, '<redacted> and <redacted>');
  });

  it('does not partially show a secret that truncation would cut', () => {
    // The secret starts at char 110, so an unredacted cut at 120 would leak a prefix.
    const filler = 'x'.repeat(110);
    const error = new Error(filler + SECRET + ' tail');
    const reason = safeReason(error, SECRET);
    assert.equal(reason, filler + '<redacted>...');
    assert.equal(reason.includes('sk-ant'), false);
  });

  it('leaves text unchanged when the secret is null', () => {
    assert.equal(safeReason(new Error('plain failure'), null), 'plain failure');
    assert.equal(safeReason(new Error('plain failure'), ''), 'plain failure');
  });

  it('collapses whitespace and reports aborts as timed out', () => {
    assert.equal(safeReason(new Error('a\n\n  b'), null), 'a b');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.equal(safeReason(abort, null), 'timed out');
  });
});

describe('parseClaudeUsageResponse scopedLimits', () => {
  const base = { seven_day: { utilization: 3, resets_at: '2026-11-20T01:00:00Z' } };

  it('maps a scoped entry to a ScopedLimit', () => {
    const quota = parseClaudeUsageResponse(
      {
        ...base,
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 14,
            severity: 'normal',
            resets_at: '2026-11-20T01:00:00.417343+00:00',
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: true,
          },
        ],
      },
      'max',
      OBSERVED,
    );
    assert.deepEqual(quota.scopedLimits, [
      { scope: 'Fable', kind: 'weekly', usedPercent: 14, resetsAt: '2026-11-20T01:00:00.417Z' },
    ]);
    assert.equal(quota.status, 'ok');
  });

  it('falls back to scope.model.id when display_name is empty', () => {
    const quota = parseClaudeUsageResponse(
      { ...base, limits: [{ kind: 'weekly_scoped', percent: 2, scope: { model: { id: 'opus', display_name: '' } } }] },
      null,
      OBSERVED,
    );
    assert.equal(quota.scopedLimits?.[0]?.scope, 'opus');
  });

  it('maps five_hour and session kinds to five_hour', () => {
    const quota = parseClaudeUsageResponse(
      {
        limits: [
          { kind: 'five_hour_scoped', percent: 9, scope: { model: { display_name: 'Fable' } } },
          { kind: 'session_scoped', percent: 1, scope: { model: { display_name: 'Haiku' } } },
        ],
      },
      null,
      OBSERVED,
    );
    assert.deepEqual(quota.scopedLimits?.map((l) => l.kind), ['five_hour', 'five_hour']);
  });

  it('ignores unscoped entries', () => {
    const quota = parseClaudeUsageResponse(
      { ...base, limits: [{ kind: 'weekly_all', percent: 11, scope: null, resets_at: null }] },
      null,
      OBSERVED,
    );
    assert.equal(quota.scopedLimits, undefined);
    assert.equal('scopedLimits' in quota, false);
  });

  it('keeps several scoped entries in order', () => {
    const quota = parseClaudeUsageResponse(
      {
        limits: [
          { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_all', percent: 11, scope: null },
          { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Opus' } } },
        ],
      },
      null,
      OBSERVED,
    );
    assert.deepEqual(quota.scopedLimits?.map((l) => [l.scope, l.usedPercent]), [
      ['Fable', 5],
      ['Opus', 7],
    ]);
  });

  it('keeps percent 0', () => {
    const quota = parseClaudeUsageResponse(
      { limits: [{ kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } }] },
      null,
      OBSERVED,
    );
    assert.equal(quota.scopedLimits?.[0]?.usedPercent, 0);
  });

  it('ignores malformed limits without changing status', () => {
    const malformed: unknown[] = [
      'nope',
      { limits: null },
      { limits: 5 },
      { limits: [null, 3, 'x', [], { kind: 'weekly_scoped', scope: 'Fable' }, { scope: { model: null } }] },
    ];
    for (const body of malformed) {
      const clean = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
      if (clean === null) continue;
      const quota = parseClaudeUsageResponse({ ...(clean as object), ...base }, null, OBSERVED);
      assert.equal(quota.scopedLimits, undefined);
      assert.equal(quota.status, 'ok');
    }
    assert.equal(parseClaudeUsageResponse({ limits: [null, 3] }, null, OBSERVED).status, 'no_data');
    assert.equal(parseClaudeUsageResponse('nope', null, OBSERVED).status, 'error');
  });

  it('reports null usedPercent for a non-numeric percent', () => {
    const quota = parseClaudeUsageResponse(
      { limits: [{ kind: 'weekly_scoped', percent: '5', scope: { model: { display_name: 'Fable' } } }] },
      null,
      OBSERVED,
    );
    assert.equal(quota.scopedLimits?.[0]?.usedPercent, null);
  });
});

const FIXTURE_TOKEN = 'sk-ant-oat01-fixture-token';
const FIXTURE_EXPIRES = 1999999999000;

function credsDocument(token = FIXTURE_TOKEN): string {
  return credsJson({ accessToken: token, expiresAt: FIXTURE_EXPIRES, subscriptionType: 'max' });
}

async function fixtureHome(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'claude-creds-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

describe('resolveClaudeCredentialSources', () => {
  it('Linux: only the credentials file under the fixture home', async (t) => {
    const home = await fixtureHome(t);
    const expected = join(home, '.claude', '.credentials.json');
    assert.deepEqual(resolveClaudeCredentialSources(home, {}, 'linux'), [
      { kind: 'file', location: expected, label: expected },
    ]);
  });

  it('Linux: CLAUDE_CONFIG_DIR replaces the config directory', async (t) => {
    const home = await fixtureHome(t);
    const configDir = join(home, 'account-two', 'claude');
    assert.deepEqual(
      resolveClaudeCredentialSources(home, { CLAUDE_CONFIG_DIR: configDir }, 'linux').map((s) => s.location),
      [join(configDir, '.credentials.json')],
    );
  });

  it('Linux: empty and relative CLAUDE_CONFIG_DIR values are ignored', async (t) => {
    const home = await fixtureHome(t);
    const expected = join(home, '.claude', '.credentials.json');
    for (const value of ['', '   ', '.claude-work', '~/.claude-work']) {
      assert.equal(resolveClaudeCredentialSources(home, { CLAUDE_CONFIG_DIR: value }, 'linux')[0]?.location, expected);
    }
  });

  it('macOS: keychain entry first, then the file fallback', async (t) => {
    const home = await fixtureHome(t);
    const sources = resolveClaudeCredentialSources(home, {}, 'darwin');
    assert.deepEqual(sources.map((s) => s.kind), ['keychain', 'file']);
    assert.equal(sources[0]?.location, 'Claude Code-credentials');
    assert.equal(sources[1]?.location, join(home, '.claude', '.credentials.json'));
  });

  it('macOS: CLAUDE_CONFIG_DIR keys the keychain service by config-dir hash', async (t) => {
    const home = await fixtureHome(t);
    const configDir = join(home, 'account-two', 'claude');
    const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    const sources = resolveClaudeCredentialSources(home, { CLAUDE_CONFIG_DIR: configDir }, 'darwin');
    assert.equal(sources[0]?.location, `Claude Code-credentials-${hash}`);
    assert.equal(sources[1]?.location, join(configDir, '.credentials.json'));
  });

  it('the not-signed-in message names every location looked at', async (t) => {
    const home = await fixtureHome(t);
    const configDir = join(home, 'work', 'claude');
    const linux = resolveClaudeCredentialSources(home, { CLAUDE_CONFIG_DIR: configDir }, 'linux');
    assert.equal(
      claudeNotSignedInMessage(linux),
      `not signed in: run \`claude\` and log in (looked at ${join(configDir, '.credentials.json')})`,
    );
    const mac = claudeNotSignedInMessage(resolveClaudeCredentialSources(home, {}, 'darwin'));
    assert.ok(mac.includes('Claude Code-credentials'));
    assert.ok(mac.includes(join(home, '.claude', '.credentials.json')));
  });
});

describe('loadClaudeCredentials with fixture homes', () => {
  it('Linux: reads the fixture-home file and never calls the keychain', async (t) => {
    const home = await fixtureHome(t);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), credsDocument());
    const keychainServices: string[] = [];
    const loaded = await loadClaudeCredentials(resolveClaudeCredentialSources(home, {}, 'linux'), 1000, {
      readKeychain: async (service) => {
        keychainServices.push(service);
        return null;
      },
    });
    assert.deepEqual(loaded, { accessToken: FIXTURE_TOKEN, expiresAt: FIXTURE_EXPIRES, plan: 'max' });
    assert.deepEqual(keychainServices, []);
  });

  it('Linux: reads CLAUDE_CONFIG_DIR credentials, not the default home file', async (t) => {
    const home = await fixtureHome(t);
    const configDir = join(home, 'work', 'claude');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), credsDocument('default-file-token'));
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, '.credentials.json'), credsDocument('override-file-token'));
    const loaded = await loadClaudeCredentials(
      resolveClaudeCredentialSources(home, { CLAUDE_CONFIG_DIR: configDir }, 'linux'),
      1000,
    );
    assert.equal(loaded?.accessToken, 'override-file-token');
  });

  it('macOS: falls back to the fixture-home file when the keychain has no entry', async (t) => {
    const home = await fixtureHome(t);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), credsDocument());
    const asked: string[] = [];
    const loaded = await loadClaudeCredentials(resolveClaudeCredentialSources(home, {}, 'darwin'), 1000, {
      readKeychain: async (service) => {
        asked.push(service);
        return null;
      },
    });
    assert.equal(loaded?.accessToken, FIXTURE_TOKEN);
    assert.deepEqual(asked, ['Claude Code-credentials']);
  });

  it('macOS: prefers the keychain entry over the file', async (t) => {
    const home = await fixtureHome(t);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), credsDocument('file-token'));
    const loaded = await loadClaudeCredentials(resolveClaudeCredentialSources(home, {}, 'darwin'), 1000, {
      readKeychain: async () => credsDocument('keychain-token'),
    });
    assert.equal(loaded?.accessToken, 'keychain-token');
  });

  it('returns null when no source holds a valid token', async (t) => {
    const home = await fixtureHome(t);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), '{not json');
    const loaded = await loadClaudeCredentials(resolveClaudeCredentialSources(home, {}, 'darwin'), 1000, {
      readKeychain: async () => credsDocument().replace('accessToken', 'wrongField'),
    });
    assert.equal(loaded, null);
  });

  it('the quota fetcher names the looked-at file when no credentials exist', async (t) => {
    if (process.platform === 'darwin') return t.skip('a real keychain may hold a credential on macOS runners');
    const home = await fixtureHome(t);
    const quota = await fetchClaudeQuota({ timeoutMs: 500, now: () => new Date(OBSERVED), homeDir: home });
    assert.equal(quota.status, 'auth');
    assert.equal(quota.message, claudeNotSignedInMessage(resolveClaudeCredentialSources(home)));
  });
});

// Tests in this module own temporary homes and must not access inherited harness paths.
const inheritedPathOverrides: NodeJS.ProcessEnv = {};
const pathOverrideNames = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
] as const;
before(() => {
  for (const name of pathOverrideNames) {
    inheritedPathOverrides[name] = process.env[name];
    delete process.env[name];
  }
});
after(() => {
  for (const name of pathOverrideNames) {
    const value = inheritedPathOverrides[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
