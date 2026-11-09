import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { argvForPairingRestart, beginIdentityReset, completePendingIdentityReset, reexec } from './identity-reset.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const SEC_FILES = ['account-enrollment.json', 'pending-approval-status.json', 'pending-approval-confirmation.json', 'local-cli-identity.json', 'policy.json', 'bridge-identity.json'];

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
    ['empty', [], ['--bootstrap']],
    ['removes --bridge-id v', ['--bridge-id', 'x', '--foo'], ['--foo', '--bootstrap']],
    ['removes --bridge-id=v', ['--bridge-id=x', '--foo'], ['--foo', '--bootstrap']],
    ['removes --new-identity (no value)', ['--new-identity', '--foo', 'bar'], ['--foo', 'bar', '--bootstrap']],
    ['removes --account and --token both forms', ['--account', 'a', '--token=t', 'start'], ['start', '--bootstrap']],
    ['keeps --bootstrap once', ['--bootstrap', '--foo'], ['--bootstrap', '--foo']],
    ['value options consume next token', ['--data-dir', '/d', '--token', 'x'], ['--data-dir', '/d', '--bootstrap']],
    ['trailing --token', ['--foo', '--token'], ['--foo', '--bootstrap']],
    ['--account followed by flag-like value', ['--account', '--bootstrap'], ['--bootstrap']],
    ['kept option value equal to --token', ['--data-dir', '--token', '--port', '1'], ['--data-dir', '--token', '--port', '1', '--bootstrap']],
    ['keeps --port= form', ['--port=9', '--token=t'], ['--port=9', '--bootstrap']],
    ['preserves order of others', ['a', '--b', 'c', '--bridge-id', 'x', 'd'], ['a', '--b', 'c', 'd', '--bootstrap']],
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
