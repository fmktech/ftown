import { randomBytes, randomUUID } from 'node:crypto';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreparedHandoff, PreparedRelease, RestartDescriptor, UpdateReceipt, UpdateReservation, UpdateRestartContext } from './update-runtime-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PROOF_MS = 15_000;
export class UpdateHandoffUncertainError extends Error {
  readonly code = 'handoff_uncertain' as const;
  constructor() { super('Cannot prove update helper exited'); }
}
interface Lock { schema: 1; operationId: string; ownerPid: number; token: string }
interface Context extends UpdateRestartContext { token: string; helperPid: number; home: string; jobDir: string }
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || realpathSync(path) !== resolve(path)) throw new Error('Unsafe update directory');
}
function privateRead(path: string): unknown {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || s.size > 65_536) throw new Error('Unsafe update file');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
function atomic(path: string, value: unknown): void {
  const dir = dirname(path); privateDir(dir);
  if (existsSync(path)) privateRead(path);
  const tmp = join(dir, `.update-${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); closeSync(fd); renameSync(tmp, path); }
  catch (e) { try { closeSync(fd); } catch {} try { unlinkSync(tmp); } catch {} throw e; }
}
function parseLock(value: unknown): Lock {
  const v = value as Partial<Lock> | null;
  if (!v || v.schema !== 1 || typeof v.operationId !== 'string' || !UUID.test(v.operationId) || !Number.isSafeInteger(v.ownerPid) || v.ownerPid! < 1 || typeof v.token !== 'string' || !TOKEN.test(v.token)) throw new Error('Invalid update reservation');
  return v as Lock;
}
function lockPath(home: string): string { return join(home, '.ftown', 'update-reservation.json'); }
function checkHome(home: string): void {
  if (!home || resolve(home) !== home || realpathSync(home) !== home) throw new Error('Invalid update home');
  privateDir(join(home, '.ftown'));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new Error('Cannot verify update owner'); }
}
function withLockGuard<T>(home: string, action: () => T): T {
  const parent = join(home, '.ftown'); const guard = join(parent, 'update-reservation.guard');
  const token = randomBytes(16).toString('hex'); const marker = `owner-${process.pid}-${token}.json`;
  const candidate = join(parent, `.update-guard-${process.pid}-${token}`);
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, marker), JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        try { lstatSync(guard); const exists = new Error('guard exists') as NodeJS.ErrnoException; exists.code = 'EEXIST'; throw exists; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        renameSync(candidate, guard); acquired = true; break;
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const stat = lstatSync(guard);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unknown update guard owner');
        const entries = readdirSync(guard);
        const match = entries.length === 1 ? /^owner-(\d+)-([a-f0-9]{32})\.json$/.exec(entries[0]) : null;
        if (!match) throw new Error('Unknown update guard owner');
        const item = privateRead(join(guard, entries[0])) as { pid?: number; token?: string };
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid < 1 || item.pid !== pid || item.token !== match[2]) throw new Error('Unknown update guard owner');
        if (alive(pid)) throw new Error('Update reservation changing');
        try { unlinkSync(join(guard, entries[0])); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        try { rmdirSync(guard); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
      }
    }
    if (!acquired) throw new Error('Update guard changed');
    return action();
  } finally {
    if (acquired) {
      try { unlinkSync(join(guard, marker)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try { rmdirSync(guard); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    } else rmSync(candidate, { recursive: true, force: true });
  }
}
function readLock(home: string): Lock | null {
  const p = lockPath(home); try { return parseLock(privateRead(p)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
function parseContext(value: unknown): Context {
  const c = value as Partial<Context> | null;
  if (!c || c.protocol !== 1 || typeof c.operationId !== 'string' || !UUID.test(c.operationId)
    || typeof c.targetVersion !== 'string' || !VERSION.test(c.targetVersion) || typeof c.token !== 'string' || !TOKEN.test(c.token)
    || !Number.isSafeInteger(c.helperPid) || c.helperPid! < 1 || typeof c.home !== 'string' || typeof c.jobDir !== 'string'
    || ![c.bridgeId,c.ownerId,c.endpointId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)) throw new Error('Invalid update context');
  if (resolve(c.home) !== c.home || c.jobDir !== join(c.home, '.ftown', 'updates', c.operationId)) throw new Error('Invalid update context');
  return c as Context;
}
let processContext: Context | null = null;
function authorizedContext(): Context | null {
  let c = processContext;
  if (!c) {
    const path = process.env.FTOWN_UPDATE_CONTEXT; const capability = process.env.FTOWN_UPDATE_CAPABILITY;
    if (!path && !capability) return null;
    if (!path || !capability || !TOKEN.test(capability) || resolve(path) !== path) throw new Error('Invalid update context');
    c = parseContext(privateRead(path));
    if (path !== join(c.jobDir, 'context.json') || c.token !== capability || c.helperPid !== process.ppid) throw new Error('Invalid update context');
    delete process.env.FTOWN_UPDATE_CONTEXT;
    delete process.env.FTOWN_UPDATE_CAPABILITY;
    processContext = c;
  }
  checkHome(c.home); privateDir(c.jobDir);
  const lock = readLock(c.home);
  if (!lock || lock.ownerPid !== c.helperPid || lock.operationId !== c.operationId || lock.token !== c.token) throw new Error('Invalid update reservation');
  return c;
}
export async function reserveUpdate(home: string, operationId: string): Promise<UpdateReservation> {
  if (!UUID.test(operationId)) throw new Error('Invalid update operation');
  checkHome(home); const path = lockPath(home);
  const lock: Lock = { schema: 1, operationId, ownerPid: process.pid, token: randomBytes(32).toString('hex') };
  withLockGuard(home, () => {
    const previous = readLock(home);
    if (previous) {
      if (alive(previous.ownerPid)) throw new Error('Update already reserved');
      unlinkSync(path);
    }
    const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(lock)); } finally { closeSync(fd); }
    if (existsSync(join(home, '.ftown', 'setup.lock'))) { unlinkSync(path); throw new Error('Setup is in progress'); }
  });
  return { async release() {
    withLockGuard(home, () => {
      const current = readLock(home);
      if (!current || current.operationId !== operationId || current.token !== lock.token) throw new Error('Update reservation ownership lost');
      if (current.ownerPid !== process.pid && alive(current.ownerPid)) throw new Error('Update helper still running');
      unlinkSync(path);
    });
  } };
}
export function assertUpdateReservationAllowed(home: string): void {
  const actualHome = realpathSync(resolve(home));
  const ftown = join(actualHome, '.ftown');
  if (!existsSync(ftown)) {
    if (process.env.FTOWN_UPDATE_CONTEXT || process.env.FTOWN_UPDATE_CAPABILITY) throw new Error('Invalid update context');
    return;
  }
  const directory = lstatSync(ftown);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe update directory');
  try { lstatSync(join(ftown, 'update-reservation.guard')); withLockGuard(actualHome, () => undefined); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = readLock(actualHome); const context = authorizedContext();
  if (lock && (!context || context.home !== actualHome || context.operationId !== lock.operationId)) {
    if (alive(lock.ownerPid)) throw new Error('Update in progress');
    withLockGuard(actualHome, () => {
      const current = readLock(actualHome);
      if (!current || current.ownerPid !== lock.ownerPid || current.operationId !== lock.operationId || current.token !== lock.token || alive(current.ownerPid)) throw new Error('Update reservation changed');
      unlinkSync(lockPath(actualHome));
    });
  }
}
export function readUpdateRestartContext(): UpdateRestartContext | null {
  const c = authorizedContext();
  return c ? { protocol: 1, operationId: c.operationId, targetVersion: c.targetVersion, bridgeId: c.bridgeId, ownerId: c.ownerId, endpointId: c.endpointId } : null;
}
export async function reportUpdateReady(identity: { version: string; bridgeId: string; ownerId: string; endpointId: string }): Promise<void> {
  const c = authorizedContext(); if (!c || !process.send || identity.version !== c.targetVersion || identity.bridgeId !== c.bridgeId || identity.ownerId !== c.ownerId || identity.endpointId !== c.endpointId) throw new Error('Update readiness identity mismatch');
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => { process.off('message', onMessage); reject(new Error('Update readiness acknowledgement failed')); }, PROOF_MS);
    const onMessage = (m: unknown) => { const v = m as Record<string, unknown> | null; if (v?.type === 'ready-ack' && v.operationId === c.operationId && v.token === c.token) { clearTimeout(timer); process.off('message', onMessage); resolvePromise(); } };
    process.on('message', onMessage); process.send!({ type: 'ready', operationId: c.operationId, token: c.token, ...identity }, error => { if (error) { clearTimeout(timer); process.off('message', onMessage); reject(new Error('Update readiness acknowledgement failed')); } });
  });
}
export async function readUpdateReceipt(stagingRoot: string): Promise<UpdateReceipt | null> {
  const p = join(stagingRoot, 'operation.json');
  try { const value = privateRead(p) as UpdateReceipt; if (value.schema !== 1 || typeof value.bridgeId !== 'string' || !value.operation || !UUID.test(value.operation.id) || !VERSION.test(value.operation.targetVersion) || !['staging','prepared','restarting','succeeded','failed'].includes(value.operation.phase)) throw new Error('Invalid update receipt'); return value; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function writeUpdateReceipt(stagingRoot: string, receipt: UpdateReceipt): Promise<void> {
  if (resolve(stagingRoot) !== stagingRoot || basenameSafe(stagingRoot) !== 'updates' || receipt.schema !== 1 || !UUID.test(receipt.operation.id) || !VERSION.test(receipt.operation.targetVersion)) throw new Error('Invalid update receipt');
  privateDir(stagingRoot); atomic(join(stagingRoot, 'operation.json'), receipt);
}
function basenameSafe(path: string): string { return path.split('/').at(-1) ?? ''; }
function waitChildExit(child: ChildProcess, timeout: number): Promise<void> {
  return new Promise((res, rej) => {
    if (child.exitCode !== null || child.signalCode !== null) { res(); return; }
    const t = setTimeout(() => { child.off('exit', onExit); rej(new Error('Cannot prove update helper exited')); }, timeout);
    const onExit = () => { clearTimeout(t); res(); }; child.once('exit', onExit);
  });
}
function awaitMessage(child: ChildProcess, type: string, op: string, token: string, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => done(new Error('Update helper acknowledgement timed out')), PROOF_MS);
    const done = (error?: Error) => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); signal.removeEventListener('abort', onAbort); error ? rej(error) : res(); };
    const onMessage = (m: unknown) => { const v = m as Record<string, unknown> | null; if (v?.type === type && v.operationId === op && v.token === token) done(); };
    const onExit = () => done(new Error('Update helper exited')); const onError = () => done(new Error('Update helper failed')); const onAbort = () => done(new Error('Update cancelled'));
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
  });
}
/** Forward only ordinary runtime settings and the explicit trusted-LAN opt-in. */
export function selectUpdateLaunchEnvironment(source: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (/^(PATH|SHELL|TERM|LANG|LC_[A-Z_]+|TZ|TMPDIR)$/.test(name)
      || (name === 'FTOWN_ALLOW_INSECURE_API' && value === '1')) result[name] = value;
  }
  return result;
}
/** The ACK is an irreversible attempt: the replacement might receive it even if sending fails. */
export async function finalizeUpdateReady(steps: {
  persist: () => Promise<void>; markAckAttempted: () => void;
  acknowledge: () => Promise<void>; release: () => Promise<void>;
}): Promise<void> {
  await steps.persist();
  steps.markAckAttempted();
  await steps.acknowledge();
  await steps.release();
}
/** After an ACK attempt, preserve the replacement and reservation on any uncertainty. */
export async function protectOrStopReplacement(ackAttempted: boolean, steps: {
  stop: () => Promise<void>; retain: () => Promise<void>;
}): Promise<void> {
  if (ackAttempted) await steps.retain();
  else await steps.stop();
}
function sendMessage(child: ChildProcess, message: object): Promise<void> {
  return new Promise((ok, fail) => {
    try { child.send(message, error => error ? fail(new Error('Update helper communication failed')) : ok()); }
    catch { fail(new Error('Update helper communication failed')); }
  });
}
export async function prepareHandoff(prepared: PreparedRelease, restart: RestartDescriptor, signal: AbortSignal): Promise<PreparedHandoff> {
  checkHome(restart.home);
  if (prepared.protocol !== 1 || !UUID.test(prepared.operationId) || !VERSION.test(prepared.targetVersion)
    || prepared.jobDir !== join(restart.home, '.ftown', 'updates', prepared.operationId)
    || prepared.packageRoot !== join(prepared.jobDir, 'install', 'node_modules', 'ftown')
    || prepared.packageEntry !== join(prepared.packageRoot, 'dist', 'ftown-cli.js')
    || restart.dataDir !== join(restart.home, '.ftown', 'data') || !['local','cloud'].includes(restart.mode)
    || ![restart.bridgeId,restart.ownerId,restart.endpointId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)) throw new Error('Invalid update handoff');
  privateDir(prepared.jobDir);
  const lock = readLock(restart.home); if (!lock || lock.operationId !== prepared.operationId || lock.ownerPid !== process.pid) throw new Error('Update reservation ownership lost');
  const owner = privateRead(join(prepared.jobDir, 'owner.json')) as { operationId?: string; version?: string };
  if (owner.operationId !== prepared.operationId || owner.version !== prepared.targetVersion) throw new Error('Invalid update stage');
  const helperPath = join(prepared.jobDir, 'helper.mjs');
  const source = fileURLToPath(import.meta.url); const bytes = readFileSync(source);
  if (!source.endsWith('.js')) throw new Error('Update helper requires installed runtime');
  const fd = openSync(helperPath, 'wx', 0o500); try { writeFileSync(fd, bytes); } finally { closeSync(fd); } chmodSync(helperPath, 0o500);
  const helper = fork(helperPath, ['--ftown-update-helper'], { detached: true, cwd: prepared.jobDir, env: { HOME: restart.home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, stdio: ['ignore','ignore','ignore','ipc'] });
  helper.on('error', () => undefined);
  if (!helper.pid) throw new Error('Update helper failed to start');
  try {
    withLockGuard(restart.home, () => {
      const current = readLock(restart.home);
      if (!current || current.ownerPid !== process.pid || current.operationId !== lock.operationId || current.token !== lock.token) throw new Error('Update reservation ownership lost');
      atomic(lockPath(restart.home), { ...lock, ownerPid: helper.pid! });
    });
    const context: Context = { protocol: 1, operationId: prepared.operationId, targetVersion: prepared.targetVersion, bridgeId: restart.bridgeId,
      ownerId: restart.ownerId, endpointId: restart.endpointId, token: lock.token, helperPid: helper.pid, home: restart.home, jobDir: prepared.jobDir };
    atomic(join(prepared.jobDir, 'context.json'), context);
    const pending = awaitMessage(helper, 'prepared', prepared.operationId, lock.token, signal);
    const launchEnv = selectUpdateLaunchEnvironment(process.env);
    await Promise.all([pending, sendMessage(helper, { type: 'prepare', prepared, restart, oldPid: process.pid, token: lock.token, launchEnv })]);
    let cancelled = false;
    return {
      async commit() {
        if (cancelled) throw new Error('Update helper cancelled');
        const pendingCommit = awaitMessage(helper, 'committed', prepared.operationId, lock.token, signal);
        await Promise.all([pendingCommit, sendMessage(helper, { type: 'commit', operationId: prepared.operationId, token: lock.token })]);
      },
      async cancel() {
        cancelled = true; if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
        await waitChildExit(helper, PROOF_MS);
      },
    };
  } catch (error) {
    try {
      if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
      await waitChildExit(helper, PROOF_MS);
    } catch { throw new UpdateHandoffUncertainError(); }
    throw error;
  }
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
export class UpdateProcessUncertainError extends Error {
  readonly code = 'update_process_uncertain' as const;
  constructor() { super('Cannot prove update child exited'); }
}
/** Bounded termination proof for helper-owned setup processes. */
export function waitForUpdateChild(child: ChildProcess, stop: () => void, timeoutMs: number, proofMs: number): Promise<void> {
  return new Promise((ok, fail) => {
    let stopped = false; let spawnError = false; let finished = false;
    let proof: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); if (proof) clearTimeout(proof);
      child.off('close', onClose); child.off('error', onError); error ? fail(error) : ok();
    };
    const onStop = () => {
      if (stopped || finished) return; stopped = true;
      proof = setTimeout(() => finish(new UpdateProcessUncertainError()), proofMs);
      try { stop(); } catch { /* Failure to prove exit must retain ownership. */ }
    };
    const onError = () => { spawnError = true; };
    const onClose = (code: number | null) => finish(!stopped && !spawnError && code === 0 ? undefined : new Error('Setup failed'));
    const timer = setTimeout(onStop, timeoutMs);
    child.once('error', onError); child.once('close', onClose);
  });
}
async function runSetup(entry: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [entry, 'setup'], { cwd, env, stdio: 'ignore', shell: false, detached: true });
  await waitForUpdateChild(child, () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }, 300_000, 5_000);
}
/** A possibly live child means this helper must remain the live lock owner. */
async function holdUncertainReservation(): Promise<never> {
  return await new Promise<never>(() => { setInterval(() => undefined, 60_000); });
}
async function helperMain(): Promise<void> {
  const initial = await new Promise<Record<string, unknown>>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('Preparation timeout')), PROOF_MS);
    process.once('message', m => { clearTimeout(t); ok(m as Record<string, unknown>); });
  });
  const p = initial.prepared as PreparedRelease; const restart = initial.restart as RestartDescriptor; const token = initial.token as string; const oldPid = initial.oldPid as number;
  if (initial.type !== 'prepare' || !p || !restart || !TOKEN.test(token) || !Number.isSafeInteger(oldPid) || oldPid < 1) throw new Error('Invalid helper preparation');
  const c = parseContext(privateRead(join(p.jobDir, 'context.json'))); const lock = readLock(restart.home);
  if (c.token !== token || c.helperPid !== process.pid || c.operationId !== p.operationId || c.targetVersion !== p.targetVersion || !lock || lock.ownerPid !== process.pid || lock.token !== token || lock.operationId !== p.operationId) throw new Error('Invalid helper ownership');
  process.send?.({ type: 'prepared', operationId: p.operationId, token });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('Commit timeout')), PROOF_MS);
    process.once('message', m => { const v = m as Record<string, unknown> | null; clearTimeout(t); v?.type === 'commit' && v.operationId === p.operationId && v.token === token ? ok() : fail(new Error('Invalid commit')); });
  });
  process.send?.({ type: 'committed', operationId: p.operationId, token });
  let child: ChildProcess | undefined;
  let readyAckAttempted = false;
  try {
    const deadline = Date.now() + PROOF_MS; while (alive(oldPid) && Date.now() < deadline) await sleep(100);
    if (alive(oldPid)) throw new Error('Old bridge did not exit');
    const supplied = initial.launchEnv as Record<string, unknown> | undefined;
    const env: NodeJS.ProcessEnv = supplied && typeof supplied === 'object' ? selectUpdateLaunchEnvironment(supplied) : {};
    env.HOME = restart.home; env.PATH ??= `${dirname(process.execPath)}:/usr/bin:/bin`;
    env.FTOWN_UPDATE_CONTEXT = join(p.jobDir, 'context.json'); env.FTOWN_UPDATE_CAPABILITY = token;
    await runSetup(p.packageEntry, restart.cwd, env);
    const installed = join(restart.home, '.ftown', 'cli', 'dist', 'ftown-cli.js');
    const info = JSON.parse(readFileSync(join(restart.home, '.ftown', 'cli', 'package.json'), 'utf8')) as { version?: string; ftownUpdateProtocol?: number };
    if (info.version !== p.targetVersion || info.ftownUpdateProtocol !== 1) throw new Error('Installed update mismatch');
    const args = [installed, 'start', '--allow-updates', '--data-dir', restart.dataDir, '--bridge-id', restart.bridgeId, '--api-url', restart.apiUrl];
    if (restart.mode === 'local') args.push('--local');
    child = fork(installed, args.slice(1), { cwd: restart.cwd, env, detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
    const ready = await new Promise<boolean>((ok) => {
      const t = setTimeout(() => ok(false), 60_000);
      child!.on('message', m => { const v = m as Record<string, unknown> | null;
        if (v?.type === 'ready' && v.operationId === p.operationId && v.token === token && v.version === p.targetVersion && v.bridgeId === restart.bridgeId && v.ownerId === restart.ownerId && v.endpointId === restart.endpointId) { clearTimeout(t); ok(true); } });
      child!.once('exit', () => { clearTimeout(t); ok(false); }); child!.once('error', () => { clearTimeout(t); ok(false); });
    });
    if (!ready) throw new Error('Replacement did not become ready');
    const receipt = await readUpdateReceipt(dirname(p.jobDir));
    if (!receipt || receipt.bridgeId !== restart.bridgeId || receipt.operation.id !== p.operationId || receipt.operation.targetVersion !== p.targetVersion) throw new Error('Update receipt mismatch');
    await finalizeUpdateReady({
      persist: () => writeUpdateReceipt(dirname(p.jobDir), { ...receipt, operation: { ...receipt.operation, phase: 'succeeded', updatedAt: new Date().toISOString(), error: null } }),
      markAckAttempted: () => { readyAckAttempted = true; },
      release: async () => withLockGuard(restart.home, () => {
        const current = readLock(restart.home);
        if (!current || current.ownerPid !== process.pid || current.operationId !== p.operationId || current.token !== token) throw new Error('Update reservation ownership lost');
        unlinkSync(lockPath(restart.home));
      }),
      acknowledge: () => sendMessage(child!, { type: 'ready-ack', operationId: p.operationId, token }),
    });
    // Once acknowledged, do not turn an IPC disconnect race into a failed update.
    try { if (child.connected) child.disconnect(); } catch { /* The child may already have disconnected. */ }
    try { child.unref(); } catch { /* Acknowledged replacement must not be stopped. */ }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'update_process_uncertain') await holdUncertainReservation();
    await protectOrStopReplacement(readyAckAttempted, {
      retain: async () => {
        // Delivery or lock release may have succeeded: do not claim a final outcome.
        try {
          const current = await readUpdateReceipt(dirname(p.jobDir));
          if (current && current.bridgeId === restart.bridgeId && current.operation.id === p.operationId && current.operation.targetVersion === p.targetVersion) {
            await writeUpdateReceipt(dirname(p.jobDir), { ...current, operation: { ...current.operation, phase: 'restarting', updatedAt: new Date().toISOString(), error: 'Update readiness could not be confirmed.' } });
          }
        } catch { /* Retain the live helper and reservation even if the receipt cannot be updated. */ }
        await holdUncertainReservation();
      },
      stop: async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); await waitChildExit(child, 5_000); }
          catch { await holdUncertainReservation(); }
        }
      },
    });
    const receipt = await readUpdateReceipt(dirname(p.jobDir));
    if (receipt && receipt.operation.id === p.operationId && receipt.operation.targetVersion === p.targetVersion && receipt.bridgeId === restart.bridgeId) {
      await writeUpdateReceipt(dirname(p.jobDir), { ...receipt, operation: { ...receipt.operation, phase: 'failed', updatedAt: new Date().toISOString(), error: 'Update did not complete. Run the exact-version setup --repair, then start the bridge.' } });
    }
    withLockGuard(restart.home, () => {
      const current = readLock(restart.home); if (current?.ownerPid === process.pid && current.token === token) unlinkSync(lockPath(restart.home));
    });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--ftown-update-helper') {
  void helperMain().then(() => process.exit(0), () => process.exit(1));
}
