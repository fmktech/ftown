// ROOT EXECUTION ONLY, after combined build. No real harness/provider/cloud/DB.
// Real copied npm-shaped package, isolated HOME/PATH, installed local bridge.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { copyProductionDependencies } = await import(pathToFileURL(join(bridge, 'dist/production-dependencies.js')).href);
const { RUNTIME_DIRECTORIES } = await import(pathToFileURL(join(bridge, 'dist/installation-manifest.js')).href);
const version = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'ftown-mail-recovery-'));
const home = join(temporary, 'home'), work = join(temporary, 'work'), bin = join(temporary, 'bin');
const source = join(temporary, 'cache/node_modules/ftown');
for (const directory of [home, work, bin, source]) mkdirSync(directory, { recursive: true });
// /etc/zprofile may replace PATH for the login shell used by direct PTYs.
// Restore the isolated executable directory before any receiver command runs.
writeFileSync(join(home, '.zprofile'), `export PATH=${JSON.stringify(bin)}\n`);
for (const [name, file] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(file, join(bin, name));
const receiptPath = join(temporary, 'native-wakes.jsonl');
// ROOT EXECUTION ONLY: fake Codex has no provider/model/network path. Normal
// launch/resume is a harmless persistent stdin receiver; queue records pointers.
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ') === 'queue --help') { console.log('Usage: codex queue --thread ID --message TEXT'); process.exit(0); }
if (args[0] === 'queue') {
  if (args[1] !== '--thread' || args[3] !== '--message') process.exit(2);
  fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({thread:args[2],text:args[4]})+'\\n');
  console.log('Queued message 00000000-0000-4000-8000-000000000099 for thread '+args[2]+'.');
  process.exit(0);
}
console.log('FAKE_RECEIVER_READY');
process.stdin.resume();
process.stdin.on('data', chunk => { if (chunk.toString().includes('private payload')) process.exit(7); });
`;
writeFileSync(join(bin, 'codex'), stub, { mode: 0o755 });
const env = { HOME: home, USERPROFILE: home, PATH: bin, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const ftown = join(home, '.ftown'), installed = join(ftown, 'ftown');
const owned = new Set();
let child; let output = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`Bridge exited: ${output}`);
    await sleep(100);
  }
  throw new Error(`${label}: ${output.slice(-4000)}`);
}
async function cli(args, extra = {}) {
  return exec(installed, args, { cwd: work, env: { ...env, ...extra }, timeout: 30_000, maxBuffer: 2_000_000 });
}
let pointer;
async function api(method, path, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${pointer.port}${path}`, {
    method, headers: { Authorization: `Bearer ${pointer.token}`, ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function create(shellType, native = {}) {
  const data = await api('POST', '/api/sessions', { shellType, command: 'codex', name: `native-${shellType}`, workingDir: work, ...native }, 201);
  owned.add(data.session.id); return data.session;
}
async function stop() {
  if (!child) return;
  const running = child;
  if (running.exitCode === null) {
    const done = once(running, 'exit'); running.kill('SIGTERM');
    await Promise.race([done, sleep(6_000)]);
    if (running.exitCode === null) { try { process.kill(-running.pid, 'SIGKILL'); } catch {} await done; }
  }
  child = undefined;
}
async function start() {
  output = '';
  child = spawn(installed, ['start', '--local', '--api-url', 'http://127.0.0.1'], { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  pointer = await until(() => {
    const path = join(ftown, 'bridge.json'); if (!existsSync(path)) return;
    const candidate = JSON.parse(readFileSync(path, 'utf8')); return candidate.pid === child.pid ? candidate : undefined;
  }, 'pointer');
  await until(() => output.includes('[Bridge] Ready and listening for commands'), 'bridge readiness');
  assert.equal(JSON.parse((await cli(['harness', '--json', 'status'])).stdout).bridge, 'up');
}
function receipts() {
  return existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
try {
  for (const path of new Set([...RUNTIME_DIRECTORIES, 'claude-mod', 'package.json'])) cpSync(join(bridge, path), join(source, path), { recursive: true });
  copyProductionDependencies(bridge, source);
  const entry = join(source, 'dist/ftown-cli.js'); chmodSync(entry, 0o755);
  const packageBin = join(temporary, 'package-ftown'); symlinkSync(entry, packageBin);
  await exec(packageBin, ['setup'], { env, cwd: work, timeout: 30_000 });
  assert.equal(JSON.parse(readFileSync(join(ftown, 'setup-state.json'), 'utf8')).packageVersion, version);
  assert.equal(existsSync(join(ftown, 'claude-plugin')), true, 'setup copies Claude Mod assets');
  rmSync(join(temporary, 'cache'), { recursive: true, force: true });
  await start();
  const nativeID = '00000000-0000-4000-8000-000000000001';
  const receiver = await create('codex', { codexSessionId: nativeID });
  await until(async () => (await api('GET', `/api/sessions/${receiver.id}/running`)).running, 'fake receiver');
  await api('POST', `/api/sessions/${receiver.id}/stop`, {});
  await until(async () => !(await api('GET', `/api/sessions/${receiver.id}/running`)).running, 'stopped receiver');
  const payload = 'private payload must remain in durable mailbox';
  await cli(['harness', 'mail', 'send', receiver.id, payload]);
  await sleep(6_200); // expire the original five-second native wake while stopped
  assert.equal(receipts().length, 0, 'stopped receiver gets no wake');
  assert.equal((await api('GET', `/api/sessions/${receiver.id}/inbox?peek=1`)).messages.length, 1);
  const retried = await api('POST', `/api/sessions/${receiver.id}/retry`, {});
  assert.equal(retried.session.id, receiver.id);
  await until(() => receipts().length === 1, 'retry readiness recovers pending wake');
  assert.equal(receipts()[0].thread, nativeID);
  assert.match(receipts()[0].text, /ftown harness mail read/);
  assert.ok(!receipts()[0].text.includes('private payload'));
  assert.equal((await api('GET', `/api/sessions/${receiver.id}/inbox?peek=1`)).messages.length, 1, 'pointer never consumes payload');
  await sleep(6_200);
  assert.equal(receipts().length, 1, 'same unread batch stays suppressed within bridge lifetime');
  await stop();
  await start();
  await until(() => receipts().length === 2, 'restart attachment recovers persisted unread inbox');
  assert.equal(receipts()[1].thread, nativeID);
  assert.equal((await api('GET', `/api/sessions/${receiver.id}/running`)).running, true);
  const drained = JSON.parse((await cli(['harness', 'mail', 'read', '--json'], { FTOWN_SESSION_ID: receiver.id })).stdout);
  assert.equal(drained.messages.length, 1);
  assert.equal(drained.messages[0].body, payload);
  const again = JSON.parse((await cli(['harness', 'mail', 'read', '--json'], { FTOWN_SESSION_ID: receiver.id })).stdout);
  assert.equal(again.messages.length, 0, 'payload is consumed once');
  await sleep(6_200);
  assert.equal(receipts().length, 2, 'no duplicate wake storm');
  for (const id of owned) await api('DELETE', `/api/sessions/${id}`); owned.clear();
  console.log(JSON.stringify({ result:'PASS', version, copiedInstalledPackage:true, realLocalBridge:true,
    stoppedTimerExpired:true, retryRecovered:true, restartRecovered:true, nativeWake:'fake command; pointer only',
    inboxDrain:'one payload then empty', restartWakeSemantics:'at least once; in-memory attempt suppression',
    harnessStatus:true, realProvider:false, cloud:false, database:false }));
} finally {
  if (child && pointer) for (const id of owned) { try { await api('DELETE', `/api/sessions/${id}`); } catch {} }
  try { await stop(); } finally { rmSync(temporary, { recursive:true, force:true }); }
}
