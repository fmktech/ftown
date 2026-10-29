// Root-only runtime smoke: cd bridge && node --import tsx ../docs/investigations/codex-direct-mail/runtime-smoke.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LocalApiServer } from '../../../bridge/src/local-api-server.js';
import { SessionStore } from '../../../bridge/src/session-store.js';
import { MailStore } from '../../../bridge/src/mail-store.js';
import { api } from '../../../bridge/src/cli-client.js';
import { loadOrCreateIdentity } from '../../../bridge/src/security/bridge/identity.js';
import { BridgeSecurityService } from '../../../bridge/src/security/bridge/security.js';
import type { Session } from '../../../bridge/src/types.js';
import type { ProcessRunner } from '../../../bridge/src/claude-runner.js';
import type { CentrifugoClient } from '../../../bridge/src/centrifugo-client.js';
import type { BridgePointer } from '../../../bridge/src/wire-types.js';

const run = promisify(execFile);
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function main(): Promise<void> {
const home = await mkdtemp(join(tmpdir(), 'ftown-codex-mail-smoke-'));
const data = join(home, 'data'); const bin = join(home, 'bin'); const log = join(home, 'argv.jsonl');
const nativeId = '00000000-0000-4000-8000-000000000001';
let server: LocalApiServer | undefined; let security: BridgeSecurityService | undefined;
try {
  await mkdir(data, { recursive: true }); await mkdir(bin);
  const script = `#!${process.execPath}\n` + `const fs = require('node:fs');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args.includes('--help')) { console.log('Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>'); process.exit(0); }\n` +
    `fs.appendFileSync(process.env.SMOKE_LOG, JSON.stringify(args) + '\\n');\n` +
    `if (fs.existsSync(process.env.SMOKE_FAIL)) process.exit(1);\n` +
    `console.log('Queued message 00000000-0000-4000-8000-000000000002 for thread ' + args[args.indexOf('--thread') + 1] + '.');\n`;
  const executable = join(bin, 'codex'); await writeFile(executable, script); await chmod(executable, 0o700);
  const store = new SessionStore(data); const mail = new MailStore(id => store.sessionDir(id));
  const session: Session = { id: 'smoke-session', name: 'smoke', command: 'codex', shellType: 'codex',
    codexSessionId: nativeId, status: 'running', bridgeId: 'bridge-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), workingDir: home,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, SMOKE_LOG: log, SMOKE_FAIL: join(home, 'fail') } };
  await store.saveSession(session);
  const writes: string[] = [];
  class Runner extends EventEmitter { isRunning(id: string) { return id === session.id; } write(_id: string, text: string) { writes.push(text); return true; } }
  const runner = new Runner(); server = new LocalApiServer();
  server.setAuthToken('smoke-token'); server.setDependencies(store, runner as unknown as ProcessRunner, {} as CentrifugoClient, 'user-1'); server.setMailStore(mail);
  const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
  const identity = await loadOrCreateIdentity(data, ownerId, 'bridge');
  const client = await loadOrCreateIdentity(data, ownerId, 'local-cli');
  security = new BridgeSecurityService(identity, 'bridge-1', data, { relayUserId: 'user-1' });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  server.setSecurity(security, { protocolVersion: 1, ownerId, bridgeId: 'bridge-1', endpoint: identity.endpoint, relayUserId: 'user-1' }, async () => null);
  const port = await server.start();
  const pointer: BridgePointer = { port, token: 'smoke-token', dataDir: data, ownerId, endpoint: identity.endpoint, bridgeId: 'bridge-1' };
  await writeFile(join(data, 'bridge.json'), JSON.stringify(pointer));
  const status = await run(process.execPath, [resolve('dist/harness-cli.js'), 'status'], { env: { ...process.env, FTOWN_DATA_DIR: data }, timeout: 15_000 });
  assert.match(status.stdout, /bridge:\s+up/); console.log('PASS task-owned harness status');
  const body = "  Unicode 雪\\nquotes ' backticks ` and $(touch never)\\n".replaceAll('\\n', '\n') + 'x'.repeat(5_000);
  const posted = await api<{ id: string }>(pointer, 'POST', `/api/sessions/${session.id}/inbox`, { body, from: 'parent', type: 'task', threadId: 'smoke-thread' });
  await until(async () => (await mail.listAll(session.id, 50)).some(m => m.id === posted.id && m.deliveredVia === 'cli'), 'accepted native receipt');
  let calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 3), ['queue', '--thread', nativeId]);
  assert.equal(calls[0][3], '--message'); assert.ok(calls[0][4].includes(posted.id)); assert.ok(calls[0][4].endsWith('\n\n' + body));
  const history = await api<{ messages: Array<{ id: string; body: string; deliveredVia?: string }> }>(pointer, 'GET', `/api/sessions/${session.id}/inbox?peek=1&all=1`);
  assert.equal(history.messages.find(m => m.id === posted.id)?.body, body); assert.equal(history.messages.find(m => m.id === posted.id)?.deliveredVia, 'cli');
  const inbox = await api<{ messages: unknown[] }>(pointer, 'GET', `/api/sessions/${session.id}/inbox?peek=1`); assert.deepEqual(inbox.messages, []);
  console.log('PASS encrypted inbox POST → real subprocess argv → acknowledged history');
  await writeFile(join(home, 'fail'), 'fail');
  const failed = await api<{ id: string }>(pointer, 'POST', `/api/sessions/${session.id}/inbox`, { body: 'failure remains durable' });
  await until(async () => (await readFile(log, 'utf8')).trim().split('\n').length === 2, 'failed enqueue');
  await delay(250); calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.equal(calls.length, 2); assert.ok((await mail.listUndelivered(session.id)).some(m => m.id === failed.id));
  assert.deepEqual(writes, []); console.log('PASS failed enqueue retained, zero PTY writes');
} finally {
  server?.getHttpServer()?.closeAllConnections(); server?.stop(); await security?.close(); await rm(home, { recursive: true, force: true });
}

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
