import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndpointIdentity, EnvelopePurpose, SecureEnvelope } from '@security/protocol';
import { generateEndpoint, open, seal } from '@security/crypto';
import { SecureEndpointRuntime } from './secure-endpoint-runtime';

const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('@security/crypto', async original => {
  const real = await original<typeof import('@security/crypto')>();
  return { ...real, open: async (...args: Parameters<typeof real.open>) => { if (gate.wait) await gate.wait; return real.open(...args); } };
});
vi.mock('./browser-identity', () => ({ pinApprovedBridge: vi.fn(async () => {}), validatePublicEndpoint: vi.fn(async value => value) }));
const ownerId = '00000000-0000-4000-8000-000000000001';
const channel = 'commands:rpc#owner@example.test';
const text = new TextEncoder();
afterEach(() => { gate.wait = null; });
async function fixture() {
  const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
  return { browser, bridge, runtime };
}
async function packet(sender: EndpointIdentity, recipient: EndpointIdentity, purpose: EnvelopePurpose, data: unknown, override: Partial<SecureEnvelope> = {}) {
  const now = Date.now();
  return seal(sender, recipient.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: recipient.endpoint.id,
    ownerId, bridgeId: 'bridge-one', channel, purpose, messageId: crypto.randomUUID(), createdAt: now, expiresAt: now + 120000, receiverEpoch: null, ...override }, text.encode(JSON.stringify(data)));
}
async function establish(runtime: SecureEndpointRuntime, bridge: EndpointIdentity, browser: EndpointIdentity) {
  await runtime.handshake('bridge-one', channel, async message => {
    const envelope = message as SecureEnvelope;
    const hello = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope, { ownerId, bridgeId: 'bridge-one', channel, recipientId: bridge.endpoint.id, purpose: 'hello' })));
    await runtime.receive(await packet(bridge, browser, 'welcome', { type: 'welcome', challenge: hello.challenge, receiverEpoch: 'boot-one' }), channel);
  });
}

describe('browser secure runtime', () => {
  it('keeps request IDs equal across encrypted header and route, and authenticates a boot epoch', async () => {
    const { browser, bridge, runtime } = await fixture(); await establish(runtime, bridge, browser);
    const requestId = crypto.randomUUID();
    const envelope = await runtime.sealApplication('bridge-one', channel, { type: 'application', route: { kind: 'command', requestId, command: 'list_sessions', sessionId: null }, data: {}, mcp: null });
    expect(envelope.messageId).toBe(requestId); expect(envelope.receiverEpoch).toBe('boot-one');
    const value = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope, { ownerId, bridgeId: 'bridge-one', channel, recipientId: bridge.endpoint.id, purpose: 'application' })));
    expect(value.route.requestId).toBe(requestId); runtime.dispose();
  });

  it('deduplicates authenticated publication recovery and rejects expired fresh responses', async () => {
    const { browser, bridge, runtime } = await fixture();
    const old = { createdAt: Date.now() - 300000, expiresAt: Date.now() - 180000 };
    const history = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { type: 'session_update' }, mcp: null }, old);
    expect(await runtime.receive(history, channel)).toHaveLength(1);
    expect(await runtime.receive(history, channel)).toHaveLength(0);
    const response = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'response', requestId: 'stale' }, data: {}, mcp: null }, old);
    expect(await runtime.receive(response, channel)).toHaveLength(0); runtime.dispose();
  });

  it('cannot deliver plaintext after disposal while authenticated decryption was awaiting', async () => {
    const { browser, bridge, runtime } = await fixture();
    const message = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { private: 'old-account-content' }, mcp: null });
    let release!: () => void; gate.wait = new Promise<void>(resolve => { release = resolve; });
    const receiving = runtime.receive(message, channel);
    runtime.dispose(); release();
    expect(await receiving).toEqual([]);
  });

  it('allows a fresh explicitly approved invitation to replace a changed key', async () => {
    const { browser, runtime } = await fixture(); const replacement = await generateEndpoint(ownerId, 'bridge');
    runtime.discover('bridge-one', replacement.endpoint); expect(runtime.state('bridge-one').status).toBe('key_changed');
    const invitation = { version: 1 as const, invitationId: 'invite-one', ownerId, bridgeId: 'bridge-one', bridge: replacement.endpoint,
      secret: 'a'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), relayUrl: null, localOrigin: null };
    await runtime.enroll(invitation, 'Browser', channel, async message => {
      if (!('candidate' in message)) throw new Error('Enrollment packet required');
      const bytes = await open(replacement, browser.endpoint, message.envelope, { ownerId, bridgeId: 'bridge-one', channel, recipientId: replacement.endpoint.id, purpose: 'enroll' });
      const enrollment = JSON.parse(new TextDecoder().decode(bytes)); expect(enrollment.invitationSecret).toBe(invitation.secret);
      await runtime.receive(await packet(replacement, browser, 'enrolled', { type: 'enrolled', invitationId: invitation.invitationId,
        approved: { endpoint: browser.endpoint, label: 'Browser', permissions: ['read', 'control', 'admin'], approvedAt: new Date().toISOString(), grantId: null, expiresAt: null }, receiverEpoch: 'boot-new' }), channel);
    });
    expect(runtime.state('bridge-one')).toMatchObject({ status: 'ready', endpoint: replacement.endpoint }); runtime.dispose();
  });
});
