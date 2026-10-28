#!/usr/bin/env node
// Root-owned Linux smoke: actual npm staging, setup, old bridge shutdown and replacement readiness.
// Uses a local fixture tarball and a new isolated HOME; never publishes or changes production.
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('Run this isolated smoke on Linux');
const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'ftown-real-update-')));
const home = join(root, 'home'), fixture = join(root, 'fixture'), logs = join(root, 'logs');
await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(fixture, { mode: 0o700 }), mkdir(logs, { mode: 0o700 })]);
const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
const env = { HOME: home, PATH: path, LANG: 'C.UTF-8' };
const installed = join(home, '.ftown', 'cli', 'dist', 'ftown-cli.js');
const pointerPath = join(home, '.ftown', 'bridge.json');
const receiptPath = join(home, '.ftown', 'updates', 'operation.json');
const reservationPath = join(home, '.ftown', 'update-reservation.json');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
let phase = 'prepare';
let old; let helperIdentity; let replacementIdentity; let controllerLog;
const owned = new Map();
const unidentified = new Set();

// PID + kernel start time protects every signal from reuse. A zombie has exited.
async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], ppid: Number(fields[1]), start: fields[19] };
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
}
async function remember(pid, parent) {
  const current = await identity(pid);
  if (!current || (parent !== undefined && current.ppid !== parent)) throw new Error('Cannot establish process ownership');
  owned.set(pid, current); return current;
}
async function signalOwned(record, signal) {
  const current = await identity(record.pid);
  if (!current || current.state === 'Z') return;
  if (current.start !== record.start) return; // Original process exited and PID was reused.
  try { process.kill(record.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function awaitExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await identity(record.pid);
    if (!current || current.state === 'Z') return;
    if (current.start !== record.start) return;
    await sleep(50);
  }
  throw new Error('Owned process exit not proved');
}
async function bounded(child, ms) {
  const completion = new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', code => ok(code));
  });
  if (!child.pid) { await completion; throw new Error('Command did not start'); }
  unidentified.add(child.pid);
  const record = await remember(child.pid); unidentified.delete(child.pid);
  let timer;
  const deadline = new Promise((_, fail) => {
    timer = setTimeout(() => { void stopTree([record]).then(
      () => fail(new Error('Command timed out')), () => fail(new Error('Command termination was not proved')),
    ); }, ms);
  });
  try {
    const code = await Promise.race([completion, deadline]);
    if (code !== 0) throw new Error('Command failed');
  } finally { clearTimeout(timer); }
}
async function command(label, binary, args, cwd, timeoutMs = 300_000) {
  const fd = openSync(join(logs, `${label}.log`), 'w', 0o600);
  try { await bounded(spawn(binary, args, { cwd, env, stdio: ['ignore', fd, fd] }), timeoutMs); }
  finally { closeSync(fd); }
}
async function status(expectedPid) {
  const fd = openSync(join(logs, 'status.log'), 'w', 0o600);
  try {
    const child = spawn(process.execPath, [installed, 'harness', '--json', 'status'], { cwd: home, env, stdio: ['ignore', fd, fd] });
    await bounded(child, 10_000);
    const result = JSON.parse(await readFile(join(logs, 'status.log'), 'utf8'));
    return result.bridge === 'up' && result.pid === expectedPid;
  } catch { return false; } finally { closeSync(fd); }
}
async function waitFor(test, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await test(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function json(pathname) { try { return JSON.parse(await readFile(pathname, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

// Stop and prove only processes observed in the exact controller/helper descendant tree.
// Freeze parents before enumeration so no new owned descendants can be launched.
async function stopTree(roots) {
  for (const record of roots) await signalOwned(record, 'SIGSTOP');
  const found = new Map(roots.map(record => [record.pid, record]));
  for (;;) {
    let changed = false;
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const info = await identity(Number(name));
      if (!info || !found.has(info.ppid) || found.has(info.pid)) continue;
      const parent = found.get(info.ppid), still = await identity(parent.pid);
      if (!still || still.start !== parent.start || still.state === 'Z') continue;
      found.set(info.pid, info); owned.set(info.pid, info); changed = true;
      await signalOwned(info, 'SIGSTOP');
    }
    if (!changed) break;
  }
  for (const record of [...found.values()].reverse()) await signalOwned(record, 'SIGKILL');
  for (const record of found.values()) await awaitExit(record, 10_000);
}
async function cleanupOwned() {
  await stopTree([...owned.values()]);
}

const controllerSource = `
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const home=process.env.HOME, runtime=join(home,'.ftown','cli','dist');
const {runBridge}=await import(pathToFileURL(join(runtime,'index.js')).href);
const {createUpdateReleaseApi}=await import(pathToFileURL(join(runtime,'update-release.js')).href);
const {reserveUpdate,writeUpdateReceipt,prepareHandoff}=await import(pathToFileURL(join(runtime,'update-handoff.js')).href);
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
await runBridge(['--local','--allow-updates'], 'ftown start');
process.send({type:'started'});
process.on('message', async message => {
 if (message?.type!=='stage') return;
 try {
  const pointer=JSON.parse(await readFile(join(home,'.ftown','bridge.json'),'utf8'));
  const op=randomUUID(), stagingRoot=join(home,'.ftown','updates');
  const metadata={name:'ftown',version:config.version,gitHead:'0'.repeat(40),engines:{node:config.engine},dist:{tarball:'https://registry.npmjs.org/ftown/-/ftown-'+config.version+'.tgz',integrity:config.integrity}};
  const api=createUpdateReleaseApi({read:async (url,limit,signal) => {
    signal.throwIfAborted();
    const bytes=url==='https://registry.npmjs.org/ftown/latest' ? Buffer.from(JSON.stringify(metadata)) :
      url===metadata.dist.tarball ? await readFile(config.tarball) : (()=>{throw new Error('Unexpected fixture URL');})();
    if(bytes.length>limit) throw new Error('Fixture too large'); return bytes;
  }});
  const release=await api.resolveStableRelease(AbortSignal.timeout(15000));
  await reserveUpdate(home,op);
  const operation={id:op,targetVersion:config.version,phase:'staging',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:null};
  await writeUpdateReceipt(stagingRoot,{schema:1,bridgeId:pointer.bridgeId,operation});
  const prepared=await api.prepareRelease(release,{operationId:op,stagingRoot,signal:AbortSignal.timeout(300000)});
  const descriptor={mode:'local',home,dataDir:join(home,'.ftown','data'),cwd:home,apiUrl:pointer.apiUrl,bridgeId:pointer.bridgeId,ownerId:pointer.ownerId,endpointId:pointer.endpoint.id};
  const handoff=await prepareHandoff(prepared,descriptor,AbortSignal.timeout(15000));
  const lock=JSON.parse(await readFile(join(home,'.ftown','update-reservation.json'),'utf8'));
  process.send({type:'prepared',op,helperPid:lock.ownerPid});
  operation.phase='restarting'; operation.updatedAt=new Date().toISOString();
  await writeUpdateReceipt(stagingRoot,{schema:1,bridgeId:pointer.bridgeId,operation});
  await handoff.commit(); process.send({type:'committed',op,helperPid:lock.ownerPid});
 } catch { process.send({type:'error'}); }
});`;

try {
  const info = JSON.parse(await readFile(join(bridge, 'package.json'), 'utf8'));
  const parts = info.version.split('.').map(Number);
  assert.equal(parts.length, 3); assert(parts.every(Number.isSafeInteger)); parts[2]++;
  const version = parts.join('.');
  phase = 'fixture';
  for (const dir of ['dist', 'bin', 'hooks', 'pi-extension', 'claude-mod', 'opencode-plugin', 'muse-plugin', 'skills'])
    await cp(join(bridge, dir), join(fixture, dir), { recursive: true });
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...info, name: 'ftown', version, ftownUpdateProtocol: 1 }), { mode: 0o600 });
  await command('pack', join(dirname(process.execPath), 'npm'), ['pack', '--ignore-scripts', '--pack-destination', root], fixture, 60_000);
  const tarball = join(root, `ftown-${version}.tgz`);
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  const configPath = join(root, 'fixture.json');
  await writeFile(configPath, JSON.stringify({ version, engine: info.engines.node, integrity, tarball }), { mode: 0o600 });
  phase = 'initial setup';
  await command('setup', process.execPath, [join(bridge, 'dist', 'ftown-cli.js'), 'setup'], home);
  const controllerPath = join(root, 'controller.mjs'); await writeFile(controllerPath, controllerSource, { mode: 0o600 });
  controllerLog = openSync(join(logs, 'controller.log'), 'w', 0o600);
  old = fork(controllerPath, [configPath], { cwd: home, env, stdio: ['ignore', controllerLog, controllerLog, 'ipc'] });
  unidentified.add(old.pid);
  const oldIdentity = await remember(old.pid); unidentified.delete(old.pid);
  const messages = []; old.on('message', message => messages.push(message));
  phase = 'old bridge';
  await waitFor(() => messages.find(m => m.type === 'started'), 30_000, 'old controller startup');
  const before = await waitFor(async () => { const p = await json(pointerPath); return p?.pid === old.pid && await status(old.pid) ? p : null; }, 45_000, 'authenticated old bridge');
  assert.equal(before.ownerId, `solo:${before.bridgeId}`); assert(before.endpoint?.id && before.port);
  old.send({ type: 'stage' });
  phase = 'real npm staging and helper preparation';
  const prepared = await waitFor(() => { if (messages.some(m => m.type === 'error')) throw new Error('Controller staging failed'); return messages.find(m => m.type === 'prepared'); }, 320_000, 'prepared helper');
  helperIdentity = await remember(prepared.helperPid, old.pid);
  const committed = await waitFor(() => { if (messages.some(m => m.type === 'error')) throw new Error('Controller handoff failed'); return messages.find(m => m.type === 'committed'); }, 20_000, 'commit acknowledgement');
  assert.equal(committed.op, prepared.op);
  phase = 'old bridge shutdown';
  await signalOwned(oldIdentity, 'SIGTERM');
  const oldExitDeadline = Date.now() + 20_000;
  while (Date.now() < oldExitDeadline) {
    const current = await identity(oldIdentity.pid);
    if (!current || current.state === 'Z' || current.start !== oldIdentity.start) break;
    const observed = await json(pointerPath);
    assert(!observed || observed.pid === oldIdentity.pid, 'replacement pointer appeared while old bridge lived');
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const child = await identity(Number(name));
      if (!child || child.ppid !== helperIdentity.pid) continue;
      let argv;
      try { argv = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0'); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
      assert(!(argv.includes(installed) && argv.includes('start')), 'replacement spawned while old bridge lived');
    }
    await sleep(10);
  }
  await awaitExit(oldIdentity, 1);
  phase = 'replacement';
  const after = await waitFor(async () => {
    const p = await json(pointerPath);
    if (!p || p.pid === old.pid) return null;
    if (!replacementIdentity) replacementIdentity = await remember(p.pid, helperIdentity.pid);
    return p;
  }, 90_000, 'owned replacement pointer');
  assert.equal(after.pid, replacementIdentity.pid); assert.equal(after.bridgeId, before.bridgeId);
  assert.equal(after.ownerId, before.ownerId); assert.equal(after.endpoint.id, before.endpoint.id); assert.equal(after.port, before.port);
  const receipt = await waitFor(async () => { const r = await json(receiptPath); if (r?.operation.phase === 'failed') throw new Error('Helper reported failure'); return r?.operation.phase === 'succeeded' ? r : null; }, 90_000, 'successful private receipt');
  assert.equal(receipt.bridgeId, before.bridgeId); assert.equal(receipt.operation.id, prepared.op); assert.equal(receipt.operation.targetVersion, version);
  assert.equal(JSON.parse(await readFile(join(home, '.ftown', 'cli', 'package.json'), 'utf8')).version, version);
  await waitFor(() => status(replacementIdentity.pid), 30_000, 'authenticated replacement harness status');
  await awaitExit(helperIdentity, 20_000);
  console.log(`PASS: local fixture ${info.version} -> ${version}; same bridge identity and port; authenticated replacement ready`);
} catch (error) {
  // Logs remain private and are not printed; retained scratch path is useful if cleanup cannot prove exit.
  console.error(`FAIL during ${phase}: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  if (controllerLog !== undefined) closeSync(controllerLog);
  try {
    for (const pid of unidentified) {
      const candidate = await identity(pid);
      if (candidate && candidate.state !== 'Z') throw new Error('Cannot establish a spawned process identity');
    }
    // If failure occurred before the prepared IPC, recover only the task-owned helper
    // whose parent is the controller and whose reservation lives in this private HOME.
    if (!helperIdentity && old) {
      const lock = await json(reservationPath);
      if (lock?.ownerPid && lock.ownerPid !== old.pid) {
        const candidate = await identity(lock.ownerPid);
        if (candidate && candidate.state !== 'Z') {
          if (candidate.ppid !== old.pid) throw new Error('Cannot prove helper ownership after controller exit');
          helperIdentity = await remember(candidate.pid, old.pid);
        }
      }
    }
    const lastPointer = await json(pointerPath);
    if (lastPointer?.pid && old && lastPointer.pid !== old.pid && !replacementIdentity) {
      const candidate = await identity(lastPointer.pid);
      if (candidate && candidate.state !== 'Z') {
        if (!helperIdentity || candidate.ppid !== helperIdentity.pid) throw new Error('Cannot prove replacement ownership');
        replacementIdentity = await remember(candidate.pid, helperIdentity.pid);
      }
    }
    await cleanupOwned();
    await rm(root, { recursive: true, force: true });
  } catch {
    console.error(`Cleanup could not prove all owned processes exited; scratch retained at ${root}`);
    process.exitCode = 1;
  }
}
