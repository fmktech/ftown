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
const temporary = mkdtempSync(join(tmpdir(), 'ftown-native-bridge-'));
const home = join(temporary, 'home'), work = join(temporary, 'work'), bin = join(temporary, 'bin');
const source = join(temporary, 'cache/node_modules/ftown');
for (const directory of [home, work, bin, source]) mkdirSync(directory, { recursive: true });
for (const [name, file] of [['node', process.execPath], ['bash', '/bin/bash'], ['sh', '/bin/sh']]) symlinkSync(file, join(bin, name));
const receiptPath = join(temporary, 'native-wakes.jsonl');
// The fake CLI only accepts queue/help; it never launches a model or network.
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ') === 'queue --help') { console.log('Usage: codex queue --thread ID --message TEXT'); process.exit(0); }
if (args[0] !== 'queue' || args[1] !== '--thread' || args[3] !== '--message') process.exit(2);
fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({thread:args[2],text:args[4]})+'\\n');
console.log('Queued message 00000000-0000-4000-8000-000000000099 for thread '+args[2]+'.');
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
let pointer, secureApi;
async function api(method, path, body, expected = 200) {
  const response = await secureApi(pointer, method, path, body, undefined, AbortSignal.timeout(10_000));
  assert.equal(response.status, expected, JSON.stringify(response.body)); return response.body;
}
async function create(shellType, native = {}) {
  const data = await api('POST', '/api/sessions', { shellType, command: '/bin/cat', name: `native-${shellType}`, workingDir: work, ...native }, 201);
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
try {
  for (const path of new Set([...RUNTIME_DIRECTORIES, 'claude-mod', 'package.json'])) cpSync(join(bridge, path), join(source, path), { recursive: true });
  copyProductionDependencies(bridge, source);
  const entry = join(source, 'dist/ftown-cli.js'); chmodSync(entry, 0o755);
  const packageBin = join(temporary, 'package-ftown'); symlinkSync(entry, packageBin);
  await exec(packageBin, ['setup'], { env, cwd: work, timeout: 30_000 });
  assert.equal(JSON.parse(readFileSync(join(ftown, 'setup-state.json'), 'utf8')).packageVersion, version);
  assert.equal(existsSync(join(ftown, 'claude-plugin')), true, 'setup copies Claude Mod assets');
  rmSync(join(temporary, 'cache'), { recursive: true, force: true });
  ({ apiResponse: secureApi } = await import(pathToFileURL(join(ftown, 'cli/dist/cli-client.js')).href));
  child = spawn(installed, ['start', '--local', '--api-url', 'http://127.0.0.1'], { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  pointer = await until(() => {
    const path = join(ftown, 'bridge.json'); if (!existsSync(path)) return;
    const candidate = JSON.parse(readFileSync(path, 'utf8')); return candidate.pid === child.pid ? candidate : undefined;
  }, 'pointer');
  await until(() => output.includes('[Bridge] Ready and listening for commands'), 'bridge readiness');
  assert.equal(JSON.parse((await cli(['harness', '--json', 'status'])).stdout).bridge, 'up');
  const nativeID = '00000000-0000-4000-8000-000000000001';
  const codex = await create('codex', { codexSessionId: nativeID });
  await cli(['harness', 'mail', 'send', codex.id, 'private payload must remain in mailbox']);
  const receipts = await until(() => existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : undefined, 'native wake receipt');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].thread, nativeID);
  assert.match(receipts[0].text, /ftown harness mail read/); assert.ok(!receipts[0].text.includes('private payload'));
  const queued = (await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).messages;
  assert.equal(queued.length, 1); assert.equal(queued[0].deliveredAt, undefined);
  const peek = JSON.parse((await cli(['harness', 'mail', 'read', '--peek', '--json'], { FTOWN_SESSION_ID: codex.id })).stdout);
  assert.equal(peek.messages[0].id, queued[0].id);
  assert.equal((await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).messages.length, 1, 'CLI peek never acknowledges');
  const read = JSON.parse((await cli(['harness', 'mail', 'read', '--json'], { FTOWN_SESSION_ID: codex.id })).stdout);
  assert.match(read.messages[0].body, /private payload/);
  assert.equal(read.messages[0].id, queued[0].id);
  assert.equal(read.messages[0].deliveredAt, undefined, 'CLI output contains the non-consuming fetch before acknowledgment');
  const history = (await api('GET', `/api/sessions/${codex.id}/inbox?peek=1&all=1`)).messages;
  assert.equal(history[0].deliveredVia, 'cli'); assert.ok(history[0].deliveredAt, 'completed output is acknowledged');
  assert.deepEqual((await api('POST', `/api/sessions/${codex.id}/inbox/ack`, { ids: [queued[0].id] })).acknowledgedIds, [], 'ack retry is idempotent');
  assert.equal(JSON.parse((await cli(['harness', 'mail', 'read', '--json'], { FTOWN_SESSION_ID: codex.id })).stdout).messages.length, 0);
  for (const body of ['first page task', 'second page task', 'next page task']) {
    await cli(['harness', 'mail', 'send', codex.id, '--type', 'fyi', body]);
  }
  const sessionEnv = { FTOWN_SESSION_ID: codex.id };
  const firstPage = JSON.parse((await cli(['sessions', 'inbox', '--limit', '2', '--json'], sessionEnv)).stdout);
  assert.deepEqual(firstPage.messages.map(message => message.body), ['first page task', 'second page task']);
  assert.equal(firstPage.moreAvailable, true);
  assert.equal((await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).messages.length, 1, 'only displayed rows are acknowledged');
  const nextPage = JSON.parse((await cli(['sessions', 'mail', '--json'], sessionEnv)).stdout);
  assert.deepEqual(nextPage.messages.map(message => message.body), ['next page task']);
  assert.equal(nextPage.moreAvailable, false);
  const historyPage = JSON.parse((await cli(['sessions', 'inbox', '--all', '--limit', '1', '--json'], sessionEnv)).stdout);
  assert.equal(historyPage.messages[0].id, queued[0].id);
  assert.equal(historyPage.nextOffset, 1);
  const largeBody = '\0'.repeat(20000);
  const largeSender = 'sender'.repeat(5000);
  const large = await api('POST', `/api/sessions/${codex.id}/inbox`, { body: largeBody, fromName: largeSender, threadId: 'exact-thread', type: 'fyi' }, 201);
  const descriptorPage = JSON.parse((await cli(['sessions', 'inbox', '--json'], sessionEnv)).stdout);
  assert.deepEqual(descriptorPage.messages, []);
  assert.equal(descriptorPage.oversizedMessages[0].id, large.id);
  let cursor;
  const bodyParts = [], metadataParts = [];
  for (;;) {
    const text = (await cli(['harness', 'mail', 'read', '--message-id', large.id, ...(cursor ? ['--cursor', cursor] : []), '--json'], sessionEnv)).stdout;
    assert.ok(Buffer.byteLength(text) < 100000);
    const part = JSON.parse(text); bodyParts.push(part.body.chunk); metadataParts.push(part.metadata.chunk);
    if (part.complete) break;
    assert.equal((await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).oversizedMessages[0].id, large.id, 'intermediate chunks never acknowledge');
    cursor = part.nextCursor;
  }
  assert.equal(bodyParts.join(''), largeBody);
  const originalMetadata = JSON.parse(metadataParts.join(''));
  assert.equal(originalMetadata.fromName, largeSender); assert.equal(originalMetadata.threadId, 'exact-thread');
  assert.equal(Object.hasOwn(originalMetadata, 'body'), false);
  assert.equal((await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).messages.length, 0);
  assert.equal((await api('GET', `/api/sessions/${codex.id}/inbox?peek=1`)).oversizedMessages.length, 0, 'only completed chunk output acknowledges');
  const claude = await create('claude', { claudeSessionId: nativeID });
  const heartbeat = `/api/sessions/${claude.id}/inbox?peek=1&wait=0&adapter=claude-mod&nativeSessionId=${nativeID}`;
  await api('GET', heartbeat);
  await api('GET', `/api/sessions/${claude.id}/inbox?adapter=claude-mod`, undefined, 400);
  await api('GET', heartbeat.replace(nativeID, 'mismatched'), undefined, 409);
  await api('POST', `/api/sessions/${claude.id}/stop`, {});
  await until(async () => !(await api('GET', `/api/sessions/${claude.id}/running`)).running, 'stopped process');
  await api('GET', heartbeat, undefined, 409);
  for (const id of owned) await api('DELETE', `/api/sessions/${id}`); owned.clear();
  console.log(JSON.stringify({ result:'PASS', version, copiedPackage:true, cacheIndependent:true, realLocalBridge:true, harnessStatus:true, nativeWake:'stub command admission; pointer only; pending until CLI output and idempotent acknowledgment', heartbeat:'valid/malformed/mismatch/stopped', realProvider:false, cloud:false, database:false }));
} finally {
  if (child && pointer) for (const id of owned) { try { await api('DELETE', `/api/sessions/${id}`); } catch {} }
  try { await stop(); } finally { rmSync(temporary, { recursive:true, force:true }); }
}
