// ROOT EXECUTION ONLY. Real package/installed CLIs + real local-only bridge.
// No cloud, native harness agents, database, user HOME or existing bridge touched.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bridge = join(root, 'bridge');
const version = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'ftown-setup-smoke-'));
const home = join(temporary, 'home'); const work = join(temporary, 'work'); const bin = join(temporary, 'bin');
for (const dir of [home, work, bin]) mkdirSync(dir);
// Only explicit harmless tools are visible; no host codex/muse/opencode or tmux.
for (const [name, file] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(file, join(bin, name));
const env = { HOME: home, USERPROFILE: home, PATH: bin, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const ftown = join(home, '.ftown'); const statePath = join(ftown, 'setup-state.json');
const source = join(temporary, 'package-cache'); mkdirSync(source);
for (const path of ['dist', 'hooks', 'pi-extension', 'opencode-plugin', 'muse-plugin', 'skills', 'package.json']) cpSync(join(bridge, path), join(source, path), { recursive: true });
mkdirSync(join(source, 'node_modules')); cpSync(join(bridge, 'node_modules/commander'), join(source, 'node_modules/commander'), { recursive: true });
const packageEntry = join(source, 'dist/ftown-cli.js'); chmodSync(packageEntry, 0o755);
const packageBin = join(temporary, 'package-ftown'); symlinkSync(packageEntry, packageBin);
const installed = join(ftown, 'ftown');
let running; let output = ''; const ownedSessions = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await sleep(100); }
  throw new Error(`${message}\n${output.slice(-5000)}`);
}
async function invoke(file, args, code = 0, extra = {}) {
  try { const result = await exec(file, args, { env: { ...env, ...extra }, cwd: work, timeout: 20000 }); assert.equal(code, 0); return result; }
  catch (error) { assert.equal(error.code, code, `${file} ${args.join(' ')}: ${error.stderr ?? error.message}`); return error; }
}
function readState() { return JSON.parse(readFileSync(statePath, 'utf8')); }
function snapshot() {
  const files = {};
  function walk(path, relative) {
    if (!existsSync(path)) return;
    const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    else files[relative] = { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mtime: stat.mtimeMs };
  }
  for (const path of ['.claude', '.cursor', '.zshenv', '.ftown/cli', '.ftown/skills', '.ftown/pi', '.ftown/notify.sh', '.ftown/harness-agent.md', '.ftown/ftown', '.ftown/ftown-env', '.ftown/ftown-sessions', '.ftown/bin', '.ftown/setup-state.json']) walk(join(home, path), path);
  return files;
}
async function start() {
  assert.equal(running, undefined);
  running = spawn(process.execPath, [join(bridge, 'dist/index.js'), '--local', '--api-url', 'http://127.0.0.1'], { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.stdout.on('data', (chunk) => { output += chunk; }); running.stderr.on('data', (chunk) => { output += chunk; });
  const pointer = await until(() => { const p = JSON.parse(readFileSync(join(ftown, 'bridge.json'), 'utf8')); return p.pid === running.pid ? p : undefined; }, 'local bridge readiness');
  return pointer;
}
async function stop() {
  if (!running) return;
  const child = running;
  if (child.exitCode === null) {
    const done = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([done, sleep(6000)]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await done; }
  }
  running = undefined;
}
async function api(pointer, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${pointer.port}${path}`, { method, headers: { Authorization: `Bearer ${pointer.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
}
async function retiredTicket() {
  const target = join(ftown, 'skills/fticket'); mkdirSync(target, { recursive: true });
  const content = (await exec('git', ['show', '4f6811c215865c839f9b6a9f3e277346bbde4b74:bridge/skills/fticket/SKILL.md'], { cwd: root })).stdout;
  writeFileSync(join(target, 'SKILL.md'), content);
}
try {
  // Missing setup fails before listener, identity/data migration or install writes.
  mkdirSync(join(work, 'data/sessions'), { recursive: true }); writeFileSync(join(work, 'data/history'), 'preserve history');
  const missing = await invoke(process.execPath, [join(bridge, 'dist/index.js'), '--local'], 1);
  assert.match(missing.stderr, new RegExp(`ftown-bridge@${version.replaceAll('.', '\\.')} -- ftown setup`));
  assert.equal(existsSync(ftown), false); assert.equal(existsSync(join(work, 'data/history')), true);
  await retiredTicket();
  mkdirSync(join(ftown, 'workflows/saved'), { recursive: true }); writeFileSync(join(ftown, 'workflows/saved/result.json'), 'keep saved run');
  mkdirSync(join(home, '.agents/skills/independent'), { recursive: true }); writeFileSync(join(home, '.agents/skills/independent/SKILL.md'), 'my skill');
  const setup = await invoke(packageBin, ['setup']); assert.match(setup.stdout, /installed/);
  assert.equal(readState().packageVersion, version); assert.equal(existsSync(join(ftown, 'skills/fticket')), false);
  assert.equal(readFileSync(join(ftown, 'data/history'), 'utf8'), 'preserve history');
  assert.equal(existsSync(join(work, 'data')), false);
  assert.equal(readFileSync(join(ftown, 'workflows/saved/result.json'), 'utf8'), 'keep saved run');
  assert.equal(readFileSync(join(home, '.agents/skills/independent/SKILL.md'), 'utf8'), 'my skill');

  // Stable cleanup IDs skip on same-version setup and upgrades; explicit repair reruns.
  await retiredTicket(); const currentBefore = snapshot();
  assert.match((await invoke(installed, ['setup'])).stdout, /current/); assert.deepEqual(snapshot(), currentBefore);
  const state = readState(); state.packageVersion = '0.0.0'; writeFileSync(statePath, JSON.stringify(state));
  const outdated = await invoke(process.execPath, [join(bridge, 'dist/index.js'), '--local'], 1); assert.match(outdated.stderr, /outdated/);
  await invoke(packageBin, ['setup']); assert.equal(existsSync(join(ftown, 'skills/fticket')), true, 'completed cleanup IDs survive version upgrade');
  await invoke(packageBin, ['setup', '--repair']); assert.equal(existsSync(join(ftown, 'skills/fticket')), false);
  // A missing required command module is caught by startup; package bootstrap repairs it.
  rmSync(join(ftown, 'cli/dist/harness-commands.js'));
  assert.match((await invoke(process.execPath, [join(bridge, 'dist/index.js'), '--local'], 1)).stderr, /--repair/);
  await invoke(packageBin, ['setup', '--repair']);
  // Stale package setup cannot downgrade the ready version.
  writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
  assert.match((await invoke(packageBin, ['setup', '--repair'], 1)).stderr, /newer/); assert.equal(readState().packageVersion, version);
  mkdirSync(join(ftown, 'skills/fticket')); writeFileSync(join(ftown, 'skills/fticket/SKILL.md'), 'my customized skill');
  symlinkSync('../../.ftown/skills/fticket', join(home, '.agents/skills/fticket'));
  rmSync(source, { recursive: true });
  await invoke(installed, ['--help']); await invoke(installed, ['setup', '--repair']); // no package cache remains
  assert.equal(readFileSync(join(ftown, 'skills/fticket/SKILL.md'), 'utf8'), 'my customized skill');
  assert.equal(lstatSync(join(home, '.agents/skills/fticket')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(ftown, 'workflows/saved/result.json'), 'utf8'), 'keep saved run');
  // Required configuration failure leaves no ready marker, then explicit repair retries.
  writeFileSync(join(home, '.claude/settings.json'), '{invalid');
  await invoke(installed, ['setup', '--repair'], 1); assert.equal(readState().packageVersion, undefined);
  writeFileSync(join(home, '.claude/settings.json'), '{}'); await invoke(installed, ['setup', '--repair']);

  const globals = snapshot(); let pointer = await start();
  assert.equal(JSON.parse((await invoke(installed, ['harness', '--json', 'status'])).stdout).bridge, 'up');
  await invoke(join(ftown, 'bin/ftown-harness'), ['--json', 'status']);
  await invoke(installed, ['sessions', 'list']); await invoke(join(ftown, 'ftown-sessions'), ['list']);
  await invoke(installed, ['env', 'ls']); await invoke(join(ftown, 'ftown-env'), ['ls']);
  const parent = (await api(pointer, 'POST', '/api/sessions', { shellType: 'shell', command: '/bin/cat', name: 'smoke-parent', workingDir: work })).session; ownedSessions.add(parent.id);
  const child = (await api(pointer, 'POST', '/api/sessions', { shellType: 'claude', command: '/bin/cat', parentSessionId: parent.id, prompt: 'ordinary child task', name: 'smoke-child', orchestrator: true, env: { FTOWN_ORCHESTRATOR: 'custom-value' }, workingDir: work, initialInputDelay: 10 })).session; ownedSessions.add(child.id);
  const screen = await until(async () => { const data = await api(pointer, 'GET', `/api/sessions/${child.id}/screen?limit=200`); const text = data.lines.join('\n'); return text.includes('ordinary child task') ? text : undefined; }, 'ordinary child task delivery');
  assert.match(screen, /child session/); assert.doesNotMatch(screen, /You are an ORCHESTRATOR|references\/orchestrator/);
  const stored = JSON.parse(readFileSync(join(ftown, 'data/sessions', child.id, 'session.json'), 'utf8'));
  assert.equal(stored.env.FTOWN_ORCHESTRATOR, 'custom-value'); assert.equal(stored.parentSessionId, parent.id);
  const legacy = JSON.parse((await invoke(installed, ['sessions', 'create', '--shell', 'shell', '--command', '/bin/cat', '--orchestrator', '--prompt', 'literal task', '--parent-id', parent.id, '--workdir', work])).stdout).session; ownedSessions.add(legacy.id);
  assert.equal(legacy.parentSessionId, parent.id);
  await invoke(installed, ['harness', 'mail', 'send', parent.id, '--type', 'result', 'root smoke result']);
  assert.match((await invoke(installed, ['sessions', 'inbox', '--json'], 0, { FTOWN_SESSION_ID: parent.id })).stdout, /root smoke result/);
  for (const id of ownedSessions) await api(pointer, 'DELETE', `/api/sessions/${id}`); ownedSessions.clear();
  await stop(); assert.deepEqual(snapshot(), globals, 'first startup cannot modify global integration files');
  pointer = await start(); await stop(); assert.deepEqual(snapshot(), globals, 'second startup cannot reinstall or migrate global integrations');
  console.log(JSON.stringify({ result: 'PASS', version, realLocalBridge: true, nativeHarnessAgents: false, database: false, setup: 'fresh/current/upgrade/repair/failure-retry/stale-version/cache-independent', normalStarts: 2, temporaryHome: home, cleanup: 'all owned sessions/processes and temporary data removed in finally' }));
} finally {
  if (running) {
    try { const pointer = JSON.parse(readFileSync(join(ftown, 'bridge.json'), 'utf8')); for (const id of ownedSessions) await api(pointer, 'DELETE', `/api/sessions/${id}`); } catch {}
  }
  await stop(); rmSync(temporary, { recursive: true, force: true });
}
