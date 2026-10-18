// ROOT EXECUTION ONLY: run after the combined bridge build and all writers stop.
// Real copied package + installed CLI, isolated local bridge, no cloud/database.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bridge = join(root, 'bridge');
const { copyProductionDependencies } = await import(pathToFileURL(join(bridge, 'dist/production-dependencies.js')).href);
const { RUNTIME_DIRECTORIES } = await import(pathToFileURL(join(bridge, 'dist/installation-manifest.js')).href);
const version = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'ftown-start-smoke-'));
const home = join(temporary, 'home');
const work = join(temporary, 'work');
const bin = join(temporary, 'bin');
const source = join(temporary, 'npm-cache', 'node_modules', 'ftown');
for (const dir of [home, work, bin, source]) mkdirSync(dir, { recursive: true });
for (const [name, path] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(path, join(bin, name));
const env = { HOME: home, USERPROFILE: home, PATH: bin, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const ftown = join(home, '.ftown');
const installed = join(ftown, 'ftown');
const statePath = join(ftown, 'setup-state.json');
let running;
let output = '';
const ownedSessions = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function invoke(file, args, code = 0) {
  try {
    const result = await exec(file, args, { env, cwd: work, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(code, 0, `Expected failure: ${file} ${args.join(' ')}`);
    return result;
  } catch (error) {
    assert.equal(error.code, code, `${file} ${args.join(' ')}: ${error.stderr ?? error.message}`);
    return error;
  }
}

function snapshot() {
  const files = {};
  function walk(path, relative) {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    else files[relative] = { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mtime: stat.mtimeMs };
  }
  for (const path of ['.agents', '.claude', '.cursor', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.ftown/cli', '.ftown/skills', '.ftown/pi', '.ftown/notify.sh', '.ftown/harness-agent.md', '.ftown/ftown', '.ftown/ftown-env', '.ftown/ftown-sessions', '.ftown/bin', '.ftown/setup-state.json']) walk(join(home, path), path);
  return files;
}

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    if (running && running.exitCode !== null) throw new Error(`${message}: bridge exited ${running.exitCode}\n${output}`);
    await sleep(100);
  }
  throw new Error(`${message}\n${output.slice(-5000)}`);
}

async function start(file, args) {
  assert.equal(running, undefined);
  output = '';
  running = spawn(file, args, { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.stdout.on('data', (chunk) => { output += chunk; });
  running.stderr.on('data', (chunk) => { output += chunk; });
  const pointer = await until(() => {
    if (!existsSync(join(ftown, 'bridge.json'))) return undefined;
    const candidate = JSON.parse(readFileSync(join(ftown, 'bridge.json'), 'utf8'));
    return candidate.pid === running.pid ? candidate : undefined;
  }, 'local bridge pointer');
  await until(() => output.includes('[Bridge] Ready and listening for commands'), 'local bridge ready');
  return pointer;
}

async function stop() {
  if (!running) return;
  const child = running;
  if (child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([done, sleep(6000)]);
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await done;
    }
  }
  running = undefined;
  assert.equal(existsSync(join(ftown, 'bridge.json')), false, 'owned pointer is removed on shutdown');
}

async function api(pointer, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${pointer.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${pointer.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function checkRuntime(pointer) {
  assert.equal(JSON.parse((await invoke(installed, ['harness', '--json', 'status'])).stdout).bridge, 'up');
  await invoke(join(ftown, 'bin/ftown-harness'), ['--json', 'status']);
  await invoke(join(ftown, 'ftown-sessions'), ['list']);
  const before = await api(pointer, 'GET', '/api/sessions');
  assert.match((await invoke(installed, ['sessions', 'create', '--help'])).stdout, /Usage: ftown sessions create/);
  const after = await api(pointer, 'GET', '/api/sessions');
  assert.deepEqual(after, before, 'create --help cannot create a session');
  const session = (await api(pointer, 'POST', '/api/sessions', { shellType: 'shell', command: '/bin/cat', name: 'canonical-start-smoke', workingDir: work })).session;
  ownedSessions.add(session.id);
  assert.match((await invoke(installed, ['sessions', 'list'])).stdout, /canonical-start-smoke/);
  await api(pointer, 'DELETE', `/api/sessions/${session.id}`);
  ownedSessions.delete(session.id);
}

try {
  for (const path of [...RUNTIME_DIRECTORIES, 'package.json']) cpSync(join(bridge, path), join(source, path), { recursive: true });
  copyProductionDependencies(bridge, source);
  const packageEntry = join(source, 'dist/ftown-cli.js');
  chmodSync(packageEntry, 0o755);
  const packageBin = join(temporary, 'npm-ftown');
  symlinkSync(packageEntry, packageBin); // Same npm bin-symlink entry shape.
  const help = await invoke(packageBin, ['start', '--help']);
  assert.match(help.stdout, /Usage: ftown start/);
  assert.deepEqual(readdirSync(home), [], 'help cannot write setup or runtime data');
  const missing = await invoke(packageBin, ['start', '--local'], 1);
  assert.match(missing.stderr, new RegExp(`npx ftown@${version.replaceAll('.', '\\.')} setup`));
  assert.deepEqual(readdirSync(home), [], 'missing setup cannot start, install or migrate');
  assert.match((await invoke(process.execPath, [join(source, 'dist/index.js'), '--help'])).stdout, /Usage: ftown-bridge/);

  assert.match((await invoke(packageBin, ['setup'])).stdout, /installed/);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).packageVersion, version);
  const current = snapshot();
  assert.match((await invoke(installed, ['setup'])).stdout, /current/);
  assert.deepEqual(snapshot(), current, 'same-version setup is read-only');
  await invoke(installed, ['setup', '--repair']);
  const ready = snapshot();
  await checkRuntime(await start(packageBin, ['start', '--local', '--api-url', 'http://127.0.0.1']));
  await stop();
  assert.deepEqual(snapshot(), ready, 'package start cannot rewrite integrations');

  rmSync(join(ftown, 'cli/dist/harness-commands.js'));
  const incomplete = snapshot();
  assert.match((await invoke(packageBin, ['start', '--local'], 1)).stderr, /--repair/);
  assert.deepEqual(snapshot(), incomplete, 'incomplete runtime is rejected without repair');
  await invoke(packageBin, ['setup', '--repair']);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.1' }));
  assert.match((await invoke(packageBin, ['setup', '--repair'], 1)).stderr, /newer/);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).packageVersion, version);
  rmSync(join(temporary, 'npm-cache'), { recursive: true });
  assert.equal(existsSync(packageEntry), false);
  await invoke(installed, ['setup', '--repair']);
  const cacheIndependent = snapshot();
  assert.match((await invoke(installed, ['start', '--help'])).stdout, /Usage: ftown start/);
  assert.match((await invoke(installed, ['sessions', 'create', '--help'])).stdout, /Usage: ftown sessions create/);
  assert.deepEqual(snapshot(), cacheIndependent, 'installed help is read-only after npm cache removal');
  await checkRuntime(await start(installed, ['start', '--local', '--api-url', 'http://127.0.0.1']));
  await stop();
  assert.deepEqual(snapshot(), cacheIndependent, 'installed restart cannot rewrite integrations');
  const soloData = join(temporary, 'solo');
  assert.match((await invoke(installed, ['start', '--solo', '--rotate-key', '--port', '8047', '--data-dir', soloData])).stdout, /access key rotated/);
  assert.match(readFileSync(join(soloData, 'solo/access-key-hash'), 'utf8'), /^[a-f0-9]{64}\n$/);
  assert.equal(existsSync(join(soloData, 'local-api-port')), false, 'offline rotation cannot bind listeners');
  assert.deepEqual(snapshot(), cacheIndependent, 'offline rotation cannot rewrite integrations');
  console.log(JSON.stringify({ result: 'PASS', version, localStarts: ['npm-package-bin', 'installed-after-cache-removal'], setup: 'fresh/current/repair/incomplete/downgrade-guard', help: 'start/create read-only', solo: 'offline rotate-key forwarding; full panel/hub startup not exercised', cloud: false, database: false, cleanup: 'owned processes/sessions/scratch HOME removed' }));
} finally {
  if (running && existsSync(join(ftown, 'bridge.json'))) {
    try {
      const pointer = JSON.parse(readFileSync(join(ftown, 'bridge.json'), 'utf8'));
      if (pointer.pid === running.pid) for (const id of ownedSessions) await api(pointer, 'DELETE', `/api/sessions/${id}`);
    } catch {}
  }
  try { await stop(); } finally { rmSync(temporary, { recursive: true, force: true }); }
}
