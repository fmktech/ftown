// ROOT EXECUTION ONLY after build. Isolated HOME/PATH; no cloud/provider/database.
// Prepared bare no-args startup is deliberately NOT run: it uses the cloud URL.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const bridge = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { copyProductionDependencies } = await import(pathToFileURL(join(bridge, 'dist/production-dependencies.js')).href);
const { RUNTIME_DIRECTORIES } = await import(pathToFileURL(join(bridge, 'dist/installation-manifest.js')).href);
const version = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'ftown-default-start-'));
const home = join(temporary, 'home'), work = join(temporary, 'work'), bin = join(temporary, 'bin');
const source = join(temporary, 'npm-cache/node_modules/ftown');
for (const path of [home, work, bin, source]) mkdirSync(path, { recursive: true });
for (const [name, file] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(file, join(bin, name));
const env = { HOME: home, USERPROFILE: home, PATH: bin, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const ftown = join(home, '.ftown'), installed = join(ftown, 'ftown');
let child; let output = '';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function invoke(file, args, expected = 0) {
  try {
    const result = await exec(file, args, { env, cwd: work, timeout: 30_000, maxBuffer: 2_000_000 });
    assert.equal(expected, 0, 'Expected command failure'); return result;
  } catch (error) {
    assert.equal(error.code, expected, `${file} ${args.join(' ')}: ${error.stderr ?? error.message}`); return error;
  }
}
async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`${label}: bridge exited: ${output}`);
    await sleep(100);
  }
  throw new Error(`${label}: ${output.slice(-4000)}`);
}
async function start(file, args) {
  output = '';
  child = spawn(file, args, { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await until(() => {
    const path = join(ftown, 'bridge.json'); if (!existsSync(path)) return;
    const value = JSON.parse(readFileSync(path, 'utf8')); return value.pid === child.pid ? value : undefined;
  }, 'owned bridge pointer');
  await until(() => output.includes('[Bridge] Ready and listening for commands'), 'local bridge readiness');
  assert.equal(JSON.parse((await invoke(installed, ['harness', '--json', 'status'])).stdout).bridge, 'up');
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
  assert.equal(existsSync(join(ftown, 'bridge.json')), false, 'owned bridge pointer removed');
}
try {
  for (const path of [...RUNTIME_DIRECTORIES, 'package.json']) cpSync(join(bridge, path), join(source, path), { recursive: true });
  copyProductionDependencies(bridge, source);
  const entry = join(source, 'dist/ftown-cli.js'); chmodSync(entry, 0o755);
  const packageBin = join(temporary, 'npm-ftown'); symlinkSync(entry, packageBin);
  const cold = await invoke(packageBin, [], 1);
  assert.match(cold.stderr, new RegExp(`npx ftown@${version.replaceAll('.', '\\.')} setup`));
  assert.deepEqual(readdirSync(home), [], 'cold no-args startup does not install or create runtime data');
  for (const help of ['--help', '-h', 'help']) {
    assert.match((await invoke(packageBin, [help])).stdout, /With no subcommand, start the bridge/);
    assert.deepEqual(readdirSync(home), [], 'help is read-only');
  }
  assert.match((await invoke(packageBin, ['not-a-command'], 1)).stderr, /Unknown subcommand/);
  assert.deepEqual(readdirSync(home), []);
  await invoke(packageBin, ['setup']);
  assert.equal(JSON.parse(readFileSync(join(ftown, 'setup-state.json'), 'utf8')).packageVersion, version);
  const local = ['--local', '--api-url', 'http://127.0.0.1'];
  await start(packageBin, local); await stop();
  rmSync(join(temporary, 'npm-cache'), { recursive: true, force: true });
  assert.equal(existsSync(entry), false);
  await start(installed, local); await stop();
  await start(installed, ['start', ...local]); await stop();
  console.log(JSON.stringify({ result: 'PASS', version, coldBareDefault: 'readiness error; no writes',
    explicitHelp: 'read-only', rootFlags: 'package symlink and installed alias after cache removal',
    explicitStart: true, harnessStatus: true, cloud: false, providers: false, database: false,
    cleanup: 'owned process groups and scratch HOME/cache/workspace removed' }));
} finally {
  try { await stop(); } finally { rmSync(temporary, { recursive: true, force: true }); }
}
