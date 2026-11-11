import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LEDGER_ARCHIVES_KEPT, argvForPairingRestart, beginIdentityReset, completePendingIdentityReset, reexec } from './identity-reset.js';
import { hasLegacyAccountState } from './security/bridge/ledger-identity.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const SEC_FILES = ['account-enrollment.json', 'pending-approval-status.json', 'pending-approval-confirmation.json', 'local-cli-identity.json', 'policy.json',
  'bridge-identity.json', 'ledger.json', 'ledger-clock.json', 'relay-url.json', 'ledger-identity.json', 'ledger.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp', 'policy.json.x.tmp'];
const identityOwnedBy = (ownerId: string): string => JSON.stringify({ version: 1, endpoint: { version: 1, id: 'i', ownerId, kind: 'bridge', publicKey: 'p' }, privateKey: {} });

let dir: string;
const sec = (n: string) => join(dir, 'security', n);
const marker = () => sec('identity-reset.json');

function seed(): void {
  mkdirSync(join(dir, 'security'), { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', 's1.json'), '{}');
  writeFileSync(join(dir, 'bridge-id'), `${OLD_ID}\n`);
  writeFileSync(join(dir, 'refresh-token'), 'tok');
  writeFileSync(join(dir, 'browser-devices.json'), '[]');
  writeFileSync(join(dir, 'local-api-port'), '1234');
  writeFileSync(join(dir, 'archive.jsonl'), 'x');
  writeFileSync(join(dir, 'unrelated.txt'), 'keep');
  writeFileSync(sec('unrelated-sec.json'), 'keep');
  for (const f of SEC_FILES) writeFileSync(sec(f), '{}');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'identity-reset-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('identity reset', () => {
  it('full reset deletes exactly the listed files and returns ids', () => {
    seed();
    beginIdentityReset(dir, 'revoked');
    const newId = (JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId;
    const res = completePendingIdentityReset(dir);
    assert.deepEqual(res, { oldBridgeId: OLD_ID, newBridgeId: newId, reason: 'revoked' });
    for (const f of SEC_FILES) assert.equal(existsSync(sec(f)), false, f);
    assert.equal(existsSync(join(dir, 'refresh-token')), false);
    assert.equal(existsSync(join(dir, 'browser-devices.json')), false);
    assert.equal(existsSync(marker()), false);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${newId}\n`);
    assert.equal(statSync(join(dir, 'bridge-id')).mode & 0o777, 0o600);
    for (const keep of ['local-api-port', 'archive.jsonl', 'unrelated.txt', 'sessions/s1.json', 'security/unrelated-sec.json']) {
      assert.equal(existsSync(join(dir, keep)), true, keep);
    }
    // ledger.json is archived, never deleted.
    assert.equal(readdirSync(join(dir, 'security')).filter(name => name.endsWith('.archived.json')).length, 1);
  });

  it('archives security/ledger.json (it may be the only copy of the history): renamed with a timestamp, 0600, newest 5 kept', () => {
    seed();
    writeFileSync(sec('ledger.json'), '{"the":"only copy"}', { mode: 0o644 });
    const older = Array.from({ length: 6 }, (_, index) => `ledger.2026-01-0${index + 1}T00-00-00.000Z.archived.json`);
    for (const name of older) writeFileSync(sec(name), 'old');
    writeFileSync(sec('ledger.notes.json'), 'keep');
    beginIdentityReset(dir, 'revoked');
    completePendingIdentityReset(dir, () => new Date('2026-11-10T12:34:56.789Z'));
    const archive = sec('ledger.2026-11-10T12-34-56.789Z.archived.json');
    assert.equal(readFileSync(archive, 'utf8'), '{"the":"only copy"}');
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    assert.equal(existsSync(sec('ledger.json')), false);
    const kept = readdirSync(join(dir, 'security')).filter(name => name.endsWith('.archived.json')).sort();
    assert.equal(kept.length, LEDGER_ARCHIVES_KEPT);
    assert.deepEqual(kept, [...older.slice(2), 'ledger.2026-11-10T12-34-56.789Z.archived.json']);
    assert.equal(readFileSync(sec('ledger.notes.json'), 'utf8'), 'keep');
    // A second reset in the same millisecond gets its own name.
    writeFileSync(sec('ledger.json'), '{"second":true}');
    beginIdentityReset(dir, 'manual');
    completePendingIdentityReset(dir, () => new Date('2026-11-10T12:34:56.789Z'));
    assert.equal(readFileSync(sec('ledger.2026-11-10T12-34-56.789Z-1.archived.json'), 'utf8'), '{"second":true}');
    assert.equal(readFileSync(archive, 'utf8'), '{"the":"only copy"}');
  });

  it('leaves no v1 account state behind, so the legacy trigger cannot fire again', () => {
    seed();
    writeFileSync(sec('bridge-identity.json'), identityOwnedBy('349f8d2e-38e4-4d59-888d-687dcfa19e39'));
    assert.equal(hasLegacyAccountState(dir), true);
    beginIdentityReset(dir, 'manual');
    completePendingIdentityReset(dir);
    assert.equal(hasLegacyAccountState(dir), false);
    assert.equal(existsSync(sec('bridge-identity.json')), false);
  });

  it('deletes the bridge identity whatever its owner: a solo:<old bridge-id> identity could never load after the rotation', () => {
    for (const content of [identityOwnedBy(`solo:${OLD_ID}`), '{corrupt', identityOwnedBy('A'.repeat(43))]) {
      seed();
      writeFileSync(sec('bridge-identity.json'), content);
      assert.equal(hasLegacyAccountState(dir), true, 'seed leaves refresh-token');
      beginIdentityReset(dir, 'manual');
      completePendingIdentityReset(dir);
      for (const f of SEC_FILES) assert.equal(existsSync(sec(f)), false, `${f} after ${content.slice(0, 20)}`);
    }
  });

  it('a Solo/--local identity alone never looks like v1 account state', () => {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(sec('bridge-identity.json'), identityOwnedBy(`solo:${OLD_ID}`));
    assert.equal(hasLegacyAccountState(dir), false);
  });

  it('sweeps only *.tmp files, never directories, and keeps the reset retryable', () => {
    seed();
    mkdirSync(sec('dir.tmp'));
    writeFileSync(sec('dir.tmp/inner.json'), 'keep');
    beginIdentityReset(dir, 'manual');
    completePendingIdentityReset(dir);
    assert.equal(existsSync(sec('dir.tmp/inner.json')), true);
    assert.equal(existsSync(sec('unrelated-sec.json')), true);
  });

  // Fault injection, one step at a time: every deletion lands before the new bridge-id, and the marker outlives the bridge-id write,
  // so a reset interrupted anywhere is finished by the next start with the same new id.
  const DELETION_STEPS = [['refresh-token'], ...['account-enrollment.json', 'pending-approval-status.json', 'pending-approval-confirmation.json',
    'local-cli-identity.json'].map(name => ['security', name]), ['browser-devices.json'], ...['policy.json', 'bridge-identity.json',
    'ledger-clock.json', 'relay-url.json', 'ledger-identity.json'].map(name => ['security', name])];
  for (const step of DELETION_STEPS) {
    it(`a failure deleting ${step.join('/')} leaves the old bridge-id and the marker, and the retry finishes`, () => {
      seed();
      beginIdentityReset(dir, 'revoked');
      const newId = (JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId;
      const blocked = join(dir, ...step);
      rmSync(blocked, { force: true });
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'inner'), 'x'); // unlink of a directory fails with a non-ENOENT error
      assert.throws(() => completePendingIdentityReset(dir));
      assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
      assert.equal(existsSync(marker()), true);
      rmSync(blocked, { recursive: true });
      assert.equal(completePendingIdentityReset(dir)?.newBridgeId, newId);
      for (const f of SEC_FILES) assert.equal(existsSync(sec(f)), false, f);
      assert.equal(existsSync(marker()), false);
    });
  }

  it('a failure writing the new bridge-id keeps the marker, after every deletion, and the retry finishes', { skip: process.getuid?.() === 0 }, () => {
    seed();
    rmSync(join(dir, 'refresh-token'));
    rmSync(join(dir, 'browser-devices.json'));
    beginIdentityReset(dir, 'revoked');
    const newId = (JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId;
    chmodSync(dir, 0o500); // the data dir refuses the bridge-id temporary; security/ stays writable
    try {
      assert.throws(() => completePendingIdentityReset(dir));
      assert.equal(existsSync(marker()), true);
      for (const f of SEC_FILES) assert.equal(existsSync(sec(f)), false, f);
      assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
    } finally { chmodSync(dir, 0o700); }
    assert.deepEqual(completePendingIdentityReset(dir), { oldBridgeId: OLD_ID, newBridgeId: newId, reason: 'revoked' });
    assert.equal(existsSync(marker()), false);
  });

  it('returns null without a marker', () => {
    seed();
    assert.equal(completePendingIdentityReset(dir), null);
    assert.equal(existsSync(join(dir, 'refresh-token')), true);
  });

  it('oldBridgeId is null when there was no bridge-id', () => {
    beginIdentityReset(dir, 'manual');
    const res = completePendingIdentityReset(dir);
    assert.equal(res?.oldBridgeId, null);
    assert.equal(res?.reason, 'manual');
  });

  it('second begin keeps the first newBridgeId', () => {
    beginIdentityReset(dir, 'revoked');
    const first = readFileSync(marker(), 'utf8');
    beginIdentityReset(dir, 'manual');
    assert.equal(readFileSync(marker(), 'utf8'), first);
  });

  it('marker is mode 0600', () => {
    beginIdentityReset(dir, 'manual');
    assert.equal(statSync(marker()).mode & 0o777, 0o600);
  });

  it('crash recovery finishes with the same newBridgeId', () => {
    seed();
    beginIdentityReset(dir, 'revoked');
    const newId = (JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId;
    rmSync(join(dir, 'refresh-token'));
    writeFileSync(join(dir, 'bridge-id'), `${newId}\n`);
    const res = completePendingIdentityReset(dir);
    assert.equal(res?.newBridgeId, newId);
    for (const f of SEC_FILES) assert.equal(existsSync(sec(f)), false, f);
    assert.equal(existsSync(join(dir, 'browser-devices.json')), false);
    assert.equal(existsSync(marker()), false);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${newId}\n`);
  });

  it('crash before bridge-id write keeps the original old id', () => {
    seed();
    beginIdentityReset(dir, 'revoked');
    rmSync(join(dir, 'refresh-token'));
    rmSync(sec('policy.json'));
    const res = completePendingIdentityReset(dir);
    assert.equal(res?.oldBridgeId, OLD_ID);
  });

  it('a mid-sequence fs failure is rethrown, keeps the marker, and the retry finishes', () => {
    seed();
    beginIdentityReset(dir, 'revoked');
    const newId = (JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId;
    rmSync(sec('policy.json'));
    mkdirSync(sec('policy.json')); // unlink of a directory fails with a non-ENOENT error
    assert.throws(() => completePendingIdentityReset(dir));
    assert.equal(existsSync(marker()), true);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
    assert.equal(existsSync(join(dir, 'refresh-token')), false);
    rmSync(sec('policy.json'), { recursive: true });
    const res = completePendingIdentityReset(dir);
    assert.equal(res?.newBridgeId, newId);
    assert.equal(existsSync(marker()), false);
  });

  it('corrupt marker: complete returns null and deletes nothing', () => {
    seed();
    writeFileSync(marker(), '{not json');
    assert.equal(completePendingIdentityReset(dir), null);
    assert.equal(existsSync(join(dir, 'refresh-token')), true);
    assert.equal(existsSync(sec('policy.json')), true);
    assert.equal(readFileSync(join(dir, 'bridge-id'), 'utf8'), `${OLD_ID}\n`);
  });

  it('removes symlinks without following them', () => {
    seed();
    const target = join(dir, 'unrelated.txt');
    rmSync(join(dir, 'refresh-token'));
    symlinkSync(target, join(dir, 'refresh-token'));
    rmSync(sec('policy.json'));
    symlinkSync(join(dir, 'sessions'), sec('policy.json')); // symlink to a dir
    beginIdentityReset(dir, 'manual');
    completePendingIdentityReset(dir);
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(join(dir, 'sessions', 's1.json')), true);
    assert.equal(existsSync(join(dir, 'refresh-token')), false);
    assert.equal(existsSync(sec('policy.json')), false);
  });

  it('a corrupt marker is replaced by begin', () => {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(marker(), '{not json');
    beginIdentityReset(dir, 'manual');
    const m = JSON.parse(readFileSync(marker(), 'utf8')) as { version: number; reason: string; newBridgeId: string };
    assert.equal(m.version, 1);
    assert.equal(m.reason, 'manual');
    assert.match(m.newBridgeId, /^[0-9a-f-]{36}$/);
  });

  it('a structurally invalid marker is replaced by begin', () => {
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(marker(), JSON.stringify({ version: 1, reason: 'revoked', requestedAt: 'x', newBridgeId: '../evil' }));
    beginIdentityReset(dir, 'revoked');
    assert.match((JSON.parse(readFileSync(marker(), 'utf8')) as { newBridgeId: string }).newBridgeId, /^[0-9a-f-]{36}$/);
  });
});

describe('argvForPairingRestart', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['empty', [], []],
    ['removes --bridge-id v', ['--bridge-id', 'x', '--foo'], ['--foo']],
    ['removes --bridge-id=v', ['--bridge-id=x', '--foo'], ['--foo']],
    ['removes --new-identity (no value)', ['--new-identity', '--foo', 'bar'], ['--foo', 'bar']],
    ['removes --new-identity= form', ['--new-identity=1', 'start'], ['start']],
    ['value options consume next token', ['--data-dir', '/d', '--bridge-id', 'x'], ['--data-dir', '/d']],
    ['trailing --bridge-id', ['--foo', '--bridge-id'], ['--foo']],
    ['--bridge-id followed by flag-like value', ['--bridge-id', '--allow-updates'], []],
    ['kept option value equal to --bridge-id', ['--data-dir', '--bridge-id', '--port', '1'], ['--data-dir', '--bridge-id', '--port', '1']],
    ['keeps --port= and --api-url= forms', ['--port=9', '--api-url=https://a.test', '--bridge-id=x'], ['--port=9', '--api-url=https://a.test']],
    ['keeps --api-url value', ['--api-url', 'https://a.test', 'start'], ['--api-url', 'https://a.test', 'start']],
    ['preserves order of others', ['a', '--b', 'c', '--bridge-id', 'x', 'd'], ['a', '--b', 'c', 'd']],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const frozen = Object.freeze([...input]);
      assert.deepEqual(argvForPairingRestart(frozen), expected);
      assert.deepEqual(frozen, input);
    });
  }
});

describe('reexec', () => {
  const original = process.execve;
  afterEach(() => { process.execve = original; });

  it('returns false when execve is unavailable', () => {
    process.execve = undefined;
    assert.equal(reexec('/s.js', ['a']), false);
  });

  it('returns false without calling execve when the script is missing', () => {
    let called = 0;
    process.execve = (() => { called++; }) as unknown as typeof process.execve;
    assert.equal(reexec(join(dir, 'nope.js'), []), false);
    assert.equal(called, 0);
  });

  it('calls execve with the expected args', () => {
    const calls: Array<[string, readonly string[] | undefined, unknown]> = [];
    process.execve = ((f: string, a?: readonly string[], e?: unknown) => { calls.push([f, a, e]); }) as unknown as typeof process.execve;
    const script = join(dir, 's.js');
    writeFileSync(script, '');
    assert.equal(reexec(script, ['--x', 'y']), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], process.execPath);
    assert.deepEqual(calls[0][1], [process.execPath, ...process.execArgv, script, '--x', 'y']);
    assert.equal(calls[0][2], process.env);
  });
});
