import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLocal, localOrigin, localRequest, LocalBrowserClient, type BrowserBootstrap } from './local-browser-client';
import { createRpcCore } from '@/hooks/useBridgeRpc';
import { HybridTerminalTransport } from './direct-transport/hybrid-terminal-transport';

const device = { port: 43127, bridgeId: 'bridge-a', credential: 'private-device-token' };
const boot: BrowserBootstrap = { version: 1, bridgeId: 'bridge-a', userId: 'local-owner', hostname: 'laptop',
  localPort: 43128, localNonce: device.credential };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local browser control', () => {
  it('accepts only numeric loopback ports and refuses redirects/cookies on credential requests', async () => {
    for (const bad of ['0', '65536', 'localhost:123', '123/path', '1@evil.test', '-1', '1.5']) {
      expect(() => localOrigin(bad)).toThrow();
    }
    const fetcher = vi.fn().mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
    await expect(bootstrapLocal(device)).resolves.toEqual(boot);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:43127/api/browser/bootstrap', expect.objectContaining({
      credentials: 'omit', redirect: 'error', cache: 'no-store', method: 'POST',
      headers: { Authorization: 'Bearer private-device-token', 'Content-Type': 'application/json' },
    }));
  });

  it('rejects a different bridge at a remembered port before exposing it to the dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...boot, bridgeId: 'other' })));
    await expect(bootstrapLocal(device)).rejects.toThrow('different bridge');
  });

  it('routes create/remove/loop controller RPC responses without cloud and never retries uncertain commands', async () => {
    const fetcher = vi.fn().mockImplementation((_url, options) => {
      const command = JSON.parse(options.body);
      return Promise.resolve(json({ requestId: command.requestId, success: true, data: { ok: true } }));
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new LocalBrowserClient(device, boot, vi.fn(), vi.fn());
    const sub = client.newSubscription(`commands:rpc#${boot.userId}`); sub.subscribe();
    const core = createRpcCore((command) => { void sub.publish(command); });
    sub.on('publication', ({ data, info }) => {
      expect(info?.user).toBe(boot.userId);
      core.handleResponse((data as { response: Parameters<typeof core.handleResponse>[0] }).response);
    });
    for (const type of ['create_session', 'remove_session', 'create_loop'] as const) {
      await expect(core.sendCommand({ type, requestId: type, payload: {} })).resolves.toMatchObject({ success: true });
    }
    fetcher.mockRejectedValueOnce(new Error('connection lost'));
    await expect(core.sendCommand({ type: 'create_session', requestId: 'lost', payload: {} })).resolves.toMatchObject({
      success: false, error: expect.stringContaining('Delivery may be uncertain'),
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => url === 'http://127.0.0.1:43127/api/browser/commands')).toBe(true);
    expect(JSON.stringify(client.presence())).not.toContain(device.credential);
    client.close();
  });

  it('delivers local events, refreshes snapshots after lost history, and stops on revocation', async () => {
    const revoked = vi.fn(); const status = vi.fn();
    const client = new LocalBrowserClient(device, boot, status, revoked);
    const sub = client.newSubscription('sessions:updates#local-owner');
    const event = vi.fn(); const refreshed = vi.fn();
    sub.on('publication', event); sub.on('subscribed', refreshed); sub.subscribe();
    await Promise.resolve(); refreshed.mockClear();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ cursor: 17, reset: true, events: [{ channel: sub.channel, data: { type: 'session_update', session: { id: 's1' } } }] }))
      .mockResolvedValueOnce(json(boot))
      .mockResolvedValueOnce(json({ error: 'revoked' }, 401));
    vi.stubGlobal('fetch', fetcher);
    client.start();
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce());
    expect(refreshed).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'session_update', session: { id: 's1' } } }));
    expect(fetcher.mock.calls[2][0]).toContain('cursor=17');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not send pairing poll credentials outside the local API', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(localRequest(43127, 'https://example.com/', 'poll-token')).rejects.toThrow('Invalid local API');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows controller commands to finish beyond the bridge execution timeout', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(json({ success: true }))));
    await localRequest(device.port, '/api/browser/commands', device.credential, {});
    expect(timeouts).toHaveBeenLastCalledWith(35_000);
    await localRequest(device.port, '/api/browser/events?cursor=0', device.credential);
    expect(timeouts).toHaveBeenLastCalledWith(25_000);
    timeouts.mockRestore();
  });

  it('revalidates bootstrap after reconnection and rebuilds subscriptions when bridge identity changes', async () => {
    vi.useFakeTimers();
    const rebuild = vi.fn(); const status = vi.fn();
    const client = new LocalBrowserClient(device, boot, status, vi.fn(), rebuild);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('restarted'))
      .mockResolvedValueOnce(json({ cursor: 0, reset: true, events: [] }))
      .mockResolvedValueOnce(json({ ...boot, userId: 'cloud-owner', localPort: 43129 }));
    vi.stubGlobal('fetch', fetcher);
    client.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[2][0]).toContain('/api/browser/bootstrap');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(status).not.toHaveBeenCalledWith(true);
    client.close();
  });

  it('rebuilds on an event reset even when a fast restart did not produce a transport error', async () => {
    const rebuild = vi.fn();
    const client = new LocalBrowserClient(device, boot, vi.fn(), vi.fn(), rebuild);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ cursor: 0, reset: true, events: [] }))
      .mockResolvedValueOnce(json({ ...boot, localPort: 45000 }));
    vi.stubGlobal('fetch', fetcher);
    client.start();
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[1][0]).toContain('/api/browser/bootstrap');
    client.close();
  });

  it('retries a failed local terminal without WebRTC/cloud and drops input while disconnected', async () => {
    vi.useFakeTimers();
    const client = new LocalBrowserClient(device, boot, vi.fn(), vi.fn());
    const newSubscription = vi.spyOn(client, 'newSubscription');
    let closeListener = () => {};
    const peer = { connect: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
      attach: vi.fn(), detach: vi.fn(), close: vi.fn(), sendInput: vi.fn(), sendResize: vi.fn(),
      onClose: (cb: () => void) => { closeListener = cb; } };
    const rtc = vi.fn(); const publish = vi.fn();
    const transport = new HybridTerminalTransport({ centrifuge: client, userId: boot.userId, clientId: 'browser',
      localOnly: true, getLocalAdvert: async () => boot, loopbackPeerFactory: () => peer, peerFactory: rtc,
      publishCommand: publish, upgradeBackoffMs: [50], upgradeJitter: 0 });
    transport.subscribeTerminal('s1', boot.bridgeId, { onOutput: vi.fn(), onScreen: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.getMode('s1')).toBe('connecting');
    transport.sendInput('s1', 'do not replay');
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.getMode('s1')).toBe('local');
    expect(peer.sendInput).not.toHaveBeenCalled();
    transport.sendInput('s1', 'ok'); expect(peer.sendInput).toHaveBeenCalledWith('s1', 'ok');
    closeListener(); await vi.advanceTimersByTimeAsync(100);
    expect(transport.getMode('s1')).toBe('local');
    expect(newSubscription).not.toHaveBeenCalled(); expect(rtc).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    transport.dispose(); client.close();
  });
});
