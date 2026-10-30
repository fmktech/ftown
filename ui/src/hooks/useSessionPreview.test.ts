// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageClient } from '@/lib/message-client';
import type { Command, CommandResponse } from '@/types';
import { useSessionPreview } from './useSessionPreview';
const id = '12345678-1234-4234-8234-123456789abc';
const target = { bridgeId: 'bridge', sessionId: 'one', preview: { id, fileName: 'demo.html' } };
const client = {} as MessageClient;
let subtleDescriptor: PropertyDescriptor | undefined;
beforeEach(() => { subtleDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle'); vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); if (subtleDescriptor) Object.defineProperty(globalThis.crypto, 'subtle', subtleDescriptor); else Reflect.deleteProperty(globalThis.crypto, 'subtle'); vi.useRealTimers(); });
it('discards a late response after switching sessions and stops after disposal', async () => {
  const resolvers: Array<(value: CommandResponse) => void> = [];
  const sendCommand = vi.fn(() => new Promise<CommandResponse>(r => { resolvers.push(r); }));
  const hook = renderHook(({ selected }) => useSessionPreview({ client, userId: 'user', target: selected, visible: true, readable: true, securityGeneration: 0, sendCommand }), { initialProps: { selected: target } });
  expect(sendCommand).toHaveBeenCalledTimes(1);
  hook.rerender({ selected: { ...target, sessionId: 'two' } });
  expect(sendCommand).toHaveBeenCalledTimes(2);
  await act(async () => { resolvers[0]({ requestId: 'x', success: true, data: { state: 'unregistered' } }); });
  expect(hook.result.current.state.kind).toBe('loading');
  await act(async () => { resolvers[1]({ requestId: 'x', success: true, data: { state: 'unregistered' } }); });
  expect(hook.result.current.state.kind).toBe('unregistered');
  hook.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sendCommand).toHaveBeenCalledTimes(2);
});
it('retries errors on the next poll and hides old state immediately on security loss', async () => {
  const sendCommand = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ requestId: 'x', success: true, data: { state: 'unregistered' } });
  const hook = renderHook(({ readable }) => useSessionPreview({ client, userId: 'user', target, visible: true, readable, securityGeneration: 0, sendCommand }), { initialProps: { readable: true } });
  await act(async () => {}); expect(hook.result.current.state.kind).toBe('error');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state.kind).toBe('unregistered');
  hook.rerender({ readable: false }); expect(hook.result.current.state.kind).toBe('offline');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(sendCommand).toHaveBeenCalledTimes(2);
});
it('keeps the document key on unchanged polls, remounts on manual refresh, and pauses while hidden', async () => {
  const { createHash } = await import('node:crypto');
  const html = '<p>hello</p>'; const digest = createHash('sha256').update(html).digest(); const revision = digest.toString('hex');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from(digest).buffer } });
  const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
    ? { state: 'chunk', previewId: id, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'knownRevision' in command.payload ? 'unchanged' : 'ready', previewId: id, revision, totalBytes: html.length } }));
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 0, sendCommand }));
  await act(async () => {});
  expect(hook.result.current.state.kind).toBe('ready');
  if (hook.result.current.state.kind !== 'ready') throw new Error('expected ready');
  const key = hook.result.current.state.key;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key });
  await act(async () => { hook.result.current.refresh(); });
  expect(hook.result.current.state.kind).toBe('ready');
  if (hook.result.current.state.kind !== 'ready') throw new Error('expected ready');
  expect(hook.result.current.state.key).not.toBe(key);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const count = sendCommand.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sendCommand).toHaveBeenCalledTimes(count);
});
it('keeps automatic status checks quiet but shows actual updates and manual refresh', async () => {
  const { createHash } = await import('node:crypto');
  const first = '<p>one</p>'; const second = '<p>two</p>';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const firstRevision = hash(first); const secondRevision = hash(second);
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer } });
  const pendingStatuses: Array<(response: CommandResponse) => void> = [];
  let resolveChunk: ((response: CommandResponse) => void) | undefined;
  const reply = (data: unknown): CommandResponse => ({ requestId: 'x', success: true, data });
  const status = (state: 'ready' | 'unchanged', revision: string, text: string) => reply({ state, previewId: id, revision, totalBytes: text.length });
  const chunk = (revision: string, text: string) => reply({ state: 'chunk', previewId: id, revision, totalBytes: text.length, offset: 0, dataBase64: btoa(text), done: true });
  let statuses = 0;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_status') {
      if (++statuses === 1) return Promise.resolve(status('ready', firstRevision, first));
      return new Promise(resolve => { pendingStatuses.push(resolve); });
    }
    if ('revision' in command.payload && command.payload.revision === firstRevision) return Promise.resolve(chunk(firstRevision, first));
    return new Promise(resolve => { resolveChunk = resolve; });
  });
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 0, sendCommand }));
  await act(async () => {});
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { pendingStatuses.shift()!(status('unchanged', firstRevision, first)); });
  act(() => hook.result.current.refresh());
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: true });
  await act(async () => { pendingStatuses.shift()!(status('unchanged', firstRevision, first)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { pendingStatuses.shift()!(status('ready', secondRevision, second)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: true });
  await act(async () => { resolveChunk!(chunk(secondRevision, second)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: second, updating: false });
});

function stablePreviewHarness() {
  const html = '<p>unchanged</p>'; const revision = '9'.repeat(64);
  const digest = Uint8Array.from({ length: 32 }, () => 0x99).buffer;
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => digest } });
  const pending: Array<(reply: CommandResponse) => void> = [];
  let firstStatus = true;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_chunk') return Promise.resolve({ requestId: 'chunk', success: true, data: { state: 'chunk', previewId: id, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true } });
    if (firstStatus) { firstStatus = false; return Promise.resolve({ requestId: 'status', success: true, data: { state: 'ready', previewId: id, revision, totalBytes: html.length } }); }
    return new Promise(resolve => pending.push(resolve));
  });
  return { html, revision, sendCommand, pending };
}
function authorityFixture() {
  const endpoint = { version: 1, id: 'bridge-key', ownerId: 'owner', kind: 'bridge', publicKey: 'key' };
  const pin = { bridgeId: 'bridge', endpoint, permissions: ['read', 'control'] };
  const listeners = new Set<() => void>();
  const accountListeners = new Set<() => void>();
  let allowed = true;
  const runtime = { identity: { endpoint: { ...endpoint, id: 'browser-key', kind: 'browser' } },
    bridge: () => pin, state: () => ({ status: 'ready', endpoint: pin.endpoint }),
    assertCanSend: () => { if (!allowed) throw new Error('revoked'); },
    onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const subscribeAuthority = (listener: () => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); };
  const notify = () => listeners.forEach(listener => listener());
  const account = (next: boolean) => { allowed = next; accountListeners.forEach(listener => listener()); };
  return { client: { securityRuntime: runtime } as unknown as MessageClient, pin, notify, account, subscribeAuthority };
}
it('preserves the verified frame across an unchanged ready-to-ready security notification', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(({ generation }) => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: generation, sendCommand: h.sendCommand, subscribeAuthority: auth.subscribeAuthority }), { initialProps: { generation: 1 } });
  await act(async () => {});
  const state = hook.result.current.state; if (state.kind !== 'ready') throw new Error('expected ready');
  act(() => auth.notify());
  hook.rerender({ generation: 2 });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, key: state.key, verifying: true });
  expect(h.sendCommand.mock.calls.at(-1)?.[0].payload).toMatchObject({ knownRevision: h.revision });
  await act(async () => { h.pending.shift()!({ requestId: 'old', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: state.key, verifying: true });
  await act(async () => { h.pending.shift()!({ requestId: 'current', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: state.key, verifying: false });
});
it('retains manual refresh across a benign authority notification', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand, subscribeAuthority: auth.subscribeAuthority }));
  await act(async () => {});
  const initial = hook.result.current.state; if (initial.kind !== 'ready') throw new Error('expected ready');
  act(() => hook.result.current.refresh());
  expect(h.pending).toHaveLength(1);
  act(() => auth.notify());
  expect(h.pending).toHaveLength(2);
  const unchanged = { requestId: 'status', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } };
  await act(async () => { h.pending.shift()!(unchanged); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: initial.key, verifying: true });
  await act(async () => { h.pending.shift()!(unchanged); });
  const refreshed = hook.result.current.state; if (refreshed.kind !== 'ready') throw new Error('expected ready');
  expect(refreshed.key).not.toBe(initial.key);
  expect(refreshed.verifying).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(h.pending).toHaveLength(1);
  await act(async () => { h.pending.shift()!(unchanged); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: refreshed.key, verifying: false });
});
it('coalesces newer refresh clicks into one subsequent poll', async () => {
  const h = stablePreviewHarness();
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {});
  const initial = hook.result.current.state; if (initial.kind !== 'ready') throw new Error('expected ready');
  act(() => { hook.result.current.refresh(); hook.result.current.refresh(); hook.result.current.refresh(); });
  expect(h.pending).toHaveLength(1);
  const unchanged = { requestId: 's', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } };
  await act(async () => { h.pending.shift()!(unchanged); });
  const first = hook.result.current.state; if (first.kind !== 'ready') throw new Error('expected ready');
  expect(first.key).not.toBe(initial.key); expect(h.pending).toHaveLength(1);
  await act(async () => { h.pending.shift()!(unchanged); });
  const second = hook.result.current.state; if (second.kind !== 'ready') throw new Error('expected ready');
  expect(second.key).not.toBe(first.key); expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { h.pending.shift()!(unchanged); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: second.key });
});
it('cancels pending refresh after batched authority loss and recovery', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand, subscribeAuthority: auth.subscribeAuthority }));
  await act(async () => {});
  act(() => hook.result.current.refresh());
  const old = h.pending.shift()!;
  act(() => { auth.account(false); auth.account(true); });
  expect(hook.result.current.state.kind).toBe('loading');
  await act(async () => { old({ requestId: 'old', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state.kind).toBe('loading');
  await act(async () => { h.pending.shift()!({ requestId: 'new', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  const recovered = hook.result.current.state; if (recovered.kind !== 'ready') throw new Error('expected ready');
  expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { h.pending.shift()!({ requestId: 'auto', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: recovered.key });
});
it('cancels queued refresh on failed response rather than retrying immediately', async () => {
  const h = stablePreviewHarness();
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {});
  act(() => { hook.result.current.refresh(); hook.result.current.refresh(); });
  await act(async () => { h.pending.shift()!({ requestId: 'failed', success: false }); });
  expect(hook.result.current.state.kind).toBe('error'); expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(h.pending).toHaveLength(1);
  await act(async () => { h.pending.shift()!({ requestId: 'new', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  const recovered = hook.result.current.state; if (recovered.kind !== 'ready') throw new Error('expected ready');
  expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { h.pending.shift()!({ requestId: 'auto', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key: recovered.key });
});
it.each([
  ['unregistered', { state: 'unregistered' }, 'unregistered'],
  ['unavailable', { state: 'unavailable', previewId: id, reason: 'missing' }, 'unavailable'],
  ['invalid', { state: 'unchanged', previewId: 'wrong', revision: '9'.repeat(64), totalBytes: 16 }, 'error'],
] as const)('cancels queued refresh on %s status', async (_label, response, kind) => {
  const h = stablePreviewHarness();
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {});
  act(() => { hook.result.current.refresh(); hook.result.current.refresh(); });
  await act(async () => { h.pending.shift()!({ requestId: 's', success: true, data: response }); });
  expect(hook.result.current.state.kind).toBe(kind); expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(h.pending).toHaveLength(1);
  await act(async () => { h.pending.shift()!({ requestId: 'new', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state.kind).toBe('ready'); expect(h.pending).toHaveLength(0);
});
it('waits for the normal poll after a stale revision during manual refresh', async () => {
  const h = stablePreviewHarness(); let stale = false;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => stale && command.type === 'session_preview_chunk'
    ? Promise.resolve({ requestId: 'c', success: true, data: { state: 'stale_revision' } }) : h.sendCommand(command));
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand }));
  await act(async () => {}); stale = true;
  act(() => hook.result.current.refresh());
  await act(async () => { h.pending.shift()!({ requestId: 's', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); }); expect(h.pending).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(h.pending).toHaveLength(1);
});
it('latches account authority loss and recovery in one batch and ignores an old reply', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand, subscribeAuthority: auth.subscribeAuthority }));
  await act(async () => {});
  const state = hook.result.current.state; if (state.kind !== 'ready') throw new Error('expected ready');
  act(() => auth.notify());
  const stale = h.pending.shift()!;
  act(() => { auth.account(false); auth.account(true); });
  expect(hook.result.current.state.kind).toBe('loading');
  await act(async () => { stale({ requestId: 'old', success: true, data: { state: 'unchanged', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state.kind).toBe('loading');
  expect(h.sendCommand.mock.calls.at(-1)?.[0].payload).not.toHaveProperty('knownRevision');
  await act(async () => { h.pending.shift()!({ requestId: 'new', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  expect(hook.result.current.state.kind).toBe('ready');
  if (hook.result.current.state.kind !== 'ready') throw new Error('expected ready');
  expect(hook.result.current.state.key).not.toBe(state.key);
});
it('clears cached content when selected bridge permissions change', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {}); expect(hook.result.current.state.kind).toBe('ready');
  act(() => { auth.pin.permissions.splice(0, 1); auth.notify(); });
  expect(hook.result.current.state.kind).toBe('offline');
});
it('preserves the verified frame when the page is hidden and visible again', async () => {
  const h = stablePreviewHarness();
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {});
  const state = hook.result.current.state; if (state.kind !== 'ready') throw new Error('expected ready');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, key: state.key });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, key: state.key });
  expect(h.sendCommand.mock.calls.at(-1)?.[0].payload).toMatchObject({ knownRevision: h.revision });
});
it('preserves the verified frame when the preview panel is temporarily hidden', async () => {
  const h = stablePreviewHarness();
  const hook = renderHook(({ visible }) => useSessionPreview({ client, userId: 'user', target, visible, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }), { initialProps: { visible: true } });
  await act(async () => {});
  const state = hook.result.current.state; if (state.kind !== 'ready') throw new Error('expected ready');
  hook.rerender({ visible: false });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, key: state.key });
  hook.rerender({ visible: true });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, key: state.key });
  expect(h.sendCommand.mock.calls.at(-1)?.[0].payload).toMatchObject({ knownRevision: h.revision });
});
it('identical pinned bridges still notify the runtime while the bridge stays ready', async () => {
  const { webcrypto } = await import('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  const { generateEndpoint, open, seal } = await import('@security/crypto');
  const { SecureEndpointRuntime } = await import('@/lib/secure-endpoint-runtime');
  const ownerId = '00000000-0000-4000-8000-000000000001';
  const browser = await generateEndpoint(ownerId, 'browser');
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const pin = { bridgeId: 'bridge', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] as const };
  const pins = [{ ...pin, permissions: [...pin.permissions] }];
  const runtime = new SecureEndpointRuntime(browser, pins);
  const channel = 'commands:rpc#user';
  await runtime.handshake('bridge', channel, async envelope => {
    if (envelope.type !== 'ftown_encrypted') throw new Error('expected envelope');
    const hello = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope, { ownerId, bridgeId: 'bridge', channel, recipientId: bridge.endpoint.id, purpose: 'hello' })));
    const now = Date.now();
    const welcome = await seal(bridge, browser.endpoint, { type: 'ftown_encrypted', version: 1, senderId: bridge.endpoint.id, recipientId: browser.endpoint.id, ownerId, bridgeId: 'bridge', channel, purpose: 'welcome', messageId: crypto.randomUUID(), createdAt: now, expiresAt: now + 120000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: hello.challenge, receiverEpoch: 'epoch' })));
    await runtime.receive(welcome, channel);
  });
  expect(runtime.state('bridge').status).toBe('ready');
  const listener = vi.fn(); runtime.onChange(listener);
  runtime.replacePins(pins.map(value => ({ ...value, permissions: [...value.permissions] })));
  expect(runtime.state('bridge').status).toBe('ready');
  expect(listener).toHaveBeenCalledTimes(1);
  runtime.dispose(); vi.unstubAllGlobals();
});
it('rejects a digest completion started before account authority was revoked', async () => {
  const auth = authorityFixture(); const html = '<p>secret</p>'; const revision = '9'.repeat(64);
  let finishDigest!: (value: ArrayBuffer) => void;
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: () => new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; }) } });
  const pending: Array<(value: CommandResponse) => void> = []; let first = true;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_chunk') return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId: id, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true } });
    if (first) { first = false; return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId: id, revision, totalBytes: html.length } }); }
    return new Promise(resolve => pending.push(resolve));
  });
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand, subscribeAuthority: auth.subscribeAuthority }));
  await act(async () => {}); expect(finishDigest).toBeTypeOf('function');
  act(() => { auth.account(false); auth.account(true); });
  await act(async () => { finishDigest(Uint8Array.from({ length: 32 }, () => 0x99).buffer); });
  expect(hook.result.current.state.kind).toBe('loading');
  expect(pending).toHaveLength(1);
});
it('ignores a rejected request from a prior security generation', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  let rejectOld!: (error: Error) => void; let call = 0;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_status' && ++call === 2) return new Promise((_, reject) => { rejectOld = reject; });
    return h.sendCommand(command);
  });
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand, subscribeAuthority: auth.subscribeAuthority }));
  await act(async () => {}); act(() => auth.notify());
  act(() => auth.notify());
  await act(async () => { rejectOld(new Error('late')); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: h.html, verifying: true });
});
it('latches a selected bridge key change and restoration in one batch', async () => {
  const h = stablePreviewHarness(); const auth = authorityFixture();
  const hook = renderHook(() => useSessionPreview({ client: auth.client, userId: 'user', target, visible: true, readable: true, securityGeneration: 1, sendCommand: h.sendCommand }));
  await act(async () => {});
  const old = hook.result.current.state; if (old.kind !== 'ready') throw new Error('expected ready');
  act(() => { auth.pin.endpoint.publicKey = 'replacement'; auth.notify(); auth.pin.endpoint.publicKey = 'key'; auth.notify(); });
  expect(hook.result.current.state.kind).toBe('loading');
  expect(h.sendCommand.mock.calls.at(-1)?.[0].payload).not.toHaveProperty('knownRevision');
  await act(async () => { h.pending.shift()!({ requestId: 'new', success: true, data: { state: 'ready', previewId: id, revision: h.revision, totalBytes: h.html.length } }); });
  const next = hook.result.current.state; if (next.kind !== 'ready') throw new Error('expected ready');
  expect(next.key).not.toBe(old.key);
});
