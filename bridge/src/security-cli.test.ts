import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ACCOUNT_MANAGED_INVITE_MESSAGE, invitationLink, runSecurity, soloPanelOrigin, securityRefusalMessage } from './security-cli.js';
import { SecurityCommandError, securityCommand, securityCommandError } from './cli-client.js';
import type { ApplicationJson, BridgeInvitation } from './security/protocol.js';

const INVITATION: BridgeInvitation = { version: 1, invitationId: 'i', ownerId: 'solo:b', bridgeId: 'b', bridge: {} as BridgeInvitation['bridge'],
  secret: 'SECRET', expiresAt: 'soon', relayUrl: null, localOrigin: 'http://127.0.0.1:9' };

/** A loopback HTTP server that answers every request with `status` and the given JSON body. */
async function stubServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('invitation URLs carry the full invitation only in the dedicated connect fragment', () => {
  const invitation = { version: 1, secret: 'SECRET', ownerId: 'owner', bridgeId: 'bridge' } as BridgeInvitation;
  const url = new URL(invitationLink(invitation, 'https://example.test'));
  assert.equal(url.pathname, '/connect'); assert.equal(url.search, '');
  assert.equal(new URL(url.origin + url.pathname).href.includes('SECRET'), false);
  assert.deepEqual(JSON.parse(new URLSearchParams(url.hash.slice(1)).get('invite')!), invitation);
});

test('security help lists recovery commands without accessing a bridge or printing an invitation', async t => {
  const log = t.mock.method(console, 'log', () => {});
  assert.equal(await runSecurity(['--help']), 0);
  const output = log.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n');
  for (const command of ['invite', 'devices', 'revoke', 'proxy']) assert.ok(output.includes(command));
  // Account computers pair by a passkey link printed by `ftown start`; the v1 approval commands are gone.
  for (const command of ['pair-status', 'pair-confirm', 'pair-reject', 'pair-link']) assert.ok(!output.includes(command), command);
  assert.ok(!output.includes('#invite='));
});

test('an account bridge refuses `invite` with the account_managed reason, without contacting the bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-security-cli-'));
  const previous = console.error; const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    writeFileSync(join(dir, 'bridge.json'), JSON.stringify({ port: 1, token: 'local-token', bridgeId: 'b', ownerId: 'A'.repeat(43) }));
    assert.equal(await runSecurity(['--data-dir', dir, 'invite']), 1);
    assert.deepEqual(errors, [ACCOUNT_MANAGED_INVITE_MESSAGE]);
    assert.match(ACCOUNT_MANAGED_INVITE_MESSAGE, /account_managed/);
  } finally { console.error = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("security commands surface the bridge's typed refusal instead of a generic failure", () => {
  const managed = securityCommandError({ requestId: 'r', success: false, error: 'Bridge security: account_managed', data: { code: 'account_managed' } });
  assert.ok(managed instanceof SecurityCommandError);
  assert.equal(managed.code, 'account_managed');
  assert.equal(managed.message, 'Bridge security: account_managed');
  assert.match(securityRefusalMessage(managed), /account_managed/);

  const other = securityCommandError({ success: false, error: 'Bridge security: permission_denied\u0007', data: { code: 'permission_denied' } });
  assert.equal(other.message, 'Bridge security: permission_denied');
  assert.equal(securityRefusalMessage(other), 'The bridge refused this security command: Bridge security: permission_denied');

  const coded = securityCommandError({ success: false, data: { code: 'approval_required' } });
  assert.equal(coded.message, 'Encrypted security command failed (approval_required)');
  const untyped = securityCommandError({ success: false, error: 'x'.repeat(400), data: { code: 'Not A Code!' } });
  assert.equal(untyped.code, null);
  assert.equal(untyped.message.length, 300);
});

test('securityCommand throws the typed refusal for every security command', async () => {
  for (const type of ['security_invite', 'security_devices', 'security_revoke'] as const) {
    const send = async () => ({ response: { requestId: 'r', success: false, error: 'Bridge security: account_managed', data: { code: 'account_managed' } } });
    const error = await securityCommand({ port: 1, token: 't', bridgeId: 'b' }, type, {}, send as never).then(() => assert.fail('should reject'), (e: unknown) => e);
    assert.ok(error instanceof SecurityCommandError, type);
    assert.equal(error.code, 'account_managed');
  }
  const ok = async () => ({ response: { requestId: 'r', success: true, data: { devices: [] } } });
  assert.deepEqual(await securityCommand({ port: 1, token: 't', bridgeId: 'b' }, 'security_devices', {}, ok as never), { devices: [] });
});

test('soloPanelOrigin answers with the pointer origin only when that panel names this bridge', async () => {
  const info = await stubServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocolVersion: 1, ownerId: 'solo:b', bridgeId: 'b', relayUserId: 'solo', endpoint: {} }));
  });
  const origin = `http://127.0.0.1:${info.port}`;
  try {
    assert.equal(await soloPanelOrigin(origin, 'b'), origin);
    assert.equal(await soloPanelOrigin(origin, 'other'), null);
    assert.equal(await soloPanelOrigin(undefined, 'b'), null);
  } finally { await info.close(); }
});

test('soloPanelOrigin keeps the hosted flow when nothing answers or the answer is not security info', async () => {
  const free = await stubServer(() => { /* bound only to reserve the port */ });
  await free.close();
  assert.equal(await soloPanelOrigin(`http://127.0.0.1:${free.port}`, 'b'), null);
  const lost = await stubServer((_req, res) => { res.writeHead(404); res.end(); });
  try { assert.equal(await soloPanelOrigin(`http://127.0.0.1:${lost.port}`, 'b'), null); } finally { await lost.close(); }
});

test('a custom-port solo panel prints its invitation on its own origin instead of the hosted one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-security-cli-'));
  const log = t.mock.method(console, 'log', () => {});
  try {
    writeFileSync(join(dir, 'bridge.json'),
      JSON.stringify({ port: 1, token: 'local-token', bridgeId: 'b', ownerId: 'solo:b', soloOrigin: 'http://localhost:18042' }));
    let probed: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      probed = String(input);
      return new Response(JSON.stringify({ protocolVersion: 1, bridgeId: 'b', ownerId: 'solo:b', endpoint: {} }), { status: 200 });
    }) as typeof fetch;
    const send = async () => INVITATION as unknown as ApplicationJson;
    assert.equal(await runSecurity(['--data-dir', dir, 'invite'], send, fetchImpl), 0);
    assert.equal(probed, 'http://localhost:18042/api/security/info');
    const output = log.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n');
    assert.ok(output.startsWith('http://localhost:18042/connect#invite='), output);
    assert.ok(!output.includes('ftown.ia.br'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a solo origin that stopped naming this bridge falls back to the configured API origin', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-security-cli-'));
  const log = t.mock.method(console, 'log', () => {});
  try {
    writeFileSync(join(dir, 'bridge.json'),
      JSON.stringify({ port: 1, token: 'local-token', bridgeId: 'b', ownerId: 'solo:b', soloOrigin: 'http://localhost:18042', apiUrl: 'https://ftown.ia.br' }));
    const fetchImpl = (async () => new Response(JSON.stringify({ bridgeId: 'another-bridge' }), { status: 200 })) as typeof fetch;
    const send = async () => INVITATION as unknown as ApplicationJson;
    assert.equal(await runSecurity(['--data-dir', dir, 'invite'], send, fetchImpl), 0);
    const output = log.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n');
    assert.ok(output.startsWith('https://ftown.ia.br/connect#invite='), output);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without a persisted solo origin the invitation stays on the configured API origin', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-security-cli-'));
  const log = t.mock.method(console, 'log', () => {});
  try {
    writeFileSync(join(dir, 'bridge.json'), JSON.stringify({ port: 1, token: 'local-token', bridgeId: 'b', ownerId: 'solo:b', apiUrl: 'https://ftown.ia.br' }));
    const fetchImpl = (async () => { throw new Error('no solo panel'); }) as typeof fetch;
    const send = async () => INVITATION as unknown as ApplicationJson;
    assert.equal(await runSecurity(['--data-dir', dir, 'invite'], send, fetchImpl), 0);
    const output = log.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n');
    assert.ok(output.startsWith('https://ftown.ia.br/connect#invite='), output);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the bridge pointer writer persists the solo panel origin the invite CLIs read', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /soloOrigin: `http:\/\/localhost:\$\{solo\.front\.port\}`/);
});
