import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bridge's long-lived DTLS identity for connections made to its fixed address.
 *
 * A browser that connects without an introduction has to name the certificate it expects before the bridge has said anything, so
 * the certificate must stay the same across restarts. It identifies the listener only: what a peer may do is still decided by the
 * encrypted hello on the channel, exactly as on every other transport.
 */
export interface DtlsIdentity {
  certPath: string;
  keyPath: string;
  /** SHA-256 of the certificate, as SDP writes it: upper-case hex pairs joined by colons. */
  fingerprint: string;
}

const VALID_YEARS = 20;
/** Re-issued when less than this remains, so a browser never remembers a certificate that is about to stop working. */
const RENEW_BEFORE_MS = 365 * 24 * 60 * 60 * 1000;

// Minimal DER: only what one self-signed ECDSA P-256 certificate needs.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const bytes: number[] = [];
  for (let rest = body.length; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
/** A positive INTEGER: a leading zero keeps the top bit from reading as a sign. */
const integer = (value: Buffer) => der(0x02, value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const utcTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));
const generalizedTime = (date: Date) => der(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`, 'ascii'));
/** X.509 writes years through 2049 as UTCTime and later ones as GeneralizedTime. */
const time = (date: Date) => date.getUTCFullYear() < 2050 ? utcTime(date) : generalizedTime(date);
const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'));
/** Name with a single commonName. */
const name = (commonName: string) => sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from(commonName, 'utf8')))));

/** A self-signed certificate for `privateKeyPem` (an EC P-256 key), as PEM. */
export function selfSignedCertificate(privateKeyPem: string, commonName: string, notBefore: Date, notAfter: Date): string {
  const key = createPrivateKey(privateKeyPem);
  const subjectPublicKeyInfo = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const who = name(commonName);
  const tbs = sequence(der(0xa0, integer(Buffer.from([2]))), integer(serial), ECDSA_WITH_SHA256, who, sequence(time(notBefore), time(notAfter)), who, subjectPublicKeyInfo);
  const signature = sign('sha256', tbs, key);
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function fingerprintOf(certPem: string): string {
  const raw = new X509Certificate(certPem).raw;
  return (createHash('sha256').update(raw).digest('hex').toUpperCase().match(/.{2}/g) ?? []).join(':');
}

/** True when the stored pair is a certificate for that key with enough validity left. */
function usable(certPem: string, keyPem: string, now: number): boolean {
  try {
    const certificate = new X509Certificate(certPem);
    return certificate.checkPrivateKey(createPrivateKey(keyPem)) && Date.parse(certificate.validFrom) <= now
      && Date.parse(certificate.validTo) - now > RENEW_BEFORE_MS;
  } catch { return false; }
}

/**
 * Loads the identity kept under `dataDir`, creating it on first use (or when the stored one is unreadable or close to expiry).
 * The private key is written owner-only, and both files are replaced atomically.
 */
export function loadOrCreateDtlsIdentity(dataDir: string, now: () => number = Date.now): DtlsIdentity {
  const dir = join(dataDir, 'direct-identity');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, 'utf8');
    if (usable(certPem, readFileSync(keyPath, 'utf8'), now())) return { certPath, keyPath, fingerprint: fingerprintOf(certPem) };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const start = new Date(now() - 24 * 60 * 60 * 1000);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + VALID_YEARS);
  const certPem = selfSignedCertificate(keyPem, 'ftown-bridge', start, end);
  // The key first: a crash in between leaves a key without its certificate, which the check above replaces.
  writeFileSync(`${keyPath}.tmp`, keyPem, { mode: 0o600 });
  renameSync(`${keyPath}.tmp`, keyPath);
  writeFileSync(`${certPath}.tmp`, certPem, { mode: 0o600 });
  renameSync(`${certPath}.tmp`, certPath);
  return { certPath, keyPath, fingerprint: fingerprintOf(certPem) };
}
