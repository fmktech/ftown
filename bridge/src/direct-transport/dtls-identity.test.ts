import assert from 'node:assert/strict';
import { test } from 'node:test';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateDtlsIdentity, selfSignedCertificate } from './dtls-identity.js';

function home(t: { after(fn: () => unknown): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-dtls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the certificate is a valid self-signed certificate for its key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certificate = new X509Certificate(selfSignedCertificate(keyPem, 'ftown-bridge', new Date('2026-01-01T00:00:00Z'), new Date('2046-01-01T00:00:00Z')));
  assert.equal(certificate.subject, 'CN=ftown-bridge');
  assert.equal(certificate.issuer, 'CN=ftown-bridge');
  assert.ok(certificate.checkPrivateKey(createPrivateKey(keyPem)));
  // Signed by its own key: this is what a TLS stack checks before it will use the certificate.
  assert.ok(certificate.verify(certificate.publicKey));
  assert.equal(new Date(certificate.validFrom).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(new Date(certificate.validTo).toISOString(), '2046-01-01T00:00:00.000Z');
});

test('validity dates from 2050 on are written in the long form and read back unchanged', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certificate = new X509Certificate(selfSignedCertificate(keyPem, 'x', new Date('2049-06-01T00:00:00Z'), new Date('2069-06-01T00:00:00Z')));
  assert.equal(new Date(certificate.validFrom).toISOString(), '2049-06-01T00:00:00.000Z');
  assert.equal(new Date(certificate.validTo).toISOString(), '2069-06-01T00:00:00.000Z');
});

test('the identity is created once and stays the same across restarts', t => {
  const dir = home(t);
  const first = loadOrCreateDtlsIdentity(dir);
  assert.match(first.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(statSync(first.keyPath).mode & 0o777, 0o600);
  const again = loadOrCreateDtlsIdentity(dir);
  assert.deepEqual(again, first);
  assert.ok(new X509Certificate(readFileSync(first.certPath, 'utf8')).checkPrivateKey(createPrivateKey(readFileSync(first.keyPath, 'utf8'))));
});

test('an unreadable, mismatched or nearly expired identity is replaced', t => {
  const dir = home(t);
  const first = loadOrCreateDtlsIdentity(dir);
  writeFileSync(first.certPath, 'not a certificate');
  const afterJunk = loadOrCreateDtlsIdentity(dir);
  assert.notEqual(afterJunk.fingerprint, first.fingerprint);

  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(afterJunk.keyPath, other);
  const afterMismatch = loadOrCreateDtlsIdentity(dir);
  assert.notEqual(afterMismatch.fingerprint, afterJunk.fingerprint);

  // Nineteen years and a bit later, less than a year of validity is left.
  const later = Date.now() + (19 * 365 + 30) * 24 * 60 * 60 * 1000;
  const renewed = loadOrCreateDtlsIdentity(dir, () => later);
  assert.notEqual(renewed.fingerprint, afterMismatch.fingerprint);
  assert.deepEqual(loadOrCreateDtlsIdentity(dir, () => later), renewed);
});
