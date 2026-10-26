// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateEndpoint } from '@security/crypto';
import { captureInvitation, clearAccountEnrollment, loadBrowserIdentity, parseInvitation } from './browser-identity';
import { BridgePolicyStore, LOCAL_RECOVERY_AUTHORITY } from '@security/bridge/policy';
import { invitationLink } from '../../../bridge/src/security-cli';
const ownerId = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true }); });
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('parses real bridge-policy invitations and CLI fragment links with distinct web and broker origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-browser-invitation-'));
  try {
    for (const relayUrl of ['wss://broker.example.test/connection/websocket', 'ws://localhost:8000/connection/websocket']) {
      const bridge = await generateEndpoint(ownerId, 'bridge');
      const policy = new BridgePolicyStore(join(directory, crypto.randomUUID()), 'bridge-one', bridge.endpoint, { relayUrl, localOrigin: 'http://127.0.0.1:43127' });
      const invitation = await policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Actual generated browser' });
      const link = new URL(invitationLink(invitation, 'https://panel.example.test'));
      expect(link.origin).toBe('https://panel.example.test'); expect(link.pathname).toBe('/connect');
      window.history.replaceState(null, '', link.pathname + link.hash);
      const captured = captureInvitation(); expect(window.location.hash).toBe('');
      await expect(parseInvitation(captured)).resolves.toEqual(invitation);
      await expect(parseInvitation({ ...invitation, relayUrl: 'http://localhost:3000' })).rejects.toMatchObject({ code: 'invitation_invalid' });
      await expect(parseInvitation({ ...invitation, relayUrl: 'https://panel.example.test' })).rejects.toMatchObject({ code: 'invitation_invalid' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('scrubs an invitation before parsing or awaiting any identity operation', async () => {
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const invitation = { version: 1, invitationId: 'invite-one', ownerId, bridgeId: 'bridge-one', bridge: bridge.endpoint,
    secret: 'A'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), relayUrl: 'wss://relay.example.test/connection/websocket', localOrigin: 'http://127.0.0.1:43127' };
  window.history.replaceState(null, '', `/connect#invite=${encodeURIComponent(JSON.stringify(invitation))}`);
  const captured = captureInvitation(); expect(window.location.hash).toBe('');
  await expect(parseInvitation(captured)).resolves.toEqual(invitation);
  await expect(parseInvitation({ ...invitation, bridge: { ...bridge.endpoint, id: 'A'.repeat(43) } })).rejects.toMatchObject({ code: 'invitation_invalid' });
  await expect(parseInvitation({ ...invitation, expiresAt: new Date(Date.now() - 1).toISOString() })).rejects.toMatchObject({ code: 'invitation_expired' });
});
it('scrubs malformed fragments and refuses duplicate invitation parameters', () => {
  window.history.replaceState(null, '', '/connect#invite=bad&invite=other');
  expect(() => captureInvitation()).toThrow(); expect(window.location.hash).toBe('');
});
it('requires secure browser context and durable key storage without fallback', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  await expect(loadBrowserIdentity(ownerId)).rejects.toMatchObject({ code: 'secure_context_required' });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.stubGlobal('indexedDB', undefined);
  await expect(loadBrowserIdentity(ownerId)).rejects.toMatchObject({ code: 'storage_unavailable' });
});

it('cleans only the completed enrollment in the same read/write transaction, preserving a newer request', async () => {
  let stored: unknown = { link: { request: { requestId: 'newer-request' } } };
  const remove = vi.fn(() => { stored = undefined; });
  const close = vi.fn();
  const transaction = vi.fn((_name: string, mode: string) => {
    expect(mode).toBe('readwrite');
    const tx = { oncomplete: null as (() => void) | null, onabort: null, onerror: null,
      objectStore: () => ({ delete: remove, get: () => {
        const request = { result: stored, onsuccess: null as (() => void) | null };
        queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
        return request;
      } }) };
    return tx;
  });
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: { transaction, close }, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } });
  await clearAccountEnrollment(ownerId, 'completed-request');
  expect(remove).not.toHaveBeenCalled(); expect(stored).toBeDefined();
  await clearAccountEnrollment(ownerId, 'newer-request');
  expect(remove).toHaveBeenCalledExactlyOnceWith(ownerId); expect(stored).toBeUndefined();
  expect(transaction).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2);
});
