import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEndpoint, open, seal } from '@security/crypto';
import type { SecureEnvelope } from '@security/protocol';
import { SecureEndpointRuntime } from './secure-endpoint-runtime';
import { bootstrapLocal, localOrigin, localRequest, LocalBrowserClient, type BrowserBootstrap } from './local-browser-client';
const ownerId = '00000000-0000-4000-8000-000000000001';
const json = (data: unknown) => new Response(JSON.stringify(data));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('encrypted local browser control', () => {
  it('limits discovery to numeric loopback and never sends cookies or legacy bearer credentials', async () => {
    for (const bad of ['0', '65536', 'localhost:123', '123/path', '1@evil.test', '-1', '1.5']) expect(() => localOrigin(bad)).toThrow();
    const bridge = await generateEndpoint(ownerId, 'bridge');
    const info = { protocolVersion: 1, ownerId, bridgeId: 'bridge-a', endpoint: bridge.endpoint, relayUserId: 'local-owner' };
    const fetcher = vi.fn().mockResolvedValue(json(info)); vi.stubGlobal('fetch', fetcher);
    await expect(bootstrapLocal({ port: 43127, bridgeId: 'bridge-a', credential: 'old-token' })).resolves.toMatchObject(info);
    expect(fetcher.mock.calls[0]).toEqual(['http://127.0.0.1:43127/api/security/info', expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store', method: 'GET', headers: {} })]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('old-token');
  });
  it('rejects plaintext command paths before making a network request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(localRequest(43127, '/api/browser/commands', 'legacy-secret', {})).rejects.toMatchObject({ status: 426 });
    await expect(localRequest(43127, 'https://example.com/', 'legacy-secret')).rejects.toMatchObject({ status: 426 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels a queued local mutation when its caller aborts during handshake', async () => {
    const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
    const boot: BrowserBootstrap = { version: 1, protocolVersion: 1, ownerId, bridgeId: 'bridge-a', endpoint: bridge.endpoint, relayUserId: 'local-owner', userId: 'local-owner', hostname: 'laptop', localPort: 43127 };
    const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: boot.bridgeId, endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
    let release!: () => void;
    vi.spyOn(runtime, 'handshake').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const client = new LocalBrowserClient({ port: 43127, bridgeId: boot.bridgeId }, boot, vi.fn(), vi.fn(), undefined, runtime);
    const cancellation = new AbortController();
    const pending = client.command({ type: 'stop_session', requestId: 'cancelled-local', payload: { sessionId: 'session-one' } }, { deadline: Date.now() + 1000, signal: cancellation.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'expired' }); cancellation.abort(); release(); await rejected;
    expect(fetcher).not.toHaveBeenCalled(); client.close(); runtime.dispose();
  });
  it('authenticates local commands with the pinned browser identity and opaque payloads', async () => {
    const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
    const boot: BrowserBootstrap = { version: 1, protocolVersion: 1, ownerId, bridgeId: 'bridge-a', endpoint: bridge.endpoint, relayUserId: 'local-owner', userId: 'local-owner', hostname: 'laptop', localPort: 43127 };
    const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: boot.bridgeId, endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body)) as SecureEnvelope;
      const plain = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope,
        { ownerId, bridgeId: boot.bridgeId, channel: `local-http:${boot.bridgeId}`, recipientId: bridge.endpoint.id, purpose: envelope.purpose })));
      const value = envelope.purpose === 'hello' ? { type: 'welcome', challenge: plain.challenge, receiverEpoch: 'boot-one' }
        : { type: 'application', route: { kind: 'response', requestId: plain.route.requestId }, data: { type: 'command_response', response: { requestId: plain.route.requestId, success: true, data: { ok: true } } }, mcp: null };
      const reply = await seal(bridge, browser.endpoint, { ...envelope, senderId: bridge.endpoint.id, recipientId: browser.endpoint.id, purpose: envelope.purpose === 'hello' ? 'welcome' : 'application' }, new TextEncoder().encode(JSON.stringify(value)));
      return json(reply);
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new LocalBrowserClient({ port: 43127, bridgeId: boot.bridgeId }, boot, vi.fn(), vi.fn(), undefined, runtime);
    await expect(client.command({ type: 'rename_session', requestId: 'rename-one', payload: { sessionId: 'session-one', name: 'PRIVATE-SESSION' } })).resolves.toMatchObject({ success: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE-SESSION'); client.close(); runtime.dispose();
  });
});
