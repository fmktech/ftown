import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toWireSession } from './session-wire.js';
import { CentrifugoClient } from './centrifugo-client.js';
import type { Session } from './types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEndpoint, open } from './security/crypto.js';
import type { SecureEnvelope } from './security/protocol.js';
import { BridgeSecurityService } from './security/bridge/security.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'Demo',
    command: 'claude --resume abc',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:01.000Z',
    workingDir: '/tmp/work',
    shellType: 'claude',
    model: 'opus',
    claudeSessionId: 'claude-abc',
    parentSessionId: 'parent-9',
    runtime: 'tmux',
    errorReason: 'boom',
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-token', PATH: '/usr/bin' },
    ...overrides,
  };
}

describe('toWireSession', () => {
  it('strips env from the returned copy', () => {
    const wire = toWireSession(makeSession());
    assert.strictEqual(wire.env, undefined);
    assert.ok(!('env' in wire));
  });

  it('preserves every other field, including errorReason', () => {
    const session = makeSession();
    const wire = toWireSession(session);
    assert.strictEqual(wire.id, session.id);
    assert.strictEqual(wire.name, session.name);
    assert.strictEqual(wire.command, session.command);
    assert.strictEqual(wire.status, session.status);
    assert.strictEqual(wire.bridgeId, session.bridgeId);
    assert.strictEqual(wire.createdAt, session.createdAt);
    assert.strictEqual(wire.updatedAt, session.updatedAt);
    assert.strictEqual(wire.workingDir, session.workingDir);
    assert.strictEqual(wire.shellType, session.shellType);
    assert.strictEqual(wire.model, session.model);
    assert.strictEqual(wire.claudeSessionId, session.claudeSessionId);
    assert.strictEqual(wire.parentSessionId, session.parentSessionId);
    assert.strictEqual(wire.runtime, session.runtime);
    assert.strictEqual(wire.errorReason, session.errorReason);
  });

  it('does not mutate the input session', () => {
    const session = makeSession();
    toWireSession(session);
    assert.deepStrictEqual(session.env, { ANTHROPIC_AUTH_TOKEN: 'sk-secret-token', PATH: '/usr/bin' });
    assert.ok('env' in session);
  });

  it('returns a valid copy when the session has no env', () => {
    const session = makeSession({ env: undefined });
    const wire = toWireSession(session);
    assert.strictEqual(wire.env, undefined);
    assert.strictEqual(wire.id, session.id);
    assert.notStrictEqual(wire, session);
  });
});

interface PublishCapture {
  state: 'connected';
  publish(channel: string, data: Record<string, unknown>): Promise<unknown>;
}

describe('CentrifugoClient.publishSessionUpdate — token never crosses the wire', () => {
  it('publishes only ciphertext and decrypts a session whose env (and token) is stripped', async t => {
    const client = new CentrifugoClient('ws://127.0.0.1:0/connection/websocket', 'tok', async () => 'tok');
    const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
    const dir = await mkdtemp(join(tmpdir(), 'ftown-session-wire-'));
    const bridge = await generateEndpoint(ownerId, 'bridge');
    const browser = await generateEndpoint(ownerId, 'local-cli');
    const security = new BridgeSecurityService(bridge, 'bridge-1', dir, { relayUserId: 'user-1' });
    await security.policy.provisionLocalEndpoint(browser.endpoint);
    client.setSecurity(security);
    t.after(async () => { await security.close(); await rm(dir, { recursive: true, force: true }); });

    const captured: { channel?: string; data?: Record<string, unknown> } = {};
    let delivered!: () => void;
    const delivery = new Promise<void>(resolve => { delivered = resolve; });
    (client as unknown as { client: PublishCapture }).client = {
      state: 'connected',
      publish: async (channel: string, data: Record<string, unknown>) => {
        captured.channel = channel;
        captured.data = data;
        delivered();
        return {};
      },
    };

    const session = makeSession();
    await client.publishSessionUpdate('user-1', session);
    await delivery;

    const envelope = captured.data as unknown as SecureEnvelope;
    assert.equal(envelope.type, 'ftown_encrypted');
    const decrypted = JSON.parse(new TextDecoder().decode(await open(browser, bridge.endpoint, envelope,
      { ownerId, bridgeId: 'bridge-1', channel: 'sessions:updates#user-1', recipientId: browser.endpoint.id, purpose: 'application' }))) as { data: { type: string; session: Session } };
    const publishedSession = decrypted.data.session;
    assert.strictEqual(publishedSession.env, undefined);
    assert.ok(!('env' in publishedSession));
    // The full payload must contain no token value anywhere.
    assert.ok(!JSON.stringify(captured.data).includes('sk-secret-token'));
    assert.ok(!JSON.stringify(captured.data).includes(session.command));
    assert.ok(!JSON.stringify(decrypted).includes('sk-secret-token'));
    // Sanity: the rest of the session is intact on the wire.
    assert.strictEqual(publishedSession.id, session.id);
    assert.strictEqual(decrypted.data.type, 'session_update');
    // The original session keeps its env for server-side spawn/resume.
    assert.deepStrictEqual(session.env, { ANTHROPIC_AUTH_TOKEN: 'sk-secret-token', PATH: '/usr/bin' });
  });
});

it('keeps PR link incarnation private on the wire', () => {
  const session = makeSession({ pullRequestUrl: 'https://github.com/owner/repo/pull/1', pullRequestLinkId: 'private-link' });
  const wire = toWireSession(session);
  assert.equal(wire.pullRequestUrl, session.pullRequestUrl);
  assert.equal('pullRequestLinkId' in wire, false);
  assert.equal(session.pullRequestLinkId, 'private-link');
});
