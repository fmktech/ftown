// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalDashboard } from './LocalDashboard';
import { readDevice, rememberDevice } from '@/lib/local-browser-client';
import { SecurityError } from '@security/crypto';

const cryptoState = vi.hoisted(() => ({ handshake: vi.fn(), loadIdentity: vi.fn(), readPins: vi.fn(), dispose: vi.fn() }));
vi.mock('@/lib/browser-identity', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/browser-identity')>(),
  loadBrowserIdentity: cryptoState.loadIdentity,
  readPinnedBridges: cryptoState.readPins,
}));
vi.mock('@/lib/secure-endpoint-runtime', async importOriginal => ({ accountManagedOwner: (await importOriginal<typeof import('@/lib/secure-endpoint-runtime')>()).accountManagedOwner, SecureEndpointRuntime: class {
  discover() {}
  handshake(...args: unknown[]) { return cryptoState.handshake(...args); }
  state() { return { status: 'ready' }; }
  request() { return new Promise(() => {}); }
  dispose() { cryptoState.dispose(); }
} }));
vi.mock('./Dashboard', () => ({ Dashboard: (props: { localMode: boolean; onDisconnect: () => void }) =>
  React.createElement('div', null, 'Local dashboard ' + String(props.localMode), React.createElement('button', { onClick: props.onDisconnect }, 'Disconnect')) }));
vi.mock('@/lib/direct-transport/hybrid-terminal-transport', () => ({ HybridTerminalTransport: class { dispose() {} } }));
// Solo and --local bridges (the invitation flow) name `solo:<bridgeId>` as owner; an account bridge names its accountId.
const ownerId = 'solo:bridge';
const endpoint = { version: 1, id: 'bridge-key', ownerId, kind: 'bridge', publicKey: 'public' };
const boot = { protocolVersion: 1, ownerId, bridgeId: 'bridge', endpoint, relayUserId: 'local' };
const accountId = 'A'.repeat(43);
const accountBoot = { protocolVersion: 1, ownerId: accountId, bridgeId: 'bridge', endpoint: { ...endpoint, ownerId: accountId }, relayUserId: accountId };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/local');
  vi.clearAllMocks(); cryptoState.handshake.mockResolvedValue(undefined);
  cryptoState.loadIdentity.mockResolvedValue({ endpoint: { ownerId, id: 'browser-key' }, keyPair: {} });
  cryptoState.readPins.mockResolvedValue([{ bridgeId: 'bridge', endpoint, permissions: ['read', 'control', 'admin'] }]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('requires the approved identity handshake and remembers only session-scoped port metadata when requested', async () => {
  let approve!: () => void;
  cryptoState.handshake.mockImplementationOnce(() => new Promise<void>(resolve => { approve = resolve; }));
  const fetcher = vi.fn().mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  fireEvent.change(screen.getByLabelText('Local bridge port'), { target: { value: '40123' } });
  fireEvent.click(screen.getByLabelText("Remember this bridge's port"));
  fireEvent.click(screen.getByRole('button', { name: 'Connect locally' }));
  await waitFor(() => expect(cryptoState.handshake).toHaveBeenCalledOnce());
  expect(screen.queryByText('Local dashboard true')).toBeNull(); expect(readDevice()).toBeNull();
  approve(); await screen.findByText('Local dashboard true');
  expect(localStorage.getItem('ftown:local:device:40123')).toBeNull();
  expect(readDevice()).toEqual({ port: 40123, bridgeId: 'bridge' });
  expect(cryptoState.loadIdentity).toHaveBeenCalledWith(ownerId); expect(cryptoState.readPins).toHaveBeenCalledWith(ownerId);
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:40123/api/security/info');
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(cryptoState.dispose).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Forget saved bridge port' })); expect(readDevice()).toBeNull();
});

it('restores remembered discovery metadata and unlocks through the pinned identity without login or legacy pairing', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge', credential: 'retired-secret' }, true);
  const fetcher = vi.fn().mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard)); await screen.findByText('Local dashboard true');
  expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/api/security/info'))).toBe(true);
  expect(cryptoState.handshake).toHaveBeenCalledOnce();
  expect(localStorage.getItem('ftown:local:device:40123')).not.toContain('retired-secret');
});

it('rejects a revoked identity without using or retaining an old bearer credential', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge', credential: 'retired-secret' }, true);
  cryptoState.handshake.mockRejectedValue(new SecurityError('endpoint_revoked', 'Rejected'));
  const fetcher = vi.fn().mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('revoked'));
  expect(screen.queryByText('Local dashboard true')).toBeNull(); expect(cryptoState.dispose).toHaveBeenCalledOnce();
  expect(readDevice()).toEqual({ port: 40123, bridgeId: 'bridge' });
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

it('keeps remembered discovery metadata on a temporary failure so retry uses the existing key', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge' }, true);
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Bridge unreachable')).mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  await screen.findByRole('alert'); expect(readDevice()?.bridgeId).toBe('bridge'); expect(cryptoState.loadIdentity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect locally' })); await screen.findByText('Local dashboard true');
  expect(cryptoState.loadIdentity).toHaveBeenCalledOnce(); expect(cryptoState.handshake).toHaveBeenCalledOnce();
});

it('an account bridge is never sent through invitations: /local points to the account dashboard instead', async () => {
  vi.stubEnv('NEXT_PUBLIC_FTOWN_PUBLIC_URL', 'https://ftown.example');
  const fetcher = vi.fn().mockResolvedValue(json(accountBoot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  fireEvent.change(screen.getByLabelText('Local bridge port'), { target: { value: '40123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect locally' }));
  expect(await screen.findByRole('heading', { name: 'This computer belongs to your account' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open your dashboard' }).getAttribute('href')).toBe('https://ftown.example/dashboard');
  expect(screen.queryByText(/ftown security invite/)).toBeNull(); expect(screen.queryByText('Local dashboard true')).toBeNull();
  expect(cryptoState.handshake).not.toHaveBeenCalled(); expect(cryptoState.loadIdentity).not.toHaveBeenCalled(); expect(cryptoState.readPins).not.toHaveBeenCalled();
  expect(readDevice()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use another port' }));
  expect(screen.getByLabelText('Local bridge port')).toBeTruthy(); expect(screen.getByText(/ftown security invite/)).toBeTruthy();
});

it('a Solo/--local bridge keeps the invitation instructions and never shows the account message', async () => {
  const fetcher = vi.fn().mockResolvedValue(json(boot)); vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  expect(screen.getByText(/ftown security invite/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Local bridge port'), { target: { value: '40123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect locally' }));
  await screen.findByText('Local dashboard true');
  expect(screen.queryByText('This computer belongs to your account')).toBeNull(); expect(cryptoState.handshake).toHaveBeenCalledOnce();
});
