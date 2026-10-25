// Linux Chromium's test-only NSS trust. Never writes to the runner/user HOME.
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NICKNAME = 'ftown-e2e-localhost';
const DEFAULT_E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function reject() { throw new Error('Isolated browser trust setup rejected; check its exact scratch path, fixture certificate and certutil prerequisite.'); }
function noSymlinks(target) {
  const absolute = resolve(target);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) reject(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
export function browserTrustPaths(e2eDir = process.env.E2E_DIR ?? DEFAULT_E2E_DIR,
  browserHome = process.env.E2E_BROWSER_HOME ?? join(e2eDir, '.browser-home')) {
  if (!isAbsolute(e2eDir) || resolve(e2eDir) !== e2eDir || realpathSync(e2eDir) !== e2eDir
    || browserHome !== join(e2eDir, '.browser-home')) reject();
  noSymlinks(e2eDir);
  const paths = { e2eDir, home: browserHome, data: join(browserHome, '.local/share'), config: join(browserHome, '.config'),
    cache: join(browserHome, '.cache'), db: join(browserHome, '.local/share/pki/nssdb'), certificate: join(e2eDir, 'certs/cert.pem') };
  for (const target of [paths.home, paths.data, paths.config, paths.cache, paths.db, join(paths.home, '.pki/nssdb')]) noSymlinks(target);
  if (existsSync(join(paths.home, '.pki/nssdb'))) reject();
  if (existsSync(paths.db)) for (const entry of readdirSync(paths.db)) {
    const item = lstatSync(join(paths.db, entry));
    if (!item.isFile() || item.isSymbolicLink()) reject();
  }
  return paths;
}
export function fixtureCertificate(bytes, now = Date.now()) {
  const pem = bytes.toString('utf8');
  if (bytes.length > 65536 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) reject();
  const certificate = new X509Certificate(bytes);
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)
    || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now
    || certificate.checkHost('localhost', { subject: 'never' }) !== 'localhost'
    || certificate.checkIP('127.0.0.1') !== '127.0.0.1') reject();
  return certificate;
}
function privateDirectory(path) { noSymlinks(path); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function setupBrowserTrust(paths = browserTrustPaths(), execute = execFileSync, platform = process.platform) {
  if (platform !== 'linux') throw new Error('Browser NSS trust setup requires Linux and libnss3-tools; use the isolated Linux E2E sandbox.');
  // Revalidate before every mutation, including callers using the exported test seam.
  paths = browserTrustPaths(paths.e2eDir, paths.home);
  noSymlinks(paths.certificate);
  if (!lstatSync(paths.certificate).isFile()) reject();
  const source = fixtureCertificate(readFileSync(paths.certificate));
  for (const path of [paths.home, join(paths.home, '.local'), paths.data, join(paths.data, 'pki'), paths.db, paths.config, paths.cache]) privateDirectory(path);
  const run = args => {
    browserTrustPaths(paths.e2eDir, paths.home);
    try { return execute('certutil', ['-d', `sql:${paths.db}`, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', HOME: paths.home,
        XDG_DATA_HOME: paths.data, XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache } }); }
    catch { throw new Error('Browser NSS trust command failed; install libnss3-tools and use the isolated E2E browser home.'); }
  };
  const certificateDb = existsSync(join(paths.db, 'cert9.db'));
  const keyDb = existsSync(join(paths.db, 'key4.db'));
  if (certificateDb !== keyDb) reject();
  if (!certificateDb) run(['-N', '--empty-password']);
  let listing = run(['-L']);
  const entry = () => listing.split('\n').find(line => /^ftown-e2e-localhost\s/.test(line.trimStart()));
  let exact = false;
  if (entry()) {
    const current = new X509Certificate(run(['-L', '-n', NICKNAME, '-a']));
    exact = current.fingerprint256 === source.fingerprint256 && entry().trim().split(/\s+/).at(-1) === 'P,,';
    if (!exact) run(['-D', '-n', NICKNAME]);
  }
  if (!exact) run(['-A', '-t', 'P,,', '-n', NICKNAME, '-i', paths.certificate]);
  const exported = new X509Certificate(run(['-L', '-n', NICKNAME, '-a']));
  listing = run(['-L']);
  if (exported.fingerprint256 !== source.fingerprint256 || entry()?.trim().split(/\s+/).at(-1) !== 'P,,') reject();
  return paths;
}
export function cleanupBrowserTrust(paths = browserTrustPaths()) {
  const checked = browserTrustPaths(paths.e2eDir, paths.home);
  // Call only after Playwright has closed its browser. rm never follows child symlinks.
  rmSync(checked.home, { recursive: true, force: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const paths = browserTrustPaths();
    if (paths.e2eDir !== DEFAULT_E2E_DIR) reject();
    if (args.length === 1 && args[0] === '--cleanup') { cleanupBrowserTrust(paths); console.log('[browser-trust] isolated browser home removed'); }
    else if (args.length === 0) { setupBrowserTrust(paths); console.log('[browser-trust] exact localhost certificate trusted in isolated browser home'); }
    else reject();
  } catch (error) { console.error(error instanceof Error ? error.message : 'Isolated browser trust operation failed'); process.exitCode = 1; }
}
