import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreparedRelease, StableRelease, UpdateReleaseApi } from './update-runtime-contract.js';

const REGISTRY = 'https://registry.npmjs.org';
const MAX_METADATA = 1_048_576;
const MAX_TARBALL = 100 * 1024 * 1024;
const JOB_LIMIT_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function stableVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value) && value.split('.').every(n => Number.isSafeInteger(Number(n)));
}
export function compareStableVersions(a: string, b: string): number {
  if (!stableVersion(a) || !stableVersion(b)) throw new Error('Invalid stable version');
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** Conservative subset of npm engine ranges; unsupported ranges fail closed. */
export function supportsNode(engine: string, node: string): boolean {
  const current = node.replace(/^v/, '');
  if (!stableVersion(current) || typeof engine !== 'string' || engine.length > 256) return false;
  return engine.split('||').some(part => {
    const clauses = part.trim().split(/\s+/).filter(Boolean);
    if (!clauses.length) return false;
    return clauses.every(clause => {
      const m = /^(\^|>=|>|<=|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(clause);
      if (!m) return false;
      const base = `${m[2]}.${m[3]}.${m[4]}`; if (!stableVersion(base)) return false;
      const c = compareStableVersions(current, base);
      switch (m[1]) {
        case '^': {
          const [major, minor, patch] = base.split('.').map(Number);
          const upper = major ? `${major + 1}.0.0` : minor ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
          return c >= 0 && compareStableVersions(current, upper) < 0;
        }
        case '>=': return c >= 0; case '>': return c > 0; case '<=': return c <= 0; case '<': return c < 0;
        default: return c === 0;
      }
    });
  });
}
export function validateStableMetadata(value: unknown, nodeVersion = process.versions.node): StableRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release metadata');
  const m = value as Record<string, unknown>; const dist = m.dist as Record<string, unknown> | undefined;
  const engines = m.engines as Record<string, unknown> | undefined;
  if (m.name !== 'ftown' || !stableVersion(m.version) || typeof m.gitHead !== 'string' || !/^[a-f0-9]{40}$/i.test(m.gitHead)
    || !dist || typeof dist.tarball !== 'string' || dist.tarball !== `${REGISTRY}/ftown/-/ftown-${m.version}.tgz`
    || typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)
    || Buffer.from(dist.integrity.slice(7), 'base64').length !== 64
    || !engines || typeof engines.node !== 'string' || !supportsNode(engines.node, nodeVersion)) throw new Error('Unsupported release metadata');
  return { version: m.version, gitHead: m.gitHead.toLowerCase(), tarballUrl: dist.tarball, integrity: dist.integrity, nodeEngine: engines.node };
}
async function readBounded(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json, application/octet-stream' } });
  if (!response.ok || !response.body) throw new Error('Release unavailable');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('Release too large');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += part.byteLength; if (bytes > limit) throw new Error('Release too large'); chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}
async function secureDir(path: string): Promise<void> {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (typeof process.getuid === 'function' && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0) throw new Error('Unsafe update directory');
  if (await realpath(path) !== resolve(path)) throw new Error('Unsafe update path');
}
export class UpdateProcessUncertainError extends Error {
  readonly code = 'update_process_uncertain' as const;
  constructor() { super('Cannot prove update child exited'); }
}
/** Resolve only after close; once stopped, bound the time allowed to prove exit. */
export function waitForUpdateChild(child: import('node:child_process').ChildProcess, stop: () => void,
  timeoutMs: number, proofMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    let stopped = false; let spawnError = false; let finished = false;
    let proof: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); if (proof) clearTimeout(proof);
      signal?.removeEventListener('abort', onStop); child.off('close', onClose); child.off('error', onError);
      error ? fail(error) : ok();
    };
    const onStop = () => {
      if (stopped || finished) return; stopped = true;
      proof = setTimeout(() => finish(new UpdateProcessUncertainError()), proofMs);
      try { stop(); } catch { /* Absence of proof still fails closed. */ }
    };
    const onError = () => { spawnError = true; };
    const onClose = (code: number | null) => finish(!stopped && !spawnError && code === 0 ? undefined : new Error('Update staging failed'));
    const timer = setTimeout(onStop, timeoutMs);
    child.once('error', onError); child.once('close', onClose); signal?.addEventListener('abort', onStop, { once: true });
    if (signal?.aborted) onStop();
  });
}
async function command(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, timeout: number): Promise<void> {
  if (signal.aborted) throw new Error('Update cancelled');
  const child = spawn(binary, args, { cwd, env, shell: false, stdio: 'ignore', detached: true });
  await waitForUpdateChild(child, () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }, timeout, 5_000, signal);
}
export async function createStagingEnvironment(jobDir: string, cache: string): Promise<NodeJS.ProcessEnv> {
  const userConfig = join(jobDir, 'user.npmrc'); const globalConfig = join(jobDir, 'global.npmrc');
  await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  return { HOME: jobDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_REGISTRY: REGISTRY, NPM_CONFIG_ENGINE_STRICT: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' };
}
export interface ReleaseDependencies {
  read: typeof readBounded;
  run: typeof command;
  nowNode: string;
  currentVersion: () => Promise<string>;
}
const defaults: ReleaseDependencies = {
  read: readBounded, run: command, nowNode: process.versions.node,
  currentVersion: async () => (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version,
};
export function createUpdateReleaseApi(overrides: Partial<ReleaseDependencies> = {}): UpdateReleaseApi {
  const deps = { ...defaults, ...overrides };
  return {
    async resolveStableRelease(signal) {
      const bytes = await deps.read(`${REGISTRY}/ftown/latest`, MAX_METADATA, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      return validateStableMetadata(JSON.parse(bytes.toString('utf8')), deps.nowNode);
    },
    async prepareRelease(release, options) {
      options.signal.throwIfAborted();
      const safe = validateStableMetadata({ name: 'ftown', version: release.version, gitHead: release.gitHead,
        dist: { tarball: release.tarballUrl, integrity: release.integrity }, engines: { node: release.nodeEngine } }, deps.nowNode);
      if (!UUID.test(options.operationId) || compareStableVersions(safe.version, await deps.currentVersion()) <= 0) throw new Error('Invalid update target');
      const root = resolve(options.stagingRoot);
      if (root !== options.stagingRoot || root !== join(process.env.HOME ?? '', '.ftown', 'updates')) throw new Error('Invalid staging root');
      await mkdir(root, { recursive: true, mode: 0o700 }); await secureDir(root);
      const jobDir = join(root, options.operationId); await mkdir(jobDir, { mode: 0o700 });
      try {
        await writeFile(join(jobDir, 'owner.json'), JSON.stringify({ operationId: options.operationId, version: safe.version }), { flag: 'wx', mode: 0o600 });
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(JOB_LIMIT_MS)]);
        const tarball = await deps.read(safe.tarballUrl, MAX_TARBALL, signal);
        signal.throwIfAborted();
        const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
        if (integrity !== safe.integrity) throw new Error('Invalid release integrity');
        const tarPath = join(jobDir, 'release.tgz'); await writeFile(tarPath, tarball, { flag: 'wx', mode: 0o600 });
        const prefix = join(jobDir, 'install'); const cache = join(jobDir, 'cache');
        await mkdir(prefix, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 });
        const env = await createStagingEnvironment(jobDir, cache);
        const npm = join(dirname(process.execPath), 'npm');
        await deps.run(npm, ['install', '--prefix', prefix, '--package-lock=false', '--no-audit', '--no-fund', '--engine-strict', '--registry', REGISTRY, tarPath], env, jobDir, signal, JOB_LIMIT_MS);
        signal.throwIfAborted();
        const packageRoot = join(prefix, 'node_modules', 'ftown'); await secureDir(jobDir);
        const info = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
        if (info.name !== 'ftown' || info.version !== safe.version || info.ftownUpdateProtocol !== 1) throw new Error('Unsupported update candidate');
        const packageEntry = join(packageRoot, 'dist', 'ftown-cli.js');
        const entryStat = await lstat(packageEntry);
        if (!entryStat.isFile() || entryStat.isSymbolicLink() || !(await realpath(packageEntry)).startsWith(`${await realpath(packageRoot)}/`)) throw new Error('Invalid update entry');
        const probe = `const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);r('node-pty');const d=r('node-datachannel');if(typeof d.cleanup==='function')d.cleanup();`;
        await deps.run(process.execPath, ['-e', probe, packageEntry], env, jobDir, signal, 30_000);
        signal.throwIfAborted();
        return { protocol: 1, operationId: options.operationId, targetVersion: safe.version, jobDir, packageRoot, packageEntry };
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'update_process_uncertain') await rm(jobDir, { recursive: true, force: true });
        throw error;
      }
    },
    async discardPreparedRelease(prepared) {
      const job = resolve(prepared.jobDir); const root = dirname(job);
      if (job !== prepared.jobDir || root !== join(process.env.HOME ?? '', '.ftown', 'updates') || !UUID.test(prepared.operationId)
        || job !== join(root, prepared.operationId)) throw new Error('Invalid staging ownership');
      await secureDir(root); await secureDir(job);
      const owner = JSON.parse(await readFile(join(job, 'owner.json'), 'utf8')) as { operationId?: string; version?: string };
      if (owner.operationId !== prepared.operationId || owner.version !== prepared.targetVersion) throw new Error('Invalid staging ownership');
      await rm(job, { recursive: true, force: true });
    },
  };
}
const api = createUpdateReleaseApi();
export const resolveStableRelease = api.resolveStableRelease;
export const prepareRelease = api.prepareRelease;
export const discardPreparedRelease = api.discardPreparedRelease;
