/** Root-only isolated smoke: node --import tsx ../docs/investigations/pr-ci-status/runtime-smoke.ts (from bridge/). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateEndpoint, seal } from '../../../bridge/src/security/crypto.js';
import { BridgeSecurityService } from '../../../bridge/src/security/bridge/security.js';
import { LOCAL_RECOVERY_AUTHORITY } from '../../../bridge/src/security/bridge/policy.js';
import { createCommandHandler } from '../../../bridge/src/command-rpc.js';
import { PullRequestStatusService } from '../../../bridge/src/pull-request-status.js';
import { LocalApiServer } from '../../../bridge/src/local-api-server.js';
import { SessionStore } from '../../../bridge/src/session-store.js';
import { loadOrCreateIdentity } from '../../../bridge/src/security/bridge/identity.js';
import type { ProcessRunner } from '../../../bridge/src/claude-runner.js';
import type { CentrifugoClient } from '../../../bridge/src/centrifugo-client.js';
import type { BridgePointer } from '../../../bridge/src/wire-types.js';
import type { SessionController } from '../../../bridge/src/session-controller.js';
import type { Command, CommandResponse } from '../../../bridge/src/types.js';

async function main(): Promise<void> {
const dir = await mkdtemp(join(tmpdir(), 'ftown-pr-status-smoke-'));
const oldPath = process.env.PATH;
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const bridgeId = 'smoke-bridge';
const channel = `local-http:${bridgeId}`;
const route = { transport: 'local-http' as const, bridgeId, channel, pairId: null };
const identity = await generateEndpoint(owner, 'bridge');
const security = new BridgeSecurityService(identity, bridgeId, dir, { relayUserId: 'smoke@example.test' });
let server: LocalApiServer | undefined;
try {
  const count = join(dir, 'calls');
  const data = { data: { r0: { pullRequest: { state: 'OPEN', merged: false, headRefOid: 'head', commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 1 } } } }] } } }, rateLimit: { cost: 1, remaining: 5000, resetAt: '2030-01-01T00:00:00Z' } } };
  const gh = join(dir, 'gh');
  await writeFile(gh, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(count)}, 'x'); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(data))}));\n`);
  await chmod(gh, 0o700); process.env.PATH = `${dir}:${oldPath ?? ''}`;
  const browser = await generateEndpoint(owner, 'browser');
  const invitation = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Smoke browser' });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Smoke browser' });
  const service = new PullRequestStatusService();
  const sessionController = { get: async (id: string) => id === 'session' ? { id, bridgeId, pullRequestUrl: 'https://github.com/owner/repo/pull/1' } : null } as unknown as SessionController;
  const command = (id: string): Command => ({ type: 'get_pull_request_statuses', requestId: id, payload: { bridgeId, sessionIds: ['session'] } });
  const envelope = async (sender: typeof browser, cmd: Command) => seal(sender, identity.endpoint, { type: 'ftown_encrypted', version: 1,
    senderId: sender.endpoint.id, recipientId: identity.endpoint.id, ownerId: owner, bridgeId, channel, purpose: 'application', messageId: cmd.requestId,
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, receiverEpoch: security.receiverEpoch }, new TextEncoder().encode(JSON.stringify({ type: 'application', route: { kind: 'command', requestId: cmd.requestId, command: cmd.type, sessionId: null }, data: cmd, mcp: null })));
  const dispatch = async (cmd: Command) => {
    const verified = await security.acceptApplication(await envelope(browser, cmd), route);
    let response: CommandResponse | undefined;
    await createCommandHandler({ bridgeId, security, sessionController, pullRequestStatuses: service, publishCommandResponse: async r => { response = r; } })(cmd, verified);
    assert.equal(response?.success, true); return response!;
  };
  const [a, b] = await Promise.all([dispatch(command(randomUUID())), dispatch(command(randomUUID()))]);
  assert.equal((a.data as { statuses: Array<{ state: string }> }).statuses[0].state, 'passed');
  assert.equal((b.data as { statuses: Array<{ state: string }> }).statuses[0].state, 'passed');
  assert.equal(await readFile(count, 'utf8'), 'x');
  const unknown = await generateEndpoint(owner, 'browser');
  await assert.rejects(security.acceptApplication(await envelope(unknown, command(randomUUID())), route));
  console.log('Encrypted status requests, shared gh call, and unknown principal denial passed.');

  // A task-owned local API and pointer exercise the built harness CLI without
  // touching the user's active bridge, data directory, port, or identity.
  const store = new SessionStore(dir);
  const cli = await loadOrCreateIdentity(dir, owner, 'local-cli');
  await security.policy.provisionLocalEndpoint(cli.endpoint);
  server = new LocalApiServer();
  server.setAuthToken('smoke-token');
  server.setDependencies(store, new EventEmitter() as unknown as ProcessRunner, {} as CentrifugoClient, 'smoke@example.test');
  server.setSecurity(security, { protocolVersion: 1, ownerId: owner, bridgeId, endpoint: identity.endpoint, relayUserId: 'smoke@example.test' }, async () => null);
  const port = await server.start();
  const pointer: BridgePointer = { port, token: 'smoke-token', dataDir: dir, ownerId: owner, endpoint: identity.endpoint, bridgeId };
  await writeFile(join(dir, 'bridge.json'), JSON.stringify(pointer));
  const run = promisify(execFile);
  const status = await run(process.execPath, [resolve('dist/harness-cli.js'), 'status'], { env: { ...process.env, FTOWN_DATA_DIR: dir }, timeout: 15_000 });
  assert.match(status.stdout, /bridge:\s+up/);
  console.log('Task-owned built harness status passed.');
} finally {
  process.env.PATH = oldPath; server?.getHttpServer()?.closeAllConnections(); server?.stop(); await security.close(); await rm(dir, { recursive: true, force: true });
}

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
