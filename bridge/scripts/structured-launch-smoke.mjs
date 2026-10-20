// ROOT EXECUTION ONLY after combined build; scratch HOME uses an ephemeral local API port.
// No real harness/provider/cloud/DB: every agent is a harmless scratch executable.
// Real copied npm-shaped package, isolated HOME/PATH, installed local bridge.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { copyProductionDependencies } = await import(pathToFileURL(join(bridge, 'dist/production-dependencies.js')).href);
const { RUNTIME_DIRECTORIES } = await import(pathToFileURL(join(bridge, 'dist/installation-manifest.js')).href);
const version = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'ftown-structured-launch-'));
const home = join(temporary, 'home'), work = join(temporary, 'work'), bin = join(temporary, 'bin');
const source = join(temporary, 'cache/node_modules/ftown');
for (const directory of [home, work, bin, source]) mkdirSync(directory, { recursive: true });
for (const [name, file] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(file, join(bin, name));
const receiptPath = join(temporary, 'launches.jsonl');
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.302 (Claude Code)'); process.exit(0); }
const record = value => fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({pid:process.pid,session:process.env.FTOWN_SESSION_ID,...value})+'\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', chunk => record({type:'input',text:chunk.toString()}));
process.stdin.resume();
record({type:'launch',args,cwd:process.cwd(),setting:process.env.FIXTURE_SETTING});
`;
writeFileSync(join(bin, 'claude'), stub, { mode: 0o755 });
// zsh -l reads /etc/zprofile first; fence its PATH before any fake-agent launch.
// The test HOME has no user profiles, credentials or real harness executables.
writeFileSync(join(home, '.zprofile'), `export PATH='${bin}'\n`);
const env = { HOME: home, USERPROFILE: home, PATH: bin, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const ftown = join(home, '.ftown'), installed = join(ftown, 'ftown');
const owned = new Set();
let child; let pointer; let output = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function receipts(session) {
  if (!existsSync(receiptPath)) return [];
  return readFileSync(receiptPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value => value.session === session);
}
async function until(check, label, milliseconds = 20_000, diagnostics = () => undefined) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`Bridge exited: ${output}`);
    await sleep(100);
  }
  throw new Error(`${label}: receipts=${JSON.stringify(diagnostics())}; bridge=${output.slice(-4000)}`);
}
async function api(method, path, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${pointer.port}${path}`, {
    method, headers: { Authorization: `Bearer ${pointer.token}`, ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function create(input) {
  const { session } = await api('POST', '/api/sessions', { name:'structured-fixture', workingDir:work, ...input }, 201);
  owned.add(session.id);
  const launch = await until(() => receipts(session.id).find(value => value.type === 'launch'), 'fake CLI launch');
  return { session, launch };
}
async function remove(id) { await api('DELETE', `/api/sessions/${id}`); owned.delete(id); }
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
try {
  for (const path of [...RUNTIME_DIRECTORIES, 'package.json']) cpSync(join(bridge, path), join(source, path), { recursive:true });
  copyProductionDependencies(bridge, source);
  const entry = join(source, 'dist/ftown-cli.js'); chmodSync(entry, 0o755);
  const packageBin = join(temporary, 'package-ftown'); symlinkSync(entry, packageBin);
  await exec(packageBin, ['setup'], { env, cwd:work, timeout:30_000 });
  assert.equal(JSON.parse(readFileSync(join(ftown, 'setup-state.json'), 'utf8')).packageVersion, version);
  rmSync(join(temporary, 'cache'), { recursive:true, force:true });
  child = spawn(installed, ['start', '--local', '--api-url', 'http://127.0.0.1'], { env, cwd:work, detached:true, stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  pointer = await until(() => {
    const path = join(ftown, 'bridge.json'); if (!existsSync(path)) return;
    const candidate = JSON.parse(readFileSync(path, 'utf8')); return candidate.pid === child.pid ? candidate : undefined;
  }, 'owned pointer');
  await until(() => output.includes('[Bridge] Ready and listening for commands'), 'bridge readiness');
  const status = await exec(installed, ['harness','--json','status'], { env, cwd:work, timeout:30_000 });
  assert.equal(JSON.parse(status.stdout).bridge, 'up');
  const task = "inspect today's changes; $(literal text)";
  const model = "fixture/model 'quoted'";
  const fresh = await create({ shellType:'claude', prompt:task, model, env:{FIXTURE_SETTING:'preserved'} });
  assert.equal(fresh.launch.cwd, realpathSync(work));
  assert.equal(fresh.launch.setting, 'preserved');
  assert.equal(fresh.launch.args[fresh.launch.args.indexOf('--model') + 1], model);
  assert.equal(fresh.launch.args.filter(value => value === task).length, 1);
  assert.equal(fresh.session.command.includes('literal text'), false, 'persisted base command excludes task');
  await sleep(3_000); // Beyond both legacy delayed-input timers; proves no duplicate typing.
  assert.equal(receipts(fresh.session.id).filter(value => value.type === 'input').length, 0);
  await remove(fresh.session.id);

  const native = '00000000-0000-4000-8000-000000000049';
  const followUp = 'new resume task';
  const resumed = await create({ shellType:'claude', claudeSessionId:native, prompt:followUp, model });
  assert.equal(resumed.launch.args[resumed.launch.args.indexOf('--resume') + 1], native);
  assert.equal(resumed.launch.args.includes(followUp), false);
  const input = () => receipts(resumed.session.id).filter(value => value.type === 'input').map(value => value.text).join('');
  await until(() => input().endsWith('\r'), 'resume task submitted');
  assert.equal(input(), followUp + '\r');
  await api('POST', `/api/sessions/${resumed.session.id}/stop`, {});
  await until(async () => !(await api('GET', `/api/sessions/${resumed.session.id}/running`)).running, 'resume process stopped');
  await api('POST', `/api/sessions/${resumed.session.id}/retry`, {});
  const retry = await until(() => receipts(resumed.session.id).find(value => value.type === 'launch' && value.pid !== resumed.launch.pid), 'retry launch');
  assert.deepEqual(retry.args, resumed.launch.args);
  await sleep(3_000);
  assert.equal(receipts(resumed.session.id).filter(value => value.type === 'input' && value.pid === retry.pid).length, 0, 'retry does not replay stored task');
  await remove(resumed.session.id);

  const custom = await create({ shellType:'claude', command:'claude --custom-marker', prompt:'metadata only',
    // Allow the login shell and fake TUI to initialize before raw passthrough.
    initialInput:'raw input\r', initialInputDelay:2000 });
  // Existing compatibility decorator may add --plugin-dir, but never rebuilds custom flags.
  assert.ok(custom.launch.args.includes('--custom-marker'));
  assert.equal(custom.launch.args.includes('metadata only'), false);
  const raw = () => receipts(custom.session.id).filter(value => value.type === 'input').map(value => value.text).join('');
  await until(() => raw().endsWith('\r'), 'legacy raw input', 20_000, () => receipts(custom.session.id));
  await sleep(700); assert.equal(raw(), 'raw input\r', 'caller-owned raw submit remains exactly once');
  await remove(custom.session.id);
  console.log(JSON.stringify({result:'PASS',version,copiedPackage:true,cacheIndependent:true,harnessStatus:true,
    standard:'registry model/env/workspace; quoted task once; persisted command has no task',
    resume:'native ID plus one new task; retry without replay',legacy:'custom flags/raw input preserved',realProvider:false,cloud:false,database:false}));
} finally {
  if (child && pointer) for (const id of owned) { try { await api('DELETE', `/api/sessions/${id}`); } catch {} }
  try { await stop(); } finally { rmSync(temporary, {recursive:true,force:true}); }
}
