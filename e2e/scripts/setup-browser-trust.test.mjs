import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserTrustPaths, cleanupBrowserTrust, fixtureCertificate, setupBrowserTrust } from './setup-browser-trust.mjs';

function fixture(t, certificate = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ftown-browser-trust-unit-'));
  const e2e = join(root, 'e2e'); mkdirSync(e2e);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = browserTrustPaths(e2e, join(e2e, '.browser-home'));
  if (certificate) {
    mkdirSync(join(e2e, 'certs'));
    const key = join(root, 'fixture-key.pem'); writeFileSync(key, '', { mode: 0o600 });
    // Temporary crypto fixture only: no NSS command, browser, server or real HOME.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', paths.certificate,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { timeout: 10000, stdio: 'ignore' });
  }
  return { root, e2e, paths };
}
test('only exact canonical task HOME is accepted; cleanup cannot remove another directory', t => {
  const { root, e2e, paths } = fixture(t);
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
  for (const home of [outside, '.', `${paths.home}/`, join(e2e, 'other-home')]) assert.throws(() => browserTrustPaths(e2e, home));
  assert.throws(() => cleanupBrowserTrust({ ...paths, home: outside }));
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
  mkdirSync(paths.home); writeFileSync(join(paths.home, 'owned'), 'scratch');
  cleanupBrowserTrust(paths); assert.throws(() => readFileSync(join(paths.home, 'owned')));
});
test('symlinked HOME, modern path components and database files fail closed', t => {
  const { root, e2e, paths } = fixture(t); const outside = join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, paths.home); assert.throws(() => browserTrustPaths(e2e, paths.home)); unlinkSync(paths.home);
  mkdirSync(paths.home); symlinkSync(outside, join(paths.home, '.local'));
  assert.throws(() => browserTrustPaths(e2e, paths.home)); unlinkSync(join(paths.home, '.local'));
  mkdirSync(paths.db, { recursive: true }); symlinkSync(join(outside, 'cert9.db'), join(paths.db, 'cert9.db'));
  assert.throws(() => browserTrustPaths(e2e, paths.home));
});
test('legacy NSS database is rejected instead of silently shadowing modern trust', t => {
  const { e2e, paths } = fixture(t); mkdirSync(join(paths.home, '.pki/nssdb'), { recursive: true });
  assert.throws(() => browserTrustPaths(e2e, paths.home)); assert.throws(() => cleanupBrowserTrust(paths));
});
test('certificate validation accepts current exact localhost peer and rejects expired or corrupted fixtures', t => {
  const { paths } = fixture(t, true); const bytes = readFileSync(paths.certificate);
  const certificate = fixtureCertificate(bytes);
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.throws(() => fixtureCertificate(bytes, Date.parse(certificate.validTo) + 1));
  assert.throws(() => fixtureCertificate(bytes, Date.parse(certificate.validFrom) - 1));
  assert.throws(() => fixtureCertificate(Buffer.from('not a certificate')));
  const tampered = Buffer.from(certificate.raw); tampered[tampered.length - 1] ^= 1;
  const pem = `-----BEGIN CERTIFICATE-----\n${tampered.toString('base64')}\n-----END CERTIFICATE-----\n`;
  assert.throws(() => fixtureCertificate(Buffer.from(pem)));
});
test('NSS commands remain isolated/bounded and repeat setup changes only its own nickname', t => {
  const { paths } = fixture(t, true); const pem = readFileSync(paths.certificate, 'utf8');
  let trust = null; const calls = [];
  const execute = (executable, args, options) => {
    assert.equal(executable, 'certutil'); assert.deepEqual(args.slice(0, 2), ['-d', `sql:${paths.db}`]);
    assert.equal(options.timeout, 10000); assert.equal(options.env.HOME, paths.home);
    assert.equal(options.env.XDG_DATA_HOME, paths.data); assert.equal(options.env.XDG_CONFIG_HOME, paths.config); assert.equal(options.env.XDG_CACHE_HOME, paths.cache);
    calls.push(args);
    if (args.includes('-N')) { for (const name of ['cert9.db', 'key4.db']) writeFileSync(join(paths.db, name), 'fixture'); return ''; }
    if (args.includes('-A')) { assert.ok(args.includes('P,,')); trust = 'P,,'; return ''; }
    if (args.includes('-D')) { assert.equal(args.at(-1), 'ftown-e2e-localhost'); trust = null; return ''; }
    if (args.includes('-a')) return pem;
    return `Unrelated fixture C,,\n${trust ? `ftown-e2e-localhost  ${trust}\n` : ''}`;
  };
  setupBrowserTrust(paths, execute, 'linux'); assert.equal(calls.filter(args => args.includes('-A')).length, 1);
  calls.length = 0; setupBrowserTrust(paths, execute, 'linux');
  assert.equal(calls.some(args => args.includes('-A') || args.includes('-D') || args.includes('-N')), false);
  trust = 'C,,'; calls.length = 0; setupBrowserTrust(paths, execute, 'linux');
  assert.equal(calls.filter(args => args.includes('-D')).length, 1); assert.equal(calls.filter(args => args.includes('-A')).length, 1);
});
test('exported certificate mismatch and subprocess failures do not report trusted setup', t => {
  const { paths } = fixture(t, true); const certificate = new X509Certificate(readFileSync(paths.certificate));
  const changed = Buffer.from(certificate.raw); changed[changed.length - 1] ^= 1;
  const wrong = `-----BEGIN CERTIFICATE-----\n${changed.toString('base64')}\n-----END CERTIFICATE-----\n`;
  const execute = (_binary, args) => {
    if (args.includes('-N')) { for (const name of ['cert9.db', 'key4.db']) writeFileSync(join(paths.db, name), 'fixture'); }
    if (args.includes('-a')) return wrong;
    return '';
  };
  assert.throws(() => setupBrowserTrust(paths, execute, 'linux'));
  assert.throws(() => setupBrowserTrust(paths, () => { throw new Error('untrusted stderr'); }, 'linux'), error => !error.message.includes('untrusted stderr'));
});
